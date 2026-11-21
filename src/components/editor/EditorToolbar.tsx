import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Copy,
  Crop,
  Droplet,
  Frame,
  Grid2x2,
  Hash,
  Minus,
  MoreHorizontal,
  MousePointer2,
  Pencil,
  Pin,
  Redo2,
  Save,
  Settings,
  Square,
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
  hoverHex: string;
  onCopyHex: () => void;
  widthPt: number;
  heightPt: number;
  onOpenResize: () => void;
  zoom: number;
  onSetZoom: (zoom: number) => void;
  onZoomFit: () => void;
  backdropEnabled: boolean;
}

/** Custom crisp ruler icon matching the "12" pixel-measure icon from Reference Image 2 */
function RulerMeasureIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      className="h-[18px] w-[18px]"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <text
        x="10"
        y="9.5"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="8.5"
        fontWeight="600"
        fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
      >
        12
      </text>
      <line x1="3.5" y1="14" x2="16.5" y2="14" />
      <line x1="3.5" y1="11.5" x2="3.5" y2="16.5" />
      <line x1="16.5" y1="11.5" x2="16.5" y2="16.5" />
    </svg>
  );
}

/** Crisp serif 'T' text icon matching Reference Image 2 */
function SerifTextIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
      <text
        x="10"
        y="15"
        textAnchor="middle"
        fill="currentColor"
        fontSize="15"
        fontWeight="500"
        fontFamily="Georgia, 'Times New Roman', serif"
      >
        T
      </text>
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
  hoverHex,
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
    `flex h-[30px] w-[30px] items-center justify-center rounded-[7px] transition ${
      active
        ? "bg-neutral-200/90 text-neutral-950"
        : "text-neutral-700 hover:bg-neutral-200/55 hover:text-neutral-950"
    }`;

  return (
    <header
      data-tauri-drag-region
      className={`relative z-30 flex h-[48px] shrink-0 items-center justify-between border-b border-neutral-200/85 bg-[#FBFBFB] pr-3 ${
        isMac ? "pl-[78px]" : "pl-3"
      }`}
    >
      {/* Left: Action buttons + Crop */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onCopy}
          title="Copy to Clipboard (⌘C)"
          className={iconBtn(false)}
        >
          <Copy className="h-[16px] w-[16px] stroke-[1.65]" />
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
          <Save className="h-[16px] w-[16px] stroke-[1.65]" />
        </button>
        <button
          type="button"
          onClick={onPin}
          title="Pin Screenshot Always-on-Top"
          className={iconBtn(false)}
        >
          <Pin className="h-[16px] w-[16px] stroke-[1.65]" />
        </button>

        <span className="mx-1.5 h-[18px] w-px bg-neutral-200" />

        <button
          type="button"
          onClick={() => onSelectTool(activeTool === "crop" ? "select" : "crop")}
          title="Crop Canvas (C)"
          className={iconBtn(activeTool === "crop")}
        >
          <Crop className="h-[16px] w-[16px] stroke-[1.65]" />
        </button>
      </div>

      {/* Center: Primary Annotation Tools */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => onSelectTool("select")}
          title="Select & Move (V)"
          className={iconBtn(activeTool === "select")}
        >
          <MousePointer2 className="h-[16px] w-[16px] stroke-[1.65]" />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool("arrow")}
          title="Arrow (A)"
          className={iconBtn(activeTool === "arrow")}
        >
          <ArrowUpRight className="h-[17px] w-[17px] stroke-[1.7]" />
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
          <Square className="h-[15px] w-[15px] stroke-[1.65]" />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool(activeTool === "frame" ? "select" : "frame")}
          title="Frame & Backdrop (F)"
          className={iconBtn(activeTool === "frame" || backdropEnabled)}
        >
          <Frame className="h-[16px] w-[16px] stroke-[1.65]" />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool("pen")}
          title="Freehand Pen (P)"
          className={iconBtn(activeTool === "pen")}
        >
          <Pencil className="h-[15px] w-[15px] stroke-[1.65]" />
        </button>
        <button
          type="button"
          onClick={() => onSelectTool("blur")}
          title="Blur / Redact (B)"
          className={iconBtn(activeTool === "blur" || activeTool === "pixelate")}
        >
          <Droplet className="h-[15px] w-[15px] stroke-[1.65]" />
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
            <MoreHorizontal className="h-[16px] w-[16px] stroke-[1.8]" />
          </button>

          {moreOpen && (
            <div className="absolute left-0 top-full z-50 mt-1.5 w-48 rounded-xl border border-neutral-200/90 bg-white py-1.5 text-[12.5px] text-neutral-700 shadow-xl">
              <button
                type="button"
                onClick={() => {
                  onSelectTool("ellipse");
                  setMoreOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-neutral-100"
              >
                <span className="flex items-center gap-2">
                  <Circle className="h-3.5 w-3.5" /> Ellipse
                </span>
                <span className="text-[11px] text-neutral-400">O</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("line");
                  setMoreOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-neutral-100"
              >
                <span className="flex items-center gap-2">
                  <Minus className="h-3.5 w-3.5" /> Line
                </span>
                <span className="text-[11px] text-neutral-400">L</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("counter");
                  setMoreOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-neutral-100"
              >
                <span className="flex items-center gap-2">
                  <Hash className="h-3.5 w-3.5" /> Step Counter
                </span>
                <span className="text-[11px] text-neutral-400">N</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("pixelate");
                  setMoreOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-neutral-100"
              >
                <span className="flex items-center gap-2">
                  <Grid2x2 className="h-3.5 w-3.5" /> Pixelate
                </span>
                <span className="text-[11px] text-neutral-400">X</span>
              </button>

              <hr className="my-1 border-neutral-200/80" />

              <button
                type="button"
                disabled={!canUndo}
                onClick={() => {
                  onUndo();
                  setMoreOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-neutral-100 disabled:opacity-40"
              >
                <span className="flex items-center gap-2">
                  <Undo2 className="h-3.5 w-3.5" /> Undo
                </span>
                <span className="text-[11px] text-neutral-400">⌘Z</span>
              </button>
              <button
                type="button"
                disabled={!canRedo}
                onClick={() => {
                  onRedo();
                  setMoreOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-neutral-100 disabled:opacity-40"
              >
                <span className="flex items-center gap-2">
                  <Redo2 className="h-3.5 w-3.5" /> Redo
                </span>
                <span className="text-[11px] text-neutral-400">⌘⇧Z</span>
              </button>
              <button
                type="button"
                disabled={!hasAnnotations}
                onClick={() => {
                  onClearAnnotations();
                  setMoreOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear Annotations
              </button>

              <hr className="my-1 border-neutral-200/80" />

              <button
                type="button"
                onClick={() => {
                  onSaveAs();
                  setMoreOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-neutral-100"
              >
                <span className="flex items-center gap-2">
                  <Save className="h-3.5 w-3.5" /> Save As…
                </span>
                <span className="text-[11px] text-neutral-400">⌘⇧S</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onOpenPreferences();
                  setMoreOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-neutral-100"
              >
                <span className="flex items-center gap-2">
                  <Settings className="h-3.5 w-3.5" /> Preferences…
                </span>
                <span className="text-[11px] text-neutral-400">⌘,</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right: Live Color Inspector, Image Size, Zoom */}
      <div className="flex items-center gap-2.5">
        {/* Color Swatch + Hex */}
        <button
          type="button"
          onClick={onCopyHex}
          title="Click or press Tab to copy color"
          className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition hover:bg-neutral-200/50"
        >
          <span
            className="h-[18px] w-[18px] shrink-0 rounded-full border border-black/15 shadow-2xs"
            style={{ backgroundColor: hoverHex }}
          />
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[11.5px] font-medium text-neutral-800">
              {hoverHex}
            </span>
            <span className="text-[10px] text-neutral-400">Tab to copy</span>
          </div>
        </button>

        <span className="h-[24px] w-px bg-neutral-200/90" />

        {/* Image Size */}
        <button
          type="button"
          onClick={onOpenResize}
          title="Click to resize image"
          className="flex flex-col rounded-md px-1.5 py-0.5 text-left leading-tight transition hover:bg-neutral-200/50"
        >
          <span className="text-[11.5px] font-medium tabular-nums text-neutral-800">
            {widthPt}×{heightPt}pt
          </span>
          <span className="text-[10px] text-neutral-400">Image size</span>
        </button>

        <span className="h-[24px] w-px bg-neutral-200/90" />

        {/* Zoom */}
        <div ref={zoomRef} className="relative">
          <button
            type="button"
            onClick={() => setZoomOpen((v) => !v)}
            title="Change Zoom (⌘+ / ⌘- / ⌘0)"
            className="flex min-w-[46px] flex-col rounded-md px-1.5 py-0.5 text-left leading-tight transition hover:bg-neutral-200/50"
          >
            <span className="text-[11.5px] font-medium tabular-nums text-neutral-800">
              {Math.round(zoom * 100)}%
            </span>
            <span className="text-[10px] text-neutral-400">Zoom</span>
          </button>

          {zoomOpen && (
            <div className="absolute right-0 top-full z-50 mt-1.5 w-28 rounded-xl border border-neutral-200 bg-white py-1 text-[12px] text-neutral-700 shadow-xl">
              <button
                type="button"
                onClick={() => {
                  onZoomFit();
                  setZoomOpen(false);
                }}
                className="flex w-full px-3 py-1.5 text-left hover:bg-neutral-100"
              >
                Fit Window
              </button>
              <hr className="my-1 border-neutral-200/70" />
              {[0.5, 1, 1.5, 2, 4].map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => {
                    onSetZoom(z);
                    setZoomOpen(false);
                  }}
                  className="flex w-full justify-between px-3 py-1.5 text-left tabular-nums hover:bg-neutral-100"
                >
                  <span>{Math.round(z * 100)}%</span>
                  {Math.abs(zoom - z) < 0.02 && (
                    <span className="text-[#0A84FF]">●</span>
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
