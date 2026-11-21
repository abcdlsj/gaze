import { useState } from "react";
import { Link2, Unlink2, X } from "lucide-react";

interface Props {
  widthPx: number;
  heightPx: number;
  scaleFactor: number;
  onApply: (newWidthPx: number, newHeightPx: number) => void;
  onClose: () => void;
}

export function ResizeModal({
  widthPx,
  heightPx,
  scaleFactor,
  onApply,
  onClose,
}: Props) {
  const initW = Math.round(widthPx / scaleFactor);
  const initH = Math.round(heightPx / scaleFactor);
  const [w, setW] = useState(String(initW));
  const [h, setH] = useState(String(initH));
  const [lockAspect, setLockAspect] = useState(true);
  const ratio = widthPx / Math.max(1, heightPx);

  const handleW = (val: string) => {
    setW(val);
    const num = Number(val);
    if (lockAspect && Number.isFinite(num) && num > 0) {
      setH(String(Math.max(1, Math.round(num / ratio))));
    }
  };

  const handleH = (val: string) => {
    setH(val);
    const num = Number(val);
    if (lockAspect && Number.isFinite(num) && num > 0) {
      setW(String(Math.max(1, Math.round(num * ratio))));
    }
  };

  const submit = () => {
    const nw = Math.max(16, Math.min(8000, Math.round(Number(w) * scaleFactor)));
    const nh = Math.max(16, Math.min(20000, Math.round(Number(h) * scaleFactor)));
    if (Number.isFinite(nw) && Number.isFinite(nh)) {
      onApply(nw, nh);
    }
    onClose();
  };

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[1px]"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[300px] rounded-2xl border border-neutral-200 bg-white p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-neutral-800">
            Resize Image (pt)
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11px] text-neutral-500">Width</span>
            <input
              type="number"
              min={16}
              value={w}
              onChange={(e) => handleW(e.target.value)}
              className="h-8 rounded-lg border border-neutral-300 px-2.5 text-[13px] tabular-nums outline-none focus:border-[#0A84FF]"
            />
          </label>

          <button
            type="button"
            onClick={() => setLockAspect((v) => !v)}
            title={lockAspect ? "Aspect ratio locked" : "Aspect ratio unlocked"}
            className={`mt-5 rounded-lg p-1.5 transition ${
              lockAspect
                ? "bg-[#0A84FF]/10 text-[#0A84FF]"
                : "text-neutral-400 hover:bg-neutral-100"
            }`}
          >
            {lockAspect ? (
              <Link2 className="h-4 w-4" />
            ) : (
              <Unlink2 className="h-4 w-4" />
            )}
          </button>

          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11px] text-neutral-500">Height</span>
            <input
              type="number"
              min={16}
              value={h}
              onChange={(e) => handleH(e.target.value)}
              className="h-8 rounded-lg border border-neutral-300 px-2.5 text-[13px] tabular-nums outline-none focus:border-[#0A84FF]"
            />
          </label>
        </div>

        <div className="mt-3 flex gap-1.5">
          {[0.5, 0.75, 1].map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => {
                setW(String(Math.max(1, Math.round(initW * pct))));
                setH(String(Math.max(1, Math.round(initH * pct))));
              }}
              className="flex-1 rounded-md border border-neutral-200 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50"
            >
              {Math.round(pct * 100)}%
            </button>
          ))}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-lg bg-[#0A84FF] px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-blue-600"
          >
            Resize
          </button>
        </div>
      </div>
    </div>
  );
}
