import { useEffect, useState } from "react";
import {
  CheckCircle2,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";
import {
  checkPermissions,
  openPermissionSettings,
  openScreenshotsFolder,
  requestScreenPermission,
} from "../../lib/tauri";
import type { PermissionStatus } from "../../types";

interface Props {
  onResetDefaults: () => Promise<void>;
}

export function AdvancedTab({ onResetDefaults }: Props) {
  const [perms, setPerms] = useState<PermissionStatus | null>(null);
  const [resetDone, setResetDone] = useState(false);

  const loadPerms = async () => {
    try {
      const p = await checkPermissions();
      setPerms(p);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadPerms();
  }, []);

  const handleReset = async () => {
    await onResetDefaults();
    setResetDone(true);
    setTimeout(() => setResetDone(false), 2000);
  };

  return (
    <div className="flex flex-col gap-5 px-7 py-5">
      {perms?.platform === "macos" && (
        <div className="rounded-xl border border-neutral-200/80 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-[13px] font-semibold text-neutral-800">
                macOS Permissions
              </h3>
              <p className="text-[11px] text-neutral-500">
                Required for screen capture and automatic scrolling screenshots.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadPerms()}
              className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 transition hover:bg-neutral-50"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Refresh</span>
            </button>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between rounded-lg bg-neutral-50 px-3 py-2.5">
              <div className="flex items-center gap-2.5">
                {perms.screen_recording ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-amber-500" />
                )}
                <div>
                  <div className="text-[12.5px] font-medium text-neutral-800">
                    Screen Recording
                  </div>
                  <div className="text-[11px] text-neutral-500">
                    {perms.screen_recording
                      ? "Granted — ready to capture screens & windows"
                      : "Needed to capture screen pixels"}
                  </div>
                </div>
              </div>
              {!perms.screen_recording && (
                <button
                  type="button"
                  onClick={() => {
                    void requestScreenPermission();
                    void openPermissionSettings("screen_recording");
                  }}
                  className="rounded-md bg-[#0A84FF] px-2.5 py-1 text-[11.5px] font-medium text-white transition hover:bg-blue-600"
                >
                  Grant
                </button>
              )}
            </div>

            <div className="flex items-center justify-between rounded-lg bg-neutral-50 px-3 py-2.5">
              <div className="flex items-center gap-2.5">
                {perms.accessibility ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-amber-500" />
                )}
                <div>
                  <div className="text-[12.5px] font-medium text-neutral-800">
                    Accessibility
                  </div>
                  <div className="text-[11px] text-neutral-500">
                    {perms.accessibility
                      ? "Granted — ready for auto-scrolling capture"
                      : "Needed for auto-scroll wheel simulation"}
                  </div>
                </div>
              </div>
              {!perms.accessibility && (
                <button
                  type="button"
                  onClick={() => void openPermissionSettings("accessibility")}
                  className="rounded-md bg-[#0A84FF] px-2.5 py-1 text-[11.5px] font-medium text-white transition hover:bg-blue-600"
                >
                  Open Settings
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-neutral-200/80 bg-white p-4">
        <h3 className="text-[13px] font-semibold text-neutral-800">
          Storage & Maintenance
        </h3>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void openScreenshotsFolder()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-[12.5px] text-neutral-700 transition hover:bg-neutral-100"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span>Open Screenshots Folder</span>
          </button>

          <button
            type="button"
            onClick={() => void handleReset()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-[12.5px] text-neutral-700 transition hover:bg-red-50 hover:border-red-200 hover:text-red-600"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>{resetDone ? "Defaults Restored!" : "Reset All Settings"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
