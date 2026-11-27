import { type RefObject, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Copy,
  Crop,
  Ellipsis,
  EyeOff,
  Focus,
  Grid3x3,
  MousePointer2,
  Pencil,
  Pin,
  Redo2,
  Ruler,
  Save,
  Settings,
  Slash,
  Square,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { isMacPlatform } from "../../lib/hotkeys";
import type { EditorTool } from "../../types";
import { Tooltip } from "../ui/Tooltip";

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

/* Crisp custom icons matching Lucide 1.75 stroke weight for tools with unique screenshot semantics */
function BackdropFrameIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[17px] w-[17px]"
    >
      <rect x="2.5" y="3.2" width="15" height="13.6" rx="2.6" />
      <rect
        x="5.6"
        y="6.2"
        width="8.8"
        height="7.6"
        rx="1.2"
        fill="currentColor"
        fillOpacity={0.14}
      />
    </svg>
  );
}

export function MosaicBlurIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[17px] w-[17px]"
    >
      <rect x="3" y="3" width="14" height="14" rx="2.5" />
      <rect
        x="5.4"
        y="5.4"
        width="3"
        height="3"
        rx="0.4"
        fill="currentColor"
        stroke="none"
      />
      <rect
        x="11.6"
        y="5.4"
        width="3"
        height="3"
        rx="0.4"
        fill="currentColor"
        stroke="none"
      />
      <rect
        x="8.5"
        y="8.5"
        width="3"
        height="3"
        rx="0.4"
        fill="currentColor"
        stroke="none"
      />
      <rect
        x="5.4"
        y="11.6"
        width="3"
        height="3"
        rx="0.4"
        fill="currentColor"
        stroke="none"
      />
      <rect
        x="11.6"
        y="11.6"
        width="3"
        height="3"
        rx="0.4"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export function StepCounterIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8.7 7.6 10.4 6.5v7M8.8 13.5h3.1" strokeWidth={1.6} />
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
  const modKey = isMac ? "⌘" : "Ctrl+";

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

  const iconCls = "h-[16px] w-[16px] stroke-[1.75]";

  const iconBtn = (active = false, disabled = false) =>
    `flex h-[30px] w-[30px] items-center justify-center rounded-[7px] transition-all duration-100 ${
      disabled
        ? "cursor-default text-[#27272A]/30"
        : active
          ? "cursor-pointer bg-[#007AFF]/[0.11] text-[#0066D6] shadow-[inset_0_0_0_1px_rgba(0,122,255,0.18)]"
          : "cursor-pointer text-[#27272A] hover:bg-black/[0.06] hover:text-[#09090B] active:scale-[0.95]"
    }`;

  const isRedactActive =
    activeTool === "blur" ||
    activeTool === "pixelate" ||
    activeTool === "blackout";

  return (
    <header
      data-tauri-drag-region
      className={`relative z-30 flex h-[48px] shrink-0 items-center justify-between border-b border-black/[0.08] bg-white/95 pr-3 backdrop-blur-md ${
        isMac ? "pl-[76px]" : "pl-3"
      }`}
    >
      {/* Left: Primary Actions + Crop + Undo */}
      <div className="flex items-center gap-0.5">
        <Tooltip label="Copy" shortcut={`${modKey}C`} align="left">
          <button type="button" onClick={onCopy} className={iconBtn(false)}>
            <Copy className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Save" shortcut={`${modKey}S`}>
          <button
            type="button"
            onClick={onSave}
            onContextMenu={(e) => {
              e.preventDefault();
              onSaveAs();
            }}
            className={iconBtn(false)}
          >
            <Save className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Pin on Screen">
          <button type="button" onClick={onPin} className={iconBtn(false)}>
            <Pin className={iconCls} />
          </button>
        </Tooltip>

        <span className="mx-1 h-[18px] w-px bg-black/[0.08]" />

        <Tooltip label="Crop Canvas" shortcut="C">
          <button
            type="button"
            onClick={() =>
              onSelectTool(activeTool === "crop" ? "select" : "crop")
            }
            className={iconBtn(activeTool === "crop")}
          >
            <Crop className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Undo" shortcut={`${modKey}Z`} disabled={!canUndo}>
          <button
            type="button"
            disabled={!canUndo}
            onClick={onUndo}
            className={iconBtn(false, !canUndo)}
          >
            <Undo2 className={iconCls} />
          </button>
        </Tooltip>
      </div>

      {/* Center: Annotation Tools */}
      <div className="flex items-center gap-0.5">
        <Tooltip label="Select & Edit" shortcut="V">
          <button
            type="button"
            onClick={() => onSelectTool("select")}
            className={iconBtn(activeTool === "select")}
          >
            <MousePointer2 className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Arrow" shortcut="A">
          <button
            type="button"
            onClick={() => onSelectTool("arrow")}
            className={iconBtn(activeTool === "arrow")}
          >
            <ArrowUpRight className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Text" shortcut="T">
          <button
            type="button"
            onClick={() => onSelectTool("text")}
            className={iconBtn(activeTool === "text")}
          >
            <Type className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Measure Distance" shortcut="R">
          <button
            type="button"
            onClick={() => onSelectTool("ruler")}
            className={iconBtn(activeTool === "ruler")}
          >
            <Ruler className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Rectangle" shortcut="S">
          <button
            type="button"
            onClick={() => onSelectTool("rect")}
            className={iconBtn(activeTool === "rect")}
          >
            <Square className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Backdrop & Frame" shortcut="F">
          <button
            type="button"
            onClick={() =>
              onSelectTool(activeTool === "frame" ? "select" : "frame")
            }
            className={iconBtn(activeTool === "frame" || backdropEnabled)}
          >
            <BackdropFrameIcon />
          </button>
        </Tooltip>
        <Tooltip label="Pen / Highlighter" shortcut="P">
          <button
            type="button"
            onClick={() => onSelectTool("pen")}
            className={iconBtn(activeTool === "pen")}
          >
            <Pencil className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Blur / Mosaic / Blackout" shortcut="B">
          <button
            type="button"
            onClick={() => onSelectTool(isRedactActive ? activeTool : "blur")}
            className={iconBtn(isRedactActive)}
          >
            <MosaicBlurIcon />
          </button>
        </Tooltip>

        {/* More tools dropdown */}
        <div ref={moreRef} className="relative">
          <Tooltip label="More Tools" disabled={moreOpen}>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              className={iconBtn(
                moreOpen ||
                  activeTool === "ellipse" ||
                  activeTool === "line" ||
                  activeTool === "counter" ||
                  activeTool === "spotlight",
              )}
            >
              <Ellipsis className={iconCls} />
            </button>
          </Tooltip>

          {moreOpen && (
            <div className="animate-pop-in absolute left-0 top-full z-50 mt-2 w-52 rounded-xl border border-black/[0.1] bg-white/95 py-1.5 text-[12.5px] text-[#141416] shadow-[0_12px_36px_rgba(0,0,0,0.14)] backdrop-blur-xl">
              <button
                type="button"
                onClick={() => {
                  onSelectTool("ellipse");
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <Circle className="h-3.5 w-3.5 stroke-[1.8] text-[#3F3F46]" />{" "}
                  Ellipse
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">O</span>
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
                  <Slash className="h-3.5 w-3.5 stroke-[1.8] text-[#3F3F46]" />{" "}
                  Line
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">L</span>
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
                  <StepCounterIcon className="h-3.5 w-3.5 text-[#3F3F46]" />{" "}
                  Step Counter
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">N</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("spotlight");
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <Focus className="h-3.5 w-3.5 stroke-[1.8] text-[#3F3F46]" />{" "}
                  Spotlight
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">H</span>
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
                  <Grid3x3 className="h-3.5 w-3.5 stroke-[1.8] text-[#3F3F46]" />{" "}
                  Pixelate
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">X</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("blackout");
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <EyeOff className="h-3.5 w-3.5 stroke-[1.8] text-[#3F3F46]" />{" "}
                  Blackout
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">K</span>
              </button>

              <div className="my-1 h-px bg-black/[0.07]" />

              <button
                type="button"
                disabled={!canUndo}
                onClick={() => {
                  onUndo();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05] disabled:cursor-default disabled:opacity-40"
              >
                <span className="flex items-center gap-2">
                  <Undo2 className="h-3.5 w-3.5 stroke-[1.8] text-[#3F3F46]" />{" "}
                  Undo
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">
                  {modKey}Z
                </span>
              </button>
              <button
                type="button"
                disabled={!canRedo}
                onClick={() => {
                  onRedo();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05] disabled:cursor-default disabled:opacity-40"
              >
                <span className="flex items-center gap-2">
                  <Redo2 className="h-3.5 w-3.5 stroke-[1.8] text-[#3F3F46]" />{" "}
                  Redo
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">
                  {modKey}⇧Z
                </span>
              </button>
              <button
                type="button"
                disabled={!hasAnnotations}
                onClick={() => {
                  onClearAnnotations();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-[#D70015] hover:bg-[#FF3B30]/[0.06] disabled:cursor-default disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5 stroke-[1.8]" /> Clear
                Annotations
              </button>

              <div className="my-1 h-px bg-black/[0.07]" />

              <button
                type="button"
                onClick={() => {
                  onSaveAs();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-black/[0.05]"
              >
                <span className="flex items-center gap-2">
                  <Save className="h-3.5 w-3.5 stroke-[1.8] text-[#3F3F46]" />{" "}
                  Save As…
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">
                  {modKey}⇧S
                </span>
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
                  <Settings className="h-3.5 w-3.5 stroke-[1.8] text-[#3F3F46]" />{" "}
                  Preferences…
                </span>
                <span className="font-mono text-[11px] text-[#63636C]">
                  {modKey},
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right: Live Inspector */}
      <div className="flex items-center gap-2.5">
        {/* Live Color Well + Hex (updated directly via refs for 0 React re-renders) */}
        <Tooltip label="Copy Hex Color" shortcut="Tab">
          <button
            type="button"
            onClick={onCopyHex}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-black/[0.05]"
          >
            <span
              ref={colorDotRef}
              className="h-[20px] w-[20px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.16)]"
              style={{ backgroundColor: "#000000" }}
            />
            <div className="flex flex-col leading-[1.2]">
              <span
                ref={colorHexRef}
                className="font-mono text-[11.5px] font-medium tracking-[-0.01em] text-[#141416]"
              >
                #000000
              </span>
              <span className="text-[10.5px] text-[#52525B]">Tab to copy</span>
            </div>
          </button>
        </Tooltip>

        <span className="h-[24px] w-px bg-black/[0.09]" />

        {/* Image Size */}
        <Tooltip label="Resize Image">
          <button
            type="button"
            onClick={onOpenResize}
            className="flex cursor-pointer flex-col rounded-lg px-1.5 py-1 text-left leading-[1.2] transition hover:bg-black/[0.05]"
          >
            <span className="text-[11.5px] font-medium tabular-nums tracking-[-0.01em] text-[#141416]">
              {widthPt}×{heightPt}pt
            </span>
            <span className="text-[10.5px] text-[#52525B]">Image size</span>
          </button>
        </Tooltip>

        <span className="h-[24px] w-px bg-black/[0.09]" />

        {/* Zoom */}
        <div ref={zoomRef} className="relative">
          <Tooltip
            label="Change Zoom"
            shortcut={`${modKey}+ / -`}
            align="right"
            disabled={zoomOpen}
          >
            <button
              type="button"
              onClick={() => setZoomOpen((v) => !v)}
              className="flex min-w-[44px] cursor-pointer flex-col rounded-lg px-1.5 py-1 text-left leading-[1.2] transition hover:bg-black/[0.05]"
            >
              <span className="text-[11.5px] font-medium tabular-nums tracking-[-0.01em] text-[#141416]">
                {Math.round(zoom * 100)}%
              </span>
              <span className="text-[10.5px] text-[#52525B]">Zoom</span>
            </button>
          </Tooltip>

          {zoomOpen && (
            <div className="animate-pop-in absolute right-0 top-full z-50 mt-2 w-28 rounded-xl border border-black/[0.1] bg-white/95 py-1 text-[12px] text-[#141416] shadow-[0_12px_36px_rgba(0,0,0,0.14)] backdrop-blur-xl">
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
              <div className="my-1 h-px bg-black/[0.07]" />
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
                    <span className="text-[#0066D6]">●</span>
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
