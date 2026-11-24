import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  AppWindow,
  ClipboardPaste,
  Crop,
  ExternalLink,
  Maximize2,
  ScrollText,
} from "lucide-react";
import { openExternalUrl, triggerCapture } from "../../lib/tauri";

const GITHUB_URL = "https://github.com/abcdlsj/gaze";

export function AboutTab() {
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("0.2.0");

  // Read the version from tauri.conf.json at runtime so a release bump never
  // leaves a stale string in the About tab.
  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

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
      <h2 className="font-display mt-2 text-[16px] font-semibold tracking-[-0.02em] text-[#141416]">
        Gaze
      </h2>
      <p className="mt-0.5 text-[11.5px] text-[#52525B]">
        Version {version} · macOS & Windows
      </p>
      <p className="mt-1.5 max-w-[340px] text-[12px] leading-snug text-[#3F3F46]">
        Fast screenshot, scrolling & annotation.
      </p>
      <button
        type="button"
        onClick={() => void openExternalUrl(GITHUB_URL)}
        className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-black/[0.1] bg-[#F4F4F6] px-2.5 py-1 text-[11.5px] font-medium text-[#141416] transition hover:border-[#007AFF]/45 hover:bg-[#007AFF]/[0.06] hover:text-[#0066D6]"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
        <span>github.com/abcdlsj/gaze</span>
        <ExternalLink className="h-2.5 w-2.5 opacity-70" />
      </button>

      <div className="mt-3.5 w-full rounded-lg border border-black/[0.09] bg-[#FAFAFC] p-3 text-left">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#52525B]">
          Quick Capture
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => void runAction("area")}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-black/[0.09] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#141416] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/45 hover:text-[#0066D6]"
          >
            <Crop className="h-3.5 w-3.5" />
            <span>Area</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("scrolling")}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-black/[0.09] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#141416] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/45 hover:text-[#0066D6]"
          >
            <ScrollText className="h-3.5 w-3.5" />
            <span>Scrolling</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("window")}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-black/[0.09] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#141416] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/45 hover:text-[#0066D6]"
          >
            <AppWindow className="h-3.5 w-3.5" />
            <span>Window</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("fullscreen")}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-black/[0.09] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#141416] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/45 hover:text-[#0066D6]"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span>Fullscreen</span>
          </button>
          <button
            type="button"
            onClick={() => void runAction("clipboard")}
            className="col-span-2 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-black/[0.09] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#141416] shadow-[0_0.5px_1px_rgba(0,0,0,0.04)] transition hover:border-[#007AFF]/45 hover:text-[#0066D6]"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>From Clipboard</span>
          </button>
        </div>

        {error && (
          <div className="mt-2 rounded-md bg-[#FF3B30]/[0.08] px-2.5 py-1.5 text-[11.5px] font-medium text-[#D70015]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
