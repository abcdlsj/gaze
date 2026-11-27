import type { ReactNode } from "react";
import {
  AppWindowMac,
  ArrowUpRight,
  CaseSensitive,
  Check,
  Circle,
  Download,
  Droplet,
  Pencil,
  Pin,
  Redo2,
  Slash,
  Square,
  Undo2,
  X,
} from "lucide-react";
import type { EditorTool, InplaceAction } from "../../types";
import { Tooltip } from "../ui/Tooltip";
import { MosaicBlurIcon, StepCounterIcon } from "./EditorToolbar";
import {
  TOOLBAR_BTN,
  TOOLBAR_DIVIDER,
  TOOLBAR_ITEMS,
  TOOLBAR_PILL_H,
  TOOLBAR_WIDTH,
  type InplaceToolbarItem,
  toolbarItemXs,
} from "./inplaceToolbarLayout";

function ScrollCaptureIcon() {
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
      <path d="M3 7.5h6M3 10h6M3 12.5h6" />
      <path d="M14.5 3.5v13M12 6l2.5-2.5L17 6M12 14l2.5 2.5L17 14" />
    </svg>
  );
}

const iconCls = "h-[17px] w-[17px] stroke-[1.75]";

const TOOL_ICONS: Partial<Record<EditorTool, ReactNode>> = {
  rect: <Square className={iconCls} />,
  ellipse: <Circle className={iconCls} />,
  arrow: <ArrowUpRight className={iconCls} />,
  line: <Slash className={iconCls} />,
  pen: <Pencil className={iconCls} />,
  text: <CaseSensitive className={iconCls} />,
  pixelate: <MosaicBlurIcon />,
  blur: <Droplet className={iconCls} />,
  counter: <StepCounterIcon className="h-[17px] w-[17px]" />,
};

interface Props {
  /** Pill rect in display-local points. */
  left: number;
  top: number;
  activeTool: EditorTool;
  canUndo: boolean;
  canRedo: boolean;
  tooltipSide: "top" | "bottom";
  onSelectTool: (tool: EditorTool) => void;
  onUndo: () => void;
  onRedo: () => void;
  onAction: (action: InplaceAction) => void;
}

/** True when `tool` is shown as active by the toolbar button for `item`. */
function isToolItemActive(item: InplaceToolbarItem, activeTool: EditorTool) {
  if (item.kind !== "tool") return false;
  if (item.tool === activeTool) return true;
  // The mosaic button also stands for the other redaction modes offered in its options row.
  return item.tool === "pixelate" && (activeTool === "blackout" || activeTool === "spotlight");
}

export function InplaceToolbar({
  left,
  top,
  activeTool,
  canUndo,
  canRedo,
  tooltipSide,
  onSelectTool,
  onUndo,
  onRedo,
  onAction,
}: Props) {
  const xs = toolbarItemXs();

  const btnCls = (active: boolean, disabled: boolean, accent = false) =>
    `flex items-center justify-center rounded-[7px] transition-colors duration-75 ${
      disabled
        ? "cursor-default text-[#26262B]/30"
        : active
          ? "cursor-pointer bg-[#007AFF]/[0.11] text-[#0066D6]"
          : accent
            ? "cursor-pointer text-[#0066D6] hover:bg-black/[0.06]"
            : "cursor-pointer text-[#42424A] hover:bg-black/[0.06] hover:text-[#1C1C1F]"
    }`;

  return (
    <div
      data-inplace-toolbar="true"
      onMouseDown={(e) => {
        // Keep the inline text editor focused and never start a canvas drag from here.
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{ left, top, width: TOOLBAR_WIDTH, height: TOOLBAR_PILL_H }}
      className="fixed z-40 rounded-[10px] border border-black/[0.12] bg-[#FBFBFC]/[0.96] shadow-[0_5px_24px_rgba(0,0,0,0.30)]"
    >
      {TOOLBAR_ITEMS.map((item, idx) => {
        const x = xs[idx];
        if (item.kind === "divider") {
          return (
            <span
              key={`div-${idx}`}
              className="absolute w-px bg-black/[0.10]"
              style={{
                left: x + (TOOLBAR_DIVIDER - 1) / 2 - 1,
                top: 10,
                height: TOOLBAR_PILL_H - 22,
              }}
            />
          );
        }

        let icon: ReactNode = null;
        let disabled = false;
        let active = false;
        let accent = false;
        let onClick: () => void = () => {};
        let label = item.label;
        switch (item.kind) {
          case "tool":
            icon = TOOL_ICONS[item.tool];
            active = isToolItemActive(item, activeTool);
            onClick = () => onSelectTool(item.tool);
            break;
          case "undo":
            icon = <Undo2 className={iconCls} />;
            disabled = !canUndo;
            onClick = onUndo;
            break;
          case "redo":
            icon = <Redo2 className={iconCls} />;
            disabled = !canRedo;
            onClick = onRedo;
            break;
          case "scroll":
            icon = <ScrollCaptureIcon />;
            // Scrolling capture re-captures live content, so it is only offered before
            // annotating (from the native toolbar).
            disabled = true;
            label = "Scrolling Capture (before annotating)";
            break;
          case "action": {
            const action = item.action;
            icon =
              action === "pin" ? (
                <Pin className={iconCls} />
              ) : action === "editor" ? (
                <AppWindowMac className={iconCls} />
              ) : (
                <Download className={iconCls} />
              );
            onClick = () => onAction(action);
            break;
          }
          case "cancel":
            icon = <X className={iconCls} />;
            onClick = () => onAction("cancel");
            break;
          case "done":
            icon = <Check className="h-[18px] w-[18px] stroke-[2.1]" />;
            accent = true;
            onClick = () => onAction("done");
            break;
        }

        const align = idx < 2 ? "left" : idx > TOOLBAR_ITEMS.length - 3 ? "right" : "center";
        return (
          <div
            key={`${item.kind}-${idx}`}
            className="absolute"
            // Children are laid out from the padding box, i.e. 1px inside the border, while
            // the native toolbar measures from the outer edge.
            style={{
              left: x - 1,
              top: (TOOLBAR_PILL_H - TOOLBAR_BTN) / 2 - 1,
              width: TOOLBAR_BTN,
              height: TOOLBAR_BTN,
            }}
          >
            <Tooltip
              label={label}
              shortcut={item.shortcut || undefined}
              side={tooltipSide}
              align={align}
            >
              <button
                type="button"
                aria-label={label}
                aria-pressed={item.kind === "tool" ? active : undefined}
                disabled={disabled}
                onClick={onClick}
                style={{ width: TOOLBAR_BTN, height: TOOLBAR_BTN }}
                className={btnCls(active, disabled, accent)}
              >
                {icon}
              </button>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}
