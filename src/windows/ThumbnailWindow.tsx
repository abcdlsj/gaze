import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Copy, Pencil, Pin, Save, X } from "lucide-react";
import {
  copyCaptureById,
  getCaptureImageBytes,
  getCaptureMeta,
  getSettings,
  openEditorForCapture,
  pinImageBytes,
  saveCaptureById,
} from "../lib/tauri";
import type { CaptureMeta } from "../types";

export function ThumbnailWindow({ captureId }: { captureId: string }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [pngBytes, setPngBytes] = useState<Uint8Array | null>(null);
  const [meta, setMeta] = useState<CaptureMeta | null>(null);
  const [hovered, setHovered] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

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
    setStatus("Copied");
    setTimeout(() => setStatus(null), 900);
  };

  const handleSave = async () => {
    await saveCaptureById(captureId);
    setStatus("Saved");
    setTimeout(() => setStatus(null), 900);
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

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-neutral-200/90 bg-white shadow-xl"
    >
      {/* Preview area */}
      <div
        onClick={() => void handleEdit()}
        className="checkerboard-sm relative flex flex-1 cursor-pointer items-center justify-center overflow-hidden p-2"
      >
        {imgUrl && (
          <img
            src={imgUrl}
            alt="Preview"
            className="max-h-full max-w-full rounded object-contain shadow-xs"
          />
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            closeWin();
          }}
          className="absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900/70 text-white transition hover:bg-neutral-900"
        >
          <X className="h-3 w-3" />
        </button>

        {status && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35">
            <span className="flex items-center gap-1 rounded-full bg-white px-3 py-1 text-[11.5px] font-medium text-neutral-900 shadow">
              <Check className="h-3.5 w-3.5 text-emerald-600" />
              {status}
            </span>
          </div>
        )}
      </div>

      {/* Bottom quick action bar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-t border-neutral-200/80 bg-[#FAFAFB] px-2">
        <span className="text-[11px] tabular-nums text-neutral-500">
          {meta
            ? `${Math.round(meta.width / meta.scale_factor)}×${Math.round(meta.height / meta.scale_factor)}pt`
            : ""}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void handleEdit()}
            title="Open Editor"
            className="rounded-md p-1.5 text-neutral-600 transition hover:bg-neutral-200/70 hover:text-neutral-900"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            title="Copy"
            className="rounded-md p-1.5 text-neutral-600 transition hover:bg-neutral-200/70 hover:text-neutral-900"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            title="Save"
            className="rounded-md p-1.5 text-neutral-600 transition hover:bg-neutral-200/70 hover:text-neutral-900"
          >
            <Save className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handlePin()}
            title="Pin on screen"
            className="rounded-md p-1.5 text-neutral-600 transition hover:bg-neutral-200/70 hover:text-neutral-900"
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
