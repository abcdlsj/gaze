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
    <div className="flex flex-col items-center px-8 py-6 text-center">
      {/* Brand-new Shotter sculptural Swiss Cobalt icon */}
      <svg
        viewBox="0 0 1024 1024"
        className="h-16 w-16 drop-shadow-[0_6px_16px_rgba(11,25,49,0.28)]"
      >
        <defs>
          <radialGradient id="about-plate" cx="0.32" cy="0.22" r="0.88">
            <stop offset="0%" stopColor="#1E3F73" />
            <stop offset="56%" stopColor="#132A4F" />
            <stop offset="100%" stopColor="#0B1931" />
          </radialGradient>
          <linearGradient id="about-tl" x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#D7E0EE" />
          </linearGradient>
          <linearGradient id="about-br" x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor="#F1F5FA" />
            <stop offset="100%" stopColor="#9BAEC9" />
          </linearGradient>
          <linearGradient id="about-dot" x1="0.15" y1="0.05" x2="0.85" y2="0.95">
            <stop offset="0%" stopColor="#93E0FF" />
            <stop offset="100%" stopColor="#38BDF8" />
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
      <h2 className="font-display mt-2.5 text-[17px] font-semibold tracking-[-0.02em] text-[#1D1D1F]">
        Shotter
      </h2>
      <p className="mt-0.5 text-[12px] text-[#86868B]">
        Version 0.1.0 · macOS & Windows
      </p>
      <p className="mt-2 max-w-[340px] text-[12px] leading-relaxed text-[#6E6E73]">
        Clean, fast cross-platform screenshot, scrolling capture, and annotation
        app. Lives quietly in your menu bar / system tray.
      </p>

      <div className="mt-5 w-full rounded-xl border border-black/[0.08] bg-[#FAFAFC] p-3.5 text-left">
        <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-[#86868B]">
          Quick Capture
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void runAction("area")}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-black/[0.07] bg-white px-3 py-2 text-[12.5px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <Crop className="h-3.5 w-3.5" />
            <span>Capture Area</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("scrolling")}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-black/[0.07] bg-white px-3 py-2 text-[12.5px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <ScrollText className="h-3.5 w-3.5" />
            <span>Scrolling Capture</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("window")}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-black/[0.07] bg-white px-3 py-2 text-[12.5px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <AppWindow className="h-3.5 w-3.5" />
            <span>Capture Window</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("fullscreen")}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-black/[0.07] bg-white px-3 py-2 text-[12.5px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span>Fullscreen</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("clipboard")}
            className="col-span-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-black/[0.07] bg-white px-3 py-2 text-[12.5px] font-medium text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/40 hover:text-[#007AFF]"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>Open Image from Clipboard</span>
          </button>
        </div>

        {error && (
          <div className="mt-2.5 rounded-lg bg-[#FF3B30]/[0.08] px-3 py-2 text-[11.5px] text-[#FF3B30]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
