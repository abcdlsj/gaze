import { type ReactNode, useEffect, useRef, useState } from "react";

interface TooltipProps {
  label: string;
  shortcut?: string;
  side?: "top" | "bottom";
  align?: "center" | "left" | "right";
  delay?: number;
  disabled?: boolean;
  children: ReactNode;
}

export function Tooltip({
  label,
  shortcut,
  side = "bottom",
  align = "center",
  delay = 110,
  disabled = false,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (disabled) {
      clearTimer();
      setOpen(false);
    }
    return clearTimer;
  }, [disabled]);

  const handleEnter = () => {
    if (disabled) return;
    clearTimer();
    timerRef.current = setTimeout(() => setOpen(true), delay);
  };

  const handleLeave = () => {
    clearTimer();
    setOpen(false);
  };

  const sideClass = side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5";
  const alignClass =
    align === "left"
      ? "left-0"
      : align === "right"
        ? "right-0"
        : "left-1/2 -translate-x-1/2";

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onMouseDown={handleLeave}
    >
      {children}
      {open && !disabled && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute z-50 whitespace-nowrap ${sideClass} ${alignClass}`}
        >
          <span className="animate-tooltip-in inline-flex items-center gap-1.5 rounded-[7px] bg-[#18181B]/94 px-2 py-[5px] text-[11.5px] font-medium leading-none tracking-[-0.008em] text-white/95 antialiased shadow-[0_8px_24px_-4px_rgba(0,0,0,0.34),0_2px_6px_rgba(0,0,0,0.16)] ring-1 ring-white/[0.13] backdrop-blur-xl">
            <span>{label}</span>
            {shortcut && (
              <kbd className="rounded-[4px] bg-white/[0.15] px-1.5 py-[2px] font-mono text-[10px] font-medium leading-none text-white/85">
                {shortcut}
              </kbd>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
