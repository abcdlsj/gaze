import { type RefObject, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Copy,
  Crop,
  Ellipsis,
  EyeOff,
  Focus,
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
import {
  BackdropFrameIcon,
  MosaicBlurIcon,
  StepCounterIcon,
} from "./toolbarIcons";
import {
  EDITOR_TOOLBAR_ICON_CLS,
  MENU_ICON_CLS,
  TOOLBAR_GROUP_GAP_CLS,
  TOOLBAR_MENU_CLS,
  toolbarIconBtnClass,
  toolbarMenuItemClass,
} from "./toolbarSpec";

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

  const iconCls = EDITOR_TOOLBAR_ICON_CLS;
  const iconBtn = (active = false, disabled = false) =>
    toolbarIconBtnClass({ active, disabled, variant: "editor" });

  const menuIconCls = (active = false) =>
    `${MENU_ICON_CLS} ${active ? "text-[#0066D6]" : "text-[#3F3F46]"}`;

  const shortcutCls = (active = false) =>
    `font-mono text-[11px] ${active ? "text-[#0066D6]/80" : "text-[#63636C]"}`;

  const isRedactActive =
    activeTool === "blur" ||
    activeTool === "pixelate" ||
    activeTool === "blackout";

  const isMoreToolActive =
    activeTool === "ellipse" ||
    activeTool === "line" ||
    activeTool === "counter" ||
    activeTool === "spotlight";

  const inspectorBtnCls =
    "flex cursor-pointer rounded-[7px] px-1.5 py-1 text-left transition-colors duration-100 hover:bg-black/[0.06]";

  return (
    <header
      data-tauri-drag-region
      className={`relative z-30 flex h-[48px] shrink-0 items-center justify-between border-b border-black/[0.08] bg-white/95 pr-3 backdrop-blur-md ${
        isMac ? "pl-[76px]" : "pl-3"
      }`}
    >
      {/* Left: Primary Actions + Crop + Undo */}
      <div className={`flex items-center ${TOOLBAR_GROUP_GAP_CLS}`}>
        <Tooltip label="Copy" shortcut={`${modKey}C`} align="left">
          <button
            type="button"
            aria-label="Copy"
            onClick={onCopy}
            className={iconBtn(false)}
          >
            <Copy className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Save" shortcut={`${modKey}S`}>
          <button
            type="button"
            aria-label="Save"
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
          <button
            type="button"
            aria-label="Pin on Screen"
            onClick={onPin}
            className={iconBtn(false)}
          >
            <Pin className={iconCls} />
          </button>
        </Tooltip>

        <span className="mx-1 h-[18px] w-px bg-black/[0.09]" />

        <Tooltip label="Crop Canvas" shortcut="C">
          <button
            type="button"
            aria-label="Crop Canvas"
            aria-pressed={activeTool === "crop"}
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
            aria-label="Undo"
            disabled={!canUndo}
            onClick={onUndo}
            className={iconBtn(false, !canUndo)}
          >
            <Undo2 className={iconCls} />
          </button>
        </Tooltip>
      </div>

      {/* Center: Annotation Tools */}
      <div className={`flex items-center ${TOOLBAR_GROUP_GAP_CLS}`}>
        <Tooltip label="Select & Edit" shortcut="V">
          <button
            type="button"
            aria-label="Select & Edit"
            aria-pressed={activeTool === "select"}
            onClick={() => onSelectTool("select")}
            className={iconBtn(activeTool === "select")}
          >
            <MousePointer2 className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Arrow" shortcut="A">
          <button
            type="button"
            aria-label="Arrow"
            aria-pressed={activeTool === "arrow"}
            onClick={() => onSelectTool("arrow")}
            className={iconBtn(activeTool === "arrow")}
          >
            <ArrowUpRight className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Text" shortcut="T">
          <button
            type="button"
            aria-label="Text"
            aria-pressed={activeTool === "text"}
            onClick={() => onSelectTool("text")}
            className={iconBtn(activeTool === "text")}
          >
            <Type className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Measure Distance" shortcut="R">
          <button
            type="button"
            aria-label="Measure Distance"
            aria-pressed={activeTool === "ruler"}
            onClick={() => onSelectTool("ruler")}
            className={iconBtn(activeTool === "ruler")}
          >
            <Ruler className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Rectangle" shortcut="S">
          <button
            type="button"
            aria-label="Rectangle"
            aria-pressed={activeTool === "rect"}
            onClick={() => onSelectTool("rect")}
            className={iconBtn(activeTool === "rect")}
          >
            <Square className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Backdrop & Frame" shortcut="F">
          <button
            type="button"
            aria-label="Backdrop & Frame"
            aria-pressed={activeTool === "frame" || backdropEnabled}
            onClick={() =>
              onSelectTool(activeTool === "frame" ? "select" : "frame")
            }
            className={iconBtn(activeTool === "frame" || backdropEnabled)}
          >
            <BackdropFrameIcon className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Pen / Highlighter" shortcut="P">
          <button
            type="button"
            aria-label="Pen / Highlighter"
            aria-pressed={activeTool === "pen"}
            onClick={() => onSelectTool("pen")}
            className={iconBtn(activeTool === "pen")}
          >
            <Pencil className={iconCls} />
          </button>
        </Tooltip>
        <Tooltip label="Blur / Mosaic / Blackout" shortcut="B">
          <button
            type="button"
            aria-label="Blur / Mosaic / Blackout"
            aria-pressed={isRedactActive}
            onClick={() => onSelectTool(isRedactActive ? activeTool : "blur")}
            className={iconBtn(isRedactActive)}
          >
            <MosaicBlurIcon className={iconCls} />
          </button>
        </Tooltip>

        {/* More tools dropdown */}
        <div ref={moreRef} className="relative">
          <Tooltip label="More Tools" disabled={moreOpen}>
            <button
              type="button"
              aria-label="More Tools"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              className={iconBtn(moreOpen || isMoreToolActive)}
            >
              <Ellipsis className={iconCls} />
            </button>
          </Tooltip>

          {moreOpen && (
            <div className={`${TOOLBAR_MENU_CLS} left-0 w-52`}>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("ellipse");
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass(activeTool === "ellipse")}
              >
                <span className="flex items-center gap-2">
                  <Circle className={menuIconCls(activeTool === "ellipse")} />{" "}
                  Ellipse
                </span>
                <span className={shortcutCls(activeTool === "ellipse")}>O</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("line");
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass(activeTool === "line")}
              >
                <span className="flex items-center gap-2">
                  <Slash className={menuIconCls(activeTool === "line")} /> Line
                </span>
                <span className={shortcutCls(activeTool === "line")}>L</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("counter");
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass(activeTool === "counter")}
              >
                <span className="flex items-center gap-2">
                  <StepCounterIcon
                    className={menuIconCls(activeTool === "counter")}
                  />{" "}
                  Step Counter
                </span>
                <span className={shortcutCls(activeTool === "counter")}>N</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("spotlight");
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass(activeTool === "spotlight")}
              >
                <span className="flex items-center gap-2">
                  <Focus className={menuIconCls(activeTool === "spotlight")} />{" "}
                  Spotlight
                </span>
                <span className={shortcutCls(activeTool === "spotlight")}>
                  H
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("pixelate");
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass(activeTool === "pixelate")}
              >
                <span className="flex items-center gap-2">
                  <MosaicBlurIcon
                    className={menuIconCls(activeTool === "pixelate")}
                  />{" "}
                  Pixelate
                </span>
                <span className={shortcutCls(activeTool === "pixelate")}>
                  X
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSelectTool("blackout");
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass(activeTool === "blackout")}
              >
                <span className="flex items-center gap-2">
                  <EyeOff className={menuIconCls(activeTool === "blackout")} />{" "}
                  Blackout
                </span>
                <span className={shortcutCls(activeTool === "blackout")}>
                  K
                </span>
              </button>

              <div className="my-1 h-px bg-black/[0.07]" />

              <button
                type="button"
                disabled={!canUndo}
                onClick={() => {
                  onUndo();
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass()}
              >
                <span className="flex items-center gap-2">
                  <Undo2 className={menuIconCls()} /> Undo
                </span>
                <span className={shortcutCls()}>{modKey}Z</span>
              </button>
              <button
                type="button"
                disabled={!canRedo}
                onClick={() => {
                  onRedo();
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass()}
              >
                <span className="flex items-center gap-2">
                  <Redo2 className={menuIconCls()} /> Redo
                </span>
                <span className={shortcutCls()}>{modKey}⇧Z</span>
              </button>
              <button
                type="button"
                disabled={!hasAnnotations}
                onClick={() => {
                  onClearAnnotations();
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass(false, true)}
              >
                <span className="flex items-center gap-2">
                  <Trash2 className={MENU_ICON_CLS} /> Clear Annotations
                </span>
              </button>

              <div className="my-1 h-px bg-black/[0.07]" />

              <button
                type="button"
                onClick={() => {
                  onSaveAs();
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass()}
              >
                <span className="flex items-center gap-2">
                  <Save className={menuIconCls()} /> Save As…
                </span>
                <span className={shortcutCls()}>{modKey}⇧S</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onOpenPreferences();
                  setMoreOpen(false);
                }}
                className={toolbarMenuItemClass()}
              >
                <span className="flex items-center gap-2">
                  <Settings className={menuIconCls()} /> Preferences…
                </span>
                <span className={shortcutCls()}>{modKey},</span>
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
            className={`${inspectorBtnCls} items-center gap-2`}
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

        <span className="h-[22px] w-px bg-black/[0.09]" />

        {/* Image Size */}
        <Tooltip label="Resize Image">
          <button
            type="button"
            onClick={onOpenResize}
            className={`${inspectorBtnCls} flex-col leading-[1.2]`}
          >
            <span className="text-[11.5px] font-medium tabular-nums tracking-[-0.01em] text-[#141416]">
              {widthPt}×{heightPt}pt
            </span>
            <span className="text-[10.5px] text-[#52525B]">Image size</span>
          </button>
        </Tooltip>

        <span className="h-[22px] w-px bg-black/[0.09]" />

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
              className={`${inspectorBtnCls} min-w-[44px] flex-col leading-[1.2]`}
            >
              <span className="text-[11.5px] font-medium tabular-nums tracking-[-0.01em] text-[#141416]">
                {Math.round(zoom * 100)}%
              </span>
              <span className="text-[10.5px] text-[#52525B]">Zoom</span>
            </button>
          </Tooltip>

          {zoomOpen && (
            <div className={`${TOOLBAR_MENU_CLS} right-0 w-28`}>
              <button
                type="button"
                onClick={() => {
                  onZoomFit();
                  setZoomOpen(false);
                }}
                className={toolbarMenuItemClass()}
              >
                Fit Window
              </button>
              <div className="my-1 h-px bg-black/[0.07]" />
              {[0.5, 1, 1.5, 2, 4].map((z) => {
                const active = Math.abs(zoom - z) < 0.02;
                return (
                  <button
                    key={z}
                    type="button"
                    onClick={() => {
                      onSetZoom(z);
                      setZoomOpen(false);
                    }}
                    className={`${toolbarMenuItemClass(active)} tabular-nums`}
                  >
                    <span>{Math.round(z * 100)}%</span>
                    {active && <span className="text-[#0066D6]">●</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
