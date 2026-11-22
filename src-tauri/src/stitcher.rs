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

        let cols = select_active_columns(&self.last_frame, &next);
        if cols.is_empty() {
            return StitchOutcome::NoMovement;
        }

        // Per-row difference at zero shift (in-place).
        let same_diffs: Vec<f32> = (0..self.frame_height)
            .map(|y| row_mad_cols(&self.last_frame, y, &next, y, &cols))
            .collect();

        // Fast stationary check: only short-circuit before shift matching when virtually zero rows changed.
        let changed_rows = same_diffs.iter().filter(|&&d| d > 2.5).count() as u32;
        let zero_trimmed = trimmed_mean_f32(&same_diffs, 0.85);
        let zero_inlier_ratio =
            same_diffs.iter().filter(|&&d| d <= 2.5).count() as f32 / (self.frame_height.max(1) as f32);

        if changed_rows < 4 {
            return StitchOutcome::NoMovement;
        }

        let (top_static, bottom_static) = static_margins_from_diffs(&same_diffs);

        // Cap assumed sticky margins at 35% each so large blank regions never starve the interior.
        let max_margin = (self.frame_height as f32 * 0.35) as u32;
        let scroll_top = top_static.min(max_margin);
        let scroll_bottom = self.frame_height - bottom_static.min(max_margin);
        let interior_h = scroll_bottom.saturating_sub(scroll_top);
        if interior_h < 24 {
            return StitchOutcome::NoMovement;
        }

        let Some(shift_match) = find_downward_shift_with_cols(
            &self.last_frame,
            &next,
            scroll_top,
            scroll_bottom,
            &cols,
        ) else {
            // If no downward shift matched AND almost the entire interior is unchanged
            // (e.g. a small animated element or blinking cursor in the middle while at page bottom),
            // classify as NoMovement rather than Unmatched.
            if zero_inlier_ratio >= 0.88 && zero_trimmed <= 2.2 {
                return StitchOutcome::NoMovement;
            }
            return StitchOutcome::Unmatched;
        };

        let delta_y = shift_match.shift;
        if delta_y == 0 {
            return StitchOutcome::NoMovement;
        }

        // If zero-shift is overwhelmingly better than the best non-zero shift (e.g., blinking
        // cursor / minor clock update at the bottom of a repetitive page), it didn't scroll.
        if zero_inlier_ratio >= 0.92 && zero_trimmed + 0.5 < shift_match.trimmed_err {
            return StitchOutcome::NoMovement;
        }

        let stride = (self.width as usize) * 4;

        // Self-healing sticky footer management:
        // If we previously locked a sticky footer, verify it is still genuinely static;
        // if new content scrolled into it (meaning frame 1 just happened to have blank bottom space),
        // flush the old footer back into body_rows and clear footer_height.
        if self.footer_height > 0 {
            let footer_start = self.frame_height - self.footer_height;
            let footer_static_rows = same_diffs[footer_start as usize..]
                .iter()
                .filter(|&&d| d <= 4.0)
                .count() as u32;
            if footer_static_rows * 10 < self.footer_height * 7 {
                self.body_rows.extend_from_slice(&self.footer_rows);
                self.body_height += self.footer_height;
                self.footer_rows.clear();
                self.footer_height = 0;
            }
        }

        if self.frames == 1 && bottom_static > 0 {
            let detected_footer = detect_true_sticky_footer(
                &self.last_frame,
                &next,
                bottom_static.min(max_margin),
                delta_y,
                &cols,
            );
            if detected_footer > 0 && detected_footer < self.body_height {
                let keep_h = self.body_height - detected_footer;
                let split_byte = (keep_h as usize) * stride;
                self.footer_rows = self.body_rows.split_off(split_byte);
                self.body_height = keep_h;
                self.footer_height = detected_footer;
            }
        } else if self.footer_height > 0 {
            // Keep latest footer pixels in case footer updated slightly.
            let start_y = (self.frame_height - self.footer_height) as usize;
            self.footer_rows = next.as_raw()[start_y * stride..].to_vec();
        }

        // Copy only the newly revealed rows above the sticky footer.
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

/// Fast sampled RGB mean absolute difference between two same-size frames.
/// Used to detect whether a smooth-scroll animation has settled.
pub fn quick_frame_diff(a: &RgbaImage, b: &RgbaImage) -> f32 {
    if a.width() != b.width() || a.height() != b.height() {
        return 255.0;
    }
    let w = a.width();
    let h = a.height();
    if w == 0 || h == 0 {
        return 0.0;
    }

    let x_start = if w > 80 { w / 40 } else { 0 };
    let x_end = if w > 120 {
        w.saturating_sub((w / 20).max(20).min(w / 5))
    } else {
        w
    }
    .max(x_start + 1);

    let y_step = (h / 24).max(1);
    let x_step = ((x_end - x_start) / 32).max(1);

    let raw_a = a.as_raw();
    let raw_b = b.as_raw();
    let stride = (w as usize) * 4;

    let mut sum: u64 = 0;
    let mut count: u64 = 0;
    let mut y = 0;
    while y < h {
        let off = (y as usize) * stride;
        let mut x = x_start;
        while x < x_end {
            let idx = off + (x as usize) * 4;
            sum += (raw_a[idx].abs_diff(raw_b[idx]) as u64)
                + (raw_a[idx + 1].abs_diff(raw_b[idx + 1]) as u64)
                + (raw_a[idx + 2].abs_diff(raw_b[idx + 2]) as u64);
            count += 3;
            x += x_step;
        }
        y += y_step;
    }
    if count == 0 {
        0.0
    } else {
        sum as f32 / count as f32
    }
}

/// Checks if `next` actually moved UPWARD relative to `prev` (which happens if OS/utility scroll
/// direction was inverted relative to our initial scroll sign).
pub fn detect_upward_shift(prev: &RgbaImage, next: &RgbaImage) -> Option<u32> {
    if prev.width() != next.width() || prev.height() != next.height() {
        return None;
    }
    let cols = select_active_columns(next, prev);
    if cols.is_empty() {
        return None;
    }
    let h = prev.height();
    let same_diffs: Vec<f32> = (0..h)
        .map(|y| row_mad_cols(next, y, prev, y, &cols))
        .collect();
    let (top_static, bottom_static) = static_margins_from_diffs(&same_diffs);
    let max_margin = (h as f32 * 0.35) as u32;
    let scroll_top = top_static.min(max_margin);
    let scroll_bottom = h - bottom_static.min(max_margin);
    if scroll_bottom.saturating_sub(scroll_top) < 24 {
        return None;
    }
    // Upward movement from prev -> next is identical to downward movement from next -> prev.
    find_downward_shift_with_cols(next, prev, scroll_top, scroll_bottom, &cols).map(|m| m.shift)
}

#[derive(Debug, Clone, Copy)]
struct ShiftMatch {
    shift: u32,
    trimmed_err: f32,
}

/// Selects representative X columns for comparison, automatically excluding scrollbars and
/// static sidebars / wide uniform side margins whenever a clear moving content pane exists.
fn select_active_columns(prev: &RgbaImage, next: &RgbaImage) -> Vec<u32> {
    let w = prev.width();
    let h = prev.height();
    if w == 0 || h == 0 {
        return Vec::new();
    }

    let left_pad = if w > 80 { (w / 60).max(2) } else { 0 };
    let right_pad = if w > 120 {
        (w / 22).max(20).min(w / 5)
    } else {
        0
    };
    let x_start = left_pad;
    let x_end = w.saturating_sub(right_pad).max(x_start + 1);
    let span = x_end - x_start;

    let sample_count = span.min(96) as usize;
    let mut all_cols = Vec::with_capacity(sample_count);
    for i in 0..sample_count {
        let x = x_start + ((i as u32) * span) / (sample_count as u32);
        all_cols.push(x.min(w - 1));
    }
    all_cols.dedup();

    if all_cols.len() <= 8 || h < 16 {
        return all_cols;
    }

    // Measure per-column motion between `prev` and `next` across sampled rows.
    let y_step = (h / 32).max(1);
    let raw_a = prev.as_raw();
    let raw_b = next.as_raw();
    let stride = (w as usize) * 4;

    let mut moving_cols = Vec::with_capacity(all_cols.len());
    for &x in &all_cols {
        let mut sum: u64 = 0;
        let mut cnt: u64 = 0;
        let mut y = 0;
        while y < h {
            let idx = (y as usize) * stride + (x as usize) * 4;
            sum += (raw_a[idx].abs_diff(raw_b[idx]) as u64)
                + (raw_a[idx + 1].abs_diff(raw_b[idx + 1]) as u64)
                + (raw_a[idx + 2].abs_diff(raw_b[idx + 2]) as u64);
            cnt += 3;
            y += y_step;
        }
        let col_mad = if cnt == 0 { 0.0 } else { sum as f32 / cnt as f32 };
        if col_mad > 2.2 {
            moving_cols.push(x);
        }
    }

    // Use moving columns if a meaningful portion of the width scrolled (e.g. excludes static
    // sidebars & wide blank margins without collapsing to a single blinking cursor column).
    if moving_cols.len() >= (all_cols.len() / 6).max(6) {
        moving_cols
    } else {
        all_cols
    }
}

fn static_margins_from_diffs(same_diffs: &[f32]) -> (u32, u32) {
    const STATIC_ROW_EPS: f32 = 2.5;
    let h = same_diffs.len();
    let mut top = 0usize;
    while top < h && same_diffs[top] <= STATIC_ROW_EPS {
        top += 1;
    }
    let mut bottom = 0usize;
    while bottom < h.saturating_sub(top) && same_diffs[h - 1 - bottom] <= STATIC_ROW_EPS {
        bottom += 1;
    }
    (top as u32, bottom as u32)
}

/// Distinguishes a genuine sticky footer from a coincidental blank margin at the bottom of frame 0.
fn detect_true_sticky_footer(
    prev: &RgbaImage,
    next: &RgbaImage,
    candidate_bottom_static: u32,
    delta_y: u32,
    cols: &[u32],
) -> u32 {
    let h = prev.height();
    if candidate_bottom_static == 0 || candidate_bottom_static >= h || delta_y == 0 {
        return 0;
    }

    let start_y = h - candidate_bottom_static;
    // Check if rows in the candidate footer actually disagree with shifted content
    // (i.e. `prev[y]` does NOT equal `next[y - delta_y]`, proving it's an overlay/bar rather
    // than uniform scrolling background).
    let mut non_matching = 0u32;
    let mut checked = 0u32;
    let step = (candidate_bottom_static / 12).max(1);
    let mut y = start_y;
    while y < h {
        if y >= delta_y {
            let shifted_diff = row_mad_cols(prev, y, next, y - delta_y, cols);
            if shifted_diff > 5.0 {
                non_matching += 1;
            }
            checked += 1;
        }
        y += step;
    }

    if checked == 0 || non_matching == 0 {
        return 0;
    }

    // Also verify the footer either has internal texture or a clear visual boundary against
    // the row just above it (so blank bottom padding isn't misclassified as a footer).
    let has_boundary = start_y > 0 && row_mad_cols(prev, start_y, prev, start_y - 1, cols) > 6.0;
    let has_internal_detail = {
        let mut energy = 0.0f32;
        let mut samples = 0u32;
        let mut ry = start_y;
        while ry + 1 < h {
            energy += row_mad_cols(prev, ry, prev, ry + 1, cols);
            samples += 1;
            ry += step;
        }
        samples > 0 && (energy / samples as f32) > 2.0
    };

    if has_boundary || has_internal_detail {
        candidate_bottom_static
    } else {
        0
    }
}

fn row_mad_cols(a: &RgbaImage, y_a: u32, b: &RgbaImage, y_b: u32, cols: &[u32]) -> f32 {
    let raw_a = a.as_raw();
    let raw_b = b.as_raw();
    let stride = (a.width() as usize) * 4;
    let off_a = (y_a as usize) * stride;
    let off_b = (y_b as usize) * stride;

    let mut sum: u64 = 0;
    for &x in cols {
        let dx = (x as usize) * 4;
        let ia = off_a + dx;
        let ib = off_b + dx;
        sum += (raw_a[ia].abs_diff(raw_b[ib]) as u64)
            + (raw_a[ia + 1].abs_diff(raw_b[ib + 1]) as u64)
            + (raw_a[ia + 2].abs_diff(raw_b[ib + 2]) as u64);
    }
    let count = (cols.len() * 3) as u64;
    if count == 0 {
        0.0
    } else {
        sum as f32 / count as f32
    }
}

fn trimmed_mean_f32(values: &[f32], keep_fraction: f32) -> f32 {
    if values.is_empty() {
        return 255.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let keep = ((sorted.len() as f32 * keep_fraction).ceil() as usize).clamp(1, sorted.len());
    let sum: f32 = sorted[..keep].iter().sum();
    sum / (keep as f32)
}

const SIG_LEN: usize = 32;

struct RowSignatures {
    /// Compact 32-sample luma signature per row for ultra-fast coarse shift search.
    luma: Vec<[u8; SIG_LEN]>,
    /// Horizontal contrast/detail energy per row so textured rows are weighted above blank gaps.
    energy: Vec<f32>,
}

fn build_row_signatures(img: &RgbaImage, cols: &[u32]) -> RowSignatures {
    let h = img.height() as usize;
    let stride = (img.width() as usize) * 4;
    let raw = img.as_raw();

    // Pick SIG_LEN evenly spaced columns from `cols`.
    let mut sig_cols = [0usize; SIG_LEN];
    for i in 0..SIG_LEN {
        let idx = (i * cols.len()) / SIG_LEN;
        sig_cols[i] = (cols[idx.min(cols.len() - 1)] as usize) * 4;
    }

    let mut luma = Vec::with_capacity(h);
    let mut energy = Vec::with_capacity(h);

    for y in 0..h {
        let off = y * stride;
        let mut sig = [0u8; SIG_LEN];
        let mut grad_sum: u32 = 0;
        for i in 0..SIG_LEN {
            let p = off + sig_cols[i];
            // Fast approximate Rec.601 luma
            let lum = ((raw[p] as u32 * 77 + raw[p + 1] as u32 * 150 + raw[p + 2] as u32 * 29) >> 8)
                as u8;
            sig[i] = lum;
            if i > 0 {
                grad_sum += sig[i].abs_diff(sig[i - 1]) as u32;
            }
        }
        luma.push(sig);
        energy.push(grad_sum as f32 / ((SIG_LEN - 1) as f32));
    }

    RowSignatures { luma, energy }
}

#[inline]
fn sig_row_diff(a: &[u8; SIG_LEN], b: &[u8; SIG_LEN]) -> f32 {
    let mut sum: u32 = 0;
    for i in 0..SIG_LEN {
        sum += a[i].abs_diff(b[i]) as u32;
    }
    sum as f32 / (SIG_LEN as f32)
}

fn find_downward_shift_with_cols(
    prev: &RgbaImage,
    next: &RgbaImage,
    scroll_top: u32,
    scroll_bottom: u32,
    cols: &[u32],
) -> Option<ShiftMatch> {
    let interior_h = scroll_bottom.saturating_sub(scroll_top);
    if interior_h < 24 {
        return None;
    }

    let min_overlap = (interior_h / 10).clamp(16, 48).min(interior_h.saturating_sub(2));
    let max_shift = interior_h.saturating_sub(min_overlap);
    if max_shift < 1 {
        return None;
    }

    let sig_prev = build_row_signatures(prev, cols);
    let sig_next = build_row_signatures(next, cols);

    // Precompute textured rows in `next`'s scrolling interior so even very sparse pages
    // (mostly blank whitespace with a few lines of text) always sample on real content.
    let active_next_rows: Vec<u32> = (scroll_top..scroll_bottom)
        .filter(|&y| sig_next.energy[y as usize] > 1.8)
        .collect();

    let coarse_step: u32 = if max_shift > 700 {
        3
    } else if max_shift > 280 {
        2
    } else {
        1
    };

    // Stage 1: Exhaustive 1D-signature coarse scan over EVERY shift in [1..=max_shift].
    // No anchor-band blind spots, and trimmed mean ignores translucent sticky headers & overlays.
    let mut coarse_scores: Vec<(u32, f32)> = Vec::with_capacity((max_shift / coarse_step) as usize + 2);
    let mut errs_buf: Vec<f32> = Vec::with_capacity(44);
    let mut detail_errs_buf: Vec<f32> = Vec::with_capacity(44);

    let mut shift = 1u32;
    while shift <= max_shift {
        let overlap_h = interior_h - shift;
        let overlap_end = scroll_top + overlap_h;
        let sample_rows = overlap_h.min(28);
        errs_buf.clear();
        detail_errs_buf.clear();

        for k in 0..sample_rows {
            let dy = (k * overlap_h) / sample_rows;
            let y_next = (scroll_top + dy) as usize;
            let y_prev = (scroll_top + shift + dy) as usize;
            let d = sig_row_diff(&sig_prev.luma[y_prev], &sig_next.luma[y_next]);
            errs_buf.push(d);
            if sig_prev.energy[y_prev] > 1.8 || sig_next.energy[y_next] > 1.8 {
                detail_errs_buf.push(d);
            }
        }

        // Supplement with textured rows inside the overlap for sparse pages.
        if detail_errs_buf.len() < 8 && !active_next_rows.is_empty() {
            let valid_end = active_next_rows.partition_point(|&y| y < overlap_end);
            if valid_end > 0 {
                let extra = valid_end.min(12);
                for k in 0..extra {
                    let y_next = active_next_rows[(k * valid_end) / extra] as usize;
                    let y_prev = y_next + shift as usize;
                    let d = sig_row_diff(&sig_prev.luma[y_prev], &sig_next.luma[y_next]);
                    detail_errs_buf.push(d);
                }
            }
        }

        // Discard worst 25% of rows (sticky headers with backdrop-blur, floating widgets, hover effects).
        let trimmed_all = trimmed_mean_f32(&errs_buf, 0.75);
        // Guard against blank-matching-blank false positives by also checking textured rows.
        let score = if detail_errs_buf.len() >= 3 {
            let trimmed_detail = trimmed_mean_f32(&detail_errs_buf, 0.75);
            trimmed_all * 0.4 + trimmed_detail * 0.6
        } else {
            // Penalize pure-blank overlaps slightly so real textured matches win decisively.
            trimmed_all + 2.5
        };

        coarse_scores.push((shift, score));
        shift += coarse_step;
    }

    if coarse_scores.is_empty() {
        return None;
    }

    // Collect local minima (plus global best) so one broad valley cannot crowd out other shifts.
    let mut candidates: Vec<(u32, f32)> = Vec::new();
    for i in 0..coarse_scores.len() {
        let (s, sc) = coarse_scores[i];
        if sc > 24.0 {
            continue;
        }
        let left_ok = i == 0 || sc <= coarse_scores[i - 1].1 + 0.25;
        let right_ok = i + 1 == coarse_scores.len() || sc <= coarse_scores[i + 1].1 + 0.25;
        if left_ok && right_ok {
            candidates.push((s, sc));
        }
    }
    if candidates.is_empty() {
        coarse_scores.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        candidates.extend(coarse_scores.into_iter().take(12));
    } else {
        candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        candidates.truncate(16);
    }

    // Stage 2: Exact 1-pixel full-RGB verification around top coarse candidates.
    let mut best_match: Option<(u32, f32, f32)> = None; // (shift, combined_score, trimmed_rgb)
    let mut rgb_errs: Vec<f32> = Vec::with_capacity(48);
    let mut rgb_detail_errs: Vec<f32> = Vec::with_capacity(48);
    let mut tested_shifts: Vec<u32> = Vec::with_capacity(64);

    for (coarse_s, _) in candidates {
        let lo = coarse_s.saturating_sub(coarse_step).max(1);
        let hi = (coarse_s + coarse_step).min(max_shift);
        for s in lo..=hi {
            if tested_shifts.contains(&s) {
                continue;
            }
            tested_shifts.push(s);

            let overlap_h = interior_h - s;
            if overlap_h < min_overlap {
                continue;
            }
            let overlap_end = scroll_top + overlap_h;

            let sample_rows = overlap_h.min(44);
            rgb_errs.clear();
            rgb_detail_errs.clear();

            for k in 0..sample_rows {
                let dy = (k * overlap_h) / sample_rows;
                let y_next = scroll_top + dy;
                let y_prev = scroll_top + s + dy;
                let d = row_mad_cols(prev, y_prev, next, y_next, cols);
                rgb_errs.push(d);
                if sig_prev.energy[y_prev as usize] > 1.8 || sig_next.energy[y_next as usize] > 1.8 {
                    rgb_detail_errs.push(d);
                }
            }

            if rgb_detail_errs.len() < 8 && !active_next_rows.is_empty() {
                let valid_end = active_next_rows.partition_point(|&y| y < overlap_end);
                if valid_end > 0 {
                    let extra = valid_end.min(12);
                    for k in 0..extra {
                        let y_next = active_next_rows[(k * valid_end) / extra];
                        let y_prev = y_next + s;
                        let d = row_mad_cols(prev, y_prev, next, y_next, cols);
                        rgb_detail_errs.push(d);
                    }
                }
            }

            let trimmed_rgb = trimmed_mean_f32(&rgb_errs, 0.75);
            let inliers = rgb_errs.iter().filter(|&&d| d <= 12.0).count() as f32
                / (rgb_errs.len().max(1) as f32);

            let (detail_trimmed, detail_inliers) = if rgb_detail_errs.len() >= 3 {
                let dt = trimmed_mean_f32(&rgb_detail_errs, 0.75);
                let di = rgb_detail_errs.iter().filter(|&&d| d <= 14.0).count() as f32
                    / (rgb_detail_errs.len() as f32);
                (dt, di)
            } else {
                (trimmed_rgb + 1.5, inliers)
            };

            if trimmed_rgb > 12.5 || inliers < 0.65 || detail_trimmed > 14.0 || detail_inliers < 0.60
            {
                continue;
            }

            let combined = trimmed_rgb * 0.45 + detail_trimmed * 0.55;
            let better = match best_match {
                None => true,
                Some((prev_s, prev_score, _)) => {
                    if (combined - prev_score).abs() <= 0.35 {
                        // When scores are essentially tied, prefer the smaller shift (larger overlap)
                        // to avoid skipping content on periodic patterns.
                        s < prev_s
                    } else {
                        combined < prev_score
                    }
                }
            };
            if better {
                best_match = Some((s, combined, trimmed_rgb));
            }
        }
    }

    best_match.map(|(shift, _, trimmed_err)| ShiftMatch { shift, trimmed_err })
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
    fn handles_translucent_changing_sticky_header() {
        let page = make_synthetic_page(360, 900);
        let view_h = 300;
        let header_h = 36;

        let make_frame = |scroll_y: u32, tint: u8| {
            let mut frame = slice_frame(&page, scroll_y, view_h);
            // Translucent header whose backdrop color shifts on every scroll!
            for y in 0..header_h {
                for x in 0..360 {
                    let orig = frame.get_pixel(x, y);
                    let r = ((orig[0] as u16 + tint as u16 * 3) / 4) as u8;
                    let g = ((orig[1] as u16 + tint as u16 * 3) / 4) as u8;
                    let b = ((orig[2] as u16 + tint as u16 * 3) / 4) as u8;
                    frame.put_pixel(x, y, Rgba([r, g, b, 255]));
                }
            }
            frame
        };

        let mut stitcher = VerticalStitcher::new(make_frame(0, 235), 20_000);
        assert_eq!(
            stitcher.push_frame(make_frame(110, 195)),
            StitchOutcome::Appended {
                delta_y: 110,
                total_height: view_h + 110,
            }
        );
        assert_eq!(
            stitcher.push_frame(make_frame(225, 220)),
            StitchOutcome::Appended {
                delta_y: 115,
                total_height: view_h + 225,
            }
        );
    }

    #[test]
    fn handles_static_left_sidebar() {
        let page = make_synthetic_page(400, 900);
        let view_h = 280;
        let sidebar_w = 120; // 30% static left sidebar

        let make_frame = |scroll_y: u32| {
            let mut frame = slice_frame(&page, scroll_y, view_h);
            for y in 0..view_h {
                for x in 0..sidebar_w {
                    let stripe = if (y / 28) % 2 == 0 { 242 } else { 232 };
                    frame.put_pixel(x, y, Rgba([stripe, stripe, stripe + 4, 255]));
                }
            }
            frame
        };

        let mut stitcher = VerticalStitcher::new(make_frame(0), 20_000);
        assert_eq!(
            stitcher.push_frame(make_frame(130)),
            StitchOutcome::Appended {
                delta_y: 130,
                total_height: view_h + 130,
            }
        );
        assert_eq!(
            stitcher.push_frame(make_frame(260)),
            StitchOutcome::Appended {
                delta_y: 130,
                total_height: view_h + 260,
            }
        );
    }

    #[test]
    fn handles_large_blank_bottom_half_and_large_shift() {
        let mut page = RgbaImage::from_pixel(320, 900, Rgba([255, 255, 255, 255]));
        let textured = make_synthetic_page(320, 900);
        // Only paint content bands at y = 20..120 and y = 340..500 (leaving huge white gap in bottom half of frame 0!)
        for y in 20..120 {
            for x in 20..300 {
                page.put_pixel(x, y, *textured.get_pixel(x, y));
            }
        }
        for y in 300..520 {
            for x in 20..300 {
                page.put_pixel(x, y, *textured.get_pixel(x, y));
            }
        }

        let view_h = 280;
        let f0 = slice_frame(&page, 0, view_h);
        // Scroll by 70px (content at top moves up, bottom half was blank white!)
        let f1 = slice_frame(&page, 70, view_h);
        // Large scroll by 210px (75% of viewport!)
        let f2 = slice_frame(&page, 280, view_h);

        let mut stitcher = VerticalStitcher::new(f0, 20_000);
        assert_eq!(
            stitcher.push_frame(f1),
            StitchOutcome::Appended {
                delta_y: 70,
                total_height: view_h + 70,
            }
        );
        assert_eq!(
            stitcher.push_frame(f2),
            StitchOutcome::Appended {
                delta_y: 210,
                total_height: view_h + 280,
            }
        );
    }

    #[test]
    fn detects_no_movement_with_blinking_cursor() {
        let page = make_synthetic_page(320, 600);
        let f0 = slice_frame(&page, 0, 260);
        let mut f1 = f0.clone();
        // Blinking 2x16 text cursor in the middle of the frame
        for y in 120..136 {
            for x in 140..142 {
                f1.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        let mut stitcher = VerticalStitcher::new(f0, 20_000);
        assert_eq!(stitcher.push_frame(f1), StitchOutcome::NoMovement);
    }

    #[test]
    fn handles_small_final_scroll_at_bottom() {
        let page = make_synthetic_page(320, 600);
        let view_h = 240;
        let f0 = slice_frame(&page, 0, view_h);
        let f1 = slice_frame(&page, 120, view_h);
        let f2 = slice_frame(&page, 129, view_h); // Only 9px left to bottom!

        let mut stitcher = VerticalStitcher::new(f0, 20_000);
        assert_eq!(
            stitcher.push_frame(f1),
            StitchOutcome::Appended {
                delta_y: 120,
                total_height: view_h + 120,
            }
        );
        assert_eq!(
            stitcher.push_frame(f2),
            StitchOutcome::Appended {
                delta_y: 9,
                total_height: view_h + 129,
            }
        );
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

    #[test]
    fn handles_very_sparse_page_without_false_no_movement() {
        let mut page = RgbaImage::from_pixel(320, 900, Rgba([255, 255, 255, 255]));
        let textured = make_synthetic_page(320, 900);
        // Only a single 16px-tall strip of text on a 500px-tall viewport (97% blank white!)
        for y in 220..236 {
            for x in 40..280 {
                page.put_pixel(x, y, *textured.get_pixel(x, y));
            }
        }
        let view_h = 500;
        let f0 = slice_frame(&page, 0, view_h);
        let f1 = slice_frame(&page, 110, view_h);

        let mut stitcher = VerticalStitcher::new(f0, 20_000);
        assert_eq!(
            stitcher.push_frame(f1),
            StitchOutcome::Appended {
                delta_y: 110,
                total_height: view_h + 110,
            }
        );
    }
}
