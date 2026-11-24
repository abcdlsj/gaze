import type { Annotation, BackdropConfig, Point } from "../types";

export function isLightHexColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 195;
}

export interface CompositeLayout {
  canvasWidth: number;
  canvasHeight: number;
  offsetX: number;
  offsetY: number;
}

export function computeLayout(
  imgWidth: number,
  imgHeight: number,
  backdrop: BackdropConfig,
): CompositeLayout {
  if (!backdrop.enabled) {
    return {
      canvasWidth: imgWidth,
      canvasHeight: imgHeight,
      offsetX: 0,
      offsetY: 0,
    };
  }
  const pad = Math.max(0, Math.round(backdrop.padding));
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
    // Parse simple preset gradients "linear-gradient(135deg, #c1, #c2)"
    const colors = bg.match(/#[0-9a-fA-F]{6}/g);
    if (colors && colors.length >= 2) {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, colors[0]);
      if (colors.length >= 3) {
        grad.addColorStop(0.5, colors[1]);
        grad.addColorStop(1, colors[2]);
      } else {
        grad.addColorStop(1, colors[1]);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      return;
    }
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
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
) {
  const layout = computeLayout(imgWidth, imgHeight, backdrop);
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
        backdrop.cornerRadius,
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
      backdrop.cornerRadius,
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

  for (const ann of annotations) {
    drawAnnotation(ctx, sourceImage, ann, scaleFactor);
    if (ann.id === selectedId) {
      drawSelectionOutline(ctx, ann, scaleFactor);
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
      const rx = Math.round(Math.min(ann.x, ann.x + ann.width));
      const ry = Math.round(Math.min(ann.y, ann.y + ann.height));
      const rw = Math.max(1, Math.round(Math.abs(ann.width)));
      const rh = Math.max(1, Math.round(Math.abs(ann.height)));

      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.filter = `blur(${Math.max(4, ann.strength * scaleFactor)}px)`;
      ctx.drawImage(sourceImage, 0, 0);
      ctx.filter = "none";
      break;
    }

    case "pixelate": {
      const rx = Math.round(Math.min(ann.x, ann.x + ann.width));
      const ry = Math.round(Math.min(ann.y, ann.y + ann.height));
      const rw = Math.max(1, Math.round(Math.abs(ann.width)));
      const rh = Math.max(1, Math.round(Math.abs(ann.height)));

      const blockSize = Math.max(6, Math.round(ann.strength * scaleFactor));
      const smallW = Math.max(1, Math.ceil(rw / blockSize));
      const smallH = Math.max(1, Math.ceil(rh / blockSize));

      const tmp = document.createElement("canvas");
      tmp.width = smallW;
      tmp.height = smallH;
      const tctx = tmp.getContext("2d");
      if (tctx) {
        tctx.imageSmoothingEnabled = true;
        tctx.drawImage(sourceImage, rx, ry, rw, rh, 0, 0, smallW, smallH);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, smallW, smallH, rx, ry, rw, rh);
        ctx.imageSmoothingEnabled = true;
      }
      break;
    }

    case "rect": {
      const x = Math.min(ann.x, ann.x + ann.width);
      const y = Math.min(ann.y, ann.y + ann.height);
      const w = Math.abs(ann.width);
      const h = Math.abs(ann.height);
      const lw = ann.strokeWidth * scaleFactor;
      const rad = (ann.cornerRadius ?? 4) * scaleFactor;

      drawRoundedRectPath(ctx, x, y, w, h, rad);
      if (ann.filled) {
        ctx.fillStyle = ann.color;
        ctx.globalAlpha = 0.22;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = lw;
      ctx.stroke();
      break;
    }

    case "ellipse": {
      const cx = ann.x + ann.width / 2;
      const cy = ann.y + ann.height / 2;
      const rx = Math.abs(ann.width / 2);
      const ry = Math.abs(ann.height / 2);
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      if (ann.filled) {
        ctx.fillStyle = ann.color;
        ctx.globalAlpha = 0.22;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.strokeWidth * scaleFactor;
      ctx.stroke();
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
      const headLen = Math.max(14 * scaleFactor, lw * 4.5);
      const shaftEndX = ann.end.x - Math.cos(angle) * (headLen * 0.65);
      const shaftEndY = ann.end.y - Math.sin(angle) * (headLen * 0.65);

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

      drawRoundedRectPath(ctx, mx - bw / 2, my - bh / 2, bw, bh, 4 * scaleFactor);
      ctx.fillStyle = ann.color;
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, mx, my + 0.5 * scaleFactor);
      break;
    }

    case "pen": {
      if (ann.points.length < 2) break;
      ctx.strokeStyle = ann.color;
      ctx.lineWidth =
        (ann.highlighter ? ann.strokeWidth * 3.5 : ann.strokeWidth) *
        scaleFactor;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (ann.highlighter) {
        ctx.globalAlpha = 0.35;
      }
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      for (let i = 1; i < ann.points.length; i++) {
        ctx.lineTo(ann.points[i].x, ann.points[i].y);
      }
      ctx.stroke();
      break;
    }

    case "text": {
      if (!ann.text.trim()) break;
      const fontPx = Math.round(ann.fontSize * scaleFactor);
      ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif`;
      ctx.fillStyle = ann.color;
      ctx.textBaseline = "top";
      // Add a tight directional shadow only for light colors (e.g., white/yellow) so dark & saturated text stays razor-sharp
      if (isLightHexColor(ann.color)) {
        ctx.shadowColor = "rgba(0, 0, 0, 0.42)";
        ctx.shadowBlur = 1.5 * scaleFactor;
        ctx.shadowOffsetY = 0.75 * scaleFactor;
      }
      const lines = ann.text.split("\n");
      const lh = fontPx * 1.28;
      lines.forEach((line, idx) => {
        ctx.fillText(line, ann.x, ann.y + idx * lh);
      });
      break;
    }

    case "counter": {
      const r = ann.radius * scaleFactor;
      ctx.beginPath();
      ctx.arc(ann.x, ann.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ann.color;
      ctx.fill();
      ctx.lineWidth = 2 * scaleFactor;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${Math.round(r * 1.15)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(ann.number), ann.x, ann.y + 0.5 * scaleFactor);
      break;
    }
  }

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
        x: x1 - 6 * scaleFactor,
        y: y1 - 6 * scaleFactor,
        w: Math.max(12 * scaleFactor, x2 - x1 + 12 * scaleFactor),
        h: Math.max(12 * scaleFactor, y2 - y1 + 12 * scaleFactor),
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
      return { x: minX, y: minY, w: Math.max(8, maxX - minX), h: Math.max(8, maxY - minY) };
    }
    case "text": {
      const lines = ann.text.split("\n");
      const maxLen = Math.max(1, ...lines.map((l) => l.length));
      const fontPx = ann.fontSize * scaleFactor;
      return {
        x: ann.x,
        y: ann.y,
        w: Math.max(30 * scaleFactor, maxLen * fontPx * 0.62),
        h: Math.max(fontPx * 1.3, lines.length * fontPx * 1.28),
      };
    }
    case "counter": {
      const r = ann.radius * scaleFactor;
      return { x: ann.x - r, y: ann.y - r, w: r * 2, h: r * 2 };
    }
  }
}

function drawSelectionOutline(
  ctx: CanvasRenderingContext2D,
  ann: Annotation,
  scaleFactor: number,
) {
  const b = getAnnotationBounds(ann, scaleFactor);
  const pad = 5 * scaleFactor;
  ctx.save();
  ctx.strokeStyle = "#0A84FF";
  ctx.lineWidth = 1.5 * scaleFactor;
  ctx.setLineDash([5 * scaleFactor, 4 * scaleFactor]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.restore();
}

export function hitTestAnnotation(
  annotations: Annotation[],
  pt: Point,
  scaleFactor: number,
): Annotation | null {
  const tol = 8 * scaleFactor;
  for (let i = annotations.length - 1; i >= 0; i--) {
    const ann = annotations[i];
    const b = getAnnotationBounds(ann, scaleFactor);
    if (
      pt.x >= b.x - tol &&
      pt.x <= b.x + b.w + tol &&
      pt.y >= b.y - tol &&
      pt.y <= b.y + b.h + tol
    ) {
      return ann;
    }
  }
  return null;
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
  const layout = computeLayout(imgWidth, imgHeight, backdrop);
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
