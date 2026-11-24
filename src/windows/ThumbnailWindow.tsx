import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Copy, Pin, Save, SquarePen, X } from "lucide-react";
import { Tooltip } from "../components/ui/Tooltip";
import { isMacPlatform } from "../lib/hotkeys";
import {
  copyCaptureById,
  getCaptureImageBytes,
  getCaptureMeta,
  getSettings,
  openEditorForCapture,
  pinImageBytes,
  revealWindow,
  saveCaptureById,
} from "../lib/tauri";
import type { CaptureMeta } from "../types";

export function ThumbnailWindow({ captureId }: { captureId: string }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [pngBytes, setPngBytes] = useState<Uint8Array | null>(null);
  const [meta, setMeta] = useState<CaptureMeta | null>(null);
  const [hovered, setHovered] = useState(false);
  const [status, setStatus] = useState<"copied" | "saved" | null>(null);
  const revealedRef = useRef(false);
  const modKey = isMacPlatform() ? "⌘" : "Ctrl+";

  const triggerReveal = () => {
    if (revealedRef.current) return;
    revealedRef.current = true;
    setTimeout(() => {
      void revealWindow(false);
    }, 16);
  };

  useEffect(() => {
    let active = true;
    let url: string | null = null;

    void (async () => {
      try {
        const [m, bytes] = await Promise.all([
          getCaptureMeta(captureId),
          getCaptureImageBytes(captureId),
        ]);
        if (!active) return;
        setMeta(m);
        setPngBytes(bytes);
        url = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }),
        );
        setImgUrl(url);
      } catch {
        void getCurrentWindow().close();
      }
    })();

    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [captureId]);

  // Respect Hide preview thumbnail auto-hide setting (paused while hovered)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      const settings = await getSettings();
      const ms =
        settings.hide_preview_thumbnail === "after5s"
          ? 5000
          : settings.hide_preview_thumbnail === "after10s"
            ? 10000
            : settings.hide_preview_thumbnail === "after30s"
              ? 30000
              : 0;
      if (ms > 0 && !hovered) {
        timer = setTimeout(() => {
          void getCurrentWindow().close();
        }, ms);
      }
    })();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [hovered]);

  const closeWin = () => void getCurrentWindow().close();

  const handleCopy = async () => {
    await copyCaptureById(captureId);
    setStatus("copied");
    setTimeout(() => setStatus(null), 1000);
  };

  const handleSave = async () => {
    await saveCaptureById(captureId);
    setStatus("saved");
    setTimeout(() => setStatus(null), 1000);
  };

  const handlePin = async () => {
    if (!pngBytes || !meta) return;
    await pinImageBytes(pngBytes, meta.scale_factor);
    closeWin();
  };

  const handleEdit = async () => {
    await openEditorForCapture(captureId);
    closeWin();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void getCurrentWindow().close();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        void openEditorForCapture(captureId).then(() =>
          getCurrentWindow().close(),
        );
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "c") {
        e.preventDefault();
        void copyCaptureById(captureId).then(() => {
          setStatus("copied");
          setTimeout(() => setStatus(null), 1000);
        });
        return;
      }
      if (mod && k === "s") {
        e.preventDefault();
        void saveCaptureById(captureId).then(() => {
          setStatus("saved");
          setTimeout(() => setStatus(null), 1000);
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [captureId]);

  const widthPt = meta ? Math.round(meta.width / meta.scale_factor) : null;
  const heightPt = meta ? Math.round(meta.height / meta.scale_factor) : null;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group flex h-full w-full flex-col overflow-hidden rounded-[13px] bg-white ring-1 ring-inset ring-black/[0.1]"
    >
      {/* Preview area */}
      <div
        onClick={() => void handleEdit()}
        className="checkerboard-sm relative flex flex-1 cursor-pointer items-center justify-center overflow-hidden p-2.5"
      >
        {imgUrl && (
          <img
            src={imgUrl}
            alt="Preview"
            onLoad={triggerReveal}
            onError={triggerReveal}
            className="max-h-full max-w-full rounded-[6px] object-contain shadow-[0_2px_10px_rgba(0,0,0,0.1)] ring-1 ring-black/[0.06] transition-transform duration-150 group-hover:scale-[1.01]"
          />
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            closeWin();
          }}
          aria-label="Close preview"
          className="absolute left-2 top-2 flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-full bg-[#18181B]/72 text-white/90 antialiased shadow-xs ring-1 ring-white/15 backdrop-blur-md transition duration-150 hover:bg-[#18181B]/92 hover:text-white active:scale-95"
        >
          <X className="h-3 w-3 stroke-[2.2]" />
        </button>

        {status && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/22 backdrop-blur-[1px]">
            <span className="animate-pop-in flex items-center gap-1.5 rounded-full bg-[#18181B]/90 px-3 py-1 text-[11.5px] font-medium tracking-[-0.01em] text-white antialiased shadow-lg ring-1 ring-white/15 backdrop-blur-md">
              <Check className="h-3.5 w-3.5 stroke-[2.2] text-emerald-400" />
              {status === "copied" ? "Copied" : "Saved"}
            </span>
          </div>
        )}
      </div>

      {/* Refined bottom quick action bar */}
      <div className="flex h-[38px] shrink-0 items-center justify-between border-t border-black/[0.07] bg-white/96 px-2.5">
        <span className="font-mono text-[11px] font-medium tabular-nums tracking-[-0.01em] text-[#3F3F46]">
          {widthPt !== null && heightPt !== null ? (
            <>
              {widthPt}×{heightPt}
              <span className="ml-0.5 font-sans font-normal text-[#71717A]">
                pt
              </span>
            </>
          ) : (
            ""
          )}
        </span>

        <div className="flex items-center gap-0.5">
          <Tooltip label="Edit" side="top">
            <button
              type="button"
              onClick={() => void handleEdit()}
              className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[7px] text-[#3F3F46] transition-all duration-100 hover:bg-[#007AFF]/[0.1] hover:text-[#0066D6] active:scale-[0.94]"
            >
              <SquarePen className="h-[14px] w-[14px] stroke-[1.8]" />
            </button>
          </Tooltip>
          <Tooltip label="Copy" shortcut={`${modKey}C`} side="top">
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[7px] text-[#3F3F46] transition-all duration-100 hover:bg-black/[0.06] hover:text-[#141416] active:scale-[0.94]"
            >
              {status === "copied" ? (
                <Check className="h-[14px] w-[14px] stroke-[2] text-emerald-600" />
              ) : (
                <Copy className="h-[14px] w-[14px] stroke-[1.8]" />
              )}
            </button>
          </Tooltip>
          <Tooltip label="Save" shortcut={`${modKey}S`} side="top">
            <button
              type="button"
              onClick={() => void handleSave()}
              className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[7px] text-[#3F3F46] transition-all duration-100 hover:bg-black/[0.06] hover:text-[#141416] active:scale-[0.94]"
            >
              {status === "saved" ? (
                <Check className="h-[14px] w-[14px] stroke-[2] text-emerald-600" />
              ) : (
                <Save className="h-[14px] w-[14px] stroke-[1.8]" />
              )}
            </button>
          </Tooltip>
          <Tooltip label="Pin on Screen" side="top" align="right">
            <button
              type="button"
              onClick={() => void handlePin()}
              className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[7px] text-[#3F3F46] transition-all duration-100 hover:bg-black/[0.06] hover:text-[#141416] active:scale-[0.94]"
            >
              <Pin className="h-[14px] w-[14px] stroke-[1.8]" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
