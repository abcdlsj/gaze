use crate::capture;
use crate::stitcher::{detect_upward_shift, quick_frame_diff, StitchOutcome, VerticalStitcher};
use crate::{finalize_capture, windows, AppState};
use image::RgbaImage;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use xcap::Monitor;

#[derive(Debug, Clone, Serialize)]
pub struct ScrollProgressEvent {
    pub frames: u32,
    pub height: u32,
    pub max_height: u32,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct ScrollingController {
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

impl ScrollingController {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn request_stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn begin(&self) -> Option<(Arc<AtomicBool>, Arc<AtomicBool>)> {
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return None;
        }
        self.cancel.store(false, Ordering::SeqCst);
        Some((self.cancel.clone(), self.running.clone()))
    }
}

/// Platform-native scroll & pointer driver.
/// On macOS we use CoreGraphics `CGEvent` directly with `ScrollEventUnit::PIXEL` (smooth,
/// predictable pixel scrolling without HID wheel acceleration) plus `ScrollEventUnit::LINE`
/// fallback for apps that ignore continuous pixel wheel events.
#[cfg(target_os = "macos")]
mod driver {
    use crate::permissions;
    use core_graphics::display::{CGDisplay, CGPoint};
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, ScrollEventUnit,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
        fn CGAssociateMouseAndMouseCursorPosition(connected: bool) -> i32;
    }

    /// Returns true if the user is pressing Escape (works even when our HUD is unfocused).
    pub fn is_escape_pressed() -> bool {
        // kCGEventSourceStateCombinedSessionState = 0, kVK_Escape = 0x35 (53)
        unsafe { CGEventSourceKeyState(0, 0x35) }
    }

    pub struct ScrollDriver {
        source: CGEventSource,
    }

    impl ScrollDriver {
        pub fn new() -> Result<Self, String> {
            if !permissions::check_permissions().accessibility {
                return Err("Accessibility permission required".to_string());
            }
            let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
                .map_err(|_| "Failed to initialize CoreGraphics event source".to_string())?;
            Ok(Self { source })
        }

        pub fn move_pointer(&mut self, x: i32, y: i32) -> Result<(), String> {
            let pt = CGPoint::new(x as f64, y as f64);
            if let Ok(ev) = CGEvent::new_mouse_event(
                self.source.clone(),
                CGEventType::MouseMoved,
                pt,
                CGMouseButton::Left,
            ) {
                ev.set_flags(CGEventFlags::CGEventFlagNull);
                ev.post(CGEventTapLocation::HID);
            }
            std::thread::sleep(Duration::from_millis(12));
            // Verify cursor actually moved; if macOS ignored synthetic MouseMoved, warp cleanly.
            if let Some((cx, cy)) = crate::capture::get_cursor_position() {
                if (cx - x).abs() > 8 || (cy - y).abs() > 8 {
                    let _ = CGDisplay::warp_mouse_cursor_position(pt);
                    unsafe {
                        CGAssociateMouseAndMouseCursorPosition(true);
                    }
                }
            }
            Ok(())
        }

        /// Scrolls vertically at the current cursor position inside the capture region.
        /// `downward_pt > 0` scrolls DOWN (toward bottom of document); `< 0` scrolls UP.
        pub fn scroll_vertical(
            &mut self,
            downward_pt: f32,
            use_line_mode: bool,
            cancel: &AtomicBool,
        ) -> Result<(), String> {
            if use_line_mode {
                let sign = if downward_pt >= 0.0 { -1 } else { 1 };
                let lines = ((downward_pt.abs() / 38.0).round() as i32).clamp(1, 8);
                // Split into small 1-2 line ticks so macOS wheel acceleration doesn't launch the page.
                let mut remaining = lines;
                while remaining > 0 {
                    if cancel.load(Ordering::SeqCst) || is_escape_pressed() {
                        cancel.store(true, Ordering::SeqCst);
                        return Ok(());
                    }
                    let chunk = remaining.min(2);
                    let ev = CGEvent::new_scroll_event(
                        self.source.clone(),
                        ScrollEventUnit::LINE,
                        1,
                        sign * chunk,
                        0,
                        0,
                    )
                    .map_err(|_| "Failed to create CoreGraphics line scroll event".to_string())?;
                    ev.set_flags(CGEventFlags::CGEventFlagNull);
                    ev.post(CGEventTapLocation::HID);
                    remaining -= chunk;
                    if remaining > 0 {
                        std::thread::sleep(Duration::from_millis(18));
                    }
                }
                return Ok(());
            }

            // Smooth pixel scroll in small increments (24-28px per tick): avoids momentum/acceleration
            // spikes and works accurately across browsers, Electron apps, and native AppKit views.
            let total_px = downward_pt.abs().round() as i32;
            if total_px == 0 {
                return Ok(());
            }
            let sign = if downward_pt >= 0.0 { -1 } else { 1 };
            let chunk_size = 28;
            let mut remaining = total_px;

            while remaining > 0 {
                if cancel.load(Ordering::SeqCst) || is_escape_pressed() {
                    cancel.store(true, Ordering::SeqCst);
                    return Ok(());
                }
                let step = remaining.min(chunk_size);
                let ev = CGEvent::new_scroll_event(
                    self.source.clone(),
                    ScrollEventUnit::PIXEL,
                    1,
                    sign * step,
                    0,
                    0,
                )
                .map_err(|_| "Failed to create CoreGraphics pixel scroll event".to_string())?;
                ev.set_flags(CGEventFlags::CGEventFlagNull);
                ev.post(CGEventTapLocation::HID);
                remaining -= step;
                if remaining > 0 {
                    std::thread::sleep(Duration::from_millis(8));
                }
            }
            Ok(())
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod driver {
    use enigo::{Axis, Coordinate, Enigo, Mouse, Settings as EnigoSettings};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    pub fn is_escape_pressed() -> bool {
        false
    }

    pub struct ScrollDriver {
        enigo: Enigo,
    }

    impl ScrollDriver {
        pub fn new() -> Result<Self, String> {
            let enigo = Enigo::new(&EnigoSettings::default())
                .map_err(|e| format!("Scroll simulation unavailable: {e}"))?;
            Ok(Self { enigo })
        }

        pub fn move_pointer(&mut self, x: i32, y: i32) -> Result<(), String> {
            self.enigo
                .move_mouse(x, y, Coordinate::Abs)
                .map_err(|e| format!("Failed to move mouse: {e}"))
        }

        pub fn scroll_vertical(
            &mut self,
            downward_pt: f32,
            _use_line_mode: bool,
            cancel: &AtomicBool,
        ) -> Result<(), String> {
            let sign = if downward_pt >= 0.0 { 1 } else { -1 };
            let ticks = ((downward_pt.abs() / 48.0).round() as i32).clamp(1, 8);
            for i in 0..ticks {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(());
                }
                self.enigo
                    .scroll(sign, Axis::Vertical)
                    .map_err(|e| format!("Failed to send scroll event: {e}"))?;
                if i + 1 < ticks {
                    std::thread::sleep(Duration::from_millis(16));
                }
            }
            Ok(())
        }
    }
}

pub fn start_scrolling_capture(
    app: AppHandle,
    state: Arc<AppState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if width < 32.0 || height < 48.0 {
        return Err("Select a larger scrollable region (at least 32×48)".to_string());
    }

    let (monitor_id, monitor_x, monitor_y, monitor_w, monitor_h, scale_factor) = {
        let store = state.store.lock();
        let session = store
            .overlay
            .as_ref()
            .ok_or_else(|| "No active overlay session".to_string())?;
        (
            session.monitor_id,
            session.monitor_x,
            session.monitor_y,
            session.monitor_width,
            session.monitor_height,
            session.scale_factor,
        )
    };

    let Some((cancel_flag, running_flag)) = state.scrolling.begin() else {
        return Err("Scrolling capture is already running".to_string());
    };

    let seq = state.overlay_seq.load(Ordering::SeqCst);
    windows::close_overlay(&app, seq);
    state.store.lock().overlay = None;

    let settings = state.settings.lock().clone();
    let max_height = settings.scrolling_max_height;
    let speed = settings.scrolling_speed;

    // Clamp region cleanly to monitor bounds (in xcap monitor coordinates).
    let rx = (x.round().max(0.0) as u32).min(monitor_w.saturating_sub(2));
    let ry = (y.round().max(0.0) as u32).min(monitor_h.saturating_sub(2));
    let rw = (width.round().max(32.0) as u32).min(monitor_w - rx);
    let rh = (height.round().max(48.0) as u32).min(monitor_h - ry);

    let hud_rect = windows::open_scroll_hud(
        &app,
        monitor_x,
        monitor_y,
        monitor_w,
        monitor_h,
        rx,
        ry,
        rw,
        rh,
        scale_factor,
    )
    .ok();

    let region_abs_x = monitor_x + rx as i32;
    let region_abs_y = monitor_y + ry as i32;
    let (scroll_x, scroll_y) = choose_scroll_anchor(region_abs_x, region_abs_y, rw, rh, hud_rect);

    std::thread::spawn(move || {
        struct RunningGuard(Arc<AtomicBool>);
        impl Drop for RunningGuard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = RunningGuard(running_flag);

        // Give the overlay window time to unmap completely and focus to settle.
        if sleep_interruptible(250, &cancel_flag) {
            windows::close_scroll_hud(&app);
            return;
        }

        let monitor = match capture::find_monitor_by_id(monitor_id) {
            Ok(m) => m,
            Err(e) => {
                report_error_and_close_hud(&app, max_height, 0, e, &cancel_flag);
                return;
            }
        };

        let first_frame = match monitor.capture_region(rx, ry, rw, rh) {
            Ok(img) => img,
            Err(e) => {
                report_error_and_close_hud(
                    &app,
                    max_height,
                    0,
                    format!("Capture failed: {e}"),
                    &cancel_flag,
                );
                return;
            }
        };

        let frame_h = first_frame.height().max(1);
        let eff_scale = (frame_h as f32 / rh.max(1) as f32).clamp(1.0, 4.0);
        let frame_pt_h = (frame_h as f32 / eff_scale).max(48.0);

        let mut stitcher = VerticalStitcher::new(first_frame, max_height);
        emit_progress(
            &app,
            stitcher.frame_count(),
            stitcher.current_height(),
            max_height,
            "capturing",
            None,
        );

        let mut scroll_driver = match driver::ScrollDriver::new() {
            Ok(d) => d,
            Err(e) => {
                report_error_and_close_hud(
                    &app,
                    max_height,
                    stitcher.current_height(),
                    e,
                    &cancel_flag,
                );
                #[cfg(target_os = "macos")]
                {
                    let _ = windows::open_preferences(&app);
                }
                return;
            }
        };

        let _ = scroll_driver.move_pointer(scroll_x, scroll_y);
        if sleep_interruptible(70, &cancel_flag) {
            finish_and_present(
                &app,
                &state,
                stitcher,
                max_height,
                scale_factor,
                monitor_x,
                monitor_y,
                monitor_w,
                monitor_h,
            );
            return;
        }

        // Map speed (1..=100) to settle wait (258ms -> 80ms) and target scroll ratio (32% -> 55%).
        let base_settle_ms = 260u64.saturating_sub(((speed as u64) * 180) / 100);
        let target_ratio = 0.32 + ((speed as f32) * 0.23) / 100.0;
        let base_step_pt = (frame_pt_h * target_ratio).clamp(48.0, 560.0);

        let mut direction: f32 = 1.0;
        let mut use_line_mode = cfg!(not(target_os = "macos"));
        let mut direction_confirmed = false;
        let mut step_scale: f32 = 1.0;
        let mut no_move_streak: u32 = 0;
        let mut unmatched_streak: u32 = 0;

        const MAX_FRAMES: u32 = 300;

        while !is_stopped(&cancel_flag) && stitcher.frame_count() < MAX_FRAMES {
            // Respect the user moving the cursor onto the HUD to click Stop instead of yanking it back.
            if let Some((cx, cy)) = capture::get_cursor_position() {
                if let Some(hud) = hud_rect {
                    if point_in_rect(
                        cx,
                        cy,
                        hud.x - 10,
                        hud.y - 10,
                        hud.width + 20,
                        hud.height + 20,
                    ) {
                        sleep_interruptible(90, &cancel_flag);
                        continue;
                    }
                }
                if !point_in_rect(cx, cy, region_abs_x, region_abs_y, rw, rh) {
                    let _ = scroll_driver.move_pointer(scroll_x, scroll_y);
                    if sleep_interruptible(30, &cancel_flag) {
                        break;
                    }
                }
            }

            let cur_step_pt =
                (base_step_pt * step_scale).clamp(24.0, (frame_pt_h * 0.72).max(48.0));

            if scroll_driver
                .scroll_vertical(cur_step_pt * direction, use_line_mode, &cancel_flag)
                .is_err()
            {
                break;
            }

            if is_stopped(&cancel_flag) {
                break;
            }

            let Some(next_frame) = capture_settled_frame(
                &monitor,
                rx,
                ry,
                rw,
                rh,
                base_settle_ms,
                55,
                5,
                &cancel_flag,
            ) else {
                break;
            };

            let candidate_backup = if !direction_confirmed {
                Some(next_frame.clone())
            } else {
                None
            };

            match stitcher.push_frame(next_frame) {
                StitchOutcome::Appended {
                    delta_y,
                    total_height,
                } => {
                    direction_confirmed = true;
                    no_move_streak = 0;
                    unmatched_streak = 0;

                    // Dynamically keep each scroll step inside the sweet spot (~30%..60% of frame height).
                    let actual_ratio = delta_y as f32 / frame_h as f32;
                    if actual_ratio > 0.015 {
                        if actual_ratio < target_ratio * 0.45 {
                            step_scale = (step_scale * 1.35).min(3.5);
                        } else if actual_ratio > 0.65 {
                            step_scale = (step_scale * 0.62).max(0.25);
                        } else if actual_ratio > target_ratio * 1.25 {
                            step_scale = (step_scale * 0.85).max(0.25);
                        }
                    }

                    emit_progress(
                        &app,
                        stitcher.frame_count(),
                        total_height,
                        max_height,
                        "capturing",
                        None,
                    );
                }

                StitchOutcome::ReachedMaxHeight { total_height } => {
                    emit_progress(
                        &app,
                        stitcher.frame_count(),
                        total_height,
                        max_height,
                        "finishing",
                        Some("Reached max height".to_string()),
                    );
                    break;
                }

                StitchOutcome::NoMovement => {
                    if !direction_confirmed {
                        // First step produced zero movement:
                        // 1) Try LINE scroll mode (some apps ignore continuous PIXEL wheel events).
                        // 2) Try opposite scroll direction (e.g. inverted scroll utility at top of page).
                        // 3) Try opposite direction + LINE mode.
                        no_move_streak += 1;
                        #[cfg(target_os = "macos")]
                        match no_move_streak {
                            1 => {
                                use_line_mode = true;
                                continue;
                            }
                            2 => {
                                direction = -direction;
                                use_line_mode = false;
                                continue;
                            }
                            3 => {
                                use_line_mode = true;
                                continue;
                            }
                            _ => {
                                emit_progress(
                                    &app,
                                    stitcher.frame_count(),
                                    stitcher.current_height(),
                                    max_height,
                                    "finishing",
                                    Some("Cannot scroll further".to_string()),
                                );
                                break;
                            }
                        }
                        #[cfg(not(target_os = "macos"))]
                        match no_move_streak {
                            1 => {
                                direction = -direction;
                                continue;
                            }
                            _ => {
                                emit_progress(
                                    &app,
                                    stitcher.frame_count(),
                                    stitcher.current_height(),
                                    max_height,
                                    "finishing",
                                    Some("Cannot scroll further".to_string()),
                                );
                                break;
                            }
                        }
                    } else {
                        // Already scrolling downward: confirm we truly cannot scroll any further
                        // before stopping (retry with stronger step, then line-scroll fallback).
                        no_move_streak += 1;
                        if no_move_streak == 1 {
                            step_scale = (step_scale * 1.5).min(3.5);
                            if sleep_interruptible(160, &cancel_flag) {
                                break;
                            }
                            continue;
                        }
                        #[cfg(target_os = "macos")]
                        if no_move_streak == 2 && !use_line_mode {
                            // One last probe with LINE scroll in case app stopped reacting to PIXEL near bottom.
                            let _ = scroll_driver.scroll_vertical(
                                cur_step_pt * direction,
                                true,
                                &cancel_flag,
                            );
                            if let Some(probe_frame) = capture_settled_frame(
                                &monitor,
                                rx,
                                ry,
                                rw,
                                rh,
                                base_settle_ms + 120,
                                55,
                                4,
                                &cancel_flag,
                            ) {
                                match stitcher.push_frame(probe_frame) {
                                    StitchOutcome::Appended { total_height, .. } => {
                                        no_move_streak = 0;
                                        unmatched_streak = 0;
                                        emit_progress(
                                            &app,
                                            stitcher.frame_count(),
                                            total_height,
                                            max_height,
                                            "capturing",
                                            None,
                                        );
                                        continue;
                                    }
                                    StitchOutcome::ReachedMaxHeight { total_height } => {
                                        emit_progress(
                                            &app,
                                            stitcher.frame_count(),
                                            total_height,
                                            max_height,
                                            "finishing",
                                            Some("Reached max height".to_string()),
                                        );
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        emit_progress(
                            &app,
                            stitcher.frame_count(),
                            stitcher.current_height(),
                            max_height,
                            "finishing",
                            Some("Reached bottom".to_string()),
                        );
                        break;
                    }
                }

                StitchOutcome::Unmatched => {
                    // On the first move, check if content actually scrolled UPWARD (inverted scroll sign).
                    if !direction_confirmed {
                        if let Some(ref candidate) = candidate_backup {
                            if let Some(up_px) =
                                detect_upward_shift(stitcher.last_frame(), candidate)
                            {
                                direction = -direction;
                                direction_confirmed = true;
                                let return_pt = (up_px as f32 / eff_scale) + (base_step_pt * 0.85);
                                let _ = scroll_driver.scroll_vertical(
                                    return_pt * direction,
                                    use_line_mode,
                                    &cancel_flag,
                                );
                                sleep_interruptible(base_settle_ms + 80, &cancel_flag);
                                continue;
                            }
                        }
                    }

                    unmatched_streak += 1;
                    if unmatched_streak <= 2 {
                        // Overshoot / mid-render recovery:
                        // Scroll BACK UP by ~55% of the last step and halve step_scale so overlap returns.
                        let _ = scroll_driver.scroll_vertical(
                            -cur_step_pt * 0.55 * direction,
                            use_line_mode,
                            &cancel_flag,
                        );
                        step_scale = (step_scale * 0.5).max(0.25);

                        if let Some(recovered) = capture_settled_frame(
                            &monitor,
                            rx,
                            ry,
                            rw,
                            rh,
                            base_settle_ms + 100,
                            55,
                            4,
                            &cancel_flag,
                        ) {
                            match stitcher.push_frame(recovered) {
                                StitchOutcome::Appended { total_height, .. } => {
                                    direction_confirmed = true;
                                    no_move_streak = 0;
                                    unmatched_streak = 0;
                                    emit_progress(
                                        &app,
                                        stitcher.frame_count(),
                                        total_height,
                                        max_height,
                                        "capturing",
                                        None,
                                    );
                                    continue;
                                }
                                StitchOutcome::ReachedMaxHeight { total_height } => {
                                    emit_progress(
                                        &app,
                                        stitcher.frame_count(),
                                        total_height,
                                        max_height,
                                        "finishing",
                                        Some("Reached max height".to_string()),
                                    );
                                    break;
                                }
                                _ => {}
                            }
                        }
                    } else {
                        break;
                    }
                }
            }
        }

        finish_and_present(
            &app,
            &state,
            stitcher,
            max_height,
            scale_factor,
            monitor_x,
            monitor_y,
            monitor_w,
            monitor_h,
        );
    });

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn finish_and_present(
    app: &AppHandle,
    state: &Arc<AppState>,
    stitcher: VerticalStitcher,
    max_height: u32,
    scale_factor: f32,
    monitor_x: i32,
    monitor_y: i32,
    monitor_w: u32,
    monitor_h: u32,
) {
    let frames = stitcher.frame_count();
    let final_image = stitcher.finish();
    emit_progress(app, frames, final_image.height(), max_height, "done", None);
    windows::close_scroll_hud(app);

    let meta = state.store.lock().insert(
        final_image,
        scale_factor,
        "scrolling",
        Some(capture::MonitorBounds {
            x: monitor_x,
            y: monitor_y,
            width: monitor_w,
            height: monitor_h,
        }),
    );
    let _ = finalize_capture(app, state, &meta, false);
}

fn report_error_and_close_hud(
    app: &AppHandle,
    max_height: u32,
    height: u32,
    message: String,
    cancel: &AtomicBool,
) {
    emit_progress(app, 0, height, max_height, "error", Some(message));
    sleep_interruptible(2600, cancel);
    windows::close_scroll_hud(app);
}

/// Waits for smooth-scroll animation to finish by checking whether two successive captures
/// have settled before handing the frame to the stitcher.
#[allow(clippy::too_many_arguments)]
fn capture_settled_frame(
    monitor: &Monitor,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
    base_settle_ms: u64,
    check_interval_ms: u64,
    max_checks: u32,
    cancel: &AtomicBool,
) -> Option<RgbaImage> {
    if sleep_interruptible(base_settle_ms, cancel) {
        return None;
    }

    let mut current = monitor.capture_region(rx, ry, rw, rh).ok()?;
    for _ in 0..max_checks {
        if sleep_interruptible(check_interval_ms, cancel) {
            return Some(current);
        }
        let next = match monitor.capture_region(rx, ry, rw, rh) {
            Ok(img) => img,
            Err(_) => return Some(current),
        };
        if quick_frame_diff(&current, &next) <= 1.2 {
            return Some(next);
        }
        current = next;
    }
    Some(current)
}

/// Picks a cursor anchor inside the capture region (slightly right of center to avoid narrow
/// left sidebars, and guaranteed not to sit underneath the Scroll HUD).
fn choose_scroll_anchor(
    region_x: i32,
    region_y: i32,
    rw: u32,
    rh: u32,
    hud: Option<windows::ScrollHudRect>,
) -> (i32, i32) {
    let default_x = region_x + ((rw * 55) / 100) as i32;
    let default_y = region_y + (rh / 2) as i32;

    let Some(h) = hud else {
        return (default_x, default_y);
    };

    let overlaps_hud =
        |px: i32, py: i32| point_in_rect(px, py, h.x - 8, h.y - 8, h.width + 16, h.height + 16);

    if !overlaps_hud(default_x, default_y) {
        return (default_x, default_y);
    }

    // Try lower-center, then upper-center, then center-left/right inside region.
    let candidates = [
        (default_x, region_y + ((rh * 3) / 4) as i32),
        (default_x, region_y + (rh / 4) as i32),
        (region_x + (rw / 3) as i32, default_y),
        (region_x + ((rw * 3) / 4) as i32, default_y),
    ];
    for (cx, cy) in candidates {
        if !overlaps_hud(cx, cy) {
            return (cx, cy);
        }
    }
    (default_x, default_y)
}

fn point_in_rect(px: i32, py: i32, rx: i32, ry: i32, rw: u32, rh: u32) -> bool {
    px >= rx && px < rx + rw as i32 && py >= ry && py < ry + rh as i32
}

fn is_stopped(cancel: &AtomicBool) -> bool {
    if cancel.load(Ordering::SeqCst) {
        return true;
    }
    if driver::is_escape_pressed() {
        cancel.store(true, Ordering::SeqCst);
        return true;
    }
    false
}

fn sleep_interruptible(ms: u64, cancel: &AtomicBool) -> bool {
    let mut elapsed = 0u64;
    while elapsed < ms {
        if is_stopped(cancel) {
            return true;
        }
        let step = (ms - elapsed).min(20);
        std::thread::sleep(Duration::from_millis(step));
        elapsed += step;
    }
    is_stopped(cancel)
}

fn emit_progress(
    app: &AppHandle,
    frames: u32,
    height: u32,
    max_height: u32,
    status: &str,
    message: Option<String>,
) {
    let payload = ScrollProgressEvent {
        frames,
        height,
        max_height,
        status: status.to_string(),
        message,
    };
    let _ = app.emit("scroll-progress", payload);
}
