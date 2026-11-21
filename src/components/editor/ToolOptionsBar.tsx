import { Check, X } from "lucide-react";
import type { BackdropConfig, EditorTool } from "../../types";

const COLORS = [
  "#EF4444",
  "#F97316",
  "#EAB308",
  "#22C55E",
  "#007AFF",
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
    <div className="animate-pop-in pointer-events-auto absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-black/[0.08] bg-white/92 px-3.5 py-1.5 text-[12px] text-[#1D1D1F] shadow-[0_8px_28px_rgba(0,0,0,0.12)] backdrop-blur-xl">
      {activeTool === "crop" ? (
        <div className="flex items-center gap-2">
          <span className="text-[#6E6E73]">Drag handles to crop</span>
          <button
            type="button"
            onClick={onApplyCrop}
            className="mac-blue-fill inline-flex cursor-pointer items-center gap-1 rounded-full px-3 py-1 text-[11.5px] font-medium text-white transition hover:brightness-105"
          >
            <Check className="h-3.5 w-3.5" /> Apply
          </button>
          <button
            type="button"
            onClick={onCancelCrop}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-black/[0.05] px-2.5 py-1 text-[11.5px] text-[#424245] transition hover:bg-black/[0.09]"
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
              className="accent-[#007AFF]"
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
                className={`h-5 w-5 cursor-pointer rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] transition ${
                  backdrop.background === b.value && backdrop.enabled
                    ? "ring-2 ring-[#007AFF] ring-offset-1"
                    : "hover:scale-110"
                }`}
              />
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-[11.5px] text-[#6E6E73]">
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
              className="w-16 accent-[#007AFF]"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11.5px] text-[#6E6E73]">
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
              className="w-14 accent-[#007AFF]"
            />
          </label>
        </div>
      ) : activeTool === "blur" || activeTool === "pixelate" ? (
        <div className="flex items-center gap-3">
          <div className="flex rounded-full bg-black/[0.06] p-0.5 text-[11.5px]">
            <button
              type="button"
              onClick={() => onSelectTool("blur")}
              className={`cursor-pointer rounded-full px-2.5 py-0.5 transition ${
                activeTool === "blur"
                  ? "bg-white font-medium text-[#1D1D1F] shadow-xs"
                  : "text-[#6E6E73]"
              }`}
            >
              Blur
            </button>
            <button
              type="button"
              onClick={() => onSelectTool("pixelate")}
              className={`cursor-pointer rounded-full px-2.5 py-0.5 transition ${
                activeTool === "pixelate"
                  ? "bg-white font-medium text-[#1D1D1F] shadow-xs"
                  : "text-[#6E6E73]"
              }`}
            >
              Pixelate
            </button>
          </div>
          <label className="flex items-center gap-2 text-[11.5px] text-[#6E6E73]">
            <span>Strength</span>
            <input
              type="range"
              min={4}
              max={28}
              value={blurStrength}
              onChange={(e) => onBlurStrengthChange(Number(e.target.value))}
              className="w-20 accent-[#007AFF]"
            />
          </label>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            {COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => onColorChange(hex)}
                style={{ backgroundColor: hex }}
                className={`h-[18px] w-[18px] cursor-pointer rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.16)] transition ${
                  color.toLowerCase() === hex.toLowerCase()
                    ? "ring-2 ring-[#007AFF] ring-offset-1"
                    : "hover:scale-110"
                }`}
              />
            ))}
          </div>

          <span className="h-4 w-px bg-black/[0.08]" />

          {activeTool === "text" ? (
            <label className="flex items-center gap-2 text-[11.5px] text-[#6E6E73]">
              <span>Size</span>
              <input
                type="range"
                min={12}
                max={48}
                value={fontSize}
                onChange={(e) => onFontSizeChange(Number(e.target.value))}
                className="w-20 accent-[#007AFF]"
              />
              <span className="w-7 text-right tabular-nums text-[#1D1D1F]">
                {fontSize}
              </span>
            </label>
          ) : (
            <label className="flex items-center gap-2 text-[11.5px] text-[#6E6E73]">
              <span>Width</span>
              <input
                type="range"
                min={1}
                max={12}
                value={strokeWidth}
                onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
                className="w-16 accent-[#007AFF]"
              />
              <span className="w-4 text-right tabular-nums text-[#1D1D1F]">
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
                className="accent-[#007AFF]"
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
                className="accent-[#007AFF]"
              />
              <span>Highlighter</span>
            </label>
          )}
        </>
      )}
    </div>
  );
}
