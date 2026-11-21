const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "OS",
]);

/**
 * Converts a browser KeyboardEvent into a Tauri global-shortcut accelerator string
 * such as "F1", "Shift+F1", "CommandOrControl+Shift+4", etc.
 */
export function keyboardEventToShortcut(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) {
    return null;
  }

  const parts: string[] = [];
  if (isMac) {
    if (e.metaKey) {
      parts.push("CommandOrControl");
    }
    if (e.ctrlKey) {
      parts.push("Control");
    }
  } else {
    if (e.ctrlKey) {
      parts.push("CommandOrControl");
    }
    if (e.metaKey) {
      parts.push("Super");
    }
  }
  if (e.altKey) {
    parts.push("Alt");
  }
  if (e.shiftKey) {
    parts.push("Shift");
  }

  const key = normalizeKeyCode(e.code, e.key);
  if (!key) {
    return null;
  }

  // Allow function keys (F1-F12) without modifiers, and standard keys with at least one modifier.
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
  if (!isFunctionKey && parts.length === 0) {
    return null;
  }

  parts.push(key);
  return parts.join("+");
}

function normalizeKeyCode(code: string, key: string): string | null {
  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code;
  }
  if (/^F([1-9]|1[0-2])$/.test(key)) {
    return key;
  }
  if (/^Key([A-Z])$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit([0-9])$/.test(code)) {
    return code.slice(5);
  }
  const map: Record<string, string> = {
    Space: "Space",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    PrintScreen: "PrintScreen",
  };
  if (map[code]) {
    return map[code];
  }
  if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) {
    return key.toUpperCase();
  }
  return null;
}

/**
 * Formats a Tauri shortcut string into crisp OS-native display tokens (e.g. ⌘⇧V or Ctrl+Shift+V, F1).
 */
export function formatShortcutDisplay(shortcut: string): string {
  if (!shortcut.trim()) {
    return "";
  }
  const tokens = shortcut.split("+").map((t) => t.trim());
  if (isMac) {
    return tokens
      .map((t) => {
        switch (t) {
          case "CommandOrControl":
          case "Command":
          case "Super":
            return "⌘";
          case "Control":
          case "Ctrl":
            return "⌃";
          case "Alt":
          case "Option":
            return "⌥";
          case "Shift":
            return "⇧";
          case "Space":
            return "Space";
          default:
            return t;
        }
      })
      .join("");
  }
  return tokens
    .map((t) => (t === "CommandOrControl" ? "Ctrl" : t))
    .join("+");
}

export function isMacPlatform(): boolean {
  return isMac;
}
