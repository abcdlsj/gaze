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
    <div className="flex h-full w-full flex-col bg-[#FAFAFB] text-neutral-900">
      {/* Unified macOS-style Preferences Header */}
      <header
        data-tauri-drag-region
        className="flex shrink-0 flex-col items-center border-b border-neutral-200/80 bg-[#F4F4F5]/95 pb-2.5 pt-2"
      >
        <div
          data-tauri-drag-region
          className="mb-2 text-[13px] font-semibold tracking-[-0.01em] text-neutral-700"
        >
          Preferences
        </div>

        <nav className="flex items-center gap-1.5">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex w-[70px] flex-col items-center gap-1 rounded-[10px] py-1.5 transition ${
                  active
                    ? "bg-white text-[#0A84FF] shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0.5px_1px_rgba(0,0,0,0.06)]"
                    : "text-neutral-600 hover:bg-black/[0.04]"
                }`}
              >
                <Icon className="h-[22px] w-[22px] stroke-[1.6]" />
                <span className="text-[11px] font-medium leading-none">
                  {tab.label}
                </span>
              </button>
            );
          })}
        </nav>
      </header>

      {/* Body */}
      <main className="flex-1 overflow-y-auto">
        {!settings ? (
          <div className="flex h-full items-center justify-center text-[12px] text-neutral-400">
            Loading…
          </div>
        ) : activeTab === "general" ? (
          <GeneralTab settings={settings} onChange={(p) => void handlePatch(p)} />
        ) : activeTab === "hotkeys" ? (
          <HotkeysTab
            settings={settings}
            hotkeyErrors={hotkeyErrors}
            onChange={(p) => void handlePatch(p)}
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
