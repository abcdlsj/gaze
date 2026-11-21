use crate::capture;
use crate::stitcher::{detect_upward_shift, StitchOutcome, VerticalStitcher};
use crate::{finalize_capture, windows, AppState};
use enigo::{Axis, Coordinate, Enigo, Mouse, Settings as EnigoSettings};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

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

    windows::close_overlay(&app);
    state.store.lock().overlay = None;

    let _ = windows::open_scroll_hud(&app, monitor_x, monitor_y, monitor_w, scale_factor);

    let settings = state.settings.lock().clone();
    let max_height = settings.scrolling_max_height;
    let speed = settings.scrolling_speed;

    // Clamp region cleanly to monitor bounds (in xcap monitor coordinates).
    let rx = (x.round().max(0.0) as u32).min(monitor_w.saturating_sub(2));
    let ry = (y.round().max(0.0) as u32).min(monitor_h.saturating_sub(2));
    let rw = (width.round().max(32.0) as u32).min(monitor_w - rx);
    let rh = (height.round().max(48.0) as u32).min(monitor_h - ry);

    // Center point inside the capture region where mouse wheel events will be sent.
    let abs_center_x = monitor_x + (rx + rw / 2) as i32;
    let abs_center_y = monitor_y + (ry + rh / 2) as i32;

    std::thread::spawn(move || {
        struct RunningGuard(Arc<AtomicBool>);
        impl Drop for RunningGuard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = RunningGuard(running_flag);

        // Give the overlay window a brief moment to vanish completely.
        sleep_interruptible(200, &cancel_flag);

        let monitor = match capture::find_monitor_by_id(monitor_id) {
            Ok(m) => m,
            Err(e) => {
                emit_progress(&app, 0, 0, max_height, "error", Some(e));
                windows::close_scroll_hud(&app);
                return;
            }
        };

        let first_frame = match monitor.capture_region(rx, ry, rw, rh) {
            Ok(img) => img,
            Err(e) => {
                emit_progress(
                    &app,
                    0,
                    0,
                    max_height,
                    "error",
                    Some(format!("Capture failed: {e}")),
                );
                windows::close_scroll_hud(&app);
                return;
            }
        };

        let mut stitcher = VerticalStitcher::new(first_frame, max_height);
        emit_progress(
            &app,
            stitcher.frame_count(),
            stitcher.current_height(),
            max_height,
            "capturing",
            None,
        );

        let mut enigo = match Enigo::new(&EnigoSettings::default()) {
            Ok(e) => e,
            Err(e) => {
                emit_progress(
                    &app,
                    1,
                    stitcher.current_height(),
                    max_height,
                    "error",
                    Some(format!(
                        "Scroll simulation unavailable (check Accessibility permission): {e}"
                    )),
                );
                windows::close_scroll_hud(&app);
                return;
            }
        };

        let _ = enigo.move_mouse(abs_center_x, abs_center_y, Coordinate::Abs);
        sleep_interruptible(60, &cancel_flag);

        // Speed (1..=100) maps to settle delay (420ms -> 130ms) and wheel lines (3 -> 8).
        let settle_ms = 420u64.saturating_sub(((speed as u64) * 290) / 100);
        let wheel_lines: i32 = 3 + ((speed as i32) * 5) / 100;
        let mut direction: i32 = 1;
        let mut static_streak: u32 = 0;
        let mut unmatched_streak: u32 = 0;
        let mut checked_direction = false;

        const MAX_FRAMES: u32 = 180;

        while !cancel_flag.load(Ordering::SeqCst) && stitcher.frame_count() < MAX_FRAMES {
            // Keep pointer inside scrollable region before scrolling.
            let _ = enigo.move_mouse(abs_center_x, abs_center_y, Coordinate::Abs);
            if enigo.scroll(wheel_lines * direction, Axis::Vertical).is_err() {
                break;
            }

            if sleep_interruptible(settle_ms, &cancel_flag) {
                break;
            }

            let next_frame = match monitor.capture_region(rx, ry, rw, rh) {
                Ok(img) => img,
                Err(_) => break,
            };

            let prev_snapshot = if !checked_direction {
                Some(next_frame.clone())
            } else {
                None
            };

            match stitcher.push_frame(next_frame) {
                StitchOutcome::Appended { total_height, .. } => {
                    checked_direction = true;
                    static_streak = 0;
                    unmatched_streak = 0;
                    emit_progress(
                        &app,
                        stitcher.frame_count(),
                        total_height,
                        max_height,
                        "capturing",
                        None,
                    );
                }
                StitchOutcome::NoMovement => {
                    static_streak += 1;
                    if static_streak >= 2 {
                        break;
                    }
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
                StitchOutcome::Unmatched => {
                    // On the very first step, check if scrolling moved upward (inverted natural scroll).
                    if !checked_direction {
                        checked_direction = true;
                        if let Some(ref candidate) = prev_snapshot {
                            if detect_upward_shift(stitcher.last_frame(), candidate).is_some() {
                                direction = -direction;
                                // Scroll back down past start to continue cleanly.
                                let _ = enigo.scroll(wheel_lines * direction * 2, Axis::Vertical);
                                sleep_interruptible(settle_ms, &cancel_flag);
                                continue;
                            }
                        }
                    }
                    unmatched_streak += 1;
                    if unmatched_streak >= 3 {
                        break;
                    }
                }
            }
        }

        let final_image = stitcher.finish();
        emit_progress(
            &app,
            0,
            final_image.height(),
            max_height,
            "done",
            None,
        );
        windows::close_scroll_hud(&app);

        let meta = state.store.lock().insert(final_image, scale_factor, "scrolling");
        let _ = finalize_capture(&app, &state, &meta, false);
    });

    Ok(())
}

fn sleep_interruptible(ms: u64, cancel: &AtomicBool) -> bool {
    let mut elapsed = 0u64;
    while elapsed < ms {
        if cancel.load(Ordering::SeqCst) {
            return true;
        }
        let step = (ms - elapsed).min(25);
        std::thread::sleep(Duration::from_millis(step));
        elapsed += step;
    }
    cancel.load(Ordering::SeqCst)
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
