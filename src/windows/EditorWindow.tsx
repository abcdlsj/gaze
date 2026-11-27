import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  computeLayout,
  exportCompositePng,
  getContrastingTextColor,
  hitTestAnnotation,
  hitTestHandle,
  hitTestSingleAnnotation,
  isLightHexColor,
  normalizeAnnotation,
  renderComposite,
  resizeAnnotationByHandle,
  translateAnnotation,
} from "../lib/canvas-render";
import {
  copyImageBytes,
  copyTextToClipboard,
  getCaptureImageRaw,
  getCaptureMeta,
  getSettings,
  inplaceFinish,
  inplaceHide,
  inplaceReady,
  openPreferencesWindow,
  pinImageBytes,
  revealWindow,
  saveImageBytes,
} from "../lib/tauri";
import type {
  Annotation,
  AppSettings,
  BackdropConfig,
  EditorTool,
  InplaceAction,
  InplaceSession,
  Point,
  RedactMode,
  ResizeHandleId,
  ShapeFillStyle,
  TextStyle,
} from "../types";
import { EditorToolbar } from "../components/editor/EditorToolbar";
import { ToolOptionsBar } from "../components/editor/ToolOptionsBar";
import { ResizeModal } from "../components/editor/ResizeModal";
import { InplaceToolbar } from "../components/editor/InplaceToolbar";

/** Height reserved for the tool options row shown next to the in-place toolbar. */
const INPLACE_OPTIONS_H = 40;
const INPLACE_OPTIONS_GAP = 6;
/** Tools that only make sense in the standalone editor (canvas crop and backdrop frame). */
const STANDALONE_ONLY_TOOLS: ReadonlySet<EditorTool> = new Set(["crop", "frame", "select"]);

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type CropEdge = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface HistoryEntry {
  annotations: Annotation[];
  sourceCanvas: HTMLCanvasElement;
  imgSize: { w: number; h: number };
}

interface TextDraftState {
  sessionId: number;
  editingId: string | null;
  x: number;
  y: number;
  value: string;
}

export function EditorWindow({
  captureId,
  inplace,
}: {
  captureId: string;
  /**
   * When set, the editor runs in place on top of the frozen capture overlay: the image is
   * drawn 1:1 at the selection rect, and a compact toolbar replaces the window chrome.
   */
  inplace?: InplaceSession;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const revealedRef = useRef(false);
  // Direct DOM refs for zero-rerender 120fps live color inspector
  const colorDotRef = useRef<HTMLSpanElement | null>(null);
  const colorHexRef = useRef<HTMLSpanElement | null>(null);
  const hoverHexRef = useRef<string>("#000000");
  // Cached composite RGBA pixel buffer for O(1) color lookup without GPU getImageData stalls
  const compositePixelsRef = useRef<{
    w: number;
    h: number;
    data: Uint8ClampedArray;
  } | null>(null);

  const [sourceCanvas, setSourceCanvas] = useState<HTMLCanvasElement | null>(
    null,
  );
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({
    w: 1,
    h: 1,
  });
  const [scaleFactor, setScaleFactor] = useState<number>(1);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Viewport transform
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);

  // Tool state
  const [activeTool, setActiveTool] = useState<EditorTool>(
    inplace && !STANDALONE_ONLY_TOOLS.has(inplace.tool) ? inplace.tool : "select",
  );
  const [color, setColor] = useState<string>("#EF4444");
  const [blackoutColor, setBlackoutColor] = useState<string>("#18181B");
  const [strokeWidth, setStrokeWidth] = useState<number>(3);
  const [fontSize, setFontSize] = useState<number>(16);
  const [textStyle, setTextStyle] = useState<TextStyle>("plain");
  const [blurStrength, setBlurStrength] = useState<number>(12);
  const [spotlightOpacity, setSpotlightOpacity] = useState<number>(0.52);
  const [shapeFillStyle, setShapeFillStyle] =
    useState<ShapeFillStyle>("outline");
  const [highlighter, setHighlighter] = useState<boolean>(false);
  const [counterRadius, setCounterRadius] = useState<number>(14);
  const [nextCounterNum, setNextCounterNum] = useState<number>(1);

  const [backdrop, setBackdrop] = useState<BackdropConfig>({
    enabled: false,
    padding: 36,
    cornerRadius: 12,
    shadow: true,
    background: "linear-gradient(135deg, #0EA5E9, #2563EB, #6366F1)",
  });

  // Annotations + Unified Undo/Redo stacks (covers annotations, move, resize, crop, canvas resize)
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftAnn, setDraftAnn] = useState<Annotation | null>(null);

  // Coalesce rapid property/nudge edits into one undo step
  const propUndoGateRef = useRef<{ key: string; ts: number }>({
    key: "",
    ts: 0,
  });

  // Inline text editor (supports both creating new text & double-clicking existing text to edit)
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraftState | null>(null);

  useEffect(() => {
    if (!textDraft) return;
    const raf = requestAnimationFrame(() => {
      const el = textInputRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [textDraft?.sessionId]);

  // Crop overlay state (in image pixel coordinates)
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [resizeOpen, setResizeOpen] = useState(false);

  // Toast feedback
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dragRef = useRef<{
    kind: "pan" | "draw" | "move-ann" | "resize-ann" | "crop";
    startClient: Point;
    startImg: Point;
    origPan?: Point;
    origAnn?: Annotation;
    handleId?: ResizeHandleId;
    preDragAnnotations?: Annotation[];
    didMutate?: boolean;
    origCrop?: CropRect;
    cropEdge?: CropEdge;
  } | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 1300);
  }, []);

  const selectedAnnotation = useMemo(
    () => (selectedId ? annotations.find((a) => a.id === selectedId) ?? null : null),
    [annotations, selectedId],
  );

  // Load capture via zero-compression raw RGBA IPC (instant paint, no PNG decode lag)
  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const [meta, raw, s] = await Promise.all([
          getCaptureMeta(captureId),
          getCaptureImageRaw(captureId),
          getSettings(),
        ]);
        if (!active) return;

        setSettings(s);
        const sf = meta.scale_factor || 1;
        setScaleFactor(sf);
        setColor(s.editor.default_color);
        setStrokeWidth(s.editor.stroke_width);
        setFontSize(s.editor.font_size);
        setBlurStrength(s.editor.blur_strength);

        const c = document.createElement("canvas");
        c.width = raw.width;
        c.height = raw.height;
        const ctx = c.getContext("2d");
        if (ctx) {
          const imgData = new ImageData(
            raw.data as Uint8ClampedArray<ArrayBuffer>,
            raw.width,
            raw.height,
          );
          ctx.putImageData(imgData, 0, 0);
        }

        // Pre-seed pixel cache immediately so eyedropper works at 120fps on frame 1
        compositePixelsRef.current = {
          w: raw.width,
          h: raw.height,
          data: raw.data,
        };

        setSourceCanvas(c);
        setImgSize({ w: raw.width, h: raw.height });

        if (inplace) {
          // In place the image must line up pixel-for-pixel with the frozen frame below.
          setZoom(1);
          return;
        }
        const vp = viewportRef.current;
        const vpW = vp && vp.clientWidth > 0 ? vp.clientWidth : window.innerWidth;
        const vpH =
          vp && vp.clientHeight > 0
            ? vp.clientHeight
            : Math.max(200, window.innerHeight - 48);
        const logicalW = raw.width / sf;
        const logicalH = raw.height / sf;
        const fitW = (vpW - 64) / Math.max(1, logicalW);
        const fitH = (vpH - 64) / Math.max(1, logicalH);
        const initialZoom = Math.min(1, fitW, fitH);
        setZoom(Math.max(0.15, Number(initialZoom.toFixed(2))));
      } catch (err) {
        console.error("Failed to load capture:", err);
        // In place, the native overlay times out and falls back to the standalone editor.
        if (!revealedRef.current && !inplace) {
          revealedRef.current = true;
          void revealWindow(true);
        }
      }
    })();

    return () => {
      active = false;
    };
    // `inplace` is fixed for the lifetime of this component (it is keyed by session).
  }, [captureId]);

  const layout = useMemo(
    () => computeLayout(imgSize.w, imgSize.h, backdrop, scaleFactor),
    [imgSize, backdrop, scaleFactor],
  );

  const displayedAnnotations = useMemo(
    () => (draftAnn ? [...annotations, draftAnn] : annotations),
    [annotations, draftAnn],
  );

  // Redraw composite canvas whenever image, backdrop, annotations, zoom, or selection changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sourceCanvas) return;
    canvas.width = layout.canvasWidth;
    canvas.height = layout.canvasHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    renderComposite(
      ctx,
      sourceCanvas,
      imgSize.w,
      imgSize.h,
      scaleFactor,
      backdrop,
      displayedAnnotations,
      selectedId,
      {
        zoom,
        draftId: draftAnn?.id ?? null,
        editingTextId: textDraft?.editingId ?? null,
      },
    );

    // Refresh CPU pixel cache only when idle (not mid-stroke) so dragging stays 120fps
    if (!draftAnn && !dragRef.current) {
      try {
        const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
        compositePixelsRef.current = {
          w: snap.width,
          h: snap.height,
          data: snap.data,
        };
      } catch {
        // ignore
      }
    }

    // Reveal the hidden editor window only after the first composite frame is painted
    if (!revealedRef.current) {
      revealedRef.current = true;
      setTimeout(() => {
        void (inplace ? inplaceReady() : revealWindow(true));
      }, 16);
    }
  }, [
    sourceCanvas,
    imgSize,
    scaleFactor,
    backdrop,
    displayedAnnotations,
    selectedId,
    layout,
    draftAnn,
    zoom,
    textDraft?.editingId,
  ]);

  const pushHistoryEntry = useCallback(
    (entry: HistoryEntry) => {
      setUndoStack((u) => [...u.slice(-49), entry]);
      setRedoStack([]);
    },
    [],
  );

  const commitAnnotations = useCallback(
    (next: Annotation[]) => {
      if (sourceCanvas) {
        pushHistoryEntry({ annotations, sourceCanvas, imgSize });
      }
      setAnnotations(next);
    },
    [annotations, sourceCanvas, imgSize, pushHistoryEntry],
  );

  // Patch selected annotation live with coalesced undo (prevents slider drags spamming history)
  const patchSelectedAnnotation = useCallback(
    (
      gateKey: string,
      updater: (ann: Annotation) => Annotation,
    ) => {
      if (!selectedId || !sourceCanvas || textDraft) return;
      const now = Date.now();
      const fullKey = `${selectedId}:${gateKey}`;
      if (
        propUndoGateRef.current.key !== fullKey ||
        now - propUndoGateRef.current.ts > 500
      ) {
        pushHistoryEntry({ annotations, sourceCanvas, imgSize });
      }
      propUndoGateRef.current = { key: fullKey, ts: now };
      setAnnotations((prev) =>
        prev.map((a) => (a.id === selectedId ? updater(a) : a)),
      );
    },
    [selectedId, sourceCanvas, textDraft, annotations, imgSize, pushHistoryEntry],
  );

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0 || !sourceCanvas) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((u) => u.slice(0, -1));
    setRedoStack((r) => [...r, { annotations, sourceCanvas, imgSize }]);
    setAnnotations(prev.annotations);
    setSourceCanvas(prev.sourceCanvas);
    setImgSize(prev.imgSize);
    setSelectedId(null);
    setTextDraft(null);
    setCropRect(null);
  }, [undoStack, annotations, sourceCanvas, imgSize]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0 || !sourceCanvas) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u, { annotations, sourceCanvas, imgSize }]);
    setAnnotations(next.annotations);
    setSourceCanvas(next.sourceCanvas);
    setImgSize(next.imgSize);
    setSelectedId(null);
    setTextDraft(null);
    setCropRect(null);
  }, [redoStack, annotations, sourceCanvas, imgSize]);

  const handleZoomFit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const logicalW = layout.canvasWidth / scaleFactor;
    const logicalH = layout.canvasHeight / scaleFactor;
    const fit = Math.min(
      (vp.clientWidth - 64) / Math.max(1, logicalW),
      (vp.clientHeight - 64) / Math.max(1, logicalH),
    );
    setZoom(Math.max(0.1, Math.min(4, Number(fit.toFixed(2)))));
    setPan({ x: 0, y: 0 });
  }, [layout, scaleFactor]);

  const commitTextDraft = useCallback(() => {
    if (!textDraft) return;
    const trimmed = textDraft.value.trim();
    if (textDraft.editingId) {
      if (trimmed) {
        commitAnnotations(
          annotations.map((a) =>
            a.id === textDraft.editingId && a.type === "text"
              ? { ...a, text: textDraft.value, fontSize, color, textStyle }
              : a,
          ),
        );
        setSelectedId(textDraft.editingId);
      } else {
        commitAnnotations(
          annotations.filter((a) => a.id !== textDraft.editingId),
        );
        setSelectedId(null);
      }
    } else if (trimmed) {
      const id = crypto.randomUUID();
      const ann: Annotation = {
        id,
        type: "text",
        x: textDraft.x,
        y: textDraft.y,
        text: textDraft.value,
        fontSize,
        textStyle,
        color,
        strokeWidth,
      };
      commitAnnotations([...annotations, ann]);
      setSelectedId(id);
    }
    setTextDraft(null);
  }, [textDraft, annotations, fontSize, color, textStyle, strokeWidth, commitAnnotations]);

  const selectTool = useCallback(
    (tool: EditorTool) => {
      if (textDraft) {
        commitTextDraft();
      }
      setActiveTool(tool);
      // Clear selection when switching to a different tool so you don't accidentally drag an old item
      if (tool !== "select") {
        setSelectedId(null);
      }
      if (tool === "crop") {
        setSelectedId(null);
        setCropRect({ x: 0, y: 0, w: imgSize.w, h: imgSize.h });
      } else {
        setCropRect(null);
      }
      if (tool === "frame" && !backdrop.enabled) {
        setBackdrop((b) => ({ ...b, enabled: true }));
      }
    },
    [imgSize, backdrop.enabled, textDraft, commitTextDraft],
  );

  // Contextual property handlers: update both active tool defaults AND selected annotation live
  const handleColorChange = useCallback(
    (hex: string) => {
      setColor(hex);
      if (selectedAnnotation && selectedAnnotation.type !== "blackout") {
        patchSelectedAnnotation("color", (a) => ({ ...a, color: hex }));
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleBlackoutColorChange = useCallback(
    (hex: string) => {
      setBlackoutColor(hex);
      if (selectedAnnotation?.type === "blackout") {
        patchSelectedAnnotation("blackout-color", (a) => ({
          ...a,
          color: hex,
        }));
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleStrokeWidthChange = useCallback(
    (w: number) => {
      setStrokeWidth(w);
      if (selectedAnnotation) {
        patchSelectedAnnotation("stroke", (a) => ({ ...a, strokeWidth: w }));
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleFontSizeChange = useCallback(
    (s: number) => {
      setFontSize(s);
      if (selectedAnnotation?.type === "text") {
        patchSelectedAnnotation("fontSize", (a) =>
          a.type === "text" ? { ...a, fontSize: s } : a,
        );
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleTextStyleChange = useCallback(
    (style: TextStyle) => {
      setTextStyle(style);
      if (selectedAnnotation?.type === "text") {
        patchSelectedAnnotation("textStyle", (a) =>
          a.type === "text" ? { ...a, textStyle: style } : a,
        );
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleBlurStrengthChange = useCallback(
    (s: number) => {
      setBlurStrength(s);
      if (
        selectedAnnotation &&
        (selectedAnnotation.type === "blur" ||
          selectedAnnotation.type === "pixelate")
      ) {
        patchSelectedAnnotation("strength", (a) =>
          a.type === "blur" || a.type === "pixelate" ? { ...a, strength: s } : a,
        );
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleSpotlightOpacityChange = useCallback(
    (opacity: number) => {
      setSpotlightOpacity(opacity);
      if (selectedAnnotation?.type === "spotlight") {
        patchSelectedAnnotation("spotlight-opacity", (a) =>
          a.type === "spotlight" ? { ...a, opacity } : a,
        );
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleShapeFillStyleChange = useCallback(
    (fillStyle: ShapeFillStyle) => {
      setShapeFillStyle(fillStyle);
      if (
        selectedAnnotation &&
        (selectedAnnotation.type === "rect" ||
          selectedAnnotation.type === "ellipse")
      ) {
        patchSelectedAnnotation("fillStyle", (a) =>
          a.type === "rect" || a.type === "ellipse"
            ? { ...a, fillStyle, filled: fillStyle !== "outline" }
            : a,
        );
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleHighlighterChange = useCallback(
    (hl: boolean) => {
      setHighlighter(hl);
      if (selectedAnnotation?.type === "pen") {
        patchSelectedAnnotation("highlighter", (a) =>
          a.type === "pen" ? { ...a, highlighter: hl } : a,
        );
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleCounterRadiusChange = useCallback(
    (r: number) => {
      setCounterRadius(r);
      if (selectedAnnotation?.type === "counter") {
        patchSelectedAnnotation("counterRadius", (a) =>
          a.type === "counter" ? { ...a, radius: r } : a,
        );
      }
    },
    [selectedAnnotation, patchSelectedAnnotation],
  );

  const handleSelectRedactMode = useCallback(
    (mode: RedactMode) => {
      if (
        selectedAnnotation &&
        (selectedAnnotation.type === "blur" ||
          selectedAnnotation.type === "pixelate" ||
          selectedAnnotation.type === "blackout")
      ) {
        patchSelectedAnnotation("redact-mode", (a) =>
          a.type === "blur" || a.type === "pixelate" || a.type === "blackout"
            ? {
                ...a,
                type: mode,
                color: mode === "blackout" ? blackoutColor : a.color,
              }
            : a,
        );
      }
      if (
        activeTool === "blur" ||
        activeTool === "pixelate" ||
        activeTool === "blackout"
      ) {
        setActiveTool(mode);
      }
    },
    [selectedAnnotation, activeTool, blackoutColor, patchSelectedAnnotation],
  );

  const handleDuplicateSelected = useCallback(() => {
    if (!selectedAnnotation) return;
    const offset = 12 * scaleFactor;
    const cloned = translateAnnotation(
      { ...selectedAnnotation, id: crypto.randomUUID() },
      offset,
      offset,
    );
    commitAnnotations([...annotations, cloned]);
    setSelectedId(cloned.id);
  }, [selectedAnnotation, scaleFactor, annotations, commitAnnotations]);

  const handleDeleteSelected = useCallback(() => {
    if (!selectedId) return;
    commitAnnotations(annotations.filter((a) => a.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, annotations, commitAnnotations]);

  const applyCrop = useCallback(() => {
    if (!cropRect || !sourceCanvas) return;
    const rx = Math.max(0, Math.round(cropRect.x));
    const ry = Math.max(0, Math.round(cropRect.y));
    const rw = Math.max(8, Math.min(imgSize.w - rx, Math.round(cropRect.w)));
    const rh = Math.max(8, Math.min(imgSize.h - ry, Math.round(cropRect.h)));

    pushHistoryEntry({ annotations, sourceCanvas, imgSize });

    const nextCanvas = document.createElement("canvas");
    nextCanvas.width = rw;
    nextCanvas.height = rh;
    nextCanvas
      .getContext("2d")
      ?.drawImage(sourceCanvas, rx, ry, rw, rh, 0, 0, rw, rh);

    setSourceCanvas(nextCanvas);
    setImgSize({ w: rw, h: rh });
    setAnnotations((prev) => prev.map((a) => translateAnnotation(a, -rx, -ry)));
    setCropRect(null);
    setActiveTool("select");
    showToast(
      `Cropped to ${Math.round(rw / scaleFactor)}×${Math.round(rh / scaleFactor)}pt`,
    );
  }, [
    cropRect,
    sourceCanvas,
    imgSize,
    annotations,
    scaleFactor,
    pushHistoryEntry,
    showToast,
  ]);

  const handleResize = useCallback(
    (newW: number, newH: number) => {
      if (!sourceCanvas) return;
      pushHistoryEntry({ annotations, sourceCanvas, imgSize });

      const sx = newW / imgSize.w;
      const sy = newH / imgSize.h;
      const nextCanvas = document.createElement("canvas");
      nextCanvas.width = newW;
      nextCanvas.height = newH;
      const ctx = nextCanvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(sourceCanvas, 0, 0, newW, newH);
      }
      setSourceCanvas(nextCanvas);
      setImgSize({ w: newW, h: newH });
      setAnnotations((prev) =>
        prev.map((a) => {
          switch (a.type) {
            case "rect":
            case "ellipse":
            case "blur":
            case "pixelate":
            case "blackout":
            case "spotlight":
              return {
                ...a,
                x: a.x * sx,
                y: a.y * sy,
                width: a.width * sx,
                height: a.height * sy,
              };
            case "arrow":
            case "line":
            case "ruler":
              return {
                ...a,
                start: { x: a.start.x * sx, y: a.start.y * sy },
                end: { x: a.end.x * sx, y: a.end.y * sy },
              };
            case "pen":
              return {
                ...a,
                points: a.points.map((p) => ({ x: p.x * sx, y: p.y * sy })),
              };
            case "text":
            case "counter":
              return { ...a, x: a.x * sx, y: a.y * sy };
          }
        }),
      );
      showToast(
        `Resized to ${Math.round(newW / scaleFactor)}×${Math.round(newH / scaleFactor)}pt`,
      );
    },
    [sourceCanvas, annotations, imgSize, scaleFactor, pushHistoryEntry, showToast],
  );

  const buildExportBytes = useCallback(async () => {
    if (!sourceCanvas) throw new Error("Image not loaded");
    return exportCompositePng(
      sourceCanvas,
      imgSize.w,
      imgSize.h,
      scaleFactor,
      backdrop,
      annotations,
    );
  }, [sourceCanvas, imgSize, scaleFactor, backdrop, annotations]);

  // In-place completion: hide everything first so the screen unfreezes instantly, then
  // export (only when there is something to flatten) and let Rust copy/save/pin the result.
  const finishingRef = useRef(false);
  const [pendingFinish, setPendingFinish] = useState<InplaceAction | null>(null);
  const finishInplace = useCallback(
    (action: InplaceAction) => {
      if (!inplace || finishingRef.current) return;
      if (textDraft && action !== "cancel") {
        // Flush the text being typed first; the effect below resumes once it is committed.
        commitTextDraft();
        setPendingFinish(action);
        return;
      }
      finishingRef.current = true;
      void (async () => {
        try {
          await inplaceHide(action);
          const bytes =
            action !== "cancel" && annotations.length > 0
              ? await buildExportBytes()
              : null;
          await inplaceFinish(action, bytes);
        } catch (e) {
          console.error(`In-place ${action} failed:`, e);
          // Never leave a hidden, orphaned editor window behind.
          void getCurrentWindow().destroy();
        }
      })();
    },
    [inplace, textDraft, commitTextDraft, annotations, buildExportBytes],
  );

  useEffect(() => {
    if (pendingFinish && !textDraft) {
      const action = pendingFinish;
      setPendingFinish(null);
      finishInplace(action);
    }
  }, [pendingFinish, textDraft, finishInplace]);

  const handleCopy = useCallback(async () => {
    if (inplace) {
      finishInplace("done");
      return;
    }
    try {
      const bytes = await buildExportBytes();
      await copyImageBytes(bytes);
      showToast("Copied to Clipboard");
      if (settings?.editor.copy_closes_editor) {
        setTimeout(() => void getCurrentWindow().close(), 180);
      }
    } catch (e) {
      showToast(`Copy failed: ${String(e)}`);
    }
  }, [inplace, finishInplace, buildExportBytes, settings, showToast]);

  const handleSave = useCallback(async () => {
    if (inplace) {
      finishInplace("save");
      return;
    }
    try {
      const bytes = await buildExportBytes();
      await saveImageBytes(bytes, scaleFactor);
      showToast("Saved to Screenshots Folder");
      if (settings?.editor.save_closes_editor) {
        setTimeout(() => void getCurrentWindow().close(), 180);
      }
    } catch (e) {
      showToast(`Save failed: ${String(e)}`);
    }
  }, [inplace, finishInplace, buildExportBytes, scaleFactor, settings, showToast]);

  const handleSaveAs = useCallback(async () => {
    try {
      const chosen = await saveDialog({
        title: "Save Screenshot As",
        defaultPath: settings?.screenshots_folder,
        filters: [
          { name: "PNG Image", extensions: ["png"] },
          { name: "JPEG Image", extensions: ["jpg", "jpeg"] },
        ],
      });
      if (!chosen) return;
      const bytes = await buildExportBytes();
      await saveImageBytes(bytes, scaleFactor, chosen);
      showToast("Saved");
    } catch (e) {
      showToast(`Save failed: ${String(e)}`);
    }
  }, [buildExportBytes, scaleFactor, settings, showToast]);

  const handlePin = useCallback(async () => {
    if (inplace) {
      finishInplace("pin");
      return;
    }
    try {
      const bytes = await buildExportBytes();
      await pinImageBytes(bytes, scaleFactor);
      showToast("Pinned on Screen");
    } catch (e) {
      showToast(`Pin failed: ${String(e)}`);
    }
  }, [inplace, finishInplace, buildExportBytes, scaleFactor, showToast]);

  const handleCopyHex = useCallback(() => {
    const hex = hoverHexRef.current;
    void copyTextToClipboard(hex).then(() => showToast(`Copied ${hex}`));
  }, [showToast]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (textDraft || resizeOpen) return;
      const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
      if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

      if (inplace) {
        // Snipaste key map: Esc cancels the capture, Enter / ⌘C copies and closes, ⌘S saves.
        const mod = e.metaKey || e.ctrlKey;
        const k = e.key.toLowerCase();
        if (e.key === "Escape") {
          e.preventDefault();
          finishInplace("cancel");
          return;
        }
        if (e.key === "Enter" || (mod && k === "c")) {
          e.preventDefault();
          finishInplace("done");
          return;
        }
        if (mod && k === "s") {
          e.preventDefault();
          finishInplace("save");
          return;
        }
        // No zoom/pan, Preferences, crop, frame or select tool in place.
        if (e.code === "Space" || (mod && ["=", "+", "-", "0", ","].includes(k))) {
          e.preventDefault();
          return;
        }
        if (!mod && !e.altKey && (k === "c" || k === "f" || k === "v")) {
          return;
        }
      }

      if (e.code === "Space") {
        e.preventDefault();
        setSpacePressed(true);
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        handleCopyHex();
        return;
      }

      if (e.key === "Escape") {
        if (activeTool === "crop") {
          setCropRect(null);
          setActiveTool("select");
          return;
        }
        if (selectedId) {
          setSelectedId(null);
          return;
        }
        if (activeTool !== "select") {
          setActiveTool("select");
          return;
        }
        void getCurrentWindow().close();
        return;
      }

      if (e.key === "Enter") {
        if (activeTool === "crop") {
          e.preventDefault();
          applyCrop();
          return;
        }
        if (selectedAnnotation?.type === "text") {
          e.preventDefault();
          setColor(selectedAnnotation.color);
          setFontSize(selectedAnnotation.fontSize);
          setTextStyle(selectedAnnotation.textStyle ?? "plain");
          setTextDraft({
            sessionId: Date.now(),
            editingId: selectedAnnotation.id,
            x: selectedAnnotation.x,
            y: selectedAnnotation.y,
            value: selectedAnnotation.text,
          });
          return;
        }
      }

      if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
        e.preventDefault();
        handleDeleteSelected();
        return;
      }

      // Arrow-key precision nudging for selected annotation (1pt, or 10pt with Shift)
      if (
        selectedId &&
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight")
      ) {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * scaleFactor;
        const dx =
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy =
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        patchSelectedAnnotation("nudge", (a) => translateAnnotation(a, dx, dy));
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();

      if (mod && k === "c") {
        e.preventDefault();
        void handleCopy();
        return;
      }
      if (mod && k === "d" && selectedId) {
        e.preventDefault();
        handleDuplicateSelected();
        return;
      }
      if (mod && k === "s") {
        e.preventDefault();
        if (e.shiftKey) void handleSaveAs();
        else void handleSave();
        return;
      }
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (mod && k === ",") {
        e.preventDefault();
        void openPreferencesWindow();
        return;
      }
      if (mod && (k === "=" || k === "+")) {
        e.preventDefault();
        setZoom((z) => Math.min(8, Number((z * 1.25).toFixed(2))));
        return;
      }
      if (mod && k === "-") {
        e.preventDefault();
        setZoom((z) => Math.max(0.15, Number((z / 1.25).toFixed(2))));
        return;
      }
      if (mod && k === "0") {
        e.preventDefault();
        setZoom(1);
        setPan({ x: 0, y: 0 });
        return;
      }

      // Quick [ / ] size adjustment (like CleanShot X / Photoshop / Snipaste)
      if (!mod && !e.altKey && (e.key === "[" || e.key === "]")) {
        const delta = e.key === "]" ? 1 : -1;
        const ctxKind = selectedAnnotation ? selectedAnnotation.type : activeTool;
        if (ctxKind === "blur" || ctxKind === "pixelate") {
          const cur =
            selectedAnnotation &&
            (selectedAnnotation.type === "blur" ||
              selectedAnnotation.type === "pixelate")
              ? selectedAnnotation.strength
              : blurStrength;
          handleBlurStrengthChange(Math.max(4, Math.min(28, cur + delta * 2)));
        } else if (ctxKind === "text") {
          const cur =
            selectedAnnotation?.type === "text"
              ? selectedAnnotation.fontSize
              : fontSize;
          handleFontSizeChange(Math.max(12, Math.min(48, cur + delta * 2)));
        } else if (
          ctxKind === "arrow" ||
          ctxKind === "line" ||
          ctxKind === "rect" ||
          ctxKind === "ellipse" ||
          ctxKind === "pen"
        ) {
          const cur = selectedAnnotation
            ? selectedAnnotation.strokeWidth
            : strokeWidth;
          handleStrokeWidthChange(Math.max(1, Math.min(12, cur + delta)));
        }
        return;
      }

      if (!mod && !e.altKey) {
        const shortcuts: Record<string, EditorTool> = {
          v: "select",
          a: "arrow",
          t: "text",
          r: "ruler",
          s: "rect",
          o: "ellipse",
          l: "line",
          f: "frame",
          p: "pen",
          b: "blur",
          x: "pixelate",
          k: "blackout",
          h: "spotlight",
          n: "counter",
          c: "crop",
        };
        if (shortcuts[k]) {
          selectTool(shortcuts[k]);
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpacePressed(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    inplace,
    finishInplace,
    textDraft,
    resizeOpen,
    activeTool,
    selectedId,
    selectedAnnotation,
    scaleFactor,
    blurStrength,
    fontSize,
    strokeWidth,
    applyCrop,
    handleCopy,
    handleCopyHex,
    handleDeleteSelected,
    handleDuplicateSelected,
    handleBlurStrengthChange,
    handleFontSizeChange,
    handleStrokeWidthChange,
    handleRedo,
    handleSave,
    handleSaveAs,
    handleUndo,
    patchSelectedAnnotation,
    selectTool,
  ]);

  const clientToImagePoint = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const cx =
        ((clientX - rect.left) / Math.max(1, rect.width)) * layout.canvasWidth;
      const cy =
        ((clientY - rect.top) / Math.max(1, rect.height)) * layout.canvasHeight;
      return {
        x: cx - layout.offsetX,
        y: cy - layout.offsetY,
      };
    },
    [layout],
  );

  // Zero-alloc, zero-rerender O(1) pixel sampling directly from cached Uint8ClampedArray
  const sampleColorAtClient = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const cache = compositePixelsRef.current;
    if (!canvas || !cache) return;
    const rect = canvas.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return;
    }
    const px = Math.min(
      cache.w - 1,
      Math.max(
        0,
        Math.floor(
          ((clientX - rect.left) / Math.max(1, rect.width)) * cache.w,
        ),
      ),
    );
    const py = Math.min(
      cache.h - 1,
      Math.max(
        0,
        Math.floor(
          ((clientY - rect.top) / Math.max(1, rect.height)) * cache.h,
        ),
      ),
    );
    const idx = (py * cache.w + px) * 4;
    const hex = rgbToHex(
      cache.data[idx],
      cache.data[idx + 1],
      cache.data[idx + 2],
    );
    if (hex !== hoverHexRef.current) {
      hoverHexRef.current = hex;
      if (colorDotRef.current) {
        colorDotRef.current.style.backgroundColor = hex;
      }
      if (colorHexRef.current) {
        colorHexRef.current.textContent = hex;
      }
    }
  }, []);

  // Zero-rerender dynamic cursor feedback based on handle/annotation hover
  const updateHoverCursor = useCallback(
    (pt: Point | null) => {
      const vp = viewportRef.current;
      if (!vp) return;
      if (spacePressed) {
        vp.style.cursor = dragRef.current?.kind === "pan" ? "grabbing" : "grab";
        return;
      }
      if (dragRef.current) return;
      if (pt) {
        if (selectedAnnotation) {
          const handle = hitTestHandle(selectedAnnotation, pt, scaleFactor, zoom);
          if (handle) {
            vp.style.cursor = handle.cursor;
            return;
          }
          if (
            activeTool !== "pen" &&
            activeTool !== "crop" &&
            hitTestSingleAnnotation(selectedAnnotation, pt, scaleFactor, zoom)
          ) {
            vp.style.cursor = "move";
            return;
          }
        }
        if (activeTool === "select" || activeTool === "frame") {
          const hit = hitTestAnnotation(annotations, pt, scaleFactor, zoom);
          vp.style.cursor = hit ? "move" : "default";
          return;
        }
      }
      vp.style.cursor =
        activeTool === "select" || activeTool === "frame"
          ? "default"
          : activeTool === "text"
            ? "text"
            : "crosshair";
    },
    [spacePressed, selectedAnnotation, activeTool, annotations, scaleFactor, zoom],
  );

  // Sync cursor whenever tool or spacebar changes
  useEffect(() => {
    updateHoverCursor(null);
  }, [updateHoverCursor]);

  const handleViewportDoubleClick = (e: React.MouseEvent) => {
    if (activeTool === "crop" || spacePressed) return;
    const pt = clientToImagePoint(e.clientX, e.clientY);
    if (!pt) return;
    const hit = hitTestAnnotation(annotations, pt, scaleFactor, zoom);
    if (hit && hit.type === "text") {
      e.preventDefault();
      e.stopPropagation();
      setSelectedId(hit.id);
      setColor(hit.color);
      setFontSize(hit.fontSize);
      setTextStyle(hit.textStyle ?? "plain");
      setTextDraft({
        sessionId: Date.now(),
        editingId: hit.id,
        x: hit.x,
        y: hit.y,
        value: hit.text,
      });
    }
  };

  const handleViewportMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || spacePressed) {
      e.preventDefault();
      dragRef.current = {
        kind: "pan",
        startClient: { x: e.clientX, y: e.clientY },
        startImg: { x: 0, y: 0 },
        origPan: { ...pan },
      };
      if (viewportRef.current) viewportRef.current.style.cursor = "grabbing";
      return;
    }

    if (e.button !== 0) return;

    const pt = clientToImagePoint(e.clientX, e.clientY);
    if (!pt) return;

    if (activeTool === "crop") {
      return;
    }

    // If inline text is currently active and user clicks canvas outside textarea, commit it
    if (textDraft) {
      e.preventDefault();
      commitTextDraft();
      if (activeTool !== "text") return;
    }

    // 1. Direct handle manipulation on currently selected annotation (works in ANY drawing tool!)
    if (selectedAnnotation) {
      const handle = hitTestHandle(selectedAnnotation, pt, scaleFactor, zoom);
      if (handle) {
        dragRef.current = {
          kind: "resize-ann",
          startClient: { x: e.clientX, y: e.clientY },
          startImg: pt,
          origAnn: selectedAnnotation,
          handleId: handle.id,
          preDragAnnotations: annotations,
          didMutate: false,
        };
        return;
      }

      // 2. Direct move of the currently selected annotation (except pen so rapid sketching isn't blocked)
      if (
        activeTool !== "pen" &&
        hitTestSingleAnnotation(selectedAnnotation, pt, scaleFactor, zoom)
      ) {
        let targetAnn = selectedAnnotation;
        let preDrag = annotations;
        // Alt+drag duplicates the selected annotation in-place
        if (e.altKey) {
          const cloned = { ...selectedAnnotation, id: crypto.randomUUID() };
          preDrag = annotations;
          setAnnotations((prev) => [...prev, cloned]);
          setSelectedId(cloned.id);
          targetAnn = cloned;
        }
        dragRef.current = {
          kind: "move-ann",
          startClient: { x: e.clientX, y: e.clientY },
          startImg: pt,
          origAnn: targetAnn,
          preDragAnnotations: preDrag,
          didMutate: e.altKey,
        };
        return;
      }
    }

    // 3. Select / Frame mode: pick any annotation under cursor
    if (activeTool === "select" || activeTool === "frame") {
      const hit = hitTestAnnotation(annotations, pt, scaleFactor, zoom);
      setSelectedId(hit?.id ?? null);
      if (hit) {
        let targetAnn = hit;
        if (e.altKey) {
          const cloned = { ...hit, id: crypto.randomUUID() };
          setAnnotations((prev) => [...prev, cloned]);
          setSelectedId(cloned.id);
          targetAnn = cloned;
        }
        dragRef.current = {
          kind: "move-ann",
          startClient: { x: e.clientX, y: e.clientY },
          startImg: pt,
          origAnn: targetAnn,
          preDragAnnotations: annotations,
          didMutate: e.altKey,
        };
      }
      return;
    }

    // 4. Text tool: click existing text to select/move, or click empty space to type new text
    if (activeTool === "text") {
      e.preventDefault();
      e.stopPropagation();
      const existing = hitTestAnnotation(annotations, pt, scaleFactor, zoom);
      if (existing?.type === "text") {
        setSelectedId(existing.id);
        dragRef.current = {
          kind: "move-ann",
          startClient: { x: e.clientX, y: e.clientY },
          startImg: pt,
          origAnn: existing,
          preDragAnnotations: annotations,
          didMutate: false,
        };
        return;
      }
      setSelectedId(null);
      setTextDraft({
        sessionId: Date.now(),
        editingId: null,
        x: pt.x,
        y: pt.y,
        value: "",
      });
      return;
    }

    // 5. Counter tool: click existing counter to move, or place next numbered badge
    if (activeTool === "counter") {
      const existing = hitTestAnnotation(annotations, pt, scaleFactor, zoom);
      if (existing?.type === "counter") {
        setSelectedId(existing.id);
        dragRef.current = {
          kind: "move-ann",
          startClient: { x: e.clientX, y: e.clientY },
          startImg: pt,
          origAnn: existing,
          preDragAnnotations: annotations,
          didMutate: false,
        };
        return;
      }
      const id = crypto.randomUUID();
      const ann: Annotation = {
        id,
        type: "counter",
        x: pt.x,
        y: pt.y,
        number: nextCounterNum,
        radius: counterRadius,
        color,
        strokeWidth,
      };
      commitAnnotations([...annotations, ann]);
      setNextCounterNum((n) => n + 1);
      setSelectedId(id);
      return;
    }

    // 6. Start drawing a new annotation
    const id = crypto.randomUUID();
    let initial: Annotation | null = null;
    switch (activeTool) {
      case "arrow":
      case "line":
        initial = {
          id,
          type: activeTool,
          start: pt,
          end: pt,
          color,
          strokeWidth,
        };
        break;
      case "ruler":
        initial = {
          id,
          type: "ruler",
          start: pt,
          end: pt,
          color,
          strokeWidth,
        };
        break;
      case "rect":
      case "ellipse":
        initial = {
          id,
          type: activeTool,
          x: pt.x,
          y: pt.y,
          width: 0,
          height: 0,
          filled: shapeFillStyle !== "outline",
          fillStyle: shapeFillStyle,
          color,
          strokeWidth,
        };
        break;
      case "blur":
      case "pixelate":
      case "blackout":
        initial = {
          id,
          type: activeTool,
          x: pt.x,
          y: pt.y,
          width: 0,
          height: 0,
          strength: blurStrength,
          color: activeTool === "blackout" ? blackoutColor : color,
          strokeWidth,
        };
        break;
      case "spotlight":
        initial = {
          id,
          type: "spotlight",
          x: pt.x,
          y: pt.y,
          width: 0,
          height: 0,
          opacity: spotlightOpacity,
          color,
          strokeWidth,
        };
        break;
      case "pen":
        initial = {
          id,
          type: "pen",
          points: [pt],
          highlighter,
          color,
          strokeWidth,
        };
        break;
    }

    if (initial) {
      setSelectedId(null);
      setDraftAnn(initial);
      dragRef.current = {
        kind: "draw",
        startClient: { x: e.clientX, y: e.clientY },
        startImg: pt,
      };
    }
  };

  const handleViewportMouseMove = (e: React.MouseEvent) => {
    sampleColorAtClient(e.clientX, e.clientY);

    const drag = dragRef.current;
    const pt = clientToImagePoint(e.clientX, e.clientY);

    if (!drag) {
      updateHoverCursor(pt);
      return;
    }

    if (drag.kind === "pan" && drag.origPan) {
      setPan({
        x: drag.origPan.x + (e.clientX - drag.startClient.x),
        y: drag.origPan.y + (e.clientY - drag.startClient.y),
      });
      return;
    }

    if (!pt) return;

    if (drag.kind === "crop" && drag.origCrop && drag.cropEdge) {
      const dx = pt.x - drag.startImg.x;
      const dy = pt.y - drag.startImg.y;
      const o = drag.origCrop;

      if (drag.cropEdge === "move") {
        setCropRect({
          x: Math.max(0, Math.min(imgSize.w - o.w, o.x + dx)),
          y: Math.max(0, Math.min(imgSize.h - o.h, o.y + dy)),
          w: o.w,
          h: o.h,
        });
        return;
      }

      let x1 = o.x;
      let y1 = o.y;
      let x2 = o.x + o.w;
      let y2 = o.y + o.h;
      if (drag.cropEdge.includes("w"))
        x1 = Math.max(0, Math.min(x2 - 16, o.x + dx));
      if (drag.cropEdge.includes("e"))
        x2 = Math.min(imgSize.w, Math.max(x1 + 16, o.x + o.w + dx));
      if (drag.cropEdge.includes("n"))
        y1 = Math.max(0, Math.min(y2 - 16, o.y + dy));
      if (drag.cropEdge.includes("s"))
        y2 = Math.min(imgSize.h, Math.max(y1 + 16, o.y + o.h + dy));
      setCropRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
      return;
    }

    if (drag.kind === "move-ann" && drag.origAnn) {
      const dx = pt.x - drag.startImg.x;
      const dy = pt.y - drag.startImg.y;
      if (Math.hypot(dx, dy) > 0.5) {
        drag.didMutate = true;
      }
      const moved = translateAnnotation(drag.origAnn, dx, dy);
      setAnnotations((prev) =>
        prev.map((a) => (a.id === moved.id ? moved : a)),
      );
      return;
    }

    if (drag.kind === "resize-ann" && drag.origAnn && drag.handleId) {
      drag.didMutate = true;
      const resized = resizeAnnotationByHandle(
        drag.origAnn,
        drag.handleId,
        pt,
        e.shiftKey,
      );
      setAnnotations((prev) =>
        prev.map((a) => (a.id === resized.id ? resized : a)),
      );
      return;
    }

    if (drag.kind === "draw") {
      setDraftAnn((curr) => {
        if (!curr) return null;
        switch (curr.type) {
          case "arrow":
          case "line":
          case "ruler": {
            let end = pt;
            if (e.shiftKey) {
              const dx = pt.x - curr.start.x;
              const dy = pt.y - curr.start.y;
              const angle =
                Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
              const dist = Math.hypot(dx, dy);
              end = {
                x: curr.start.x + Math.cos(angle) * dist,
                y: curr.start.y + Math.sin(angle) * dist,
              };
            }
            return { ...curr, end };
          }
          case "rect":
          case "ellipse":
          case "blur":
          case "pixelate":
          case "blackout":
          case "spotlight": {
            let dx = pt.x - drag.startImg.x;
            let dy = pt.y - drag.startImg.y;
            if (e.shiftKey) {
              const side = Math.max(Math.abs(dx), Math.abs(dy));
              dx = Math.sign(dx || 1) * side;
              dy = Math.sign(dy || 1) * side;
            }
            if (e.altKey) {
              return {
                ...curr,
                x: drag.startImg.x - dx,
                y: drag.startImg.y - dy,
                width: dx * 2,
                height: dy * 2,
              };
            }
            return {
              ...curr,
              x: drag.startImg.x,
              y: drag.startImg.y,
              width: dx,
              height: dy,
            };
          }
          case "pen": {
            // Shift draws a straight horizontal/vertical/45° line (ideal for highlighting text lines!)
            if (e.shiftKey) {
              const dx = pt.x - drag.startImg.x;
              const dy = pt.y - drag.startImg.y;
              const angle =
                Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
              const dist = Math.hypot(dx, dy);
              return {
                ...curr,
                points: [
                  drag.startImg,
                  {
                    x: drag.startImg.x + Math.cos(angle) * dist,
                    y: drag.startImg.y + Math.sin(angle) * dist,
                  },
                ],
              };
            }
            const last = curr.points[curr.points.length - 1];
            if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 1.5) {
              return curr;
            }
            return { ...curr, points: [...curr.points, pt] };
          }
          default:
            return curr;
        }
      });
    }
  };

  const handleViewportMouseUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.kind === "pan") {
      updateHoverCursor(null);
      return;
    }

    if (
      (drag.kind === "move-ann" || drag.kind === "resize-ann") &&
      drag.didMutate &&
      drag.preDragAnnotations &&
      sourceCanvas
    ) {
      pushHistoryEntry({
        annotations: drag.preDragAnnotations,
        sourceCanvas,
        imgSize,
      });
      return;
    }

    if (drag.kind === "draw" && draftAnn) {
      const normalized = normalizeAnnotation(draftAnn);
      const meaningful =
        normalized.type === "pen"
          ? normalized.points.length >= 2 &&
            Math.hypot(
              normalized.points[normalized.points.length - 1].x -
                normalized.points[0].x,
              normalized.points[normalized.points.length - 1].y -
                normalized.points[0].y,
            ) > 2
          : normalized.type === "arrow" ||
              normalized.type === "line" ||
              normalized.type === "ruler"
            ? Math.hypot(
                normalized.end.x - normalized.start.x,
                normalized.end.y - normalized.start.y,
              ) > 4
            : normalized.type === "rect" ||
                normalized.type === "ellipse" ||
                normalized.type === "blur" ||
                normalized.type === "pixelate" ||
                normalized.type === "blackout" ||
                normalized.type === "spotlight"
              ? Math.abs(normalized.width) > 4 &&
                Math.abs(normalized.height) > 4
              : true;

      if (meaningful) {
        commitAnnotations([...annotations, normalized]);
        // Auto-select newly created shape/arrow/redact so user can immediately adjust handles or style
        // (keep Pen unselected so freehand sketching stays fluid)
        if (normalized.type !== "pen") {
          setSelectedId(normalized.id);
        }
      }
      setDraftAnn(null);
    }
  };

  // Native non-passive wheel listener so WKWebView allows preventDefault() on trackpad pinch-zoom
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || inplace) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        setZoom((z) =>
          Math.max(0.15, Math.min(8, Number((z * factor).toFixed(2)))),
        );
      } else {
        e.preventDefault();
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [inplace]);

  const startCropDrag = (edge: CropEdge, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!cropRect) return;
    const pt = clientToImagePoint(e.clientX, e.clientY);
    if (!pt) return;
    dragRef.current = {
      kind: "crop",
      startClient: { x: e.clientX, y: e.clientY },
      startImg: pt,
      origCrop: { ...cropRect },
      cropEdge: edge,
    };
  };

  const displayW = (layout.canvasWidth / scaleFactor) * zoom;
  const displayH = (layout.canvasHeight / scaleFactor) * zoom;
  const widthPt = Math.round(layout.canvasWidth / scaleFactor);
  const heightPt = Math.round(layout.canvasHeight / scaleFactor);
  const cropSizePt = cropRect
    ? {
        w: Math.round(cropRect.w / scaleFactor),
        h: Math.round(cropRect.h / scaleFactor),
      }
    : null;

  const isBadgeDraft = textStyle === "badge";

  const renderToolOptions = (floatingStyle?: React.CSSProperties) => (
    <ToolOptionsBar
      activeTool={textDraft ? "text" : activeTool}
      selectedAnnotation={textDraft ? null : selectedAnnotation}
      color={color}
      onColorChange={handleColorChange}
      blackoutColor={blackoutColor}
      onBlackoutColorChange={handleBlackoutColorChange}
      strokeWidth={strokeWidth}
      onStrokeWidthChange={handleStrokeWidthChange}
      fontSize={fontSize}
      onFontSizeChange={handleFontSizeChange}
      textStyle={textStyle}
      onTextStyleChange={handleTextStyleChange}
      blurStrength={blurStrength}
      onBlurStrengthChange={handleBlurStrengthChange}
      spotlightOpacity={spotlightOpacity}
      onSpotlightOpacityChange={handleSpotlightOpacityChange}
      shapeFillStyle={shapeFillStyle}
      onShapeFillStyleChange={handleShapeFillStyleChange}
      highlighter={highlighter}
      onHighlighterChange={handleHighlighterChange}
      counterRadius={counterRadius}
      onCounterRadiusChange={handleCounterRadiusChange}
      nextCounterNum={nextCounterNum}
      onResetCounter={() => setNextCounterNum(1)}
      backdrop={backdrop}
      onBackdropChange={setBackdrop}
      onSelectRedactMode={handleSelectRedactMode}
      onDuplicateSelected={handleDuplicateSelected}
      onDeleteSelected={handleDeleteSelected}
      cropSizePt={cropSizePt}
      onApplyCrop={applyCrop}
      onCancelCrop={() => {
        setCropRect(null);
        setActiveTool("select");
      }}
      floatingStyle={floatingStyle}
    />
  );

  // GPU-accelerated canvas stage (shared by the standalone and in-place layouts)
  const stage = (
    <div
      style={
        inplace
          ? {
              position: "absolute",
              left: inplace.selection.x,
              top: inplace.selection.y,
              width: displayW,
              height: displayH,
            }
          : {
              width: displayW,
              height: displayH,
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
              willChange: "transform",
            }
      }
      className={inplace ? undefined : "relative shrink-0"}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: displayW,
          height: displayH,
          imageRendering: zoom >= 2 ? "pixelated" : "auto",
        }}
        className={inplace ? "block" : "block shadow-[0_1px_5px_rgba(0,0,0,0.08)]"}
      />

      {/* Inline transparent/badge text box (WYSIWYG aligned with canvas text renderer) */}
      {textDraft && (
        <textarea
          ref={textInputRef}
          autoFocus
          rows={Math.max(1, textDraft.value.split("\n").length)}
          value={textDraft.value}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onChange={(e) =>
            setTextDraft({ ...textDraft, value: e.target.value })
          }
          onBlur={(e) => {
            const next = e.relatedTarget as HTMLElement | null;
            if (next && next.closest('[data-options-bar="true"]')) {
              return;
            }
            commitTextDraft();
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape") {
              e.preventDefault();
              setTextDraft(null);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitTextDraft();
            }
          }}
          style={{
            left: ((textDraft.x + layout.offsetX) / scaleFactor) * zoom - 2,
            top: ((textDraft.y + layout.offsetY) / scaleFactor) * zoom - 1,
            color: isBadgeDraft ? getContrastingTextColor(color) : color,
            backgroundColor: isBadgeDraft ? color : "transparent",
            padding: isBadgeDraft
              ? `${Math.round(fontSize * zoom * 0.24)}px ${Math.round(fontSize * zoom * 0.45)}px`
              : "0px 2px",
            borderRadius: isBadgeDraft
              ? `${Math.round(Math.min(8 * zoom, fontSize * zoom * 0.35))}px`
              : "3px",
            caretColor: isBadgeDraft
              ? getContrastingTextColor(color)
              : color,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif',
            fontSize: `${fontSize * zoom}px`,
            lineHeight: 1.28,
            textShadow:
              !isBadgeDraft && isLightHexColor(color)
                ? "0 0.75px 1.5px rgba(0, 0, 0, 0.42)"
                : "none",
            width: `${Math.max(
              6,
              ...textDraft.value.split("\n").map((line) => {
                let units = 0;
                for (const ch of line) {
                  units += ch.charCodeAt(0) > 127 ? 2 : 1.05;
                }
                return Math.ceil(units) + 2;
              }),
            )}ch`,
            maxWidth: Math.max(
              140,
              displayW -
                ((textDraft.x + layout.offsetX) / scaleFactor) * zoom,
            ),
            userSelect: "text",
          }}
          placeholder="Type…"
          className="absolute z-30 resize-none overflow-hidden border border-dashed border-[#007AFF]/70 font-semibold outline-none placeholder:text-current/55"
        />
      )}

      {/* Interactive 8-Handle Crop Frame with Rule-of-Thirds Grid */}
      {activeTool === "crop" && cropRect && (
        <div
          onMouseDown={(e) => startCropDrag("move", e)}
          style={{
            left: ((cropRect.x + layout.offsetX) / scaleFactor) * zoom,
            top: ((cropRect.y + layout.offsetY) / scaleFactor) * zoom,
            width: (cropRect.w / scaleFactor) * zoom,
            height: (cropRect.h / scaleFactor) * zoom,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.38)",
          }}
          className="absolute z-20 cursor-move border-[1.5px] border-white shadow-[inset_0_0_0_1px_rgba(0,122,255,0.85)]"
        >
          {/* Rule-of-thirds guides */}
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/30" />
            <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/30" />
            <div className="absolute top-1/3 left-0 right-0 h-px bg-white/30" />
            <div className="absolute top-2/3 left-0 right-0 h-px bg-white/30" />
          </div>

          {/* 4 Corner Handles */}
          {(
            [
              ["nw", "-left-1.5 -top-1.5 cursor-nwse-resize"],
              ["ne", "-right-1.5 -top-1.5 cursor-nesw-resize"],
              ["sw", "-left-1.5 -bottom-1.5 cursor-nesw-resize"],
              ["se", "-right-1.5 -bottom-1.5 cursor-nwse-resize"],
            ] as const
          ).map(([edge, cls]) => (
            <div
              key={edge}
              onMouseDown={(e) => startCropDrag(edge, e)}
              className={`absolute h-3 w-3 rounded-full border-2 border-[#007AFF] bg-white shadow ${cls}`}
            />
          ))}

          {/* 4 Edge Midpoint Pill Handles */}
          {(
            [
              ["n", "left-1/2 -top-1.5 -translate-x-1/2 h-2.5 w-6 cursor-ns-resize"],
              ["s", "left-1/2 -bottom-1.5 -translate-x-1/2 h-2.5 w-6 cursor-ns-resize"],
              ["w", "top-1/2 -left-1.5 -translate-y-1/2 w-2.5 h-6 cursor-ew-resize"],
              ["e", "top-1/2 -right-1.5 -translate-y-1/2 w-2.5 h-6 cursor-ew-resize"],
            ] as const
          ).map(([edge, cls]) => (
            <div
              key={edge}
              onMouseDown={(e) => startCropDrag(edge, e)}
              className={`absolute rounded-full border-[1.5px] border-[#007AFF] bg-white shadow ${cls}`}
            />
          ))}
        </div>
      )}
    </div>
  );

  if (inplace) {
    const sel = inplace.selection;
    const tb = inplace.toolbar;
    const viewH = inplace.view_height;
    // Options row: on the far side of the toolbar from the selection, flipping when the
    // screen edge is too close (mirrors the toolbar's own below/above/inside placement).
    const roomBelow =
      tb.y + tb.height + INPLACE_OPTIONS_GAP + INPLACE_OPTIONS_H <= viewH - 4;
    const roomAbove = tb.y - INPLACE_OPTIONS_GAP - INPLACE_OPTIONS_H >= 4;
    const optionsBelow =
      inplace.toolbar_side === "below" ? roomBelow : !roomAbove && roomBelow;
    const optionsStyle: React.CSSProperties = {
      left: tb.x,
      maxWidth: tb.width,
      top: optionsBelow ? tb.y + tb.height + INPLACE_OPTIONS_GAP : tb.y - INPLACE_OPTIONS_GAP,
      // `translate` (not `transform`): the pop-in animation owns `transform`.
      translate: optionsBelow ? undefined : "0 -100%",
    };
    const tooltipSide = optionsBelow
      ? "top"
      : tb.y + tb.height + 34 <= viewH
        ? "bottom"
        : "top";

    return (
      <div
        className="fixed inset-0 select-none overflow-hidden text-[#141416]"
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          ref={viewportRef}
          onMouseDown={handleViewportMouseDown}
          onDoubleClick={handleViewportDoubleClick}
          onMouseMove={handleViewportMouseMove}
          onMouseUp={handleViewportMouseUp}
          onMouseLeave={handleViewportMouseUp}
          className="absolute inset-0"
        >
          {stage}
          {/* Same two-tone frame as the native selection border underneath */}
          <div
            className="pointer-events-none absolute z-30 shadow-[inset_0_0_0_2px_#0095FF]"
            style={{ left: sel.x, top: sel.y, width: sel.width, height: sel.height }}
          >
            {sel.width > 6 && sel.height > 6 && (
              <div className="absolute inset-[2px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.62)]" />
            )}
          </div>
        </div>

        {renderToolOptions(optionsStyle)}

        <InplaceToolbar
          left={tb.x}
          top={tb.y}
          activeTool={textDraft ? "text" : activeTool}
          canUndo={undoStack.length > 0}
          canRedo={redoStack.length > 0}
          tooltipSide={tooltipSide}
          onSelectTool={selectTool}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onAction={finishInplace}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-white text-[#141416]">
      <EditorToolbar
        activeTool={activeTool}
        onSelectTool={selectTool}
        onCopy={() => void handleCopy()}
        onSave={() => void handleSave()}
        onSaveAs={() => void handleSaveAs()}
        onPin={() => void handlePin()}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onClearAnnotations={() => {
          commitAnnotations([]);
          setSelectedId(null);
          setNextCounterNum(1);
        }}
        onOpenPreferences={() => void openPreferencesWindow()}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        hasAnnotations={annotations.length > 0}
        colorDotRef={colorDotRef}
        colorHexRef={colorHexRef}
        onCopyHex={handleCopyHex}
        widthPt={widthPt}
        heightPt={heightPt}
        onOpenResize={() => setResizeOpen(true)}
        zoom={zoom}
        onSetZoom={(z) => {
          setZoom(z);
          setPan({ x: 0, y: 0 });
        }}
        onZoomFit={handleZoomFit}
        backdropEnabled={backdrop.enabled}
      />

      {/* Airy Checkerboard Canvas Viewport */}
      <div
        ref={viewportRef}
        onMouseDown={handleViewportMouseDown}
        onDoubleClick={handleViewportDoubleClick}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={handleViewportMouseUp}
        onMouseLeave={handleViewportMouseUp}
        className="checkerboard-bg relative flex flex-1 select-none items-center justify-center overflow-hidden"
      >
        {renderToolOptions()}

        {stage}

        {/* Minimal Frosted Toast */}
        {toast && (
          <div className="animate-pop-in pointer-events-none absolute bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-full bg-[#1C1C1E]/90 px-4 py-1.5 text-[12px] font-medium text-white antialiased shadow-xl backdrop-blur-md">
            {toast}
          </div>
        )}
      </div>

      {resizeOpen && (
        <ResizeModal
          widthPx={imgSize.w}
          heightPx={imgSize.h}
          scaleFactor={scaleFactor}
          onApply={handleResize}
          onClose={() => setResizeOpen(false)}
        />
      )}
    </div>
  );
}
