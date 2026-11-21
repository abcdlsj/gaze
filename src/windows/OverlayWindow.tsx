import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Crop,
  Pin,
  Save,
  ScrollText,
  X,
  AppWindow,
} from "lucide-react";
import {
  cancelOverlay,
  completeAreaSelection,
  completeWindowSelection,
  copyTextToClipboard,
  getOverlayImageBytes,
  getOverlaySession,
  startScrollingCapture,
} from "../lib/tauri";
import type { OverlaySessionInfo, WindowRect } from "../types";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragHandle =
  | "create"
  | "move"
  | "nw"
  | "ne"
  | "sw"
  | "se"
  | "n"
  | "s"
  | "e"
  | "w";

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

export function OverlayWindow() {
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [session, setSession] = useState<OverlaySessionInfo | null>(null);
  const [mode, setMode] = useState<"area" | "window" | "scrolling">("area");
  const [ready, setReady] = useState(false);

  const [cursor, setCursor] = useState<{ x: number; y: number }>({ x: -1, y: -1 });
  const [hoverHex, setHoverHex] = useState<string>("#000000");
  const [toast, setToast] = useState<string | null>(null);

  const [selection, setSelection] = useState<Rect | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef<{
    handle: DragHandle;
    startX: number;
    startY: number;
    origRect: Rect;
  } | null>(null);

  // Load frozen display snapshot and metadata immediately
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const [info, pngBytes] = await Promise.all([
          getOverlaySession(),
          getOverlayImageBytes(),
        ]);
        if (!active) return;
        setSession(info);
        setMode(info.initial_mode);

        const blob = new Blob([pngBytes as Uint8Array<ArrayBuffer>], {
          type: "image/png",
        });
        objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (!active) return;
          imgRef.current = img;
          const canvas = bgCanvasRef.current;
          if (canvas) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx?.drawImage(img, 0, 0);
          }
          setReady(true);
        };
        img.src = objectUrl;
      } catch (err) {
        console.error("Failed to initialize overlay:", err);
        void cancelOverlay();
      }
    })();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  // Coordinate mapping between CSS viewport coords and xcap monitor coords
  const cssToMonitor = useCallback(
    (x: number, y: number) => {
      if (!session) return { x, y };
      const sx = session.monitor_width / window.innerWidth;
      const sy = session.monitor_height / window.innerHeight;
      return { x: x * sx, y: y * sy };
    },
    [session],
  );

  const monitorToCss = useCallback(
    (rect: WindowRect) => {
      if (!session) return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      const sx = window.innerWidth / session.monitor_width;
      const sy = window.innerHeight / session.monitor_height;
      return {
        x: rect.x * sx,
        y: rect.y * sy,
        w: rect.width * sx,
        h: rect.height * sy,
      };
    },
    [session],
  );

  // Hovered window in window capture mode
  const hoveredWindow = useMemo(() => {
    if (mode !== "window" || !session || cursor.x < 0) return null;
    const m = cssToMonitor(cursor.x, cursor.y);
    return (
      session.windows.find(
        (w) =>
          m.x >= w.x &&
          m.x <= w.x + w.width &&
          m.y >= w.y &&
          m.y <= w.y + w.height,
      ) ?? null
    );
  }, [mode, session, cursor, cssToMonitor]);

  // Update pixel loupe and live hex color under cursor
  useEffect(() => {
    if (!ready || cursor.x < 0 || !bgCanvasRef.current) return;
    const bg = bgCanvasRef.current;
    const ctx = bg.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const px = Math.min(
      bg.width - 1,
      Math.max(0, Math.floor((cursor.x / window.innerWidth) * bg.width)),
    );
    const py = Math.min(
      bg.height - 1,
      Math.max(0, Math.floor((cursor.y / window.innerHeight) * bg.height)),
    );

    const pixel = ctx.getImageData(px, py, 1, 1).data;
    setHoverHex(rgbToHex(pixel[0], pixel[1], pixel[2]));

    const loupe = loupeCanvasRef.current;
    if (loupe) {
      const lctx = loupe.getContext("2d");
      if (lctx) {
        const sampleSize = 11;
        const half = Math.floor(sampleSize / 2);
        lctx.imageSmoothingEnabled = false;
        lctx.clearRect(0, 0, loupe.width, loupe.height);
        lctx.fillStyle = "#18181b";
        lctx.fillRect(0, 0, loupe.width, loupe.height);
        lctx.drawImage(
          bg,
          px - half,
          py - half,
          sampleSize,
          sampleSize,
          0,
          0,
          loupe.width,
          loupe.height,
        );
        // Subtle pixel grid
        const cell = loupe.width / sampleSize;
        lctx.strokeStyle = "rgba(255,255,255,0.16)";
        lctx.lineWidth = 1;
        for (let i = 1; i < sampleSize; i++) {
          const p = Math.round(i * cell) + 0.5;
          lctx.beginPath();
          lctx.moveTo(p, 0);
          lctx.lineTo(p, loupe.height);
          lctx.stroke();
          lctx.beginPath();
          lctx.moveTo(0, p);
          lctx.lineTo(loupe.width, p);
          lctx.stroke();
        }
        // Center pixel reticle
        lctx.strokeStyle = "#0A84FF";
        lctx.lineWidth = 2;
        lctx.strokeRect(half * cell + 1, half * cell + 1, cell - 2, cell - 2);
      }
    }
  }, [ready, cursor]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1200);
  }, []);

  const commitSelection = useCallback(
    async (action: "default" | "editor" | "copy" | "save" | "pin") => {
      if (!selection || !session) return;
      const p1 = cssToMonitor(selection.x, selection.y);
      const p2 = cssToMonitor(
        selection.x + selection.w,
        selection.y + selection.h,
      );
      await completeAreaSelection(
        p1.x,
        p1.y,
        Math.max(2, p2.x - p1.x),
        Math.max(2, p2.y - p1.y),
        action,
      );
    },
    [selection, session, cssToMonitor],
  );

  const launchScroll = useCallback(
    async (rect: Rect) => {
      if (!session) return;
      const p1 = cssToMonitor(rect.x, rect.y);
      const p2 = cssToMonitor(rect.x + rect.w, rect.y + rect.h);
      await startScrollingCapture(
        p1.x,
        p1.y,
        Math.max(32, p2.x - p1.x),
        Math.max(48, p2.y - p1.y),
      );
    },
    [session, cssToMonitor],
  );

  // Global keyboard shortcuts inside overlay
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void cancelOverlay();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        void copyTextToClipboard(hoverHex).then(() =>
          showToast(`Copied ${hoverHex}`),
        );
        return;
      }
      if (e.key === " " && !selection) {
        e.preventDefault();
        setMode((m) => (m === "window" ? "area" : "window"));
        return;
      }
      if (selection && !isDragging) {
        if (e.key === "Enter") {
          e.preventDefault();
          if (mode === "scrolling") {
            void launchScroll(selection);
          } else {
            void commitSelection("default");
          }
          return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
          e.preventDefault();
          void commitSelection("copy");
          return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void commitSelection("save");
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    hoverHex,
    selection,
    isDragging,
    mode,
    commitSelection,
    launchScroll,
    showToast,
  ]);

  const startDrag = (handle: DragHandle, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.button === 2) {
      void cancelOverlay();
      return;
    }
    if (mode === "window") {
      if (hoveredWindow) {
        void completeWindowSelection(hoveredWindow.id);
      }
      return;
    }

    const baseRect =
      handle === "create"
        ? { x: e.clientX, y: e.clientY, w: 0, h: 0 }
        : selection ?? { x: e.clientX, y: e.clientY, w: 0, h: 0 };

    dragStateRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      origRect: baseRect,
    };
    if (handle === "create") {
      setSelection({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    }
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    setCursor({ x: e.clientX, y: e.clientY });

    const drag = dragStateRef.current;
    if (!drag) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const o = drag.origRect;

    if (drag.handle === "create") {
      const x = Math.min(drag.startX, e.clientX);
      const y = Math.min(drag.startY, e.clientY);
      const w = Math.abs(e.clientX - drag.startX);
      const h = Math.abs(e.clientY - drag.startY);
      setSelection({ x, y, w, h });
      return;
    }

    if (drag.handle === "move") {
      const x = Math.max(0, Math.min(window.innerWidth - o.w, o.x + dx));
      const y = Math.max(0, Math.min(window.innerHeight - o.h, o.y + dy));
      setSelection({ ...o, x, y });
      return;
    }

    let x1 = o.x;
    let y1 = o.y;
    let x2 = o.x + o.w;
    let y2 = o.y + o.h;

    if (drag.handle.includes("w")) x1 = o.x + dx;
    if (drag.handle.includes("e")) x2 = o.x + o.w + dx;
    if (drag.handle.includes("n")) y1 = o.y + dy;
    if (drag.handle.includes("s")) y2 = o.y + o.h + dy;

    setSelection({
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.max(8, Math.abs(x2 - x1)),
      h: Math.max(8, Math.abs(y2 - y1)),
    });
  };

  const handleMouseUp = () => {
    if (!dragStateRef.current) return;
    const wasCreate = dragStateRef.current.handle === "create";
    dragStateRef.current = null;
    setIsDragging(false);

    if (selection && (selection.w < 6 || selection.h < 6)) {
      setSelection(null);
      return;
    }

    // In direct Scrolling mode, start auto-scrolling immediately once the user drags a region!
    if (wasCreate && mode === "scrolling" && selection && selection.w >= 32 && selection.h >= 48) {
      void launchScroll(selection);
    }
  };

  const winBox = hoveredWindow ? monitorToCss(hoveredWindow) : null;

  // Position floating action toolbar below selection, or flip above if near bottom edge
  const actionBarPos = useMemo(() => {
    if (!selection || isDragging || selection.w < 6 || selection.h < 6) {
      return null;
    }
    const barW = 350;
    const barH = 40;
    const left = Math.max(
      12,
      Math.min(
        window.innerWidth - barW - 12,
        selection.x + selection.w - barW,
      ),
    );
    const belowY = selection.y + selection.h + 10;
    const top =
      belowY + barH < window.innerHeight - 10
        ? belowY
        : Math.max(12, selection.y - barH - 10);
    return { left, top };
  }, [selection, isDragging]);

  // Loupe positioning near cursor (flips away from screen edges)
  const loupePos = useMemo(() => {
    if (cursor.x < 0) return null;
    const w = 132;
    const h = 152;
    const left =
      cursor.x + 22 + w < window.innerWidth
        ? cursor.x + 22
        : cursor.x - w - 22;
    const top =
      cursor.y + 22 + h < window.innerHeight
        ? cursor.y + 22
        : cursor.y - h - 22;
    return { left, top };
  }, [cursor]);

  const showLoupe = ready && cursor.x >= 0 && (!selection || isDragging);

  return (
    <div
      className={`relative h-full w-full overflow-hidden ${
        mode === "window" ? "cursor-pointer" : "cursor-crosshair"
      }`}
      onMouseDown={(e) => startDrag("create", e)}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => {
        e.preventDefault();
        void cancelOverlay();
      }}
    >
      {/* Full-bleed frozen desktop canvas */}
      <canvas
        ref={bgCanvasRef}
        className="pointer-events-none block h-full w-full"
      />

      {/* Dimmed veil with crisp cutout for active selection or hovered window */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundColor:
            selection || winBox ? "transparent" : "rgba(0, 0, 0, 0.24)",
        }}
      />

      {/* Top mode switcher pill */}
      {!isDragging && !selection && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute left-1/2 top-5 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-neutral-900/80 p-1 text-[12px] text-white shadow-xl backdrop-blur-md"
        >
          <button
            type="button"
            onClick={() => setMode("area")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
              mode === "area"
                ? "bg-[#0A84FF] font-medium text-white"
                : "text-neutral-300 hover:text-white"
            }`}
          >
            <Crop className="h-3.5 w-3.5" />
            <span>Area</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("window")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
              mode === "window"
                ? "bg-[#0A84FF] font-medium text-white"
                : "text-neutral-300 hover:text-white"
            }`}
          >
            <AppWindow className="h-3.5 w-3.5" />
            <span>Window</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("scrolling")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
              mode === "scrolling"
                ? "bg-[#0A84FF] font-medium text-white"
                : "text-neutral-300 hover:text-white"
            }`}
          >
            <ScrollText className="h-3.5 w-3.5" />
            <span>Scroll</span>
          </button>
          <span className="mx-1 h-3.5 w-px bg-white/15" />
          <span className="px-2 text-[11px] text-neutral-400">
            Tab: Copy color · Esc: Cancel
          </span>
        </div>
      )}

      {/* Window highlight in Window mode */}
      {mode === "window" && winBox && hoveredWindow && (
        <div
          className="pointer-events-none absolute z-20 border-2 border-[#0A84FF] bg-[#0A84FF]/10 transition-all duration-75"
          style={{
            left: winBox.x,
            top: winBox.y,
            width: winBox.w,
            height: winBox.h,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.28)",
          }}
        >
          <div className="absolute left-2 top-2 rounded-md bg-neutral-900/85 px-2.5 py-1 text-[11.5px] font-medium text-white shadow">
            {hoveredWindow.app_name}
            {hoveredWindow.title ? ` — ${hoveredWindow.title}` : ""} (
            {hoveredWindow.width}×{hoveredWindow.height})
          </div>
        </div>
      )}

      {/* Active area/scroll selection frame */}
      {selection && selection.w > 2 && selection.h > 2 && (
        <div
          onMouseDown={(e) => startDrag("move", e)}
          onDoubleClick={() => {
            if (mode === "scrolling") {
              void launchScroll(selection);
            } else {
              void commitSelection("default");
            }
          }}
          className="absolute z-20 cursor-move border-[1.5px] border-[#0A84FF]"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.w,
            height: selection.h,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.34)",
          }}
        >
          {/* Dimension pill */}
          <div className="pointer-events-none absolute -top-7 left-0 flex items-center gap-1.5 rounded-md bg-neutral-900/85 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white shadow">
            <span>
              {Math.round(selection.w)} × {Math.round(selection.h)} pt
            </span>
          </div>

          {/* 8 resize handles */}
          {(
            [
              ["nw", "-left-1.5 -top-1.5 cursor-nwse-resize"],
              ["ne", "-right-1.5 -top-1.5 cursor-nesw-resize"],
              ["sw", "-left-1.5 -bottom-1.5 cursor-nesw-resize"],
              ["se", "-right-1.5 -bottom-1.5 cursor-nwse-resize"],
              ["n", "left-1/2 -top-1.5 -translate-x-1/2 cursor-ns-resize"],
              ["s", "left-1/2 -bottom-1.5 -translate-x-1/2 cursor-ns-resize"],
              ["w", "-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize"],
              ["e", "-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize"],
            ] as [DragHandle, string][]
          ).map(([handle, cls]) => (
            <div
              key={handle}
              onMouseDown={(e) => startDrag(handle, e)}
              className={`absolute h-2.5 w-2.5 rounded-full border border-[#0A84FF] bg-white shadow-xs ${cls}`}
            />
          ))}
        </div>
      )}

      {/* Floating Action Bar after selection */}
      {actionBarPos && selection && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: actionBarPos.left, top: actionBarPos.top }}
          className="absolute z-30 flex items-center gap-1 rounded-xl border border-neutral-200/80 bg-white/95 p-1 shadow-xl backdrop-blur-md"
        >
          <button
            type="button"
            onClick={() => void commitSelection("copy")}
            title="Copy to Clipboard (⌘C)"
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-100"
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Copy</span>
          </button>
          <button
            type="button"
            onClick={() => void commitSelection("save")}
            title="Save to Folder (⌘S)"
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-100"
          >
            <Save className="h-3.5 w-3.5" />
            <span>Save</span>
          </button>
          <button
            type="button"
            onClick={() => void commitSelection("pin")}
            title="Pin on Screen"
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-100"
          >
            <Pin className="h-3.5 w-3.5" />
            <span>Pin</span>
          </button>
          <button
            type="button"
            onClick={() => void launchScroll(selection)}
            title="Auto-Scroll Long Screenshot"
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-100"
          >
            <ScrollText className="h-3.5 w-3.5" />
            <span>Scroll</span>
          </button>
          <span className="mx-0.5 h-4 w-px bg-neutral-200" />
          <button
            type="button"
            onClick={() => void commitSelection("default")}
            title="Open in Editor (Enter)"
            className="flex items-center gap-1 rounded-lg bg-[#0A84FF] px-3 py-1.5 text-[12px] font-medium text-white shadow-xs transition hover:bg-blue-600"
          >
            <Check className="h-3.5 w-3.5" />
            <span>Edit</span>
          </button>
          <button
            type="button"
            onClick={() => void cancelOverlay()}
            title="Cancel (Esc)"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Pixel Magnifier Loupe + Live Hex */}
      {showLoupe && loupePos && (
        <div
          style={{ left: loupePos.left, top: loupePos.top }}
          className="pointer-events-none absolute z-30 w-[132px] overflow-hidden rounded-xl border border-white/20 bg-neutral-900/90 shadow-2xl backdrop-blur-md"
        >
          <canvas
            ref={loupeCanvasRef}
            width={132}
            height={110}
            className="block h-[110px] w-[132px]"
          />
          <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] text-white">
            <span className="flex items-center gap-1.5 font-mono">
              <span
                className="h-2.5 w-2.5 rounded-full border border-white/40"
                style={{ backgroundColor: hoverHex }}
              />
              {hoverHex}
            </span>
            <span className="text-[10px] text-neutral-400">Tab</span>
          </div>
        </div>
      )}

      {/* Subtle toast feedback */}
      {toast && (
        <div className="pointer-events-none absolute bottom-8 left-1/2 z-40 -translate-x-1/2 rounded-full bg-neutral-900/90 px-4 py-1.5 text-[12px] font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
