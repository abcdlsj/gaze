import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  computeLayout,
  exportCompositePng,
  hitTestAnnotation,
  renderComposite,
  translateAnnotation,
} from "../lib/canvas-render";
import {
  copyImageBytes,
  copyTextToClipboard,
  getCaptureImageBytes,
  getCaptureMeta,
  getSettings,
  openPreferencesWindow,
  pinImageBytes,
  saveImageBytes,
} from "../lib/tauri";
import type {
  Annotation,
  AppSettings,
  BackdropConfig,
  EditorTool,
  Point,
} from "../types";
import { EditorToolbar } from "../components/editor/EditorToolbar";
import { ToolOptionsBar } from "../components/editor/ToolOptionsBar";
import { ResizeModal } from "../components/editor/ResizeModal";

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

export function EditorWindow({ captureId }: { captureId: string }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
  const [activeTool, setActiveTool] = useState<EditorTool>("select");
  const [color, setColor] = useState<string>("#EF4444");
  const [strokeWidth, setStrokeWidth] = useState<number>(3);
  const [fontSize, setFontSize] = useState<number>(16);
  const [blurStrength, setBlurStrength] = useState<number>(12);
  const [filled, setFilled] = useState<boolean>(false);
  const [highlighter, setHighlighter] = useState<boolean>(false);

  const [backdrop, setBackdrop] = useState<BackdropConfig>({
    enabled: false,
    padding: 48,
    cornerRadius: 12,
    shadow: true,
    background: "linear-gradient(135deg, #0EA5E9, #2563EB, #6366F1)",
  });

  // Annotations + Undo/Redo stacks
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [undoStack, setUndoStack] = useState<Annotation[][]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftAnn, setDraftAnn] = useState<Annotation | null>(null);

  // Inline text editor
  const [textDraft, setTextDraft] = useState<{
    x: number;
    y: number;
    value: string;
  } | null>(null);

  // Crop overlay state (in image pixel coordinates)
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [resizeOpen, setResizeOpen] = useState(false);

  // Inspector & feedback
  const [hoverHex, setHoverHex] = useState<string>("#000000");
  const [toast, setToast] = useState<string | null>(null);

  const dragRef = useRef<{
    kind: "pan" | "draw" | "move-ann" | "crop";
    startClient: Point;
    startImg: Point;
    origPan?: Point;
    origAnn?: Annotation;
    origCrop?: CropRect;
    cropEdge?: "move" | "nw" | "ne" | "sw" | "se";
  } | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1300);
  }, []);

  // Load capture image and preferences
  useEffect(() => {
    let active = true;
    let url: string | null = null;

    void (async () => {
      try {
        const [meta, bytes, s] = await Promise.all([
          getCaptureMeta(captureId),
          getCaptureImageBytes(captureId),
          getSettings(),
        ]);
        if (!active) return;

        setSettings(s);
        setScaleFactor(meta.scale_factor || 1);
        setColor(s.editor.default_color);
        setStrokeWidth(s.editor.stroke_width);
        setFontSize(s.editor.font_size);
        setBlurStrength(s.editor.blur_strength);

        url = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }),
        );
        const img = new Image();
        img.onload = () => {
          if (!active) return;
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext("2d")?.drawImage(img, 0, 0);
          setSourceCanvas(c);
          setImgSize({ w: img.naturalWidth, h: img.naturalHeight });

          // Auto-fit if image is larger than viewport, otherwise crisp 100% (1:1 pt)
          const vp = viewportRef.current;
          if (vp) {
            const logicalW = img.naturalWidth / (meta.scale_factor || 1);
            const logicalH = img.naturalHeight / (meta.scale_factor || 1);
            const fitW = (vp.clientWidth - 64) / Math.max(1, logicalW);
            const fitH = (vp.clientHeight - 64) / Math.max(1, logicalH);
            const initialZoom = Math.min(1, fitW, fitH);
            setZoom(Math.max(0.15, Number(initialZoom.toFixed(2))));
          }
        };
        img.src = url;
      } catch (err) {
        console.error("Failed to load capture:", err);
      }
    })();

    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [captureId]);

  const layout = useMemo(
    () => computeLayout(imgSize.w, imgSize.h, backdrop),
    [imgSize, backdrop],
  );

  const displayedAnnotations = useMemo(
    () => (draftAnn ? [...annotations, draftAnn] : annotations),
    [annotations, draftAnn],
  );

  // Redraw composite canvas whenever image, backdrop, annotations, or selection changes
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
    );
  }, [
    sourceCanvas,
    imgSize,
    scaleFactor,
    backdrop,
    displayedAnnotations,
    selectedId,
    layout,
  ]);

  const commitAnnotations = useCallback(
    (next: Annotation[]) => {
      setUndoStack((u) => [...u.slice(-39), annotations]);
      setRedoStack([]);
      setAnnotations(next);
    },
    [annotations],
  );

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((u) => u.slice(0, -1));
    setRedoStack((r) => [...r, annotations]);
    setAnnotations(prev);
    setSelectedId(null);
  }, [undoStack, annotations]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u, annotations]);
    setAnnotations(next);
    setSelectedId(null);
  }, [redoStack, annotations]);

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

  // Enter crop mode initializes full crop box
  const selectTool = useCallback(
    (tool: EditorTool) => {
      setTextDraft(null);
      setActiveTool(tool);
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
    [imgSize, backdrop.enabled],
  );

  const applyCrop = useCallback(() => {
    if (!cropRect || !sourceCanvas) return;
    const rx = Math.max(0, Math.round(cropRect.x));
    const ry = Math.max(0, Math.round(cropRect.y));
    const rw = Math.max(8, Math.min(imgSize.w - rx, Math.round(cropRect.w)));
    const rh = Math.max(8, Math.min(imgSize.h - ry, Math.round(cropRect.h)));

    const nextCanvas = document.createElement("canvas");
    nextCanvas.width = rw;
    nextCanvas.height = rh;
    nextCanvas
      .getContext("2d")
      ?.drawImage(sourceCanvas, rx, ry, rw, rh, 0, 0, rw, rh);

    setSourceCanvas(nextCanvas);
    setImgSize({ w: rw, h: rh });
    // Shift existing annotations to match cropped origin
    setAnnotations((prev) => prev.map((a) => translateAnnotation(a, -rx, -ry)));
    setCropRect(null);
    setActiveTool("select");
    showToast(`Cropped to ${Math.round(rw / scaleFactor)}×${Math.round(rh / scaleFactor)}pt`);
  }, [cropRect, sourceCanvas, imgSize, scaleFactor, showToast]);

  const handleResize = useCallback(
    (newW: number, newH: number) => {
      if (!sourceCanvas) return;
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
      // Scale annotations proportionally
      setAnnotations((prev) =>
        prev.map((a) => {
          switch (a.type) {
            case "rect":
            case "ellipse":
            case "blur":
            case "pixelate":
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
    [sourceCanvas, imgSize, scaleFactor, showToast],
  );

  // Export actions
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

  const handleCopy = useCallback(async () => {
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
  }, [buildExportBytes, settings, showToast]);

  const handleSave = useCallback(async () => {
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
  }, [buildExportBytes, scaleFactor, settings, showToast]);

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
    try {
      const bytes = await buildExportBytes();
      await pinImageBytes(bytes, scaleFactor);
      showToast("Pinned on Screen");
    } catch (e) {
      showToast(`Pin failed: ${String(e)}`);
    }
  }, [buildExportBytes, scaleFactor, showToast]);

  const handleCopyHex = useCallback(() => {
    void copyTextToClipboard(hoverHex).then(() =>
      showToast(`Copied ${hoverHex}`),
    );
  }, [hoverHex, showToast]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (textDraft || resizeOpen) return;

      if (e.code === "Space") {
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
        void getCurrentWindow().close();
        return;
      }

      if (e.key === "Enter" && activeTool === "crop") {
        e.preventDefault();
        applyCrop();
        return;
      }

      if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
        e.preventDefault();
        commitAnnotations(annotations.filter((a) => a.id !== selectedId));
        setSelectedId(null);
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();

      if (mod && k === "c") {
        e.preventDefault();
        void handleCopy();
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
    textDraft,
    resizeOpen,
    activeTool,
    selectedId,
    annotations,
    applyCrop,
    commitAnnotations,
    handleCopy,
    handleCopyHex,
    handleRedo,
    handleSave,
    handleSaveAs,
    handleUndo,
    selectTool,
  ]);

  // Map client pointer coordinates into image pixel space
  const clientToImagePoint = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const cx = ((clientX - rect.left) / Math.max(1, rect.width)) * layout.canvasWidth;
      const cy = ((clientY - rect.top) / Math.max(1, rect.height)) * layout.canvasHeight;
      return {
        x: cx - layout.offsetX,
        y: cy - layout.offsetY,
      };
    },
    [layout],
  );

  // Sample exact hex color under cursor on the composite canvas
  const sampleColorAtClient = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
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
        canvas.width - 1,
        Math.max(
          0,
          Math.floor(((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width),
        ),
      );
      const py = Math.min(
        canvas.height - 1,
        Math.max(
          0,
          Math.floor(((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height),
        ),
      );
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const data = ctx.getImageData(px, py, 1, 1).data;
      setHoverHex(rgbToHex(data[0], data[1], data[2]));
    },
    [],
  );

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || spacePressed) {
      dragRef.current = {
        kind: "pan",
        startClient: { x: e.clientX, y: e.clientY },
        startImg: { x: 0, y: 0 },
        origPan: { ...pan },
      };
      return;
    }

    if (e.button !== 0) return;

    const pt = clientToImagePoint(e.clientX, e.clientY);
    if (!pt) return;

    if (activeTool === "crop") {
      return;
    }

    if (activeTool === "text") {
      setTextDraft({ x: pt.x, y: pt.y, value: "" });
      return;
    }

    if (activeTool === "counter") {
      const nextNum =
        annotations.filter((a) => a.type === "counter").length + 1;
      const ann: Annotation = {
        id: crypto.randomUUID(),
        type: "counter",
        x: pt.x,
        y: pt.y,
        number: nextNum,
        radius: 14,
        color,
        strokeWidth,
      };
      commitAnnotations([...annotations, ann]);
      return;
    }

    if (activeTool === "select" || activeTool === "frame") {
      const hit = hitTestAnnotation(annotations, pt, scaleFactor);
      setSelectedId(hit?.id ?? null);
      if (hit) {
        dragRef.current = {
          kind: "move-ann",
          startClient: { x: e.clientX, y: e.clientY },
          startImg: pt,
          origAnn: hit,
        };
      }
      return;
    }

    // Begin drawing a new annotation
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
          filled,
          color,
          strokeWidth,
        };
        break;
      case "blur":
      case "pixelate":
        initial = {
          id,
          type: activeTool,
          x: pt.x,
          y: pt.y,
          width: 0,
          height: 0,
          strength: blurStrength,
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
    if (!drag) return;

    if (drag.kind === "pan" && drag.origPan) {
      setPan({
        x: drag.origPan.x + (e.clientX - drag.startClient.x),
        y: drag.origPan.y + (e.clientY - drag.startClient.y),
      });
      return;
    }

    const pt = clientToImagePoint(e.clientX, e.clientY);
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
      if (drag.cropEdge.includes("w")) x1 = Math.max(0, Math.min(x2 - 16, o.x + dx));
      if (drag.cropEdge.includes("e")) x2 = Math.min(imgSize.w, Math.max(x1 + 16, o.x + o.w + dx));
      if (drag.cropEdge.includes("n")) y1 = Math.max(0, Math.min(y2 - 16, o.y + dy));
      if (drag.cropEdge.includes("s")) y2 = Math.min(imgSize.h, Math.max(y1 + 16, o.y + o.h + dy));
      setCropRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
      return;
    }

    if (drag.kind === "move-ann" && drag.origAnn) {
      const dx = pt.x - drag.startImg.x;
      const dy = pt.y - drag.startImg.y;
      const moved = translateAnnotation(drag.origAnn, dx, dy);
      setAnnotations((prev) =>
        prev.map((a) => (a.id === moved.id ? moved : a)),
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
            // Snap to horizontal/vertical/45° when holding Shift
            let end = pt;
            if (e.shiftKey) {
              const dx = pt.x - curr.start.x;
              const dy = pt.y - curr.start.y;
              const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
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
            return {
              ...curr,
              width: pt.x - drag.startImg.x,
              height: pt.y - drag.startImg.y,
            };
          case "pen":
            return { ...curr, points: [...curr.points, pt] };
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

    if (drag.kind === "draw" && draftAnn) {
      const meaningful =
        draftAnn.type === "pen"
          ? draftAnn.points.length > 2
          : draftAnn.type === "arrow" ||
              draftAnn.type === "line" ||
              draftAnn.type === "ruler"
            ? Math.hypot(
                draftAnn.end.x - draftAnn.start.x,
                draftAnn.end.y - draftAnn.start.y,
              ) > 4
            : draftAnn.type === "rect" ||
                draftAnn.type === "ellipse" ||
                draftAnn.type === "blur" ||
                draftAnn.type === "pixelate"
              ? Math.abs(draftAnn.width) > 4 && Math.abs(draftAnn.height) > 4
              : true;

      if (meaningful) {
        commitAnnotations([...annotations, draftAnn]);
      }
      setDraftAnn(null);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setZoom((z) =>
        Math.max(0.15, Math.min(8, Number((z * factor).toFixed(2)))),
      );
    } else {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };

  const commitTextDraft = () => {
    if (!textDraft) return;
    if (textDraft.value.trim()) {
      const ann: Annotation = {
        id: crypto.randomUUID(),
        type: "text",
        x: textDraft.x,
        y: textDraft.y,
        text: textDraft.value,
        fontSize,
        color,
        strokeWidth,
      };
      commitAnnotations([...annotations, ann]);
    }
    setTextDraft(null);
  };

  const startCropDrag = (
    edge: "move" | "nw" | "ne" | "sw" | "se",
    e: React.MouseEvent,
  ) => {
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

  return (
    <div className="flex h-full w-full flex-col bg-white text-neutral-900">
      <EditorToolbar
        activeTool={activeTool}
        onSelectTool={selectTool}
        onCopy={() => void handleCopy()}
        onSave={() => void handleSave()}
        onSaveAs={() => void handleSaveAs()}
        onPin={() => void handlePin()}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onClearAnnotations={() => commitAnnotations([])}
        onOpenPreferences={() => void openPreferencesWindow()}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        hasAnnotations={annotations.length > 0}
        hoverHex={hoverHex}
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

      {/* Main Checkerboard Canvas Viewport */}
      <div
        ref={viewportRef}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={handleViewportMouseUp}
        onMouseLeave={handleViewportMouseUp}
        onWheel={handleWheel}
        className={`checkerboard-bg relative flex flex-1 items-center justify-center overflow-hidden ${
          spacePressed
            ? "cursor-grab active:cursor-grabbing"
            : activeTool === "select"
              ? "cursor-default"
              : activeTool === "text"
                ? "cursor-text"
                : "cursor-crosshair"
        }`}
      >
        <ToolOptionsBar
          activeTool={activeTool}
          color={color}
          onColorChange={setColor}
          strokeWidth={strokeWidth}
          onStrokeWidthChange={setStrokeWidth}
          fontSize={fontSize}
          onFontSizeChange={setFontSize}
          blurStrength={blurStrength}
          onBlurStrengthChange={setBlurStrength}
          filled={filled}
          onFilledChange={setFilled}
          highlighter={highlighter}
          onHighlighterChange={setHighlighter}
          backdrop={backdrop}
          onBackdropChange={setBackdrop}
          onSelectTool={selectTool}
          onApplyCrop={applyCrop}
          onCancelCrop={() => {
            setCropRect(null);
            setActiveTool("select");
          }}
        />

        {/* Positioned Canvas Stage */}
        <div
          style={{
            width: displayW,
            height: displayH,
            transform: `translate(${pan.x}px, ${pan.y}px)`,
          }}
          className="relative shrink-0"
        >
          <canvas
            ref={canvasRef}
            onMouseDown={handleCanvasMouseDown}
            style={{
              width: displayW,
              height: displayH,
              imageRendering: zoom >= 2 ? "pixelated" : "auto",
            }}
            className="block shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
          />

          {/* Inline text box when placing Text annotation */}
          {textDraft && (
            <textarea
              autoFocus
              rows={1}
              value={textDraft.value}
              onChange={(e) =>
                setTextDraft({ ...textDraft, value: e.target.value })
              }
              onBlur={commitTextDraft}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setTextDraft(null);
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitTextDraft();
                }
              }}
              style={{
                left: ((textDraft.x + layout.offsetX) / scaleFactor) * zoom,
                top: ((textDraft.y + layout.offsetY) / scaleFactor) * zoom,
                color,
                fontSize: `${fontSize * zoom}px`,
                lineHeight: 1.25,
              }}
              placeholder="Type…"
              className="absolute z-30 min-w-[120px] resize-none rounded border border-[#0A84FF] bg-white/85 px-1.5 py-0.5 font-semibold outline-none shadow"
            />
          )}

          {/* Interactive Crop Frame */}
          {activeTool === "crop" && cropRect && (
            <div
              onMouseDown={(e) => startCropDrag("move", e)}
              style={{
                left: ((cropRect.x + layout.offsetX) / scaleFactor) * zoom,
                top: ((cropRect.y + layout.offsetY) / scaleFactor) * zoom,
                width: (cropRect.w / scaleFactor) * zoom,
                height: (cropRect.h / scaleFactor) * zoom,
                boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.35)",
              }}
              className="absolute z-20 cursor-move border-2 border-[#0A84FF]"
            >
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
                  className={`absolute h-3 w-3 rounded-full border-2 border-[#0A84FF] bg-white shadow ${cls}`}
                />
              ))}
            </div>
          )}
        </div>

        {/* Crisp minimal toast */}
        {toast && (
          <div className="pointer-events-none absolute bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-full bg-neutral-900/88 px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg">
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
