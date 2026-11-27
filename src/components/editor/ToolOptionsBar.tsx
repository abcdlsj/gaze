import type { CSSProperties } from "react";
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
import {
  OPTIONS_ACTION_ICON_CLS,
  OPTIONS_BAR_SHELL_CLS,
  OPTIONS_DIVIDER_CLS,
  OPTIONS_ICON_CLS,
  OPTIONS_ROW_CLS,
  OPTIONS_SEGMENT_TRACK_CLS,
  OPTIONS_SLIDER_LABEL_CLS,
  OPTIONS_SLIDER_VALUE_CLS,
  optionsActionPillClass,
  optionsCircleIconBtnClass,
  optionsSegmentBtnClass,
  optionsSwatchClass,
  optionsTogglePillClass,
} from "./toolbarSpec";

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

function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  compact = false,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  compact?: boolean;
}) {
  return (
    <div className={OPTIONS_SEGMENT_TRACK_CLS}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={optionsSegmentBtnClass(active, compact)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
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
  /**
   * Fixed-position placement (in-place editor). When omitted the bar floats centered at the
   * top of the editor viewport.
   */
  floatingStyle?: CSSProperties;
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
  floatingStyle,
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
    <div className="flex h-[24px] items-center gap-[6px]">
      {palette.map((hex) => {
        const active = activeHex.toLowerCase() === hex.toLowerCase();
        return (
          <button
            key={hex}
            type="button"
            aria-label={`Color ${hex}`}
            aria-pressed={active}
            onClick={() => onChange(hex)}
            style={{ backgroundColor: hex }}
            className={optionsSwatchClass(active)}
          />
        );
      })}
    </div>
  );

  const renderStrokeDots = () => (
    <div className="flex items-center gap-[3px]" title="Stroke width ([ / ])">
      {STROKE_PRESETS.map((w) => {
        const active = Math.abs(effectiveStroke - w) < 0.8;
        const dotSize = Math.min(12, 3.5 + w * 1.05);
        return (
          <button
            key={w}
            type="button"
            aria-label={`Stroke width ${w}px`}
            aria-pressed={active}
            onClick={() => onStrokeWidthChange(w)}
            className={optionsCircleIconBtnClass({ active })}
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
        <span className={OPTIONS_DIVIDER_CLS} />
        <div className="flex items-center gap-[3px]">
          <button
            type="button"
            title="Duplicate (⌘D)"
            aria-label="Duplicate annotation"
            onClick={onDuplicateSelected}
            className={optionsCircleIconBtnClass()}
          >
            <CopyPlus className={OPTIONS_ICON_CLS} />
          </button>
          <button
            type="button"
            title="Delete (⌫)"
            aria-label="Delete annotation"
            onClick={onDeleteSelected}
            className={optionsCircleIconBtnClass({ destructive: true })}
          >
            <Trash2 className={OPTIONS_ICON_CLS} />
          </button>
        </div>
      </>
    );
  };

  return (
    <div
      data-options-bar="true"
      onMouseDown={keepFocusOnMouseDown}
      style={floatingStyle}
      className={`${OPTIONS_BAR_SHELL_CLS} ${
        floatingStyle
          ? "fixed z-40 shadow-[0_5px_24px_rgba(0,0,0,0.22)]"
          : "absolute left-1/2 top-3 z-[25] max-w-[94%] -translate-x-1/2 shadow-[0_8px_28px_rgba(0,0,0,0.12)]"
      }`}
    >
      {contextKind === "crop" ? (
        <div className={OPTIONS_ROW_CLS}>
          <span className="font-mono text-[11.5px] font-medium tabular-nums leading-none text-[#3F3F46]">
            {cropSizePt ? `${cropSizePt.w} × ${cropSizePt.h} pt` : "Crop"}
          </span>
          <span className={OPTIONS_DIVIDER_CLS} />
          <div className="flex items-center gap-[6px]">
            <button
              type="button"
              onClick={onApplyCrop}
              className={optionsActionPillClass("primary")}
            >
              <Check className={OPTIONS_ACTION_ICON_CLS} /> Apply
            </button>
            <button
              type="button"
              onClick={onCancelCrop}
              className={optionsActionPillClass("secondary")}
            >
              <X className={OPTIONS_ACTION_ICON_CLS} /> Cancel
            </button>
          </div>
        </div>
      ) : contextKind === "frame" ? (
        <div className={OPTIONS_ROW_CLS}>
          <button
            type="button"
            aria-pressed={backdrop.enabled}
            onClick={() =>
              onBackdropChange({ ...backdrop, enabled: !backdrop.enabled })
            }
            className={optionsTogglePillClass(backdrop.enabled)}
          >
            {backdrop.enabled ? "Frame On" : "Frame Off"}
          </button>
          <div className="flex h-[24px] items-center gap-[6px]">
            {BACKDROPS.map((b) => {
              const active = backdrop.background === b.value && backdrop.enabled;
              return (
                <button
                  key={b.label}
                  type="button"
                  title={b.label}
                  aria-label={`Backdrop ${b.label}`}
                  aria-pressed={active}
                  onClick={() =>
                    onBackdropChange({
                      ...backdrop,
                      enabled: true,
                      background: b.value,
                    })
                  }
                  style={{ background: b.value }}
                  className={optionsSwatchClass(active)}
                />
              );
            })}
          </div>
          <span className={OPTIONS_DIVIDER_CLS} />
          <label className={OPTIONS_SLIDER_LABEL_CLS}>
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
              className="gaze-slider w-[56px]"
              style={{ background: sliderTrack(backdrop.padding, 12, 96) }}
            />
          </label>
          <label className={OPTIONS_SLIDER_LABEL_CLS}>
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
              className="gaze-slider w-[56px]"
              style={{ background: sliderTrack(backdrop.cornerRadius, 0, 28) }}
            />
          </label>
          <button
            type="button"
            aria-pressed={backdrop.shadow}
            onClick={() =>
              onBackdropChange({
                ...backdrop,
                enabled: true,
                shadow: !backdrop.shadow,
              })
            }
            className={optionsTogglePillClass(backdrop.shadow)}
          >
            Shadow
          </button>
        </div>
      ) : contextKind === "blur" ||
        contextKind === "pixelate" ||
        contextKind === "blackout" ? (
        <div className={OPTIONS_ROW_CLS}>
          <SegmentedControl<RedactMode>
            options={[
              { value: "blur", label: "Blur" },
              { value: "pixelate", label: "Pixelate" },
              { value: "blackout", label: "Blackout" },
            ]}
            value={contextKind}
            onChange={onSelectRedactMode}
          />

          <span className={OPTIONS_DIVIDER_CLS} />

          {contextKind === "blackout" ? (
            renderColorSwatches(
              BLACKOUT_COLORS,
              effectiveBlackoutColor,
              onBlackoutColorChange,
            )
          ) : (
            <label className={OPTIONS_SLIDER_LABEL_CLS}>
              <span>Strength</span>
              <input
                type="range"
                min={4}
                max={28}
                value={effectiveBlurStrength}
                onChange={(e) => onBlurStrengthChange(Number(e.target.value))}
                className="gaze-slider w-[80px]"
                style={{
                  background: sliderTrack(effectiveBlurStrength, 4, 28),
                }}
              />
              <span className={`${OPTIONS_SLIDER_VALUE_CLS} w-[18px]`}>
                {effectiveBlurStrength}
              </span>
            </label>
          )}
          {renderSelectionActions()}
        </div>
      ) : contextKind === "spotlight" ? (
        <div className={OPTIONS_ROW_CLS}>
          <span className="inline-flex h-[24px] items-center text-[11.5px] font-medium leading-none text-[#141416]">
            Spotlight
          </span>
          <span className={OPTIONS_DIVIDER_CLS} />
          <label className={OPTIONS_SLIDER_LABEL_CLS}>
            <span>Dim</span>
            <input
              type="range"
              min={25}
              max={80}
              value={Math.round(effectiveSpotlightOpacity * 100)}
              onChange={(e) =>
                onSpotlightOpacityChange(Number(e.target.value) / 100)
              }
              className="gaze-slider w-[80px]"
              style={{
                background: sliderTrack(
                  Math.round(effectiveSpotlightOpacity * 100),
                  25,
                  80,
                ),
              }}
            />
            <span className={`${OPTIONS_SLIDER_VALUE_CLS} w-[28px]`}>
              {Math.round(effectiveSpotlightOpacity * 100)}%
            </span>
          </label>
          {renderSelectionActions()}
        </div>
      ) : contextKind === "text" ? (
        <div className={OPTIONS_ROW_CLS}>
          <SegmentedControl<TextStyle>
            options={[
              { value: "plain", label: "Plain" },
              { value: "badge", label: "Badge" },
            ]}
            value={effectiveTextStyle}
            onChange={onTextStyleChange}
          />
          <span className={OPTIONS_DIVIDER_CLS} />
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          <span className={OPTIONS_DIVIDER_CLS} />
          <label className={OPTIONS_SLIDER_LABEL_CLS}>
            <span>Size</span>
            <input
              type="range"
              min={12}
              max={48}
              value={effectiveFontSize}
              onChange={(e) => onFontSizeChange(Number(e.target.value))}
              className="gaze-slider w-[80px]"
              style={{ background: sliderTrack(effectiveFontSize, 12, 48) }}
            />
            <span className={`${OPTIONS_SLIDER_VALUE_CLS} w-[22px]`}>
              {effectiveFontSize}
            </span>
          </label>
          {renderSelectionActions()}
        </div>
      ) : contextKind === "counter" ? (
        <div className={OPTIONS_ROW_CLS}>
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          <span className={OPTIONS_DIVIDER_CLS} />
          <SegmentedControl<number>
            compact
            options={COUNTER_SIZES.map((s) => ({
              value: s.radius,
              label: s.label,
            }))}
            value={effectiveCounterRadius}
            onChange={onCounterRadiusChange}
          />
          {!selectedAnnotation && (
            <>
              <span className={OPTIONS_DIVIDER_CLS} />
              <div className="flex h-[24px] items-center gap-1 text-[11.5px] leading-none text-[#3F3F46]">
                <span className="tabular-nums">Next #{nextCounterNum}</span>
                {nextCounterNum > 1 && (
                  <button
                    type="button"
                    title="Reset counter to 1"
                    aria-label="Reset counter to 1"
                    onClick={onResetCounter}
                    className={optionsCircleIconBtnClass()}
                  >
                    <RotateCcw className={OPTIONS_ICON_CLS} />
                  </button>
                )}
              </div>
            </>
          )}
          {renderSelectionActions()}
        </div>
      ) : contextKind === "pen" ? (
        <div className={OPTIONS_ROW_CLS}>
          <SegmentedControl<"pen" | "highlighter">
            options={[
              { value: "pen", label: "Pen" },
              { value: "highlighter", label: "Highlighter" },
            ]}
            value={effectiveHighlighter ? "highlighter" : "pen"}
            onChange={(mode) => onHighlighterChange(mode === "highlighter")}
          />
          <span className={OPTIONS_DIVIDER_CLS} />
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          <span className={OPTIONS_DIVIDER_CLS} />
          {renderStrokeDots()}
          {renderSelectionActions()}
        </div>
      ) : contextKind === "rect" || contextKind === "ellipse" ? (
        <div className={OPTIONS_ROW_CLS}>
          <SegmentedControl<ShapeFillStyle>
            options={[
              { value: "outline", label: "Outline" },
              { value: "tinted", label: "Tinted" },
              { value: "solid", label: "Solid" },
            ]}
            value={effectiveFillStyle}
            onChange={onShapeFillStyleChange}
          />
          <span className={OPTIONS_DIVIDER_CLS} />
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          {effectiveFillStyle !== "solid" && (
            <>
              <span className={OPTIONS_DIVIDER_CLS} />
              {renderStrokeDots()}
            </>
          )}
          {renderSelectionActions()}
        </div>
      ) : contextKind === "ruler" ? (
        <div className={OPTIONS_ROW_CLS}>
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          {renderSelectionActions()}
        </div>
      ) : (
        /* arrow | line */
        <div className={OPTIONS_ROW_CLS}>
          {renderColorSwatches(COLORS, effectiveColor, onColorChange)}
          <span className={OPTIONS_DIVIDER_CLS} />
          {renderStrokeDots()}
          {renderSelectionActions()}
        </div>
      )}
    </div>
  );
}
