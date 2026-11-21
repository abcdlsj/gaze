use crate::hotkeys::{
    ACTION_AREA, ACTION_CLIPBOARD, ACTION_FULLSCREEN, ACTION_SCROLLING, ACTION_WINDOW,
};
use crate::windows;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;

const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");

pub fn setup_tray<F>(app: &AppHandle, on_action: F) -> Result<(), String>
where
    F: Fn(AppHandle, &'static str) + Send + Sync + Clone + 'static,
{
    let area = MenuItem::with_id(app, "tray_area", "Capture Area", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let fullscreen =
        MenuItem::with_id(app, "tray_fullscreen", "Capture Fullscreen", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let window = MenuItem::with_id(app, "tray_window", "Capture Window", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let scrolling = MenuItem::with_id(
        app,
        "tray_scrolling",
        "Scrolling Screenshot",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let clipboard = MenuItem::with_id(
        app,
        "tray_clipboard",
        "Open from Clipboard",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let prefs = MenuItem::with_id(app, "tray_prefs", "Preferences...", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit Gaze", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    let menu = Menu::with_items(
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
    .map_err(|e| e.to_string())?;

    let icon = Image::from_bytes(TRAY_ICON_BYTES)
        .map_err(|e| format!("Failed to load tray icon: {e}"))?;

    let cb = on_action.clone();
    let builder = TrayIconBuilder::with_id("gaze-tray")
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
