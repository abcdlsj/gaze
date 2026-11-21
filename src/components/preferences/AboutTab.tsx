import { useState } from "react";
import {
  AppWindow,
  ClipboardPaste,
  Crop,
  Maximize2,
  ScrollText,
} from "lucide-react";
import { triggerCapture } from "../../lib/tauri";

export function AboutTab() {
  const [error, setError] = useState<string | null>(null);

  const runAction = async (
    mode: "area" | "window" | "scrolling" | "fullscreen" | "clipboard",
  ) => {
    setError(null);
    try {
      await triggerCapture(mode);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex flex-col items-center px-7 py-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-[14px] bg-gradient-to-b from-[#1A84FF] to-[#0C60E8] shadow-md">
        <Crop className="h-7 w-7 text-white stroke-[2.2]" />
      </div>
      <h2 className="mt-3 text-[16px] font-semibold tracking-tight text-neutral-900">
        Shotter
      </h2>
      <p className="mt-0.5 text-[12px] text-neutral-500">
        Version 0.1.0 · macOS & Windows
      </p>
      <p className="mt-2 max-w-[340px] text-[12px] leading-relaxed text-neutral-600">
        Clean, fast cross-platform screenshot, scrolling capture, and annotation
        app. Lives quietly in your menu bar / system tray.
      </p>

      <div className="mt-5 w-full rounded-xl border border-neutral-200/80 bg-white p-3.5 text-left">
        <div className="mb-2.5 text-[11.5px] font-semibold uppercase tracking-wider text-neutral-400">
          Quick Capture
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void runAction("area")}
            className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50/70 px-3 py-2 text-[12.5px] font-medium text-neutral-700 transition hover:border-[#0A84FF]/40 hover:bg-[#0A84FF]/5 hover:text-[#0A84FF]"
          >
            <Crop className="h-3.5 w-3.5" />
            <span>Capture Area</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("scrolling")}
            className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50/70 px-3 py-2 text-[12.5px] font-medium text-neutral-700 transition hover:border-[#0A84FF]/40 hover:bg-[#0A84FF]/5 hover:text-[#0A84FF]"
          >
            <ScrollText className="h-3.5 w-3.5" />
            <span>Scrolling Capture</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("window")}
            className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50/70 px-3 py-2 text-[12.5px] font-medium text-neutral-700 transition hover:border-[#0A84FF]/40 hover:bg-[#0A84FF]/5 hover:text-[#0A84FF]"
          >
            <AppWindow className="h-3.5 w-3.5" />
            <span>Capture Window</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("fullscreen")}
            className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50/70 px-3 py-2 text-[12.5px] font-medium text-neutral-700 transition hover:border-[#0A84FF]/40 hover:bg-[#0A84FF]/5 hover:text-[#0A84FF]"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span>Fullscreen</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("clipboard")}
            className="col-span-2 flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50/70 px-3 py-2 text-[12.5px] font-medium text-neutral-700 transition hover:border-[#0A84FF]/40 hover:bg-[#0A84FF]/5 hover:text-[#0A84FF]"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>Open Image from Clipboard</span>
          </button>
        </div>

        {error && (
          <div className="mt-2.5 rounded-lg bg-red-50 px-3 py-2 text-[11.5px] text-red-600">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
