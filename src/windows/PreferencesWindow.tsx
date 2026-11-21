import { useCallback, useEffect, useState } from "react";
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
  updateSettings,
} from "../lib/tauri";
import type { AppSettings } from "../types";
import { GeneralTab } from "../components/preferences/GeneralTab";
import { HotkeysTab } from "../components/preferences/HotkeysTab";
import { EditorTab } from "../components/preferences/EditorTab";
import { AdvancedTab } from "../components/preferences/AdvancedTab";
import { AboutTab } from "../components/preferences/AboutTab";

type TabId = "general" | "hotkeys" | "editor" | "advanced" | "about";

const TABS: { id: TabId; label: string; icon: typeof Settings }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "hotkeys", label: "Hotkeys", icon: Command },
  { id: "editor", label: "Editor", icon: PenTool },
  { id: "advanced", label: "Advanced", icon: FlaskConical },
  { id: "about", label: "About", icon: Info },
];

export function PreferencesWindow() {
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
    <div className="flex h-full w-full flex-col bg-white text-[#1D1D1F]">
      {/* Compact macOS-style Unified Preferences Header */}
      <header
        data-tauri-drag-region
        className="flex shrink-0 flex-col items-center border-b border-black/[0.07] bg-[#F7F7F9]/95 pb-2 pt-[7px]"
      >
        <div
          data-tauri-drag-region
          className="font-display mb-1.5 text-[13px] font-semibold tracking-[-0.015em] text-[#3C3C43]"
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
                    ? "bg-white text-[#007AFF] shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0.5px_1px_rgba(0,0,0,0.05)]"
                    : "text-[#6E6E73] hover:bg-black/[0.04] hover:text-[#1D1D1F]"
                }`}
              >
                <Icon className="h-[18px] w-[18px] stroke-[1.6]" />
                <span className="text-[10.5px] font-medium leading-none tracking-[-0.005em]">
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
          <div className="flex h-full items-center justify-center text-[12px] text-[#86868B]">
            Loading…
          </div>
        ) : activeTab === "general" ? (
          <GeneralTab settings={settings} onChange={(p) => void handlePatch(p)} />
        ) : activeTab === "hotkeys" ? (
          <HotkeysTab
            settings={settings}
            hotkeyErrors={hotkeyErrors}
            onChange={(p) => void handlePatch(p)}
            onHotkeyErrors={setHotkeyErrors}
          />
        ) : activeTab === "editor" ? (
          <EditorTab settings={settings} onChange={(p) => void handlePatch(p)} />
        ) : activeTab === "advanced" ? (
          <AdvancedTab onResetDefaults={handleReset} />
        ) : (
          <AboutTab />
        )}
      </main>
    </div>
  );
}
