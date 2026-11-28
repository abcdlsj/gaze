use crate::hotkeys::{
    ACTION_AREA, ACTION_CLIPBOARD, ACTION_FULLSCREEN, ACTION_SCROLLING, ACTION_WINDOW,
};
use crate::settings::HotkeyConfig;
use crate::updater::{UpdatePhase, UpdateStatus};
use crate::windows;
use tauri::image::Image;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
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

/// Returns `(label, enabled)` for the optional minimalist update menu item,
/// or `None` when the updater is idle/checking (completely hidden).
pub(crate) fn format_update_menu_item(status: &UpdateStatus) -> Option<(String, bool)> {
    let ver = status.latest.as_deref().unwrap_or("");
    match status.state {
        UpdatePhase::Idle | UpdatePhase::Checking => None,
        UpdatePhase::Available => {
            if !status.available || ver.is_empty() {
                return None;
            }
            Some((format!("Update to v{ver}"), true))
        }
        UpdatePhase::Downloading => {
            let pct = status.progress.min(99);
            Some((format!("Downloading {pct}%…"), false))
        }
        UpdatePhase::Verifying => Some(("Verifying update…".to_string(), false)),
        UpdatePhase::ReadyToRestart => {
            if ver.is_empty() {
                Some(("Restart to update".to_string(), true))
            } else {
                Some((format!("Restart to v{ver}"), true))
            }
        }
        UpdatePhase::Flushing | UpdatePhase::Installing => Some(("Restarting…".to_string(), false)),
        UpdatePhase::Error => {
            if !status.available || ver.is_empty() {
                return None;
            }
            Some((format!("Retry update to v{ver}"), true))
        }
    }
}

fn build_tray_menu(
    app: &AppHandle,
    hotkeys: &HotkeyConfig,
    update_status: Option<&UpdateStatus>,
) -> Result<Menu<tauri::Wry>, String> {
    let area = make_shortcut_item(app, "tray_area", "Capture", &hotkeys.capture_area)?;
    let scrolling = make_shortcut_item(
        app,
        "tray_scrolling",
        "Scrolling Screenshot",
        &hotkeys.capture_scrolling,
    )?;
    let fullscreen = make_shortcut_item(
        app,
        "tray_fullscreen",
        "Capture Fullscreen",
        &hotkeys.capture_fullscreen,
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
    let update_item = match update_status.and_then(format_update_menu_item) {
        Some((label, enabled)) => Some(
            MenuItem::with_id(app, "tray_update", &label, enabled, None::<&str>)
                .map_err(|e| e.to_string())?,
        ),
        None => None,
    };
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit Gaze", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> =
        vec![&area, &scrolling, &fullscreen, &clipboard, &sep1, &prefs];
    if let Some(ref item) = update_item {
        items.push(item);
    }
    items.push(&sep2);
    items.push(&quit);

    Menu::with_items(app, &items).map_err(|e| e.to_string())
}

pub fn update_tray_menu(
    app: &AppHandle,
    hotkeys: &HotkeyConfig,
    update_status: Option<&UpdateStatus>,
) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app, hotkeys, update_status) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn setup_tray<F>(app: &AppHandle, hotkeys: &HotkeyConfig, on_action: F) -> Result<(), String>
where
    F: Fn(AppHandle, &'static str) + Send + Sync + Clone + 'static,
{
    let menu = build_tray_menu(app, hotkeys, None)?;

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
            "tray_update" => {
                crate::handle_tray_update_click(app_handle);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_status(state: UpdatePhase, available: bool, progress: u8) -> UpdateStatus {
        UpdateStatus {
            current: "0.2.6".to_string(),
            latest: if available {
                Some("0.2.7".to_string())
            } else {
                None
            },
            available,
            state,
            progress,
            can_apply: true,
            release_url: Some("https://github.com/abcdlsj/gaze/releases/tag/v0.2.7".to_string()),
            notes: None,
            error: None,
        }
    }

    #[test]
    fn tray_update_item_hidden_when_idle_and_formatted_per_phase() {
        assert_eq!(
            format_update_menu_item(&sample_status(UpdatePhase::Idle, false, 0)),
            None
        );
        assert_eq!(
            format_update_menu_item(&sample_status(UpdatePhase::Checking, false, 0)),
            None
        );
        assert_eq!(
            format_update_menu_item(&sample_status(UpdatePhase::Available, true, 0)),
            Some(("Update to v0.2.7".to_string(), true))
        );
        assert_eq!(
            format_update_menu_item(&sample_status(UpdatePhase::Downloading, true, 42)),
            Some(("Downloading 42%…".to_string(), false))
        );
        assert_eq!(
            format_update_menu_item(&sample_status(UpdatePhase::ReadyToRestart, true, 100)),
            Some(("Restart to v0.2.7".to_string(), true))
        );
        assert_eq!(
            format_update_menu_item(&sample_status(UpdatePhase::Error, true, 0)),
            Some(("Retry update to v0.2.7".to_string(), true))
        );
    }
}
