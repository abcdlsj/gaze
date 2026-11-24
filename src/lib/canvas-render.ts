import type {
  Annotation,
  BackdropConfig,
  Point,
  ResizeHandleId,
  ShapeAnnotation,
  ShapeFillStyle,
  TextAnnotation,
} from "../types";

export function isLightHexColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 195;
}

export function getContrastingTextColor(hex: string): string {
  return isLightHexColor(hex) ? "#141416" : "#FFFFFF";
}

export function getShapeFillStyle(ann: ShapeAnnotation): ShapeFillStyle {
  if (ann.fillStyle) return ann.fillStyle;
  return ann.filled ? "tinted" : "outline";
}

export interface CompositeLayout {
  canvasWidth: number;
  canvasHeight: number;
  offsetX: number;
  offsetY: number;
}

export interface AnnotationHandle {
  id: ResizeHandleId;
  x: number;
  y: number;
  cursor: string;
}

export function computeLayout(
  imgWidth: number,
  imgHeight: number,
  backdrop: BackdropConfig,
  scaleFactor = 1,
): CompositeLayout {
  if (!backdrop.enabled) {
    return {
      canvasWidth: imgWidth,
      canvasHeight: imgHeight,
      offsetX: 0,
      offsetY: 0,
    };
  }
  const pad = Math.max(0, Math.round(backdrop.padding * scaleFactor));
  return {
    canvasWidth: imgWidth + pad * 2,
    canvasHeight: imgHeight + pad * 2,
    offsetX: pad,
    offsetY: pad,
  };
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function fillBackdrop(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bg: string,
) {
  if (bg.startsWith("linear-gradient(")) {
    const colors = bg.match(/#[0-9a-fA-F]{6}/g);
    if (colors && colors.length >= 2) {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      const last = colors.length - 1;
      colors.forEach((c, idx) => {
        grad.addColorStop(idx / last, c);
      });
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      return;
    }
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
}

// Reusable scratch canvases to avoid per-frame DOM allocations during live drag
let blurScratchCanvas: HTMLCanvasElement | null = null;
let pixelScratchCanvas: HTMLCanvasElement | null = null;
let measureCanvas: HTMLCanvasElement | null = null;

function getScratchCanvas(
  kind: "blur" | "pixel" | "measure",
): HTMLCanvasElement {
  if (kind === "blur") {
    if (!blurScratchCanvas) blurScratchCanvas = document.createElement("canvas");
    return blurScratchCanvas;
  }
  if (kind === "pixel") {
    if (!pixelScratchCanvas)
      pixelScratchCanvas = document.createElement("canvas");
    return pixelScratchCanvas;
  }
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  return measureCanvas;
}

/**
 * Pure software 3-pass separable sliding-window box blur (converges to Gaussian blur).
 * O(W * H) regardless of radius; works identically across macOS WKWebView, WebView2, and headless canvases
 * without relying on CanvasRenderingContext2D.filter (which WKWebView silently ignores).
 */
export function boxBlurRgbaInPlace(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  passes = 3,
): void {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0 || width <= 0 || height <= 0) return;

  const tmp = new Uint8ClampedArray(data.length);
  const diam = r * 2 + 1;
  const inv = 1 / diam;

  for (let pass = 0; pass < passes; pass++) {
    // Horizontal pass: data -> tmp
    for (let y = 0; y < height; y++) {
      const rowOff = y * width * 4;
      let sr = data[rowOff] * (r + 1);
      let sg = data[rowOff + 1] * (r + 1);
      let sb = data[rowOff + 2] * (r + 1);
      let sa = data[rowOff + 3] * (r + 1);

      for (let k = 1; k <= r; k++) {
        const cx = k < width ? k : width - 1;
        const p = rowOff + cx * 4;
        sr += data[p];
        sg += data[p + 1];
        sb += data[p + 2];
        sa += data[p + 3];
      }

      for (let x = 0; x < width; x++) {
        const out = rowOff + x * 4;
        tmp[out] = (sr * inv + 0.5) | 0;
        tmp[out + 1] = (sg * inv + 0.5) | 0;
        tmp[out + 2] = (sb * inv + 0.5) | 0;
        tmp[out + 3] = (sa * inv + 0.5) | 0;

        const addX = x + r + 1 < width ? x + r + 1 : width - 1;
        const subX = x - r > 0 ? x - r : 0;
        const addP = rowOff + addX * 4;
        const subP = rowOff + subX * 4;
        sr += data[addP] - data[subP];
        sg += data[addP + 1] - data[subP + 1];
        sb += data[addP + 2] - data[subP + 2];
        sa += data[addP + 3] - data[subP + 3];
      }
    }

    // Vertical pass: tmp -> data
    const stride = width * 4;
    for (let x = 0; x < width; x++) {
      const colOff = x * 4;
      let sr = tmp[colOff] * (r + 1);
      let sg = tmp[colOff + 1] * (r + 1);
      let sb = tmp[colOff + 2] * (r + 1);
      let sa = tmp[colOff + 3] * (r + 1);

      for (let k = 1; k <= r; k++) {
        const cy = k < height ? k : height - 1;
        const p = cy * stride + colOff;
        sr += tmp[p];
        sg += tmp[p + 1];
        sb += tmp[p + 2];
        sa += tmp[p + 3];
      }

      for (let y = 0; y < height; y++) {
        const out = y * stride + colOff;
        data[out] = (sr * inv + 0.5) | 0;
        data[out + 1] = (sg * inv + 0.5) | 0;
        data[out + 2] = (sb * inv + 0.5) | 0;
        data[out + 3] = (sa * inv + 0.5) | 0;

        const addY = y + r + 1 < height ? y + r + 1 : height - 1;
        const subY = y - r > 0 ? y - r : 0;
        const addP = addY * stride + colOff;
        const subP = subY * stride + colOff;
        sr += tmp[addP] - tmp[subP];
        sg += tmp[addP + 1] - tmp[subP + 1];
        sb += tmp[addP + 2] - tmp[subP + 2];
        sa += tmp[addP + 3] - tmp[subP + 3];
      }
    }
  }
}

function getSourceDimensions(
  sourceImage: HTMLImageElement | HTMLCanvasElement,
): { w: number; h: number } {
  if (sourceImage instanceof HTMLCanvasElement) {
    return { w: sourceImage.width, h: sourceImage.height };
  }
  return {
    w: sourceImage.naturalWidth || sourceImage.width,
    h: sourceImage.naturalHeight || sourceImage.height,
  };
}

function clampRectToImage(
  x: number,
  y: number,
  w: number,
  h: number,
  imgW: number,
  imgH: number,
): { rx: number; ry: number; rw: number; rh: number } | null {
  const x0 = Math.max(0, Math.min(imgW, Math.round(Math.min(x, x + w))));
  const y0 = Math.max(0, Math.min(imgH, Math.round(Math.min(y, y + h))));
  const x1 = Math.max(0, Math.min(imgW, Math.round(Math.max(x, x + w))));
  const y1 = Math.max(0, Math.min(imgH, Math.round(Math.max(y, y + h))));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 1 || rh < 1) return null;
  return { rx: x0, ry: y0, rw, rh };
}

function drawBlurredRegion(
  ctx: CanvasRenderingContext2D,
  sourceImage: HTMLImageElement | HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  strength: number,
  scaleFactor: number,
) {
  const { w: imgW, h: imgH } = getSourceDimensions(sourceImage);
  const clamped = clampRectToImage(x, y, w, h, imgW, imgH);
  if (!clamped) return;
  const { rx, ry, rw, rh } = clamped;

  // Target Gaussian blur radius in physical pixels
  const targetRadius = Math.max(3, Math.round(strength * scaleFactor * 0.9));
  // Downsample proportionally for huge radii so blurring stays <1ms at 120fps
  const ds = targetRadius >= 22 ? 4 : targetRadius >= 10 ? 2 : 1;
  const smallR = Math.max(1, Math.round(targetRadius / ds));

  // Pad ROI so surrounding pixels contribute seamlessly without edge darkening
  const pad = Math.min(Math.max(targetRadius * 2, 16), 96);
  const sx0 = Math.max(0, rx - pad);
  const sy0 = Math.max(0, ry - pad);
  const sx1 = Math.min(imgW, rx + rw + pad);
  const sy1 = Math.min(imgH, ry + rh + pad);
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  if (sw < 1 || sh < 1) return;

  const bufW = Math.max(1, Math.ceil(sw / ds));
  const bufH = Math.max(1, Math.ceil(sh / ds));
  const scratch = getScratchCanvas("blur");
  scratch.width = bufW;
  scratch.height = bufH;
  const sctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!sctx) return;

  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.clearRect(0, 0, bufW, bufH);
  sctx.drawImage(sourceImage, sx0, sy0, sw, sh, 0, 0, bufW, bufH);

  const imgData = sctx.getImageData(0, 0, bufW, bufH);
  boxBlurRgbaInPlace(imgData.data, bufW, bufH, smallR, 3);
  sctx.putImageData(imgData, 0, 0);

  // Compute exact sub-rect inside scratch canvas corresponding to [rx, ry, rw, rh]
  const scaleX = bufW / sw;
  const scaleY = bufH / sh;
  const cropX = (rx - sx0) * scaleX;
  const cropY = (ry - sy0) * scaleY;
  const cropW = rw * scaleX;
  const cropH = rh * scaleY;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(scratch, cropX, cropY, cropW, cropH, rx, ry, rw, rh);
  ctx.restore();
}

function drawPixelatedRegion(
  ctx: CanvasRenderingContext2D,
  sourceImage: HTMLImageElement | HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  strength: number,
  scaleFactor: number,
) {
  const { w: imgW, h: imgH } = getSourceDimensions(sourceImage);
  const clamped = clampRectToImage(x, y, w, h, imgW, imgH);
  if (!clamped) return;
  const { rx, ry, rw, rh } = clamped;

  const blockSize = Math.max(6, Math.round(strength * scaleFactor * 1.15));
  // Align mosaic cells to global image grid so resizing/moving never causes block shimmer
  const gx0 = Math.floor(rx / blockSize) * blockSize;
  const gy0 = Math.floor(ry / blockSize) * blockSize;
  const gx1 = Math.min(imgW, Math.ceil((rx + rw) / blockSize) * blockSize);
  const gy1 = Math.min(imgH, Math.ceil((ry + rh) / blockSize) * blockSize);
  const gw = Math.max(1, gx1 - gx0);
  const gh = Math.max(1, gy1 - gy0);

  const cols = Math.max(1, Math.round(gw / blockSize));
  const rows = Math.max(1, Math.round(gh / blockSize));

  const scratch = getScratchCanvas("pixel");
  scratch.width = cols;
  scratch.height = rows;
  const sctx = scratch.getContext("2d");
  if (!sctx) return;

  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "medium";
  sctx.clearRect(0, 0, cols, rows);
  sctx.drawImage(sourceImage, gx0, gy0, gw, gh, 0, 0, cols, rows);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, cols, rows, gx0, gy0, gw, gh);
  ctx.imageSmoothingEnabled = true;
  ctx.restore();
}

const TEXT_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif';

export function measureTextAnnotation(
  ann: TextAnnotation,
  scaleFactor: number,
): { width: number; height: number; padX: number; padY: number; lineHeight: number } {
  const fontPx = Math.round(ann.fontSize * scaleFactor);
  const lineHeight = fontPx * 1.28;
  const lines = (ann.text || " ").split("\n");
  const isBadge = ann.textStyle === "badge";
  const padX = isBadge ? Math.round(fontPx * 0.45) : 0;
  const padY = isBadge ? Math.round(fontPx * 0.24) : 0;

  let maxLineW = 0;
  if (typeof document !== "undefined") {
    const c = getScratchCanvas("measure");
    const mctx = c.getContext("2d");
    if (mctx) {
      mctx.font = `600 ${fontPx}px ${TEXT_FONT_FAMILY}`;
      for (const line of lines) {
        const w = mctx.measureText(line || " ").width;
        if (w > maxLineW) maxLineW = w;
      }
    }
  }
  if (maxLineW === 0) {
    const maxLen = Math.max(1, ...lines.map((l) => l.length));
    maxLineW = maxLen * fontPx * 0.65;
  }

  return {
    width: Math.max(24 * scaleFactor, maxLineW) + padX * 2,
    height: Math.max(lineHeight, lines.length * lineHeight) + padY * 2,
    padX,
    padY,
    lineHeight,
  };
}

/**
 * Renders the base screenshot, optional frame/backdrop, and all annotations onto `ctx`.
 * All coordinates are in physical image pixel space.
 */
export function renderComposite(
  ctx: CanvasRenderingContext2D,
  sourceImage: HTMLImageElement | HTMLCanvasElement,
  imgWidth: number,
  imgHeight: number,
  scaleFactor: number,
  backdrop: BackdropConfig,
  annotations: Annotation[],
  selectedId: string | null,
  options?: {
    zoom?: number;
    draftId?: string | null;
    editingTextId?: string | null;
  },
) {
  const zoom = options?.zoom ?? 1;
  const draftId = options?.draftId ?? null;
  const editingTextId = options?.editingTextId ?? null;
  const layout = computeLayout(imgWidth, imgHeight, backdrop, scaleFactor);
  ctx.clearRect(0, 0, layout.canvasWidth, layout.canvasHeight);

  // 1. Optional backdrop & framed image
  if (backdrop.enabled) {
    fillBackdrop(ctx, layout.canvasWidth, layout.canvasHeight, backdrop.background);

    ctx.save();
    if (backdrop.shadow) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.28)";
      ctx.shadowBlur = Math.round(32 * scaleFactor);
      ctx.shadowOffsetY = Math.round(12 * scaleFactor);
      drawRoundedRectPath(
        ctx,
        layout.offsetX,
        layout.offsetY,
        imgWidth,
        imgHeight,
        backdrop.cornerRadius * scaleFactor,
      );
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    drawRoundedRectPath(
      ctx,
      layout.offsetX,
      layout.offsetY,
      imgWidth,
      imgHeight,
      backdrop.cornerRadius * scaleFactor,
    );
    ctx.clip();
    ctx.drawImage(sourceImage, layout.offsetX, layout.offsetY, imgWidth, imgHeight);
    ctx.restore();
  } else {
    ctx.drawImage(sourceImage, 0, 0, imgWidth, imgHeight);
  }

  // 2. Render annotations in image-coordinate space
  ctx.save();
  ctx.translate(layout.offsetX, layout.offsetY);

  // Clip redactions & spotlights to the framed screenshot bounds if backdrop is enabled
  const clipToImage = () => {
    if (backdrop.enabled) {
      drawRoundedRectPath(
        ctx,
        0,
        0,
        imgWidth,
        imgHeight,
        backdrop.cornerRadius * scaleFactor,
      );
      ctx.clip();
    }
  };

  // 2a. Redaction layers first (blur, pixelate, blackout)
  ctx.save();
  clipToImage();
  for (const ann of annotations) {
    if (
      ann.type === "blur" ||
      ann.type === "pixelate" ||
      ann.type === "blackout"
    ) {
      drawAnnotation(ctx, sourceImage, ann, scaleFactor);
    }
  }

  // 2b. Unified Spotlight scrim (dims everything outside spotlight cutouts cleanly)
  const spotlights = annotations.filter((a) => a.type === "spotlight");
  if (spotlights.length > 0) {
    const dimOpacity = spotlights[spotlights.length - 1].opacity ?? 0.52;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, imgWidth, imgHeight);
    for (const sp of spotlights) {
      const x = Math.min(sp.x, sp.x + sp.width);
      const y = Math.min(sp.y, sp.y + sp.height);
      const w = Math.abs(sp.width);
      const h = Math.abs(sp.height);
      if (w < 1 || h < 1) continue;
      const rad = Math.min(8 * scaleFactor, w / 2, h / 2);
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + w, y, x + w, y + h, rad);
      ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad);
      ctx.arcTo(x, y, x + w, y, rad);
      ctx.closePath();
    }
    ctx.fillStyle = `rgba(0, 0, 0, ${dimOpacity})`;
    ctx.fill("evenodd");
    ctx.restore();
  }
  ctx.restore();

  // 2c. Vector & text annotations above scrim so callouts stay crisp & legible
  for (const ann of annotations) {
    if (
      ann.type === "blur" ||
      ann.type === "pixelate" ||
      ann.type === "blackout" ||
      ann.type === "spotlight"
    ) {
      continue;
    }
    if (ann.id === editingTextId) continue;
    drawAnnotation(ctx, sourceImage, ann, scaleFactor);
  }

  // 2d. Live draft feedback outline for redaction/spotlight boxes (so dragging over flat colors is visible)
  if (draftId) {
    const draft = annotations.find((a) => a.id === draftId);
    if (
      draft &&
      (draft.type === "blur" ||
        draft.type === "pixelate" ||
        draft.type === "blackout" ||
        draft.type === "spotlight")
    ) {
      drawDraftBoxGuide(ctx, draft, scaleFactor, zoom);
    }
  }

  // 2e. Selection outline + zoom-invariant resize/endpoint handles
  if (selectedId && selectedId !== editingTextId) {
    const sel = annotations.find((a) => a.id === selectedId);
    if (sel) {
      drawSelectionAndHandles(ctx, sel, scaleFactor, zoom);
    }
  }

  ctx.restore();
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  sourceImage: HTMLImageElement | HTMLCanvasElement,
  ann: Annotation,
  scaleFactor: number,
) {
  ctx.save();

  switch (ann.type) {
    case "blur": {
      drawBlurredRegion(
        ctx,
        sourceImage,
        ann.x,
        ann.y,
        ann.width,
        ann.height,
        ann.strength,
        scaleFactor,
      );
      break;
    }

    case "pixelate": {
      drawPixelatedRegion(
        ctx,
        sourceImage,
        ann.x,
        ann.y,
        ann.width,
        ann.height,
        ann.strength,
        scaleFactor,
      );
      break;
    }

    case "blackout": {
      const x = Math.min(ann.x, ann.x + ann.width);
      const y = Math.min(ann.y, ann.y + ann.height);
      const w = Math.abs(ann.width);
      const h = Math.abs(ann.height);
      if (w >= 1 && h >= 1) {
        drawRoundedRectPath(ctx, x, y, w, h, 3 * scaleFactor);
        ctx.fillStyle = ann.color || "#18181B";
        ctx.fill();
      }
      break;
    }

    case "spotlight": {
      break;
    }

    case "rect": {
      const x = Math.min(ann.x, ann.x + ann.width);
      const y = Math.min(ann.y, ann.y + ann.height);
      const w = Math.abs(ann.width);
      const h = Math.abs(ann.height);
      const lw = ann.strokeWidth * scaleFactor;
      const rad = (ann.cornerRadius ?? 4) * scaleFactor;
      const style = getShapeFillStyle(ann);

      drawRoundedRectPath(ctx, x, y, w, h, rad);
      if (style === "solid") {
        ctx.fillStyle = ann.color;
        ctx.fill();
      } else {
        if (style === "tinted") {
          ctx.fillStyle = ann.color;
          ctx.globalAlpha = 0.22;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = lw;
        ctx.stroke();
      }
      break;
    }

    case "ellipse": {
      const cx = ann.x + ann.width / 2;
      const cy = ann.y + ann.height / 2;
      const rx = Math.abs(ann.width / 2);
      const ry = Math.abs(ann.height / 2);
      const style = getShapeFillStyle(ann);

      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      if (style === "solid") {
        ctx.fillStyle = ann.color;
        ctx.fill();
      } else {
        if (style === "tinted") {
          ctx.fillStyle = ann.color;
          ctx.globalAlpha = 0.22;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = ann.strokeWidth * scaleFactor;
        ctx.stroke();
      }
      break;
    }

    case "line": {
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.strokeWidth * scaleFactor;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(ann.start.x, ann.start.y);
      ctx.lineTo(ann.end.x, ann.end.y);
      ctx.stroke();
      break;
    }

    case "arrow": {
      const lw = ann.strokeWidth * scaleFactor;
      const angle = Math.atan2(
        ann.end.y - ann.start.y,
        ann.end.x - ann.start.x,
      );
      const dist = Math.hypot(
        ann.end.x - ann.start.x,
        ann.end.y - ann.start.y,
      );
      const headLen = Math.min(
        dist * 0.75,
        Math.max(14 * scaleFactor, lw * 4.2),
      );
      const shaftEndX = ann.end.x - Math.cos(angle) * (headLen * 0.62);
      const shaftEndY = ann.end.y - Math.sin(angle) * (headLen * 0.62);

      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(ann.start.x, ann.start.y);
      ctx.lineTo(shaftEndX, shaftEndY);
      ctx.stroke();

      // Sleek filled arrowhead
      ctx.beginPath();
      ctx.moveTo(ann.end.x, ann.end.y);
      ctx.lineTo(
        ann.end.x - headLen * Math.cos(angle - Math.PI / 6.5),
        ann.end.y - headLen * Math.sin(angle - Math.PI / 6.5),
      );
      ctx.lineTo(
        ann.end.x - headLen * Math.cos(angle + Math.PI / 6.5),
        ann.end.y - headLen * Math.sin(angle + Math.PI / 6.5),
      );
      ctx.closePath();
      ctx.fill();
      break;
    }

    case "ruler": {
      const dx = ann.end.x - ann.start.x;
      const dy = ann.end.y - ann.start.y;
      const distPx = Math.hypot(dx, dy);
      const distPt = Math.round(distPx / Math.max(1, scaleFactor));
      const angle = Math.atan2(dy, dx);
      const perp = angle + Math.PI / 2;
      const cap = 6 * scaleFactor;

      ctx.strokeStyle = ann.color;
      ctx.lineWidth = Math.max(1.5, 1.5 * scaleFactor);
      ctx.beginPath();
      ctx.moveTo(ann.start.x, ann.start.y);
      ctx.lineTo(ann.end.x, ann.end.y);
      // End caps
      ctx.moveTo(
        ann.start.x - Math.cos(perp) * cap,
        ann.start.y - Math.sin(perp) * cap,
      );
      ctx.lineTo(
        ann.start.x + Math.cos(perp) * cap,
        ann.start.y + Math.sin(perp) * cap,
      );
      ctx.moveTo(
        ann.end.x - Math.cos(perp) * cap,
        ann.end.y - Math.sin(perp) * cap,
      );
      ctx.lineTo(
        ann.end.x + Math.cos(perp) * cap,
        ann.end.y + Math.sin(perp) * cap,
      );
      ctx.stroke();

      // Centered pill label
      const label = `${distPt}pt`;
      const fontSize = Math.round(11 * scaleFactor);
      ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      const metrics = ctx.measureText(label);
      const padX = 6 * scaleFactor;
      const padY = 3 * scaleFactor;
      const bw = metrics.width + padX * 2;
      const bh = fontSize + padY * 2;
      const mx = (ann.start.x + ann.end.x) / 2;
      const my = (ann.start.y + ann.end.y) / 2;

      drawRoundedRectPath(
        ctx,
        mx - bw / 2,
        my - bh / 2,
        bw,
        bh,
        4 * scaleFactor,
      );
      ctx.fillStyle = ann.color;
      ctx.fill();
      ctx.fillStyle = getContrastingTextColor(ann.color);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, mx, my + 0.5 * scaleFactor);
      break;
    }

    case "pen": {
      if (ann.points.length < 2) break;
      ctx.strokeStyle = ann.color;
      ctx.lineWidth =
        (ann.highlighter ? ann.strokeWidth * 4 : ann.strokeWidth) * scaleFactor;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (ann.highlighter) {
        ctx.globalAlpha = 0.36;
      }
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      if (ann.points.length === 2) {
        ctx.lineTo(ann.points[1].x, ann.points[1].y);
      } else {
        // Quadratic Bézier midpoint smoothing for fluid Apple-Pencil-like strokes
        for (let i = 1; i < ann.points.length - 1; i++) {
          const midX = (ann.points[i].x + ann.points[i + 1].x) / 2;
          const midY = (ann.points[i].y + ann.points[i + 1].y) / 2;
          ctx.quadraticCurveTo(ann.points[i].x, ann.points[i].y, midX, midY);
        }
        const last = ann.points[ann.points.length - 1];
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
      break;
    }

    case "text": {
      if (!ann.text.trim()) break;
      const fontPx = Math.round(ann.fontSize * scaleFactor);
      const isBadge = ann.textStyle === "badge";
      const m = measureTextAnnotation(ann, scaleFactor);
      const lines = ann.text.split("\n");

      if (isBadge) {
        drawRoundedRectPath(
          ctx,
          ann.x,
          ann.y,
          m.width,
          m.height,
          Math.min(8 * scaleFactor, m.height * 0.28),
        );
        ctx.fillStyle = ann.color;
        ctx.fill();
      }

      ctx.font = `600 ${fontPx}px ${TEXT_FONT_FAMILY}`;
      ctx.fillStyle = isBadge ? getContrastingTextColor(ann.color) : ann.color;
      ctx.textBaseline = "top";
      if (!isBadge && isLightHexColor(ann.color)) {
        ctx.shadowColor = "rgba(0, 0, 0, 0.42)";
        ctx.shadowBlur = 1.5 * scaleFactor;
        ctx.shadowOffsetY = 0.75 * scaleFactor;
      }
      lines.forEach((line, idx) => {
        ctx.fillText(line, ann.x + m.padX, ann.y + m.padY + idx * m.lineHeight);
      });
      break;
    }

    case "counter": {
      const r = ann.radius * scaleFactor;
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.22)";
      ctx.shadowBlur = 4 * scaleFactor;
      ctx.shadowOffsetY = 1.5 * scaleFactor;
      ctx.beginPath();
      ctx.arc(ann.x, ann.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ann.color;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(ann.x, ann.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 2 * scaleFactor;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();

      ctx.fillStyle = getContrastingTextColor(ann.color);
      ctx.font = `700 ${Math.round(r * 1.15)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(ann.number), ann.x, ann.y + 0.5 * scaleFactor);
      break;
    }
  }

  ctx.restore();
}

function drawDraftBoxGuide(
  ctx: CanvasRenderingContext2D,
  ann: Extract<
    Annotation,
    { type: "blur" | "pixelate" | "blackout" | "spotlight" }
  >,
  scaleFactor: number,
  zoom: number,
) {
  const x = Math.min(ann.x, ann.x + ann.width);
  const y = Math.min(ann.y, ann.y + ann.height);
  const w = Math.abs(ann.width);
  const h = Math.abs(ann.height);
  if (w < 2 && h < 2) return;

  const uiUnit = scaleFactor / Math.max(0.15, zoom);

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 2 * uiUnit;
  ctx.strokeRect(x, y, w, h);

  ctx.strokeStyle = "#007AFF";
  ctx.lineWidth = 1.25 * uiUnit;
  ctx.setLineDash([4 * uiUnit, 3 * uiUnit]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  // Dimension pill
  const label = `${Math.round(w / scaleFactor)}×${Math.round(h / scaleFactor)}`;
  const fontSize = Math.round(11 * uiUnit);
  ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const tw = ctx.measureText(label).width;
  const padX = 6 * uiUnit;
  const padY = 3 * uiUnit;
  const bw = tw + padX * 2;
  const bh = fontSize + padY * 2;
  const pillX = x + w / 2 - bw / 2;
  const pillY = Math.max(4 * uiUnit, y - bh - 6 * uiUnit);

  drawRoundedRectPath(ctx, pillX, pillY, bw, bh, 5 * uiUnit);
  ctx.fillStyle = "rgba(20, 20, 22, 0.84)";
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, pillX + bw / 2, pillY + bh / 2 + 0.5 * uiUnit);
  ctx.restore();
}

export function getAnnotationBounds(
  ann: Annotation,
  scaleFactor: number,
): { x: number; y: number; w: number; h: number } {
  switch (ann.type) {
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
    case "blackout":
    case "spotlight":
      return {
        x: Math.min(ann.x, ann.x + ann.width),
        y: Math.min(ann.y, ann.y + ann.height),
        w: Math.abs(ann.width),
        h: Math.abs(ann.height),
      };
    case "arrow":
    case "line":
    case "ruler": {
      const x1 = Math.min(ann.start.x, ann.end.x);
      const y1 = Math.min(ann.start.y, ann.end.y);
      const x2 = Math.max(ann.start.x, ann.end.x);
      const y2 = Math.max(ann.start.y, ann.end.y);
      return {
        x: x1,
        y: y1,
        w: Math.max(1, x2 - x1),
        h: Math.max(1, y2 - y1),
      };
    }
    case "pen": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of ann.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
      return {
        x: minX,
        y: minY,
        w: Math.max(8, maxX - minX),
        h: Math.max(8, maxY - minY),
      };
    }
    case "text": {
      const m = measureTextAnnotation(ann, scaleFactor);
      return {
        x: ann.x,
        y: ann.y,
        w: m.width,
        h: m.height,
      };
    }
    case "counter": {
      const r = ann.radius * scaleFactor;
      return { x: ann.x - r, y: ann.y - r, w: r * 2, h: r * 2 };
    }
  }
}

export function getAnnotationHandles(
  ann: Annotation,
  scaleFactor: number,
): AnnotationHandle[] {
  switch (ann.type) {
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
    case "blackout":
    case "spotlight": {
      const b = getAnnotationBounds(ann, scaleFactor);
      const mx = b.x + b.w / 2;
      const my = b.y + b.h / 2;
      return [
        { id: "nw", x: b.x, y: b.y, cursor: "nwse-resize" },
        { id: "n", x: mx, y: b.y, cursor: "ns-resize" },
        { id: "ne", x: b.x + b.w, y: b.y, cursor: "nesw-resize" },
        { id: "e", x: b.x + b.w, y: my, cursor: "ew-resize" },
        { id: "se", x: b.x + b.w, y: b.y + b.h, cursor: "nwse-resize" },
        { id: "s", x: mx, y: b.y + b.h, cursor: "ns-resize" },
        { id: "sw", x: b.x, y: b.y + b.h, cursor: "nesw-resize" },
        { id: "w", x: b.x, y: my, cursor: "ew-resize" },
      ];
    }
    case "arrow":
    case "line":
    case "ruler":
      return [
        { id: "start", x: ann.start.x, y: ann.start.y, cursor: "grab" },
        { id: "end", x: ann.end.x, y: ann.end.y, cursor: "grab" },
      ];
    default:
      return [];
  }
}

export function hitTestHandle(
  ann: Annotation,
  pt: Point,
  scaleFactor: number,
  zoom = 1,
): AnnotationHandle | null {
  const handles = getAnnotationHandles(ann, scaleFactor);
  if (handles.length === 0) return null;
  const hitRadius = (9 * scaleFactor) / Math.max(0.15, zoom);
  let best: AnnotationHandle | null = null;
  let bestDist = hitRadius;
  for (const h of handles) {
    const d = Math.hypot(pt.x - h.x, pt.y - h.y);
    if (d <= bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return best;
}

function drawSelectionAndHandles(
  ctx: CanvasRenderingContext2D,
  ann: Annotation,
  scaleFactor: number,
  zoom: number,
) {
  const uiUnit = scaleFactor / Math.max(0.15, zoom);
  const handles = getAnnotationHandles(ann, scaleFactor);

  ctx.save();
  if (ann.type === "arrow" || ann.type === "line" || ann.type === "ruler") {
    // Subtle crisp guide line between endpoints
    ctx.strokeStyle = "rgba(0, 122, 255, 0.45)";
    ctx.lineWidth = 1.25 * uiUnit;
    ctx.setLineDash([4 * uiUnit, 3 * uiUnit]);
    ctx.beginPath();
    ctx.moveTo(ann.start.x, ann.start.y);
    ctx.lineTo(ann.end.x, ann.end.y);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    const b = getAnnotationBounds(ann, scaleFactor);
    const pad =
      ann.type === "text" || ann.type === "counter" || ann.type === "pen"
        ? 4 * uiUnit
        : 0;
    ctx.strokeStyle = "#007AFF";
    ctx.lineWidth = 1.5 * uiUnit;
    if (ann.type === "text" || ann.type === "counter" || ann.type === "pen") {
      ctx.setLineDash([4 * uiUnit, 3 * uiUnit]);
    }
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.setLineDash([]);
  }

  // Crisp macOS-style circular handles
  const r = 4.5 * uiUnit;
  for (const h of handles) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.24)";
    ctx.shadowBlur = 3 * uiUnit;
    ctx.shadowOffsetY = 1 * uiUnit;
    ctx.beginPath();
    ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#007AFF";
    ctx.lineWidth = 1.6 * uiUnit;
    ctx.stroke();
  }
  ctx.restore();
}

function pointToSegmentDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq),
  );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function hitTestSingleAnnotation(
  ann: Annotation,
  pt: Point,
  scaleFactor: number,
  zoom = 1,
): boolean {
  const uiUnit = scaleFactor / Math.max(0.15, zoom);
  const tol = Math.max(7 * uiUnit, (ann.strokeWidth * scaleFactor) / 2 + 4 * uiUnit);

  switch (ann.type) {
    case "arrow":
    case "line":
    case "ruler":
      return pointToSegmentDist(pt, ann.start, ann.end) <= tol + 2 * uiUnit;

    case "pen": {
      const penTol =
        ((ann.highlighter ? ann.strokeWidth * 4 : ann.strokeWidth) *
          scaleFactor) /
          2 +
        6 * uiUnit;
      for (let i = 0; i < ann.points.length - 1; i++) {
        if (pointToSegmentDist(pt, ann.points[i], ann.points[i + 1]) <= penTol) {
          return true;
        }
      }
      return false;
    }

    case "rect": {
      const b = getAnnotationBounds(ann, scaleFactor);
      const style = getShapeFillStyle(ann);
      if (style !== "outline") {
        return (
          pt.x >= b.x - tol &&
          pt.x <= b.x + b.w + tol &&
          pt.y >= b.y - tol &&
          pt.y <= b.y + b.h + tol
        );
      }
      // Hollow rectangle: hit-test the 4 borders so inner annotations remain clickable
      const onOuter =
        pt.x >= b.x - tol &&
        pt.x <= b.x + b.w + tol &&
        pt.y >= b.y - tol &&
        pt.y <= b.y + b.h + tol;
      if (!onOuter) return false;
      const insideHole =
        pt.x > b.x + tol &&
        pt.x < b.x + b.w - tol &&
        pt.y > b.y + tol &&
        pt.y < b.y + b.h - tol;
      return !insideHole;
    }

    case "ellipse": {
      const b = getAnnotationBounds(ann, scaleFactor);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const rx = Math.max(1, b.w / 2);
      const ry = Math.max(1, b.h / 2);
      const style = getShapeFillStyle(ann);
      const normOuter =
        ((pt.x - cx) / (rx + tol)) ** 2 + ((pt.y - cy) / (ry + tol)) ** 2;
      if (normOuter > 1) return false;
      if (style !== "outline") return true;
      const irx = Math.max(0.5, rx - tol);
      const iry = Math.max(0.5, ry - tol);
      const normInner = ((pt.x - cx) / irx) ** 2 + ((pt.y - cy) / iry) ** 2;
      return normInner >= 1;
    }

    case "counter": {
      const r = ann.radius * scaleFactor + 5 * uiUnit;
      return Math.hypot(pt.x - ann.x, pt.y - ann.y) <= r;
    }

    case "blur":
    case "pixelate":
    case "blackout":
    case "spotlight":
    case "text": {
      const b = getAnnotationBounds(ann, scaleFactor);
      const pad = 4 * uiUnit;
      return (
        pt.x >= b.x - pad &&
        pt.x <= b.x + b.w + pad &&
        pt.y >= b.y - pad &&
        pt.y <= b.y + b.h + pad
      );
    }
  }
}

export function hitTestAnnotation(
  annotations: Annotation[],
  pt: Point,
  scaleFactor: number,
  zoom = 1,
): Annotation | null {
  // Prioritize vector/text annotations above redaction/spotlight layers (matches visual z-order)
  for (let i = annotations.length - 1; i >= 0; i--) {
    const ann = annotations[i];
    if (
      ann.type === "blur" ||
      ann.type === "pixelate" ||
      ann.type === "blackout" ||
      ann.type === "spotlight"
    ) {
      continue;
    }
    if (hitTestSingleAnnotation(ann, pt, scaleFactor, zoom)) {
      return ann;
    }
  }
  for (let i = annotations.length - 1; i >= 0; i--) {
    const ann = annotations[i];
    if (
      ann.type !== "blur" &&
      ann.type !== "pixelate" &&
      ann.type !== "blackout" &&
      ann.type !== "spotlight"
    ) {
      continue;
    }
    if (hitTestSingleAnnotation(ann, pt, scaleFactor, zoom)) {
      return ann;
    }
  }
  return null;
}

export function normalizeAnnotation(ann: Annotation): Annotation {
  switch (ann.type) {
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
    case "blackout":
    case "spotlight": {
      const x = Math.min(ann.x, ann.x + ann.width);
      const y = Math.min(ann.y, ann.y + ann.height);
      const width = Math.abs(ann.width);
      const height = Math.abs(ann.height);
      return { ...ann, x, y, width, height };
    }
    default:
      return ann;
  }
}

export function resizeAnnotationByHandle(
  orig: Annotation,
  handle: ResizeHandleId,
  pt: Point,
  shiftKey: boolean,
): Annotation {
  if (orig.type === "arrow" || orig.type === "line" || orig.type === "ruler") {
    const anchor = handle === "start" ? orig.end : orig.start;
    let target = pt;
    if (shiftKey) {
      const dx = pt.x - anchor.x;
      const dy = pt.y - anchor.y;
      const angle =
        Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const dist = Math.hypot(dx, dy);
      target = {
        x: anchor.x + Math.cos(angle) * dist,
        y: anchor.y + Math.sin(angle) * dist,
      };
    }
    return handle === "start"
      ? { ...orig, start: target }
      : { ...orig, end: target };
  }

  if (
    orig.type === "rect" ||
    orig.type === "ellipse" ||
    orig.type === "blur" ||
    orig.type === "pixelate" ||
    orig.type === "blackout" ||
    orig.type === "spotlight"
  ) {
    const ox1 = Math.min(orig.x, orig.x + orig.width);
    const oy1 = Math.min(orig.y, orig.y + orig.height);
    const ox2 = Math.max(orig.x, orig.x + orig.width);
    const oy2 = Math.max(orig.y, orig.y + orig.height);

    let x1 = ox1;
    let y1 = oy1;
    let x2 = ox2;
    let y2 = oy2;

    if (handle.includes("w")) x1 = pt.x;
    if (handle.includes("e")) x2 = pt.x;
    if (handle.includes("n")) y1 = pt.y;
    if (handle.includes("s")) y2 = pt.y;

    // Optional Shift-lock to square on corner drags
    const isCorner = handle.length === 2;
    if (shiftKey && isCorner) {
      const anchorX = handle.includes("w") ? ox2 : ox1;
      const anchorY = handle.includes("n") ? oy2 : oy1;
      const dx = pt.x - anchorX;
      const dy = pt.y - anchorY;
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      const nx = anchorX + Math.sign(dx || 1) * side;
      const ny = anchorY + Math.sign(dy || 1) * side;
      x1 = Math.min(anchorX, nx);
      x2 = Math.max(anchorX, nx);
      y1 = Math.min(anchorY, ny);
      y2 = Math.max(anchorY, ny);
    }

    const nx = Math.min(x1, x2);
    const ny = Math.min(y1, y2);
    const nw = Math.max(4, Math.abs(x2 - x1));
    const nh = Math.max(4, Math.abs(y2 - y1));

    return {
      ...orig,
      x: nx,
      y: ny,
      width: nw,
      height: nh,
    };
  }

  return orig;
}

export function translateAnnotation(
  ann: Annotation,
  dx: number,
  dy: number,
): Annotation {
  switch (ann.type) {
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
    case "blackout":
    case "spotlight":
    case "text":
    case "counter":
      return { ...ann, x: ann.x + dx, y: ann.y + dy };
    case "arrow":
    case "line":
    case "ruler":
      return {
        ...ann,
        start: { x: ann.start.x + dx, y: ann.start.y + dy },
        end: { x: ann.end.x + dx, y: ann.end.y + dy },
      };
    case "pen":
      return {
        ...ann,
        points: ann.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      };
  }
}

export async function exportCompositePng(
  sourceImage: HTMLImageElement | HTMLCanvasElement,
  imgWidth: number,
  imgHeight: number,
  scaleFactor: number,
  backdrop: BackdropConfig,
  annotations: Annotation[],
): Promise<Uint8Array> {
  const layout = computeLayout(imgWidth, imgHeight, backdrop, scaleFactor);
  const offscreen = document.createElement("canvas");
  offscreen.width = layout.canvasWidth;
  offscreen.height = layout.canvasHeight;
  const ctx = offscreen.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to initialize export canvas");
  }
  renderComposite(
    ctx,
    sourceImage,
    imgWidth,
    imgHeight,
    scaleFactor,
    backdrop,
    annotations,
    null,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    offscreen.toBlob(resolve, "image/png"),
  );
  if (!blob) {
    throw new Error("Failed to encode composite PNG");
  }
  const ab = await blob.arrayBuffer();
  return new Uint8Array(ab);
}
