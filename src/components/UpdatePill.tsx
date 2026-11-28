import type { UpdateStatus } from "../types";

interface UpdatePillProps {
  status: UpdateStatus;
  onActivate: () => void;
  compact?: boolean;
}

/**
 * Ultra-minimal, zero-interruption update pill.
 * Completely hidden when idle or checking; shows compact progress while
 * downloading, a calm restart cue if deferred, or one-click trigger when ready.
 */
export function UpdatePill({ status, onActivate, compact = false }: UpdatePillProps) {
  const visible =
    status.available ||
    status.state === "downloading" ||
    status.state === "verifying" ||
    status.state === "ready_to_restart" ||
    status.state === "flushing" ||
    status.state === "installing";

  if (!visible) return null;

  const busy =
    status.state === "downloading" ||
    status.state === "verifying" ||
    status.state === "flushing" ||
    status.state === "installing";

  const versionLabel = status.latest ?? "";
  let label: string;
  let title: string;

  switch (status.state) {
    case "downloading": {
      const pct = Math.max(0, Math.min(99, status.progress || 0));
      label = `↓ ${pct}%`;
      title = `Downloading v${versionLabel} (${pct}%)`;
      break;
    }
    case "verifying":
      label = "↓ 99%";
      title = `Verifying signature for v${versionLabel}…`;
      break;
    case "ready_to_restart":
      label = `↻ ${versionLabel}`;
      title = `v${versionLabel} ready — click to save & restart cleanly`;
      break;
    case "flushing":
    case "installing":
      label = "↻ …";
      title = `Saving state & restarting into v${versionLabel}…`;
      break;
    case "error":
      label = `↑ ${versionLabel} !`;
      title = status.error
        ? `Update failed: ${status.error} — click to retry`
        : "Update failed — click to retry";
      break;
    default:
      label = `↑ ${versionLabel}`;
      title = status.can_apply
        ? `Update to v${versionLabel} — click to download & restart`
        : `v${versionLabel} available — click to open GitHub release`;
      break;
  }

  return (
    <button
      type="button"
      className={[
        "update-pill",
        "tabular-nums",
        compact ? "update-pill--compact" : "",
        busy ? "update-pill--busy" : "",
        status.state === "ready_to_restart" ? "update-pill--ready" : "",
        status.state === "error" ? "update-pill--error" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={title}
      title={title}
      onClick={onActivate}
    >
      {label}
    </button>
  );
}
