#![cfg(target_os = "macos")]

use crate::capture::{MonitorBounds, WindowRect};
use block2::RcBlock;
use image::RgbaImage;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSBackingStoreType, NSBezierPath, NSColor,
    NSCompositingOperation, NSCursor, NSEvent, NSEventMask, NSEventModifierFlags, NSFont,
    NSFontAttributeName, NSFontWeightMedium, NSFontWeightRegular,
    NSForegroundColorAttributeName, NSGraphicsContext, NSImage, NSImageSymbolConfiguration,
    NSImageSymbolScale, NSPanel, NSResponder, NSRunningApplication, NSScreen,
    NSScreenSaverWindowLevel, NSStringDrawing, NSTrackingArea, NSTrackingAreaOptions, NSView,
    NSWindow, NSWindowAnimationBehavior, NSWindowCollectionBehavior, NSWindowSharingType,
    NSWindowStyleMask, NSWorkspace, NSWorkspaceActiveSpaceDidChangeNotification,
};
use objc2_core_foundation::{
    CFData, CFDictionary, CFNumber, CFNumberType, CFRetained, CFString, CGPoint, CGRect, CGSize,
};
#[allow(deprecated)]
use objc2_core_graphics::{
    CGColor, CGContext, CGDataProvider, CGDirectDisplayID, CGDisplayBounds,
    CGDisplayCopyDisplayMode, CGDisplayIsMain, CGDisplayMode, CGError, CGGetActiveDisplayList,
    CGImage, CGMainDisplayID, CGMutablePath, CGRectMakeWithDictionaryRepresentation,
    CGWindowImageOption, CGWindowListCopyWindowInfo, CGWindowListCreateImage, CGWindowListOption,
};
use objc2_foundation::{
    ns_string, MainThreadMarker, NSActivityOptions, NSDictionary, NSNotification, NSNumber,
    NSObject, NSObjectProtocol, NSPoint, NSProcessInfo, NSRect, NSSize, NSString,
};
use objc2_quartz_core::{
    kCAFillRuleEvenOdd, kCAGravityResize, CALayer, CAShapeLayer, CATransaction,
};
use parking_lot::Mutex;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Manager};

// ============================================================================
// CoreGraphics zero-copy image & display capture (100% thread-safe)
// ============================================================================

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

/// Thread-safe raw pixel view backed directly by a `CGImage`'s `CFData` (zero full-screen copy).
pub struct SendPixelBuffer {
    cf_data: CFRetained<CFData>,
    pub width: usize,
    pub height: usize,
    pub bytes_per_row: usize,
    pub is_bgra: bool,
}

// SAFETY: `CFDataRef` returned by `CGDataProviderCopyData` is immutable and thread-safe.
unsafe impl Send for SendPixelBuffer {}
unsafe impl Sync for SendPixelBuffer {}

impl SendPixelBuffer {
    pub fn from_cg_image(cg_image: &CGImage) -> Option<Self> {
        let width = CGImage::width(Some(cg_image));
        let height = CGImage::height(Some(cg_image));
        if width == 0 || height == 0 {
            return None;
        }
        let bytes_per_row = CGImage::bytes_per_row(Some(cg_image));
        let bpp = CGImage::bits_per_pixel(Some(cg_image));
        if bpp != 32 {
            return None;
        }
        let provider = CGImage::data_provider(Some(cg_image))?;
        let cf_data = CGDataProvider::data(Some(&provider))?;
        let len = CFData::length(&cf_data) as usize;
        let ptr = CFData::byte_ptr(&cf_data);
        if ptr.is_null() || len < height.saturating_sub(1) * bytes_per_row + width * 4 {
            return None;
        }
        let bitmap_info = CGImage::bitmap_info(Some(cg_image));
        // kCGBitmapByteOrderMask = 0x7000, kCGBitmapByteOrder32Little = 0x2000 -> [B, G, R, A].
        let byte_order = bitmap_info.0 & 0x7000;
        let is_bgra = byte_order == 0x2000 || byte_order == 0;
        Some(Self {
            cf_data,
            width,
            height,
            bytes_per_row,
            is_bgra,
        })
    }

    #[inline]
    fn as_slice(&self) -> &[u8] {
        let len = CFData::length(&self.cf_data) as usize;
        let ptr = CFData::byte_ptr(&self.cf_data);
        // SAFETY: `cf_data` is immutable and validated in `from_cg_image`.
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }

    #[inline]
    pub fn sample_rgb(&self, px: usize, py: usize) -> Option<(u8, u8, u8)> {
        if px >= self.width || py >= self.height {
            return None;
        }
        let src = self.as_slice();
        let idx = py * self.bytes_per_row + px * 4;
        if idx + 3 >= src.len() {
            return None;
        }
        if self.is_bgra {
            Some((src[idx + 2], src[idx + 1], src[idx]))
        } else {
            Some((src[idx], src[idx + 1], src[idx + 2]))
        }
    }

    /// Crops only the selected monitor-relative rectangle into an `RgbaImage` (< 0.5ms).
    pub fn crop_rgba(
        &self,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        monitor_width: u32,
        monitor_height: u32,
    ) -> Result<RgbaImage, String> {
        if w < 2.0 || h < 2.0 {
            return Err("Selection is too small".to_string());
        }
        let rx = self.width as f64 / (monitor_width.max(1) as f64);
        let ry = self.height as f64 / (monitor_height.max(1) as f64);

        let px = (x * rx).round().clamp(0.0, (self.width - 1) as f64) as usize;
        let py = (y * ry).round().clamp(0.0, (self.height - 1) as f64) as usize;
        let pw = ((w * rx).round() as usize).clamp(1, self.width - px);
        let ph = ((h * ry).round() as usize).clamp(1, self.height - py);

        let src = self.as_slice();
        let row_bytes = pw * 4;
        let mut out = vec![0u8; ph * row_bytes];

        for row in 0..ph {
            let s_off = (py + row) * self.bytes_per_row + px * 4;
            let s_row = &src[s_off..s_off + row_bytes];
            let d_row = &mut out[row * row_bytes..(row + 1) * row_bytes];
            if self.is_bgra {
                for (s, d) in s_row.chunks_exact(4).zip(d_row.chunks_exact_mut(4)) {
                    d[0] = s[2];
                    d[1] = s[1];
                    d[2] = s[0];
                    d[3] = 255;
                }
            } else {
                for (s, d) in s_row.chunks_exact(4).zip(d_row.chunks_exact_mut(4)) {
                    d[0] = s[0];
                    d[1] = s[1];
                    d[2] = s[2];
                    d[3] = 255;
                }
            }
        }

        RgbaImage::from_raw(pw as u32, ph as u32, out)
            .ok_or_else(|| "Failed to build cropped RgbaImage".to_string())
    }
}

/// Crops a sub-rectangle directly from a `CGImage` without converting the whole display.
pub fn crop_cg_image_to_rgba(
    cg_image: &CGImage,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    monitor_width: u32,
    monitor_height: u32,
) -> Result<RgbaImage, String> {
    if w < 2.0 || h < 2.0 {
        return Err("Selection is too small".to_string());
    }
    let img_w = CGImage::width(Some(cg_image));
    let img_h = CGImage::height(Some(cg_image));
    if img_w == 0 || img_h == 0 {
        return Err("Captured image has zero dimensions".to_string());
    }
    let rx = img_w as f64 / (monitor_width.max(1) as f64);
    let ry = img_h as f64 / (monitor_height.max(1) as f64);
    let px = (x * rx).round().clamp(0.0, (img_w - 1) as f64);
    let py = (y * ry).round().clamp(0.0, (img_h - 1) as f64);
    let pw = (w * rx).round().clamp(1.0, img_w as f64 - px);
    let ph = (h * ry).round().clamp(1.0, img_h as f64 - py);

    let sub_rect = CGRect {
        origin: CGPoint { x: px, y: py },
        size: CGSize {
            width: pw,
            height: ph,
        },
    };
    let sub = CGImage::with_image_in_rect(Some(cg_image), sub_rect)
        .ok_or_else(|| "Failed to crop CGImage sub-rectangle".to_string())?;
    cg_image_to_rgba(&sub, true)
}

#[derive(Debug, Clone)]
pub struct MacDisplayInfo {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub is_main: bool,
}

impl MacDisplayInfo {
    fn bounds(&self) -> MonitorBounds {
        MonitorBounds {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}

/// Thread-safe display enumeration using pure CoreGraphics (never touches `NSScreen` off main thread).
pub fn enumerate_active_displays() -> Result<Vec<MacDisplayInfo>, String> {
    const MAX_DISPLAYS: u32 = 16;
    let mut ids = [0 as CGDirectDisplayID; MAX_DISPLAYS as usize];
    let mut count: u32 = 0;
    let err = unsafe { CGGetActiveDisplayList(MAX_DISPLAYS, ids.as_mut_ptr(), &mut count) };
    if err != CGError::Success || count == 0 {
        return Err("Failed to enumerate active displays".to_string());
    }

    let mut out = Vec::with_capacity(count as usize);
    for &id in &ids[..count as usize] {
        let bounds = CGDisplayBounds(id);
        let w = bounds.size.width.round().max(1.0) as u32;
        let h = bounds.size.height.round().max(1.0) as u32;
        let scale_factor = CGDisplayCopyDisplayMode(id)
            .map(|mode| {
                let pw = CGDisplayMode::pixel_width(Some(&mode)) as f64;
                if bounds.size.width > 0.0 {
                    (pw / bounds.size.width) as f32
                } else {
                    1.0
                }
            })
            .unwrap_or(1.0)
            .max(1.0);
        out.push(MacDisplayInfo {
            id,
            x: bounds.origin.x.round() as i32,
            y: bounds.origin.y.round() as i32,
            width: w,
            height: h,
            scale_factor,
            is_main: CGDisplayIsMain(id),
        });
    }
    Ok(out)
}

struct CapturedDisplay {
    info: MacDisplayInfo,
    name: String,
    cg_image: SendCGImage,
    pixel_buffer: Arc<Mutex<Option<SendPixelBuffer>>>,
    windows: Vec<WindowRect>,
}

/// Wrapper for holding an `NSProcessInfo` App Nap activity token for the process lifetime.
struct ActivityGuard(#[allow(dead_code)] Retained<ProtocolObject<dyn NSObjectProtocol>>);
unsafe impl Send for ActivityGuard {}
unsafe impl Sync for ActivityGuard {}

static APP_NAP_GUARD: OnceLock<ActivityGuard> = OnceLock::new();
static SPACE_OBSERVER: OnceLock<ActivityGuard> = OnceLock::new();
static LAST_PRESENT_MS: AtomicI64 = AtomicI64::new(0);

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Disables macOS App Nap for this menu-bar accessory process while still allowing idle system sleep.
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

/// Captures the active (cursor) display as an `RgbaImage` using pure CoreGraphics.
pub fn capture_active_display_rgba() -> Result<(RgbaImage, f32, MonitorBounds), String> {
    let displays = enumerate_active_displays()?;
    let cursor = crate::capture::get_cursor_position();
    let target = cursor
        .and_then(|(cx, cy)| {
            displays.iter().find(|d| {
                cx >= d.x && cx < d.x + d.width as i32 && cy >= d.y && cy < d.y + d.height as i32
            })
        })
        .or_else(|| displays.iter().find(|d| d.is_main))
        .unwrap_or(&displays[0]);

    let cg = capture_display_cg_image(target.x, target.y, target.width, target.height)?;
    let rgba = cg_image_to_rgba(&cg.0, true)?;
    Ok((rgba, target.scale_factor, target.bounds()))
}

/// Captures a single window directly by CGWindowID into an `RgbaImage`.
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

/// Single-pass BGRA -> RGBA conversion directly from CoreGraphics `CFData`.
pub fn cg_image_to_rgba(cg_image: &CGImage, force_opaque: bool) -> Result<RgbaImage, String> {
    let width = CGImage::width(Some(cg_image));
    let height = CGImage::height(Some(cg_image));
    if width == 0 || height == 0 {
        return Err("Captured image has zero dimensions".to_string());
    }
    let bytes_per_row = CGImage::bytes_per_row(Some(cg_image));
    let data_provider = CGImage::data_provider(Some(cg_image))
        .ok_or_else(|| "CGImage has no data provider".to_string())?;
    let cf_data = CGDataProvider::data(Some(&data_provider))
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

/// Single-pass window enumeration via `CGWindowListCopyWindowInfo` (< 1ms) bucketed across all displays.
fn enumerate_windows_for_displays(displays: &[MacDisplayInfo]) -> Vec<Vec<WindowRect>> {
    let mut per_display: Vec<Vec<WindowRect>> = vec![Vec::new(); displays.len()];
    let self_pid = std::process::id() as i32;

    let Some(cf_array) = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    ) else {
        return per_display;
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
    for i in 0..count {
        unsafe {
            let dict_ptr = cf_array.value_at_index(i) as *const CFDictionary;
            if dict_ptr.is_null() {
                continue;
            }
            let dict = &*dict_ptr;

            if dict_i32(dict, &key_pid) == Some(self_pid) {
                continue;
            }
            if dict_i32(dict, &key_sharing) == Some(0) {
                continue;
            }
            if dict_f64(dict, &key_alpha).unwrap_or(1.0) <= 0.01 {
                continue;
            }
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
            let raw_x = rect.origin.x.round() as i32;
            let raw_y = rect.origin.y.round() as i32;

            for (d_idx, disp) in displays.iter().enumerate() {
                let mon_w = disp.width as i32;
                let mon_h = disp.height as i32;
                let rel_x1 = raw_x - disp.x;
                let rel_y1 = raw_y - disp.y;
                let cx1 = rel_x1.clamp(0, mon_w);
                let cy1 = rel_y1.clamp(0, mon_h);
                let cx2 = (rel_x1 + raw_w).clamp(0, mon_w);
                let cy2 = (rel_y1 + raw_h).clamp(0, mon_h);
                let cw = cx2 - cx1;
                let ch = cy2 - cy1;
                if cw < 32 || ch < 32 {
                    continue;
                }
                if app_name.eq_ignore_ascii_case("Finder")
                    && title.is_empty()
                    && cw >= mon_w - 2
                    && ch >= mon_h - 2
                {
                    continue;
                }
                per_display[d_idx].push(WindowRect {
                    id: window_id,
                    app_name: app_name.clone(),
                    title: title.clone(),
                    x: cx1,
                    y: cy1,
                    width: cw as u32,
                    height: ch as u32,
                });
            }
        }
    }

    per_display
}

/// Single-display helper kept for cross-module callers.
pub fn enumerate_monitor_windows_fast(
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) -> Vec<WindowRect> {
    let single = [MacDisplayInfo {
        id: 0,
        x: monitor_x,
        y: monitor_y,
        width: monitor_width,
        height: monitor_height,
        scale_factor: 1.0,
        is_main: true,
    }];
    enumerate_windows_for_displays(&single)
        .into_iter()
        .next()
        .unwrap_or_default()
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

/// Fetches friendly localized names for displays on the main thread.
fn main_thread_display_names(mtm: MainThreadMarker) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let screens = NSScreen::screens(mtm);
    let key = ns_string!("NSScreenNumber");
    for screen in screens {
        let desc = screen.deviceDescription();
        if let Some(obj) = desc.objectForKey(key) {
            if let Ok(num) = obj.downcast::<NSNumber>() {
                map.insert(num.unsignedIntValue(), screen.localizedName().to_string());
            }
        }
    }
    map
}

// ============================================================================
// Pure geometry, hit-testing & action-bar layout
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq)]
struct RectF {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl RectF {
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DragHandle {
    Pending,
    Create,
    Move,
    NW,
    NE,
    SW,
    SE,
    N,
    S,
    E,
    W,
}

const DRAG_THRESHOLD_PT: f64 = 4.0;
const HANDLE_HIT_RADIUS: f64 = 10.0;
const LOUPE_W: f64 = 136.0;
const LOUPE_H: f64 = 160.0;

// Snipaste-style edit toolbar metrics. These MUST stay in sync with
// `src/components/editor/inplaceToolbarLayout.ts`, because the in-place webview editor
// redraws the very same toolbar on top of this native one at the same coordinates.
const TOOLBAR_PAD: f64 = 5.0;
const TOOLBAR_BTN: f64 = 30.0;
const TOOLBAR_GAP: f64 = 2.0;
const TOOLBAR_DIVIDER: f64 = 11.0;
const TOOLBAR_PILL_H: f64 = 40.0;
const TOOLBAR_TOOLTIP_H: f64 = 28.0;
const TOOLBAR_TOTAL_H: f64 = TOOLBAR_PILL_H + TOOLBAR_TOOLTIP_H;
const TOOLBAR_MARGIN: f64 = 8.0;
const TOOLBAR_SEL_GAP: f64 = 8.0;
/// How long the native overlay waits for the in-place webview before falling back.
const INPLACE_READY_TIMEOUT_MS: u64 = 3000;
/// Delay between ordering the webview front and hiding the native toolbar it covers.
const INPLACE_CHROME_HIDE_DELAY_MS: u64 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolbarAction {
    /// Annotation tool id understood by the web editor (`EditorTool`).
    Tool(&'static str),
    Undo,
    Redo,
    Scroll,
    Pin,
    OpenEditor,
    Save,
    Cancel,
    Done,
}

#[derive(Debug, Clone, Copy)]
struct ToolbarItem {
    /// `None` renders a vertical divider.
    action: Option<ToolbarAction>,
    symbol: &'static str,
    tooltip: &'static str,
    shortcut: &'static str,
}

const fn tb(
    action: ToolbarAction,
    symbol: &'static str,
    tooltip: &'static str,
    shortcut: &'static str,
) -> ToolbarItem {
    ToolbarItem {
        action: Some(action),
        symbol,
        tooltip,
        shortcut,
    }
}

const TB_DIVIDER: ToolbarItem = ToolbarItem {
    action: None,
    symbol: "",
    tooltip: "",
    shortcut: "",
};

const TOOLBAR_ITEMS: [ToolbarItem; 20] = [
    tb(ToolbarAction::Tool("rect"), "rectangle", "Rectangle", "S"),
    tb(ToolbarAction::Tool("ellipse"), "circle", "Ellipse", "O"),
    tb(ToolbarAction::Tool("arrow"), "arrow.up.right", "Arrow", "A"),
    tb(ToolbarAction::Tool("line"), "line.diagonal", "Line", "L"),
    tb(ToolbarAction::Tool("pen"), "pencil.tip", "Pen / Highlighter", "P"),
    tb(ToolbarAction::Tool("text"), "textformat", "Text", "T"),
    tb(ToolbarAction::Tool("pixelate"), "checkerboard.rectangle", "Mosaic", "X"),
    tb(ToolbarAction::Tool("blur"), "drop", "Blur", "B"),
    tb(ToolbarAction::Tool("counter"), "1.circle", "Step Number", "N"),
    TB_DIVIDER,
    tb(ToolbarAction::Undo, "arrow.uturn.backward", "Undo", "⌘Z"),
    tb(ToolbarAction::Redo, "arrow.uturn.forward", "Redo", "⇧⌘Z"),
    TB_DIVIDER,
    tb(
        ToolbarAction::Scroll,
        "arrow.up.and.down.text.horizontal",
        "Scrolling Capture",
        "",
    ),
    tb(ToolbarAction::Pin, "pin", "Pin on Screen", ""),
    tb(ToolbarAction::OpenEditor, "macwindow", "Open in Editor", ""),
    tb(ToolbarAction::Save, "square.and.arrow.down", "Save", "⌘S"),
    TB_DIVIDER,
    tb(ToolbarAction::Cancel, "xmark", "Cancel", "Esc"),
    tb(ToolbarAction::Done, "checkmark", "Copy & Done", "↵"),
];

/// Local x of every toolbar item inside the pill (`None` for dividers' button rect).
fn toolbar_item_xs() -> [f64; TOOLBAR_ITEMS.len()] {
    let mut xs = [0.0; TOOLBAR_ITEMS.len()];
    let mut x = TOOLBAR_PAD;
    let mut prev_was_button = false;
    for (i, item) in TOOLBAR_ITEMS.iter().enumerate() {
        if item.action.is_none() {
            xs[i] = x;
            x += TOOLBAR_DIVIDER;
            prev_was_button = false;
        } else {
            if prev_was_button {
                x += TOOLBAR_GAP;
            }
            xs[i] = x;
            x += TOOLBAR_BTN;
            prev_was_button = true;
        }
    }
    xs
}

fn toolbar_width() -> f64 {
    let xs = toolbar_item_xs();
    xs[TOOLBAR_ITEMS.len() - 1] + TOOLBAR_BTN + TOOLBAR_PAD
}

/// Undo/redo only have meaning once the in-place editor owns the annotations.
fn toolbar_item_enabled(action: ToolbarAction) -> bool {
    !matches!(action, ToolbarAction::Undo | ToolbarAction::Redo)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolbarSide {
    Below,
    Above,
    Inside,
}

#[derive(Debug, Clone, Copy)]
struct ActionBarPlacement {
    /// Outer frame of the `action_bar_view` (includes tooltip strip).
    view_rect: RectF,
    /// Local Y of the pill inside `action_bar_view`.
    pill_y_local: f64,
    /// True if tooltip draws below the pill, false if above.
    tooltip_below: bool,
    side: ToolbarSide,
}

impl ActionBarPlacement {
    /// Pill rect in display-local points.
    fn pill_rect(&self) -> RectF {
        RectF {
            x: self.view_rect.x,
            y: self.view_rect.y + self.pill_y_local,
            w: self.view_rect.w,
            h: TOOLBAR_PILL_H,
        }
    }
}

/// Snipaste placement: right-aligned with the selection, below it; flips above when the
/// bottom screen edge is too close, and moves inside the selection's bottom edge when
/// neither fits (e.g. fullscreen selections).
fn compute_action_bar_placement(sel: RectF, view_w: f64, view_h: f64) -> ActionBarPlacement {
    let bar_w = toolbar_width();
    let margin = TOOLBAR_MARGIN;
    let pill_left = (sel.x + sel.w - bar_w)
        .min(view_w - bar_w - margin)
        .max(margin);
    let below_y = sel.y + sel.h + TOOLBAR_SEL_GAP;
    let above_y = sel.y - TOOLBAR_PILL_H - TOOLBAR_SEL_GAP;
    let (pill_top, side) = if below_y + TOOLBAR_PILL_H <= view_h - margin {
        (below_y, ToolbarSide::Below)
    } else if above_y >= margin {
        (above_y, ToolbarSide::Above)
    } else {
        (
            (sel.y + sel.h - TOOLBAR_PILL_H - TOOLBAR_SEL_GAP)
                .min(view_h - TOOLBAR_PILL_H - margin)
                .max(margin),
            ToolbarSide::Inside,
        )
    };
    let tooltip_below = pill_top + TOOLBAR_PILL_H + TOOLBAR_TOOLTIP_H + 4.0 < view_h;
    let view_y = if tooltip_below {
        pill_top
    } else {
        (pill_top - TOOLBAR_TOOLTIP_H).max(0.0)
    };
    let pill_y_local = pill_top - view_y;

    ActionBarPlacement {
        view_rect: RectF {
            x: pill_left,
            y: view_y,
            w: bar_w,
            h: TOOLBAR_TOTAL_H,
        },
        pill_y_local,
        tooltip_below,
        side,
    }
}

fn handle_positions(sel: RectF) -> [(DragHandle, f64, f64); 8] {
    let mx = sel.x + sel.w * 0.5;
    let my = sel.y + sel.h * 0.5;
    let x2 = sel.x + sel.w;
    let y2 = sel.y + sel.h;
    [
        (DragHandle::NW, sel.x, sel.y),
        (DragHandle::NE, x2, sel.y),
        (DragHandle::SW, sel.x, y2),
        (DragHandle::SE, x2, y2),
        (DragHandle::N, mx, sel.y),
        (DragHandle::S, mx, y2),
        (DragHandle::W, sel.x, my),
        (DragHandle::E, x2, my),
    ]
}

fn hit_test_handle(sel: RectF, x: f64, y: f64) -> Option<DragHandle> {
    for (handle, hx, hy) in handle_positions(sel) {
        if (x - hx).abs() <= HANDLE_HIT_RADIUS && (y - hy).abs() <= HANDLE_HIT_RADIUS {
            return Some(handle);
        }
    }
    None
}

/// True if (x, y) is anywhere on the toolbar pill (buttons, dividers or padding).
fn point_in_toolbar_pill(placement: ActionBarPlacement, x: f64, y: f64) -> bool {
    placement.pill_rect().contains(x, y)
}

/// Returns the index into `TOOLBAR_ITEMS` of the button under (x, y), if any.
fn hit_test_action_bar(placement: ActionBarPlacement, x: f64, y: f64) -> Option<usize> {
    let pill = placement.pill_rect();
    let lx = x - pill.x;
    let ly = y - pill.y;
    if !(0.0..=pill.w).contains(&lx) || !(0.0..=TOOLBAR_PILL_H).contains(&ly) {
        return None;
    }
    let btn_top = (TOOLBAR_PILL_H - TOOLBAR_BTN) * 0.5;
    if !(btn_top..=btn_top + TOOLBAR_BTN).contains(&ly) {
        return None;
    }
    let xs = toolbar_item_xs();
    for (idx, item) in TOOLBAR_ITEMS.iter().enumerate() {
        if item.action.is_some() && lx >= xs[idx] && lx <= xs[idx] + TOOLBAR_BTN {
            return Some(idx);
        }
    }
    None
}

/// Maps a plain (no modifier) key to an annotation tool, mirroring the web editor shortcuts.
fn tool_for_shortcut_key(ch: &str) -> Option<&'static str> {
    TOOLBAR_ITEMS.iter().find_map(|item| match item.action {
        Some(ToolbarAction::Tool(tool)) if item.shortcut.eq_ignore_ascii_case(ch) => Some(tool),
        _ => None,
    })
}

fn find_window_at(windows: &[WindowRect], mx: f64, my: f64) -> Option<WindowRect> {
    for w in windows {
        let wx = w.x as f64;
        let wy = w.y as f64;
        if mx >= wx && mx <= wx + w.width as f64 && my >= wy && my <= wy + w.height as f64 {
            return Some(w.clone());
        }
    }
    None
}

fn rgb_to_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02X}{g:02X}{b:02X}")
}

fn compute_loupe_origin(cx: f64, cy: f64, view_w: f64, view_h: f64) -> (f64, f64) {
    let offset = 22.0;
    let left = if cx + offset + LOUPE_W < view_w - 6.0 {
        cx + offset
    } else {
        (cx - LOUPE_W - offset).max(6.0)
    };
    let top = if cy + offset + LOUPE_H < view_h - 6.0 {
        cy + offset
    } else {
        (cy - LOUPE_H - offset).max(6.0)
    };
    (left.round(), top.round())
}

// ============================================================================
// Native AppKit Classes: GazeOverlayPanel, GazeHudView, GazeOverlayView
// ============================================================================

define_class!(
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "GazeOverlayPanel"]
    struct GazeOverlayPanel;

    impl GazeOverlayPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> Bool {
            Bool::YES
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> Bool {
            Bool::NO
        }
    }
);

impl GazeOverlayPanel {
    fn create(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        let style = NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel;
        let alloc = Self::alloc(mtm);
        let panel: Retained<Self> = unsafe {
            msg_send![
                alloc,
                initWithContentRect: frame,
                styleMask: style,
                backing: NSBackingStoreType::Buffered,
                defer: Bool::NO
            ]
        };
        panel.setLevel(NSScreenSaverWindowLevel);
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        panel.setFloatingPanel(true);
        panel.setBecomesKeyOnlyIfNeeded(false);
        panel.setWorksWhenModal(true);
        panel.setOpaque(true);
        panel.setBackgroundColor(Some(&NSColor::blackColor()));
        panel.setHasShadow(false);
        panel.setHidesOnDeactivate(false);
        panel.setAcceptsMouseMovedEvents(true);
        panel.setIgnoresMouseEvents(false);
        panel.setAnimationBehavior(NSWindowAnimationBehavior::None);
        panel.setSharingType(NSWindowSharingType::None);
        unsafe {
            panel.setReleasedWhenClosed(false);
        }
        panel
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HudKind {
    Badge,
    Loupe,
    ActionBar,
    Banner,
}

struct HudViewIvars {
    display_idx: Cell<usize>,
    kind: HudKind,
}

define_class!(
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "GazeHudView"]
    #[ivars = HudViewIvars]
    struct GazeHudView;

    impl GazeHudView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> Bool {
            Bool::YES
        }

        // Let all mouse events flow cleanly to the parent GazeOverlayView.
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView {
            std::ptr::null_mut()
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty_rect: NSRect) {
            let ivars = self.ivars();
            let display_idx = ivars.display_idx.get();
            let bounds = self.bounds();
            match ivars.kind {
                HudKind::Badge => draw_badge_hud(display_idx, bounds),
                HudKind::Loupe => draw_loupe_hud(display_idx, bounds),
                HudKind::ActionBar => draw_action_bar_hud(display_idx, bounds),
                HudKind::Banner => draw_banner_hud(display_idx, bounds),
            }
        }
    }
);

impl GazeHudView {
    fn new(
        mtm: MainThreadMarker,
        frame: NSRect,
        display_idx: usize,
        kind: HudKind,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(HudViewIvars {
            display_idx: Cell::new(display_idx),
            kind,
        });
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        view.setWantsLayer(true);
        if let Some(layer) = view.layer() {
            layer.setOpaque(false);
            layer.setBackgroundColor(None);
        }
        view
    }
}

struct OverlayViewIvars {
    display_idx: Cell<usize>,
}

define_class!(
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "GazeOverlayView"]
    #[ivars = OverlayViewIvars]
    struct GazeOverlayView;

    impl GazeOverlayView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> Bool {
            Bool::YES
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> Bool {
            Bool::YES
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> Bool {
            Bool::YES
        }

        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, event: &NSEvent) {
            let pt = self.convertPoint_fromView(event.locationInWindow(), None);
            let idx = self.ivars().display_idx.get();
            with_controller(|ctrl| ctrl.on_mouse_moved(idx, pt.x, pt.y, true));
        }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) {
            let idx = self.ivars().display_idx.get();
            with_controller(|ctrl| ctrl.on_mouse_exited(idx));
        }

        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, event: &NSEvent) {
            let pt = self.convertPoint_fromView(event.locationInWindow(), None);
            let idx = self.ivars().display_idx.get();
            with_controller(|ctrl| ctrl.on_mouse_moved(idx, pt.x, pt.y, false));
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let pt = self.convertPoint_fromView(event.locationInWindow(), None);
            let idx = self.ivars().display_idx.get();
            let clicks = event.clickCount();
            with_controller(|ctrl| ctrl.on_mouse_down(idx, pt.x, pt.y, clicks));
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            let pt = self.convertPoint_fromView(event.locationInWindow(), None);
            let idx = self.ivars().display_idx.get();
            with_controller(|ctrl| ctrl.on_mouse_dragged(idx, pt.x, pt.y));
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            let pt = self.convertPoint_fromView(event.locationInWindow(), None);
            let idx = self.ivars().display_idx.get();
            with_controller(|ctrl| ctrl.on_mouse_up(idx, pt.x, pt.y));
        }

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, _event: &NSEvent) {
            with_controller(|ctrl| ctrl.on_right_click());
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            with_controller(|ctrl| {
                let _ = ctrl.on_key_down(event);
            });
        }

        #[unsafe(method(cancelOperation:))]
        fn cancel_operation(&self, _sender: Option<&AnyObject>) {
            with_controller(|ctrl| ctrl.dismiss(true));
        }

        #[unsafe(method(cursorUpdate:))]
        fn cursor_update(&self, _event: &NSEvent) {
            with_controller(|ctrl| ctrl.apply_current_cursor());
        }
    }
);

impl GazeOverlayView {
    fn new(mtm: MainThreadMarker, frame: NSRect, display_idx: usize) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(OverlayViewIvars {
            display_idx: Cell::new(display_idx),
        });
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        view.setWantsLayer(true);
        if let Some(layer) = view.layer() {
            layer.setGeometryFlipped(true);
            layer.setOpaque(false);
            layer.setBackgroundColor(None);
        }
        let tracking_opts = NSTrackingAreaOptions::MouseEnteredAndExited
            | NSTrackingAreaOptions::MouseMoved
            | NSTrackingAreaOptions::CursorUpdate
            | NSTrackingAreaOptions::ActiveAlways
            | NSTrackingAreaOptions::InVisibleRect;
        let area = unsafe {
            NSTrackingArea::initWithRect_options_owner_userInfo(
                NSTrackingArea::alloc(),
                NSRect::ZERO,
                tracking_opts,
                Some(&view),
                None,
            )
        };
        view.addTrackingArea(&area);
        view
    }
}

// ============================================================================
// Main-thread OverlayController & GPU Layer Tree
// ============================================================================

#[derive(Clone, Copy, PartialEq, Eq)]
enum CaptureMode {
    Unified,
    Scrolling,
}

#[derive(Clone)]
struct LockedSelection {
    display_idx: usize,
    rect: RectF,
    window_id: Option<u32>,
}

/// State of the hand-off from the native selection UI to the in-place webview editor.
#[derive(Clone)]
struct InplaceHandoff {
    display_idx: usize,
    /// Index into `TOOLBAR_ITEMS` of the tool that started editing (drawn as active).
    tool_idx: usize,
    label: String,
    /// True once the webview has painted and was ordered above the native panel.
    ready: bool,
}

/// Window label of the in-place editor webview for one overlay session.
pub fn inplace_label(seq: u64) -> String {
    format!("inplace-{seq}")
}

#[derive(Clone)]
struct DragState {
    display_idx: usize,
    handle: DragHandle,
    start_x: f64,
    start_y: f64,
    orig_rect: RectF,
    candidate_window: Option<WindowRect>,
}

struct DisplayPanel {
    display_id: u32,
    info: MacDisplayInfo,
    name: String,
    cg_image: Option<SendCGImage>,
    pixel_buffer: Arc<Mutex<Option<SendPixelBuffer>>>,
    windows: Vec<WindowRect>,

    panel: Retained<GazeOverlayPanel>,
    overlay_view: Retained<GazeOverlayView>,

    // Pure GPU CoreAnimation layers (0.05ms updates, zero full-screen CPU redraw!)
    dim_layer: Retained<CAShapeLayer>,
    crosshair_h: Retained<CALayer>,
    crosshair_v: Retained<CALayer>,
    border_outer: Retained<CALayer>,
    border_inner: Retained<CALayer>,
    corners_layer: Retained<CAShapeLayer>,
    handles: Vec<Retained<CALayer>>,

    // Tiny minimal-redraw HUD subviews
    badge_view: Retained<GazeHudView>,
    loupe_view: Retained<GazeHudView>,
    action_bar_view: Retained<GazeHudView>,
    banner_view: Retained<GazeHudView>,

    // Cached badge text so we only redraw `badge_view` when text actually changes.
    badge_primary: String,
    badge_secondary: String,
    action_bar_placement: Option<ActionBarPlacement>,
}

impl DisplayPanel {
    fn create(mtm: MainThreadMarker, display_idx: usize, info: MacDisplayInfo) -> Self {
        let cocoa_frame = cg_rect_to_cocoa_frame(info.x, info.y, info.width, info.height);
        let panel = GazeOverlayPanel::create(mtm, cocoa_frame);
        let local_bounds = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(info.width as f64, info.height as f64),
        );

        let overlay_view = GazeOverlayView::new(mtm, local_bounds, display_idx);
        if let Some(content_view) = panel.contentView() {
            content_view.setWantsLayer(true);
            content_view.addSubview(&overlay_view);
        }

        let root_layer = overlay_view.layer().expect("layer-backed GazeOverlayView");
        root_layer.setGeometryFlipped(true);
        let scale = info.scale_factor.max(1.0) as f64;

        let dim_layer = CAShapeLayer::layer();
        dim_layer.setFrame(local_bounds);
        dim_layer.setContentsScale(scale);
        dim_layer.setZPosition(1.0);
        dim_layer.setFillRule(unsafe { kCAFillRuleEvenOdd });
        let dim_color = CGColor::new_srgb(0.0, 0.0, 0.0, 0.28);
        dim_layer.setFillColor(Some(&dim_color));
        root_layer.addSublayer(&dim_layer);

        let guide_color = CGColor::new_srgb(0.0, 0.584, 1.0, 0.45);
        let crosshair_h = CALayer::layer();
        crosshair_h.setContentsScale(scale);
        crosshair_h.setZPosition(2.0);
        crosshair_h.setBackgroundColor(Some(&guide_color));
        crosshair_h.setHidden(true);
        root_layer.addSublayer(&crosshair_h);

        let crosshair_v = CALayer::layer();
        crosshair_v.setContentsScale(scale);
        crosshair_v.setZPosition(2.0);
        crosshair_v.setBackgroundColor(Some(&guide_color));
        crosshair_v.setHidden(true);
        root_layer.addSublayer(&crosshair_v);

        let blue_color = CGColor::new_srgb(0.0, 0.584, 1.0, 1.0);
        let white_inner = CGColor::new_srgb(1.0, 1.0, 1.0, 0.62);
        let white_solid = CGColor::new_srgb(1.0, 1.0, 1.0, 1.0);
        let black_shadow = CGColor::new_srgb(0.0, 0.0, 0.0, 1.0);

        let border_outer = CALayer::layer();
        border_outer.setContentsScale(scale);
        border_outer.setZPosition(3.0);
        border_outer.setBorderWidth(2.0);
        border_outer.setBorderColor(Some(&blue_color));
        border_outer.setHidden(true);
        root_layer.addSublayer(&border_outer);

        let border_inner = CALayer::layer();
        border_inner.setContentsScale(scale);
        border_inner.setZPosition(3.5);
        border_inner.setBorderWidth(1.0);
        border_inner.setBorderColor(Some(&white_inner));
        border_inner.setHidden(true);
        root_layer.addSublayer(&border_inner);

        let corners_layer = CAShapeLayer::layer();
        corners_layer.setFrame(local_bounds);
        corners_layer.setContentsScale(scale);
        corners_layer.setZPosition(4.0);
        corners_layer.setFillColor(None);
        corners_layer.setStrokeColor(Some(&white_solid));
        corners_layer.setLineWidth(3.0);
        corners_layer.setShadowColor(Some(&blue_color));
        corners_layer.setShadowOpacity(0.85);
        corners_layer.setShadowRadius(2.5);
        corners_layer.setShadowOffset(CGSize::new(0.0, 0.0));
        corners_layer.setHidden(true);
        root_layer.addSublayer(&corners_layer);

        let mut handles = Vec::with_capacity(8);
        for _ in 0..8 {
            let h = CALayer::layer();
            h.setContentsScale(scale);
            h.setZPosition(5.0);
            h.setBounds(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(10.0, 10.0)));
            h.setCornerRadius(5.0);
            h.setBackgroundColor(Some(&white_solid));
            h.setBorderWidth(1.5);
            h.setBorderColor(Some(&blue_color));
            h.setShadowColor(Some(&black_shadow));
            h.setShadowOpacity(0.28);
            h.setShadowRadius(2.0);
            h.setShadowOffset(CGSize::new(0.0, 1.0));
            h.setHidden(true);
            root_layer.addSublayer(&h);
            handles.push(h);
        }

        let badge_view = GazeHudView::new(
            mtm,
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(160.0, 24.0)),
            display_idx,
            HudKind::Badge,
        );
        if let Some(l) = badge_view.layer() {
            l.setZPosition(10.0);
            l.setShadowColor(Some(&black_shadow));
            l.setShadowOpacity(0.32);
            l.setShadowRadius(6.0);
            l.setShadowOffset(CGSize::new(0.0, 2.0));
        }
        badge_view.setHidden(true);
        overlay_view.addSubview(&badge_view);

        let loupe_view = GazeHudView::new(
            mtm,
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(LOUPE_W, LOUPE_H)),
            display_idx,
            HudKind::Loupe,
        );
        if let Some(l) = loupe_view.layer() {
            l.setZPosition(20.0);
            l.setShadowColor(Some(&black_shadow));
            l.setShadowOpacity(0.42);
            l.setShadowRadius(10.0);
            l.setShadowOffset(CGSize::new(0.0, 4.0));
        }
        loupe_view.setHidden(true);
        overlay_view.addSubview(&loupe_view);

        let action_bar_view = GazeHudView::new(
            mtm,
            NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(toolbar_width(), TOOLBAR_TOTAL_H),
            ),
            display_idx,
            HudKind::ActionBar,
        );
        if let Some(l) = action_bar_view.layer() {
            l.setZPosition(15.0);
            l.setShadowColor(Some(&black_shadow));
            l.setShadowOpacity(0.30);
            l.setShadowRadius(12.0);
            l.setShadowOffset(CGSize::new(0.0, 5.0));
        }
        action_bar_view.setHidden(true);
        overlay_view.addSubview(&action_bar_view);

        let banner_view = GazeHudView::new(
            mtm,
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(360.0, 32.0)),
            display_idx,
            HudKind::Banner,
        );
        if let Some(l) = banner_view.layer() {
            l.setZPosition(18.0);
            l.setShadowColor(Some(&black_shadow));
            l.setShadowOpacity(0.36);
            l.setShadowRadius(8.0);
            l.setShadowOffset(CGSize::new(0.0, 3.0));
        }
        banner_view.setHidden(true);
        overlay_view.addSubview(&banner_view);

        Self {
            display_id: info.id,
            info,
            name: String::new(),
            cg_image: None,
            pixel_buffer: Arc::new(Mutex::new(None)),
            windows: Vec::new(),
            panel,
            overlay_view,
            dim_layer,
            crosshair_h,
            crosshair_v,
            border_outer,
            border_inner,
            corners_layer,
            handles,
            badge_view,
            loupe_view,
            action_bar_view,
            banner_view,
            badge_primary: String::new(),
            badge_secondary: String::new(),
            action_bar_placement: None,
        }
    }

    fn set_display_idx(&self, idx: usize) {
        self.overlay_view.ivars().display_idx.set(idx);
        self.badge_view.ivars().display_idx.set(idx);
        self.loupe_view.ivars().display_idx.set(idx);
        self.action_bar_view.ivars().display_idx.set(idx);
        self.banner_view.ivars().display_idx.set(idx);
    }

    fn resize_if_needed(&mut self, info: &MacDisplayInfo) {
        let cocoa_frame = cg_rect_to_cocoa_frame(info.x, info.y, info.width, info.height);
        self.panel
            .setFrame_display_animate(cocoa_frame, true, false);
        let local_bounds = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(info.width as f64, info.height as f64),
        );
        let scale = info.scale_factor.max(1.0) as f64;
        self.overlay_view.setFrame(local_bounds);
        self.dim_layer.setFrame(local_bounds);
        self.dim_layer.setContentsScale(scale);
        self.corners_layer.setFrame(local_bounds);
        self.corners_layer.setContentsScale(scale);
        self.border_outer.setContentsScale(scale);
        self.border_inner.setContentsScale(scale);
        self.crosshair_h.setContentsScale(scale);
        self.crosshair_v.setContentsScale(scale);
        for h in &self.handles {
            h.setContentsScale(scale);
        }
        self.info = info.clone();
    }

    fn set_backdrop(&mut self, cg_image: SendCGImage, scale_factor: f32) {
        if let Some(content_view) = self.panel.contentView() {
            content_view.setWantsLayer(true);
            if let Some(layer) = content_view.layer() {
                unsafe {
                    let cg_obj = &*(CFRetained::as_ptr(&cg_image.0).as_ptr().cast::<AnyObject>());
                    layer.setContents(Some(cg_obj));
                }
                layer.setContentsGravity(unsafe { kCAGravityResize });
                layer.setContentsScale(scale_factor.max(1.0) as f64);
            }
        }
        self.cg_image = Some(cg_image);
    }

    fn clear_backdrop(&mut self) {
        if let Some(content_view) = self.panel.contentView() {
            if let Some(layer) = content_view.layer() {
                unsafe {
                    layer.setContents(None);
                }
            }
        }
        self.cg_image = None;
        *self.pixel_buffer.lock() = None;
    }

    fn update_dim_cutout(&self, cutout: Option<RectF>, alpha: f64, corner_radius: f64) {
        let w = self.info.width as f64;
        let h = self.info.height as f64;
        let path = CGMutablePath::new();
        let full = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w, h));
        unsafe {
            CGMutablePath::add_rect(Some(&path), std::ptr::null(), full);
            if let Some(c) = cutout {
                if c.w > 1.0 && c.h > 1.0 {
                    let r = CGRect::new(CGPoint::new(c.x, c.y), CGSize::new(c.w, c.h));
                    let cr = corner_radius.min(c.w * 0.5).min(c.h * 0.5);
                    if cr > 0.5 {
                        CGMutablePath::add_rounded_rect(Some(&path), std::ptr::null(), r, cr, cr);
                    } else {
                        CGMutablePath::add_rect(Some(&path), std::ptr::null(), r);
                    }
                }
            }
        }
        let color = CGColor::new_srgb(0.0, 0.0, 0.0, alpha);
        self.dim_layer.setFillColor(Some(&color));
        self.dim_layer.setPath(Some(path.as_ref()));
    }

    fn update_corners_path(&self, rect: RectF) {
        let len = 11.0_f64.min(rect.w * 0.25).min(rect.h * 0.25);
        let x1 = rect.x - 1.0;
        let y1 = rect.y - 1.0;
        let x2 = rect.x + rect.w + 1.0;
        let y2 = rect.y + rect.h + 1.0;

        let path = CGMutablePath::new();
        unsafe {
            // Top-left ┌
            CGMutablePath::move_to_point(Some(&path), std::ptr::null(), x1, y1 + len);
            CGMutablePath::add_line_to_point(Some(&path), std::ptr::null(), x1, y1);
            CGMutablePath::add_line_to_point(Some(&path), std::ptr::null(), x1 + len, y1);
            // Top-right ┐
            CGMutablePath::move_to_point(Some(&path), std::ptr::null(), x2 - len, y1);
            CGMutablePath::add_line_to_point(Some(&path), std::ptr::null(), x2, y1);
            CGMutablePath::add_line_to_point(Some(&path), std::ptr::null(), x2, y1 + len);
            // Bottom-left └
            CGMutablePath::move_to_point(Some(&path), std::ptr::null(), x1, y2 - len);
            CGMutablePath::add_line_to_point(Some(&path), std::ptr::null(), x1, y2);
            CGMutablePath::add_line_to_point(Some(&path), std::ptr::null(), x1 + len, y2);
            // Bottom-right ┘
            CGMutablePath::move_to_point(Some(&path), std::ptr::null(), x2 - len, y2);
            CGMutablePath::add_line_to_point(Some(&path), std::ptr::null(), x2, y2);
            CGMutablePath::add_line_to_point(Some(&path), std::ptr::null(), x2, y2 - len);
        }
        self.corners_layer.setPath(Some(path.as_ref()));
        self.corners_layer.setHidden(false);
    }

    fn update_badge(&mut self, rect: RectF, primary: &str, secondary: &str, inside_hint: bool) {
        let changed = self.badge_primary != primary || self.badge_secondary != secondary;
        if changed {
            self.badge_primary.clear();
            self.badge_primary.push_str(primary);
            self.badge_secondary.clear();
            self.badge_secondary.push_str(secondary);
        }

        let pill_w = measure_badge_width(primary, secondary).min(340.0);
        let pill_h = 24.0;
        let max_x = (self.info.width as f64 - pill_w - 8.0).max(8.0);
        let (bx, by) = if rect.y < 32.0 || inside_hint {
            ((rect.x + 10.0).clamp(8.0, max_x), (rect.y + 10.0).max(8.0))
        } else {
            (rect.x.clamp(8.0, max_x), rect.y - pill_h - 6.0)
        };
        self.badge_view.setFrame(NSRect::new(
            NSPoint::new(bx.round(), by.round()),
            NSSize::new(pill_w.ceil(), pill_h),
        ));
        self.badge_view.setHidden(false);
        if changed {
            self.badge_view.setNeedsDisplay(true);
        }
    }
}

struct OverlayController {
    app: AppHandle,
    seq: u64,
    active: bool,
    mode: CaptureMode,
    prev_app: Option<Retained<NSRunningApplication>>,
    panels: Vec<DisplayPanel>,

    cursor_display_idx: usize,
    cursor_local: (f64, f64),
    cursor_inside: bool,
    hover_hex: String,
    hovered_window: Option<(usize, WindowRect)>,
    selection: Option<LockedSelection>,
    drag: Option<DragState>,
    hovered_action_idx: Option<usize>,
    /// Set once an annotation tool is picked: the selection is frozen and the in-place
    /// webview editor takes over input. `None` while the user is still selecting.
    inplace: Option<InplaceHandoff>,

    toast_text: Option<String>,
    toast_seq: u64,

    key_monitors: Vec<Retained<AnyObject>>,
}

thread_local! {
    static OVERLAY_CTRL: RefCell<Option<OverlayController>> = const { RefCell::new(None) };
}

fn with_controller<R>(f: impl FnOnce(&mut OverlayController) -> R) -> Option<R> {
    OVERLAY_CTRL.with(|cell| {
        let mut borrow = cell.borrow_mut();
        borrow.as_mut().map(f)
    })
}

fn with_controller_ref<R>(f: impl FnOnce(&OverlayController) -> R) -> Option<R> {
    OVERLAY_CTRL.with(|cell| {
        let borrow = cell.borrow();
        borrow.as_ref().map(f)
    })
}

impl OverlayController {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            seq: 0,
            active: false,
            mode: CaptureMode::Unified,
            prev_app: None,
            panels: Vec::new(),
            cursor_display_idx: 0,
            cursor_local: (-1.0, -1.0),
            cursor_inside: false,
            hover_hex: "#000000".to_string(),
            hovered_window: None,
            selection: None,
            drag: None,
            hovered_action_idx: None,
            inplace: None,
            toast_text: None,
            toast_seq: 0,
            key_monitors: Vec::new(),
        }
    }

    fn present(
        &mut self,
        mtm: MainThreadMarker,
        seq: u64,
        mode: CaptureMode,
        captured: Vec<CapturedDisplay>,
        initial_cursor: Option<(i32, i32)>,
    ) {
        if captured.is_empty() {
            return;
        }

        // Save the currently frontmost external app (only if we aren't already open).
        if !self.active {
            let my_pid = std::process::id() as i32;
            let front = NSWorkspace::sharedWorkspace().frontmostApplication();
            self.prev_app = front.filter(|a| a.processIdentifier() != my_pid);
        }

        self.seq = seq;
        self.active = true;
        self.mode = mode;
        self.selection = None;
        self.drag = None;
        self.hovered_action_idx = None;
        self.toast_text = None;
        if let Some(prev) = self.inplace.take() {
            if let Some(win) = self.app.get_webview_window(&prev.label) {
                let _ = win.destroy();
            }
        }

        // Reconcile panel pool with current display list (reusing existing panels for zero alloc).
        let display_names = main_thread_display_names(mtm);
        let mut existing_by_id: HashMap<u32, DisplayPanel> =
            self.panels.drain(..).map(|p| (p.display_id, p)).collect();

        let mut next_panels = Vec::with_capacity(captured.len());
        for (idx, cap) in captured.into_iter().enumerate() {
            let mut dp = match existing_by_id.remove(&cap.info.id) {
                Some(mut reused) => {
                    reused.set_display_idx(idx);
                    reused.resize_if_needed(&cap.info);
                    reused
                }
                None => DisplayPanel::create(mtm, idx, cap.info.clone()),
            };
            dp.name = display_names.get(&cap.info.id).cloned().unwrap_or(cap.name);
            dp.windows = cap.windows;
            dp.pixel_buffer = cap.pixel_buffer;
            dp.action_bar_placement = None;
            dp.badge_primary.clear();
            dp.badge_secondary.clear();
            dp.set_backdrop(cap.cg_image, cap.info.scale_factor);
            next_panels.push(dp);
        }

        // Hide and drop any panels for disconnected displays.
        for (_, mut stale) in existing_by_id {
            stale.panel.orderOut(None);
            stale.clear_backdrop();
        }
        self.panels = next_panels;

        // Locate initial cursor display & local point.
        let mut active_idx = self.panels.iter().position(|p| p.info.is_main).unwrap_or(0);
        let mut local_pt = (-1.0, -1.0);
        let mut inside = false;
        if let Some((cx, cy)) = initial_cursor {
            for (idx, p) in self.panels.iter().enumerate() {
                if cx >= p.info.x
                    && cx < p.info.x + p.info.width as i32
                    && cy >= p.info.y
                    && cy < p.info.y + p.info.height as i32
                {
                    active_idx = idx;
                    local_pt = ((cx - p.info.x) as f64, (cy - p.info.y) as f64);
                    inside = true;
                    break;
                }
            }
        }
        self.cursor_display_idx = active_idx;
        self.cursor_local = local_pt;
        self.cursor_inside = inside;
        self.hovered_window = if inside {
            find_window_at(&self.panels[active_idx].windows, local_pt.0, local_pt.1)
                .map(|w| (active_idx, w))
        } else {
            None
        };

        // Synchronously commit all visual layers BEFORE showing panels so Frame 1 is 100% ready!
        self.sync_all_panels();

        LAST_PRESENT_MS.store(now_ms(), Ordering::SeqCst);

        // If Gaze was somehow hidden by the user (Cmd+H), unhide cleanly without switching Spaces.
        let ns_app = NSApplication::sharedApplication(mtm);
        if ns_app.isHidden() {
            ns_app.unhideWithoutActivation();
        }

        // Order all panels front across all displays simultaneously.
        for dp in &self.panels {
            dp.panel.orderFrontRegardless();
        }

        // Activate without `ActivateAllWindows` (and skip activation if another Gaze window
        // resides on a different Space, so macOS never yanks off a Fullscreen Space).
        if !has_other_visible_window_on_different_space(&self.app) {
            #[allow(deprecated)]
            let _ = NSRunningApplication::currentApplication()
                .activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
        }
        if let Some(active_dp) = self.panels.get(active_idx) {
            active_dp.panel.makeKeyAndOrderFront(None);
            active_dp
                .panel
                .makeFirstResponder(Some(&active_dp.overlay_view));
        }

        self.install_key_monitors();
        self.apply_current_cursor();
    }

    fn dismiss(&mut self, restore_focus: bool) {
        if !self.active {
            return;
        }
        self.active = false;
        self.drag = None;
        self.selection = None;
        self.hovered_window = None;
        self.hovered_action_idx = None;
        self.toast_text = None;
        self.remove_key_monitors();

        // The in-place editor webview is hidden together with the panels. If it owns an edit
        // session it still has to export the annotated image, so it destroys itself through
        // `inplace_finish`; the timer below only cleans up if that never arrives.
        let inplace = self.inplace.take();
        let label = inplace
            .as_ref()
            .map(|h| h.label.clone())
            .unwrap_or_else(|| inplace_label(self.seq));
        if let Some(win) = self.app.get_webview_window(&label) {
            if let Ok(ptr) = win.ns_window() {
                let ns_win = unsafe { &*(ptr as *const NSWindow) };
                ns_win.orderOut(None);
            }
            if inplace.is_some() {
                let app = self.app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    if let Some(win) = app.get_webview_window(&label) {
                        let _ = win.destroy();
                    }
                });
            } else {
                let _ = win.destroy();
            }
        }

        CATransaction::begin();
        CATransaction::setDisableActions(true);
        for dp in &mut self.panels {
            dp.panel.orderOut(None);
            dp.clear_backdrop();
            dp.badge_view.setHidden(true);
            dp.loupe_view.setHidden(true);
            dp.action_bar_view.setHidden(true);
            dp.banner_view.setHidden(true);
        }
        CATransaction::commit();
        CATransaction::flush();

        NSCursor::arrowCursor().set();

        // Yield focus cleanly back to the previously active app WITHOUT calling NSApp.hide(None)!
        let prev = self.prev_app.take();
        if restore_focus && !has_any_other_visible_window(&self.app) {
            if let Some(prev_app) = prev {
                #[allow(deprecated)]
                let _ = prev_app.activateWithOptions(NSApplicationActivationOptions::empty());
            }
        }
    }

    fn install_key_monitors(&mut self) {
        self.remove_key_monitors();

        let local_block = RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
            let handled = with_controller(|ctrl| {
                if !ctrl.active {
                    return false;
                }
                ctrl.on_key_down(unsafe { ev.as_ref() })
            })
            .unwrap_or(false);
            if handled {
                std::ptr::null_mut()
            } else {
                ev.as_ptr()
            }
        });
        if let Some(m) = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::KeyDown,
                &local_block,
            )
        } {
            self.key_monitors.push(m);
        }

        let global_block = RcBlock::new(move |ev: NonNull<NSEvent>| {
            let key_code = unsafe { ev.as_ref().keyCode() };
            if key_code == 53 {
                with_controller(|ctrl| {
                    if ctrl.active {
                        ctrl.dismiss(true);
                    }
                });
            }
        });
        if let Some(m) = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::KeyDown,
            &global_block,
        ) {
            self.key_monitors.push(m);
        }
    }

    fn remove_key_monitors(&mut self) {
        for m in self.key_monitors.drain(..) {
            unsafe {
                NSEvent::removeMonitor(&m);
            }
        }
    }

    fn on_pixel_buffers_ready(&mut self, seq: u64) {
        if !self.active || self.seq != seq {
            return;
        }
        self.update_loupe_only();
    }

    fn on_mouse_exited(&mut self, display_idx: usize) {
        if !self.active || self.inplace.is_some() || self.drag.is_some() {
            return;
        }
        if self.cursor_display_idx == display_idx {
            self.cursor_inside = false;
            if let Some(dp) = self.panels.get(display_idx) {
                CATransaction::begin();
                CATransaction::setDisableActions(true);
                dp.crosshair_h.setHidden(true);
                dp.crosshair_v.setHidden(true);
                dp.loupe_view.setHidden(true);
                CATransaction::commit();
            }
        }
    }

    fn on_mouse_moved(&mut self, display_idx: usize, x: f64, y: f64, entered: bool) {
        if !self.active || self.inplace.is_some() || display_idx >= self.panels.len() {
            return;
        }
        let prev_disp = self.cursor_display_idx;
        let switched_display = prev_disp != display_idx;
        self.cursor_display_idx = display_idx;
        self.cursor_local = (x, y);
        self.cursor_inside = true;

        if switched_display || entered {
            // Focus the display panel under the cursor so keyboard shortcuts stay active.
            if let Some(dp) = self.panels.get(display_idx) {
                dp.panel.makeKeyAndOrderFront(None);
                dp.panel.makeFirstResponder(Some(&dp.overlay_view));
            }
        }

        // If a locked selection exists, only update action bar hover + cursor!
        if let Some(sel) = &self.selection {
            if sel.display_idx == display_idx {
                let new_hover = self.panels[display_idx]
                    .action_bar_placement
                    .and_then(|p| hit_test_action_bar(p, x, y));
                if new_hover != self.hovered_action_idx {
                    self.hovered_action_idx = new_hover;
                    self.panels[display_idx]
                        .action_bar_view
                        .setNeedsDisplay(true);
                }
            } else if self.hovered_action_idx.is_some() {
                self.hovered_action_idx = None;
                if let Some(dp) = self.panels.get(sel.display_idx) {
                    dp.action_bar_view.setNeedsDisplay(true);
                }
            }
            self.apply_current_cursor();
            return;
        }

        // Live window hover auto-detection.
        let hit = find_window_at(&self.panels[display_idx].windows, x, y).map(|w| (display_idx, w));
        let hover_changed = switched_display
            || match (&self.hovered_window, &hit) {
                (Some((d1, w1)), Some((d2, w2))) => d1 != d2 || w1.id != w2.id,
                (None, None) => false,
                _ => true,
            };
        self.hovered_window = hit;

        if hover_changed {
            self.sync_all_panels();
        } else {
            // Fast path (98% of mouseMoves): ONLY move crosshair + tiny 136x160 loupe!
            self.update_crosshair_and_loupe_fast();
        }
        self.apply_current_cursor();
    }

    fn on_mouse_down(&mut self, display_idx: usize, x: f64, y: f64, click_count: isize) {
        if !self.active || self.inplace.is_some() || display_idx >= self.panels.len() {
            return;
        }
        self.cursor_display_idx = display_idx;
        self.cursor_local = (x, y);
        self.cursor_inside = true;

        // 1. Check floating action bar click first.
        if let Some(sel) = &self.selection {
            if sel.display_idx == display_idx {
                if let Some(placement) = self.panels[display_idx].action_bar_placement {
                    if let Some(btn_idx) = hit_test_action_bar(placement, x, y) {
                        self.trigger_toolbar_item(btn_idx);
                        return;
                    }
                    if point_in_toolbar_pill(placement, x, y) {
                        // Padding, dividers and disabled buttons swallow the click.
                        return;
                    }
                }
            }
        }

        // 2. Check existing locked selection handles / interior move / double-click confirm.
        if let Some(sel) = self.selection.clone() {
            if sel.display_idx == display_idx {
                if let Some(handle) = hit_test_handle(sel.rect, x, y) {
                    self.selection = Some(LockedSelection {
                        display_idx,
                        rect: sel.rect,
                        window_id: None,
                    });
                    self.drag = Some(DragState {
                        display_idx,
                        handle,
                        start_x: x,
                        start_y: y,
                        orig_rect: sel.rect,
                        candidate_window: None,
                    });
                    self.hovered_action_idx = None;
                    self.sync_all_panels();
                    self.apply_current_cursor();
                    return;
                }
                if sel.rect.contains(x, y) {
                    if click_count >= 2 {
                        if self.mode == CaptureMode::Scrolling {
                            self.commit_scroll(sel.display_idx, sel.rect);
                        } else {
                            self.commit_current_selection("done");
                        }
                        return;
                    }
                    self.selection = Some(LockedSelection {
                        display_idx,
                        rect: sel.rect,
                        window_id: None,
                    });
                    self.drag = Some(DragState {
                        display_idx,
                        handle: DragHandle::Move,
                        start_x: x,
                        start_y: y,
                        orig_rect: sel.rect,
                        candidate_window: None,
                    });
                    self.hovered_action_idx = None;
                    self.sync_all_panels();
                    self.apply_current_cursor();
                    return;
                }
            }
            // Clicked outside existing selection: clear it and start a fresh pending selection.
            self.selection = None;
            self.hovered_action_idx = None;
        }

        // 3. Unified Snipaste interaction: wait >= 4pt for area drag, or snap to window on mouseUp.
        let hit = find_window_at(&self.panels[display_idx].windows, x, y);
        self.drag = Some(DragState {
            display_idx,
            handle: DragHandle::Pending,
            start_x: x,
            start_y: y,
            orig_rect: RectF {
                x,
                y,
                w: 0.0,
                h: 0.0,
            },
            candidate_window: hit,
        });
    }

    fn on_mouse_dragged(&mut self, display_idx: usize, x: f64, y: f64) {
        if !self.active || self.inplace.is_some() {
            return;
        }
        let Some(mut drag) = self.drag.clone() else {
            return;
        };
        // Keep coordinates in the drag's originating display even if pointer slides near edges.
        let d_idx = drag.display_idx;
        if d_idx >= self.panels.len() {
            return;
        }
        let view_w = self.panels[d_idx].info.width as f64;
        let view_h = self.panels[d_idx].info.height as f64;
        let (lx, ly) = if display_idx == d_idx {
            (x.clamp(0.0, view_w), y.clamp(0.0, view_h))
        } else {
            // Translate from another display's local coordinates into drag display's coordinates.
            let src = &self.panels[display_idx].info;
            let dst = &self.panels[d_idx].info;
            let gx = src.x as f64 + x;
            let gy = src.y as f64 + y;
            (
                (gx - dst.x as f64).clamp(0.0, view_w),
                (gy - dst.y as f64).clamp(0.0, view_h),
            )
        };

        self.cursor_display_idx = d_idx;
        self.cursor_local = (lx, ly);
        self.cursor_inside = true;

        if drag.handle == DragHandle::Pending {
            let dist = (lx - drag.start_x).hypot(ly - drag.start_y);
            if dist < DRAG_THRESHOLD_PT {
                return;
            }
            drag.handle = DragHandle::Create;
            self.drag = Some(drag.clone());
        }

        let dx = lx - drag.start_x;
        let dy = ly - drag.start_y;
        let o = drag.orig_rect;

        let next_rect = match drag.handle {
            DragHandle::Create => {
                let rx1 = drag.start_x.min(lx).clamp(0.0, view_w);
                let ry1 = drag.start_y.min(ly).clamp(0.0, view_h);
                let rx2 = drag.start_x.max(lx).clamp(0.0, view_w);
                let ry2 = drag.start_y.max(ly).clamp(0.0, view_h);
                RectF {
                    x: rx1,
                    y: ry1,
                    w: rx2 - rx1,
                    h: ry2 - ry1,
                }
            }
            DragHandle::Move => RectF {
                x: (o.x + dx).clamp(0.0, (view_w - o.w).max(0.0)),
                y: (o.y + dy).clamp(0.0, (view_h - o.h).max(0.0)),
                w: o.w,
                h: o.h,
            },
            h => {
                let mut x1 = o.x;
                let mut y1 = o.y;
                let mut x2 = o.x + o.w;
                let mut y2 = o.y + o.h;
                if matches!(h, DragHandle::W | DragHandle::NW | DragHandle::SW) {
                    x1 = (o.x + dx).clamp(0.0, view_w);
                }
                if matches!(h, DragHandle::E | DragHandle::NE | DragHandle::SE) {
                    x2 = (o.x + o.w + dx).clamp(0.0, view_w);
                }
                if matches!(h, DragHandle::N | DragHandle::NW | DragHandle::NE) {
                    y1 = (o.y + dy).clamp(0.0, view_h);
                }
                if matches!(h, DragHandle::S | DragHandle::SW | DragHandle::SE) {
                    y2 = (o.y + o.h + dy).clamp(0.0, view_h);
                }
                RectF {
                    x: x1.min(x2),
                    y: y1.min(y2),
                    w: (x2 - x1).abs().max(8.0),
                    h: (y2 - y1).abs().max(8.0),
                }
            }
        };

        self.selection = Some(LockedSelection {
            display_idx: d_idx,
            rect: next_rect,
            window_id: None,
        });
        self.sync_panel_gpu(d_idx);
        self.apply_current_cursor();
    }

    fn on_mouse_up(&mut self, _display_idx: usize, _x: f64, _y: f64) {
        if !self.active || self.inplace.is_some() {
            return;
        }
        let Some(drag) = self.drag.take() else {
            return;
        };
        let d_idx = drag.display_idx;
        if d_idx >= self.panels.len() {
            return;
        }

        if drag.handle == DragHandle::Pending {
            // Clean click without dragging -> snap to hovered window or full display.
            if let Some(win) = drag.candidate_window {
                let rect = RectF {
                    x: win.x as f64,
                    y: win.y as f64,
                    w: win.width as f64,
                    h: win.height as f64,
                };
                if self.mode == CaptureMode::Scrolling {
                    self.commit_scroll(d_idx, rect);
                    return;
                }
                self.selection = Some(LockedSelection {
                    display_idx: d_idx,
                    rect,
                    window_id: Some(win.id),
                });
            } else {
                let full = RectF {
                    x: 0.0,
                    y: 0.0,
                    w: self.panels[d_idx].info.width as f64,
                    h: self.panels[d_idx].info.height as f64,
                };
                if self.mode == CaptureMode::Scrolling {
                    self.commit_scroll(d_idx, full);
                    return;
                }
                self.selection = Some(LockedSelection {
                    display_idx: d_idx,
                    rect: full,
                    window_id: None,
                });
            }
            self.sync_all_panels();
            self.apply_current_cursor();
            return;
        }

        if let Some(sel) = self.selection.clone() {
            if sel.rect.w < 4.0 || sel.rect.h < 4.0 {
                self.selection = None;
            } else if drag.handle == DragHandle::Create
                && self.mode == CaptureMode::Scrolling
                && sel.rect.w >= 32.0
                && sel.rect.h >= 48.0
            {
                self.commit_scroll(sel.display_idx, sel.rect);
                return;
            }
        }
        self.sync_all_panels();
        self.apply_current_cursor();
    }

    fn on_right_click(&mut self) {
        if !self.active || self.inplace.is_some() {
            return;
        }
        if self.selection.is_some() || self.drag.is_some() {
            // Snipaste mental model: right-click clears locked selection back to live hover.
            self.drag = None;
            self.selection = None;
            self.hovered_action_idx = None;
            let idx = self.cursor_display_idx;
            if self.cursor_inside && idx < self.panels.len() {
                self.hovered_window = find_window_at(
                    &self.panels[idx].windows,
                    self.cursor_local.0,
                    self.cursor_local.1,
                )
                .map(|w| (idx, w));
            }
            self.sync_all_panels();
            self.apply_current_cursor();
            return;
        }
        self.dismiss(true);
    }

    fn on_key_down(&mut self, event: &NSEvent) -> bool {
        if !self.active {
            return false;
        }
        let code = event.keyCode();
        let flags = event.modifierFlags();
        let has_cmd = flags.contains(NSEventModifierFlags::Command);
        let has_shift = flags.contains(NSEventModifierFlags::Shift);

        if self.inplace.is_some() {
            // The webview editor owns the keyboard once it is key; until it appears, only Esc
            // (abort the whole capture) is meaningful here.
            if code == 53 {
                self.dismiss(true);
                return true;
            }
            return false;
        }

        match code {
            // Escape
            53 => {
                self.dismiss(true);
                true
            }
            // Tab -> copy hovered hex color
            48 => {
                let hex = self.hover_hex.clone();
                let _ = crate::clipboard::copy_text(&hex);
                self.show_toast(format!("Copied {hex}"));
                true
            }
            // Backspace / Forward Delete -> clear selection
            51 | 117 => {
                if self.selection.is_some() && self.drag.is_none() {
                    self.selection = None;
                    self.hovered_action_idx = None;
                    self.sync_all_panels();
                    self.apply_current_cursor();
                }
                true
            }
            // Return / Numpad Enter -> confirm selection (or hovered window)
            36 | 76 => {
                if self.drag.is_some() {
                    return true;
                }
                if let Some(sel) = self.selection.clone() {
                    if self.mode == CaptureMode::Scrolling {
                        self.commit_scroll(sel.display_idx, sel.rect);
                    } else {
                        self.commit_current_selection("done");
                    }
                } else if let Some((d_idx, win)) = self.hovered_window.clone() {
                    let rect = RectF {
                        x: win.x as f64,
                        y: win.y as f64,
                        w: win.width as f64,
                        h: win.height as f64,
                    };
                    if self.mode == CaptureMode::Scrolling {
                        self.commit_scroll(d_idx, rect);
                    } else {
                        self.selection = Some(LockedSelection {
                            display_idx: d_idx,
                            rect,
                            window_id: Some(win.id),
                        });
                        self.commit_current_selection("done");
                    }
                }
                true
            }
            // Arrow keys (Left 123, Right 124, Down 125, Up 126) -> nudge selection by 1pt / 10pt
            123..=126 => {
                let step = if has_shift { 10.0 } else { 1.0 };
                if let Some(sel) = &mut self.selection {
                    if self.drag.is_none() && sel.display_idx < self.panels.len() {
                        let vw = self.panels[sel.display_idx].info.width as f64;
                        let vh = self.panels[sel.display_idx].info.height as f64;
                        sel.window_id = None;
                        match code {
                            123 => sel.rect.x = (sel.rect.x - step).max(0.0),
                            124 => sel.rect.x = (sel.rect.x + step).min((vw - sel.rect.w).max(0.0)),
                            125 => sel.rect.y = (sel.rect.y + step).min((vh - sel.rect.h).max(0.0)),
                            126 => sel.rect.y = (sel.rect.y - step).max(0.0),
                            _ => {}
                        }
                        let d_idx = sel.display_idx;
                        self.sync_panel_gpu(d_idx);
                    }
                }
                true
            }
            _ => {
                let has_opt_ctrl = flags.contains(NSEventModifierFlags::Option)
                    || flags.contains(NSEventModifierFlags::Control);
                if !has_cmd
                    && !has_opt_ctrl
                    && self.mode == CaptureMode::Unified
                    && self.selection.is_some()
                    && self.drag.is_none()
                {
                    let ch = event
                        .charactersIgnoringModifiers()
                        .map(|s| s.to_string())
                        .unwrap_or_default();
                    if let Some(tool) = tool_for_shortcut_key(&ch) {
                        if let Some(idx) = TOOLBAR_ITEMS
                            .iter()
                            .position(|i| i.action == Some(ToolbarAction::Tool(tool)))
                        {
                            self.begin_inplace_edit(idx);
                            return true;
                        }
                    }
                }
                if has_cmd {
                    let ch = event
                        .charactersIgnoringModifiers()
                        .map(|s| s.to_string().to_ascii_lowercase())
                        .unwrap_or_default();
                    match ch.as_str() {
                        "c" => {
                            if self.selection.is_some() && self.drag.is_none() {
                                self.commit_current_selection("copy");
                            }
                            return true;
                        }
                        "s" => {
                            if self.selection.is_some() && self.drag.is_none() {
                                self.commit_current_selection("save");
                            }
                            return true;
                        }
                        "a" => {
                            let idx = self
                                .cursor_display_idx
                                .min(self.panels.len().saturating_sub(1));
                            if let Some(dp) = self.panels.get(idx) {
                                self.drag = None;
                                self.selection = Some(LockedSelection {
                                    display_idx: idx,
                                    rect: RectF {
                                        x: 0.0,
                                        y: 0.0,
                                        w: dp.info.width as f64,
                                        h: dp.info.height as f64,
                                    },
                                    window_id: None,
                                });
                                self.sync_all_panels();
                                self.apply_current_cursor();
                            }
                            return true;
                        }
                        _ => {}
                    }
                }
                false
            }
        }
    }

    fn trigger_toolbar_item(&mut self, idx: usize) {
        let Some(action) = TOOLBAR_ITEMS.get(idx).and_then(|i| i.action) else {
            return;
        };
        if !toolbar_item_enabled(action) {
            return;
        }
        match action {
            ToolbarAction::Tool(_) => self.begin_inplace_edit(idx),
            ToolbarAction::Done => self.commit_current_selection("done"),
            ToolbarAction::Save => self.commit_current_selection("save"),
            ToolbarAction::Pin => self.commit_current_selection("pin"),
            ToolbarAction::OpenEditor => self.commit_current_selection("editor"),
            ToolbarAction::Cancel => self.dismiss(true),
            ToolbarAction::Scroll => {
                if let Some(sel) = self.selection.clone() {
                    self.commit_scroll(sel.display_idx, sel.rect);
                }
            }
            ToolbarAction::Undo | ToolbarAction::Redo => {}
        }
    }

    /// Freezes the selection and hands it to the in-place webview editor. The native toolbar
    /// stays visible (with the chosen tool highlighted) until the webview has painted the
    /// identical toolbar on top of it, so the transition never shows an empty frame.
    fn begin_inplace_edit(&mut self, tool_idx: usize) {
        if self.inplace.is_some() || self.drag.is_some() || self.mode != CaptureMode::Unified {
            return;
        }
        let Some(ToolbarAction::Tool(tool)) = TOOLBAR_ITEMS.get(tool_idx).and_then(|i| i.action)
        else {
            return;
        };
        let Some(sel) = self.selection.clone() else {
            return;
        };
        let Some(dp) = self.panels.get(sel.display_idx) else {
            return;
        };
        let Some(placement) = dp.action_bar_placement else {
            return;
        };
        let Some(cg_image) = dp.cg_image.clone() else {
            return;
        };
        let pixel_buffer = dp.pixel_buffer.clone();
        let info = dp.info.clone();
        let label = inplace_label(self.seq);

        self.inplace = Some(InplaceHandoff {
            display_idx: sel.display_idx,
            tool_idx,
            label: label.clone(),
            ready: false,
        });
        self.hovered_action_idx = None;
        // Local key monitors would swallow keystrokes meant for the webview editor.
        self.remove_key_monitors();
        self.panels[sel.display_idx]
            .action_bar_view
            .setNeedsDisplay(true);
        NSCursor::arrowCursor().set();

        let geometry = crate::InplaceGeometry {
            view_width: info.width as f64,
            view_height: info.height as f64,
            selection: crate::InplaceRect::from_xywh(sel.rect.x, sel.rect.y, sel.rect.w, sel.rect.h),
            toolbar: {
                let p = placement.pill_rect();
                crate::InplaceRect::from_xywh(p.x, p.y, p.w, p.h)
            },
            toolbar_side: match placement.side {
                ToolbarSide::Below => "below",
                ToolbarSide::Above => "above",
                ToolbarSide::Inside => "inside",
            }
            .to_string(),
        };

        let app = self.app.clone();
        let seq = self.seq;
        let rect = sel.rect;
        std::thread::spawn(move || {
            let cropped = {
                let pb = pixel_buffer.lock();
                if let Some(buf) = pb.as_ref() {
                    buf.crop_rgba(rect.x, rect.y, rect.w, rect.h, info.width, info.height)
                } else {
                    crop_cg_image_to_rgba(
                        &cg_image.0,
                        rect.x,
                        rect.y,
                        rect.w,
                        rect.h,
                        info.width,
                        info.height,
                    )
                }
            };
            match cropped {
                Ok(img) => crate::begin_inplace_session(
                    app,
                    label,
                    img,
                    info.scale_factor,
                    info.bounds(),
                    geometry,
                    tool.to_string(),
                ),
                Err(err) => {
                    eprintln!("[gaze] failed to crop selection for in-place edit: {err}");
                    let _ = app.run_on_main_thread(move || {
                        with_controller(|ctrl| {
                            if ctrl.seq == seq {
                                ctrl.dismiss(true);
                            }
                        });
                    });
                }
            }
        });

        // Safety net: if the webview never reports ready, fall back to the standalone editor
        // instead of leaving the user on a frozen, unresponsive overlay.
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(INPLACE_READY_TIMEOUT_MS));
            let app_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                let timed_out = with_controller(|ctrl| {
                    let pending = ctrl.active
                        && ctrl.seq == seq
                        && ctrl.inplace.as_ref().is_some_and(|h| !h.ready);
                    if pending {
                        ctrl.dismiss(false);
                    }
                    pending
                })
                .unwrap_or(false);
                if timed_out {
                    eprintln!("[gaze] in-place editor did not become ready; opening the editor");
                    crate::inplace_fallback_to_editor(&app_main, &inplace_label(seq));
                }
            });
        });
    }

    /// Sizes the in-place editor window to cover the display that holds the selection.
    fn place_inplace_window(&self, label: &str) {
        let Some(handoff) = self.inplace.as_ref().filter(|h| h.label == label) else {
            return;
        };
        let Some(dp) = self.panels.get(handoff.display_idx) else {
            return;
        };
        let Some(win) = self.app.get_webview_window(label) else {
            return;
        };
        let Ok(ptr) = win.ns_window() else {
            return;
        };
        let ns_win = unsafe { &*(ptr as *const NSWindow) };
        let frame = cg_rect_to_cocoa_frame(dp.info.x, dp.info.y, dp.info.width, dp.info.height);
        ns_win.setFrame_display(frame, false);
        ns_win.setLevel(NSScreenSaverWindowLevel + 1);
        ns_win.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        ns_win.setHasShadow(false);
        ns_win.setAnimationBehavior(NSWindowAnimationBehavior::None);
    }

    /// Called once the webview painted the frozen crop + toolbar: put it above the native
    /// panel, give it keyboard focus, then retire the native selection chrome underneath.
    fn on_inplace_ready(&mut self, label: &str) {
        let matches = self.active && self.inplace.as_ref().is_some_and(|h| h.label == label);
        if !matches {
            if let Some(win) = self.app.get_webview_window(label) {
                let _ = win.destroy();
            }
            return;
        }
        self.place_inplace_window(label);
        let Some(win) = self.app.get_webview_window(label) else {
            return;
        };
        if let Ok(ptr) = win.ns_window() {
            let ns_win = unsafe { &*(ptr as *const NSWindow) };
            ns_win.orderFrontRegardless();
            ns_win.makeKeyWindow();
        }
        let _ = win.set_focus();
        let display_idx = match self.inplace.as_mut() {
            Some(h) => {
                h.ready = true;
                h.display_idx
            }
            None => return,
        };

        // Keep the native toolbar for a few frames so the webview's first composited frame
        // lands on top of it; only then hide the native chrome it now duplicates.
        let app = self.app.clone();
        let seq = self.seq;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(INPLACE_CHROME_HIDE_DELAY_MS));
            let _ = app.run_on_main_thread(move || {
                with_controller(|ctrl| {
                    if !ctrl.active || ctrl.seq != seq || ctrl.inplace.is_none() {
                        return;
                    }
                    let Some(dp) = ctrl.panels.get(display_idx) else {
                        return;
                    };
                    CATransaction::begin();
                    CATransaction::setDisableActions(true);
                    dp.action_bar_view.setHidden(true);
                    dp.badge_view.setHidden(true);
                    dp.loupe_view.setHidden(true);
                    dp.crosshair_h.setHidden(true);
                    dp.crosshair_v.setHidden(true);
                    for h in &dp.handles {
                        h.setHidden(true);
                    }
                    CATransaction::commit();
                });
            });
        });
    }

    fn commit_current_selection(&mut self, action: &str) {
        let Some(sel) = self.selection.clone() else {
            return;
        };
        let Some(dp) = self.panels.get(sel.display_idx) else {
            return;
        };
        let Some(cg_image) = dp.cg_image.clone() else {
            self.dismiss(true);
            return;
        };
        let pixel_buffer = dp.pixel_buffer.clone();
        let info = dp.info.clone();
        let bounds = info.bounds();
        let scale = info.scale_factor;
        let app = self.app.clone();
        let action_owned = action.to_string();

        // Only restore focus to previous app if this action won't open an Editor/Pin/Thumbnail window.
        let restore_focus = matches!(action, "copy" | "save" | "done");

        if let Some(win_id) = sel.window_id {
            let abs_bounds = dp
                .windows
                .iter()
                .find(|w| w.id == win_id)
                .map(|w| (info.x + w.x, info.y + w.y, w.width, w.height));
            let rect = sel.rect;
            self.dismiss(restore_focus);

            std::thread::spawn(move || {
                let fallback_crop = {
                    let pb = pixel_buffer.lock();
                    pb.as_ref()
                        .and_then(|buf| {
                            buf.crop_rgba(rect.x, rect.y, rect.w, rect.h, info.width, info.height)
                                .ok()
                        })
                        .or_else(|| {
                            crop_cg_image_to_rgba(
                                &cg_image.0,
                                rect.x,
                                rect.y,
                                rect.w,
                                rect.h,
                                info.width,
                                info.height,
                            )
                            .ok()
                        })
                };
                // Only decode full wallpaper backdrop if user actually selected Wallpaper mode.
                let needs_wallpaper = app
                    .state::<Arc<crate::AppState>>()
                    .settings
                    .lock()
                    .window_background
                    == crate::settings::WindowBackground::Wallpaper;
                let backdrop = if needs_wallpaper {
                    cg_image_to_rgba(&cg_image.0, true).ok()
                } else {
                    None
                };
                crate::complete_native_window_capture(
                    app,
                    win_id,
                    abs_bounds,
                    scale,
                    bounds,
                    fallback_crop,
                    backdrop,
                    action_owned,
                );
            });
            return;
        }

        let rect = sel.rect;
        self.dismiss(restore_focus);

        std::thread::spawn(move || {
            let cropped = {
                let pb = pixel_buffer.lock();
                if let Some(buf) = pb.as_ref() {
                    buf.crop_rgba(rect.x, rect.y, rect.w, rect.h, info.width, info.height)
                } else {
                    crop_cg_image_to_rgba(
                        &cg_image.0,
                        rect.x,
                        rect.y,
                        rect.w,
                        rect.h,
                        info.width,
                        info.height,
                    )
                }
            };
            match cropped {
                Ok(img) => {
                    crate::complete_native_area_capture(app, img, scale, bounds, action_owned);
                }
                Err(err) => {
                    eprintln!("[gaze] failed to crop selection: {err}");
                }
            }
        });
    }

    fn commit_scroll(&mut self, display_idx: usize, rect: RectF) {
        let Some(dp) = self.panels.get(display_idx) else {
            return;
        };
        let monitor_id = dp.info.id;
        let bounds = dp.info.bounds();
        let scale = dp.info.scale_factor;
        let app = self.app.clone();
        self.dismiss(true);

        crate::complete_native_scroll_capture(
            app,
            monitor_id,
            bounds,
            scale,
            rect.x,
            rect.y,
            rect.w.max(32.0),
            rect.h.max(48.0),
        );
    }

    fn show_toast(&mut self, msg: String) {
        self.toast_seq = self.toast_seq.wrapping_add(1);
        let target_seq = self.toast_seq;
        self.toast_text = Some(msg);
        self.sync_banners();

        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            let _ = app.run_on_main_thread(move || {
                with_controller(|ctrl| {
                    if ctrl.toast_seq == target_seq {
                        ctrl.toast_text = None;
                        ctrl.sync_banners();
                    }
                });
            });
        });
    }

    #[allow(deprecated)]
    fn apply_current_cursor(&self) {
        if !self.active {
            NSCursor::arrowCursor().set();
            return;
        }
        if let Some(drag) = &self.drag {
            match drag.handle {
                DragHandle::Move => NSCursor::closedHandCursor().set(),
                DragHandle::N | DragHandle::S => NSCursor::resizeUpDownCursor().set(),
                DragHandle::E | DragHandle::W => NSCursor::resizeLeftRightCursor().set(),
                _ => NSCursor::crosshairCursor().set(),
            }
            return;
        }
        if let Some(sel) = &self.selection {
            if sel.display_idx == self.cursor_display_idx && self.cursor_inside {
                let (cx, cy) = self.cursor_local;
                if let Some(placement) = self.panels[sel.display_idx].action_bar_placement {
                    if hit_test_action_bar(placement, cx, cy).is_some() {
                        NSCursor::pointingHandCursor().set();
                        return;
                    }
                    if point_in_toolbar_pill(placement, cx, cy) {
                        NSCursor::arrowCursor().set();
                        return;
                    }
                }
                if let Some(h) = hit_test_handle(sel.rect, cx, cy) {
                    match h {
                        DragHandle::N | DragHandle::S => NSCursor::resizeUpDownCursor().set(),
                        DragHandle::E | DragHandle::W => NSCursor::resizeLeftRightCursor().set(),
                        _ => NSCursor::crosshairCursor().set(),
                    }
                    return;
                }
                if sel.rect.contains(cx, cy) {
                    NSCursor::openHandCursor().set();
                    return;
                }
            }
        }
        NSCursor::crosshairCursor().set();
    }

    fn sync_all_panels(&mut self) {
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        for idx in 0..self.panels.len() {
            self.sync_panel_inner(idx);
        }
        self.sync_banners_inner();
        CATransaction::commit();
    }

    fn sync_panel_gpu(&mut self, idx: usize) {
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        self.sync_panel_inner(idx);
        CATransaction::commit();
    }

    fn update_crosshair_and_loupe_fast(&mut self) {
        let idx = self.cursor_display_idx;
        if idx >= self.panels.len() {
            return;
        }
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        self.update_crosshair_inner(idx);
        self.update_loupe_inner(idx);
        CATransaction::commit();
    }

    fn update_loupe_only(&mut self) {
        let idx = self.cursor_display_idx;
        if idx >= self.panels.len() {
            return;
        }
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        self.update_loupe_inner(idx);
        CATransaction::commit();
    }

    fn update_crosshair_inner(&mut self, idx: usize) {
        let show_guides = self.cursor_inside
            && self.cursor_display_idx == idx
            && (self.selection.is_none() || self.drag.is_some());
        let dp = &self.panels[idx];
        if show_guides {
            let (cx, cy) = self.cursor_local;
            let w = dp.info.width as f64;
            let h = dp.info.height as f64;
            let hairline = 1.0 / dp.info.scale_factor.max(1.0) as f64;
            dp.crosshair_h.setFrame(CGRect::new(
                CGPoint::new(0.0, cy.round()),
                CGSize::new(w, hairline),
            ));
            dp.crosshair_v.setFrame(CGRect::new(
                CGPoint::new(cx.round(), 0.0),
                CGSize::new(hairline, h),
            ));
            dp.crosshair_h.setHidden(false);
            dp.crosshair_v.setHidden(false);
        } else {
            dp.crosshair_h.setHidden(true);
            dp.crosshair_v.setHidden(true);
        }
    }

    fn update_loupe_inner(&mut self, idx: usize) {
        let show_loupe = self.cursor_inside
            && self.cursor_display_idx == idx
            && (self.selection.is_none() || self.drag.is_some());

        let has_pixels = self.panels[idx].pixel_buffer.lock().is_some();
        if !show_loupe || !has_pixels {
            self.panels[idx].loupe_view.setHidden(true);
            return;
        }

        let (cx, cy) = self.cursor_local;
        let vw = self.panels[idx].info.width as f64;
        let vh = self.panels[idx].info.height as f64;
        // Update hover_hex directly from pixel buffer.
        if let Some(buf) = self.panels[idx].pixel_buffer.lock().as_ref() {
            let px = ((cx / vw.max(1.0)) * buf.width as f64)
                .floor()
                .clamp(0.0, (buf.width.saturating_sub(1)) as f64) as usize;
            let py = ((cy / vh.max(1.0)) * buf.height as f64)
                .floor()
                .clamp(0.0, (buf.height.saturating_sub(1)) as f64) as usize;
            if let Some((r, g, b)) = buf.sample_rgb(px, py) {
                self.hover_hex = rgb_to_hex(r, g, b);
            }
        }

        let (lx, ly) = compute_loupe_origin(cx, cy, vw, vh);
        self.panels[idx].loupe_view.setFrame(NSRect::new(
            NSPoint::new(lx, ly),
            NSSize::new(LOUPE_W, LOUPE_H),
        ));
        self.panels[idx].loupe_view.setHidden(false);
        self.panels[idx].loupe_view.setNeedsDisplay(true);
    }

    fn sync_panel_inner(&mut self, idx: usize) {
        let is_dragging = self.drag.is_some();
        let sel_on_this = self
            .selection
            .as_ref()
            .filter(|s| s.display_idx == idx)
            .cloned();
        let hover_on_this = self
            .hovered_window
            .as_ref()
            .filter(|(d, _)| *d == idx)
            .map(|(_, w)| w.clone());
        let cursor_on_this = self.cursor_inside && self.cursor_display_idx == idx;

        if let Some(sel) = sel_on_this {
            let r = sel.rect;
            let vw = self.panels[idx].info.width as f64;
            let vh = self.panels[idx].info.height as f64;

            self.panels[idx].update_dim_cutout(Some(r), 0.34, 0.0);
            self.panels[idx].border_outer.setCornerRadius(0.0);
            self.panels[idx]
                .border_outer
                .setFrame(CGRect::new(CGPoint::new(r.x, r.y), CGSize::new(r.w, r.h)));
            self.panels[idx].border_outer.setHidden(false);

            if r.w > 6.0 && r.h > 6.0 {
                self.panels[idx].border_inner.setCornerRadius(0.0);
                self.panels[idx].border_inner.setFrame(CGRect::new(
                    CGPoint::new(r.x + 2.0, r.y + 2.0),
                    CGSize::new(r.w - 4.0, r.h - 4.0),
                ));
                self.panels[idx].border_inner.setHidden(false);
            } else {
                self.panels[idx].border_inner.setHidden(true);
            }
            self.panels[idx].corners_layer.setHidden(true);

            // Position 8 tactile circular handles.
            for (h_layer, (_, hx, hy)) in self.panels[idx].handles.iter().zip(handle_positions(r)) {
                h_layer.setPosition(CGPoint::new(hx, hy));
                h_layer.setHidden(false);
            }

            let dim_primary = format!("{} × {}", r.w.round() as i32, r.h.round() as i32);
            self.panels[idx].update_badge(r, &dim_primary, "pt", false);

            // Floating action bar when selection is locked and not dragging.
            if !is_dragging && r.w >= 6.0 && r.h >= 6.0 {
                let placement = compute_action_bar_placement(r, vw, vh);
                self.panels[idx].action_bar_placement = Some(placement);
                self.panels[idx].action_bar_view.setFrame(NSRect::new(
                    NSPoint::new(placement.view_rect.x, placement.view_rect.y),
                    NSSize::new(placement.view_rect.w, placement.view_rect.h),
                ));
                self.panels[idx].action_bar_view.setHidden(false);
                self.panels[idx].action_bar_view.setNeedsDisplay(true);
            } else {
                self.panels[idx].action_bar_placement = None;
                self.panels[idx].action_bar_view.setHidden(true);
            }
        } else if self.selection.is_none() && cursor_on_this {
            // Live Snipaste window hover (or full-display highlight when on desktop/menubar).
            let vw = self.panels[idx].info.width as f64;
            let vh = self.panels[idx].info.height as f64;
            for h in &self.panels[idx].handles {
                h.setHidden(true);
            }
            self.panels[idx].action_bar_placement = None;
            self.panels[idx].action_bar_view.setHidden(true);

            if let Some(win) = hover_on_this {
                let r = RectF {
                    x: win.x as f64,
                    y: win.y as f64,
                    w: win.width as f64,
                    h: win.height as f64,
                };
                self.panels[idx].update_dim_cutout(Some(r), 0.25, 6.0);
                self.panels[idx].border_outer.setCornerRadius(6.0);
                self.panels[idx]
                    .border_outer
                    .setFrame(CGRect::new(CGPoint::new(r.x, r.y), CGSize::new(r.w, r.h)));
                self.panels[idx].border_outer.setHidden(false);

                self.panels[idx].border_inner.setCornerRadius(4.0);
                self.panels[idx].border_inner.setFrame(CGRect::new(
                    CGPoint::new(r.x + 2.0, r.y + 2.0),
                    CGSize::new((r.w - 4.0).max(0.0), (r.h - 4.0).max(0.0)),
                ));
                self.panels[idx].border_inner.setHidden(false);

                self.panels[idx].update_corners_path(r);
                let size_str = format!("{} × {}", win.width, win.height);
                self.panels[idx].update_badge(r, &win.app_name, &size_str, false);
            } else {
                // Full display highlight fallback.
                let r = RectF {
                    x: 2.0,
                    y: 2.0,
                    w: (vw - 4.0).max(1.0),
                    h: (vh - 4.0).max(1.0),
                };
                self.panels[idx].update_dim_cutout(Some(r), 0.16, 2.0);
                self.panels[idx].border_outer.setCornerRadius(2.0);
                self.panels[idx]
                    .border_outer
                    .setFrame(CGRect::new(CGPoint::new(r.x, r.y), CGSize::new(r.w, r.h)));
                self.panels[idx].border_outer.setHidden(false);
                self.panels[idx].border_inner.setHidden(true);
                self.panels[idx].update_corners_path(r);

                let label = if self.panels[idx].name.is_empty() {
                    "Display".to_string()
                } else {
                    self.panels[idx].name.clone()
                };
                let size_str = format!(
                    "{} × {}",
                    self.panels[idx].info.width, self.panels[idx].info.height
                );
                self.panels[idx].update_badge(r, &label, &size_str, true);
            }
        } else {
            // Non-active display (cursor or selection is on another monitor): clean subtle dim.
            self.panels[idx].update_dim_cutout(None, 0.22, 0.0);
            self.panels[idx].border_outer.setHidden(true);
            self.panels[idx].border_inner.setHidden(true);
            self.panels[idx].corners_layer.setHidden(true);
            for h in &self.panels[idx].handles {
                h.setHidden(true);
            }
            self.panels[idx].badge_view.setHidden(true);
            self.panels[idx].action_bar_placement = None;
            self.panels[idx].action_bar_view.setHidden(true);
        }

        self.update_crosshair_inner(idx);
        self.update_loupe_inner(idx);
    }

    fn sync_banners(&mut self) {
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        self.sync_banners_inner();
        CATransaction::commit();
    }

    fn sync_banners_inner(&self) {
        let target_idx = self
            .cursor_display_idx
            .min(self.panels.len().saturating_sub(1));
        for (idx, dp) in self.panels.iter().enumerate() {
            let show_toast = idx == target_idx && self.toast_text.is_some();
            let show_scroll_hint = idx == target_idx
                && !show_toast
                && self.mode == CaptureMode::Scrolling
                && self.selection.is_none()
                && self.drag.is_none();

            if show_toast || show_scroll_hint {
                let bw = if show_toast { 180.0 } else { 370.0 };
                let bh = 32.0;
                let bx = ((dp.info.width as f64 - bw) * 0.5).round();
                let by = (dp.info.height as f64 - bh - 26.0).round();
                dp.banner_view
                    .setFrame(NSRect::new(NSPoint::new(bx, by), NSSize::new(bw, bh)));
                dp.banner_view.setHidden(false);
                dp.banner_view.setNeedsDisplay(true);
            } else {
                dp.banner_view.setHidden(true);
            }
        }
    }
}

// ============================================================================
// Crisp Native CoreGraphics / AppKit HUD Drawing (only tiny rects!)
// ============================================================================

fn text_attrs(font: &NSFont, color: &NSColor) -> Retained<NSDictionary<NSString, AnyObject>> {
    unsafe {
        let keys: [&NSString; 2] = [NSFontAttributeName, NSForegroundColorAttributeName];
        let font_obj: &AnyObject = &*(font as *const NSFont as *const AnyObject);
        let color_obj: &AnyObject = &*(color as *const NSColor as *const AnyObject);
        let objs: [&AnyObject; 2] = [font_obj, color_obj];
        NSDictionary::from_slices(&keys, &objs)
    }
}

fn measure_text(s: &str, font: &NSFont, color: &NSColor) -> CGSize {
    let ns = NSString::from_str(s);
    let attrs = text_attrs(font, color);
    unsafe { ns.sizeWithAttributes(Some(&attrs)) }
}

fn draw_text(s: &str, pt: CGPoint, font: &NSFont, color: &NSColor) {
    let ns = NSString::from_str(s);
    let attrs = text_attrs(font, color);
    unsafe { ns.drawAtPoint_withAttributes(pt, Some(&attrs)) }
}

fn measure_badge_width(primary: &str, secondary: &str) -> f64 {
    let font_p = NSFont::systemFontOfSize_weight(11.0, unsafe { NSFontWeightMedium });
    let font_s =
        NSFont::monospacedDigitSystemFontOfSize_weight(10.5, unsafe { NSFontWeightRegular });
    let c = NSColor::whiteColor();
    let w1 = measure_text(primary, &font_p, &c).width;
    let w2 = if secondary.is_empty() {
        0.0
    } else {
        measure_text(secondary, &font_s, &c).width + 7.0
    };
    (w1 + w2 + 18.0).max(60.0)
}

fn draw_badge_hud(display_idx: usize, bounds: NSRect) {
    let Some((primary, secondary)) = with_controller_ref(|ctrl| {
        ctrl.panels
            .get(display_idx)
            .map(|dp| (dp.badge_primary.clone(), dp.badge_secondary.clone()))
    })
    .flatten() else {
        return;
    };

    let bg = NSColor::colorWithSRGBRed_green_blue_alpha(0.086, 0.086, 0.094, 0.88);
    let border = NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.16);
    let rect = NSRect::new(
        NSPoint::new(0.5, 0.5),
        NSSize::new(bounds.size.width - 1.0, bounds.size.height - 1.0),
    );
    let path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect, 7.0, 7.0);
    bg.setFill();
    path.fill();
    border.setStroke();
    path.setLineWidth(1.0);
    path.stroke();

    let font_p = NSFont::systemFontOfSize_weight(11.0, unsafe { NSFontWeightMedium });
    let font_s =
        NSFont::monospacedDigitSystemFontOfSize_weight(10.5, unsafe { NSFontWeightRegular });
    let white = NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.96);
    let muted = NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.65);

    let sz_p = measure_text(&primary, &font_p, &white);
    let sz_s = if secondary.is_empty() {
        CGSize::ZERO
    } else {
        measure_text(&secondary, &font_s, &muted)
    };
    let max_p_w = (bounds.size.width
        - 18.0
        - if secondary.is_empty() {
            0.0
        } else {
            sz_s.width + 7.0
        })
    .max(24.0);
    let y_p = ((bounds.size.height - sz_p.height) * 0.5).round();

    // Clip primary text cleanly if app name is long.
    if sz_p.width <= max_p_w {
        draw_text(&primary, CGPoint::new(9.0, y_p), &font_p, &white);
    } else {
        let mut truncated = primary.clone();
        while !truncated.is_empty()
            && measure_text(&format!("{truncated}…"), &font_p, &white).width > max_p_w
        {
            truncated.pop();
        }
        draw_text(
            &format!("{truncated}…"),
            CGPoint::new(9.0, y_p),
            &font_p,
            &white,
        );
    }

    if !secondary.is_empty() {
        let sx = (bounds.size.width - 9.0 - sz_s.width).max(9.0);
        let y_s = ((bounds.size.height - sz_s.height) * 0.5).round();
        draw_text(&secondary, CGPoint::new(sx, y_s), &font_s, &muted);
    }
}

fn draw_loupe_hud(display_idx: usize, bounds: NSRect) {
    let Some((pixel_buf_arc, cx, cy, vw, vh, hex)) = with_controller_ref(|ctrl| {
        ctrl.panels.get(display_idx).map(|dp| {
            (
                dp.pixel_buffer.clone(),
                ctrl.cursor_local.0,
                ctrl.cursor_local.1,
                dp.info.width as f64,
                dp.info.height as f64,
                ctrl.hover_hex.clone(),
            )
        })
    })
    .flatten() else {
        return;
    };

    let guard = pixel_buf_arc.lock();
    let Some(buf) = guard.as_ref() else {
        return;
    };

    let Some(ns_ctx) = NSGraphicsContext::currentContext() else {
        return;
    };
    let cg_ctx = ns_ctx.CGContext();

    // Outer dark rounded card
    let card_rect = NSRect::new(
        NSPoint::new(0.5, 0.5),
        NSSize::new(bounds.size.width - 1.0, bounds.size.height - 1.0),
    );
    let card_path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(card_rect, 11.0, 11.0);
    NSColor::colorWithSRGBRed_green_blue_alpha(0.086, 0.086, 0.094, 0.94).setFill();
    card_path.fill();

    // Pixel viewport (top 114pt, clipped inside rounded card top corners)
    let grid_x = 1.0;
    let grid_y = 1.0;
    let grid_w = bounds.size.width - 2.0;
    let grid_h = 114.0;

    let sample_n: isize = 11;
    let half: isize = 5;
    let cell_w = grid_w / sample_n as f64;
    let cell_h = grid_h / sample_n as f64;

    let px = ((cx / vw.max(1.0)) * buf.width as f64)
        .floor()
        .clamp(0.0, (buf.width.saturating_sub(1)) as f64) as isize;
    let py = ((cy / vh.max(1.0)) * buf.height as f64)
        .floor()
        .clamp(0.0, (buf.height.saturating_sub(1)) as f64) as isize;

    let center_rgb = buf
        .sample_rgb(px as usize, py as usize)
        .unwrap_or((0, 0, 0));

    CGContext::save_g_state(Some(&cg_ctx));
    card_path.addClip();
    CGContext::set_should_antialias(Some(&cg_ctx), false);

    // 121-pixel C-speed direct draw directly from CFData (< 5 microseconds!)
    for dy in -half..=half {
        let sy = py + dy;
        let ry = grid_y + (dy + half) as f64 * cell_h;
        for dx in -half..=half {
            let sx = px + dx;
            let rx = grid_x + (dx + half) as f64 * cell_w;
            if sx >= 0 && sy >= 0 && (sx as usize) < buf.width && (sy as usize) < buf.height {
                if let Some((r, g, b)) = buf.sample_rgb(sx as usize, sy as usize) {
                    CGContext::set_rgb_fill_color(
                        Some(&cg_ctx),
                        r as f64 / 255.0,
                        g as f64 / 255.0,
                        b as f64 / 255.0,
                        1.0,
                    );
                }
            } else {
                CGContext::set_rgb_fill_color(Some(&cg_ctx), 0.094, 0.094, 0.106, 1.0);
            }
            CGContext::fill_rect(
                Some(&cg_ctx),
                CGRect::new(
                    CGPoint::new(rx.floor(), ry.floor()),
                    CGSize::new(cell_w.ceil(), cell_h.ceil()),
                ),
            );
        }
    }

    // Crisp subtle pixel grid
    CGContext::set_rgb_stroke_color(Some(&cg_ctx), 1.0, 1.0, 1.0, 0.14);
    CGContext::set_line_width(Some(&cg_ctx), 1.0);
    for i in 1..sample_n {
        let gx = (grid_x + i as f64 * cell_w).round() + 0.5;
        let gy = (grid_y + i as f64 * cell_h).round() + 0.5;
        CGContext::move_to_point(Some(&cg_ctx), gx, grid_y);
        CGContext::add_line_to_point(Some(&cg_ctx), gx, grid_y + grid_h);
        CGContext::move_to_point(Some(&cg_ctx), grid_x, gy);
        CGContext::add_line_to_point(Some(&cg_ctx), grid_x + grid_w, gy);
    }
    CGContext::stroke_path(Some(&cg_ctx));

    // Center pixel reticle (#0095FF)
    CGContext::set_rgb_stroke_color(Some(&cg_ctx), 0.0, 0.584, 1.0, 1.0);
    CGContext::set_line_width(Some(&cg_ctx), 2.0);
    CGContext::stroke_rect(
        Some(&cg_ctx),
        CGRect::new(
            CGPoint::new(
                (grid_x + half as f64 * cell_w).floor() + 1.0,
                (grid_y + half as f64 * cell_h).floor() + 1.0,
            ),
            CGSize::new(cell_w.ceil() - 2.0, cell_h.ceil() - 2.0),
        ),
    );
    CGContext::restore_g_state(Some(&cg_ctx));

    // Subtle divider below pixel grid
    NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.12).setFill();
    NSBezierPath::fillRect(NSRect::new(
        NSPoint::new(1.0, grid_y + grid_h),
        NSSize::new(bounds.size.width - 2.0, 1.0),
    ));

    // Row 1 footer: Color swatch dot + #RRGGBB + Tab keycap
    let dot_rect = NSRect::new(
        NSPoint::new(10.0, grid_y + grid_h + 9.0),
        NSSize::new(10.0, 10.0),
    );
    let dot_path = NSBezierPath::bezierPathWithOvalInRect(dot_rect);
    NSColor::colorWithSRGBRed_green_blue_alpha(
        center_rgb.0 as f64 / 255.0,
        center_rgb.1 as f64 / 255.0,
        center_rgb.2 as f64 / 255.0,
        1.0,
    )
    .setFill();
    dot_path.fill();
    NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.45).setStroke();
    dot_path.setLineWidth(1.0);
    dot_path.stroke();

    let mono_bold = NSFont::monospacedSystemFontOfSize_weight(10.5, unsafe { NSFontWeightMedium });
    let white = NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.95);
    draw_text(
        &hex,
        CGPoint::new(25.0, grid_y + grid_h + 7.0),
        &mono_bold,
        &white,
    );

    // Tab keycap badge
    let tab_rect = NSRect::new(
        NSPoint::new(bounds.size.width - 32.0, grid_y + grid_h + 7.0),
        NSSize::new(24.0, 14.0),
    );
    let tab_path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(tab_rect, 3.5, 3.5);
    NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.14).setFill();
    tab_path.fill();
    let tab_font = NSFont::monospacedSystemFontOfSize_weight(9.0, unsafe { NSFontWeightMedium });
    let tab_color = NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.8);
    draw_text(
        "Tab",
        CGPoint::new(bounds.size.width - 28.0, grid_y + grid_h + 8.0),
        &tab_font,
        &tab_color,
    );

    // Row 2 footer: exact cursor coordinates
    let coords = format!("{}, {}", cx.round() as i32, cy.round() as i32);
    let coord_font =
        NSFont::monospacedDigitSystemFontOfSize_weight(9.5, unsafe { NSFontWeightRegular });
    let coord_color = NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.55);
    draw_text(
        &coords,
        CGPoint::new(10.0, grid_y + grid_h + 25.0),
        &coord_font,
        &coord_color,
    );

    // Crisp outer border ring
    NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.22).setStroke();
    card_path.setLineWidth(1.0);
    card_path.stroke();
}

fn draw_sf_symbol(symbol_name: &str, rect: NSRect, point_size: f64, color: &NSColor) {
    let name = NSString::from_str(symbol_name);
    let Some(base_img) = NSImage::imageWithSystemSymbolName_accessibilityDescription(&name, None)
    else {
        return;
    };
    let size_cfg = NSImageSymbolConfiguration::configurationWithPointSize_weight_scale(
        point_size,
        unsafe { NSFontWeightMedium },
        NSImageSymbolScale::Medium,
    );
    let color_cfg = NSImageSymbolConfiguration::configurationWithHierarchicalColor(color);
    let cfg = size_cfg.configurationByApplyingConfiguration(&color_cfg);
    let img = base_img
        .imageWithSymbolConfiguration(&cfg)
        .unwrap_or(base_img);

    let sz = img.size();
    let draw_w = sz.width.min(rect.size.width);
    let draw_h = sz.height.min(rect.size.height);
    let dst = NSRect::new(
        NSPoint::new(
            rect.origin.x + (rect.size.width - draw_w) * 0.5,
            rect.origin.y + (rect.size.height - draw_h) * 0.5,
        ),
        NSSize::new(draw_w, draw_h),
    );
    unsafe {
        img.drawInRect_fromRect_operation_fraction_respectFlipped_hints(
            dst,
            NSRect::ZERO,
            NSCompositingOperation::SourceOver,
            1.0,
            true,
            None,
        );
    }
}

fn draw_action_bar_hud(display_idx: usize, _bounds: NSRect) {
    let Some((placement, hovered_idx, active_idx)) = with_controller_ref(|ctrl| {
        ctrl.panels
            .get(display_idx)
            .and_then(|dp| dp.action_bar_placement)
            .map(|p| (p, ctrl.hovered_action_idx, ctrl.inplace.as_ref().map(|h| h.tool_idx)))
    })
    .flatten() else {
        return;
    };

    let bar_w = placement.view_rect.w;
    let py = placement.pill_y_local;
    let pill_rect = NSRect::new(
        NSPoint::new(0.5, py + 0.5),
        NSSize::new(bar_w - 1.0, TOOLBAR_PILL_H - 1.0),
    );
    let pill_path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(pill_rect, 10.0, 10.0);
    NSColor::colorWithSRGBRed_green_blue_alpha(0.985, 0.985, 0.99, 0.96).setFill();
    pill_path.fill();
    NSColor::colorWithSRGBRed_green_blue_alpha(0.0, 0.0, 0.0, 0.12).setStroke();
    pill_path.setLineWidth(1.0);
    pill_path.stroke();

    let ink = NSColor::colorWithSRGBRed_green_blue_alpha(0.11, 0.11, 0.122, 1.0);
    let icon_muted = NSColor::colorWithSRGBRed_green_blue_alpha(0.26, 0.26, 0.29, 1.0);
    let icon_disabled = NSColor::colorWithSRGBRed_green_blue_alpha(0.15, 0.15, 0.17, 0.3);
    let accent = NSColor::colorWithSRGBRed_green_blue_alpha(0.0, 0.40, 0.84, 1.0);
    let btn_top = py + (TOOLBAR_PILL_H - TOOLBAR_BTN) * 0.5;
    let xs = toolbar_item_xs();

    for (idx, item) in TOOLBAR_ITEMS.iter().enumerate() {
        let x = xs[idx];
        let Some(action) = item.action else {
            NSColor::colorWithSRGBRed_green_blue_alpha(0.0, 0.0, 0.0, 0.10).setFill();
            NSBezierPath::fillRect(NSRect::new(
                NSPoint::new(x + (TOOLBAR_DIVIDER - 1.0) * 0.5, py + 11.0),
                NSSize::new(1.0, TOOLBAR_PILL_H - 22.0),
            ));
            continue;
        };
        let enabled = toolbar_item_enabled(action);
        let is_active = active_idx == Some(idx);
        let is_hovered = enabled && hovered_idx == Some(idx);
        let btn_rect = NSRect::new(
            NSPoint::new(x, btn_top),
            NSSize::new(TOOLBAR_BTN, TOOLBAR_BTN),
        );
        let btn_path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(btn_rect, 7.0, 7.0);
        if is_active {
            NSColor::colorWithSRGBRed_green_blue_alpha(0.0, 0.478, 1.0, 0.11).setFill();
            btn_path.fill();
        } else if is_hovered {
            NSColor::colorWithSRGBRed_green_blue_alpha(0.0, 0.0, 0.0, 0.06).setFill();
            btn_path.fill();
        }
        let color = if !enabled {
            &icon_disabled
        } else if is_active || action == ToolbarAction::Done {
            &accent
        } else if is_hovered {
            &ink
        } else {
            &icon_muted
        };
        draw_sf_symbol(
            item.symbol,
            NSRect::new(
                NSPoint::new(x + (TOOLBAR_BTN - 18.0) * 0.5, btn_top + (TOOLBAR_BTN - 18.0) * 0.5),
                NSSize::new(18.0, 18.0),
            ),
            13.0,
            color,
        );
    }

    // Crisp dark tooltip pill on hover
    if let Some(h_idx) = hovered_idx {
        let Some(item) = TOOLBAR_ITEMS.get(h_idx).filter(|i| i.action.is_some()) else {
            return;
        };
        let tip_font = NSFont::systemFontOfSize_weight(10.5, unsafe { NSFontWeightMedium });
        let key_font =
            NSFont::monospacedSystemFontOfSize_weight(9.5, unsafe { NSFontWeightMedium });
        let tip_color = NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.95);
        let key_color = NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.65);

        let sz_t = measure_text(item.tooltip, &tip_font, &tip_color);
        let sz_k = if item.shortcut.is_empty() {
            CGSize::ZERO
        } else {
            measure_text(item.shortcut, &key_font, &key_color)
        };
        let tip_w = sz_t.width
            + if item.shortcut.is_empty() {
                16.0
            } else {
                sz_k.width + 24.0
            };
        let tip_h = 22.0;
        let center_x = xs[h_idx] + TOOLBAR_BTN * 0.5;
        let tip_x = (center_x - tip_w * 0.5).clamp(2.0, (bar_w - tip_w - 2.0).max(2.0));
        let tip_y = if placement.tooltip_below {
            py + TOOLBAR_PILL_H + 5.0
        } else {
            (py - tip_h - 5.0).max(1.0)
        };

        let tip_rect = NSRect::new(NSPoint::new(tip_x, tip_y), NSSize::new(tip_w, tip_h));
        let tip_path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(tip_rect, 6.0, 6.0);
        NSColor::colorWithSRGBRed_green_blue_alpha(0.086, 0.086, 0.094, 0.92).setFill();
        tip_path.fill();
        NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.14).setStroke();
        tip_path.setLineWidth(1.0);
        tip_path.stroke();

        draw_text(
            item.tooltip,
            CGPoint::new(tip_x + 8.0, tip_y + (tip_h - sz_t.height) * 0.5),
            &tip_font,
            &tip_color,
        );
        if !item.shortcut.is_empty() {
            draw_text(
                item.shortcut,
                CGPoint::new(
                    tip_x + 8.0 + sz_t.width + 8.0,
                    tip_y + (tip_h - sz_k.height) * 0.5,
                ),
                &key_font,
                &key_color,
            );
        }
    }
}

fn draw_banner_hud(_display_idx: usize, bounds: NSRect) {
    let Some((toast, is_scrolling)) =
        with_controller_ref(|ctrl| (ctrl.toast_text.clone(), ctrl.mode == CaptureMode::Scrolling))
    else {
        return;
    };

    let text = if let Some(t) = toast {
        t
    } else if is_scrolling {
        "Scrolling Capture — Click window or drag region  (Esc)".to_string()
    } else {
        return;
    };

    let rect = NSRect::new(
        NSPoint::new(0.5, 0.5),
        NSSize::new(bounds.size.width - 1.0, bounds.size.height - 1.0),
    );
    let path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
        rect,
        bounds.size.height * 0.5,
        bounds.size.height * 0.5,
    );
    NSColor::colorWithSRGBRed_green_blue_alpha(0.086, 0.086, 0.094, 0.90).setFill();
    path.fill();
    NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.16).setStroke();
    path.setLineWidth(1.0);
    path.stroke();

    let font = NSFont::systemFontOfSize_weight(12.0, unsafe { NSFontWeightMedium });
    let white = NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.95);
    let sz = measure_text(&text, &font, &white);
    draw_text(
        &text,
        CGPoint::new(
            (bounds.size.width - sz.width) * 0.5,
            (bounds.size.height - sz.height) * 0.5,
        ),
        &font,
        &white,
    );
}

// ============================================================================
// Space-change observer & Tauri window helpers
// ============================================================================

fn has_other_visible_window_on_different_space(app: &AppHandle) -> bool {
    for (label, w) in app.webview_windows() {
        if label == crate::windows::LABEL_OVERLAY || label.starts_with("inplace-") {
            continue;
        }
        if let Ok(ptr) = w.ns_window() {
            let other = unsafe { &*(ptr as *const NSWindow) };
            if other.isVisible() && !other.isOnActiveSpace() {
                return true;
            }
        }
    }
    false
}

fn has_any_other_visible_window(app: &AppHandle) -> bool {
    for (label, w) in app.webview_windows() {
        if label == crate::windows::LABEL_OVERLAY {
            continue;
        }
        if let Ok(ptr) = w.ns_window() {
            let other = unsafe { &*(ptr as *const NSWindow) };
            if other.isVisible() {
                return true;
            }
        }
    }
    false
}

/// Dismisses any active overlay immediately when the user swipes to another Space.
pub fn install_space_change_observer(app: &AppHandle) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = SPACE_OBSERVER.get_or_init(move || {
            let workspace = NSWorkspace::sharedWorkspace();
            let center = workspace.notificationCenter();
            let block = RcBlock::new(move |_note: NonNull<NSNotification>| {
                if now_ms().saturating_sub(LAST_PRESENT_MS.load(Ordering::SeqCst)) < 350 {
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

// ============================================================================
// Public Entrypoints called from lib.rs / windows.rs
// ============================================================================

/// Captures ALL active displays in parallel (~15-25ms) and presents 100% native
/// GPU-accelerated `NSPanel` overlays simultaneously across every monitor.
pub fn start_native_overlay(app: &AppHandle, seq: u64, mode: &str) -> Result<(), String> {
    let cursor = crate::capture::get_cursor_position();
    let displays = enumerate_active_displays()?;

    // Parallel capture of every display's CGImage + single-pass window enumeration.
    let (cg_results, windows_per_display) = std::thread::scope(|s| {
        let win_handle = s.spawn(|| enumerate_windows_for_displays(&displays));
        let cap_handles: Vec<_> = displays
            .iter()
            .map(|d| s.spawn(move || capture_display_cg_image(d.x, d.y, d.width, d.height)))
            .collect();

        let mut images = Vec::with_capacity(displays.len());
        for h in cap_handles {
            match h.join() {
                Ok(res) => images.push(res),
                Err(_) => images.push(Err("Display capture thread panicked".to_string())),
            }
        }
        let wins = win_handle
            .join()
            .unwrap_or_else(|_| vec![Vec::new(); displays.len()]);
        (images, wins)
    });

    let mut captured = Vec::with_capacity(displays.len());
    let mut decode_jobs: Vec<(SendCGImage, Arc<Mutex<Option<SendPixelBuffer>>>)> =
        Vec::with_capacity(displays.len());
    let mut first_err: Option<String> = None;

    for ((idx, (disp, img_res)), wins) in displays
        .into_iter()
        .zip(cg_results)
        .enumerate()
        .zip(windows_per_display)
    {
        match img_res {
            Ok(cg_img) => {
                let pb = Arc::new(Mutex::new(None));
                decode_jobs.push((cg_img.clone(), pb.clone()));
                captured.push(CapturedDisplay {
                    info: disp,
                    name: format!("Display {}", idx + 1),
                    cg_image: cg_img,
                    pixel_buffer: pb,
                    windows: wins,
                });
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }

    if captured.is_empty() {
        return Err(first_err.unwrap_or_else(|| "Failed to capture any display".to_string()));
    }

    let capture_mode = if mode == "scrolling" {
        CaptureMode::Scrolling
    } else {
        CaptureMode::Unified
    };
    let prewarm_bounds = captured
        .iter()
        .find(|c| c.info.is_main)
        .or_else(|| captured.first())
        .map(|c| c.info.bounds());

    // Present native overlay panels immediately on the main thread (~1ms).
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        OVERLAY_CTRL.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let ctrl = borrow.get_or_insert_with(|| OverlayController::new(app_for_main.clone()));
            ctrl.present(mtm, seq, capture_mode, captured, cursor);
        });
    })
    .map_err(|e| format!("Failed to present native overlay: {e}"))?;

    // Start the in-place editor webview while the user is still dragging a selection, so
    // picking an annotation tool does not wait for WKWebView to boot. It stays hidden and is
    // destroyed with the overlay if it is never used.
    if capture_mode == CaptureMode::Unified {
        if let Some(bounds) = prewarm_bounds {
            let app_prewarm = app.clone();
            std::thread::spawn(move || {
                if let Err(err) =
                    crate::windows::ensure_inplace_editor(&app_prewarm, &inplace_label(seq), bounds)
                {
                    eprintln!("[gaze] in-place editor prewarm failed: {err}");
                }
            });
        }
    }

    // Map raw CFData pixel buffers in parallel on a worker thread (~2-4ms) for the 120fps loupe.
    let app_for_bg = app.clone();
    std::thread::spawn(move || {
        std::thread::scope(|s| {
            for (cg, slot) in &decode_jobs {
                s.spawn(move || {
                    if let Some(buf) = SendPixelBuffer::from_cg_image(&cg.0) {
                        *slot.lock() = Some(buf);
                    }
                });
            }
        });
        let _ = app_for_bg.run_on_main_thread(move || {
            with_controller(|ctrl| ctrl.on_pixel_buffers_ready(seq));
        });
    });

    Ok(())
}

/// The in-place editor painted its first frame; show it above the native panel.
pub fn inplace_editor_ready(app: &AppHandle, label: String) {
    let _ = app.run_on_main_thread(move || {
        with_controller(|ctrl| ctrl.on_inplace_ready(&label));
    });
}

/// Re-applies the in-place editor window frame/level for the active hand-off (if any).
pub fn place_inplace_window(app: &AppHandle, label: String) {
    let _ = app.run_on_main_thread(move || {
        with_controller_ref(|ctrl| ctrl.place_inplace_window(&label));
    });
}

/// Immediately hides all native overlay panels and optionally restores focus to the prior app.
pub fn dismiss_native_overlay(app: &AppHandle, restore_focus: bool) {
    let _ = app.run_on_main_thread(move || {
        with_controller(|ctrl| ctrl.dismiss(restore_focus));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toolbar_width_matches_web_layout() {
        // Mirrors `TOOLBAR_WIDTH` in src/components/editor/inplaceToolbarLayout.ts.
        assert_eq!(toolbar_width(), 579.0);
        let xs = toolbar_item_xs();
        assert_eq!(xs[0], TOOLBAR_PAD);
        assert_eq!(xs[1], TOOLBAR_PAD + TOOLBAR_BTN + TOOLBAR_GAP);
    }

    #[test]
    fn action_bar_placement_prefers_below_then_above_then_inside() {
        let normal = RectF {
            x: 200.0,
            y: 200.0,
            w: 700.0,
            h: 300.0,
        };
        let p = compute_action_bar_placement(normal, 1512.0, 982.0);
        assert_eq!(p.side, ToolbarSide::Below);
        assert_eq!(p.pill_rect().y, 508.0);
        // Right edge aligned with the selection's right edge.
        assert_eq!(p.pill_rect().x + p.pill_rect().w, 900.0);
        assert!(p.tooltip_below);

        let near_bottom = RectF {
            x: 300.0,
            y: 600.0,
            w: 700.0,
            h: 360.0,
        };
        let pb = compute_action_bar_placement(near_bottom, 1512.0, 982.0);
        assert_eq!(pb.side, ToolbarSide::Above);
        assert_eq!(pb.pill_rect().y, 600.0 - TOOLBAR_SEL_GAP - TOOLBAR_PILL_H);

        let full = RectF {
            x: 0.0,
            y: 0.0,
            w: 1512.0,
            h: 982.0,
        };
        let pf = compute_action_bar_placement(full, 1512.0, 982.0);
        assert_eq!(pf.side, ToolbarSide::Inside);
        let pill = pf.pill_rect();
        assert!(pill.y + TOOLBAR_PILL_H <= 982.0 - TOOLBAR_MARGIN);
        assert!(pill.x + pill.w <= 1512.0 - TOOLBAR_MARGIN);

        // Small selection hugging the left edge: toolbar is clamped on-screen.
        let tiny_left = RectF {
            x: 2.0,
            y: 100.0,
            w: 40.0,
            h: 40.0,
        };
        let pl = compute_action_bar_placement(tiny_left, 1512.0, 982.0);
        assert_eq!(pl.pill_rect().x, TOOLBAR_MARGIN);
    }

    #[test]
    fn toolbar_hit_testing_maps_to_items() {
        let sel = RectF {
            x: 200.0,
            y: 200.0,
            w: 700.0,
            h: 300.0,
        };
        let p = compute_action_bar_placement(sel, 1512.0, 982.0);
        let pill = p.pill_rect();
        let xs = toolbar_item_xs();
        let cy = pill.y + TOOLBAR_PILL_H * 0.5;
        for (idx, item) in TOOLBAR_ITEMS.iter().enumerate() {
            let w = if item.action.is_some() {
                TOOLBAR_BTN
            } else {
                TOOLBAR_DIVIDER
            };
            let cx = pill.x + xs[idx] + w * 0.5;
            if item.action.is_some() {
                assert_eq!(hit_test_action_bar(p, cx, cy), Some(idx));
            } else {
                assert_eq!(hit_test_action_bar(p, cx, cy), None);
                assert!(point_in_toolbar_pill(p, cx, cy));
            }
        }
        assert_eq!(hit_test_action_bar(p, pill.x - 2.0, cy), None);
        assert!(!point_in_toolbar_pill(p, pill.x, pill.y - 1.0));
    }

    #[test]
    fn tool_shortcuts_follow_editor_keys() {
        assert_eq!(tool_for_shortcut_key("s"), Some("rect"));
        assert_eq!(tool_for_shortcut_key("A"), Some("arrow"));
        assert_eq!(tool_for_shortcut_key("x"), Some("pixelate"));
        assert_eq!(tool_for_shortcut_key("n"), Some("counter"));
        assert_eq!(tool_for_shortcut_key("z"), None);
        assert!(!toolbar_item_enabled(ToolbarAction::Undo));
        assert!(toolbar_item_enabled(ToolbarAction::Scroll));
    }

    #[test]
    fn handle_hit_testing_detects_all_eight_handles() {
        let sel = RectF {
            x: 100.0,
            y: 100.0,
            w: 400.0,
            h: 200.0,
        };
        assert_eq!(hit_test_handle(sel, 100.0, 100.0), Some(DragHandle::NW));
        assert_eq!(hit_test_handle(sel, 500.0, 100.0), Some(DragHandle::NE));
        assert_eq!(hit_test_handle(sel, 100.0, 300.0), Some(DragHandle::SW));
        assert_eq!(hit_test_handle(sel, 500.0, 300.0), Some(DragHandle::SE));
        assert_eq!(hit_test_handle(sel, 300.0, 100.0), Some(DragHandle::N));
        assert_eq!(hit_test_handle(sel, 300.0, 300.0), Some(DragHandle::S));
        assert_eq!(hit_test_handle(sel, 100.0, 200.0), Some(DragHandle::W));
        assert_eq!(hit_test_handle(sel, 500.0, 200.0), Some(DragHandle::E));
        assert_eq!(hit_test_handle(sel, 300.0, 200.0), None);
    }

    #[test]
    fn loupe_flips_near_screen_edges() {
        let (lx, ly) = compute_loupe_origin(100.0, 100.0, 1512.0, 982.0);
        assert_eq!((lx, ly), (122.0, 122.0));

        let (lx2, ly2) = compute_loupe_origin(1480.0, 950.0, 1512.0, 982.0);
        assert!(lx2 + LOUPE_W < 1480.0);
        assert!(ly2 + LOUPE_H < 950.0);
    }
}
