import { Check, CopyPlus, RotateCcw, Trash2, X } from "lucide-react";
import type {
  Annotation,
  BackdropConfig,
  EditorTool,
  RedactMode,
  ShapeFillStyle,
  TextStyle,
} from "../../types";
import { getShapeFillStyle } from "../../lib/canvas-render";

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

const BLACKOUT_COLORS = ["#18181B", "#FFFFFF", "#52525B", "#007AFF", "#EF4444"];

const STROKE_PRESETS = [2, 3, 5, 8];

const COUNTER_SIZES = [
  { label: "S", radius: 11 },
  { label: "M", radius: 14 },
  { label: "L", radius: 18 },
];

const BACKDROPS = [
  {
    label: "Sunset",
    value: "linear-gradient(135deg, #FF6B6B, #F97316, #FACC15)",
  },
  {
    label: "Ocean",
    value: "linear-gradient(135deg, #0EA5E9, #2563EB, #6366F1)",
  },
  {
    label: "Aurora",
    value: "linear-gradient(135deg, #EC4899, #8B5CF6, #3B82F6)",
  },
  {
    label: "Emerald",
    value: "linear-gradient(135deg, #10B981, #059669, #0F766E)",
  },
  { label: "Slate", value: "#2C3036" },
  { label: "Paper", value: "#F3F4F6" },
];

function sliderTrack(val: number, min: number, max: number): string {
  const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
  return `linear-gradient(to right, #007AFF 0%, #007AFF ${pct}%, #E5E5EA ${pct}%, #E5E5EA 100%)`;
}

interface Props {
  activeTool: EditorTool;
  selectedAnnotation: Annotation | null;
  color: string;
  onColorChange: (hex: string) => void;
  blackoutColor: string;
  onBlackoutColorChange: (hex: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (w: number) => void;
  fontSize: number;
  onFontSizeChange: (s: number) => void;
  textStyle: TextStyle;
  onTextStyleChange: (s: TextStyle) => void;
  blurStrength: number;
  onBlurStrengthChange: (s: number) => void;
  spotlightOpacity: number;
  onSpotlightOpacityChange: (o: number) => void;
  shapeFillStyle: ShapeFillStyle;
  onShapeFillStyleChange: (s: ShapeFillStyle) => void;
  highlighter: boolean;
  onHighlighterChange: (h: boolean) => void;
  counterRadius: number;
  onCounterRadiusChange: (r: number) => void;
  nextCounterNum: number;
  onResetCounter: () => void;
  backdrop: BackdropConfig;
  onBackdropChange: (next: BackdropConfig) => void;
  onSelectRedactMode: (mode: RedactMode) => void;
  onDuplicateSelected?: () => void;
  onDeleteSelected?: () => void;
  cropSizePt?: { w: number; h: number } | null;
  onApplyCrop?: () => void;
  onCancelCrop?: () => void;
}

export function ToolOptionsBar({
  activeTool,
  selectedAnnotation,
  color,
  onColorChange,
  blackoutColor,
  onBlackoutColorChange,
  strokeWidth,
  onStrokeWidthChange,
  fontSize,
  onFontSizeChange,
  textStyle,
  onTextStyleChange,
  blurStrength,
  onBlurStrengthChange,
  spotlightOpacity,
  onSpotlightOpacityChange,
  shapeFillStyle,
  onShapeFillStyleChange,
  highlighter,
  onHighlighterChange,
  counterRadius,
  onCounterRadiusChange,
  nextCounterNum,
  onResetCounter,
  backdrop,
  onBackdropChange,
  onSelectRedactMode,
  onDuplicateSelected,
  onDeleteSelected,
  cropSizePt,
  onApplyCrop,
  onCancelCrop,
}: Props) {
  // Determine which context the bar should display:
  // If an annotation is selected (in select mode or right after drawing), reflect its type & properties.
  const contextKind: EditorTool | null =
    activeTool === "crop"
      ? "crop"
      : activeTool === "frame"
        ? "frame"
        : selectedAnnotation
          ? selectedAnnotation.type
          : activeTool !== "select"
            ? activeTool
            : null;

  if (!contextKind) {
    return null;
  }

  // Derive effective live values from selected annotation when present
  const effectiveColor =
    selectedAnnotation && selectedAnnotation.type !== "blackout"
      ? selectedAnnotation.color
      : color;
  const effectiveBlackoutColor =
    selectedAnnotation?.type === "blackout"
      ? selectedAnnotation.color
      : blackoutColor;
  const effectiveStroke = selectedAnnotation
    ? selectedAnnotation.strokeWidth
    : strokeWidth;
  const effectiveFontSize =
    selectedAnnotation?.type === "text" ? selectedAnnotation.fontSize : fontSize;
  const effectiveTextStyle: TextStyle =
    selectedAnnotation?.type === "text"
      ? (selectedAnnotation.textStyle ?? "plain")
      : textStyle;
  const effectiveBlurStrength =
    selectedAnnotation &&
    (selectedAnnotation.type === "blur" ||
      selectedAnnotation.type === "pixelate")
      ? selectedAnnotation.strength
      : blurStrength;
  const effectiveSpotlightOpacity =
    selectedAnnotation?.type === "spotlight"
      ? (selectedAnnotation.opacity ?? 0.52)
      : spotlightOpacity;
  const effectiveFillStyle: ShapeFillStyle =
    selectedAnnotation &&
    (selectedAnnotation.type === "rect" ||
      selectedAnnotation.type === "ellipse")
      ? getShapeFillStyle(selectedAnnotation)
      : shapeFillStyle;
  const effectiveHighlighter =
    selectedAnnotation?.type === "pen"
      ? Boolean(selectedAnnotation.highlighter)
      : highlighter;
  const effectiveCounterRadius =
    selectedAnnotation?.type === "counter"
      ? selectedAnnotation.radius
      : counterRadius;

  // Prevent clicking buttons/swatches from blurring an active inline text editor
  const keepFocusOnMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "INPUT") {
      e.preventDefault();
    }
    e.stopPropagation();
  };

  const renderColorSwatches = (
    palette: string[],
    activeHex: string,
    onChange: (hex: string) => void,
  ) => (
    <div className="flex items-center gap-1.5">
      {palette.map((hex) => (
        <button
          key={hex}
          type="button"
          onClick={() => onChange(hex)}
          style={{ backgroundColor: hex }}
          className={`h-[17px] w-[17px] cursor-pointer rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.16)] transition ${
            activeHex.toLowerCase() === hex.toLowerCase()
              ? "ring-2 ring-[#007AFF] ring-offset-1"
              : "hover:scale-110"
          }`}
        />
      ))}
    </div>
  );

  const renderStrokeDots = () => (
    <div className="flex items-center gap-1" title="Stroke width ([ / ])">
      {STROKE_PRESETS.map((w) => {
        const active = Math.abs(effectiveStroke - w) < 0.8;
        const dotSize = Math.min(12, 3.5 + w * 1.05);
        return (
          <button
            key={w}
            type="button"
            onClick={() => onStrokeWidthChange(w)}
            className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-full transition ${
              active
                ? "bg-[#007AFF]/[0.13] text-[#0066D6] ring-1 ring-[#007AFF]/35"
                : "text-[#3F3F46] hover:bg-black/[0.06]"
            }`}
          >
            <span
              className="rounded-full bg-current"
              style={{ width: dotSize, height: dotSize }}
            />
          </button>
        );
      })}
    </div>
  );

  const renderSelectionActions = () => {
    if (!selectedAnnotation || activeTool === "crop" || activeTool === "frame") {
      return null;
    }
    return (
      <>
        <span className="h-4 w-px bg-black/[0.1]" />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="Duplicate (⌘D)"
            onClick={onDuplicateSelected}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-[#3F3F46] transition hover:bg-black/[0.06] hover:text-[#141416]"
          >
            <CopyPlus className="h-3.5 w-3.5 stroke-[1.8]" />
          </button>
          <button
            type="button"
            title="Delete (⌫)"
            onClick={onDeleteSelected}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-[#D70015] transition hover:bg-[#FF3B30]/[0.1]"
          >
            <Trash2 className="h-3.5 w-3.5 stroke-[1.8]" />
          </button>
        </div>
      </>
    );
  };

  return (
    <div
      data-options-bar="true"
      onMouseDown={keepFocusOnMouseDown}
      className="animate-pop-in pointer-events-auto absolute left-1/2 top-3 z-20 flex max-w-[94%] -translate-x-1/2 items-center gap-2.5 rounded-full border border-black/[0.1] bg-white/95 px-3 py-1.5 text-[12px] text-[#141416] shadow-[0_8px_28px_rgba(0,0,0,0.12)] backdrop-blur-xl"
    >
      {contextKind === "crop" ? (
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[11.5px] font-medium tabular-nums text-[#3F3F46]">
            {cropSizePt ? `${cropSizePt.w} × ${cropSizePt.h} pt` : "Crop"}
          </span>
          <span className="h-3.5 w-px bg-black/[0.1]" />
          <button
            type="button"
            onClick={onApplyCrop}
            className="mac-blue-fill inline-flex cursor-pointer items-center gap-1 rounded-full px-3 py-1 text-[11.5px] font-medium text-white antialiased transition hover:brightness-105"
          >
            <Check className="h-3.5 w-3.5" /> Apply
          </button>
          <button
            type="button"
            onClick={onCancelCrop}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-black/[0.06] px-2.5 py-1 text-[11.5px] text-[#2C2C30] transition hover:bg-black/[0.1]"
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
        </div>
      ) : contextKind === "frame" ? (
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() =>
              onBackdropChange({ ...backdrop, enabled: !backdrop.enabled })
            }
            className={`cursor-pointer rounded-full px-2.5 py-0.5 text-[11.5px] font-medium transition ${
              backdrop.enabled
                ? "bg-[#007AFF]/[0.12] text-[#0066D6]"
                : "bg-black/[0.06] text-[#52525B]"
            }`}
          >
            {backdrop.enabled ? "Frame On" : "Frame Off"}
          </button>
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
                className={`h-[18px] w-[18px] cursor-pointer rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] transition ${
                  backdrop.background === b.value && backdrop.enabled
                    ? "ring-2 ring-[#007AFF] ring-offset-1"
                    : "hover:scale-110"
                }`}
              />
            ))}
          </div>
          <span className="h-4 w-px bg-black/[0.1]" />
          <label className="flex items-center gap-1.5 text-[11.5px] text-[#3F3F46]">
            <span>Pad</span>
            <input
              type="range"
              min={12}
              max={96}
              value={backdrop.padding}
              onChange={(e) =>
                onBackdropChange({
                  ...backdrop,
                  enabled: true,
                  padding: Number(e.target.value),
                })
              }
              className="gaze-slider w-16"
              style={{ background: sliderTrack(backdrop.padding, 12, 96) }}
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11.5px] text-[#3F3F46]">
            <span>Round</span>
            <input
              type="range"
              min={0}
              max={28}
              value={backdrop.cornerRadius}
              onChange={(e) =>
                onBackdropChange({
                  ...backdrop,
                  enabled: true,
                  cornerRadius: Number(e.target.value),
                })
              }
              className="gaze-slider w-14"
              style={{ background: sliderTrack(backdrop.cornerRadius, 0, 28) }}
            />
          </label>
          <button
            type="button"
            onClick={() =>
              onBackdropChange({
                ...backdrop,
                enabled: true,
                shadow: !backdrop.shadow,
              })
            }
            className={`cursor-pointer rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
              backdrop.shadow
                ? "bg-black/[0.08] text-[#141416]"
                : "text-[#63636C] hover:bg-black/[0.05]"
            }`}
          >
            Shadow
          </button>
        </div>
      ) : contextKind === "blur" ||
        contextKind === "pixelate" ||
        contextKind === "blackout" ? (
        <div className="flex items-center gap-2.5">
          <div className="flex rounded-full bg-black/[0.06] p-0.5 text-[11.5px]">
            {(
              [
                ["blur", "Blur"],
                ["pixelate", "Pixelate"],
                ["blackout", "Blackout"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onSelectRedactMode(mode)}
                className={`cursor-pointer rounded-full px-2.5 py-0.5 transition ${
                  contextKind === mode
                    ? "bg-white font-medium text-[#141416] shadow-xs"
                    : "text-[#52525B] hover:text-[#141416]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="h-4 w-px bg-black/[0.1]" />

          {contextKind === "blackout" ? (
            renderColorSwatches(
              BLACKOUT_COLORS,
              effectiveBlackoutColor,
              onBlackoutColorChange,
            )
          ) : (
            <label className="flex items-center gap-2 text-[11.5px] text-[#3F3F46]">
              <span>Strength</span>
              <input
                type="range"
                min={4}
                max={28}
                value={effectiveBlurStrength}
                onChange={(e) => onBlurStrengthChange(Number(e.target.value))}
                className="gaze-slider w-24"
                style={{
                  background: sliderTrack(effectiveBlurStrength, 4, 28),
                }}
              />
              <span className="w-5 text-right font-medium tabular-nums text-[#141416]">
                {effectiveBlurStrength}
              </span>
            </label>
          )}
          {renderSelectionActions()}
        </div>
      ) : contextKind === "spotlight" ? (
        <div className="flex items-center gap-2.5">
          <span className="text-[11.5px] font-medium text-[#141416]">
            Spotlight
          </span>
          <span className="h-4 w-px bg-black/[0.1]" />
          <label className="flex items-center gap-2 text-[11.5px] text-[#3F3F46]">
            <span>Dim</span>
            <input
              type="range"
              min={25}
              max={80}
              value={Math.round(effectiveSpotlightOpacity * 100)}
              onChange={(e) =>
                onSpotlightOpacityChange(Number(e.target.value) / 100)
              }
              className="gaze-slider w-20"
              style={{
                background: sliderTrack(
                  Math.round(effectiveSpotlightOpacity * 100),
                  25,
                  80,
                ),
              }}
            />
            <span className="w-8 text-right font-medium tabular-nums text-[#141416]">
              {Math.round(effectiveSpotlightOpacity * 100)}%
            </span>
          </label>
          {renderSelectionActions()}
        </div>
      ) : contextKind === "text" ? (
        <div className="flex items-center gap-2.5">
          <div className="flex rounded-full bg-black/[0.06] p-0.5 text-[11.5px]">
            {(
              [
                ["plain", "Plain"],
                ["badge", "Badge"],
              ] as const
            ).map(([style, label]) => (
              <button
                key={style}
                type="button"
                onClick={() => onTextStyleChange(style)}
                className={`cursor-pointer rounded-full px-2.5 py-0.5 transition ${
                  effectiveTextStyle === style
                    ? "bg-white font-medium text-[#141416] shadow-xs"
                    : "text-[#52525B] hover:text-[#141416]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="h-4 w-px bg-black/[0.1]" />
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          <span className="h-4 w-px bg-black/[0.1]" />
          <label className="flex items-center gap-2 text-[11.5px] text-[#3F3F46]">
            <span>Size</span>
            <input
              type="range"
              min={12}
              max={48}
              value={effectiveFontSize}
              onChange={(e) => onFontSizeChange(Number(e.target.value))}
              className="gaze-slider w-20"
              style={{ background: sliderTrack(effectiveFontSize, 12, 48) }}
            />
            <span className="w-7 text-right font-medium tabular-nums text-[#141416]">
              {effectiveFontSize}
            </span>
          </label>
          {renderSelectionActions()}
        </div>
      ) : contextKind === "counter" ? (
        <div className="flex items-center gap-2.5">
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          <span className="h-4 w-px bg-black/[0.1]" />
          <div className="flex rounded-full bg-black/[0.06] p-0.5 text-[11px]">
            {COUNTER_SIZES.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => onCounterRadiusChange(s.radius)}
                className={`cursor-pointer rounded-full px-2 py-0.5 transition ${
                  effectiveCounterRadius === s.radius
                    ? "bg-white font-semibold text-[#141416] shadow-xs"
                    : "text-[#52525B] hover:text-[#141416]"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {!selectedAnnotation && (
            <>
              <span className="h-4 w-px bg-black/[0.1]" />
              <div className="flex items-center gap-1 text-[11.5px] text-[#3F3F46]">
                <span className="tabular-nums">Next #{nextCounterNum}</span>
                {nextCounterNum > 1 && (
                  <button
                    type="button"
                    title="Reset counter to 1"
                    onClick={onResetCounter}
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-[#52525B] transition hover:bg-black/[0.07] hover:text-[#141416]"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
              </div>
            </>
          )}
          {renderSelectionActions()}
        </div>
      ) : contextKind === "pen" ? (
        <div className="flex items-center gap-2.5">
          <div className="flex rounded-full bg-black/[0.06] p-0.5 text-[11.5px]">
            <button
              type="button"
              onClick={() => onHighlighterChange(false)}
              className={`cursor-pointer rounded-full px-2.5 py-0.5 transition ${
                !effectiveHighlighter
                  ? "bg-white font-medium text-[#141416] shadow-xs"
                  : "text-[#52525B] hover:text-[#141416]"
              }`}
            >
              Pen
            </button>
            <button
              type="button"
              onClick={() => onHighlighterChange(true)}
              className={`cursor-pointer rounded-full px-2.5 py-0.5 transition ${
                effectiveHighlighter
                  ? "bg-white font-medium text-[#141416] shadow-xs"
                  : "text-[#52525B] hover:text-[#141416]"
              }`}
            >
              Highlighter
            </button>
          </div>
          <span className="h-4 w-px bg-black/[0.1]" />
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          <span className="h-4 w-px bg-black/[0.1]" />
          {renderStrokeDots()}
          {renderSelectionActions()}
        </div>
      ) : contextKind === "rect" || contextKind === "ellipse" ? (
        <div className="flex items-center gap-2.5">
          <div className="flex rounded-full bg-black/[0.06] p-0.5 text-[11.5px]">
            {(
              [
                ["outline", "Outline"],
                ["tinted", "Tinted"],
                ["solid", "Solid"],
              ] as const
            ).map(([style, label]) => (
              <button
                key={style}
                type="button"
                onClick={() => onShapeFillStyleChange(style)}
                className={`cursor-pointer rounded-full px-2 py-0.5 transition ${
                  effectiveFillStyle === style
                    ? "bg-white font-medium text-[#141416] shadow-xs"
                    : "text-[#52525B] hover:text-[#141416]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="h-4 w-px bg-black/[0.1]" />
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          {effectiveFillStyle !== "solid" && (
            <>
              <span className="h-4 w-px bg-black/[0.1]" />
              {renderStrokeDots()}
            </>
          )}
          {renderSelectionActions()}
        </div>
      ) : contextKind === "ruler" ? (
        <div className="flex items-center gap-2.5">
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          {renderSelectionActions()}
        </div>
      ) : (
        /* arrow | line */
        <div className="flex items-center gap-2.5">
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          <span className="h-4 w-px bg-black/[0.1]" />
          {renderStrokeDots()}
          {renderSelectionActions()}
        </div>
      )}
    </div>
  );
}
