pub mod capture;
pub mod clipboard;
pub mod hotkeys;
#[cfg(target_os = "macos")]
pub mod macos_overlay;
#[cfg(target_os = "macos")]
pub mod macos_window;
pub mod permissions;
pub mod scrolling;
pub mod settings;
pub mod stitcher;
pub mod tray;
pub mod updater;
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
    /// Active in-place edit session (selection handed from the native overlay to a webview).
    pub inplace: Mutex<Option<InplaceSession>>,
    pub updater: Arc<updater::UpdateManager>,
    pub active_preferences_tab: Mutex<String>,
    pub last_tray_update_key: Mutex<(updater::UpdatePhase, u8)>,
}

impl AppState {
    fn new() -> Self {
        let data_dir = dirs::data_dir()
            .or_else(dirs::config_dir)
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("dev.abcdlsj.gaze");
        let cache_dir = dirs::cache_dir()
            .or_else(dirs::data_local_dir)
            .unwrap_or_else(|| data_dir.clone())
            .join("dev.abcdlsj.gaze");
        let updater = Arc::new(updater::UpdateManager::new(
            env!("CARGO_PKG_VERSION"),
            data_dir,
            cache_dir,
        ));
        Self {
            settings: Mutex::new(AppSettings::load()),
            store: Mutex::new(CaptureStore::default()),
            hotkey_errors: Mutex::new(HashMap::new()),
            scrolling: ScrollingController::default(),
            overlay_seq: AtomicU64::new(0),
            overlay_shown_seq: AtomicU64::new(0),
            overlay_starting: AtomicBool::new(false),
            hotkeys_suspended: AtomicBool::new(false),
            inplace: Mutex::new(None),
            updater,
            active_preferences_tab: Mutex::new("general".to_string()),
            last_tray_update_key: Mutex::new((updater::UpdatePhase::Idle, 0)),
        }
    }

    /// Zero-data-loss capture guard: refuses an automatic restart while any
    /// capture overlay, scrolling screenshot, or in-place annotation is active.
    pub fn active_capture_block_reason(&self) -> Option<&'static str> {
        if self.overlay_starting.load(Ordering::SeqCst) {
            return Some("a screen capture is starting");
        }
        if self.scrolling.is_running() {
            return Some("a scrolling capture is in progress");
        }
        if self.inplace.lock().is_some() {
            return Some("an in-place annotation session is active");
        }
        if self.store.lock().overlay.is_some() {
            return Some("a capture overlay is active");
        }
        #[cfg(target_os = "macos")]
        if macos_overlay::is_native_overlay_active() {
            return Some("a capture overlay is active");
        }
        None
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
        let _ = monitor_index;
        state.overlay_shown_seq.store(seq, Ordering::SeqCst);
        macos_overlay::start_native_overlay(app, seq, mode)?;
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
    tray::update_tray_menu(&app, &new_settings.hotkeys, Some(&state.updater.status()));
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
    tray::update_tray_menu(&app, &defaults.hotkeys, Some(&state.updater.status()));
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
    if focus {
        windows::activate_and_focus_window(&window, Some(90));
    } else {
        let _ = window.show();
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
    state.store.lock().overlay = None;
    macos_overlay::dismiss_native_overlay(app, true);
}

/// Finalizes a cropped area capture directly from the native macOS overlay on a background thread.
#[cfg(target_os = "macos")]
pub fn complete_native_area_capture(
    app: AppHandle,
    image: image::RgbaImage,
    scale: f32,
    bounds: capture::MonitorBounds,
    action: String,
) {
    let state = app.state::<Arc<AppState>>();
    let meta = state
        .store
        .lock()
        .insert(image.clone(), scale, "area", Some(bounds));
    let settings = state.settings.lock().clone();

    let res: Result<(), String> = match action.as_str() {
        "done" => finish_done_action(&app, &state, &image, &meta, Some(bounds)),
        "copy" => clipboard::copy_rgba_image(&image),
        "save" => capture::save_image_file(&image, scale, &settings, None).map(|_| ()),
        "pin" => windows::open_pin(&app, &meta.id, meta.width, meta.height, meta.scale_factor),
        "editor" => windows::open_editor(
            &app,
            &meta.id,
            meta.width,
            meta.height,
            meta.scale_factor,
            Some(bounds),
        ),
        _ => finalize_capture(&app, &state, &meta, true),
    };
    if let Err(err) = res {
        eprintln!("[gaze] native area capture action '{action}' failed: {err}");
    }
}

/// Finalizes a window capture directly from the native macOS overlay on a background thread.
#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
pub fn complete_native_window_capture(
    app: AppHandle,
    window_id: u32,
    abs_bounds: Option<(i32, i32, u32, u32)>,
    scale: f32,
    bounds: capture::MonitorBounds,
    fallback_crop: Option<image::RgbaImage>,
    backdrop_image: Option<image::RgbaImage>,
    action: String,
) {
    let state = app.state::<Arc<AppState>>();
    let settings = state.settings.lock().clone();

    let img_res: Result<image::RgbaImage, String> =
        match macos_overlay::capture_window_cg_rgba(window_id, abs_bounds) {
            Ok(raw_img) => {
                let win_x = abs_bounds.map(|b| b.0);
                let win_y = abs_bounds.map(|b| b.1);
                let temp_session = backdrop_image.map(|bg| capture::OverlaySession {
                    seq: 0,
                    monitor_id: 0,
                    monitor_name: String::new(),
                    monitor_index: 0,
                    monitor_count: 1,
                    monitor_x: bounds.x,
                    monitor_y: bounds.y,
                    monitor_width: bounds.width,
                    monitor_height: bounds.height,
                    image_width: bg.width(),
                    image_height: bg.height(),
                    scale_factor: scale,
                    image: capture::DeferredRgbaImage::ready(bg),
                    windows: Vec::new(),
                    initial_mode: "area".to_string(),
                    initial_cursor_x: None,
                    initial_cursor_y: None,
                    has_native_backdrop: true,
                });
                Ok(capture::apply_window_background(
                    raw_img,
                    settings.window_background,
                    &settings.solid_background_color,
                    scale,
                    temp_session.as_ref(),
                    win_x,
                    win_y,
                ))
            }
            Err(err) => fallback_crop.ok_or(err),
        };

    let img = match img_res {
        Ok(img) => img,
        Err(err) => {
            eprintln!("[gaze] native window capture failed: {err}");
            return;
        }
    };

    let meta = state
        .store
        .lock()
        .insert(img.clone(), scale, "window", Some(bounds));

    let res: Result<(), String> = match action.as_str() {
        "done" => finish_done_action(&app, &state, &img, &meta, Some(bounds)),
        "copy" => clipboard::copy_rgba_image(&img),
        "save" => capture::save_image_file(&img, scale, &settings, None).map(|_| ()),
        "pin" => windows::open_pin(&app, &meta.id, meta.width, meta.height, meta.scale_factor),
        "editor" => windows::open_editor(
            &app,
            &meta.id,
            meta.width,
            meta.height,
            meta.scale_factor,
            Some(bounds),
        ),
        _ => finalize_capture(&app, &state, &meta, false),
    };
    if let Err(err) = res {
        eprintln!("[gaze] native window capture action '{action}' failed: {err}");
    }
}

/// Launches scrolling capture directly from the native macOS overlay on the chosen display.
#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
pub fn complete_native_scroll_capture(
    app: AppHandle,
    monitor_id: u32,
    bounds: capture::MonitorBounds,
    scale: f32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    if let Err(err) = scrolling::start_scrolling_capture_on_monitor(
        app,
        state,
        monitor_id,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        scale,
        x,
        y,
        width,
        height,
    ) {
        eprintln!("[gaze] native scrolling capture failed: {err}");
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

// ============================================================================
// In-place (Snipaste-style) editing on top of the frozen capture overlay
// ============================================================================

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct InplaceRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl InplaceRect {
    pub fn from_xywh(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// Display-local geometry (points) shared by the native toolbar and the webview editor.
#[derive(Debug, Clone, serde::Serialize)]
pub struct InplaceGeometry {
    pub view_width: f64,
    pub view_height: f64,
    pub selection: InplaceRect,
    pub toolbar: InplaceRect,
    /// "below" | "above" | "inside": where the toolbar sits relative to the selection.
    pub toolbar_side: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InplaceSession {
    pub label: String,
    pub capture_id: String,
    pub scale_factor: f32,
    pub tool: String,
    #[serde(flatten)]
    pub geometry: InplaceGeometry,
    #[serde(skip)]
    pub monitor_bounds: capture::MonitorBounds,
}

/// Called on a worker thread once the native overlay has cropped the selection: stores the
/// crop, makes sure the (normally prewarmed) webview exists, and hands it the session.
#[cfg(target_os = "macos")]
pub fn begin_inplace_session(
    app: AppHandle,
    label: String,
    image: image::RgbaImage,
    scale: f32,
    bounds: capture::MonitorBounds,
    geometry: InplaceGeometry,
    tool: String,
) {
    use tauri::Emitter;
    let state = app.state::<Arc<AppState>>();
    let meta = state
        .store
        .lock()
        .insert(image, scale, "area", Some(bounds));
    let session = InplaceSession {
        label: label.clone(),
        capture_id: meta.id,
        scale_factor: scale,
        tool,
        geometry,
        monitor_bounds: bounds,
    };
    *state.inplace.lock() = Some(session.clone());

    if let Err(err) = windows::ensure_inplace_editor(&app, &label, bounds) {
        eprintln!("[gaze] failed to create in-place editor: {err}");
        return; // The native ready-timeout falls back to the standalone editor.
    }
    macos_overlay::place_inplace_window(&app, label.clone());
    // The page also polls `get_inplace_session` on mount, so a session emitted before the
    // listener is registered is never lost.
    let _ = app.emit_to(label.as_str(), "inplace-session", &session);
}

/// Opens the standalone editor for an in-place session that never became ready.
#[cfg(target_os = "macos")]
pub fn inplace_fallback_to_editor(app: &AppHandle, label: &str) {
    let state = app.state::<Arc<AppState>>();
    let session = take_inplace_session(&state, label);
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.destroy();
    }
    let Some(session) = session else {
        return;
    };
    let meta = state
        .store
        .lock()
        .get(&session.capture_id)
        .map(|c| c.meta());
    if let Some(meta) = meta {
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = windows::open_editor(
                &app,
                &meta.id,
                meta.width,
                meta.height,
                meta.scale_factor,
                Some(session.monitor_bounds),
            );
        });
    }
}

fn take_inplace_session(state: &AppState, label: &str) -> Option<InplaceSession> {
    let mut slot = state.inplace.lock();
    if slot.as_ref().is_some_and(|s| s.label == label) {
        slot.take()
    } else {
        None
    }
}

/// "Done" (✓ / Enter / double-click): copy to the clipboard, plus the optional
/// save / thumbnail steps from Preferences → General → After capture.
pub fn finish_done_action(
    app: &AppHandle,
    state: &AppState,
    image: &image::RgbaImage,
    meta: &CaptureMeta,
    bounds: Option<capture::MonitorBounds>,
) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    clipboard::copy_rgba_image(image)?;
    if settings.after_screenshot_save {
        capture::save_image_file(image, meta.scale_factor, &settings, None)?;
    }
    if settings.after_screenshot_show && settings.after_area_crop == AfterAreaCrop::Thumbnail {
        windows::open_thumbnail(app, &meta.id, bounds, meta.scale_factor)?;
    }
    Ok(())
}

#[tauri::command]
fn get_inplace_session(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Option<InplaceSession> {
    state
        .inplace
        .lock()
        .as_ref()
        .filter(|s| s.label == window.label())
        .cloned()
}

#[tauri::command]
fn inplace_ready(window: tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    macos_overlay::inplace_editor_ready(window.app_handle(), window.label().to_string());
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Hides the overlay and the in-place editor immediately (before the possibly slow export),
/// restoring focus to the previous app when the action does not open a new Gaze window.
#[tauri::command]
fn inplace_hide(window: tauri::WebviewWindow, action: String) {
    let restore_focus = matches!(action.as_str(), "copy" | "save" | "done" | "cancel");
    let app = window.app_handle().clone();
    app.state::<Arc<AppState>>().store.lock().overlay = None;
    #[cfg(target_os = "macos")]
    macos_overlay::dismiss_native_overlay(&app, restore_focus);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = restore_focus;
        let _ = window.hide();
    }
}

/// Completes an in-place edit. `png_base64` carries the annotated export; when it is absent
/// (no annotations) the untouched crop stored at session start is used.
#[tauri::command]
fn inplace_finish(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<AppState>>,
    action: String,
    png_base64: Option<String>,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    let session = take_inplace_session(&state, window.label());
    let result = (|| -> Result<(), String> {
        if action == "cancel" {
            return Ok(());
        }
        let session = session.ok_or_else(|| "No in-place edit session".to_string())?;
        let scale = session.scale_factor;
        let bounds = Some(session.monitor_bounds);
        let (image, meta) = match png_base64 {
            Some(b64) => {
                let bytes = BASE64
                    .decode(b64.as_bytes())
                    .map_err(|e| format!("Invalid base64 image payload: {e}"))?;
                let img = image::load_from_memory(&bytes)
                    .map_err(|e| format!("Failed to decode edited image: {e}"))?
                    .to_rgba8();
                let meta = state
                    .store
                    .lock()
                    .insert(img.clone(), scale, "area", bounds);
                (img, meta)
            }
            None => state
                .store
                .lock()
                .get(&session.capture_id)
                .map(|c| (c.image.clone(), c.meta()))
                .ok_or_else(|| "In-place capture not found".to_string())?,
        };
        let settings = state.settings.lock().clone();
        match action.as_str() {
            "done" | "copy" => finish_done_action(&app, &state, &image, &meta, bounds),
            "save" => capture::save_image_file(&image, scale, &settings, None).map(|_| ()),
            "pin" => windows::open_pin(&app, &meta.id, meta.width, meta.height, meta.scale_factor),
            "editor" => windows::open_editor(
                &app,
                &meta.id,
                meta.width,
                meta.height,
                meta.scale_factor,
                bounds,
            ),
            other => Err(format!("Unknown in-place action '{other}'")),
        }
    })();
    let _ = window.destroy();
    if let Err(err) = &result {
        eprintln!("[gaze] in-place action '{action}' failed: {err}");
    }
    result
}

// ============================================================================
// Seamless Auto-Update Commands & Tray Coordination
// ============================================================================

pub(crate) fn sync_tray_for_update(app: &AppHandle, status: &updater::UpdateStatus) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let bucket = if status.state == updater::UpdatePhase::Downloading {
        status.progress / 5
    } else {
        status.progress
    };
    let next_key = (status.state, bucket);
    {
        let mut last = state.last_tray_update_key.lock();
        if *last == next_key && status.state == updater::UpdatePhase::Downloading {
            return;
        }
        *last = next_key;
    }
    let hotkeys_cfg = state.settings.lock().hotkeys.clone();
    tray::update_tray_menu(app, &hotkeys_cfg, Some(status));
}

pub(crate) fn commit_update_restart_internal(
    app: &AppHandle,
    state: &Arc<AppState>,
    mut app_state: serde_json::Value,
) -> Result<(), String> {
    if let Some(reason) = state.active_capture_block_reason() {
        return Err(format!("Cannot restart while {reason}"));
    }

    // Flush settings atomically and release global hotkeys before exiting.
    state.settings.lock().save()?;
    let _ = app.global_shortcut().unregister_all();

    let prefs_open = app
        .get_webview_window(windows::LABEL_PREFERENCES)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let window_geom = if prefs_open {
        updater::capture_window_geometry(app)
    } else {
        None
    };

    if !app_state.is_object() {
        app_state = serde_json::json!({});
    }
    if let Some(obj) = app_state.as_object_mut() {
        obj.entry("preferences_open")
            .or_insert_with(|| serde_json::Value::Bool(prefs_open));
        if prefs_open {
            let tab = state.active_preferences_tab.lock().clone();
            obj.entry("active_tab")
                .or_insert_with(|| serde_json::Value::String(tab));
        }
    }

    state.updater.commit_restart(app, app_state, window_geom)?;
    app.exit(0);
    Ok(())
}

pub(crate) fn handle_tray_update_click(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let status = state.updater.status();
    match status.state {
        updater::UpdatePhase::ReadyToRestart => {
            let app_clone = app.clone();
            let state_clone = Arc::clone(state.inner());
            std::thread::spawn(move || {
                if let Err(err) =
                    commit_update_restart_internal(&app_clone, &state_clone, serde_json::json!({}))
                {
                    eprintln!("[gaze] tray update restart deferred: {err}");
                }
            });
        }
        updater::UpdatePhase::Available | updater::UpdatePhase::Error if status.available => {
            if !status.can_apply {
                if let Some(url) = status.release_url {
                    let _ = open_external_url(url);
                }
                return;
            }
            if let Err(err) = state.updater.start_download_from_tray(app.clone()) {
                eprintln!("[gaze] tray update download failed: {err}");
            }
        }
        _ => {}
    }
}

pub(crate) fn try_tray_commit_restart(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    if let Err(err) = commit_update_restart_internal(app, state.inner(), serde_json::json!({})) {
        eprintln!("[gaze] auto-restart deferred: {err}");
    }
}

#[tauri::command]
fn set_preferences_tab(state: State<'_, Arc<AppState>>, tab: String) {
    *state.active_preferences_tab.lock() = tab;
}

#[tauri::command]
fn updater_get_status(state: State<'_, Arc<AppState>>) -> updater::UpdateStatus {
    state.updater.status()
}

#[tauri::command]
async fn updater_check_now(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<updater::UpdateStatus, String> {
    let mgr = Arc::clone(&state.updater);
    tauri::async_runtime::spawn_blocking(move || mgr.check_manual(&app))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn updater_download_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<updater::UpdateStatus, String> {
    state.updater.start_download(app)
}

#[tauri::command]
async fn updater_commit_restart(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    app_state: serde_json::Value,
) -> Result<(), String> {
    let state_clone = Arc::clone(state.inner());
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        commit_update_restart_internal(&app_clone, &state_clone, app_state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn updater_take_handoff(state: State<'_, Arc<AppState>>) -> Option<updater::UpdateHandoffPayload> {
    state.updater.take_startup_handoff()
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
        .on_window_event(|window, event| {
            // If Preferences closes while recording a hotkey, never leave global hotkeys suspended.
            if window.label() == windows::LABEL_PREFERENCES
                && matches!(
                    event,
                    tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
                )
            {
                let app = window.app_handle();
                let state = app.state::<Arc<AppState>>();
                if state.hotkeys_suspended.swap(false, Ordering::SeqCst) {
                    let hotkeys_cfg = state.settings.lock().hotkeys.clone();
                    let errors = hotkeys::sync_hotkeys(app, &hotkeys_cfg, dispatch_capture_action);
                    *state.hotkey_errors.lock() = errors;
                }
            }
        })
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

            // Start delayed background update checks & restore Preferences if updated while open.
            app_state.updater.start_background(handle.clone());
            if let Some(handoff) = app_state.updater.peek_startup_handoff() {
                let prefs_open = handoff
                    .app_state
                    .get("preferences_open")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if prefs_open {
                    let _ = windows::open_preferences(&handle);
                    if let Some(geom) = handoff.window.as_ref() {
                        updater::apply_window_geometry(&handle, geom);
                    }
                } else {
                    let _ = app_state.updater.take_startup_handoff();
                }
            }
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
            get_inplace_session,
            inplace_ready,
            inplace_hide,
            inplace_finish,
            set_preferences_tab,
            updater_get_status,
            updater_check_now,
            updater_download_update,
            updater_commit_restart,
            updater_take_handoff,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Gaze");

    // Keep Gaze running in the menu bar / tray even when all windows are closed.
    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            windows::handle_reopen(app_handle);
        }
        _ => {
            let _ = app_handle;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_capture_guard_blocks_during_overlay_scrolling_and_inplace() {
        let state = AppState::new();
        assert_eq!(state.active_capture_block_reason(), None);

        state.overlay_starting.store(true, Ordering::SeqCst);
        assert!(state.active_capture_block_reason().is_some());
        state.overlay_starting.store(false, Ordering::SeqCst);
        assert_eq!(state.active_capture_block_reason(), None);

        let (_cancel, running) = state.scrolling.begin().expect("begin scrolling");
        assert!(state.active_capture_block_reason().is_some());
        running.store(false, Ordering::SeqCst);
        assert_eq!(state.active_capture_block_reason(), None);

        *state.inplace.lock() = Some(InplaceSession {
            label: "inplace-1".to_string(),
            capture_id: "cap-1".to_string(),
            scale_factor: 2.0,
            tool: "arrow".to_string(),
            geometry: InplaceGeometry {
                view_width: 100.0,
                view_height: 100.0,
                selection: InplaceRect::from_xywh(0.0, 0.0, 50.0, 50.0),
                toolbar: InplaceRect::from_xywh(0.0, 50.0, 50.0, 20.0),
                toolbar_side: "below".to_string(),
            },
            monitor_bounds: capture::MonitorBounds {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
        });
        assert!(state.active_capture_block_reason().is_some());
        *state.inplace.lock() = None;
        assert_eq!(state.active_capture_block_reason(), None);
    }
}
