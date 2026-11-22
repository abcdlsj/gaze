use crate::settings::HotkeyConfig;
use std::collections::HashMap;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const ACTION_AREA: &str = "capture_area";
pub const ACTION_FULLSCREEN: &str = "capture_fullscreen";
pub const ACTION_WINDOW: &str = "capture_window";
pub const ACTION_SCROLLING: &str = "capture_scrolling";
pub const ACTION_CLIPBOARD: &str = "open_clipboard";

/// Re-registers all configured global hotkeys. Returns a map of action -> optional error string.
pub fn sync_hotkeys<F>(
    app: &AppHandle,
    config: &HotkeyConfig,
    on_action: F,
) -> HashMap<String, Option<String>>
where
    F: Fn(AppHandle, &'static str) + Send + Sync + Clone + 'static,
{
    let mut results = HashMap::new();
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    let bindings: [(&'static str, &str); 5] = [
        (ACTION_AREA, &config.capture_area),
        (ACTION_FULLSCREEN, &config.capture_fullscreen),
        (ACTION_WINDOW, &config.capture_window),
        (ACTION_SCROLLING, &config.capture_scrolling),
        (ACTION_CLIPBOARD, &config.open_clipboard),
    ];

    for (action, raw) in bindings {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            results.insert(action.to_string(), None);
            continue;
        }
        match trimmed.parse::<Shortcut>() {
            Ok(shortcut) => {
                let cb = on_action.clone();
                let res = manager.on_shortcut(shortcut, move |app_handle, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        cb(app_handle.clone(), action);
                    }
                });
                match res {
                    Ok(()) => {
                        results.insert(action.to_string(), None);
                    }
                    Err(e) => {
                        let msg = format!("Failed to bind '{trimmed}': {e}");
                        eprintln!("[gaze] hotkey error ({action}): {msg}");
                        results.insert(action.to_string(), Some(msg));
                    }
                }
            }
            Err(e) => {
                let msg = format!("Invalid shortcut '{trimmed}': {e}");
                eprintln!("[gaze] hotkey parse error ({action}): {msg}");
                results.insert(action.to_string(), Some(msg));
            }
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shortcuts_parse_cleanly() {
        let cfg = HotkeyConfig::default();
        assert!(cfg.capture_area.parse::<Shortcut>().is_ok());
        assert!(cfg.capture_scrolling.parse::<Shortcut>().is_ok());
        assert!(cfg.open_clipboard.parse::<Shortcut>().is_ok());
        assert!("Control+1".parse::<Shortcut>().is_ok());
        assert!("F1".parse::<Shortcut>().is_ok());
    }
}
