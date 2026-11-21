import { useEffect, useState } from "react";
import { AlertCircle, RotateCcw, X } from "lucide-react";
import {
  formatShortcutDisplay,
  keyboardEventToShortcut,
} from "../../lib/hotkeys";
import type { AppSettings, HotkeyConfig } from "../../types";

interface Props {
  settings: AppSettings;
  hotkeyErrors: Record<string, string | null>;
  onChange: (patch: Partial<AppSettings>) => void;
}

const ROWS: {
  key: keyof HotkeyConfig;
  label: string;
  hint: string;
}[] = [
  {
    key: "capture_area",
    label: "Capture Area",
    hint: "Drag to capture a region (default F1)",
  },
  {
    key: "capture_scrolling",
    label: "Scrolling Screenshot",
    hint: "Auto-scroll and stitch long pages",
  },
  {
    key: "capture_fullscreen",
    label: "Capture Fullscreen",
    hint: "Instant capture of the active display",
  },
  {
    key: "capture_window",
    label: "Capture Window",
    hint: "Hover and click any app window",
  },
  {
    key: "open_clipboard",
    label: "Open from Clipboard",
    hint: "Open clipboard image directly in Editor",
  },
];

export function HotkeysTab({ settings, hotkeyErrors, onChange }: Props) {
  const [recordingKey, setRecordingKey] = useState<keyof HotkeyConfig | null>(
    null,
  );

  useEffect(() => {
    if (!recordingKey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecordingKey(null);
        return;
      }
      if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        onChange({
          hotkeys: { ...settings.hotkeys, [recordingKey]: "" },
        });
        setRecordingKey(null);
        return;
      }

      const shortcut = keyboardEventToShortcut(e);
      if (shortcut) {
        onChange({
          hotkeys: { ...settings.hotkeys, [recordingKey]: shortcut },
        });
        setRecordingKey(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingKey, settings.hotkeys, onChange]);

  const clearHotkey = (key: keyof HotkeyConfig) => {
    onChange({
      hotkeys: { ...settings.hotkeys, [key]: "" },
    });
  };

  const resetHotkeys = () => {
    onChange({
      hotkeys: {
        capture_area: "F1",
        capture_fullscreen: "",
        capture_window: "",
        capture_scrolling: "Shift+F1",
        open_clipboard: "CommandOrControl+Shift+V",
      },
    });
  };

  return (
    <div className="flex flex-col px-8 py-5">
      <div className="mb-3.5">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-[#1D1D1F]">
          Global Shortcuts
        </h3>
        <p className="mt-0.5 text-[11.5px] text-[#86868B]">
          Click any key box and press F1–F12 or a modifier combo. Press Esc to
          cancel.
        </p>
      </div>

      <div className="divide-y divide-black/[0.06] overflow-hidden rounded-xl border border-black/[0.08] bg-[#FAFAFC]">
        {ROWS.map((row) => {
          const rawValue = settings.hotkeys[row.key];
          const display = formatShortcutDisplay(rawValue);
          const isRecording = recordingKey === row.key;
          const err = hotkeyErrors[row.key];

          return (
            <div key={row.key} className="flex flex-col gap-1 px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-[#1D1D1F]">
                    {row.label}
                  </div>
                  <div className="text-[11px] text-[#86868B]">{row.hint}</div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setRecordingKey(isRecording ? null : row.key)
                    }
                    className={`flex h-[28px] min-w-[126px] cursor-pointer items-center justify-center rounded-[7px] px-3 text-[12px] font-medium transition-all ${
                      isRecording
                        ? "border border-[#007AFF] bg-[#007AFF]/[0.08] text-[#007AFF] ring-[3px] ring-[#007AFF]/20"
                        : display
                          ? "border border-black/[0.1] bg-white text-[#1D1D1F] shadow-[0_1px_1.5px_rgba(0,0,0,0.05)] hover:border-black/[0.2]"
                          : "border border-dashed border-black/[0.16] bg-white/60 text-[#AEAEB2] hover:border-black/[0.28] hover:text-[#6E6E73]"
                    }`}
                  >
                    {isRecording ? (
                      <span className="animate-pulse">Press keys…</span>
                    ) : display ? (
                      <span className="tracking-wider">{display}</span>
                    ) : (
                      <span>Record Shortcut</span>
                    )}
                  </button>

                  {rawValue && !isRecording && (
                    <button
                      type="button"
                      onClick={() => clearHotkey(row.key)}
                      title="Clear shortcut"
                      className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-md text-[#AEAEB2] transition hover:bg-black/[0.06] hover:text-[#3A3A3C]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {err && (
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#FF3B30]">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{err}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <span className="text-[11px] leading-snug text-[#86868B]">
          On MacBooks where F1 adjusts brightness, press Fn+F1 or enable
          standard function keys in Keyboard Settings.
        </span>
        <button
          type="button"
          onClick={resetHotkeys}
          className="mac-btn inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] px-3 py-1 text-[12px] font-medium text-[#1D1D1F] transition"
        >
          <RotateCcw className="h-3 w-3" />
          <span>Defaults</span>
        </button>
      </div>
    </div>
  );
}
