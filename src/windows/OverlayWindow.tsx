import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import {
  AppWindow,
  Copy,
  Crop,
  Monitor,
  Pin,
  Save,
  ScrollText,
  SquarePen,
  X,
} from "lucide-react";
import { Tooltip } from "../components/ui/Tooltip";
import { isMacPlatform } from "../lib/hotkeys";
import {
  cancelOverlay,
  completeAreaSelection,
  completeWindowSelection,
  copyTextToClipboard,
  getOverlayImageRaw,
  getOverlaySession,
  getOverlayWindows,
  showOverlayWindow,
  startScrollingCapture,
  switchOverlayMonitor,
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
  const loupeWrapRef = useRef<HTMLDivElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeDotRef = useRef<HTMLSpanElement | null>(null);
  const loupeHexRef = useRef<HTMLSpanElement | null>(null);
  const hoverHexRef = useRef<string>("#000000");

  // Raw RGBA pixels held directly in memory for O(1) zero-GPU-stall loupe + color sampling
  const rawPixelsRef = useRef<{
    w: number;
    h: number;
    data: Uint8ClampedArray;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const latestCursorRef = useRef<{ x: number; y: number }>({ x: -1, y: -1 });

  const [session, setSession] = useState<OverlaySessionInfo | null>(null);
  const [windowsList, setWindowsList] = useState<WindowRect[]>([]);
  const [hoveredWindow, setHoveredWindow] = useState<WindowRect | null>(null);
  const [mode, setMode] = useState<"area" | "window" | "scrolling">("area");
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [selection, setSelection] = useState<Rect | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef<{
    handle: DragHandle;
    startX: number;
    startY: number;
    origRect: Rect;
  } | null>(null);

  const resetOverlayVisuals = useCallback(() => {
    dragStateRef.current = null;
    rawPixelsRef.current = null;
    if (loupeWrapRef.current) {
      loupeWrapRef.current.style.opacity = "0";
    }
    const canvas = bgCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    setSelection(null);
    setHoveredWindow(null);
    setIsDragging(false);
    setReady(false);
  }, []);

  const loadSessionSnapshot = useCallback(
    async (incomingInfo?: OverlaySessionInfo) => {
      try {
        dragStateRef.current = null;
        if (loupeWrapRef.current) {
          loupeWrapRef.current.style.opacity = "0";
        }

        const [info, raw] = await Promise.all([
          incomingInfo ? Promise.resolve(incomingInfo) : getOverlaySession(),
          getOverlayImageRaw(),
        ]);

        rawPixelsRef.current = {
          w: raw.width,
          h: raw.height,
          data: raw.data,
        };

        const canvas = bgCanvasRef.current;
        if (canvas) {
          canvas.width = raw.width;
          canvas.height = raw.height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            const imgData = new ImageData(
              raw.data as Uint8ClampedArray<ArrayBuffer>,
              raw.width,
              raw.height,
            );
            ctx.putImageData(imgData, 0, 0);
            // Force synchronous backing-store flush before revealing the window.
            ctx.getImageData(0, 0, 1, 1);
          }
        }

        // Commit React DOM updates synchronously so no stale selection or mode ever flashes.
        flushSync(() => {
          setSelection(null);
          setHoveredWindow(null);
          setIsDragging(false);
          setSession(info);
          setMode(info.initial_mode);
          setWindowsList(info.windows);
          setReady(true);
        });

        // Yield one short tick (not rAF, which macOS WKWebView suspends on hidden windows)
        // so WebKit composites the fresh canvas & DOM into the CALayer before NSWindow maps.
        await new Promise<void>((resolve) => setTimeout(resolve, 24));
        await showOverlayWindow();
      } catch (err) {
        if (incomingInfo) {
          console.error("Failed to load overlay session:", err);
        }
        // Ignore when pre-warmed at app boot with no active session yet
      }
    },
    [],
  );

  // Register listeners FIRST, then check for an already-active session so there is zero startup race
  useEffect(() => {
    let active = true;
    let unlistenReady: (() => void) | null = null;
    let unlistenHidden: (() => void) | null = null;

    void (async () => {
      const [fnReady, fnHidden] = await Promise.all([
        listen<OverlaySessionInfo>("overlay-session-ready", (event) => {
          void loadSessionSnapshot(event.payload);
        }),
        listen("overlay-hidden", () => {
          resetOverlayVisuals();
        }),
      ]);
      if (!active) {
        fnReady();
        fnHidden();
        return;
      }
      unlistenReady = fnReady;
      unlistenHidden = fnHidden;
      await loadSessionSnapshot();
    })();

    return () => {
      active = false;
      if (unlistenReady) unlistenReady();
      if (unlistenHidden) unlistenHidden();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [loadSessionSnapshot, resetOverlayVisuals]);

  // Lazy-fetch window list only when switching to Window mode
  useEffect(() => {
    if (mode !== "window" || !session || windowsList.length > 0) return;
    void getOverlayWindows()
      .then((list) => setWindowsList(list))
      .catch(() => {});
  }, [mode, session, windowsList.length]);

  const cssToMonitor = useCallback(
    (x: number, y: number) => {
      if (!session) return { x, y };
      const sx = session.monitor_width / Math.max(1, window.innerWidth);
      const sy = session.monitor_height / Math.max(1, window.innerHeight);
      return { x: x * sx, y: y * sy };
    },
    [session],
  );

  const monitorToCss = useCallback(
    (rect: WindowRect) => {
      if (!session)
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      const sx = window.innerWidth / Math.max(1, session.monitor_width);
      const sy = window.innerHeight / Math.max(1, session.monitor_height);
      return {
        x: rect.x * sx,
        y: rect.y * sy,
        w: rect.width * sx,
        h: rect.height * sy,
      };
    },
    [session],
  );

  // 120fps zero-React-rerender loupe updater driven by requestAnimationFrame + raw RGBA buffer
  const updateLoupeFrame = useCallback(() => {
    rafRef.current = null;
    const raw = rawPixelsRef.current;
    const wrap = loupeWrapRef.current;
    const loupe = loupeCanvasRef.current;
    const { x: cx, y: cy } = latestCursorRef.current;
    if (!raw || !wrap || !loupe || cx < 0) return;

    const px = Math.min(
      raw.w - 1,
      Math.max(0, Math.floor((cx / Math.max(1, window.innerWidth)) * raw.w)),
    );
    const py = Math.min(
      raw.h - 1,
      Math.max(0, Math.floor((cy / Math.max(1, window.innerHeight)) * raw.h)),
    );

    const cIdx = (py * raw.w + px) * 4;
    const hex = rgbToHex(raw.data[cIdx], raw.data[cIdx + 1], raw.data[cIdx + 2]);
    if (hex !== hoverHexRef.current) {
      hoverHexRef.current = hex;
      if (loupeDotRef.current) loupeDotRef.current.style.backgroundColor = hex;
      if (loupeHexRef.current) loupeHexRef.current.textContent = hex;
    }

    // Position loupe cleanly via GPU translate3d
    const w = 132;
    const h = 148;
    const left = cx + 22 + w < window.innerWidth ? cx + 22 : cx - w - 22;
    const top = cy + 22 + h < window.innerHeight ? cy + 22 : cy - h - 22;
    wrap.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    wrap.style.opacity = "1";

    // Draw crisp 11×11 pixel neighborhood directly from raw RGBA array (no GPU readback!)
    const lctx = loupe.getContext("2d");
    if (!lctx) return;
    const sampleSize = 11;
    const half = 5;
    const cellW = loupe.width / sampleSize;
    const cellH = loupe.height / sampleSize;

    for (let dy = -half; dy <= half; dy++) {
      const sy = py + dy;
      for (let dx = -half; dx <= half; dx++) {
        const sx = px + dx;
        if (sx >= 0 && sx < raw.w && sy >= 0 && sy < raw.h) {
          const i = (sy * raw.w + sx) * 4;
          lctx.fillStyle = `rgb(${raw.data[i]},${raw.data[i + 1]},${raw.data[i + 2]})`;
        } else {
          lctx.fillStyle = "#18181b";
        }
        lctx.fillRect(
          Math.floor((dx + half) * cellW),
          Math.floor((dy + half) * cellH),
          Math.ceil(cellW),
          Math.ceil(cellH),
        );
      }
    }

    // Fine grid lines
    lctx.strokeStyle = "rgba(255,255,255,0.14)";
    lctx.lineWidth = 1;
    lctx.beginPath();
    for (let i = 1; i < sampleSize; i++) {
      const gx = Math.round(i * cellW) + 0.5;
      const gy = Math.round(i * cellH) + 0.5;
      lctx.moveTo(gx, 0);
      lctx.lineTo(gx, loupe.height);
      lctx.moveTo(0, gy);
      lctx.lineTo(loupe.width, gy);
    }
    lctx.stroke();

    // Center pixel reticle
    lctx.strokeStyle = "#007AFF";
    lctx.lineWidth = 2;
    lctx.strokeRect(
      Math.floor(half * cellW) + 1,
      Math.floor(half * cellH) + 1,
      Math.ceil(cellW) - 2,
      Math.ceil(cellH) - 2,
    );
  }, []);

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
      setSelection(null);
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
      setSelection(null);
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
        setSelection(null);
        void cancelOverlay();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const hex = hoverHexRef.current;
        void copyTextToClipboard(hex).then(() => showToast(`Copied ${hex}`));
        return;
      }
      if (e.key === " " && !selection) {
        e.preventDefault();
        setMode((m) => (m === "window" ? "area" : "window"));
        return;
      }
      if (
        e.key.toLowerCase() === "d" &&
        !selection &&
        session &&
        session.monitor_count > 1
      ) {
        e.preventDefault();
        void switchOverlayMonitor(mode);
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
    session,
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
      setSelection(null);
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
    latestCursorRef.current = { x: e.clientX, y: e.clientY };

    // Schedule 120fps loupe update without React re-render
    if (ready && (!selection || isDragging)) {
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(updateLoupeFrame);
      }
    }

    // Window mode hover detection (only updates state when hovered window ID changes)
    if (mode === "window" && session && windowsList.length > 0) {
      const m = cssToMonitor(e.clientX, e.clientY);
      const hit =
        windowsList.find(
          (w) =>
            m.x >= w.x &&
            m.x <= w.x + w.width &&
            m.y >= w.y &&
            m.y <= w.y + w.height,
        ) ?? null;
      if (hit?.id !== hoveredWindow?.id) {
        setHoveredWindow(hit);
      }
    }

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

    if (
      wasCreate &&
      mode === "scrolling" &&
      selection &&
      selection.w >= 32 &&
      selection.h >= 48
    ) {
      void launchScroll(selection);
    }
  };

  const winBox = hoveredWindow ? monitorToCss(hoveredWindow) : null;

  const modKey = isMacPlatform() ? "⌘" : "Ctrl+";

  const actionBarPos = useMemo(() => {
    if (!selection || isDragging || selection.w < 6 || selection.h < 6) {
      return null;
    }
    const barW = 408;
    const barH = 42;
    const left = Math.max(
      14,
      Math.min(window.innerWidth - barW - 14, selection.x + selection.w - barW),
    );
    const belowY = selection.y + selection.h + 10;
    // Keep safely below macOS Menu Bar / Notch (>= 54px) and above bottom edge.
    const top =
      belowY + barH < window.innerHeight - 14
        ? Math.max(54, belowY)
        : Math.max(54, selection.y - barH - 10);
    const tooltipSide: "top" | "bottom" =
      top + barH + 40 < window.innerHeight ? "bottom" : "top";
    return { left, top, tooltipSide };
  }, [selection, isDragging]);

  const hideLoupe = !ready || (selection !== null && !isDragging);

  return (
    <div
      style={{ opacity: ready ? 1 : 0 }}
      className={`relative h-full w-full overflow-hidden ${
        mode === "window" ? "cursor-pointer" : "cursor-crosshair"
      }`}
      onMouseDown={(e) => startDrag("create", e)}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => {
        e.preventDefault();
        setSelection(null);
        void cancelOverlay();
      }}
    >
      {/* Full-bleed frozen desktop canvas */}
      <canvas
        ref={bgCanvasRef}
        className="pointer-events-none block h-full w-full"
      />

      {/* Dimmed veil */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundColor:
            selection || winBox ? "transparent" : "rgba(0, 0, 0, 0.22)",
        }}
      />

      {/* Frosted glass top mode switcher pill — placed at top-14 (56px) safely below macOS Menu Bar & Notch */}
      {ready && !isDragging && !selection && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="animate-pop-in absolute left-1/2 top-14 z-30 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-0.5 rounded-full bg-[#161618]/88 p-[4px] text-[12px] text-white antialiased shadow-[0_12px_34px_-4px_rgba(0,0,0,0.42),inset_0_0.5px_0_rgba(255,255,255,0.14)] ring-1 ring-white/[0.14] backdrop-blur-2xl"
        >
          <button
            type="button"
            onClick={() => setMode("area")}
            className={`flex h-[28px] cursor-pointer items-center gap-1.5 rounded-full px-3 tracking-[-0.01em] transition-all duration-100 ${
              mode === "area"
                ? "mac-blue-fill font-medium text-white"
                : "text-white/75 hover:bg-white/[0.08] hover:text-white"
            }`}
          >
            <Crop className="h-[13.5px] w-[13.5px] stroke-[1.9]" />
            <span>Area</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("window")}
            className={`flex h-[28px] cursor-pointer items-center gap-1.5 rounded-full px-3 tracking-[-0.01em] transition-all duration-100 ${
              mode === "window"
                ? "mac-blue-fill font-medium text-white"
                : "text-white/75 hover:bg-white/[0.08] hover:text-white"
            }`}
          >
            <AppWindow className="h-[13.5px] w-[13.5px] stroke-[1.9]" />
            <span>Window</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("scrolling")}
            className={`flex h-[28px] cursor-pointer items-center gap-1.5 rounded-full px-3 tracking-[-0.01em] transition-all duration-100 ${
              mode === "scrolling"
                ? "mac-blue-fill font-medium text-white"
                : "text-white/75 hover:bg-white/[0.08] hover:text-white"
            }`}
          >
            <ScrollText className="h-[13.5px] w-[13.5px] stroke-[1.9]" />
            <span>Scroll</span>
          </button>
          {session && session.monitor_count > 1 && (
            <>
              <span className="mx-1 h-3.5 w-px bg-white/[0.14]" />
              <Tooltip label="Switch Display" shortcut="D" side="bottom">
                <button
                  type="button"
                  onClick={() => void switchOverlayMonitor(mode)}
                  className="flex h-[28px] cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-white/85 transition hover:bg-white/[0.1] hover:text-white"
                >
                  <Monitor className="h-[13.5px] w-[13.5px] stroke-[1.8]" />
                  <span className="font-mono text-[11px] tabular-nums">
                    {session.monitor_index + 1}/{session.monitor_count}
                  </span>
                </button>
              </Tooltip>
            </>
          )}
          <span className="mx-1 h-3.5 w-px bg-white/[0.14]" />
          <div className="flex items-center gap-2.5 whitespace-nowrap px-2 text-[11px] text-white/65">
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded-[4px] bg-white/[0.13] px-1.5 py-[1.5px] font-mono text-[10px] font-medium leading-none text-white/85">
                Tab
              </kbd>
              <span>Color</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded-[4px] bg-white/[0.13] px-1.5 py-[1.5px] font-mono text-[10px] font-medium leading-none text-white/85">
                Esc
              </kbd>
              <span>Cancel</span>
            </span>
          </div>
        </div>
      )}

      {/* Window highlight in Window mode */}
      {mode === "window" && winBox && hoveredWindow && (
        <div
          className="pointer-events-none absolute z-20 rounded-[6px] border-2 border-[#007AFF] bg-[#007AFF]/10"
          style={{
            left: winBox.x,
            top: winBox.y,
            width: winBox.w,
            height: winBox.h,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.28)",
          }}
        >
          <div className="absolute left-2.5 top-2.5 flex max-w-[380px] items-center gap-1.5 rounded-[8px] bg-[#161618]/88 px-2.5 py-1 text-[11.5px] font-medium tracking-[-0.01em] text-white/95 antialiased shadow-[0_6px_20px_rgba(0,0,0,0.34)] ring-1 ring-white/[0.14] backdrop-blur-xl">
            <span className="truncate">
              {hoveredWindow.app_name}
              {hoveredWindow.title ? ` — ${hoveredWindow.title}` : ""}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] font-normal tabular-nums text-white/60">
              {hoveredWindow.width}×{hoveredWindow.height}
            </span>
          </div>
        </div>
      )}

      {/* Crisp double-hairline selection frame */}
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
          className="absolute z-20 cursor-move border-[1.5px] border-[#007AFF] ring-1 ring-inset ring-white/65"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.w,
            height: selection.h,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.32)",
          }}
        >
          {/* Dimension pill — flips inside selection when near top edge so it never clips off-screen */}
          <div
            className={`pointer-events-none absolute left-0 flex items-center rounded-[7px] bg-[#161618]/88 px-2 py-[3px] font-mono text-[11px] font-medium tabular-nums tracking-[-0.01em] text-white/95 antialiased shadow-[0_6px_18px_rgba(0,0,0,0.3)] ring-1 ring-white/[0.14] backdrop-blur-xl ${
              selection.y < 52 ? "left-2 top-2" : "-top-7"
            }`}
          >
            <span>
              {Math.round(selection.w)} × {Math.round(selection.h)}
            </span>
            <span className="ml-1 font-sans text-[10px] font-normal text-white/55">
              pt
            </span>
          </div>

          {/* 8 tactile resize handles */}
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
              className={`absolute h-2.5 w-2.5 rounded-full border-[1.5px] border-[#007AFF] bg-white shadow-xs ${cls}`}
            />
          ))}
        </div>
      )}

      {/* Floating Frosted Action Bar */}
      {actionBarPos && selection && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: actionBarPos.left, top: actionBarPos.top }}
          className="animate-pop-in absolute z-30 flex items-center gap-0.5 rounded-[13px] bg-white/93 p-[5px] shadow-[0_14px_38px_-6px_rgba(0,0,0,0.28),0_2px_8px_rgba(0,0,0,0.1),inset_0_0.5px_0_rgba(255,255,255,0.95)] ring-1 ring-black/[0.09] backdrop-blur-2xl"
        >
          <Tooltip
            label="Copy to Clipboard"
            shortcut={`${modKey}C`}
            side={actionBarPos.tooltipSide}
            align="left"
          >
            <button
              type="button"
              onClick={() => void commitSelection("copy")}
              className="group flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-medium tracking-[-0.01em] text-[#1C1C1F] transition-all duration-100 hover:bg-black/[0.06] hover:text-[#09090B] active:scale-[0.97]"
            >
              <Copy className="h-[14px] w-[14px] stroke-[1.8] text-[#52525B] transition-colors group-hover:text-[#141416]" />
              <span>Copy</span>
            </button>
          </Tooltip>
          <Tooltip
            label="Save to Folder"
            shortcut={`${modKey}S`}
            side={actionBarPos.tooltipSide}
          >
            <button
              type="button"
              onClick={() => void commitSelection("save")}
              className="group flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-medium tracking-[-0.01em] text-[#1C1C1F] transition-all duration-100 hover:bg-black/[0.06] hover:text-[#09090B] active:scale-[0.97]"
            >
              <Save className="h-[14px] w-[14px] stroke-[1.8] text-[#52525B] transition-colors group-hover:text-[#141416]" />
              <span>Save</span>
            </button>
          </Tooltip>
          <Tooltip label="Pin on Screen" side={actionBarPos.tooltipSide}>
            <button
              type="button"
              onClick={() => void commitSelection("pin")}
              className="group flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-medium tracking-[-0.01em] text-[#1C1C1F] transition-all duration-100 hover:bg-black/[0.06] hover:text-[#09090B] active:scale-[0.97]"
            >
              <Pin className="h-[14px] w-[14px] stroke-[1.8] text-[#52525B] transition-colors group-hover:text-[#141416]" />
              <span>Pin</span>
            </button>
          </Tooltip>
          <Tooltip
            label="Scrolling Capture"
            side={actionBarPos.tooltipSide}
          >
            <button
              type="button"
              onClick={() => void launchScroll(selection)}
              className="group flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-medium tracking-[-0.01em] text-[#1C1C1F] transition-all duration-100 hover:bg-black/[0.06] hover:text-[#09090B] active:scale-[0.97]"
            >
              <ScrollText className="h-[14px] w-[14px] stroke-[1.8] text-[#52525B] transition-colors group-hover:text-[#141416]" />
              <span>Scroll</span>
            </button>
          </Tooltip>

          <span className="mx-1 h-[18px] w-px bg-black/[0.09]" />

          <Tooltip
            label="Open in Editor"
            shortcut="↵"
            side={actionBarPos.tooltipSide}
          >
            <button
              type="button"
              onClick={() => void commitSelection("default")}
              className="mac-blue-fill flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[8px] px-3 text-[12px] font-medium tracking-[-0.01em] text-white antialiased transition-all duration-100 hover:brightness-105 active:scale-[0.97]"
            >
              <SquarePen className="h-[14px] w-[14px] stroke-[1.9]" />
              <span>Edit</span>
            </button>
          </Tooltip>
          <Tooltip
            label="Cancel"
            shortcut="Esc"
            side={actionBarPos.tooltipSide}
            align="right"
          >
            <button
              type="button"
              onClick={() => {
                setSelection(null);
                void cancelOverlay();
              }}
              aria-label="Cancel screenshot"
              className="flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-[8px] text-[#71717A] transition-all duration-100 hover:bg-black/[0.06] hover:text-[#141416] active:scale-[0.95]"
            >
              <X className="h-[14.5px] w-[14.5px] stroke-[1.9]" />
            </button>
          </Tooltip>
        </div>
      )}

      {/* GPU-translated 120fps Pixel Magnifier Loupe */}
      <div
        ref={loupeWrapRef}
        style={{
          opacity: 0,
          display: hideLoupe ? "none" : "block",
          willChange: "transform",
        }}
        className="pointer-events-none fixed left-0 top-0 z-30 w-[132px] overflow-hidden rounded-xl bg-[#161618]/92 antialiased shadow-[0_12px_36px_rgba(0,0,0,0.42)] ring-1 ring-white/[0.18] backdrop-blur-xl"
      >
        <canvas
          ref={loupeCanvasRef}
          width={132}
          height={110}
          className="block h-[110px] w-[132px]"
        />
        <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] text-white">
          <span className="flex items-center gap-1.5 font-mono font-medium">
            <span
              ref={loupeDotRef}
              className="h-2.5 w-2.5 rounded-full ring-1 ring-white/40"
              style={{ backgroundColor: "#000000" }}
            />
            <span ref={loupeHexRef}>#000000</span>
          </span>
          <kbd className="rounded-[3px] bg-white/[0.14] px-1 py-[1px] font-mono text-[9.5px] leading-none text-white/75">
            Tab
          </kbd>
        </div>
      </div>

      {/* Subtle toast feedback */}
      {toast && (
        <div className="animate-pop-in pointer-events-none absolute bottom-8 left-1/2 z-40 -translate-x-1/2 rounded-full bg-[#161618]/92 px-4 py-1.5 text-[12px] font-medium tracking-[-0.01em] text-white antialiased shadow-xl ring-1 ring-white/[0.14] backdrop-blur-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
