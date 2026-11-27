import type { EditorTool, InplaceAction } from "../../types";

// Metrics of the Snipaste-style edit toolbar. They MUST match the `TOOLBAR_*` constants and
// `TOOLBAR_ITEMS` in src-tauri/src/macos_overlay.rs: the native overlay draws this toolbar
// first, and the in-place webview editor redraws it at the very same coordinates.
export const TOOLBAR_PAD = 5;
export const TOOLBAR_BTN = 30;
export const TOOLBAR_GAP = 2;
export const TOOLBAR_DIVIDER = 11;
export const TOOLBAR_PILL_H = 40;

export type InplaceToolbarItem =
  | { kind: "tool"; tool: EditorTool; label: string; shortcut: string }
  | { kind: "undo" | "redo"; label: string; shortcut: string }
  | { kind: "scroll"; label: string; shortcut: string }
  | {
      kind: "action";
      action: Exclude<InplaceAction, "cancel" | "done">;
      label: string;
      shortcut: string;
    }
  | { kind: "cancel" | "done"; label: string; shortcut: string }
  | { kind: "divider" };

export const TOOLBAR_ITEMS: InplaceToolbarItem[] = [
  { kind: "tool", tool: "rect", label: "Rectangle", shortcut: "S" },
  { kind: "tool", tool: "ellipse", label: "Ellipse", shortcut: "O" },
  { kind: "tool", tool: "arrow", label: "Arrow", shortcut: "A" },
  { kind: "tool", tool: "line", label: "Line", shortcut: "L" },
  { kind: "tool", tool: "pen", label: "Pen / Highlighter", shortcut: "P" },
  { kind: "tool", tool: "text", label: "Text", shortcut: "T" },
  { kind: "tool", tool: "pixelate", label: "Mosaic", shortcut: "X" },
  { kind: "tool", tool: "blur", label: "Blur", shortcut: "B" },
  { kind: "tool", tool: "counter", label: "Step Number", shortcut: "N" },
  { kind: "divider" },
  { kind: "undo", label: "Undo", shortcut: "⌘Z" },
  { kind: "redo", label: "Redo", shortcut: "⇧⌘Z" },
  { kind: "divider" },
  { kind: "scroll", label: "Scrolling Capture", shortcut: "" },
  { kind: "action", action: "pin", label: "Pin on Screen", shortcut: "" },
  { kind: "action", action: "editor", label: "Open in Editor", shortcut: "" },
  { kind: "action", action: "save", label: "Save", shortcut: "⌘S" },
  { kind: "divider" },
  { kind: "cancel", label: "Cancel", shortcut: "Esc" },
  { kind: "done", label: "Copy & Done", shortcut: "↵" },
];

/** Local x of every item inside the pill. */
export function toolbarItemXs(items: InplaceToolbarItem[] = TOOLBAR_ITEMS): number[] {
  const xs: number[] = [];
  let x = TOOLBAR_PAD;
  let prevWasButton = false;
  for (const item of items) {
    if (item.kind === "divider") {
      xs.push(x);
      x += TOOLBAR_DIVIDER;
      prevWasButton = false;
    } else {
      if (prevWasButton) x += TOOLBAR_GAP;
      xs.push(x);
      x += TOOLBAR_BTN;
      prevWasButton = true;
    }
  }
  return xs;
}

export const TOOLBAR_WIDTH = (() => {
  const xs = toolbarItemXs();
  return xs[xs.length - 1] + TOOLBAR_BTN + TOOLBAR_PAD;
})();
