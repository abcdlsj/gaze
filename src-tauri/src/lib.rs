pub mod capture;
pub mod clipboard;
pub mod hotkeys;
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
use std::sync::Arc;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub store: Mutex<CaptureStore>,
    pub hotkey_errors: Mutex<HashMap<String, Option<String>>>,
    pub scrolling: ScrollingController,
}

impl AppState {
    fn new() -> Self {
        Self {
            settings: Mutex::new(AppSettings::load()),
            store: Mutex::new(CaptureStore::default()),
            hotkey_errors: Mutex::new(HashMap::new()),
            scrolling: ScrollingController::default(),
        }
    }
}

pub fn dispatch_capture_action(app: AppHandle, action: &'static str) {
    // Run off the hotkey callback thread so screen capture never blocks OS event dispatch.
    std::thread::spawn(move || {
        let state = app.state::<Arc<AppState>>();
        match action {
            hotkeys::ACTION_AREA => {
                let _ = start_overlay_capture(&app, &state, "area");
            }
            hotkeys::ACTION_WINDOW => {
                let _ = start_overlay_capture(&app, &state, "window");
            }
            hotkeys::ACTION_SCROLLING => {
                let _ = start_overlay_capture(&app, &state, "scrolling");
            }
            hotkeys::ACTION_FULLSCREEN => {
                if let Ok((img, scale)) = capture::capture_fullscreen() {
                    let meta = state.store.lock().insert(img, scale, "fullscreen");
                    let _ = finalize_capture(&app, &state, &meta, false);
                }
            }
            hotkeys::ACTION_CLIPBOARD => {
                if let Ok(img) = clipboard::read_image_from_clipboard() {
                    let meta = state.store.lock().insert(img, 1.0, "clipboard");
                    let _ = windows::open_editor(
                        &app,
                        &meta.id,
                        meta.width,
                        meta.height,
                        meta.scale_factor,
                    );
                }
            }
            _ => {}
        }
    });
}

pub fn start_overlay_capture(
    app: &AppHandle,
    state: &Arc<AppState>,
    mode: &str,
) -> Result<(), String> {
    windows::close_overlay(app);
    // Tiny pause so any existing overlay window is unmapped before capturing desktop.
    std::thread::sleep(std::time::Duration::from_millis(40));
    let session = capture::capture_overlay_session(mode)?;
    let info = session.info();
    state.store.lock().overlay = Some(session);
    windows::open_overlay(app, &info)?;
    Ok(())
}

pub fn finalize_capture(
    app: &AppHandle,
    state: &Arc<AppState>,
    meta: &CaptureMeta,
    is_area_crop: bool,
) -> Result<(), String> {
    let settings = state.settings.lock().clone();
    let img_clone = {
        let store = state.store.lock();
        store
            .get(&meta.id)
            .map(|c| c.image.clone())
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
            windows::open_thumbnail(app, &meta.id)?;
        } else {
            windows::open_editor(app, &meta.id, meta.width, meta.height, meta.scale_factor)?;
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

    let errors = hotkeys::sync_hotkeys(&app, &new_settings.hotkeys, dispatch_capture_action);
    *state.hotkey_errors.lock() = errors.clone();
    *state.settings.lock() = new_settings;
    Ok(errors)
}

#[tauri::command]
fn reset_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AppSettings, String> {
    let defaults = AppSettings::default();
    defaults.save()?;
    let errors = hotkeys::sync_hotkeys(&app, &defaults.hotkeys, dispatch_capture_action);
    *state.hotkey_errors.lock() = errors;
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
            let (img, scale) = capture::capture_fullscreen()?;
            let meta = state.store.lock().insert(img, scale, "fullscreen");
            finalize_capture(&app, &state, &meta, false)
        }
        "clipboard" => {
            let img = clipboard::read_image_from_clipboard()?;
            let meta = state.store.lock().insert(img, 1.0, "clipboard");
            windows::open_editor(&app, &meta.id, meta.width, meta.height, meta.scale_factor)
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
    let img = state
        .store
        .lock()
        .overlay
        .as_ref()
        .map(|s| s.image.clone())
        .ok_or_else(|| "No active overlay session".to_string())?;
    let bytes = capture::encode_png(&img)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn cancel_overlay(app: AppHandle, state: State<'_, Arc<AppState>>) {
    state.store.lock().overlay = None;
    windows::close_overlay(&app);
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
    let (cropped, scale) = {
        let store = state.store.lock();
        let session = store
            .overlay
            .as_ref()
            .ok_or_else(|| "No active overlay session".to_string())?;
        let img = capture::crop_from_session(session, x, y, width, height)?;
        (img, session.scale_factor)
    };

    windows::close_overlay(&app);
    state.store.lock().overlay = None;

    let meta = state.store.lock().insert(cropped.clone(), scale, "area");
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
            windows::open_editor(&app, &meta.id, meta.width, meta.height, meta.scale_factor)?;
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
) -> Result<CaptureMeta, String> {
    let settings = state.settings.lock().clone();
    let session_copy = state.store.lock().overlay.clone();
    windows::close_overlay(&app);
    state.store.lock().overlay = None;

    let (img, scale) =
        capture::capture_window_with_background(window_id, &settings, session_copy.as_ref())?;
    let meta = state.store.lock().insert(img, scale, "window");
    finalize_capture(&app, &state, &meta, false)?;
    Ok(meta)
}

#[tauri::command]
fn get_capture_meta(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<CaptureMeta, String> {
    state
        .store
        .lock()
        .get(&id)
        .map(|c| c.meta())
        .ok_or_else(|| format!("Capture {id} not found"))
}

#[tauri::command]
fn get_capture_image_png(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Response, String> {
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
    let meta = state.store.lock().insert(img, scale_factor, "pin");
    windows::open_pin(&app, &meta.id, meta.width, meta.height, meta.scale_factor)?;
    Ok(meta)
}

#[tauri::command]
fn open_editor_for_capture(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let meta = state
        .store
        .lock()
        .get(&id)
        .map(|c| c.meta())
        .ok_or_else(|| format!("Capture {id} not found"))?;
    windows::open_editor(&app, &meta.id, meta.width, meta.height, meta.scale_factor)
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
            }

            let handle = app.handle().clone();
            tray::setup_tray(&handle, dispatch_capture_action)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

            let settings = app_state.settings.lock().clone();
            let errors =
                hotkeys::sync_hotkeys(&handle, &settings.hotkeys, dispatch_capture_action);
            *app_state.hotkey_errors.lock() = errors;

            // Open Preferences on first launch so user immediately sees Shotter is ready.
            let _ = windows::open_preferences(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            reset_settings,
            get_hotkey_errors,
            check_permissions,
            request_screen_permission,
            open_permission_settings,
            trigger_capture,
            get_overlay_session,
            get_overlay_image_png,
            cancel_overlay,
            complete_area_selection,
            complete_window_selection,
            get_capture_meta,
            get_capture_image_png,
            copy_image_bytes,
            copy_capture_by_id,
            copy_text_to_clipboard,
            save_image_bytes,
            save_capture_by_id,
            pin_image_bytes,
            open_editor_for_capture,
            open_preferences_window,
            open_screenshots_folder,
            start_scrolling_capture,
            stop_scrolling_capture,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Shotter");

    // Keep Shotter running in the menu bar / tray even when all windows are closed.
    app.run(|_app_handle, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
