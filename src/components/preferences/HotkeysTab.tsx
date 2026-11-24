import { useEffect, useState } from "react";
import { AlertCircle, RotateCcw, X } from "lucide-react";
import {
  formatShortcutDisplay,
  keyboardEventToShortcut,
} from "../../lib/hotkeys";
import { setHotkeysSuspended } from "../../lib/tauri";
import type { AppSettings, HotkeyConfig } from "../../types";

interface Props {
  settings: AppSettings;
  hotkeyErrors: Record<string, string | null>;
  onChange: (patch: Partial<AppSettings>) => void;
  onHotkeyErrors?: (errors: Record<string, string | null>) => void;
}

const ROWS: {
  key: keyof HotkeyConfig;
  label: string;
  hint: string;
}[] = [
  {
    key: "capture_area",
    label: "Area",
    hint: "Capture selected region",
  },
  {
    key: "capture_scrolling",
    label: "Scrolling",
    hint: "Auto-scroll long capture",
  },
  {
    key: "capture_fullscreen",
    label: "Fullscreen",
    hint: "Capture active display",
  },
  {
    key: "capture_window",
    label: "Window",
    hint: "Capture clicked window",
  },
  {
    key: "open_clipboard",
    label: "Clipboard",
    hint: "Open image in Editor",
  },
];

export function HotkeysTab({
  settings,
  hotkeyErrors,
  onChange,
  onHotkeyErrors,
}: Props) {
  const [recordingKey, setRecordingKey] = useState<keyof HotkeyConfig | null>(
    null,
  );

  // Suspend OS global shortcuts while recording so existing bindings (e.g. F1) can be captured cleanly.
  useEffect(() => {
    if (!recordingKey) return;
    void setHotkeysSuspended(true);
    return () => {
      void setHotkeysSuspended(false).then((errs) => {
        onHotkeyErrors?.(errs);
      });
    };
  }, [recordingKey, onHotkeyErrors]);

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
    <div className="flex flex-col px-5 py-3.5">
      <div className="mb-2.5">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-[#141416]">
          Shortcuts
        </h3>
        <p className="mt-0.5 text-[11.5px] text-[#52525B]">
          Click to record. Esc cancels.
        </p>
      </div>

      <div className="divide-y divide-black/[0.07] overflow-hidden rounded-lg border border-black/[0.09] bg-[#FAFAFC]">
        {ROWS.map((row) => {
          const rawValue = settings.hotkeys[row.key];
          const display = formatShortcutDisplay(rawValue);
          const isRecording = recordingKey === row.key;
          const err = hotkeyErrors[row.key];

          return (
            <div key={row.key} className="flex flex-col gap-0.5 px-3.5 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium leading-tight text-[#141416]">
                    {row.label}
                  </div>
                  <div className="text-[11.5px] leading-snug text-[#52525B]">
                    {row.hint}
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setRecordingKey(isRecording ? null : row.key)
                    }
                    className={`flex h-[26px] min-w-[116px] cursor-pointer items-center justify-center rounded-[6px] px-2.5 text-[12px] font-medium transition-all ${
                      isRecording
                        ? "border border-[#007AFF] bg-[#007AFF]/[0.08] text-[#0066D6] ring-[3px] ring-[#007AFF]/20"
                        : display
                          ? "border border-black/[0.12] bg-white font-mono text-[#141416] shadow-[0_1px_1.5px_rgba(0,0,0,0.05)] hover:border-black/[0.24]"
                          : "border border-dashed border-black/[0.2] bg-white/75 font-normal text-[#63636C] hover:border-black/[0.34] hover:text-[#2C2C30]"
                    }`}
                  >
                    {isRecording ? (
                      <span className="animate-pulse">Press keys…</span>
                    ) : display ? (
                      <span className="tracking-wider">{display}</span>
                    ) : (
                      <span>Record</span>
                    )}
                  </button>

                  {rawValue && !isRecording && (
                    <button
                      type="button"
                      onClick={() => clearHotkey(row.key)}
                      title="Clear shortcut"
                      className="flex h-[24px] w-[24px] cursor-pointer items-center justify-center rounded-md text-[#63636C] transition hover:bg-black/[0.06] hover:text-[#141416]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {err && (
                <div className="mt-0.5 flex items-center gap-1 text-[11.5px] font-medium text-[#D70015]">
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  <span className="truncate">{err}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[11.5px] leading-snug text-[#52525B]">
          MacBook: use Fn+F1 or enable standard F-keys.
        </span>
        <button
          type="button"
          onClick={resetHotkeys}
          className="mac-btn inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-[#141416] transition"
        >
          <RotateCcw className="h-3 w-3" />
          <span>Defaults</span>
        </button>
      </div>
    </div>
  );
}
