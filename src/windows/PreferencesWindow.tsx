import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  Command,
  FlaskConical,
  Info,
  PenTool,
  Settings,
} from "lucide-react";
import {
  getHotkeyErrors,
  getSettings,
  resetSettings,
  revealWindow,
  updateSettings,
} from "../lib/tauri";
import type { AppSettings } from "../types";
import { GeneralTab } from "../components/preferences/GeneralTab";
import { HotkeysTab } from "../components/preferences/HotkeysTab";
import { EditorTab } from "../components/preferences/EditorTab";
import { AdvancedTab } from "../components/preferences/AdvancedTab";
import { AboutTab } from "../components/preferences/AboutTab";

type TabId = "general" | "hotkeys" | "editor" | "advanced" | "about";

const PREFS_WIDTH = 500;
const BOTTOM_BREATHING = 18;

const TABS: { id: TabId; label: string; icon: typeof Settings }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "hotkeys", label: "Hotkeys", icon: Command },
  { id: "editor", label: "Editor", icon: PenTool },
  { id: "advanced", label: "Advanced", icon: FlaskConical },
  { id: "about", label: "About", icon: Info },
];

export function PreferencesWindow() {
  const headerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastHeightRef = useRef<number>(0);
  const revealedRef = useRef<boolean>(false);

  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [hotkeyErrors, setHotkeyErrors] = useState<Record<string, string | null>>(
    {},
  );

  useEffect(() => {
    void (async () => {
      const [s, errs] = await Promise.all([getSettings(), getHotkeyErrors()]);
      setSettings(s);
      setHotkeyErrors(errs);
    })();
  }, []);

  // Auto-fit window height to the active tab's exact content height so there is zero trailing gap.
  useLayoutEffect(() => {
    if (!settings) return;
    const header = headerRef.current;
    const content = contentRef.current;
    if (!header || !content) return;

    const syncHeight = () => {
      const target = Math.max(
        260,
        Math.min(
          660,
          Math.ceil(header.offsetHeight + content.offsetHeight + BOTTOM_BREATHING),
        ),
      );
      if (Math.abs(target - lastHeightRef.current) >= 2) {
        lastHeightRef.current = target;
        return getCurrentWindow().setSize(new LogicalSize(PREFS_WIDTH, target));
      }
      return Promise.resolve();
    };

    const resizePromise = syncHeight();
    if (!revealedRef.current) {
      revealedRef.current = true;
      void resizePromise.finally(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            void revealWindow(true);
          });
        });
      });
    }
    const ro = new ResizeObserver(() => {
      void syncHeight();
    });
    ro.observe(content);
    ro.observe(header);
    return () => ro.disconnect();
  }, [activeTab, settings]);

  const handlePatch = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (!settings) return;
      const next: AppSettings = { ...settings, ...patch };
      setSettings(next);
      try {
        const errs = await updateSettings(next);
        setHotkeyErrors(errs);
      } catch (err) {
        console.error("Failed to save settings:", err);
      }
    },
    [settings],
  );

  const handleReset = useCallback(async () => {
    const defaults = await resetSettings();
    setSettings(defaults);
    const errs = await getHotkeyErrors();
    setHotkeyErrors(errs);
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-white text-[#141416]">
      {/* Compact macOS-style Unified Preferences Header */}
      <header
        ref={headerRef}
        data-tauri-drag-region
        className="flex shrink-0 flex-col items-center border-b border-black/[0.08] bg-[#F6F6F8] pb-2 pt-[7px]"
      >
        <div
          data-tauri-drag-region
          className="font-display mb-1.5 text-[13px] font-semibold tracking-[-0.012em] text-[#141416]"
        >
          Preferences
        </div>

        <nav className="flex items-center gap-0.5">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex w-[66px] flex-col items-center gap-[3px] rounded-[8px] py-[5px] transition-all duration-150 ${
                  active
                    ? "bg-white text-[#0066D6] shadow-[0_1px_3px_rgba(0,0,0,0.09),0_0.5px_1px_rgba(0,0,0,0.06)]"
                    : "text-[#48484F] hover:bg-black/[0.05] hover:text-[#141416]"
                }`}
              >
                <Icon className="h-[18px] w-[18px] stroke-[1.65]" />
                <span
                  className={`text-[11px] leading-none tracking-[-0.005em] ${
                    active ? "font-medium" : "font-normal"
                  }`}
                >
                  {tab.label}
                </span>
              </button>
            );
          })}
        </nav>
      </header>

      {/* Clean White Content Surface */}
      <main className="flex-1 overflow-y-auto bg-white">
        {!settings ? (
          <div className="flex h-40 items-center justify-center text-[12px] font-medium text-[#52525B]">
            Loading…
          </div>
        ) : (
          <div ref={contentRef}>
            {activeTab === "general" ? (
              <GeneralTab
                settings={settings}
                onChange={(p) => void handlePatch(p)}
              />
            ) : activeTab === "hotkeys" ? (
              <HotkeysTab
                settings={settings}
                hotkeyErrors={hotkeyErrors}
                onChange={(p) => void handlePatch(p)}
                onHotkeyErrors={setHotkeyErrors}
              />
            ) : activeTab === "editor" ? (
              <EditorTab
                settings={settings}
                onChange={(p) => void handlePatch(p)}
              />
            ) : activeTab === "advanced" ? (
              <AdvancedTab onResetDefaults={handleReset} />
            ) : (
              <AboutTab />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
