import { useEffect, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Check, Copy, Pencil, X } from "lucide-react";
import {
  copyCaptureById,
  getCaptureImageBytes,
  getCaptureMeta,
  openEditorForCapture,
} from "../lib/tauri";
import type { CaptureMeta } from "../types";

export function PinWindow({ captureId }: { captureId: string }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<CaptureMeta | null>(null);
  const [opacity, setOpacity] = useState(1);
  const [scale, setScale] = useState(1);
  const [copied, setCopied] = useState(false);

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

  const handleWheel = (e: React.WheelEvent) => {
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
      Math.min(3.0, scale * (e.deltaY < 0 ? 1.08 : 0.92)),
    );
    setScale(nextScale);
    const baseW = meta.width / meta.scale_factor;
    const baseH = meta.height / meta.scale_factor;
    void getCurrentWindow().setSize(
      new LogicalSize(
        Math.max(80, Math.round(baseW * nextScale)),
        Math.max(60, Math.round(baseH * nextScale)),
      ),
    );
  };

  return (
    <div
      data-tauri-drag-region
      onWheel={handleWheel}
      style={{ opacity }}
      className="group relative flex h-full w-full cursor-move items-center justify-center overflow-hidden bg-transparent"
    >
      {imgUrl && (
        <img
          src={imgUrl}
          alt="Pinned screenshot"
          draggable={false}
          data-tauri-drag-region
          className="h-full w-full select-none object-contain"
        />
      )}

      {/* Subtle hover controls */}
      <div className="pointer-events-auto absolute right-2 top-2 flex items-center gap-1 rounded-lg bg-neutral-900/75 p-1 text-white opacity-0 shadow-lg backdrop-blur-md transition group-hover:opacity-100">
        <button
          type="button"
          onClick={() =>
            void copyCaptureById(captureId).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 900);
            })
          }
          title="Copy (⌘C)"
          className="rounded p-1 transition hover:bg-white/15"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={() => void openEditorForCapture(captureId)}
          title="Open in Editor"
          className="rounded p-1 transition hover:bg-white/15"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void getCurrentWindow().close()}
          title="Close (Esc)"
          className="rounded p-1 transition hover:bg-red-500/80"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Subtle border highlight on hover */}
      <div className="pointer-events-none absolute inset-0 border border-black/15 group-hover:border-[#0A84FF]/80" />
    </div>
  );
}
