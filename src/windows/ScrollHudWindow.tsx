import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Square } from "lucide-react";
import { stopScrollingCapture } from "../lib/tauri";
import type { ScrollProgressEvent } from "../types";

export function ScrollHudWindow() {
  const [progress, setProgress] = useState<ScrollProgressEvent>({
    frames: 1,
    height: 0,
    max_height: 20000,
    status: "capturing",
  });

  useEffect(() => {
    const unlistenPromise = listen<ScrollProgressEvent>(
      "scroll-progress",
      (event) => {
        setProgress(event.payload);
      },
    );

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void stopScrollingCapture();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      void unlistenPromise.then((u) => u());
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const pct =
    progress.max_height > 0
      ? Math.min(100, Math.round((progress.height / progress.max_height) * 100))
      : 0;

  return (
    <div
      data-tauri-drag-region
      className="flex h-full w-full items-center justify-between gap-3 rounded-2xl border border-black/[0.08] bg-white/94 px-4 shadow-[0_12px_32px_rgba(0,0,0,0.16)] backdrop-blur-xl"
    >
      <div className="pointer-events-none flex items-center gap-2.5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#007AFF] opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#007AFF]" />
        </span>
        <div className="flex flex-col">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[#1D1D1F]">
            <span>Scrolling capture…</span>
            <span className="tabular-nums text-[#86868B]">
              {progress.height.toLocaleString()} px
            </span>
          </div>
          <div className="mt-1 h-[3.5px] w-40 overflow-hidden rounded-full bg-black/[0.08]">
            <div
              className="h-full rounded-full bg-[#007AFF] transition-all duration-150"
              style={{ width: `${Math.max(6, pct)}%` }}
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void stopScrollingCapture()}
        className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[#FF3B30] px-3 py-1.5 text-[12px] font-medium text-white shadow-xs transition hover:brightness-105 active:scale-[0.97]"
      >
        <Square className="h-2.5 w-2.5 fill-current" />
        <span>Stop</span>
      </button>
    </div>
  );
}
