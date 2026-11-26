pub mod capture;
pub mod clipboard;
pub mod hotkeys;
#[cfg(target_os = "macos")]
pub mod macos_overlay;
pub mod permissions;
pub mod scrolling;
pub mod settings;
pub mod stitcher;
pub mod tray;
pub mod windows;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use capture::{CaptureMeta, CaptureStore, OverlaySessionInfo};
use parking_lot::Mutex;
use permissions::PermissionStatus;
use scrolling::ScrollingController;
use settings::{AfterAreaCrop, AppSettings};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub store: Mutex<CaptureStore>,
    pub hotkey_errors: Mutex<HashMap<String, Option<String>>>,
    pub scrolling: ScrollingController,
    pub overlay_seq: AtomicU64,
    pub overlay_shown_seq: AtomicU64,
    pub overlay_starting: AtomicBool,
    pub hotkeys_suspended: AtomicBool,
}

impl AppState {
    fn new() -> Self {
        Self {
            settings: Mutex::new(AppSettings::load()),
            store: Mutex::new(CaptureStore::default()),
            hotkey_errors: Mutex::new(HashMap::new()),
            scrolling: ScrollingController::default(),
            overlay_seq: AtomicU64::new(0),
            overlay_shown_seq: AtomicU64::new(0),
            overlay_starting: AtomicBool::new(false),
            hotkeys_suspended: AtomicBool::new(false),
        }
    }
}

pub fn dispatch_capture_action(app: AppHandle, action: &'static str) {
    // Run off the hotkey callback thread so screen capture never blocks OS event dispatch.
    std::thread::spawn(move || {
        let state = app.state::<Arc<AppState>>();
        let result: Result<(), String> = match action {
            hotkeys::ACTION_AREA => start_overlay_capture(&app, &state, "area"),
            hotkeys::ACTION_WINDOW => start_overlay_capture(&app, &state, "window"),
            hotkeys::ACTION_SCROLLING => start_overlay_capture(&app, &state, "scrolling"),
            hotkeys::ACTION_FULLSCREEN => {
                capture::capture_fullscreen().and_then(|(img, scale, bounds)| {
                    let meta = state
                        .store
                        .lock()
                        .insert(img, scale, "fullscreen", Some(bounds));
                    finalize_capture(&app, &state, &meta, false)
                })
            }
            hotkeys::ACTION_CLIPBOARD => clipboard::read_image_from_clipboard().and_then(|img| {
                let meta = state.store.lock().insert(img, 1.0, "clipboard", None);
                windows::open_editor(
                    &app,
                    &meta.id,
                    meta.width,
                    meta.height,
                    meta.scale_factor,
                    None,
                )
            }),
            _ => Ok(()),
        };
        if let Err(err) = result {
            eprintln!("[gaze] capture action '{action}' failed: {err}");
            #[cfg(target_os = "macos")]
            if action != hotkeys::ACTION_CLIPBOARD
                && !permissions::check_permissions().screen_recording
            {
                let _ = permissions::request_screen_recording_prompt();
                let _ = windows::open_preferences(&app);
            }
        }
    });
}

pub fn start_overlay_capture(
    app: &AppHandle,
    state: &Arc<AppState>,
    mode: &str,
) -> Result<(), String> {
    start_overlay_capture_on_monitor(app, state, mode, None)
}

pub fn start_overlay_capture_on_monitor(
    app: &AppHandle,
    state: &Arc<AppState>,
    mode: &str,
    monitor_index: Option<usize>,
) -> Result<(), String> {
    // Prevent overlapping hotkey triggers from racing on overlay state/visibility.
    if state
        .overlay_starting
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }
    struct StartingGuard<'a>(&'a AtomicBool);
    impl Drop for StartingGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = StartingGuard(&state.overlay_starting);

    let seq = state.overlay_seq.fetch_add(1, Ordering::SeqCst) + 1;

    #[cfg(target_os = "macos")]
    {
        // Overlay uses `NSWindowSharingType::None`, so it is automatically excluded from
        // `CGWindowListCreateImage` without needing to hide & sleep first.
        let captured = capture::capture_overlay_session_macos(seq, mode, monitor_index)?;
        let info = captured.session.info();
        let cg_for_decode = captured.cg_image.clone();
        let rgba_setter = captured.rgba_setter;

        // Store the session first so immediate IPC calls from the WebView never race.
        state.store.lock().overlay = Some(captured.session);
        state.overlay_shown_seq.store(seq, Ordering::SeqCst);

        // Present native CALayer frozen backdrop immediately (~1-2ms).
        windows::open_overlay_native(app, &info, captured.cg_image)?;

        // Decode CGImage -> RgbaImage in parallel on a worker thread for loupe & cropping.
        std::thread::spawn(move || {
            let decoded = macos_overlay::cg_image_to_rgba(&cg_for_decode.0, true);
            rgba_setter.resolve(decoded);
        });
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let was_visible = windows::is_overlay_visible(app);
        if was_visible {
            windows::close_overlay(app, seq.saturating_sub(1));
            std::thread::sleep(std::time::Duration::from_millis(35));
        }
        let session = capture::capture_overlay_session(seq, mode, monitor_index)?;
        let info = session.info();
        state.store.lock().overlay = Some(session);
        let _reused = windows::open_overlay(app, &info)?;
        let app_clone = app.clone();
        let state_clone = state.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            if state_clone.overlay_shown_seq.load(Ordering::SeqCst) < seq
                && state_clone.store.lock().overlay.is_some()
            {
                if let Some(win) = app_clone.get_webview_window(windows::LABEL_OVERLAY) {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        });
        Ok(())
    }
}

pub fn finalize_capture(
    app: &AppHandle,
    state: &Arc<AppState>,
    meta: &CaptureMeta,
    is_area_crop: bool,
) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    let (img_clone, mon_bounds) = {
        let store = state.store.lock();
        store
            .get(&meta.id)
            .map(|c| (c.image.clone(), c.monitor_bounds))
            .ok_or_else(|| "Capture not found".to_string())?
    };

    if settings.after_screenshot_copy {
        let _ = clipboard::copy_rgba_image(&img_clone);
    }
    if settings.after_screenshot_save {
        let _ = capture::save_image_file(&img_clone, meta.scale_factor, &settings, None);
    }

    if settings.after_screenshot_show {
        if is_area_crop && settings.after_area_crop == AfterAreaCrop::Thumbnail {
            windows::open_thumbnail(app, &meta.id, mon_bounds, meta.scale_factor)?;
        } else {
            windows::open_editor(
                app,
                &meta.id,
                meta.width,
                meta.height,
                meta.scale_factor,
                mon_bounds,
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
fn get_settings(state: State<'_, Arc<AppState>>) -> AppSettings {
    state.settings.lock().clone()
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    mut new_settings: AppSettings,
) -> Result<HashMap<String, Option<String>>, String> {
    new_settings.clamp();
    let old_autostart = state.settings.lock().autostart;
    new_settings.save()?;

    if old_autostart != new_settings.autostart {
        let autostart = app.autolaunch();
        let _ = if new_settings.autostart {
            autostart.enable()
        } else {
            autostart.disable()
        };
    }

    let errors = if state.hotkeys_suspended.load(Ordering::SeqCst) {
        state.hotkey_errors.lock().clone()
    } else {
        let errs = hotkeys::sync_hotkeys(&app, &new_settings.hotkeys, dispatch_capture_action);
        *state.hotkey_errors.lock() = errs.clone();
        errs
    };
    tray::update_tray_menu(&app, &new_settings.hotkeys);
    *state.settings.lock() = new_settings;
    Ok(errors)
}

#[tauri::command]
fn set_hotkeys_suspended(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    suspended: bool,
) -> HashMap<String, Option<String>> {
    state.hotkeys_suspended.store(suspended, Ordering::SeqCst);
    if suspended {
        let _ = app.global_shortcut().unregister_all();
        state.hotkey_errors.lock().clone()
    } else {
        let hotkeys_cfg = state.settings.lock().hotkeys.clone();
        let errors = hotkeys::sync_hotkeys(&app, &hotkeys_cfg, dispatch_capture_action);
        *state.hotkey_errors.lock() = errors.clone();
        errors
    }
}

#[tauri::command]
fn reset_settings(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<AppSettings, String> {
    let defaults = AppSettings::default();
    defaults.save()?;
    let errors = hotkeys::sync_hotkeys(&app, &defaults.hotkeys, dispatch_capture_action);
    *state.hotkey_errors.lock() = errors;
    tray::update_tray_menu(&app, &defaults.hotkeys);
    *state.settings.lock() = defaults.clone();
    Ok(defaults)
}

#[tauri::command]
fn get_hotkey_errors(state: State<'_, Arc<AppState>>) -> HashMap<String, Option<String>> {
    state.hotkey_errors.lock().clone()
}

#[tauri::command]
fn check_permissions() -> PermissionStatus {
    permissions::check_permissions()
}

#[tauri::command]
fn request_screen_permission() -> bool {
    permissions::request_screen_recording_prompt()
}

#[tauri::command]
fn open_permission_settings(kind: String) -> Result<(), String> {
    permissions::open_permission_settings(&kind)
}

#[tauri::command]
fn trigger_capture(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    mode: String,
) -> Result<(), String> {
    match mode.as_str() {
        "area" => start_overlay_capture(&app, &state, "area"),
        "window" => start_overlay_capture(&app, &state, "window"),
        "scrolling" => start_overlay_capture(&app, &state, "scrolling"),
        "fullscreen" => {
            let (img, scale, bounds) = capture::capture_fullscreen()?;
            let meta = state
                .store
                .lock()
                .insert(img, scale, "fullscreen", Some(bounds));
            finalize_capture(&app, &state, &meta, false)
        }
        "clipboard" => {
            let img = clipboard::read_image_from_clipboard()?;
            let meta = state.store.lock().insert(img, 1.0, "clipboard", None);
            windows::open_editor(
                &app,
                &meta.id,
                meta.width,
                meta.height,
                meta.scale_factor,
                None,
            )
        }
        other => Err(format!("Unknown capture mode: {other}")),
    }
}

#[tauri::command]
fn get_overlay_session(state: State<'_, Arc<AppState>>) -> Result<OverlaySessionInfo, String> {
    state
        .store
        .lock()
        .overlay
        .as_ref()
        .map(|s| s.info())
        .ok_or_else(|| "No active overlay session".to_string())
}

#[tauri::command]
fn get_overlay_image_png(state: State<'_, Arc<AppState>>) -> Result<Response, String> {
    let deferred = state
        .store
        .lock()
        .overlay
        .as_ref()
        .map(|s| s.image.clone())
        .ok_or_else(|| "No active overlay session".to_string())?;
    let bytes = deferred.with_image(capture::encode_png)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn get_overlay_image_raw(
    state: State<'_, Arc<AppState>>,
    seq: Option<u64>,
) -> Result<Response, String> {
    let deferred = {
        let store = state.store.lock();
        let session = store
            .overlay
            .as_ref()
            .ok_or_else(|| "No active overlay session".to_string())?;
        if let Some(expected) = seq {
            if session.seq != expected {
                return Err("Stale overlay session".to_string());
            }
        }
        session.image.clone()
    };
    let packed = deferred.with_image(|img| Ok(capture::pack_raw_rgba(img)))?;
    Ok(Response::new(packed))
}

#[tauri::command]
fn get_overlay_windows(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<capture::WindowRect>, String> {
    let mut store = state.store.lock();
    let session = store
        .overlay
        .as_mut()
        .ok_or_else(|| "No active overlay session".to_string())?;
    if session.windows.is_empty() {
        session.windows = capture::enumerate_monitor_windows(
            session.monitor_x,
            session.monitor_y,
            session.monitor_width,
            session.monitor_height,
        );
    }
    Ok(session.windows.clone())
}

#[tauri::command]
fn show_overlay_window(app: AppHandle, state: State<'_, Arc<AppState>>) {
    if state.store.lock().overlay.is_none() {
        return;
    }
    let seq = state.overlay_seq.load(Ordering::SeqCst);
    state.overlay_shown_seq.store(seq, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(windows::LABEL_OVERLAY) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reveal_window(window: tauri::WebviewWindow, focus: bool) {
    let _ = window.show();
    if focus {
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn cancel_overlay(app: AppHandle, state: State<'_, Arc<AppState>>) {
    let seq = state.overlay_seq.load(Ordering::SeqCst);
    state.store.lock().overlay = None;
    windows::close_overlay(&app, seq);
}

/// Dismisses any active overlay cleanly from native OS callbacks (e.g. Space swipe or native Esc).
#[cfg(target_os = "macos")]
pub fn dismiss_overlay_from_native(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let had_overlay = state.store.lock().overlay.take().is_some();
    if had_overlay {
        let seq = state.overlay_seq.load(Ordering::SeqCst);
        windows::close_overlay(app, seq);
    }
}

#[tauri::command]
fn switch_overlay_monitor(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    mode: String,
) -> Result<(), String> {
    let next_index = {
        let store = state.store.lock();
        let Some(curr) = store.overlay.as_ref() else {
            return Err("No active overlay session".to_string());
        };
        if curr.monitor_count <= 1 {
            return Ok(());
        }
        (curr.monitor_index + 1) % curr.monitor_count
    };
    start_overlay_capture_on_monitor(&app, &state, &mode, Some(next_index))
}

#[tauri::command]
fn complete_area_selection(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    action: String,
) -> Result<CaptureMeta, String> {
    let seq = state.overlay_seq.load(Ordering::SeqCst);
    let session_copy = state
        .store
        .lock()
        .overlay
        .take()
        .ok_or_else(|| "No active overlay session".to_string())?;

    // Hide overlay immediately for snappy UX while cropping/copying/opening editor.
    windows::close_overlay(&app, seq);

    let cropped = capture::crop_from_session(&session_copy, x, y, width, height)?;
    let scale = session_copy.scale_factor;
    let bounds = session_copy.bounds();

    let meta = state
        .store
        .lock()
        .insert(cropped.clone(), scale, "area", Some(bounds));
    let settings = state.settings.lock().clone();

    match action.as_str() {
        "copy" => {
            clipboard::copy_rgba_image(&cropped)?;
        }
        "save" => {
            capture::save_image_file(&cropped, scale, &settings, None)?;
        }
        "pin" => {
            windows::open_pin(&app, &meta.id, meta.width, meta.height, meta.scale_factor)?;
        }
        "editor" => {
            windows::open_editor(
                &app,
                &meta.id,
                meta.width,
                meta.height,
                meta.scale_factor,
                Some(bounds),
            )?;
        }
        _ => {
            finalize_capture(&app, &state, &meta, true)?;
        }
    }

    Ok(meta)
}

#[tauri::command]
fn complete_window_selection(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    window_id: u32,
    action: Option<String>,
) -> Result<CaptureMeta, String> {
    let seq = state.overlay_seq.load(Ordering::SeqCst);
    let settings = state.settings.lock().clone();
    let session_copy = state.store.lock().overlay.take();
    let bounds = session_copy.as_ref().map(|s| s.bounds());
    windows::close_overlay(&app, seq);

    let (img, scale) =
        capture::capture_window_with_background(window_id, &settings, session_copy.as_ref())?;
    let meta = state
        .store
        .lock()
        .insert(img.clone(), scale, "window", bounds);

    match action.as_deref().unwrap_or("default") {
        "copy" => {
            clipboard::copy_rgba_image(&img)?;
        }
        "save" => {
            capture::save_image_file(&img, scale, &settings, None)?;
        }
        "pin" => {
            windows::open_pin(&app, &meta.id, meta.width, meta.height, meta.scale_factor)?;
        }
        "editor" => {
            windows::open_editor(
                &app,
                &meta.id,
                meta.width,
                meta.height,
                meta.scale_factor,
                bounds,
            )?;
        }
        _ => {
            finalize_capture(&app, &state, &meta, false)?;
        }
    }
    Ok(meta)
}

#[tauri::command]
fn get_capture_meta(state: State<'_, Arc<AppState>>, id: String) -> Result<CaptureMeta, String> {
    state
        .store
        .lock()
        .get(&id)
        .map(|c| c.meta())
        .ok_or_else(|| format!("Capture {id} not found"))
}

#[tauri::command]
fn get_capture_image_png(state: State<'_, Arc<AppState>>, id: String) -> Result<Response, String> {
    let img = state
        .store
        .lock()
        .get(&id)
        .map(|c| c.image.clone())
        .ok_or_else(|| format!("Capture {id} not found"))?;
    let bytes = capture::encode_png(&img)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn get_capture_image_raw(state: State<'_, Arc<AppState>>, id: String) -> Result<Response, String> {
    let packed = state
        .store
        .lock()
        .get(&id)
        .map(|c| capture::pack_raw_rgba(&c.image))
        .ok_or_else(|| format!("Capture {id} not found"))?;
    Ok(Response::new(packed))
}

#[tauri::command]
fn copy_image_bytes(png_base64: String) -> Result<(), String> {
    let png_bytes = BASE64
        .decode(png_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 image payload: {e}"))?;
    clipboard::copy_png_bytes(&png_bytes)
}

#[tauri::command]
fn copy_capture_by_id(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    let img = state
        .store
        .lock()
        .get(&id)
        .map(|c| c.image.clone())
        .ok_or_else(|| format!("Capture {id} not found"))?;
    clipboard::copy_rgba_image(&img)
}

#[tauri::command]
fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    clipboard::copy_text(&text)
}

#[tauri::command]
fn save_image_bytes(
    state: State<'_, Arc<AppState>>,
    png_base64: String,
    scale_factor: f32,
    path: Option<String>,
) -> Result<String, String> {
    let png_bytes = BASE64
        .decode(png_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 image payload: {e}"))?;
    let img = image::load_from_memory(&png_bytes)
        .map_err(|e| format!("Failed to decode image bytes: {e}"))?
        .to_rgba8();
    let settings = state.settings.lock().clone();
    let explicit = path.map(PathBuf::from);
    let saved = capture::save_image_file(&img, scale_factor, &settings, explicit.as_deref())?;
    Ok(saved.to_string_lossy().to_string())
}

#[tauri::command]
fn save_capture_by_id(
    state: State<'_, Arc<AppState>>,
    id: String,
    path: Option<String>,
) -> Result<String, String> {
    let (img, scale) = state
        .store
        .lock()
        .get(&id)
        .map(|c| (c.image.clone(), c.scale_factor))
        .ok_or_else(|| format!("Capture {id} not found"))?;
    let settings = state.settings.lock().clone();
    let explicit = path.map(PathBuf::from);
    let saved = capture::save_image_file(&img, scale, &settings, explicit.as_deref())?;
    Ok(saved.to_string_lossy().to_string())
}

#[tauri::command]
fn pin_image_bytes(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    png_base64: String,
    scale_factor: f32,
) -> Result<CaptureMeta, String> {
    let png_bytes = BASE64
        .decode(png_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 image payload: {e}"))?;
    let img = image::load_from_memory(&png_bytes)
        .map_err(|e| format!("Failed to decode pinned image: {e}"))?
        .to_rgba8();
    let meta = state.store.lock().insert(img, scale_factor, "pin", None);
    windows::open_pin(&app, &meta.id, meta.width, meta.height, meta.scale_factor)?;
    Ok(meta)
}

#[tauri::command]
fn open_editor_for_capture(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let (meta, bounds) = state
        .store
        .lock()
        .get(&id)
        .map(|c| (c.meta(), c.monitor_bounds))
        .ok_or_else(|| format!("Capture {id} not found"))?;
    windows::open_editor(
        &app,
        &meta.id,
        meta.width,
        meta.height,
        meta.scale_factor,
        bounds,
    )
}

#[tauri::command]
fn open_preferences_window(app: AppHandle) -> Result<(), String> {
    windows::open_preferences(&app)
}

#[tauri::command]
fn open_screenshots_folder(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let folder = state.settings.lock().screenshots_folder.clone();
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&folder)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&folder)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http/https URLs are supported".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn start_scrolling_capture(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    scrolling::start_scrolling_capture(app, state.inner().clone(), x, y, width, height)
}

#[tauri::command]
fn stop_scrolling_capture(state: State<'_, Arc<AppState>>) {
    state.scrolling.request_stop();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState::new());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(app_state.clone())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                macos_overlay::disable_app_nap();
            }

            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            macos_overlay::install_space_change_observer(&handle);
            let settings = app_state.settings.lock().clone();
            tray::setup_tray(&handle, &settings.hotkeys, dispatch_capture_action)
                .map_err(std::io::Error::other)?;

            let errors = hotkeys::sync_hotkeys(&handle, &settings.hotkeys, dispatch_capture_action);
            *app_state.hotkey_errors.lock() = errors;

            // Pre-warm hidden overlay webview so F1 capture opens instantaneously.
            windows::prewarm_overlay(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            set_hotkeys_suspended,
            reset_settings,
            get_hotkey_errors,
            check_permissions,
            request_screen_permission,
            open_permission_settings,
            trigger_capture,
            get_overlay_session,
            get_overlay_image_png,
            get_overlay_image_raw,
            get_overlay_windows,
            show_overlay_window,
            reveal_window,
            switch_overlay_monitor,
            cancel_overlay,
            complete_area_selection,
            complete_window_selection,
            get_capture_meta,
            get_capture_image_png,
            get_capture_image_raw,
            copy_image_bytes,
            copy_capture_by_id,
            copy_text_to_clipboard,
            save_image_bytes,
            save_capture_by_id,
            pin_image_bytes,
            open_editor_for_capture,
            open_preferences_window,
            open_screenshots_folder,
            open_external_url,
            start_scrolling_capture,
            stop_scrolling_capture,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Gaze");

    // Keep Gaze running in the menu bar / tray even when all windows are closed.
    app.run(|_app_handle, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
