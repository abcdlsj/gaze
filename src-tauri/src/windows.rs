use crate::capture::MonitorBounds;
#[cfg(not(target_os = "macos"))]
use crate::capture::OverlaySessionInfo;
use tauri::utils::config::BackgroundThrottlingPolicy;
#[cfg(not(target_os = "macos"))]
use tauri::Emitter;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, PhysicalSize};

pub const LABEL_PREFERENCES: &str = "preferences";
pub const LABEL_OVERLAY: &str = "overlay";
pub const LABEL_THUMBNAIL: &str = "thumbnail";
pub const LABEL_SCROLL_HUD: &str = "scroll-hud";

pub fn prewarm_overlay(app: &AppHandle) {
    // On macOS the capture overlay is 100% native AppKit/CoreAnimation (NSPanel + CALayer),
    // so we never spawn or keep an idle WKWebView process for captures.
    #[cfg(target_os = "macos")]
    {
        let _ = app;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if app.get_webview_window(LABEL_OVERLAY).is_some() {
            return;
        }
        let builder = WebviewWindowBuilder::new(
            app,
            LABEL_OVERLAY,
            WebviewUrl::App("index.html?window=overlay".into()),
        )
        .title("Gaze Capture")
        .inner_size(100.0, 100.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .focused(false)
        .content_protected(true)
        .background_throttling(BackgroundThrottlingPolicy::Disabled);

        let _ = builder.build();
    }
}

/// Safety net for windows created with `visible(false)` that reveal themselves once painted:
/// if JS ever fails to call `reveal_window` within 1.5s, reveal the window so it never stalls.
fn schedule_reveal_fallback(app: &AppHandle, label: String, focus: bool) {
    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if let Some(win) = app_clone.get_webview_window(&label) {
            if !win.is_visible().unwrap_or(true) {
                let _ = win.show();
                if focus {
                    let _ = win.set_focus();
                }
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn is_overlay_visible(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL_OVERLAY)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

pub fn open_preferences(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL_PREFERENCES) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(
        app,
        LABEL_PREFERENCES,
        WebviewUrl::App("index.html?window=preferences".into()),
    )
    .title("Preferences")
    .inner_size(500.0, 504.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(true)
    .center();

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to open Preferences window: {e}"))?;
    Ok(())
}

pub fn open_editor(
    app: &AppHandle,
    capture_id: &str,
    img_width: u32,
    img_height: u32,
    scale_factor: f32,
    monitor_bounds: Option<MonitorBounds>,
) -> Result<(), String> {
    let label = format!("editor-{}", &capture_id[..8.min(capture_id.len())]);
    let sf = scale_factor.max(1.0) as f64;
    let logical_w = (img_width as f64) / sf;
    let logical_h = (img_height as f64) / sf;

    // Determine safe usable dimensions on the captured monitor so the top toolbar never overflows off-screen.
    #[cfg(target_os = "macos")]
    let (mon_x, mon_y, mon_w, mon_h) = match monitor_bounds {
        Some(b) => (b.x as f64, b.y as f64, b.width as f64, b.height as f64),
        None => (0.0, 0.0, 1440.0, 900.0),
    };

    #[cfg(not(target_os = "macos"))]
    let (mon_x, mon_y, mon_w, mon_h) = match monitor_bounds {
        Some(b) => (
            b.x as f64 / sf,
            b.y as f64 / sf,
            b.width as f64 / sf,
            b.height as f64 / sf,
        ),
        None => (0.0, 0.0, 1440.0, 900.0),
    };

    let max_w = (mon_w - 80.0).clamp(820.0, 1340.0);
    let max_h = (mon_h - 110.0).clamp(480.0, 860.0);
    let min_w = 820.0_f64.min(max_w);

    let win_w = (logical_w + 180.0).clamp(min_w, max_w);
    let win_h = (logical_h + 150.0).clamp(480.0, max_h);

    let url = format!("index.html?window=editor&id={capture_id}");
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("Gaze")
        .inner_size(win_w, win_h)
        .min_inner_size(min_w, 440.0)
        .resizable(true)
        .visible(false);

    if monitor_bounds.is_some() {
        let pos_x = mon_x + ((mon_w - win_w) * 0.5).max(20.0);
        // Keep top edge safely below the macOS menu bar / notch (>= 48pt).
        let pos_y = mon_y + ((mon_h - win_h) * 0.5).max(48.0);
        builder = builder.position(pos_x, pos_y);
    } else {
        builder = builder.center();
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to open Editor window: {e}"))?;
    schedule_reveal_fallback(app, label, true);
    Ok(())
}

/// Creates (hidden) the transparent, display-sized webview that hosts the in-place editor
/// on top of the frozen native capture overlay. No-op if it already exists.
pub fn ensure_inplace_editor(
    app: &AppHandle,
    label: &str,
    bounds: MonitorBounds,
) -> Result<(), String> {
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App("index.html?window=inplace".into()),
    )
    .title("Gaze Edit")
    .position(bounds.x as f64, bounds.y as f64)
    .inner_size(bounds.width as f64, bounds.height as f64)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .content_protected(true)
    // Export after hiding must keep running at full speed.
    .background_throttling(BackgroundThrottlingPolicy::Disabled)
    .build()
    .map_err(|e| format!("Failed to create in-place editor: {e}"))?;
    Ok(())
}

/// Opens or reuses the pre-warmed capture overlay window (non-macOS).
#[cfg(not(target_os = "macos"))]
pub fn open_overlay(app: &AppHandle, info: &OverlaySessionInfo) -> Result<bool, String> {
    if let Some(existing) = app.get_webview_window(LABEL_OVERLAY) {
        // On Windows with mixed-DPI multi-monitor setups, physical pixel coords avoid scaling drift.
        let _ = existing.set_size(PhysicalSize::new(info.monitor_width, info.monitor_height));
        let _ = existing.set_position(PhysicalPosition::new(info.monitor_x, info.monitor_y));

        // Notify pre-warmed overlay webview to paint the new snapshot first, then show itself
        // so there is zero stale-frame flash.
        let _ = app.emit_to(LABEL_OVERLAY, "overlay-session-ready", info);
        return Ok(true);
    }

    let s = info.scale_factor.max(1.0) as f64;
    let (wx, wy, ww, wh) = (
        info.monitor_x as f64 / s,
        info.monitor_y as f64 / s,
        info.monitor_width as f64 / s,
        info.monitor_height as f64 / s,
    );

    let win = WebviewWindowBuilder::new(
        app,
        LABEL_OVERLAY,
        WebviewUrl::App("index.html?window=overlay".into()),
    )
    .title("Gaze Capture")
    .position(wx, wy)
    .inner_size(ww, wh)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .content_protected(true)
    .background_throttling(BackgroundThrottlingPolicy::Disabled)
    .build()
    .map_err(|e| format!("Failed to open capture overlay: {e}"))?;

    let _ = win.set_size(PhysicalSize::new(info.monitor_width, info.monitor_height));
    let _ = win.set_position(PhysicalPosition::new(info.monitor_x, info.monitor_y));

    Ok(false)
}

pub fn close_overlay(app: &AppHandle, seq: u64) {
    #[cfg(target_os = "macos")]
    {
        let _ = seq;
        crate::macos_overlay::dismiss_native_overlay(app, true);
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(win) = app.get_webview_window(LABEL_OVERLAY) {
            let _ = win.hide();
            let _ = app.emit_to(LABEL_OVERLAY, "overlay-hidden", seq);
        }
    }
}

pub fn open_pin(
    app: &AppHandle,
    capture_id: &str,
    img_width: u32,
    img_height: u32,
    scale_factor: f32,
) -> Result<(), String> {
    let short = &capture_id[..8.min(capture_id.len())];
    let label = format!(
        "pin-{short}-{}",
        chrono::Local::now().timestamp_millis() % 10000
    );
    let logical_w = ((img_width as f64) / (scale_factor.max(1.0) as f64)).clamp(120.0, 960.0);
    let logical_h = ((img_height as f64) / (scale_factor.max(1.0) as f64)).clamp(90.0, 720.0);
    let url = format!("index.html?window=pin&id={capture_id}");

    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("Pinned Screenshot")
        .inner_size(logical_w, logical_h)
        .min_inner_size(80.0, 60.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(true)
        .resizable(true)
        .visible(false)
        .center()
        .build()
        .map_err(|e| format!("Failed to open Pin window: {e}"))?;
    schedule_reveal_fallback(app, label, true);
    Ok(())
}

pub fn open_thumbnail(
    app: &AppHandle,
    capture_id: &str,
    monitor_bounds: Option<MonitorBounds>,
    #[allow(unused_variables)] scale_factor: f32,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(LABEL_THUMBNAIL) {
        let _ = existing.destroy();
    }

    let (px, py) = if let Some(b) = monitor_bounds {
        #[cfg(target_os = "macos")]
        {
            (
                b.x as f64 + (b.width as f64 - 310.0).max(20.0),
                b.y as f64 + (b.height as f64 - 242.0).max(56.0),
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            let s = scale_factor.max(1.0) as f64;
            (
                (b.x as f64 + b.width as f64) / s - 310.0,
                (b.y as f64 + b.height as f64) / s - 242.0,
            )
        }
    } else if let Ok(Some(mon)) = app.primary_monitor() {
        let scale = mon.scale_factor();
        let w = mon.size().width as f64 / scale;
        let h = mon.size().height as f64 / scale;
        ((w - 310.0).max(20.0), (h - 242.0).max(56.0))
    } else {
        (960.0, 620.0)
    };

    let url = format!("index.html?window=thumbnail&id={capture_id}");
    WebviewWindowBuilder::new(app, LABEL_THUMBNAIL, WebviewUrl::App(url.into()))
        .title("Gaze Preview")
        .inner_size(290.0, 202.0)
        .position(px, py)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|e| format!("Failed to open Thumbnail preview: {e}"))?;
    schedule_reveal_fallback(app, LABEL_THUMBNAIL.to_string(), false);
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub struct ScrollHudRect {
    /// Global monitor coordinates (logical points on macOS, physical pixels on Windows).
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

// The HUD needs both the monitor and the capture region in one call; splitting the
// geometry into a struct would only move the same numbers around.
#[allow(clippy::too_many_arguments)]
pub fn open_scroll_hud(
    app: &AppHandle,
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
    region_x: u32,
    region_y: u32,
    region_w: u32,
    region_h: u32,
    #[allow(unused_variables)] scale_factor: f32,
) -> Result<ScrollHudRect, String> {
    if let Some(existing) = app.get_webview_window(LABEL_SCROLL_HUD) {
        let _ = existing.destroy();
    }

    #[cfg(target_os = "macos")]
    let (mx, my, mw, mh, rx, ry, rw, rh, scale) = (
        monitor_x as f64,
        monitor_y as f64,
        monitor_width as f64,
        monitor_height as f64,
        region_x as f64,
        region_y as f64,
        region_w as f64,
        region_h as f64,
        1.0f64,
    );

    #[cfg(not(target_os = "macos"))]
    let (mx, my, mw, mh, rx, ry, rw, rh, scale) = {
        let s = scale_factor.max(1.0) as f64;
        (
            monitor_x as f64 / s,
            monitor_y as f64 / s,
            monitor_width as f64 / s,
            monitor_height as f64 / s,
            region_x as f64 / s,
            region_y as f64 / s,
            region_w as f64 / s,
            region_h as f64 / s,
            s,
        )
    };

    let hud_w = 360.0;
    let hud_h = 56.0;
    let gap = 14.0;
    let top_safe = 44.0;
    let bottom_safe = 16.0;

    // Prefer placing the HUD outside the capture region so it never obstructs scrolling
    // or competes for pointer events (and mark it content_protected so it never appears in frames).
    let centered_x =
        (mx + rx + (rw - hud_w) * 0.5).clamp(mx + 12.0, mx + (mw - hud_w - 12.0).max(12.0));
    let (x, y) = if ry >= top_safe + hud_h + gap {
        (centered_x, my + ry - hud_h - gap)
    } else if ry + rh + gap + hud_h + bottom_safe <= mh {
        (centered_x, my + ry + rh + gap)
    } else if rx + rw + gap + hud_w + 12.0 <= mw {
        (
            mx + rx + rw + gap,
            my + (ry + (rh - hud_h) * 0.5).clamp(top_safe, mh - hud_h - bottom_safe),
        )
    } else if rx >= hud_w + gap + 12.0 {
        (
            mx + rx - hud_w - gap,
            my + (ry + (rh - hud_h) * 0.5).clamp(top_safe, mh - hud_h - bottom_safe),
        )
    } else {
        // Fullscreen-ish selection: place safely below menu bar & notch.
        (mx + (mw - hud_w) * 0.5, my + 56.0)
    };

    WebviewWindowBuilder::new(
        app,
        LABEL_SCROLL_HUD,
        WebviewUrl::App("index.html?window=scroll-hud".into()),
    )
    .title("Scrolling Capture")
    .inner_size(hud_w, hud_h)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .resizable(false)
    .focused(false)
    .content_protected(true)
    .build()
    .map_err(|e| format!("Failed to open Scroll HUD: {e}"))?;

    Ok(ScrollHudRect {
        x: (x * scale).round() as i32,
        y: (y * scale).round() as i32,
        width: (hud_w * scale).round() as u32,
        height: (hud_h * scale).round() as u32,
    })
}

pub fn close_scroll_hud(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL_SCROLL_HUD) {
        let _ = win.destroy();
    }
}
