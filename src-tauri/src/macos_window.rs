use objc2::runtime::{AnyClass, AnyObject, Bool, MessageReceiver};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSView, NSWindow};
use objc2_foundation::NSString;
use tauri::WebviewWindow;

/// Unlocks native 120Hz ProMotion rendering on every `WKWebView` inside `window`
/// (disabling WebKit's default 60fps cap) and suppresses browser back/forward
/// swipe navigation gestures.
pub fn configure_webview_120hz(window: &WebviewWindow) {
    let win_handle = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(raw_window) = win_handle.ns_window() else {
            return;
        };
        if raw_window.is_null() {
            return;
        }
        // SAFETY: Valid NSWindow pointer owned by Tauri on the macOS main thread.
        let ns_window: &NSWindow = unsafe { &*(raw_window as *const NSWindow) };
        let Some(content_view) = ns_window.contentView() else {
            return;
        };
        configure_webviews_in_view(&content_view);
    });
}

/// Brings a Gaze window to the foreground on macOS without altering the app's
/// `ActivationPolicy::Accessory` state. Calling `activateIgnoringOtherApps:` +
/// `makeKeyAndOrderFront:` resolves focus races when launched from Raycast / Spotlight.
pub fn activate_and_focus_window(window: &WebviewWindow, follow_up_ms: Option<u64>) {
    let win_handle = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let _ = win_handle.unminimize();
        let _ = win_handle.show();
        let app = NSApplication::sharedApplication(mtm);
        // SAFETY: Valid AppKit main-thread activation selector.
        unsafe {
            let _: () = msg_send![&*app, activateIgnoringOtherApps: true];
        }
        if let Ok(raw_window) = win_handle.ns_window() {
            if !raw_window.is_null() {
                let ns_window: &NSWindow = unsafe { &*(raw_window as *const NSWindow) };
                ns_window.makeKeyAndOrderFront(None);
            }
        }
        let _ = win_handle.set_focus();
    });

    if let Some(delay_ms) = follow_up_ms.filter(|&ms| ms > 0) {
        let win_follow = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let win_main = win_follow.clone();
            let _ = win_follow.run_on_main_thread(move || {
                let Some(mtm) = MainThreadMarker::new() else {
                    return;
                };
                let Ok(raw_window) = win_main.ns_window() else {
                    return;
                };
                if raw_window.is_null() {
                    return;
                }
                let ns_window: &NSWindow = unsafe { &*(raw_window as *const NSWindow) };
                if !ns_window.isVisible() {
                    return;
                }
                let app = NSApplication::sharedApplication(mtm);
                unsafe {
                    let _: () = msg_send![&*app, activateIgnoringOtherApps: true];
                }
                ns_window.makeKeyAndOrderFront(None);
                let _ = win_main.set_focus();
            });
        });
    }
}

fn configure_webviews_in_view(root: &NSView) {
    for subview in root.subviews().iter() {
        let cls_name = subview.class().name().to_string_lossy();
        if cls_name.contains("WebView") {
            let view_obj: &AnyObject = &subview;
            let _ = unlock_webview_120hz(view_obj);
            disable_webview_nav_gestures(view_obj);
        }
        configure_webviews_in_view(&subview);
    }
}

fn disable_webview_nav_gestures(web_view: &AnyObject) {
    let setters = [
        sel!(setAllowsBackForwardNavigationGestures:),
        sel!(setAllowsMagnification:),
    ];
    for setter in setters {
        unsafe {
            let responds: bool = msg_send![web_view, respondsToSelector: setter];
            if responds {
                let (): () = web_view.send_message(setter, (Bool::NO,));
            }
        }
    }
}

fn unlock_webview_120hz(web_view: &AnyObject) -> bool {
    unsafe {
        let has_config: bool = msg_send![web_view, respondsToSelector: sel!(configuration)];
        if !has_config {
            return false;
        }
        let config: *mut AnyObject = msg_send![web_view, configuration];
        if config.is_null() {
            return false;
        }
        let has_prefs: bool = msg_send![config, respondsToSelector: sel!(preferences)];
        if !has_prefs {
            return false;
        }
        let prefs: *mut AnyObject = msg_send![config, preferences];
        if prefs.is_null() {
            return false;
        }
        disable_60fps_cap_on_preferences(&*prefs)
    }
}

/// Disables WebKit's `PreferPageRenderingUpdatesNear60FPSEnabled` cap via runtime
/// selector checks across both `_features` and `_experimentalFeatures`, degrading
/// cleanly to a no-op if the SPI is absent on future macOS versions.
pub(crate) fn disable_60fps_cap_on_preferences(prefs: &AnyObject) -> bool {
    let Some(prefs_cls) = AnyClass::get(c"WKPreferences") else {
        return false;
    };
    let Some(array_cls) = AnyClass::get(c"NSArray") else {
        return false;
    };
    let Some(string_cls) = AnyClass::get(c"NSString") else {
        return false;
    };

    let target_key = "PreferPageRenderingUpdatesNear60FPSEnabled";
    let variants = [
        (sel!(_features), sel!(_setEnabled:forFeature:)),
        (
            sel!(_experimentalFeatures),
            sel!(_setEnabled:forExperimentalFeature:),
        ),
    ];

    for (list_sel, set_sel) in variants {
        unsafe {
            let class_responds: bool = msg_send![prefs_cls, respondsToSelector: list_sel];
            let inst_responds: bool = msg_send![prefs, respondsToSelector: set_sel];
            if !class_responds || !inst_responds {
                continue;
            }
            let features: *mut AnyObject = prefs_cls.send_message(list_sel, ());
            if features.is_null() {
                continue;
            }
            let is_array: bool = msg_send![features, isKindOfClass: array_cls];
            if !is_array {
                continue;
            }
            let count: usize = msg_send![features, count];
            for idx in 0..count {
                let feature: *mut AnyObject = msg_send![features, objectAtIndex: idx];
                if feature.is_null() {
                    continue;
                }
                let has_key: bool = msg_send![feature, respondsToSelector: sel!(key)];
                if !has_key {
                    continue;
                }
                let key_obj: *mut AnyObject = msg_send![feature, key];
                if key_obj.is_null() {
                    continue;
                }
                let is_str: bool = msg_send![key_obj, isKindOfClass: string_cls];
                if !is_str {
                    continue;
                }
                let key_str: &NSString = &*(key_obj as *const NSString);
                if key_str.to_string() == target_key {
                    let (): () = prefs.send_message(set_sel, (Bool::NO, feature));
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wkpreferences_120hz_unlock_selectors_and_toggle() {
        let Some(prefs_cls) = AnyClass::get(c"WKPreferences") else {
            return;
        };
        let has_features: bool =
            unsafe { msg_send![prefs_cls, respondsToSelector: sel!(_features)] };
        let has_experimental: bool =
            unsafe { msg_send![prefs_cls, respondsToSelector: sel!(_experimentalFeatures)] };
        assert!(
            has_features || has_experimental,
            "WKPreferences should expose _features or _experimentalFeatures on macOS"
        );
        let has_set_feature: bool = unsafe {
            msg_send![
                prefs_cls,
                instancesRespondToSelector: sel!(_setEnabled:forFeature:)
            ]
        };
        let has_set_experimental: bool = unsafe {
            msg_send![
                prefs_cls,
                instancesRespondToSelector: sel!(_setEnabled:forExperimentalFeature:)
            ]
        };
        assert!(
            has_set_feature || has_set_experimental,
            "WKPreferences instances should expose _setEnabled:forFeature:"
        );

        if MainThreadMarker::new().is_some() {
            unsafe {
                let raw: *mut AnyObject = msg_send![prefs_cls, alloc];
                let prefs: *mut AnyObject = msg_send![raw, init];
                assert!(!prefs.is_null());
                assert!(disable_60fps_cap_on_preferences(&*prefs));
            }
        }
    }

    #[test]
    fn appkit_activation_selectors_exist() {
        let app_cls = AnyClass::get(c"NSApplication").expect("NSApplication class");
        let win_cls = AnyClass::get(c"NSWindow").expect("NSWindow class");
        let app_ok: bool = unsafe {
            msg_send![
                app_cls,
                instancesRespondToSelector: sel!(activateIgnoringOtherApps:)
            ]
        };
        let win_ok: bool = unsafe {
            msg_send![
                win_cls,
                instancesRespondToSelector: sel!(makeKeyAndOrderFront:)
            ]
        };
        assert!(app_ok);
        assert!(win_ok);
    }
}
