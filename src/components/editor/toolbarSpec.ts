/**
 * Shared visual specification for Gaze editor toolbars (`EditorToolbar`,
 * `InplaceToolbar`) and the floating `ToolOptionsBar`.
 *
 * Centralizing dimensions, border radii, gaps, icon weights, and interactive
 * states here ensures all tool groups and sub-panel controls share a single
 * visual rhythm and stay aligned across edits.
 */

// ---------------------------------------------------------------------------
// Toolbar buttons & icons
// ---------------------------------------------------------------------------

/** Standard square icon button box (30×30px, 7px radius). */
export const TOOLBAR_BTN_SIZE_CLS = "h-[30px] w-[30px]";
export const TOOLBAR_BTN_RADIUS_CLS = "rounded-[7px]";

/** Gap between adjacent icon buttons inside a toolbar group (matches TOOLBAR_GAP = 2). */
export const TOOLBAR_GROUP_GAP_CLS = "gap-[2px]";

/**
 * Icon optical weights (all Lucide and custom SVG icons share a 24×24 viewBox
 * and 1.75 stroke width so stroke density is identical across every tool).
 */
export const EDITOR_TOOLBAR_ICON_CLS = "h-[16px] w-[16px] stroke-[1.75]";
export const INPLACE_TOOLBAR_ICON_CLS = "h-[17px] w-[17px] stroke-[1.75]";
export const MENU_ICON_CLS = "h-[14px] w-[14px] stroke-[1.75]";

/** Active pill fill + crisp inner hairline ring shared by toolbars and options. */
export const ACCENT_ACTIVE_CLS =
  "bg-[#007AFF]/[0.11] text-[#0066D6] shadow-[inset_0_0_0_1px_rgba(0,122,255,0.2)]";

export function toolbarIconBtnClass({
  active = false,
  disabled = false,
  accent = false,
  variant = "editor",
}: {
  active?: boolean;
  disabled?: boolean;
  accent?: boolean;
  /**
   * "editor" uses high-contrast ink on the solid white titlebar;
   * "inplace" matches the muted ink of the native macOS capture overlay bar.
   */
  variant?: "editor" | "inplace";
}): string {
  const base = `flex ${TOOLBAR_BTN_SIZE_CLS} items-center justify-center ${TOOLBAR_BTN_RADIUS_CLS} transition-all duration-100`;
  if (disabled) {
    return `${base} cursor-default ${
      variant === "inplace" ? "text-[#26262B]/30" : "text-[#27272A]/30"
    }`;
  }
  if (active) {
    return `${base} cursor-pointer ${ACCENT_ACTIVE_CLS}`;
  }
  if (accent) {
    return `${base} cursor-pointer text-[#0066D6] hover:bg-[#007AFF]/[0.08] active:scale-[0.95]`;
  }
  const idleInk =
    variant === "inplace"
      ? "text-[#42424A] hover:text-[#1C1C1F]"
      : "text-[#27272A] hover:text-[#09090B]";
  return `${base} cursor-pointer ${idleInk} hover:bg-black/[0.06] active:scale-[0.95]`;
}

// ---------------------------------------------------------------------------
// Toolbar dropdown menus (More Tools, Zoom)
// ---------------------------------------------------------------------------

export const TOOLBAR_MENU_CLS =
  "animate-pop-in absolute top-full z-50 mt-2 rounded-[12px] border border-black/[0.1] bg-white/95 py-1 text-[12px] text-[#141416] shadow-[0_12px_36px_rgba(0,0,0,0.14)] backdrop-blur-xl";

export function toolbarMenuItemClass(
  active = false,
  destructive = false,
): string {
  const base =
    "flex w-full cursor-pointer items-center justify-between px-3 py-[6px] text-left text-[12px] transition-colors disabled:cursor-default disabled:opacity-40";
  if (destructive) {
    return `${base} text-[#D70015] hover:bg-[#FF3B30]/[0.07]`;
  }
  if (active) {
    return `${base} bg-[#007AFF]/[0.08] font-medium text-[#0066D6]`;
  }
  return `${base} hover:bg-black/[0.05]`;
}

// ---------------------------------------------------------------------------
// Floating ToolOptionsBar controls (consistent 36px single-row pill height)
// ---------------------------------------------------------------------------

/** Outer floating bar shell: exact 36px min-height on every tool. */
export const OPTIONS_BAR_SHELL_CLS =
  "animate-pop-in pointer-events-auto flex min-h-[36px] items-center gap-[10px] rounded-[18px] border border-black/[0.1] bg-white/95 px-[10px] py-[5px] text-[12px] text-[#141416] backdrop-blur-xl [&_*]:whitespace-nowrap [&>div]:flex-wrap [&>div]:gap-y-[6px]";

/** Row layout inside each tool branch of ToolOptionsBar. */
export const OPTIONS_ROW_CLS = "flex items-center gap-[10px]";

/** Vertical hairline divider inside ToolOptionsBar (16px tall everywhere). */
export const OPTIONS_DIVIDER_CLS = "h-[16px] w-px shrink-0 bg-black/[0.1]";

/** Segmented control outer track (24px tall, 2px inner padding). */
export const OPTIONS_SEGMENT_TRACK_CLS =
  "inline-flex h-[24px] items-center rounded-full bg-black/[0.06] p-[2px]";

/** Segmented control button (20px tall, consistent 11.5px medium text to prevent width jitter). */
export function optionsSegmentBtnClass(active: boolean, compact = false): string {
  const padding = compact ? "min-w-[24px] px-[7px]" : "px-[10px]";
  const base = `inline-flex h-[20px] cursor-pointer items-center justify-center rounded-full ${padding} text-[11.5px] font-medium leading-none transition-all duration-100`;
  return active
    ? `${base} bg-white text-[#141416] shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_0.5px_rgba(0,0,0,0.04)]`
    : `${base} text-[#52525B] hover:text-[#141416]`;
}

/** Standalone toggle pill (e.g. Frame On/Off, Shadow) — 24px tall. */
export function optionsTogglePillClass(active: boolean): string {
  const base =
    "inline-flex h-[24px] cursor-pointer items-center justify-center rounded-full px-[10px] text-[11.5px] font-medium leading-none transition-all duration-100 active:scale-[0.97]";
  return active
    ? `${base} ${ACCENT_ACTIVE_CLS}`
    : `${base} bg-black/[0.06] text-[#52525B] hover:bg-black/[0.09] hover:text-[#141416]`;
}

/** Pill action button (e.g. Crop Apply / Cancel) — 24px tall. */
export function optionsActionPillClass(variant: "primary" | "secondary"): string {
  const base =
    "inline-flex h-[24px] cursor-pointer items-center justify-center gap-1 rounded-full px-[10px] text-[11.5px] font-medium leading-none transition-all duration-100 active:scale-[0.97]";
  return variant === "primary"
    ? `${base} mac-blue-fill text-white antialiased hover:brightness-105`
    : `${base} bg-black/[0.06] text-[#2C2C30] hover:bg-black/[0.1] hover:text-[#141416]`;
}

/** Circular color / backdrop swatch (18×18px everywhere). */
export function optionsSwatchClass(active: boolean): string {
  const base =
    "h-[18px] w-[18px] shrink-0 cursor-pointer rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.16)] transition-transform duration-100";
  return active
    ? `${base} ring-2 ring-[#007AFF] ring-offset-1`
    : `${base} hover:scale-110`;
}

/** Circular 24×24 icon/dot button inside ToolOptionsBar (stroke dots, duplicate, delete, reset). */
export function optionsCircleIconBtnClass({
  active = false,
  destructive = false,
}: {
  active?: boolean;
  destructive?: boolean;
} = {}): string {
  const base =
    "flex h-[24px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-full transition-all duration-100 active:scale-[0.95]";
  if (destructive) {
    return `${base} text-[#D70015] hover:bg-[#FF3B30]/[0.08]`;
  }
  if (active) {
    return `${base} ${ACCENT_ACTIVE_CLS}`;
  }
  return `${base} text-[#3F3F46] hover:bg-black/[0.06] hover:text-[#141416]`;
}

export const OPTIONS_ICON_CLS = "h-[14px] w-[14px] stroke-[1.75]";
export const OPTIONS_ACTION_ICON_CLS = "h-[13px] w-[13px] stroke-[1.85]";

export const OPTIONS_SLIDER_LABEL_CLS =
  "inline-flex h-[24px] items-center gap-[8px] text-[11.5px] leading-none text-[#3F3F46]";
export const OPTIONS_SLIDER_VALUE_CLS =
  "text-right text-[11.5px] font-medium tabular-nums leading-none text-[#141416]";
