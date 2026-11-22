use crate::hotkeys::{
    ACTION_AREA, ACTION_CLIPBOARD, ACTION_FULLSCREEN, ACTION_SCROLLING, ACTION_WINDOW,
};
use crate::settings::HotkeyConfig;
use crate::windows;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;

const TRAY_ID: &str = "gaze-tray";
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");

fn make_shortcut_item(
    app: &AppHandle,
    id: &str,
    label: &str,
    shortcut: &str,
) -> Result<MenuItem<tauri::Wry>, String> {
    let accel = shortcut.trim();
    if !accel.is_empty() {
        if let Ok(item) = MenuItem::with_id(app, id, label, true, Some(accel)) {
            return Ok(item);
        }
    }
    MenuItem::with_id(app, id, label, true, None::<&str>).map_err(|e| e.to_string())
}

fn build_tray_menu(app: &AppHandle, hotkeys: &HotkeyConfig) -> Result<Menu<tauri::Wry>, String> {
    let area = make_shortcut_item(app, "tray_area", "Capture Area", &hotkeys.capture_area)?;
    let fullscreen = make_shortcut_item(
        app,
        "tray_fullscreen",
        "Capture Fullscreen",
        &hotkeys.capture_fullscreen,
    )?;
    let window = make_shortcut_item(
        app,
        "tray_window",
        "Capture Window",
        &hotkeys.capture_window,
    )?;
    let scrolling = make_shortcut_item(
        app,
        "tray_scrolling",
        "Scrolling Screenshot",
        &hotkeys.capture_scrolling,
    )?;
    let clipboard = make_shortcut_item(
        app,
        "tray_clipboard",
        "Open from Clipboard",
        &hotkeys.open_clipboard,
    )?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let prefs = MenuItem::with_id(app, "tray_prefs", "Preferences...", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit Gaze", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    Menu::with_items(
        app,
        &[
            &area,
            &fullscreen,
            &window,
            &scrolling,
            &clipboard,
            &sep1,
            &prefs,
            &sep2,
            &quit,
        ],
    )
    .map_err(|e| e.to_string())
}

pub fn update_tray_menu(app: &AppHandle, hotkeys: &HotkeyConfig) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app, hotkeys) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn setup_tray<F>(app: &AppHandle, hotkeys: &HotkeyConfig, on_action: F) -> Result<(), String>
where
    F: Fn(AppHandle, &'static str) + Send + Sync + Clone + 'static,
{
    let menu = build_tray_menu(app, hotkeys)?;

    let icon =
        Image::from_bytes(TRAY_ICON_BYTES).map_err(|e| format!("Failed to load tray icon: {e}"))?;

    let cb = on_action.clone();
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Gaze")
        .menu(&menu)
        .on_menu_event(move |app_handle, event| match event.id.as_ref() {
            "tray_area" => cb(app_handle.clone(), ACTION_AREA),
            "tray_fullscreen" => cb(app_handle.clone(), ACTION_FULLSCREEN),
            "tray_window" => cb(app_handle.clone(), ACTION_WINDOW),
            "tray_scrolling" => cb(app_handle.clone(), ACTION_SCROLLING),
            "tray_clipboard" => cb(app_handle.clone(), ACTION_CLIPBOARD),
            "tray_prefs" => {
                let _ = windows::open_preferences(app_handle);
            }
            "tray_quit" => {
                app_handle.exit(0);
            }
            _ => {}
        });

    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);

    builder
        .build(app)
        .map_err(|e| format!("Failed to create tray icon: {e}"))?;
    Ok(())
}
