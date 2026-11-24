import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Check, Copy, SquarePen, X } from "lucide-react";
import { Tooltip } from "../components/ui/Tooltip";
import { isMacPlatform } from "../lib/hotkeys";
import {
  copyCaptureById,
  getCaptureImageBytes,
  getCaptureMeta,
  openEditorForCapture,
  revealWindow,
} from "../lib/tauri";
import type { CaptureMeta } from "../types";

export function PinWindow({ captureId }: { captureId: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<CaptureMeta | null>(null);
  const [opacity, setOpacity] = useState(1);
  const scaleRef = useRef(1);
  const [copied, setCopied] = useState(false);
  const revealedRef = useRef(false);
  const modKey = isMacPlatform() ? "⌘" : "Ctrl+";

  const triggerReveal = () => {
    if (revealedRef.current) return;
    revealedRef.current = true;
    setTimeout(() => {
      void revealWindow(true);
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
        url = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }),
        );
        setImgUrl(url);
      } catch {
        void getCurrentWindow().close();
      }
    })();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void getCurrentWindow().close();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void copyCaptureById(captureId).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 900);
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [captureId]);

  // Native non-passive wheel listener so WKWebView honors preventDefault() while resizing/fading pin
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.altKey) {
        setOpacity((o) =>
          Math.max(0.25, Math.min(1, Number((o - e.deltaY * 0.002).toFixed(2)))),
        );
        return;
      }
      if (!meta) return;
      const nextScale = Math.max(
        0.35,
        Math.min(3.0, scaleRef.current * (e.deltaY < 0 ? 1.08 : 0.92)),
      );
      scaleRef.current = nextScale;
      const baseW = meta.width / meta.scale_factor;
      const baseH = meta.height / meta.scale_factor;
      void getCurrentWindow().setSize(
        new LogicalSize(
          Math.max(80, Math.round(baseW * nextScale)),
          Math.max(60, Math.round(baseH * nextScale)),
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [meta]);

  return (
    <div
      ref={rootRef}
      data-tauri-drag-region
      style={{ opacity }}
      className="group relative flex h-full w-full cursor-move items-center justify-center overflow-hidden bg-transparent"
    >
      {imgUrl && (
        <img
          src={imgUrl}
          alt="Pinned screenshot"
          draggable={false}
          data-tauri-drag-region
          onLoad={triggerReveal}
          onError={triggerReveal}
          className="h-full w-full select-none object-contain"
        />
      )}

      {/* Subtle hover controls */}
      <div className="pointer-events-auto absolute right-2 top-2 flex items-center gap-0.5 rounded-[9px] bg-[#18181B]/82 p-1 text-white antialiased opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.14] backdrop-blur-xl transition-opacity duration-150 group-hover:opacity-100">
        <Tooltip label="Copy" shortcut={`${modKey}C`} side="bottom">
          <button
            type="button"
            onClick={() =>
              void copyCaptureById(captureId).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 900);
              })
            }
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[6px] transition hover:bg-white/15"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 stroke-[2] text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5 stroke-[1.8]" />
            )}
          </button>
        </Tooltip>
        <Tooltip label="Edit" side="bottom">
          <button
            type="button"
            onClick={() => void openEditorForCapture(captureId)}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[6px] transition hover:bg-white/15"
          >
            <SquarePen className="h-3.5 w-3.5 stroke-[1.8]" />
          </button>
        </Tooltip>
        <Tooltip label="Close" shortcut="Esc" side="bottom" align="right">
          <button
            type="button"
            onClick={() => void getCurrentWindow().close()}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[6px] transition hover:bg-red-500/80"
          >
            <X className="h-3.5 w-3.5 stroke-[2]" />
          </button>
        </Tooltip>
      </div>

      {/* Subtle border highlight on hover */}
      <div className="pointer-events-none absolute inset-0 border border-black/15 group-hover:border-[#0A84FF]/80" />
    </div>
  );
}
