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
          <h3 className="text-[13px] font-semibold text-[#141416]">
            Resize Image (pt)
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-[#63636C] hover:bg-black/[0.06] hover:text-[#141416]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* minmax(0,1fr): number inputs have a ~160px intrinsic width that would otherwise
            push the Height field out of the 300px card. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11.5px] text-[#3F3F46]">Width</span>
            <input
              type="number"
              min={16}
              value={w}
              onChange={(e) => handleW(e.target.value)}
              className="h-8 w-full min-w-0 rounded-lg border border-black/[0.16] px-2.5 text-[13px] tabular-nums text-[#141416] outline-none focus:border-[#007AFF] focus:ring-[3px] focus:ring-[#007AFF]/20"
            />
          </label>

          <button
            type="button"
            onClick={() => setLockAspect((v) => !v)}
            title={lockAspect ? "Aspect ratio locked" : "Aspect ratio unlocked"}
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
              lockAspect
                ? "bg-[#007AFF]/10 text-[#0066D6]"
                : "text-[#63636C] hover:bg-black/[0.06]"
            }`}
          >
            {lockAspect ? (
              <Link2 className="h-4 w-4" />
            ) : (
              <Unlink2 className="h-4 w-4" />
            )}
          </button>

          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11.5px] text-[#3F3F46]">Height</span>
            <input
              type="number"
              min={16}
              value={h}
              onChange={(e) => handleH(e.target.value)}
              className="h-8 w-full min-w-0 rounded-lg border border-black/[0.16] px-2.5 text-[13px] tabular-nums text-[#141416] outline-none focus:border-[#007AFF] focus:ring-[3px] focus:ring-[#007AFF]/20"
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
              className="min-w-0 flex-1 rounded-md border border-black/[0.11] py-1 text-[11.5px] text-[#2C2C30] hover:bg-black/[0.04]"
            >
              {Math.round(pct * 100)}%
            </button>
          ))}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-black/[0.12] px-3 py-1.5 text-[12px] text-[#2C2C30] hover:bg-black/[0.04]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="mac-blue-fill rounded-lg px-3.5 py-1.5 text-[12px] font-medium text-white antialiased hover:brightness-105"
          >
            Resize
          </button>
        </div>
      </div>
    </div>
  );
}
