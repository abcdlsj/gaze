#![cfg(target_os = "macos")]

use crate::capture::{OverlaySessionInfo, WindowRect};
use block2::RcBlock;
use image::RgbaImage;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSColor, NSEvent, NSEventMask,
    NSPopUpMenuWindowLevel, NSRunningApplication, NSWindow, NSWindowAnimationBehavior,
    NSWindowCollectionBehavior, NSWindowSharingType, NSWorkspace,
    NSWorkspaceActiveSpaceDidChangeNotification,
};
use objc2_core_foundation::{
    CFData, CFDictionary, CFNumber, CFNumberType, CFRetained, CFString, CGPoint, CGRect, CGSize,
};
#[allow(deprecated)]
use objc2_core_graphics::{
    CGDisplayBounds, CGImage, CGMainDisplayID, CGRectMakeWithDictionaryRepresentation,
    CGWindowImageOption, CGWindowListCopyWindowInfo, CGWindowListCreateImage, CGWindowListOption,
};
use objc2_foundation::{
    ns_string, MainThreadMarker, NSActivityOptions, NSNotification, NSObjectProtocol, NSPoint,
    NSProcessInfo, NSRect, NSSize,
};
use objc2_quartz_core::{kCAGravityResize, CATransaction};
use parking_lot::Mutex;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Thread-safe wrapper around an immutable CoreGraphics `CGImage`.
pub struct SendCGImage(pub CFRetained<CGImage>);

// SAFETY: Apple documents `CGImageRef` as immutable and thread-safe to retain/release/pass across threads.
unsafe impl Send for SendCGImage {}
unsafe impl Sync for SendCGImage {}

impl Clone for SendCGImage {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

/// Wrapper for holding an `NSProcessInfo` App Nap activity token for the process lifetime.
struct ActivityGuard(#[allow(dead_code)] Retained<ProtocolObject<dyn NSObjectProtocol>>);
unsafe impl Send for ActivityGuard {}
unsafe impl Sync for ActivityGuard {}

static APP_NAP_GUARD: OnceLock<ActivityGuard> = OnceLock::new();

/// Disables macOS App Nap for this menu-bar accessory process while still allowing idle system sleep.
/// Keeps global hotkeys and pre-warmed overlay IPC instantaneous even after hours of inactivity.
pub fn disable_app_nap() {
    let _ = APP_NAP_GUARD.get_or_init(|| {
        let info = NSProcessInfo::processInfo();
        let token = info.beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            ns_string!("Keep Gaze global capture hotkeys responsive"),
        );
        ActivityGuard(token)
    });
}

/// Captures the exact monitor rectangle directly into a hardware-backed `CGImage`.
/// Includes menu bar, status items, dock, wallpaper, and all visible windows on that display.
pub fn capture_display_cg_image(
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) -> Result<SendCGImage, String> {
    let cg_rect = CGRect {
        origin: CGPoint {
            x: monitor_x as f64,
            y: monitor_y as f64,
        },
        size: CGSize {
            width: monitor_width as f64,
            height: monitor_height as f64,
        },
    };
    #[allow(deprecated)]
    let cg_image = CGWindowListCreateImage(
        cg_rect,
        CGWindowListOption::OptionOnScreenOnly,
        0,
        CGWindowImageOption::Default,
    )
    .ok_or_else(|| {
        "Screen capture failed (check Screen Recording permission in System Settings)".to_string()
    })?;
    Ok(SendCGImage(cg_image))
}

/// Captures a single window directly by CGWindowID into an `RgbaImage` without enumerating all windows.
pub fn capture_window_cg_rgba(
    window_id: u32,
    bounds: Option<(i32, i32, u32, u32)>,
) -> Result<RgbaImage, String> {
    let cg_rect = match bounds {
        Some((x, y, w, h)) if w > 0 && h > 0 => CGRect {
            origin: CGPoint {
                x: x as f64,
                y: y as f64,
            },
            size: CGSize {
                width: w as f64,
                height: h as f64,
            },
        },
        _ => unsafe { objc2_core_graphics::CGRectNull },
    };
    #[allow(deprecated)]
    let cg_image = CGWindowListCreateImage(
        cg_rect,
        CGWindowListOption::OptionIncludingWindow,
        window_id,
        CGWindowImageOption::Default,
    )
    .ok_or_else(|| format!("Failed to capture window {window_id}"))?;
    cg_image_to_rgba(&cg_image, false)
}

/// Single-pass BGRA -> RGBA conversion directly from CoreGraphics `CFData` without intermediate copies.
pub fn cg_image_to_rgba(cg_image: &CGImage, force_opaque: bool) -> Result<RgbaImage, String> {
    let width = CGImage::width(Some(cg_image));
    let height = CGImage::height(Some(cg_image));
    if width == 0 || height == 0 {
        return Err("Captured image has zero dimensions".to_string());
    }
    let bytes_per_row = CGImage::bytes_per_row(Some(cg_image));
    let data_provider = CGImage::data_provider(Some(cg_image))
        .ok_or_else(|| "CGImage has no data provider".to_string())?;
    let cf_data = objc2_core_graphics::CGDataProvider::data(Some(&data_provider))
        .ok_or_else(|| "Failed to read CGImage pixel data".to_string())?;

    let src_len = CFData::length(&cf_data) as usize;
    let src_ptr = CFData::byte_ptr(&cf_data);
    if src_ptr.is_null() || src_len < height.saturating_sub(1) * bytes_per_row + width * 4 {
        return Err("CGImage pixel buffer is unexpectedly short".to_string());
    }
    // SAFETY: `cf_data` stays alive for the duration of this slice borrow and bounds were verified above.
    let src = unsafe { std::slice::from_raw_parts(src_ptr, src_len) };

    let row_bytes = width * 4;
    let mut out = vec![0u8; height * row_bytes];

    for y in 0..height {
        let s_row = &src[y * bytes_per_row..y * bytes_per_row + row_bytes];
        let d_row = &mut out[y * row_bytes..(y + 1) * row_bytes];
        let s_chunks = s_row.chunks_exact(4);
        let d_chunks = d_row.chunks_exact_mut(4);
        if force_opaque {
            for (s, d) in s_chunks.zip(d_chunks) {
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
                d[3] = 255;
            }
        } else {
            for (s, d) in s_chunks.zip(d_chunks) {
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
                d[3] = s[3];
            }
        }
    }

    RgbaImage::from_raw(width as u32, height as u32, out)
        .ok_or_else(|| "Failed to build RgbaImage from CGImage".to_string())
}

/// Single-pass window enumeration via `CGWindowListCopyWindowInfo` (< 1ms).
/// Returns visible windows on the target monitor in front-to-back Z-order, clipped to monitor bounds.
pub fn enumerate_monitor_windows_fast(
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) -> Vec<WindowRect> {
    let mut windows = Vec::new();
    let self_pid = std::process::id() as i32;

    let Some(cf_array) = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    ) else {
        return windows;
    };

    let key_pid = CFString::from_static_str("kCGWindowOwnerPID");
    let key_owner = CFString::from_static_str("kCGWindowOwnerName");
    let key_name = CFString::from_static_str("kCGWindowName");
    let key_number = CFString::from_static_str("kCGWindowNumber");
    let key_layer = CFString::from_static_str("kCGWindowLayer");
    let key_alpha = CFString::from_static_str("kCGWindowAlpha");
    let key_bounds = CFString::from_static_str("kCGWindowBounds");
    let key_sharing = CFString::from_static_str("kCGWindowSharingState");

    let count = cf_array.count();
    let mon_w = monitor_width as i32;
    let mon_h = monitor_height as i32;

    for i in 0..count {
        unsafe {
            let dict_ptr = cf_array.value_at_index(i) as *const CFDictionary;
            if dict_ptr.is_null() {
                continue;
            }
            let dict = &*dict_ptr;

            // Skip Gaze's own windows.
            if dict_i32(dict, &key_pid) == Some(self_pid) {
                continue;
            }
            // Skip invisible or non-shareable windows.
            if dict_i32(dict, &key_sharing) == Some(0) {
                continue;
            }
            if dict_f64(dict, &key_alpha).unwrap_or(1.0) <= 0.01 {
                continue;
            }
            // Only normal application windows (0) and floating palettes/popovers (< 24, below menu bar).
            let layer = dict_i32(dict, &key_layer).unwrap_or(0);
            if !(0..24).contains(&layer) {
                continue;
            }

            let app_name = dict_string(dict, &key_owner).unwrap_or_default();
            if app_name.is_empty()
                || app_name.eq_ignore_ascii_case("Window Server")
                || app_name.eq_ignore_ascii_case("Dock")
                || app_name.eq_ignore_ascii_case("Control Center")
                || app_name.eq_ignore_ascii_case("Wallpaper")
                || app_name.eq_ignore_ascii_case("SystemUIServer")
            {
                continue;
            }

            let title = dict_string(dict, &key_name).unwrap_or_default();
            if app_name.eq_ignore_ascii_case("Finder") && title.is_empty() && layer != 0 {
                continue;
            }

            let Some(window_id) = dict_i32(dict, &key_number).map(|v| v as u32) else {
                continue;
            };
            let Some(rect) = dict_rect(dict, &key_bounds) else {
                continue;
            };

            let raw_w = rect.size.width.round() as i32;
            let raw_h = rect.size.height.round() as i32;
            if raw_w < 32 || raw_h < 32 {
                continue;
            }

            // Convert to monitor-relative coordinates and clip to visible monitor bounds.
            let rel_x1 = rect.origin.x.round() as i32 - monitor_x;
            let rel_y1 = rect.origin.y.round() as i32 - monitor_y;
            let rel_x2 = rel_x1 + raw_w;
            let rel_y2 = rel_y1 + raw_h;

            let cx1 = rel_x1.clamp(0, mon_w);
            let cy1 = rel_y1.clamp(0, mon_h);
            let cx2 = rel_x2.clamp(0, mon_w);
            let cy2 = rel_y2.clamp(0, mon_h);

            let cw = cx2 - cx1;
            let ch = cy2 - cy1;
            if cw < 32 || ch < 32 {
                continue;
            }

            // Skip invisible desktop-wide helper overlays (e.g. untitled full-monitor Finder desktop window).
            if app_name.eq_ignore_ascii_case("Finder")
                && title.is_empty()
                && cw >= mon_w - 2
                && ch >= mon_h - 2
            {
                continue;
            }

            windows.push(WindowRect {
                id: window_id,
                app_name,
                title,
                x: cx1,
                y: cy1,
                width: cw as u32,
                height: ch as u32,
            });
        }
    }

    windows
}

unsafe fn dict_value(dict: &CFDictionary, key: &CFString) -> *const c_void {
    dict.value((key as *const CFString).cast())
}

unsafe fn dict_i32(dict: &CFDictionary, key: &CFString) -> Option<i32> {
    let ptr = dict_value(dict, key) as *const CFNumber;
    if ptr.is_null() {
        return None;
    }
    let mut val = 0i32;
    if (*ptr).value(CFNumberType::IntType, (&mut val as *mut i32).cast()) {
        Some(val)
    } else {
        None
    }
}

unsafe fn dict_f64(dict: &CFDictionary, key: &CFString) -> Option<f64> {
    let ptr = dict_value(dict, key) as *const CFNumber;
    if ptr.is_null() {
        return None;
    }
    let mut val = 0.0f64;
    if (*ptr).value(CFNumberType::DoubleType, (&mut val as *mut f64).cast()) {
        Some(val)
    } else {
        None
    }
}

unsafe fn dict_string(dict: &CFDictionary, key: &CFString) -> Option<String> {
    let ptr = dict_value(dict, key) as *const CFString;
    if ptr.is_null() {
        return None;
    }
    Some((*ptr).to_string())
}

unsafe fn dict_rect(dict: &CFDictionary, key: &CFString) -> Option<CGRect> {
    let ptr = dict_value(dict, key) as *const CFDictionary;
    if ptr.is_null() {
        return None;
    }
    let mut rect = CGRect::default();
    if CGRectMakeWithDictionaryRepresentation(Some(&*ptr), &mut rect) {
        Some(rect)
    } else {
        None
    }
}

/// Converts CoreGraphics top-left display coordinates into Cocoa bottom-left screen `NSRect`.
fn cg_rect_to_cocoa_frame(mx: i32, my: i32, mw: u32, mh: u32) -> NSRect {
    let main_height = CGDisplayBounds(CGMainDisplayID()).size.height;
    let cocoa_y = main_height - (my as f64 + mh as f64);
    NSRect::new(
        NSPoint::new(mx as f64, cocoa_y),
        NSSize::new(mw as f64, mh as f64),
    )
}

struct RetainedMonitor(Retained<AnyObject>);
unsafe impl Send for RetainedMonitor {}
unsafe impl Sync for RetainedMonitor {}

static ESCAPE_MONITORS: OnceLock<Mutex<Vec<RetainedMonitor>>> = OnceLock::new();
static SPACE_OBSERVER: OnceLock<ActivityGuard> = OnceLock::new();
static LAST_PRESENT_MS: AtomicI64 = AtomicI64::new(0);

fn escape_monitors() -> &'static Mutex<Vec<RetainedMonitor>> {
    ESCAPE_MONITORS.get_or_init(|| Mutex::new(Vec::new()))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Installs a workspace Space-change observer so swiping 4 fingers to another Space
/// immediately dismisses an open capture overlay instead of sticking over the destination Space.
pub fn install_space_change_observer(app: &AppHandle) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = SPACE_OBSERVER.get_or_init(move || {
            let workspace = NSWorkspace::sharedWorkspace();
            let center = workspace.notificationCenter();
            let block = RcBlock::new(move |_note: NonNull<NSNotification>| {
                // Ignore any transient notification fired right as the overlay opens.
                if now_ms().saturating_sub(LAST_PRESENT_MS.load(Ordering::SeqCst)) < 200 {
                    return;
                }
                crate::dismiss_overlay_from_native(&app_clone);
            });
            let observer = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceActiveSpaceDidChangeNotification),
                    None,
                    None,
                    &block,
                )
            };
            ActivityGuard(observer)
        });
    });
}

/// Installs native local & global Escape key monitors while the overlay is open so pressing Esc
/// ALWAYS dismisses the overlay even on macOS Fullscreen Spaces where key focus may be restricted.
unsafe fn install_escape_monitors(app: AppHandle) {
    remove_escape_monitors();
    let mut list = escape_monitors().lock();

    let app_local = app.clone();
    let local_block = RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
        if ev.as_ref().keyCode() == 53 {
            crate::dismiss_overlay_from_native(&app_local);
            return std::ptr::null_mut();
        }
        ev.as_ptr()
    });
    if let Some(m) =
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &local_block)
    {
        list.push(RetainedMonitor(m));
    }

    let global_block = RcBlock::new(move |ev: NonNull<NSEvent>| {
        if ev.as_ref().keyCode() == 53 {
            crate::dismiss_overlay_from_native(&app);
        }
    });
    if let Some(m) =
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &global_block)
    {
        list.push(RetainedMonitor(m));
    }
}

unsafe fn remove_escape_monitors() {
    let mut list = escape_monitors().lock();
    for monitor in list.drain(..) {
        NSEvent::removeMonitor(&monitor.0);
    }
}

/// Applies above-menubar level, active-space + fullscreen-auxiliary behavior, and zero-animation
/// config to the overlay `NSWindow`. Must be called on the main thread.
unsafe fn configure_overlay_ns_window(ns_window: &NSWindow) {
    // Above NSMainMenuWindowLevel (24) and NSStatusWindowLevel (25) so the overlay completely
    // covers & freezes the menu bar and receives clicks starting at y = 0, without blocking system
    // Force Quit / lock screen.
    ns_window.setLevel(NSPopUpMenuWindowLevel);
    // MoveToActiveSpace + FullScreenAuxiliary puts the overlay onto the current Space (including
    // native Fullscreen Spaces) WITHOUT gluing it across Spaces when the user swipes 4 fingers.
    ns_window.setCollectionBehavior(
        NSWindowCollectionBehavior::MoveToActiveSpace
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Transient
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    ns_window.setAcceptsMouseMovedEvents(true);
    ns_window.setHidesOnDeactivate(false);
    ns_window.setHasShadow(false);
    ns_window.setOpaque(false);
    ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
    ns_window.setAnimationBehavior(NSWindowAnimationBehavior::None);
    ns_window.setSharingType(NSWindowSharingType::None);
}

/// Configures the pre-warmed overlay window right after creation.
pub fn configure_overlay_window(win: &WebviewWindow) {
    let win_clone = win.clone();
    let _ = win.run_on_main_thread(move || {
        if let Ok(ptr) = win_clone.ns_window() {
            unsafe {
                let ns_window = &*(ptr as *const NSWindow);
                configure_overlay_ns_window(ns_window);
            }
        }
    });
}

/// Returns true if Gaze has any other visible window (e.g. Editor / Preferences) residing on a
/// DIFFERENT Space than the currently active Space.
unsafe fn has_other_visible_window_on_different_space(app: &AppHandle) -> bool {
    for (label, w) in app.webview_windows() {
        if label == crate::windows::LABEL_OVERLAY {
            continue;
        }
        if let Ok(ptr) = w.ns_window() {
            let other = &*(ptr as *const NSWindow);
            if other.isVisible() && !other.isOnActiveSpace() {
                return true;
            }
        }
    }
    false
}

/// Returns true if Gaze has any other visible window on any Space.
unsafe fn has_any_other_visible_window(app: &AppHandle) -> bool {
    for (label, w) in app.webview_windows() {
        if label == crate::windows::LABEL_OVERLAY {
            continue;
        }
        if let Ok(ptr) = w.ns_window() {
            let other = &*(ptr as *const NSWindow);
            if other.isVisible() {
                return true;
            }
        }
    }
    false
}

/// Atomically installs the hardware-backed frozen desktop `CGImage` into the overlay's native
/// `CALayer`, positions the window across the entire display (including menu bar & notch),
/// brings it to the front immediately (~1-2ms), and then emits `overlay-session-ready` so the
/// WebView sees the final resized viewport dimensions immediately.
pub fn present_native_overlay(
    app: &AppHandle,
    win: &WebviewWindow,
    cg_image: SendCGImage,
    info: OverlaySessionInfo,
) -> Result<(), String> {
    let app_clone = app.clone();
    let win_clone = win.clone();
    let frame = cg_rect_to_cocoa_frame(
        info.monitor_x,
        info.monitor_y,
        info.monitor_width,
        info.monitor_height,
    );
    let scale_factor = info.scale_factor;

    app.run_on_main_thread(move || {
        let Ok(ptr) = win_clone.ns_window() else {
            return;
        };
        LAST_PRESENT_MS.store(now_ms(), Ordering::SeqCst);
        unsafe {
            let ns_window = &*(ptr as *const NSWindow);
            if let Some(mtm) = MainThreadMarker::new() {
                let ns_app = NSApplication::sharedApplication(mtm);
                if ns_app.isHidden() {
                    ns_app.unhideWithoutActivation();
                }
            }

            configure_overlay_ns_window(ns_window);

            // Set frame AFTER setting level above menu bar so AppKit never constrains below menu bar.
            ns_window.setFrame_display_animate(frame, true, false);

            if let Some(content_view) = ns_window.contentView() {
                content_view.setWantsLayer(true);
                if let Some(layer) = content_view.layer() {
                    CATransaction::begin();
                    CATransaction::setDisableActions(true);
                    let cg_obj = &*(CFRetained::as_ptr(&cg_image.0).as_ptr().cast::<AnyObject>());
                    layer.setContents(Some(cg_obj));
                    layer.setContentsGravity(kCAGravityResize);
                    layer.setContentsScale(scale_factor.max(1.0) as f64);
                    CATransaction::commit();
                    CATransaction::flush();
                }

                // Ensure WKWebView subview matches the full display frame.
                let bounds = content_view.bounds();
                let subviews = content_view.subviews();
                for subview in subviews.iter() {
                    subview.setFrame(bounds);
                }
            }

            // Order front on the active Space FIRST so macOS never interprets activation as a
            // request to switch Spaces back to Desktop 1.
            ns_window.orderFrontRegardless();

            // Activate without `ActivateAllWindows` (and avoid activating at all when another
            // Gaze window lives on a different Space, which would yank macOS off a Fullscreen Space).
            if !has_other_visible_window_on_different_space(&app_clone) {
                #[allow(deprecated)]
                let _ = NSRunningApplication::currentApplication()
                    .activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
            }
            ns_window.makeKeyAndOrderFront(None);

            if let Some(content_view) = ns_window.contentView() {
                if let Some(first_subview) = content_view.subviews().firstObject() {
                    ns_window.makeFirstResponder(Some(&first_subview));
                }
            }

            install_escape_monitors(app_clone.clone());
        }

        // Emit lightweight JSON metadata (< 4KB) AFTER resizing the NSWindow & WKWebView subview.
        let _ = app_clone.emit_to(
            crate::windows::LABEL_OVERLAY,
            "overlay-session-ready",
            &info,
        );
    })
    .map_err(|e| format!("Failed to present native overlay: {e}"))
}

/// Immediately hides the overlay window and clears the native `CALayer` backdrop so no stale
/// frame can ever flash on the next invocation.
pub fn hide_native_overlay(app: &AppHandle, win: &WebviewWindow) {
    let app_clone = app.clone();
    let win_clone = win.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(ptr) = win_clone.ns_window() else {
            return;
        };
        unsafe {
            remove_escape_monitors();
            let ns_window = &*(ptr as *const NSWindow);
            ns_window.orderOut(None);
            if let Some(content_view) = ns_window.contentView() {
                if let Some(layer) = content_view.layer() {
                    CATransaction::begin();
                    CATransaction::setDisableActions(true);
                    layer.setContents(None);
                    CATransaction::commit();
                }
            }
            // If Gaze has no other open windows, yield app focus back cleanly to the app underneath
            // (e.g. a Fullscreen Browser) so keyboard & 4-finger swipe gestures work immediately.
            if !has_any_other_visible_window(&app_clone) {
                if let Some(mtm) = MainThreadMarker::new() {
                    NSApplication::sharedApplication(mtm).hide(None);
                }
            }
        }
    });
}
