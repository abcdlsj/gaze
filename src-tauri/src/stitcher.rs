use image::{imageops, RgbaImage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StitchOutcome {
    /// Successfully stitched `delta_y` new vertical pixels.
    Appended { delta_y: u32, total_height: u32 },
    /// Frame was effectively identical to the previous frame (reached scroll end).
    NoMovement,
    /// Reached configured maximum output height.
    ReachedMaxHeight { total_height: u32 },
    /// Could not confidently align the two frames (e.g., scrolled too fast past overlap).
    Unmatched,
}

pub struct VerticalStitcher {
    width: u32,
    frame_height: u32,
    max_height: u32,
    /// Raw RGBA buffer of accumulated rows up to the moving content bottom (excluding sticky footer).
    body_rows: Vec<u8>,
    body_height: u32,
    /// Sticky footer rows (kept from the latest frame and appended once on finish).
    footer_rows: Vec<u8>,
    footer_height: u32,
    last_frame: RgbaImage,
    frames: u32,
}

impl VerticalStitcher {
    pub fn new(first_frame: RgbaImage, max_height: u32) -> Self {
        let width = first_frame.width();
        let frame_height = first_frame.height();
        let clamped_max = max_height.max(frame_height);
        let body_rows = first_frame.as_raw().clone();
        Self {
            width,
            frame_height,
            max_height: clamped_max,
            body_rows,
            body_height: frame_height,
            footer_rows: Vec::new(),
            footer_height: 0,
            last_frame: first_frame,
            frames: 1,
        }
    }

    pub fn frame_count(&self) -> u32 {
        self.frames
    }

    pub fn current_height(&self) -> u32 {
        (self.body_height + self.footer_height).min(self.max_height)
    }

    pub fn last_frame(&self) -> &RgbaImage {
        &self.last_frame
    }

    /// Attempts to stitch `next` (scrolled downward from `last_frame`).
    pub fn push_frame(&mut self, next: RgbaImage) -> StitchOutcome {
        if next.width() != self.width || next.height() != self.frame_height {
            return StitchOutcome::Unmatched;
        }
        if self.current_height() >= self.max_height {
            return StitchOutcome::ReachedMaxHeight {
                total_height: self.current_height(),
            };
        }

        let (x_start, x_end, x_step) = active_x_range(self.width);
        let (top_static, bottom_static) =
            detect_static_margins(&self.last_frame, &next, x_start, x_end, x_step);

        // If almost the entire frame didn't move, we've reached the end of scroll.
        if top_static + bottom_static + 16 >= self.frame_height {
            return StitchOutcome::NoMovement;
        }

        // Guard against misidentifying blank margins as sticky headers/footers: cap each at 30%.
        let max_margin = (self.frame_height as f32 * 0.30) as u32;
        let scroll_top = top_static.min(max_margin);
        let scroll_bottom = self.frame_height - bottom_static.min(max_margin);
        let interior_h = scroll_bottom.saturating_sub(scroll_top);
        if interior_h < 32 {
            return StitchOutcome::NoMovement;
        }

        let Some(delta_y) = find_downward_shift(
            &self.last_frame,
            &next,
            scroll_top,
            scroll_bottom,
            x_start,
            x_end,
            x_step,
        ) else {
            return StitchOutcome::Unmatched;
        };

        if delta_y == 0 {
            return StitchOutcome::NoMovement;
        }

        // On the first stitched transition where a sticky footer is present, separate the footer
        // from the body so the footer is only rendered once at the very end.
        let detected_footer = self.frame_height - scroll_bottom;
        let stride = (self.width as usize) * 4;

        if self.frames == 1 && detected_footer > 0 && detected_footer < self.body_height {
            let keep_h = self.body_height - detected_footer;
            let split_byte = (keep_h as usize) * stride;
            self.footer_rows = self.body_rows.split_off(split_byte);
            self.body_height = keep_h;
            self.footer_height = detected_footer;
        } else if self.footer_height > 0 {
            // Keep latest footer pixels in case footer updated slightly.
            let start_y = (self.frame_height - self.footer_height) as usize;
            self.footer_rows = next.as_raw()[start_y * stride..].to_vec();
        }

        // Copy only the newly revealed rows above the footer.
        let content_bottom = self.frame_height - self.footer_height;
        let new_start = content_bottom.saturating_sub(delta_y);
        let available_new = content_bottom.saturating_sub(new_start);
        let remaining_budget = self
            .max_height
            .saturating_sub(self.body_height + self.footer_height);
        let to_append = available_new.min(remaining_budget);

        if to_append > 0 {
            let byte_start = (new_start as usize) * stride;
            let byte_end = ((new_start + to_append) as usize) * stride;
            self.body_rows
                .extend_from_slice(&next.as_raw()[byte_start..byte_end]);
            self.body_height += to_append;
        }

        self.last_frame = next;
        self.frames += 1;

        let total = self.current_height();
        if total >= self.max_height {
            StitchOutcome::ReachedMaxHeight {
                total_height: total,
            }
        } else {
            StitchOutcome::Appended {
                delta_y: to_append,
                total_height: total,
            }
        }
    }

    /// Consumes the stitcher and returns the final stitched RGBA image.
    pub fn finish(mut self) -> RgbaImage {
        let mut raw = self.body_rows;
        if !self.footer_rows.is_empty() {
            raw.extend_from_slice(&self.footer_rows);
            self.body_height += self.footer_height;
        }
        let final_h = self.body_height.min(self.max_height);
        let expected_len = (self.width as usize) * (final_h as usize) * 4;
        raw.truncate(expected_len);
        RgbaImage::from_raw(self.width, final_h, raw).unwrap_or_else(|| {
            imageops::crop_imm(
                &self.last_frame,
                0,
                0,
                self.width,
                self.frame_height.min(self.max_height),
            )
            .to_image()
        })
    }
}

/// Checks if `next` actually moved UPWARD relative to `prev` (which happens if OS natural scroll
/// direction was inverted relative to our initial scroll sign).
pub fn detect_upward_shift(prev: &RgbaImage, next: &RgbaImage) -> Option<u32> {
    if prev.width() != next.width() || prev.height() != next.height() {
        return None;
    }
    let (x_start, x_end, x_step) = active_x_range(prev.width());
    let (top_static, bottom_static) = detect_static_margins(prev, next, x_start, x_end, x_step);
    let h = prev.height();
    let max_margin = (h as f32 * 0.30) as u32;
    let scroll_top = top_static.min(max_margin);
    let scroll_bottom = h - bottom_static.min(max_margin);
    if scroll_bottom.saturating_sub(scroll_top) < 32 {
        return None;
    }
    // Upward movement from prev -> next is identical to downward movement from next -> prev.
    find_downward_shift(next, prev, scroll_top, scroll_bottom, x_start, x_end, x_step)
}

fn active_x_range(width: u32) -> (u32, u32, u32) {
    // Exclude rightmost scrollbar margin (~5% or min 24px when wide enough).
    let left_pad = if width > 80 { width / 40 } else { 0 };
    let right_pad = if width > 120 {
        (width / 20).max(24).min(width / 4)
    } else {
        0
    };
    let x_start = left_pad;
    let x_end = width.saturating_sub(right_pad).max(x_start + 1);
    let span = x_end - x_start;
    let x_step = if span > 1200 {
        4
    } else if span > 500 {
        2
    } else {
        1
    };
    (x_start, x_end, x_step)
}

fn row_mad(a: &RgbaImage, y_a: u32, b: &RgbaImage, y_b: u32, x_start: u32, x_end: u32, x_step: u32) -> f32 {
    let raw_a = a.as_raw();
    let raw_b = b.as_raw();
    let stride = (a.width() as usize) * 4;
    let off_a = (y_a as usize) * stride;
    let off_b = (y_b as usize) * stride;

    let mut sum: u64 = 0;
    let mut count: u64 = 0;
    let mut x = x_start;
    while x < x_end {
        let idx_a = off_a + (x as usize) * 4;
        let idx_b = off_b + (x as usize) * 4;
        sum += (raw_a[idx_a].abs_diff(raw_b[idx_b]) as u64)
            + (raw_a[idx_a + 1].abs_diff(raw_b[idx_b + 1]) as u64)
            + (raw_a[idx_a + 2].abs_diff(raw_b[idx_b + 2]) as u64);
        count += 3;
        x += x_step;
    }
    if count == 0 {
        return 0.0;
    }
    (sum as f32) / (count as f32)
}

fn detect_static_margins(
    prev: &RgbaImage,
    next: &RgbaImage,
    x_start: u32,
    x_end: u32,
    x_step: u32,
) -> (u32, u32) {
    let h = prev.height();
    const STATIC_ROW_EPS: f32 = 2.0;

    let mut top = 0u32;
    while top < h && row_mad(prev, top, next, top, x_start, x_end, x_step) <= STATIC_ROW_EPS {
        top += 1;
    }

    let mut bottom = 0u32;
    while bottom < h.saturating_sub(top)
        && row_mad(
            prev,
            h - 1 - bottom,
            next,
            h - 1 - bottom,
            x_start,
            x_end,
            x_step,
        ) <= STATIC_ROW_EPS
    {
        bottom += 1;
    }

    (top, bottom)
}

/// Measures visual detail (edge energy) of a horizontal band so we pick feature-rich template bands
/// instead of uniform solid background strips.
fn band_detail_score(
    img: &RgbaImage,
    y_start: u32,
    band_h: u32,
    x_start: u32,
    x_end: u32,
    x_step: u32,
) -> f32 {
    let raw = img.as_raw();
    let stride = (img.width() as usize) * 4;
    let mut energy: u64 = 0;
    let mut samples: u64 = 0;

    let y_step = (band_h / 12).max(1);
    let mut y = y_start;
    while y + 1 < y_start + band_h {
        let off = (y as usize) * stride;
        let off_next = ((y + 1) as usize) * stride;
        let mut x = x_start;
        while x + x_step < x_end {
            let i0 = off + (x as usize) * 4;
            let ix = off + ((x + x_step) as usize) * 4;
            let iy = off_next + (x as usize) * 4;
            // Horizontal + vertical luminance-like gradient.
            energy += (raw[i0].abs_diff(raw[ix]) as u64)
                + (raw[i0 + 1].abs_diff(raw[ix + 1]) as u64)
                + (raw[i0 + 2].abs_diff(raw[ix + 2]) as u64)
                + (raw[i0].abs_diff(raw[iy]) as u64)
                + (raw[i0 + 1].abs_diff(raw[iy + 1]) as u64)
                + (raw[i0 + 2].abs_diff(raw[iy + 2]) as u64);
            samples += 6;
            x += x_step;
        }
        y += y_step;
    }
    if samples == 0 {
        0.0
    } else {
        (energy as f32) / (samples as f32)
    }
}

fn band_mad(
    prev: &RgbaImage,
    prev_y: u32,
    next: &RgbaImage,
    next_y: u32,
    band_h: u32,
    x_start: u32,
    x_end: u32,
    x_step: u32,
    y_step: u32,
    abort_threshold: f32,
) -> f32 {
    let mut total = 0.0f32;
    let mut rows = 0u32;
    let mut dy = 0u32;
    while dy < band_h {
        total += row_mad(prev, prev_y + dy, next, next_y + dy, x_start, x_end, x_step);
        rows += 1;
        if rows >= 3 && (total / rows as f32) > abort_threshold * 1.4 {
            return total / rows as f32;
        }
        dy += y_step;
    }
    if rows == 0 {
        255.0
    } else {
        total / (rows as f32)
    }
}

fn find_downward_shift(
    prev: &RgbaImage,
    next: &RgbaImage,
    scroll_top: u32,
    scroll_bottom: u32,
    x_start: u32,
    x_end: u32,
    x_step: u32,
) -> Option<u32> {
    let interior_h = scroll_bottom.saturating_sub(scroll_top);
    if interior_h < 32 {
        return None;
    }

    let band_h = (interior_h / 6).clamp(18, 56).min(interior_h / 3);
    let candidate_min_y = scroll_top + (interior_h / 2);
    let candidate_max_y = scroll_bottom.saturating_sub(band_h);
    if candidate_max_y <= candidate_min_y {
        return None;
    }

    // Score bands in the bottom half of `prev`. Prefer lower bands (larger y) because they survive
    // larger scroll steps without leaving the viewport.
    let probe_step = (band_h / 2).max(6);
    let mut bands: Vec<(u32, f32)> = Vec::new();
    let mut cy = candidate_min_y;
    while cy <= candidate_max_y {
        let d = band_detail_score(prev, cy, band_h, x_start, x_end, x_step);
        bands.push((cy, d));
        cy += probe_step;
    }
    if bands.last().map(|(y, _)| *y) != Some(candidate_max_y) {
        let d = band_detail_score(prev, candidate_max_y, band_h, x_start, x_end, x_step);
        bands.push((candidate_max_y, d));
    }

    let max_detail = bands
        .iter()
        .map(|(_, d)| *d)
        .fold(0.0f32, f32::max);

    // Choose up to two complementary anchor bands:
    // 1. Lowest band with decent detail (>= 35% of max detail), supporting huge scroll steps (~80%).
    // 2. Highest-detail band overall in the lower half, for maximum discriminability.
    let mut anchors: Vec<u32> = Vec::with_capacity(2);
    if let Some((y, _)) = bands
        .iter()
        .rev()
        .find(|(_, d)| *d >= max_detail * 0.35)
    {
        anchors.push(*y);
    }
    if let Some((y, _)) = bands
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    {
        if !anchors.contains(y) {
            anchors.push(*y);
        }
    }

    let mut best_shift: Option<u32> = None;
    let mut best_full_err = f32::MAX;

    for anchor_y in anchors {
        // Downward scroll by `shift` means `prev[anchor_y]` appears at `next[anchor_y - shift]`.
        let max_shift = anchor_y.saturating_sub(scroll_top);
        if max_shift < 2 {
            continue;
        }

        let coarse_step: u32 = if max_shift > 180 { 3 } else { 1 };
        let mut top_candidates: Vec<(u32, f32)> = Vec::new();
        let mut shift = 2u32;
        while shift <= max_shift {
            let target_y = anchor_y - shift;
            let err = band_mad(
                prev,
                anchor_y,
                next,
                target_y,
                band_h,
                x_start,
                x_end,
                x_step,
                2,
                24.0,
            );
            if err < 26.0 {
                top_candidates.push((shift, err));
            }
            shift += coarse_step;
        }

        if top_candidates.is_empty() {
            continue;
        }

        top_candidates
            .sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        top_candidates.truncate(6);

        for (coarse_s, _) in top_candidates {
            let lo = coarse_s.saturating_sub(coarse_step).max(1);
            let hi = (coarse_s + coarse_step).min(max_shift);
            for s in lo..=hi {
                let overlap_h = interior_h.saturating_sub(s);
                if overlap_h < 20 {
                    continue;
                }
                let verify_step = (overlap_h / 28).max(1);
                let full_err = band_mad(
                    prev,
                    scroll_top + s,
                    next,
                    scroll_top,
                    overlap_h,
                    x_start,
                    x_end,
                    x_step,
                    verify_step,
                    16.0,
                );
                if full_err < best_full_err {
                    best_full_err = full_err;
                    best_shift = Some(s);
                }
            }
        }

        if best_full_err <= 4.0 {
            break;
        }
    }

    if best_full_err <= 13.5 {
        best_shift
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// Generates a tall synthetic page with distinct non-repeating textured stripes & text-like bars.
    fn make_synthetic_page(width: u32, height: u32) -> RgbaImage {
        let mut img = RgbaImage::new(width, height);
        for y in 0..height {
            let block = y / 24;
            for x in 0..width {
                let mut r = ((y * 7 + x * 3 + block * 29) % 210 + 25) as u8;
                let mut g = ((y * 11 + block * 53 + (x / 8) * 17) % 210 + 25) as u8;
                let mut b = ((y * 5 + x * 13 + block * 71) % 210 + 25) as u8;
                // Add crisp high-contrast "text lines"
                if (y % 24) >= 6 && (y % 24) <= 10 && (x % 19) < 11 {
                    r = (block * 41 % 180) as u8;
                    g = (block * 83 % 180) as u8;
                    b = (block * 127 % 180) as u8;
                }
                img.put_pixel(x, y, Rgba([r, g, b, 255]));
            }
        }
        img
    }

    fn slice_frame(page: &RgbaImage, y_offset: u32, view_h: u32) -> RgbaImage {
        imageops::crop_imm(page, 0, y_offset, page.width(), view_h).to_image()
    }

    #[test]
    fn stitches_clean_scroll_frames_accurately() {
        let page = make_synthetic_page(320, 900);
        let view_h = 260;
        let f0 = slice_frame(&page, 0, view_h);
        let f1 = slice_frame(&page, 120, view_h);
        let f2 = slice_frame(&page, 265, view_h);
        let f3 = slice_frame(&page, 400, view_h);

        let mut stitcher = VerticalStitcher::new(f0, 20_000);
        assert_eq!(
            stitcher.push_frame(f1),
            StitchOutcome::Appended {
                delta_y: 120,
                total_height: 380
            }
        );
        assert_eq!(
            stitcher.push_frame(f2),
            StitchOutcome::Appended {
                delta_y: 145,
                total_height: 525
            }
        );
        assert_eq!(
            stitcher.push_frame(f3),
            StitchOutcome::Appended {
                delta_y: 135,
                total_height: 660
            }
        );

        let result = stitcher.finish();
        assert_eq!(result.dimensions(), (320, 660));
        // Pixel-exact match against ground-truth page!
        for y in 0..660 {
            for x in 0..320 {
                assert_eq!(result.get_pixel(x, y), page.get_pixel(x, y));
            }
        }
    }

    #[test]
    fn handles_sticky_header_and_sticky_footer() {
        let page = make_synthetic_page(320, 800);
        let view_h = 280;
        let header_h = 40;
        let footer_h = 32;

        let make_sticky_frame = |scroll_y: u32| {
            let mut frame = slice_frame(&page, scroll_y, view_h);
            // Paint fixed header
            for y in 0..header_h {
                for x in 0..320 {
                    frame.put_pixel(x, y, Rgba([248, 249, 250, 255]));
                }
            }
            // Paint fixed footer
            for y in (view_h - footer_h)..view_h {
                for x in 0..320 {
                    frame.put_pixel(x, y, Rgba([30, 34, 42, 255]));
                }
            }
            frame
        };

        let mut stitcher = VerticalStitcher::new(make_sticky_frame(0), 20_000);
        let out1 = stitcher.push_frame(make_sticky_frame(90));
        assert_eq!(
            out1,
            StitchOutcome::Appended {
                delta_y: 90,
                total_height: view_h + 90
            }
        );
        let out2 = stitcher.push_frame(make_sticky_frame(180));
        assert_eq!(
            out2,
            StitchOutcome::Appended {
                delta_y: 90,
                total_height: view_h + 180
            }
        );

        let result = stitcher.finish();
        assert_eq!(result.height(), view_h + 180);
        // Header appears at top, footer appears only at the very bottom!
        assert_eq!(*result.get_pixel(10, 10), Rgba([248, 249, 250, 255]));
        assert_eq!(
            *result.get_pixel(10, result.height() - 10),
            Rgba([30, 34, 42, 255])
        );
        // Middle seam has real page content, not duplicated footer!
        assert_ne!(*result.get_pixel(10, view_h - 10), Rgba([30, 34, 42, 255]));
    }

    #[test]
    fn detects_static_bottom_and_max_height() {
        let page = make_synthetic_page(280, 600);
        let f0 = slice_frame(&page, 0, 220);
        let mut stitcher = VerticalStitcher::new(f0.clone(), 300);

        // Identical frame -> NoMovement
        assert_eq!(stitcher.push_frame(f0), StitchOutcome::NoMovement);

        // Scroll by 120px exceeds max_height 300 -> clamped cleanly to 300
        let f1 = slice_frame(&page, 120, 220);
        assert_eq!(
            stitcher.push_frame(f1),
            StitchOutcome::ReachedMaxHeight { total_height: 300 }
        );
        assert_eq!(stitcher.finish().height(), 300);
    }

    #[test]
    fn detects_upward_inverted_scroll() {
        let page = make_synthetic_page(300, 600);
        let f_lower = slice_frame(&page, 150, 220);
        let f_upper = slice_frame(&page, 70, 220);
        assert_eq!(detect_upward_shift(&f_lower, &f_upper), Some(80));
    }
}
