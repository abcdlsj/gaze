use crate::capture::{MonitorBounds, OverlaySessionInfo};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, PhysicalSize};

pub const LABEL_PREFERENCES: &str = "preferences";
pub const LABEL_OVERLAY: &str = "overlay";
pub const LABEL_THUMBNAIL: &str = "thumbnail";
pub const LABEL_SCROLL_HUD: &str = "scroll-hud";

pub fn prewarm_overlay(app: &AppHandle) {
    if app.get_webview_window(LABEL_OVERLAY).is_some() {
        return;
    }
    let _ = WebviewWindowBuilder::new(
        app,
        LABEL_OVERLAY,
        WebviewUrl::App("index.html?window=overlay".into()),
    )
    .title("Shotter Capture")
    .inner_size(100.0, 100.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .build();
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
    .inner_size(536.0, 686.0)
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
        .title("Shotter")
        .inner_size(win_w, win_h)
        .min_inner_size(min_w, 440.0)
        .resizable(true);

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

    let win = builder
        .build()
        .map_err(|e| format!("Failed to open Editor window: {e}"))?;
    let _ = win.set_focus();
    Ok(())
}

pub fn open_overlay(app: &AppHandle, info: &OverlaySessionInfo) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(LABEL_OVERLAY) {
        #[cfg(target_os = "macos")]
        {
            let _ = existing.set_size(LogicalSize::new(
                info.monitor_width as f64,
                info.monitor_height as f64,
            ));
            let _ = existing.set_position(LogicalPosition::new(
                info.monitor_x as f64,
                info.monitor_y as f64,
            ));
        }

        // On Windows with mixed-DPI multi-monitor setups, physical pixel coords avoid scaling drift.
        #[cfg(not(target_os = "macos"))]
        {
            let _ = existing.set_size(PhysicalSize::new(info.monitor_width, info.monitor_height));
            let _ = existing.set_position(PhysicalPosition::new(info.monitor_x, info.monitor_y));
        }

        // Notify pre-warmed overlay webview to paint the new snapshot first, then show itself
        // so there is zero stale-frame flash.
        let _ = existing.emit("overlay-session-ready", info);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    let (wx, wy, ww, wh) = (
        info.monitor_x as f64,
        info.monitor_y as f64,
        info.monitor_width as f64,
        info.monitor_height as f64,
    );

    #[cfg(not(target_os = "macos"))]
    let (wx, wy, ww, wh) = {
        let s = info.scale_factor.max(1.0) as f64;
        (
            info.monitor_x as f64 / s,
            info.monitor_y as f64 / s,
            info.monitor_width as f64 / s,
            info.monitor_height as f64 / s,
        )
    };

    let win = WebviewWindowBuilder::new(
        app,
        LABEL_OVERLAY,
        WebviewUrl::App("index.html?window=overlay".into()),
    )
    .title("Shotter Capture")
    .position(wx, wy)
    .inner_size(ww, wh)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(true)
    .build()
    .map_err(|e| format!("Failed to open capture overlay: {e}"))?;

    #[cfg(not(target_os = "macos"))]
    {
        let _ = win.set_size(PhysicalSize::new(info.monitor_width, info.monitor_height));
        let _ = win.set_position(PhysicalPosition::new(info.monitor_x, info.monitor_y));
    }

    let _ = win.set_focus();
    Ok(())
}

pub fn close_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL_OVERLAY) {
        let _ = win.hide();
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

    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("Pinned Screenshot")
        .inner_size(logical_w, logical_h)
        .min_inner_size(80.0, 60.0)
        .decorations(false)
        .always_on_top(true)
        .shadow(true)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("Failed to open Pin window: {e}"))?;
    let _ = win.set_focus();
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
                b.x as f64 + (b.width as f64 - 304.0).max(20.0),
                b.y as f64 + (b.height as f64 - 236.0).max(56.0),
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            let s = scale_factor.max(1.0) as f64;
            (
                (b.x as f64 + b.width as f64) / s - 304.0,
                (b.y as f64 + b.height as f64) / s - 236.0,
            )
        }
    } else if let Ok(Some(mon)) = app.primary_monitor() {
        let scale = mon.scale_factor();
        let w = mon.size().width as f64 / scale;
        let h = mon.size().height as f64 / scale;
        ((w - 304.0).max(20.0), (h - 236.0).max(56.0))
    } else {
        (960.0, 620.0)
    };

    let url = format!("index.html?window=thumbnail&id={capture_id}");
    WebviewWindowBuilder::new(app, LABEL_THUMBNAIL, WebviewUrl::App(url.into()))
        .title("Shotter Preview")
        .inner_size(284.0, 196.0)
        .position(px, py)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .resizable(false)
        .build()
        .map_err(|e| format!("Failed to open Thumbnail preview: {e}"))?;
    Ok(())
}

pub fn open_scroll_hud(
    app: &AppHandle,
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    #[allow(unused_variables)] scale_factor: f32,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(LABEL_SCROLL_HUD) {
        let _ = existing.destroy();
    }

    #[cfg(target_os = "macos")]
    let (mx, my, mw) = (monitor_x as f64, monitor_y as f64, monitor_width as f64);

    #[cfg(not(target_os = "macos"))]
    let (mx, my, mw) = {
        let s = scale_factor.max(1.0) as f64;
        (monitor_x as f64 / s, monitor_y as f64 / s, monitor_width as f64 / s)
    };

    let hud_w = 360.0;
    let hud_h = 56.0;
    let x = mx + (mw - hud_w) * 0.5;
    // Place safely below the macOS menu bar & notch.
    let y = my + 56.0;

    WebviewWindowBuilder::new(
        app,
        LABEL_SCROLL_HUD,
        WebviewUrl::App("index.html?window=scroll-hud".into()),
    )
    .title("Scrolling Capture")
    .inner_size(hud_w, hud_h)
    .position(x, y)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .resizable(false)
    .focused(false)
    .build()
    .map_err(|e| format!("Failed to open Scroll HUD: {e}"))?;
    Ok(())
}

pub fn close_scroll_hud(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL_SCROLL_HUD) {
        let _ = win.destroy();
    }
}
