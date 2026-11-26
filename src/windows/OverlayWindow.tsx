import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import {
  Copy,
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
  | "pending"
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

const DRAG_THRESHOLD_PX = 4;

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

function findWindowAtMonitorPoint(
  windows: WindowRect[],
  mx: number,
  my: number,
): WindowRect | null {
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (mx >= w.x && mx <= w.x + w.width && my >= w.y && my <= w.y + w.height) {
      return w;
    }
  }
  return null;
}

export function OverlayWindow() {
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeWrapRef = useRef<HTMLDivElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeDotRef = useRef<HTMLSpanElement | null>(null);
  const loupeHexRef = useRef<HTMLSpanElement | null>(null);
  const hoverHexRef = useRef<string>("#000000");

  // Monotonic session sequence guard prevents stale hide / async fetch races.
  const activeSeqRef = useRef<number>(0);

  // Raw RGBA pixels held directly in memory for O(1) zero-GPU-stall loupe + color sampling.
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
  const [isScrolling, setIsScrolling] = useState(false);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [selection, setSelection] = useState<Rect | null>(null);
  const [selectedWindowId, setSelectedWindowId] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const dragStateRef = useRef<{
    handle: DragHandle;
    startX: number;
    startY: number;
    origRect: Rect;
    candidateWindow: WindowRect | null;
  } | null>(null);

  const resetOverlayVisuals = useCallback((hiddenSeq?: number) => {
    if (
      typeof hiddenSeq === "number" &&
      hiddenSeq < activeSeqRef.current
    ) {
      return;
    }
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
    flushSync(() => {
      setSelection(null);
      setSelectedWindowId(null);
      setHoveredWindow(null);
      setIsDragging(false);
      setReady(false);
    });
  }, []);

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

    const w = 132;
    const h = 148;
    const left = cx + 22 + w < window.innerWidth ? cx + 22 : cx - w - 22;
    const top = cy + 22 + h < window.innerHeight ? cy + 22 : cy - h - 22;
    wrap.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    wrap.style.opacity = "1";

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

    lctx.strokeStyle = "#0095FF";
    lctx.lineWidth = 2;
    lctx.strokeRect(
      Math.floor(half * cellW) + 1,
      Math.floor(half * cellH) + 1,
      Math.ceil(cellW) - 2,
      Math.ceil(cellH) - 2,
    );
  }, []);

  const loadSessionSnapshot = useCallback(
    async (incomingInfo?: OverlaySessionInfo) => {
      try {
        const info = incomingInfo ?? (await getOverlaySession());
        if (info.seq < activeSeqRef.current) {
          return;
        }
        activeSeqRef.current = info.seq;
        dragStateRef.current = null;
        rawPixelsRef.current = null;
        if (loupeWrapRef.current) {
          loupeWrapRef.current.style.opacity = "0";
        }

        const initialHit =
          info.initial_cursor_x !== null && info.initial_cursor_y !== null
            ? findWindowAtMonitorPoint(
                info.windows,
                info.initial_cursor_x,
                info.initial_cursor_y,
              )
            : null;

        if (info.initial_cursor_x !== null && info.initial_cursor_y !== null) {
          const sx = window.innerWidth / Math.max(1, info.monitor_width);
          const sy = window.innerHeight / Math.max(1, info.monitor_height);
          latestCursorRef.current = {
            x: info.initial_cursor_x * sx,
            y: info.initial_cursor_y * sy,
          };
        }

        if (info.has_native_backdrop) {
          // macOS: the frozen desktop CGImage is already rendered natively by CALayer!
          // Commit UI immediately with zero IPC pixel wait so highlight appears instantaneously.
          flushSync(() => {
            setViewport({ w: window.innerWidth, h: window.innerHeight });
            setSelection(null);
            setSelectedWindowId(null);
            setHoveredWindow(initialHit);
            setIsDragging(false);
            setSession(info);
            setIsScrolling(info.initial_mode === "scrolling");
            setWindowsList(info.windows);
            setReady(true);
          });

          // Fetch raw pixels asynchronously in background purely for the 120fps pixel loupe.
          const seq = info.seq;
          void getOverlayImageRaw(seq)
            .then((raw) => {
              if (activeSeqRef.current !== seq) return;
              rawPixelsRef.current = {
                w: raw.width,
                h: raw.height,
                data: raw.data,
              };
              if (latestCursorRef.current.x >= 0 && rafRef.current === null) {
                rafRef.current = requestAnimationFrame(updateLoupeFrame);
              }
            })
            .catch(() => {});
          return;
        }

        // Non-macOS fallback: paint frozen desktop onto canvas before revealing window.
        const raw = await getOverlayImageRaw(info.seq);
        if (activeSeqRef.current !== info.seq) return;

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
            ctx.getImageData(0, 0, 1, 1);
          }
        }

        flushSync(() => {
          setSelection(null);
          setSelectedWindowId(null);
          setHoveredWindow(initialHit);
          setIsDragging(false);
          setSession(info);
          setIsScrolling(info.initial_mode === "scrolling");
          setWindowsList(info.windows);
          setReady(true);
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        await showOverlayWindow();
      } catch (err) {
        if (incomingInfo) {
          console.error("Failed to load overlay session:", err);
        }
      }
    },
    [updateLoupeFrame],
  );

  // Register listeners FIRST, then check for an already-active session so there is zero startup race.
  useEffect(() => {
    let active = true;
    let unlistenReady: (() => void) | null = null;
    let unlistenHidden: (() => void) | null = null;

    void (async () => {
      const [fnReady, fnHidden] = await Promise.all([
        listen<OverlaySessionInfo>("overlay-session-ready", (event) => {
          void loadSessionSnapshot(event.payload);
        }),
        listen<number>("overlay-hidden", (event) => {
          resetOverlayVisuals(event.payload);
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

  const cssToMonitor = useCallback(
    (x: number, y: number) => {
      if (!session) return { x, y };
      const sx = session.monitor_width / Math.max(1, viewport.w);
      const sy = session.monitor_height / Math.max(1, viewport.h);
      return { x: x * sx, y: y * sy };
    },
    [session, viewport.w, viewport.h],
  );

  const monitorToCss = useCallback(
    (rect: WindowRect): Rect => {
      if (!session) {
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      }
      const sx = viewport.w / Math.max(1, session.monitor_width);
      const sy = viewport.h / Math.max(1, session.monitor_height);
      return {
        x: rect.x * sx,
        y: rect.y * sy,
        w: rect.width * sx,
        h: rect.height * sy,
      };
    },
    [session, viewport.w, viewport.h],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1200);
  }, []);

  const commitSelection = useCallback(
    async (action: "default" | "editor" | "copy" | "save" | "pin") => {
      if (!selection || !session) return;
      const winId = selectedWindowId;
      const rect = selection;
      // Clear local DOM synchronously before IPC so the hidden webview is clean for the next capture.
      flushSync(() => {
        setSelection(null);
        setSelectedWindowId(null);
        setHoveredWindow(null);
        setReady(false);
      });
      if (winId !== null) {
        await completeWindowSelection(winId, action);
        return;
      }
      const p1 = cssToMonitor(rect.x, rect.y);
      const p2 = cssToMonitor(rect.x + rect.w, rect.y + rect.h);
      await completeAreaSelection(
        p1.x,
        p1.y,
        Math.max(2, p2.x - p1.x),
        Math.max(2, p2.y - p1.y),
        action,
      );
    },
    [selection, selectedWindowId, session, cssToMonitor],
  );

  const launchScroll = useCallback(
    async (rect: Rect) => {
      if (!session) return;
      const p1 = cssToMonitor(rect.x, rect.y);
      const p2 = cssToMonitor(rect.x + rect.w, rect.y + rect.h);
      flushSync(() => {
        setSelection(null);
        setSelectedWindowId(null);
        setHoveredWindow(null);
        setReady(false);
      });
      await startScrollingCapture(
        p1.x,
        p1.y,
        Math.max(32, p2.x - p1.x),
        Math.max(48, p2.y - p1.y),
      );
    },
    [session, cssToMonitor],
  );

  const dismissOverlay = useCallback(() => {
    flushSync(() => {
      setSelection(null);
      setSelectedWindowId(null);
      setHoveredWindow(null);
      setReady(false);
    });
    void cancelOverlay();
  }, []);

  // Global keyboard shortcuts inside overlay
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissOverlay();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const hex = hoverHexRef.current;
        void copyTextToClipboard(hex).then(() => showToast(`Copied ${hex}`));
        return;
      }
      if (
        e.key.toLowerCase() === "d" &&
        !selection &&
        session &&
        session.monitor_count > 1
      ) {
        e.preventDefault();
        void switchOverlayMonitor(isScrolling ? "scrolling" : "area");
        return;
      }
      if (selection && !isDragging) {
        if (e.key === "Backspace") {
          e.preventDefault();
          setSelection(null);
          setSelectedWindowId(null);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (isScrolling) {
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
    isScrolling,
    commitSelection,
    launchScroll,
    dismissOverlay,
    showToast,
  ]);

  const handleRightClickAction = useCallback(() => {
    if (selection) {
      // Snipaste mental model: right-click clears a locked selection back to live window hover.
      dragStateRef.current = null;
      setIsDragging(false);
      setSelection(null);
      setSelectedWindowId(null);
      const { x, y } = latestCursorRef.current;
      if (x >= 0 && session) {
        const m = cssToMonitor(x, y);
        setHoveredWindow(findWindowAtMonitorPoint(windowsList, m.x, m.y));
      }
      return;
    }
    dismissOverlay();
  }, [selection, session, windowsList, cssToMonitor, dismissOverlay]);

  const startDrag = (handle: DragHandle, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.button === 2) {
      handleRightClickAction();
      return;
    }
    if (e.button !== 0) return;

    if (handle === "pending") {
      // Unified Snipaste interaction: wait for >= 4px movement to promote to Area drag,
      // or snap to the hovered window on mouseUp if clicked without dragging.
      const m = cssToMonitor(e.clientX, e.clientY);
      const hit = findWindowAtMonitorPoint(windowsList, m.x, m.y);
      dragStateRef.current = {
        handle: "pending",
        startX: e.clientX,
        startY: e.clientY,
        origRect: { x: e.clientX, y: e.clientY, w: 0, h: 0 },
        candidateWindow: hit,
      };
      return;
    }

    // Moving or resizing a locked selection converts it into an exact area crop.
    setSelectedWindowId(null);
    const baseRect = selection ?? { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    dragStateRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      origRect: baseRect,
      candidateWindow: null,
    };
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    latestCursorRef.current = { x: e.clientX, y: e.clientY };

    // Schedule 120fps loupe update without React re-render
    if (ready && (!selection || isDragging)) {
      if (rafRef.current === null && rawPixelsRef.current) {
        rafRef.current = requestAnimationFrame(updateLoupeFrame);
      }
    }

    const drag = dragStateRef.current;

    if (!drag) {
      // Live Snipaste window auto-detection whenever hovering without a locked selection.
      if (!selection && session && windowsList.length > 0) {
        const m = cssToMonitor(e.clientX, e.clientY);
        const hit = findWindowAtMonitorPoint(windowsList, m.x, m.y);
        if (hit?.id !== hoveredWindow?.id) {
          setHoveredWindow(hit);
        }
      }
      return;
    }

    if (drag.handle === "pending") {
      const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (dist < DRAG_THRESHOLD_PX) return;
      // Exceeded click threshold: seamlessly promote to Area drag!
      drag.handle = "create";
      setSelectedWindowId(null);
      setIsDragging(true);
    }

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const o = drag.origRect;

    if (drag.handle === "create") {
      const x = Math.max(0, Math.min(drag.startX, e.clientX));
      const y = Math.max(0, Math.min(drag.startY, e.clientY));
      const x2 = Math.min(window.innerWidth, Math.max(drag.startX, e.clientX));
      const y2 = Math.min(window.innerHeight, Math.max(drag.startY, e.clientY));
      setSelection({ x, y, w: x2 - x, h: y2 - y });
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

    if (drag.handle.includes("w")) x1 = Math.max(0, o.x + dx);
    if (drag.handle.includes("e")) x2 = Math.min(window.innerWidth, o.x + o.w + dx);
    if (drag.handle.includes("n")) y1 = Math.max(0, o.y + dy);
    if (drag.handle.includes("s")) y2 = Math.min(window.innerHeight, o.y + o.h + dy);

    setSelection({
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.max(8, Math.abs(x2 - x1)),
      h: Math.max(8, Math.abs(y2 - y1)),
    });
  };

  const handleMouseUp = () => {
    const drag = dragStateRef.current;
    if (!drag) return;
    dragStateRef.current = null;

    if (drag.handle === "pending") {
      // Clean click without dragging: snap selection to the hovered window (or full display).
      if (drag.candidateWindow) {
        const rect = monitorToCss(drag.candidateWindow);
        if (isScrolling) {
          void launchScroll(rect);
          return;
        }
        setSelection(rect);
        setSelectedWindowId(drag.candidateWindow.id);
        setIsDragging(false);
        return;
      }
      // Clicked on desktop / menubar with no app window underneath -> select full display.
      const fullRect: Rect = {
        x: 0,
        y: 0,
        w: window.innerWidth,
        h: window.innerHeight,
      };
      if (isScrolling) {
        void launchScroll(fullRect);
        return;
      }
      setSelection(fullRect);
      setSelectedWindowId(null);
      setIsDragging(false);
      return;
    }

    const wasCreate = drag.handle === "create";
    setIsDragging(false);

    if (selection && (selection.w < 4 || selection.h < 4)) {
      setSelection(null);
      setSelectedWindowId(null);
      return;
    }

    if (
      wasCreate &&
      isScrolling &&
      selection &&
      selection.w >= 32 &&
      selection.h >= 48
    ) {
      void launchScroll(selection);
    }
  };

  const hoverRect = useMemo(() => {
    if (!ready || selection || isDragging) return null;
    if (hoveredWindow) {
      return {
        box: monitorToCss(hoveredWindow),
        label: hoveredWindow.app_name,
        widthPt: hoveredWindow.width,
        heightPt: hoveredWindow.height,
        isFullScreenFallback: false,
      };
    }
    if (!session) return null;
    return {
      box: { x: 0, y: 0, w: viewport.w, h: viewport.h },
      label: session.monitor_name || "Display",
      widthPt: session.monitor_width,
      heightPt: session.monitor_height,
      isFullScreenFallback: true,
    };
  }, [ready, selection, isDragging, hoveredWindow, session, monitorToCss, viewport.w, viewport.h]);

  const modKey = isMacPlatform() ? "⌘" : "Ctrl+";

  const actionBarPos = useMemo(() => {
    if (!selection || isDragging || selection.w < 6 || selection.h < 6) {
      return null;
    }
    const barW = 408;
    const barH = 42;
    const margin = 12;
    const left = Math.max(
      margin,
      Math.min(window.innerWidth - barW - margin, selection.x + selection.w - barW),
    );
    const belowY = selection.y + selection.h + 10;
    const aboveY = selection.y - barH - 10;
    let top: number;
    if (belowY + barH <= window.innerHeight - margin) {
      top = belowY;
    } else if (aboveY >= margin) {
      top = aboveY;
    } else {
      // Full-height / maximized window: tuck neatly inside bottom-right of selection.
      top = Math.max(
        margin,
        Math.min(window.innerHeight - barH - margin, selection.y + selection.h - barH - 12),
      );
    }
    const tooltipSide: "top" | "bottom" =
      top + barH + 40 < window.innerHeight ? "bottom" : "top";
    return { left, top, tooltipSide };
  }, [selection, isDragging]);

  const hideLoupe = !ready || (selection !== null && !isDragging);

  return (
    <div
      style={{ opacity: ready ? 1 : 0 }}
      className="relative h-full w-full cursor-crosshair overflow-hidden select-none"
      onMouseDown={(e) => startDrag("pending", e)}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => {
        e.preventDefault();
        handleRightClickAction();
      }}
    >
      {/* Non-macOS frozen desktop canvas (macOS renders directly via zero-copy native CALayer) */}
      {!session?.has_native_backdrop && (
        <canvas
          ref={bgCanvasRef}
          className="pointer-events-none block h-full w-full"
        />
      )}

      {/* Snipaste-style strong outline-only window highlight (no interior tint fill) + viewfinder corners */}
      {hoverRect && (
        <div
          className="pointer-events-none absolute z-20"
          style={{
            left: hoverRect.isFullScreenFallback ? 2 : hoverRect.box.x,
            top: hoverRect.isFullScreenFallback ? 2 : hoverRect.box.y,
            width: hoverRect.isFullScreenFallback
              ? Math.max(0, hoverRect.box.w - 4)
              : hoverRect.box.w,
            height: hoverRect.isFullScreenFallback
              ? Math.max(0, hoverRect.box.h - 4)
              : hoverRect.box.h,
            border: "2px solid #0095FF",
            borderRadius: hoverRect.isFullScreenFallback ? 2 : 6,
            boxShadow: hoverRect.isFullScreenFallback
              ? "inset 0 0 0 1px rgba(255, 255, 255, 0.5), inset 0 0 12px rgba(0, 149, 255, 0.22)"
              : "inset 0 0 0 1px rgba(255, 255, 255, 0.55), 0 0 0 1px rgba(0, 149, 255, 0.42), 0 0 14px rgba(0, 149, 255, 0.24), 0 0 0 9999px rgba(0, 0, 0, 0.24)",
          }}
        >
          {/* Compact viewfinder corner brackets (┌ ┐ └ ┘) for instant visual lock-on */}
          <span
            className="absolute -left-[2.5px] -top-[2.5px] h-[11px] w-[11px] rounded-tl-[4px] border-l-[3px] border-t-[3px] border-white"
            style={{
              filter:
                "drop-shadow(0 0 2.5px rgba(0, 149, 255, 0.95)) drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.5))",
            }}
          />
          <span
            className="absolute -right-[2.5px] -top-[2.5px] h-[11px] w-[11px] rounded-tr-[4px] border-r-[3px] border-t-[3px] border-white"
            style={{
              filter:
                "drop-shadow(0 0 2.5px rgba(0, 149, 255, 0.95)) drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.5))",
            }}
          />
          <span
            className="absolute -bottom-[2.5px] -left-[2.5px] h-[11px] w-[11px] rounded-bl-[4px] border-b-[3px] border-l-[3px] border-white"
            style={{
              filter:
                "drop-shadow(0 0 2.5px rgba(0, 149, 255, 0.95)) drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.5))",
            }}
          />
          <span
            className="absolute -bottom-[2.5px] -right-[2.5px] h-[11px] w-[11px] rounded-br-[4px] border-b-[3px] border-r-[3px] border-white"
            style={{
              filter:
                "drop-shadow(0 0 2.5px rgba(0, 149, 255, 0.95)) drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.5))",
            }}
          />

          <div
            className={`pointer-events-none absolute flex max-w-[320px] items-center gap-1.5 rounded-[7px] bg-[#161618]/88 px-2 py-[3px] text-[11px] font-medium tracking-[-0.01em] text-white/95 antialiased shadow-[0_6px_18px_rgba(0,0,0,0.34)] ring-1 ring-white/[0.14] backdrop-blur-xl ${
              hoverRect.box.y < 34 ? "left-3 top-3" : "left-0 -top-7"
            }`}
          >
            <span className="truncate">{hoverRect.label}</span>
            <span className="shrink-0 font-mono text-[10.5px] font-normal tabular-nums text-white/65">
              {Math.round(hoverRect.widthPt)} × {Math.round(hoverRect.heightPt)}
            </span>
          </div>
        </div>
      )}

      {/* Minimal hint badge ONLY when explicitly in Scrolling capture mode */}
      {ready && isScrolling && !selection && !isDragging && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-[#161618]/88 px-3.5 py-1.5 text-[12px] font-medium text-white/95 antialiased shadow-[0_10px_28px_rgba(0,0,0,0.38)] ring-1 ring-white/[0.14] backdrop-blur-xl">
          <ScrollText className="h-3.5 w-3.5 text-[#38A8FF]" />
          <span>Scrolling Capture — Click window or drag region</span>
          <kbd className="rounded-[4px] bg-white/[0.14] px-1.5 py-[1px] font-mono text-[10px] text-white/80">
            Esc
          </kbd>
        </div>
      )}

      {/* Subtle multi-display switcher in bottom-right corner only when >1 display */}
      {ready && !selection && !isDragging && session && session.monitor_count > 1 && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute bottom-5 right-5 z-30 flex items-center rounded-full bg-[#161618]/84 p-[3px] text-[11.5px] text-white/90 antialiased shadow-[0_8px_24px_rgba(0,0,0,0.34)] ring-1 ring-white/[0.14] backdrop-blur-xl"
        >
          <Tooltip label="Switch Display" shortcut="D" side="top" align="right">
            <button
              type="button"
              onClick={() =>
                void switchOverlayMonitor(isScrolling ? "scrolling" : "area")
              }
              className="flex h-[26px] cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-white/85 transition hover:bg-white/[0.1] hover:text-white"
            >
              <Monitor className="h-[13px] w-[13px] stroke-[1.8]" />
              <span className="font-mono text-[11px] tabular-nums">
                {session.monitor_index + 1}/{session.monitor_count}
              </span>
              <kbd className="rounded-[4px] bg-white/[0.14] px-1 py-[1px] font-mono text-[9.5px] leading-none text-white/80">
                D
              </kbd>
            </button>
          </Tooltip>
        </div>
      )}

      {/* Crisp double-hairline active selection frame */}
      {selection && selection.w > 2 && selection.h > 2 && (
        <div
          onMouseDown={(e) => startDrag("move", e)}
          onDoubleClick={() => {
            if (isScrolling) {
              void launchScroll(selection);
            } else {
              void commitSelection("default");
            }
          }}
          className="absolute z-20 cursor-move border-[2px] border-[#0095FF] ring-1 ring-inset ring-white/65"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.w,
            height: selection.h,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.30)",
          }}
        >
          {/* Dimension pill — flips inside selection when near top edge so y=0 menubar crops stay visible */}
          <div
            className={`pointer-events-none absolute flex items-center rounded-[7px] bg-[#161618]/88 px-2 py-[3px] font-mono text-[11px] font-medium tabular-nums tracking-[-0.01em] text-white/95 antialiased shadow-[0_6px_18px_rgba(0,0,0,0.3)] ring-1 ring-white/[0.14] backdrop-blur-xl ${
              selection.y < 32 ? "left-2 top-2" : "left-0 -top-7"
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
              className={`absolute h-2.5 w-2.5 rounded-full border-[1.5px] border-[#0095FF] bg-white shadow-xs ${cls}`}
            />
          ))}
        </div>
      )}

      {/* Floating Frosted Action Bar */}
      {actionBarPos && selection && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: actionBarPos.left, top: actionBarPos.top }}
          className="animate-pop-in absolute z-30 flex items-center gap-0.5 rounded-[13px] bg-white/94 p-[5px] shadow-[0_14px_38px_-6px_rgba(0,0,0,0.28),0_2px_8px_rgba(0,0,0,0.1),inset_0_0.5px_0_rgba(255,255,255,0.95)] ring-1 ring-black/[0.09] backdrop-blur-2xl"
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
          <Tooltip label="Scrolling Capture" side={actionBarPos.tooltipSide}>
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
              onClick={dismissOverlay}
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
