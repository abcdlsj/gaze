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
    <div className="flex flex-col gap-3 px-5 py-3.5">
      {perms?.platform === "macos" && (
        <div className="rounded-lg border border-black/[0.08] bg-[#FAFAFC] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-[#1D1D1F]">
                macOS Permissions
              </h3>
              <p className="text-[11px] text-[#86868B]">
                Required for screen capture and automatic scrolling screenshots.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadPerms()}
              className="mac-btn inline-flex cursor-pointer items-center gap-1 rounded-[6px] px-2 py-1 text-[11px] font-medium text-[#1D1D1F] transition"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Refresh</span>
            </button>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between rounded-md border border-black/[0.06] bg-white px-3 py-2">
              <div className="flex items-center gap-2">
                {perms.screen_recording ? (
                  <CheckCircle2 className="h-4 w-4 text-[#34C759]" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-[#FF9500]" />
                )}
                <div>
                  <div className="text-[12.5px] font-medium leading-tight text-[#1D1D1F]">
                    Screen Recording
                  </div>
                  <div className="text-[11px] text-[#86868B]">
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
                  className="mac-blue-fill cursor-pointer rounded-[6px] px-2.5 py-1 text-[11px] font-medium text-white transition hover:brightness-105"
                >
                  Grant
                </button>
              )}
            </div>

            <div className="flex items-center justify-between rounded-md border border-black/[0.06] bg-white px-3 py-2">
              <div className="flex items-center gap-2">
                {perms.accessibility ? (
                  <CheckCircle2 className="h-4 w-4 text-[#34C759]" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-[#FF9500]" />
                )}
                <div>
                  <div className="text-[12.5px] font-medium leading-tight text-[#1D1D1F]">
                    Accessibility
                  </div>
                  <div className="text-[11px] text-[#86868B]">
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
                  className="mac-blue-fill cursor-pointer rounded-[6px] px-2.5 py-1 text-[11px] font-medium text-white transition hover:brightness-105"
                >
                  Open Settings
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-black/[0.08] bg-[#FAFAFC] p-3">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-[#1D1D1F]">
          Storage & Maintenance
        </h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void openScreenshotsFolder()}
            className="mac-btn inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] font-medium text-[#1D1D1F] transition"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span>Open Screenshots Folder</span>
          </button>

          <button
            type="button"
            onClick={() => void handleReset()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] border border-black/[0.1] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#3A3A3C] transition hover:border-[#FF3B30]/40 hover:bg-[#FF3B30]/[0.05] hover:text-[#FF3B30]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>
              {resetDone ? "Defaults Restored!" : "Reset All Settings"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
