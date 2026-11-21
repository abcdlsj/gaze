import { Check, X } from "lucide-react";
import type { BackdropConfig, EditorTool } from "../../types";

const COLORS = [
  "#EF4444",
  "#F97316",
  "#EAB308",
  "#22C55E",
  "#0A84FF",
  "#8B5CF6",
  "#18181B",
  "#FFFFFF",
];

const BACKDROPS = [
  { label: "Sunset", value: "linear-gradient(135deg, #FF6B6B, #F97316, #FACC15)" },
  { label: "Ocean", value: "linear-gradient(135deg, #0EA5E9, #2563EB, #6366F1)" },
  { label: "Emerald", value: "linear-gradient(135deg, #10B981, #059669, #0F766E)" },
  { label: "Slate", value: "#2C3036" },
  { label: "Paper", value: "#F3F4F6" },
];

interface Props {
  activeTool: EditorTool;
  color: string;
  onColorChange: (hex: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (w: number) => void;
  fontSize: number;
  onFontSizeChange: (s: number) => void;
  blurStrength: number;
  onBlurStrengthChange: (s: number) => void;
  filled: boolean;
  onFilledChange: (f: boolean) => void;
  highlighter: boolean;
  onHighlighterChange: (h: boolean) => void;
  backdrop: BackdropConfig;
  onBackdropChange: (next: BackdropConfig) => void;
  onSelectTool: (t: EditorTool) => void;
  onApplyCrop?: () => void;
  onCancelCrop?: () => void;
}

export function ToolOptionsBar({
  activeTool,
  color,
  onColorChange,
  strokeWidth,
  onStrokeWidthChange,
  fontSize,
  onFontSizeChange,
  blurStrength,
  onBlurStrengthChange,
  filled,
  onFilledChange,
  highlighter,
  onHighlighterChange,
  backdrop,
  onBackdropChange,
  onSelectTool,
  onApplyCrop,
  onCancelCrop,
}: Props) {
  if (activeTool === "select") {
    return null;
  }

  return (
    <div className="pointer-events-auto absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-neutral-200/90 bg-white/95 px-3.5 py-1.5 text-[12px] text-neutral-700 shadow-lg backdrop-blur-md">
      {activeTool === "crop" ? (
        <div className="flex items-center gap-2">
          <span className="text-neutral-500">Drag handles to crop</span>
          <button
            type="button"
            onClick={onApplyCrop}
            className="inline-flex items-center gap-1 rounded-full bg-[#0A84FF] px-3 py-1 text-[11.5px] font-medium text-white hover:bg-blue-600"
          >
            <Check className="h-3.5 w-3.5" /> Apply
          </button>
          <button
            type="button"
            onClick={onCancelCrop}
            className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-1 text-[11.5px] text-neutral-600 hover:bg-neutral-200"
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
        </div>
      ) : activeTool === "frame" ? (
        <div className="flex items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium">
            <input
              type="checkbox"
              checked={backdrop.enabled}
              onChange={(e) =>
                onBackdropChange({ ...backdrop, enabled: e.target.checked })
              }
              className="accent-[#0A84FF]"
            />
            <span>Backdrop</span>
          </label>
          <div className="flex items-center gap-1.5">
            {BACKDROPS.map((b) => (
              <button
                key={b.label}
                type="button"
                title={b.label}
                onClick={() =>
                  onBackdropChange({
                    ...backdrop,
                    enabled: true,
                    background: b.value,
                  })
                }
                style={{ background: b.value }}
                className={`h-5 w-5 rounded-full border border-black/15 transition ${
                  backdrop.background === b.value && backdrop.enabled
                    ? "ring-2 ring-[#0A84FF] ring-offset-1"
                    : "hover:scale-110"
                }`}
              />
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-[11.5px] text-neutral-500">
            <span>Pad</span>
            <input
              type="range"
              min={16}
              max={120}
              value={backdrop.padding}
              onChange={(e) =>
                onBackdropChange({
                  ...backdrop,
                  enabled: true,
                  padding: Number(e.target.value),
                })
              }
              className="w-16 accent-[#0A84FF]"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11.5px] text-neutral-500">
            <span>Round</span>
            <input
              type="range"
              min={0}
              max={32}
              value={backdrop.cornerRadius}
              onChange={(e) =>
                onBackdropChange({
                  ...backdrop,
                  enabled: true,
                  cornerRadius: Number(e.target.value),
                })
              }
              className="w-14 accent-[#0A84FF]"
            />
          </label>
        </div>
      ) : activeTool === "blur" || activeTool === "pixelate" ? (
        <div className="flex items-center gap-3">
          <div className="flex rounded-full bg-neutral-100 p-0.5 text-[11.5px]">
            <button
              type="button"
              onClick={() => onSelectTool("blur")}
              className={`rounded-full px-2.5 py-0.5 transition ${
                activeTool === "blur"
                  ? "bg-white font-medium text-neutral-900 shadow-xs"
                  : "text-neutral-500"
              }`}
            >
              Blur
            </button>
            <button
              type="button"
              onClick={() => onSelectTool("pixelate")}
              className={`rounded-full px-2.5 py-0.5 transition ${
                activeTool === "pixelate"
                  ? "bg-white font-medium text-neutral-900 shadow-xs"
                  : "text-neutral-500"
              }`}
            >
              Pixelate
            </button>
          </div>
          <label className="flex items-center gap-2 text-[11.5px] text-neutral-500">
            <span>Strength</span>
            <input
              type="range"
              min={4}
              max={28}
              value={blurStrength}
              onChange={(e) => onBlurStrengthChange(Number(e.target.value))}
              className="w-20 accent-[#0A84FF]"
            />
          </label>
        </div>
      ) : (
        <>
          {/* Color swatches */}
          <div className="flex items-center gap-1.5">
            {COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => onColorChange(hex)}
                style={{ backgroundColor: hex }}
                className={`h-[18px] w-[18px] rounded-full border border-black/15 transition ${
                  color.toLowerCase() === hex.toLowerCase()
                    ? "ring-2 ring-[#0A84FF] ring-offset-1"
                    : "hover:scale-110"
                }`}
              />
            ))}
          </div>

          <span className="h-4 w-px bg-neutral-200" />

          {activeTool === "text" ? (
            <label className="flex items-center gap-2 text-[11.5px] text-neutral-500">
              <span>Size</span>
              <input
                type="range"
                min={12}
                max={48}
                value={fontSize}
                onChange={(e) => onFontSizeChange(Number(e.target.value))}
                className="w-20 accent-[#0A84FF]"
              />
              <span className="w-7 text-right tabular-nums text-neutral-700">
                {fontSize}
              </span>
            </label>
          ) : (
            <label className="flex items-center gap-2 text-[11.5px] text-neutral-500">
              <span>Width</span>
              <input
                type="range"
                min={1}
                max={12}
                value={strokeWidth}
                onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
                className="w-16 accent-[#0A84FF]"
              />
              <span className="w-4 text-right tabular-nums text-neutral-700">
                {strokeWidth}
              </span>
            </label>
          )}

          {(activeTool === "rect" || activeTool === "ellipse") && (
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px]">
              <input
                type="checkbox"
                checked={filled}
                onChange={(e) => onFilledChange(e.target.checked)}
                className="accent-[#0A84FF]"
              />
              <span>Fill</span>
            </label>
          )}

          {activeTool === "pen" && (
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px]">
              <input
                type="checkbox"
                checked={highlighter}
                onChange={(e) => onHighlighterChange(e.target.checked)}
                className="accent-[#0A84FF]"
              />
              <span>Highlighter</span>
            </label>
          )}
        </>
      )}
    </div>
  );
}
