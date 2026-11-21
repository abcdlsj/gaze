use crate::settings::{AppSettings, SaveFormat, WindowBackground};
use chrono::Local;
use image::{
    codecs::jpeg::JpegEncoder, codecs::png::PngEncoder, imageops, ColorType, ImageEncoder, Rgba,
    RgbaImage,
};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use xcap::{Monitor, Window};

#[derive(Debug, Clone, Serialize)]
pub struct WindowRect {
    pub id: u32,
    pub app_name: String,
    pub title: String,
    /// Coordinates relative to the captured monitor origin (logical points on macOS, px on Windows).
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureMeta {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub source: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct MonitorBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub struct StoredCapture {
    pub id: String,
    pub image: RgbaImage,
    pub scale_factor: f32,
    pub source: String,
    pub monitor_bounds: Option<MonitorBounds>,
}

impl StoredCapture {
    pub fn meta(&self) -> CaptureMeta {
        CaptureMeta {
            id: self.id.clone(),
            width: self.image.width(),
            height: self.image.height(),
            scale_factor: self.scale_factor,
            source: self.source.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct OverlaySession {
    pub monitor_id: u32,
    pub monitor_name: String,
    pub monitor_index: usize,
    pub monitor_count: usize,
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub monitor_width: u32,
    pub monitor_height: u32,
    pub scale_factor: f32,
    pub image: RgbaImage,
    pub windows: Vec<WindowRect>,
    pub initial_mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OverlaySessionInfo {
    pub monitor_id: u32,
    pub monitor_name: String,
    pub monitor_index: usize,
    pub monitor_count: usize,
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub monitor_width: u32,
    pub monitor_height: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub scale_factor: f32,
    pub windows: Vec<WindowRect>,
    pub initial_mode: String,
}

impl OverlaySession {
    pub fn info(&self) -> OverlaySessionInfo {
        OverlaySessionInfo {
            monitor_id: self.monitor_id,
            monitor_name: self.monitor_name.clone(),
            monitor_index: self.monitor_index,
            monitor_count: self.monitor_count,
            monitor_x: self.monitor_x,
            monitor_y: self.monitor_y,
            monitor_width: self.monitor_width,
            monitor_height: self.monitor_height,
            image_width: self.image.width(),
            image_height: self.image.height(),
            scale_factor: self.scale_factor,
            windows: self.windows.clone(),
            initial_mode: self.initial_mode.clone(),
        }
    }

    pub fn bounds(&self) -> MonitorBounds {
        MonitorBounds {
            x: self.monitor_x,
            y: self.monitor_y,
            width: self.monitor_width,
            height: self.monitor_height,
        }
    }
}

#[derive(Default)]
pub struct CaptureStore {
    captures: HashMap<String, StoredCapture>,
    order: Vec<String>,
    pub overlay: Option<OverlaySession>,
}

impl CaptureStore {
    const MAX_CAPTURES: usize = 24;

    pub fn insert(
        &mut self,
        image: RgbaImage,
        scale_factor: f32,
        source: &str,
        monitor_bounds: Option<MonitorBounds>,
    ) -> CaptureMeta {
        let id = Uuid::new_v4().to_string();
        let stored = StoredCapture {
            id: id.clone(),
            image,
            scale_factor: if scale_factor > 0.0 { scale_factor } else { 1.0 },
            source: source.to_string(),
            monitor_bounds,
        };
        let meta = stored.meta();
        self.captures.insert(id.clone(), stored);
        self.order.push(id);
        while self.order.len() > Self::MAX_CAPTURES {
            let oldest = self.order.remove(0);
            self.captures.remove(&oldest);
        }
        meta
    }

    pub fn get(&self, id: &str) -> Option<&StoredCapture> {
        self.captures.get(id)
    }

    pub fn update_image(&mut self, id: &str, image: RgbaImage) -> Option<CaptureMeta> {
        let entry = self.captures.get_mut(id)?;
        entry.image = image;
        Some(entry.meta())
    }
}

/// Returns the current global cursor position in the exact coordinate space used by `xcap::Monitor`
/// (Quartz global logical points on macOS; Win32 virtual screen physical pixels on Windows).
#[cfg(target_os = "macos")]
pub fn get_cursor_position() -> Option<(i32, i32)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let pt = event.location();
    Some((pt.x.round() as i32, pt.y.round() as i32))
}

#[cfg(not(target_os = "macos"))]
pub fn get_cursor_position() -> Option<(i32, i32)> {
    use enigo::{Enigo, Mouse, Settings};
    let enigo = Enigo::new(&Settings::default()).ok()?;
    enigo.location().ok()
}

pub fn find_active_monitor() -> Result<(Monitor, usize, usize), String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    let total = monitors.len();
    if total == 0 {
        return Err("No monitors detected".to_string());
    }

    if let Some((cx, cy)) = get_cursor_position() {
        // Explicit bounds hit-test works cleanly with negative coordinates & stacked/mixed-DPI displays.
        for (idx, m) in monitors.iter().enumerate() {
            if let (Ok(mx), Ok(my), Ok(mw), Ok(mh)) = (m.x(), m.y(), m.width(), m.height()) {
                if cx >= mx && cx < mx + (mw as i32) && cy >= my && cy < my + (mh as i32) {
                    return Ok((m.clone(), idx, total));
                }
            }
        }
        if let Ok(m) = Monitor::from_point(cx, cy) {
            let id = m.id().ok();
            let idx = monitors
                .iter()
                .position(|cand| cand.id().ok() == id)
                .unwrap_or(0);
            return Ok((m, idx, total));
        }
    }

    if let Some((idx, primary)) = monitors
        .iter()
        .enumerate()
        .find(|(_, m)| m.is_primary().unwrap_or(false))
    {
        return Ok((primary.clone(), idx, total));
    }
    Ok((monitors[0].clone(), 0, total))
}

pub fn find_monitor_by_index(target_index: usize) -> Result<(Monitor, usize, usize), String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    let total = monitors.len();
    if total == 0 {
        return Err("No monitors detected".to_string());
    }
    let idx = target_index % total;
    Ok((monitors[idx].clone(), idx, total))
}

pub fn find_monitor_by_id(monitor_id: u32) -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    monitors
        .into_iter()
        .find(|m| m.id().ok() == Some(monitor_id))
        .ok_or_else(|| format!("Monitor {monitor_id} not found"))
}

pub fn capture_overlay_session(
    initial_mode: &str,
    monitor_index_override: Option<usize>,
) -> Result<OverlaySession, String> {
    let (monitor, monitor_index, monitor_count) = match monitor_index_override {
        Some(idx) => find_monitor_by_index(idx)?,
        None => find_active_monitor()?,
    };
    let monitor_id = monitor.id().map_err(|e| e.to_string())?;
    let monitor_name = monitor
        .friendly_name()
        .or_else(|_| monitor.name())
        .unwrap_or_else(|_| format!("Display {}", monitor_index + 1));
    let monitor_x = monitor.x().map_err(|e| e.to_string())?;
    let monitor_y = monitor.y().map_err(|e| e.to_string())?;
    let monitor_width = monitor.width().map_err(|e| e.to_string())?;
    let monitor_height = monitor.height().map_err(|e| e.to_string())?;
    let scale_factor = monitor.scale_factor().unwrap_or(1.0).max(1.0);

    let image = monitor
        .capture_image()
        .map_err(|e| format!("Screen capture failed (check Screen Recording permission): {e}"))?;

    // Only enumerate OS windows immediately when starting in Window mode; otherwise load lazily
    // so Area / Scrolling capture (F1) has zero extra latency.
    let windows = if initial_mode == "window" {
        enumerate_monitor_windows(monitor_x, monitor_y, monitor_width, monitor_height)
    } else {
        Vec::new()
    };

    Ok(OverlaySession {
        monitor_id,
        monitor_name,
        monitor_index,
        monitor_count,
        monitor_x,
        monitor_y,
        monitor_width,
        monitor_height,
        scale_factor,
        image,
        windows,
        initial_mode: initial_mode.to_string(),
    })
}

pub fn enumerate_monitor_windows(
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) -> Vec<WindowRect> {
    let mut windows = Vec::new();
    if let Ok(all_windows) = Window::all() {
        for win in all_windows {
            if win.is_minimized().unwrap_or(false) {
                continue;
            }
            let app_name = win.app_name().unwrap_or_default();
            if app_name.eq_ignore_ascii_case("gaze")
                || app_name.eq_ignore_ascii_case("window server")
                || app_name.eq_ignore_ascii_case("dock")
                || app_name.eq_ignore_ascii_case("control center")
            {
                continue;
            }
            let w = win.width().unwrap_or(0);
            let h = win.height().unwrap_or(0);
            if w < 32 || h < 32 {
                continue;
            }
            let wx = win.x().unwrap_or(0) - monitor_x;
            let wy = win.y().unwrap_or(0) - monitor_y;
            if wx + (w as i32) <= 0
                || wy + (h as i32) <= 0
                || wx >= monitor_width as i32
                || wy >= monitor_height as i32
            {
                continue;
            }
            let id = match win.id() {
                Ok(id) => id,
                Err(_) => continue,
            };
            windows.push(WindowRect {
                id,
                app_name,
                title: win.title().unwrap_or_default(),
                x: wx,
                y: wy,
                width: w,
                height: h,
            });
        }
    }
    windows
}

/// Packs an RGBA image into a zero-compression binary buffer:
/// `[width: u32 LE][height: u32 LE][raw RGBA bytes...]` for instant IPC canvas rendering.
pub fn pack_raw_rgba(img: &RgbaImage) -> Vec<u8> {
    let raw = img.as_raw();
    let mut out = Vec::with_capacity(8 + raw.len());
    out.extend_from_slice(&img.width().to_le_bytes());
    out.extend_from_slice(&img.height().to_le_bytes());
    out.extend_from_slice(raw);
    out
}

pub fn capture_fullscreen() -> Result<(RgbaImage, f32, MonitorBounds), String> {
    let (monitor, _, _) = find_active_monitor()?;
    let scale = monitor.scale_factor().unwrap_or(1.0).max(1.0);
    let bounds = MonitorBounds {
        x: monitor.x().unwrap_or(0),
        y: monitor.y().unwrap_or(0),
        width: monitor.width().unwrap_or(1440),
        height: monitor.height().unwrap_or(900),
    };
    let image = monitor
        .capture_image()
        .map_err(|e| format!("Fullscreen capture failed: {e}"))?;
    Ok((image, scale, bounds))
}

/// Crops a region given in monitor-relative coordinates from a frozen OverlaySession.
pub fn crop_from_session(
    session: &OverlaySession,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<RgbaImage, String> {
    if width < 2.0 || height < 2.0 {
        return Err("Selection is too small".to_string());
    }
    let rx = session.image.width() as f64 / (session.monitor_width.max(1) as f64);
    let ry = session.image.height() as f64 / (session.monitor_height.max(1) as f64);

    let px = (x * rx).round().clamp(0.0, (session.image.width() - 1) as f64) as u32;
    let py = (y * ry).round().clamp(0.0, (session.image.height() - 1) as f64) as u32;
    let pw = ((width * rx).round() as u32).clamp(1, session.image.width() - px);
    let ph = ((height * ry).round() as u32).clamp(1, session.image.height() - py);

    Ok(imageops::crop_imm(&session.image, px, py, pw, ph).to_image())
}

pub fn capture_window_with_background(
    window_id: u32,
    settings: &AppSettings,
    session_opt: Option<&OverlaySession>,
) -> Result<(RgbaImage, f32), String> {
    let all_windows = Window::all().map_err(|e| format!("Failed to enumerate windows: {e}"))?;
    let win = all_windows
        .into_iter()
        .find(|w| w.id().ok() == Some(window_id))
        .ok_or_else(|| format!("Window {window_id} no longer exists"))?;

    let scale = win
        .current_monitor()
        .ok()
        .and_then(|m| m.scale_factor().ok())
        .unwrap_or(1.0)
        .max(1.0);

    let raw_img = win
        .capture_image()
        .map_err(|e| format!("Failed to capture window: {e}"))?;

    let processed = apply_window_background(
        raw_img,
        settings.window_background,
        &settings.solid_background_color,
        scale,
        session_opt,
        win.x().ok(),
        win.y().ok(),
    );

    Ok((processed, scale))
}

pub fn apply_window_background(
    img: RgbaImage,
    mode: WindowBackground,
    solid_hex: &str,
    scale: f32,
    session_opt: Option<&OverlaySession>,
    win_x: Option<i32>,
    win_y: Option<i32>,
) -> RgbaImage {
    match mode {
        WindowBackground::Transparent => img,
        WindowBackground::TrimShadow => trim_transparent_shadow(&img),
        WindowBackground::SolidColor => {
            let trimmed = trim_transparent_shadow(&img);
            let bg = parse_hex_color(solid_hex).unwrap_or(Rgba([44, 48, 54, 255]));
            composite_with_padding(&trimmed, (28.0 * scale).round() as u32, |_, _, _, _| bg)
        }
        WindowBackground::Wallpaper => {
            let trimmed = trim_transparent_shadow(&img);
            let pad = (28.0 * scale).round() as u32;
            // Try using the frozen desktop backdrop behind the window if available, else a crisp scenic gradient.
            if let (Some(session), Some(wx), Some(wy)) = (session_opt, win_x, win_y) {
                let rx = session.image.width() as f32 / session.monitor_width.max(1) as f32;
                let ry = session.image.height() as f32 / session.monitor_height.max(1) as f32;
                let bx = (((wx - session.monitor_x) as f32 * rx).round() as i32) - pad as i32;
                let by = (((wy - session.monitor_y) as f32 * ry).round() as i32) - pad as i32;
                let out_w = trimmed.width() + pad * 2;
                let out_h = trimmed.height() + pad * 2;
                if bx >= 0
                    && by >= 0
                    && (bx as u32) + out_w <= session.image.width()
                    && (by as u32) + out_h <= session.image.height()
                {
                    let mut canvas =
                        imageops::crop_imm(&session.image, bx as u32, by as u32, out_w, out_h)
                            .to_image();
                    imageops::overlay(&mut canvas, &trimmed, pad as i64, pad as i64);
                    return canvas;
                }
            }
            composite_with_padding(&trimmed, pad, |x, y, w, h| {
                let u = x as f32 / w.max(1) as f32;
                let v = y as f32 / h.max(1) as f32;
                let r = (36.0 + 30.0 * u + 44.0 * v).clamp(0.0, 255.0) as u8;
                let g = (118.0 + 78.0 * (1.0 - v) + 22.0 * u).clamp(0.0, 255.0) as u8;
                let b = (92.0 + 120.0 * u + 30.0 * v).clamp(0.0, 255.0) as u8;
                Rgba([r, g, b, 255])
            })
        }
    }
}

fn composite_with_padding<F>(fg: &RgbaImage, pad: u32, bg_fn: F) -> RgbaImage
where
    F: Fn(u32, u32, u32, u32) -> Rgba<u8>,
{
    let w = fg.width() + pad * 2;
    let h = fg.height() + pad * 2;
    let mut out = RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            out.put_pixel(x, y, bg_fn(x, y, w, h));
        }
    }
    imageops::overlay(&mut out, fg, pad as i64, pad as i64);
    out
}

/// Trims outer semi-transparent drop-shadow margins from a captured OS window.
pub fn trim_transparent_shadow(img: &RgbaImage) -> RgbaImage {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return img.clone();
    }
    // Pixels with alpha >= 210 belong to the actual window body rather than soft shadow halo.
    const ALPHA_THRESHOLD: u8 = 210;
    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0u32;
    let mut max_y = 0u32;

    for y in 0..h {
        for x in 0..w {
            if img.get_pixel(x, y)[3] >= ALPHA_THRESHOLD {
                if x < min_x {
                    min_x = x;
                }
                if y < min_y {
                    min_y = y;
                }
                if x > max_x {
                    max_x = x;
                }
                if y > max_y {
                    max_y = y;
                }
            }
        }
    }

    if min_x > max_x || min_y > max_y {
        return img.clone();
    }
    imageops::crop_imm(img, min_x, min_y, max_x - min_x + 1, max_y - min_y + 1).to_image()
}

pub fn parse_hex_color(hex: &str) -> Option<Rgba<u8>> {
    let clean = hex.trim().trim_start_matches('#');
    if clean.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&clean[0..2], 16).ok()?;
    let g = u8::from_str_radix(&clean[2..4], 16).ok()?;
    let b = u8::from_str_radix(&clean[4..6], 16).ok()?;
    Some(Rgba([r, g, b, 255]))
}

pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let encoder = PngEncoder::new(&mut buf);
    encoder
        .write_image(img.as_raw(), img.width(), img.height(), ColorType::Rgba8.into())
        .map_err(|e| format!("PNG encode failed: {e}"))?;
    Ok(buf)
}

fn encode_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
    let mut buf = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    encoder
        .encode(rgb.as_raw(), rgb.width(), rgb.height(), ColorType::Rgb8.into())
        .map_err(|e| format!("JPEG encode failed: {e}"))?;
    Ok(buf)
}

fn has_transparency(img: &RgbaImage) -> bool {
    // Sample every 4th pixel for fast transparency detection.
    let raw = img.as_raw();
    let mut i = 3;
    while i < raw.len() {
        if raw[i] < 252 {
            return true;
        }
        i += 16;
    }
    false
}

pub fn encode_for_save(
    img: &RgbaImage,
    scale_factor: f32,
    format: SaveFormat,
    downscale_1x: bool,
) -> Result<(Vec<u8>, &'static str), String> {
    let working = if downscale_1x && scale_factor > 1.05 {
        let nw = ((img.width() as f32) / scale_factor).round().max(1.0) as u32;
        let nh = ((img.height() as f32) / scale_factor).round().max(1.0) as u32;
        imageops::resize(img, nw, nh, imageops::FilterType::Lanczos3)
    } else {
        img.clone()
    };

    match format {
        SaveFormat::Png => Ok((encode_png(&working)?, "png")),
        SaveFormat::Auto => {
            let png = encode_png(&working)?;
            let pixel_count = (working.width() as u64) * (working.height() as u64);
            if has_transparency(&working) || pixel_count < 250_000 {
                return Ok((png, "png"));
            }
            let jpg = encode_jpeg(&working, 90)?;
            // Pick JPEG only when it meaningfully shrinks file size (photographic content).
            if jpg.len() * 10 < png.len() * 6 {
                Ok((jpg, "jpg"))
            } else {
                Ok((png, "png"))
            }
        }
    }
}

pub fn save_image_file(
    img: &RgbaImage,
    scale_factor: f32,
    settings: &AppSettings,
    explicit_path: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(path) = explicit_path {
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        let bytes = match ext.as_deref() {
            Some("jpg") | Some("jpeg") => {
                let working = if settings.resize_retina_1x && scale_factor > 1.05 {
                    let nw = ((img.width() as f32) / scale_factor).round().max(1.0) as u32;
                    let nh = ((img.height() as f32) / scale_factor).round().max(1.0) as u32;
                    imageops::resize(img, nw, nh, imageops::FilterType::Lanczos3)
                } else {
                    img.clone()
                };
                encode_jpeg(&working, 92)?
            }
            _ => encode_for_save(img, scale_factor, SaveFormat::Png, settings.resize_retina_1x)?.0,
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create folder: {e}"))?;
        }
        fs::write(path, bytes).map_err(|e| format!("Failed to save file: {e}"))?;
        return Ok(path.to_path_buf());
    }

    let (bytes, ext) = encode_for_save(
        img,
        scale_factor,
        settings.save_format,
        settings.resize_retina_1x,
    )?;
    let folder = PathBuf::from(&settings.screenshots_folder);
    fs::create_dir_all(&folder).map_err(|e| format!("Failed to create screenshots folder: {e}"))?;
    let stamp = Local::now().format("%Y-%m-%d_%H-%M-%S-%3f");
    let file_path = folder.join(format!("Gaze_{stamp}.{ext}"));
    fs::write(&file_path, bytes).map_err(|e| format!("Failed to save screenshot: {e}"))?;
    Ok(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_shadow_crops_soft_border() {
        let mut img = RgbaImage::from_pixel(40, 30, Rgba([0, 0, 0, 40]));
        for y in 6..24 {
            for x in 8..32 {
                img.put_pixel(x, y, Rgba([240, 240, 245, 255]));
            }
        }
        let trimmed = trim_transparent_shadow(&img);
        assert_eq!(trimmed.dimensions(), (24, 18));
    }

    #[test]
    fn retina_downscale_halves_dimensions() {
        let img = RgbaImage::from_pixel(200, 100, Rgba([10, 20, 30, 255]));
        let (bytes, ext) = encode_for_save(&img, 2.0, SaveFormat::Png, true).unwrap();
        assert_eq!(ext, "png");
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), 100);
        assert_eq!(decoded.height(), 50);
    }

    #[test]
    fn parse_hex_works() {
        assert_eq!(parse_hex_color("#2C3036"), Some(Rgba([0x2c, 0x30, 0x36, 255])));
        assert_eq!(parse_hex_color("invalid"), None);
    }
}
