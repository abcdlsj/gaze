import { type RefObject, useEffect, useRef, useState } from "react";
import {
  Circle,
  Grid2x2,
  Hash,
  Minus,
  Redo2,
  Save,
  Settings,
  Trash2,
  Undo2,
} from "lucide-react";
import { isMacPlatform } from "../../lib/hotkeys";
import type { EditorTool } from "../../types";

interface Props {
  activeTool: EditorTool;
  onSelectTool: (tool: EditorTool) => void;
  onCopy: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onPin: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearAnnotations: () => void;
  onOpenPreferences: () => void;
  canUndo: boolean;
  canRedo: boolean;
  hasAnnotations: boolean;
  colorDotRef: RefObject<HTMLSpanElement | null>;
  colorHexRef: RefObject<HTMLSpanElement | null>;
  onCopyHex: () => void;
  widthPt: number;
  heightPt: number;
  onOpenResize: () => void;
  zoom: number;
  onSetZoom: (zoom: number) => void;
  onZoomFit: () => void;
  backdropEnabled: boolean;
}

/* Uniform 1.45px SF-Symbols-grade icons faithfully inspired by Reference Image 2 */
const svgProps = {
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "h-[18px] w-[18px]",
};

function CopyIcon() {
  return (
    <svg {...svgProps}>
      <rect x="6.8" y="6.2" width="8.4" height="10.4" rx="1.6" />
      <path d="M12.5 6.2V4.8a1.4 1.4 0 0 0-1.4-1.4H5.4A1.4 1.4 0 0 0 4 4.8v8.4a1.4 1.4 0 0 0 1.4 1.4h1.4" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg {...svgProps}>
      <path d="M4.2 4.8A1.3 1.3 0 0 1 5.5 3.5h7.6L16.5 6.9v8.3a1.3 1.3 0 0 1-1.3 1.3H5.5a1.3 1.3 0 0 1-1.3-1.3V4.8Z" />
      <path d="M7.2 3.5v4h5v-4" />
      <rect x="7" y="11" width="6" height="5.5" rx="0.8" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg {...svgProps}>
      <path d="M12.6 3.6 16.4 7.4l-1.3 1.3-1.1-.4-2.8 2.8.5 2.4-1.2 1.2-2.7-2.7-3.4 3.4M7.8 12l-2.7-2.7 1.2-1.2 2.4.5 2.8-2.8-.4-1.1 1.5-1.1" />
    </svg>
  );
}

function CropExpandIcon() {
  return (
    <svg {...svgProps}>
      <rect x="6.8" y="4" width="6.4" height="12" rx="1.2" />
      <circle cx="3.8" cy="6.2" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="3.8" cy="10" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="3.8" cy="13.8" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="16.2" cy="6.2" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="16.2" cy="10" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="16.2" cy="13.8" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SelectCursorIcon() {
  return (
    <svg {...svgProps}>
      <path
        d="M5 3.8v11.4l3-2.9 1.8 3.6 1.6-.8-1.8-3.6h4.2L5 3.8Z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M14.5 11.8v4.4M12.3 14h4.4" strokeWidth="1.35" />
    </svg>
  );
}

function ArrowToolIcon() {
  return (
    <svg {...svgProps}>
      <path d="M5.2 4.8 14.8 10l-4.2 1.1L9.5 15.3 5.2 4.8Z" />
    </svg>
  );
}

function SerifTextIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
      <text
        x="10"
        y="15.2"
        textAnchor="middle"
        fill="currentColor"
        fontSize="15.5"
        fontWeight="500"
        fontFamily="Georgia, 'Times New Roman', serif"
      >
        T
      </text>
    </svg>
  );
}

function RulerMeasureIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      className="h-[18px] w-[18px]"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
    >
      <text
        x="10"
        y="9.4"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="8.5"
        fontWeight="600"
        fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
      >
        12
      </text>
      <line x1="3.5" y1="14.2" x2="16.5" y2="14.2" />
      <line x1="3.5" y1="11.8" x2="3.5" y2="16.6" />
      <line x1="16.5" y1="11.8" x2="16.5" y2="16.6" />
    </svg>
  );
}

function RectToolIcon() {
  return (
    <svg {...svgProps}>
      <rect x="4" y="4.8" width="12" height="10.4" rx="1.6" />
    </svg>
  );
}

function FrameToolIcon() {
  return (
    <svg {...svgProps}>
      <rect x="4.2" y="4.8" width="11.6" height="10.4" rx="2.6" />
      <rect
        x="6.8"
        y="7.4"
        width="6.4"
        height="5.2"
        rx="1"
        strokeWidth="1.15"
      />
    </svg>
  );
}

function PenToolIcon() {
  return (
    <svg {...svgProps}>
      <path d="M13.6 4.2a1.7 1.7 0 0 1 2.4 2.4L7.8 14.8l-3.4.9.9-3.4 8.3-8.1Z" />
      <path d="m11.8 6 2.4 2.4" />
    </svg>
  );
}

function BlurRedactIcon() {
  return (
    <svg {...svgProps}>
      <circle cx="7.4" cy="12.6" r="2.6" />
      <circle cx="13.8" cy="6.2" r="1.8" />
      <path d="m9.4 10.6 3.1-3.1" />
    </svg>
  );
}

function MoreDotsIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-[18px] w-[18px]">
      <circle cx="5.5" cy="10" r="1.25" />
      <circle cx="10" cy="10" r="1.25" />
      <circle cx="14.5" cy="10" r="1.25" />
    </svg>
  );
}

export function EditorToolbar({
  activeTool,
  onSelectTool,
  onCopy,
  onSave,
  onSaveAs,
  onPin,
  onUndo,
  onRedo,
  onClearAnnotations,
  onOpenPreferences,
  canUndo,
  canRedo,
  hasAnnotations,
  colorDotRef,
  colorHexRef,
  onCopyHex,
  widthPt,
  heightPt,
  onOpenResize,
  zoom,
  onSetZoom,
  onZoomFit,
  backdropEnabled,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<HTMLDivElement | null>(null);
  const isMac = isMacPlatform();

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
      if (zoomRef.current && !zoomRef.current.contains(e.target as Node)) {
        setZoomOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const iconBtn = (active = false) =>
    `flex h-[32px] w-[32px] cursor-pointer items-center justify-center rounded-[7px] transition-all duration-100 ${
      active
        ? "bg-black/[0.09] text-[#1D1D1F] shadow-[inset_0_0.5px_1px_rgba(0,0,0,0.06)]"
        : "text-[#2C2C2E] hover:bg-black/[0.05] hover:text-black active:scale-[0.96]"
    }`;

  return (
    <header
      data-tauri-drag-region
      className={`relative z-30 flex h-[48px] shrink-0 items-center justify-between border-b border-black/[0.08] bg-white/95 pr-3.5 backdrop-blur-md ${
        isMac ? "pl-[80px]" : "pl-3.5"
      }`}
    >
      {/* Left: Primary Actions + Crop */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onCopy}
          title="Copy to Clipboard (⌘C)"
          className={iconBtn(false)}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          onClick={onSave}
          onContextMenu={(e) => {
            e.preventDefault();
            onSaveAs();
          }}
          title="Save Screenshot (⌘S · ⌘⇧S Save As)"
          className={iconBtn(false)}
        >
          <SaveIcon />
        </button>
        <button
          type="button"
          onClick={onPin}
          title="Pin Floating Window"
          className={iconBtn(false)}
        >
          <PinIcon />
        </button>

        <span className="mx-1.5 h-[18px] w-px bg-black/[0.08]" />

        <button
          type="button"
          onClick={() => onSelectTool(activeTool === "crop" ? "select" : "crop")}
          title="Crop Canvas (C)"
          className={iconBtn(activeTool === "crop")}
        >
          <CropExpandIcon />
        </button>
      </div>

      {/* Center: Annotation Tools */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => onSelectTool("select")}
          title="Select & Move (V)"
          className={iconBtn(activeTool === "select")}
        >
          <SelectCursorIcon />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool("arrow")}
          title="Arrow (A)"
          className={iconBtn(activeTool === "arrow")}
        >
          <ArrowToolIcon />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool("text")}
          title="Text (T)"
          className={iconBtn(activeTool === "text")}
        >
          <SerifTextIcon />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool("ruler")}
          title="Measure Distance (R)"
          className={iconBtn(activeTool === "ruler")}
        >
          <RulerMeasureIcon />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool("rect")}
          title="Rectangle (S)"
          className={iconBtn(activeTool === "rect")}
        >
          <RectToolIcon />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool(activeTool === "frame" ? "select" : "frame")}
          title="Frame & Backdrop (F)"
          className={iconBtn(activeTool === "frame" || backdropEnabled)}
        >
          <FrameToolIcon />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool("pen")}
          title="Freehand Pen (P)"
          className={iconBtn(activeTool === "pen")}
        >
          <PenToolIcon />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool("blur")}
          title="Blur / Redact (B)"
          className={iconBtn(activeTool === "blur" || activeTool === "pixelate")}
        >
          <BlurRedactIcon />
        </button>

        {/* More tools dropdown */}
        <div ref={moreRef} className="relative">
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            title="More Tools & Actions"
            className={iconBtn(
              moreOpen ||
                activeTool === "ellipse" ||
                activeTool === "line" ||
                activeTool === "counter",
            )}
          >
            <MoreDotsIcon />
          </button>

          {moreOpen && (
            <div className="animate-pop-in absolute left-0 top-full z-50 mt-2 w-48 rounded-xl border border-black/[0.08] bg-white/95 py-1.5 text-[12.5px] text-[#1D1D1F] shadow-[0_12px_36px_rgba(0,0,0,0.14)] backdrop-blur-xl">
              <button
                type="button"
                onClick={() => {
                  onSelectTool("ellipse");
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <Circle className="h-3.5 w-3.5 text-[#515154]" /> Ellipse
                </span>
                <span className="text-[11px] text-[#AEAEB2]">O</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("line");
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <Minus className="h-3.5 w-3.5 text-[#515154]" /> Line
                </span>
                <span className="text-[11px] text-[#AEAEB2]">L</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("counter");
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <Hash className="h-3.5 w-3.5 text-[#515154]" /> Step Counter
                </span>
                <span className="text-[11px] text-[#AEAEB2]">N</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("pixelate");
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <Grid2x2 className="h-3.5 w-3.5 text-[#515154]" /> Pixelate
                </span>
                <span className="text-[11px] text-[#AEAEB2]">X</span>
              </button>

              <div className="my-1 h-px bg-black/[0.06]" />

              <button
                type="button"
                disabled={!canUndo}
                onClick={() => {
                  onUndo();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05] disabled:cursor-default disabled:opacity-35"
              >
                <span className="flex items-center gap-2">
                  <Undo2 className="h-3.5 w-3.5 text-[#515154]" /> Undo
                </span>
                <span className="text-[11px] text-[#AEAEB2]">⌘Z</span>
              </button>
              <button
                type="button"
                disabled={!canRedo}
                onClick={() => {
                  onRedo();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05] disabled:cursor-default disabled:opacity-35"
              >
                <span className="flex items-center gap-2">
                  <Redo2 className="h-3.5 w-3.5 text-[#515154]" /> Redo
                </span>
                <span className="text-[11px] text-[#AEAEB2]">⌘⇧Z</span>
              </button>
              <button
                type="button"
                disabled={!hasAnnotations}
                onClick={() => {
                  onClearAnnotations();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-[#FF3B30] hover:bg-[#FF3B30]/[0.06] disabled:cursor-default disabled:opacity-35"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear Annotations
              </button>

              <div className="my-1 h-px bg-black/[0.06]" />

              <button
                type="button"
                onClick={() => {
                  onSaveAs();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <Save className="h-3.5 w-3.5 text-[#515154]" /> Save As…
                </span>
                <span className="text-[11px] text-[#AEAEB2]">⌘⇧S</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onOpenPreferences();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <Settings className="h-3.5 w-3.5 text-[#515154]" /> Preferences…
                </span>
                <span className="text-[11px] text-[#AEAEB2]">⌘,</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right: Live Inspector matching Reference Image 2 */}
      <div className="flex items-center gap-3">
        {/* Live Color Well + Hex (updated directly via refs for 0 React re-renders) */}
        <button
          type="button"
          onClick={onCopyHex}
          title="Click or press Tab to copy color"
          className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition hover:bg-black/[0.04]"
        >
          <span
            ref={colorDotRef}
            className="h-[22px] w-[22px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]"
            style={{ backgroundColor: "#000000" }}
          />
          <div className="flex flex-col leading-[1.2]">
            <span
              ref={colorHexRef}
              className="font-mono text-[12px] font-semibold tracking-[-0.01em] text-[#1D1D1F]"
            >
              #000000
            </span>
            <span className="text-[10.5px] text-[#86868B]">Tab to copy</span>
          </div>
        </button>

        <span className="h-[26px] w-px bg-black/[0.08]" />

        {/* Image Size */}
        <button
          type="button"
          onClick={onOpenResize}
          title="Click to resize image"
          className="flex cursor-pointer flex-col rounded-lg px-1.5 py-1 text-left leading-[1.2] transition hover:bg-black/[0.04]"
        >
          <span className="text-[12px] font-semibold tabular-nums tracking-[-0.01em] text-[#1D1D1F]">
            {widthPt}×{heightPt}pt
          </span>
          <span className="text-[10.5px] text-[#86868B]">Image size</span>
        </button>

        <span className="h-[26px] w-px bg-black/[0.08]" />

        {/* Zoom */}
        <div ref={zoomRef} className="relative">
          <button
            type="button"
            onClick={() => setZoomOpen((v) => !v)}
            title="Change Zoom (⌘+ / ⌘- / ⌘0)"
            className="flex min-w-[46px] cursor-pointer flex-col rounded-lg px-1.5 py-1 text-left leading-[1.2] transition hover:bg-black/[0.04]"
          >
            <span className="text-[12px] font-semibold tabular-nums tracking-[-0.01em] text-[#1D1D1F]">
              {Math.round(zoom * 100)}%
            </span>
            <span className="text-[10.5px] text-[#86868B]">Zoom</span>
          </button>

          {zoomOpen && (
            <div className="animate-pop-in absolute right-0 top-full z-50 mt-2 w-28 rounded-xl border border-black/[0.08] bg-white/95 py-1 text-[12px] text-[#1D1D1F] shadow-[0_12px_36px_rgba(0,0,0,0.14)] backdrop-blur-xl">
              <button
                type="button"
                onClick={() => {
                  onZoomFit();
                  setZoomOpen(false);
                }}
                className="flex w-full cursor-pointer px-3 py-1.5 text-left hover:bg-black/[0.05]"
              >
                Fit Window
              </button>
              <div className="my-1 h-px bg-black/[0.06]" />
              {[0.5, 1, 1.5, 2, 4].map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => {
                    onSetZoom(z);
                    setZoomOpen(false);
                  }}
                  className="flex w-full cursor-pointer justify-between px-3 py-1.5 text-left tabular-nums hover:bg-black/[0.05]"
                >
                  <span>{Math.round(z * 100)}%</span>
                  {Math.abs(zoom - z) < 0.02 && (
                    <span className="text-[#007AFF]">●</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
