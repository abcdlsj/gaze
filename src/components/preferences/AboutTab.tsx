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
    <div className="flex flex-col items-center px-5 py-4 text-center">
      {/* Gaze matte obsidian & warm porcelain icon */}
      <svg
        viewBox="0 0 1024 1024"
        className="h-14 w-14 drop-shadow-[0_5px_14px_rgba(0,0,0,0.22)]"
      >
        <defs>
          <radialGradient id="about-plate" cx="0.35" cy="0.2" r="0.9">
            <stop offset="0%" stopColor="#1E1E21" />
            <stop offset="55%" stopColor="#141416" />
            <stop offset="100%" stopColor="#0E0E10" />
          </radialGradient>
          <linearGradient id="about-tl" x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#D4D0C7" />
          </linearGradient>
          <linearGradient id="about-br" x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0%" stopColor="#F3F1EB" />
            <stop offset="100%" stopColor="#9A968C" />
          </linearGradient>
          <linearGradient id="about-dot" x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#ECE9E0" />
          </linearGradient>
        </defs>
        <rect x="100" y="100" width="824" height="824" rx="190" fill="url(#about-plate)" />
        <g transform="translate(512 512) rotate(-8)">
          <path
            d="M -192 -232 L 24 -232 Q 58 -232 58 -198 L 58 -178 Q 58 -144 24 -144 L -126 -144 Q -144 -144 -144 -126 L -144 24 Q -144 58 -178 58 L -198 58 Q -232 58 -232 24 L -232 -192 Q -232 -232 -192 -232 Z"
            fill="url(#about-tl)"
          />
          <path
            d="M -192 -232 L 24 -232 Q 58 -232 58 -198 L 58 -178 Q 58 -144 24 -144 L -126 -144 Q -144 -144 -144 -126 L -144 24 Q -144 58 -178 58 L -198 58 Q -232 58 -232 24 L -232 -192 Q -232 -232 -192 -232 Z"
            transform="rotate(180)"
            fill="url(#about-br)"
          />
          <circle cx="0" cy="0" r="64" fill="url(#about-dot)" />
        </g>
      </svg>
      <h2 className="font-display mt-2 text-[16px] font-semibold tracking-[-0.02em] text-[#1D1D1F]">
        Gaze
      </h2>
      <p className="mt-0.5 text-[11.5px] text-[#86868B]">
        Version 0.1.0 · macOS & Windows
      </p>
      <p className="mt-1.5 max-w-[340px] text-[11.5px] leading-snug text-[#6E6E73]">
        Clean, fast cross-platform screenshot, scrolling capture, and annotation
        app. Lives quietly in your menu bar / system tray.
      </p>

      <div className="mt-3.5 w-full rounded-lg border border-black/[0.08] bg-[#FAFAFC] p-3 text-left">
        <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-[#86868B]">
          Quick Capture
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => void runAction("area")}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-black/[0.07] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <Crop className="h-3.5 w-3.5" />
            <span>Capture Area</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("scrolling")}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-black/[0.07] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <ScrollText className="h-3.5 w-3.5" />
            <span>Scrolling Capture</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("window")}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-black/[0.07] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <AppWindow className="h-3.5 w-3.5" />
            <span>Capture Window</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("fullscreen")}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-black/[0.07] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span>Fullscreen</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("clipboard")}
            className="col-span-2 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-black/[0.07] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>Open Image from Clipboard</span>
          </button>
        </div>

        {error && (
          <div className="mt-2 rounded-md bg-[#FF3B30]/[0.08] px-2.5 py-1.5 text-[11px] text-[#FF3B30]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
