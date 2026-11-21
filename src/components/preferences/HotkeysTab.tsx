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
    hint: "Select a region on screen (default F1)",
  },
  {
    key: "capture_scrolling",
    label: "Scrolling Screenshot",
    hint: "Auto-scroll and stitch a long page",
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
    hint: "Open the current clipboard image in Editor",
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
    <div className="flex flex-col px-7 py-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-semibold text-neutral-800">
            Global Shortcuts
          </h3>
          <p className="mt-0.5 text-[11.5px] text-neutral-500">
            Click a shortcut box and press any function key (F1–F12) or modifier
            combination. Press Esc to cancel.
          </p>
        </div>
      </div>

      <div className="divide-y divide-neutral-200/75 rounded-xl border border-neutral-200/80 bg-white">
        {ROWS.map((row) => {
          const rawValue = settings.hotkeys[row.key];
          const display = formatShortcutDisplay(rawValue);
          const isRecording = recordingKey === row.key;
          const err = hotkeyErrors[row.key];

          return (
            <div
              key={row.key}
              className="flex flex-col gap-1 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-neutral-800">
                    {row.label}
                  </div>
                  <div className="text-[11px] text-neutral-500">{row.hint}</div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setRecordingKey(isRecording ? null : row.key)
                    }
                    className={`flex h-[28px] min-w-[128px] items-center justify-center rounded-[7px] border px-3 text-[12px] font-medium transition ${
                      isRecording
                        ? "border-[#0A84FF] bg-[#0A84FF]/8 text-[#0A84FF] ring-2 ring-[#0A84FF]/25"
                        : display
                          ? "border-neutral-300 bg-neutral-50 text-neutral-800 hover:border-neutral-400"
                          : "border-dashed border-neutral-300 bg-neutral-50/50 text-neutral-400 hover:border-neutral-400 hover:text-neutral-600"
                    }`}
                  >
                    {isRecording ? (
                      <span className="animate-pulse">Type shortcut…</span>
                    ) : display ? (
                      <span className="tracking-wide">{display}</span>
                    ) : (
                      <span>Record Shortcut</span>
                    )}
                  </button>

                  {rawValue && !isRecording && (
                    <button
                      type="button"
                      onClick={() => clearHotkey(row.key)}
                      title="Clear shortcut"
                      className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {err && (
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-red-600">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{err}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-[11px] text-neutral-500">
          Tip: On macOS laptops, enable standard F-keys or press Fn+F1 if F1
          controls brightness.
        </span>
        <button
          type="button"
          onClick={resetHotkeys}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-[12px] text-neutral-700 transition hover:bg-neutral-50"
        >
          <RotateCcw className="h-3 w-3" />
          <span>Defaults</span>
        </button>
      </div>
    </div>
  );
}
