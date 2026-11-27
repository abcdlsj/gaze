/**
 * Custom screenshot-tool SVG icons authored on the exact same 24×24 grid and
 * stroke-cap/join geometry as Lucide icons, so callers can pass a single shared
 * icon class (`h-[16px] w-[16px] stroke-[1.75]` or `h-[17px] w-[17px] stroke-[1.75]`)
 * and get uniform optical weight across every tool button.
 */

export function BackdropFrameIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <rect
        x="6.5"
        y="7.5"
        width="11"
        height="9"
        rx="1.2"
        fill="currentColor"
        fillOpacity={0.14}
      />
    </svg>
  );
}

export function MosaicBlurIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Outer 18×18 rx=2 frame matches Lucide Square optically */}
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect
        x="6.25"
        y="6.25"
        width="3.2"
        height="3.2"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      />
      <rect
        x="14.55"
        y="6.25"
        width="3.2"
        height="3.2"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      />
      <rect
        x="10.4"
        y="10.4"
        width="3.2"
        height="3.2"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      />
      <rect
        x="6.25"
        y="14.55"
        width="3.2"
        height="3.2"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      />
      <rect
        x="14.55"
        y="14.55"
        width="3.2"
        height="3.2"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export function StepCounterIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9.5" />
      <path d="M10.4 9.2 12.2 8v8M10.4 16h3.5" />
    </svg>
  );
}

export function ScrollCaptureIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3.5 9h7M3.5 12h7M3.5 15h7" />
      <path d="M17.5 4.5v15M14.5 7.5 17.5 4.5l3 3M14.5 16.5l3 3 3-3" />
    </svg>
  );
}
