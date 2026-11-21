import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, ChevronsUpDown } from "lucide-react";
import type {
  AfterAreaCrop,
  AppSettings,
  SaveFormat,
  ThumbnailAutoHide,
  WindowBackground,
} from "../../types";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

function TooltipBadge({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="inline-flex h-[16px] w-[16px] cursor-default items-center justify-center rounded-full bg-[#EBEBED] text-[10.5px] font-semibold text-[#515154] transition hover:bg-[#E0E0E4]">
        ?
      </span>
      {open && (
        <span className="animate-pop-in pointer-events-none absolute left-1/2 top-full z-50 mt-1 w-52 -translate-x-1/2 rounded-lg border border-black/[0.08] bg-white/95 px-2.5 py-1.5 text-[11px] leading-snug text-[#424245] shadow-[0_6px_20px_rgba(0,0,0,0.12)] backdrop-blur-md">
          {text}
        </span>
      )}
    </span>
  );
}

/** Authentic macOS soft-filled radio button */
function MacRadio({
  checked,
  label,
  onClick,
}: {
  checked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group inline-flex cursor-pointer items-center gap-[6px] text-[12.5px] text-[#1D1D1F]"
    >
      <span
        className={`flex h-[15px] w-[15px] items-center justify-center rounded-full transition-all duration-150 ${
          checked
            ? "mac-blue-fill"
            : "bg-[#E5E5EA] group-hover:bg-[#DADAE0]"
        }`}
      >
        {checked && <span className="h-[5.5px] w-[5.5px] rounded-full bg-white shadow-2xs" />}
      </span>
      <span className="tracking-[-0.005em]">{label}</span>
    </button>
  );
}

/** Authentic macOS soft-filled checkbox */
function MacCheckbox({
  checked,
  label,
  onClick,
}: {
  checked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group inline-flex cursor-pointer items-center gap-[6px] text-[12.5px] text-[#1D1D1F]"
    >
      <span
        className={`flex h-[15px] w-[15px] items-center justify-center rounded-[4px] transition-all duration-150 ${
          checked
            ? "mac-blue-fill text-white"
            : "bg-[#E5E5EA] group-hover:bg-[#DADAE0]"
        }`}
      >
        {checked && <Check className="h-[10px] w-[10px] stroke-[3.2]" />}
      </span>
      <span className="tracking-[-0.005em]">{label}</span>
    </button>
  );
}

/** Crisp macOS mini window preview cards */
function MiniWindowCard({
  mode,
  selected,
  solidColor,
  onSelect,
}: {
  mode: WindowBackground;
  selected: boolean;
  solidColor: string;
  onSelect: () => void;
}) {
  const labels: Record<WindowBackground, string> = {
    wallpaper: "Wallpaper",
    transparent: "Transparent",
    solid_color: "Solid Color",
    trim_shadow: "Trim shadow",
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex w-full cursor-pointer flex-col items-center gap-1 focus:outline-none"
    >
      <div
        className={`relative h-[56px] w-full overflow-hidden rounded-[8px] transition-all duration-150 ${
          selected
            ? "ring-[2px] ring-[#007AFF] shadow-[0_2px_8px_rgba(0,122,255,0.2)]"
            : "ring-1 ring-black/[0.11] shadow-[0_1px_2px_rgba(0,0,0,0.04)] group-hover:ring-black/[0.22]"
        }`}
      >
        {mode === "wallpaper" && (
          <div
            className="h-full w-full"
            style={{
              background:
                "radial-gradient(circle at 22% 28%, rgba(163, 255, 118, 0.85) 0%, transparent 45%), radial-gradient(circle at 75% 20%, rgba(18, 128, 45, 0.9) 0%, transparent 55%), radial-gradient(circle at 30% 85%, rgba(16, 185, 72, 0.85) 0%, transparent 50%), linear-gradient(135deg, #0a4d1e 0%, #1d8a34 52%, #4ade5b 100%)",
            }}
          >
            {/* Subtle diagonal leaf highlight */}
            <div
              className="absolute inset-0 opacity-30"
              style={{
                background:
                  "linear-gradient(125deg, transparent 20%, rgba(255,255,255,0.5) 38%, transparent 52%)",
              }}
            />
            <div className="absolute bottom-0 right-0 h-[42px] w-[72%] rounded-tl-[7px] bg-[#F7F7F8] p-[7px] shadow-[0_3px_10px_rgba(0,0,0,0.28)] ring-[0.5px] ring-black/10">
              <div className="flex gap-[4px]">
                <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#FF5F57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]" />
                <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#FEBC2E] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]" />
                <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#28C840] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]" />
              </div>
            </div>
          </div>
        )}

        {mode === "transparent" && (
          <div className="checkerboard-sm h-full w-full">
            <div className="absolute bottom-0 right-0 h-[42px] w-[72%] rounded-tl-[7px] bg-[#F8F8FA] p-[7px] shadow-[0_3px_10px_rgba(0,0,0,0.18)] ring-[0.5px] ring-black/[0.09]">
              <div className="flex gap-[4px]">
                <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#FF5F57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]" />
                <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#FEBC2E] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]" />
                <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#28C840] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]" />
              </div>
            </div>
          </div>
        )}

        {mode === "solid_color" && (
          <div className="h-full w-full" style={{ backgroundColor: solidColor }}>
            <div className="absolute bottom-0 right-0 h-[42px] w-[72%] rounded-tl-[7px] bg-[#F7F7F8] p-[7px] shadow-[0_3px_10px_rgba(0,0,0,0.32)] ring-[0.5px] ring-white/10">
              <div className="flex gap-[4px]">
                <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#FF5F57]" />
                <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#FEBC2E]" />
                <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#28C840]" />
              </div>
            </div>
          </div>
        )}

        {mode === "trim_shadow" && (
          <div className="h-full w-full bg-[#F7F7F8] p-[7px]">
            <div className="flex gap-[4px]">
              <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#FF5F57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)]" />
              <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#FEBC2E] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)]" />
              <span className="h-[5.5px] w-[5.5px] rounded-full bg-[#28C840] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)]" />
            </div>
          </div>
        )}
      </div>
      <span
        className={`text-[11.5px] tracking-[-0.005em] transition ${
          selected ? "font-medium text-[#1D1D1F]" : "text-[#424245]"
        }`}
      >
        {labels[mode]}
      </span>
    </button>
  );
}

export function GeneralTab({ settings, onChange }: Props) {
  const [heightDraft, setHeightDraft] = useState(
    settings.scrolling_max_height.toLocaleString(),
  );

  useEffect(() => {
    setHeightDraft(settings.scrolling_max_height.toLocaleString());
  }, [settings.scrolling_max_height]);

  const pickFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: settings.screenshots_folder,
      title: "Select Screenshots Folder",
    });
    if (typeof selected === "string" && selected.trim()) {
      onChange({ screenshots_folder: selected });
    }
  };

  const commitMaxHeight = () => {
    const cleaned = Number(heightDraft.replace(/[^0-9]/g, ""));
    const clamped = Number.isFinite(cleaned)
      ? Math.min(50000, Math.max(1000, cleaned))
      : settings.scrolling_max_height;
    setHeightDraft(clamped.toLocaleString());
    if (clamped !== settings.scrolling_max_height) {
      onChange({ scrolling_max_height: clamped });
    }
  };

  const folderShortName = (() => {
    const p = settings.screenshots_folder;
    if (!p) return "Select Folder";
    const parts = p.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) return p;
    return `…/${parts.slice(-2).join("/")}`;
  })();

  const thumbnailDisabled = settings.after_area_crop !== "thumbnail";
  const speedPct = Math.max(0, Math.min(100, settings.scrolling_speed));

  return (
    <div className="flex flex-col px-5 py-3.5">
      {/* Window Screenshot Background */}
      <div className="flex items-center gap-1.5">
        <span className="text-[12.5px] font-medium tracking-[-0.01em] text-[#1D1D1F]">
          Window Screenshot Background
        </span>
        <TooltipBadge text="Choose how background & drop shadow are rendered when capturing an individual window." />
        {settings.window_background === "solid_color" && (
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#F5F5F7] px-2 py-0.5 text-[11px] font-medium text-[#515154] ring-1 ring-black/[0.06]">
            <span>Color</span>
            <input
              type="color"
              value={settings.solid_background_color}
              onChange={(e) =>
                onChange({ solid_background_color: e.target.value })
              }
              className="h-3.5 w-3.5 cursor-pointer rounded-full border-0 bg-transparent p-0"
            />
          </label>
        )}
      </div>

      <div className="mt-2 grid grid-cols-4 gap-2.5">
        {(
          ["wallpaper", "transparent", "solid_color", "trim_shadow"] as WindowBackground[]
        ).map((mode) => (
          <MiniWindowCard
            key={mode}
            mode={mode}
            selected={settings.window_background === mode}
            solidColor={settings.solid_background_color}
            onSelect={() => onChange({ window_background: mode })}
          />
        ))}
      </div>

      <div className="my-3 h-px bg-black/[0.07]" />

      {/* Folder / Format / Retina */}
      <div className="grid grid-cols-[182px_1fr] items-center gap-x-3 gap-y-2">
        <div className="text-right text-[12.5px] text-[#3A3A3C]">
          Screenshots folder
        </div>
        <button
          type="button"
          onClick={() => void pickFolder()}
          title={settings.screenshots_folder}
          className="mac-btn flex h-[26px] w-full cursor-pointer items-center justify-center truncate rounded-[6px] px-2.5 text-[12.5px] font-normal text-[#1D1D1F] transition"
        >
          <span className="truncate">{folderShortName}</span>
        </button>

        <div className="text-right text-[12.5px] text-[#3A3A3C]">
          Save format
        </div>
        <div className="flex items-center gap-3.5">
          <MacRadio
            checked={settings.save_format === "png"}
            label="PNG"
            onClick={() => onChange({ save_format: "png" as SaveFormat })}
          />
          <MacRadio
            checked={settings.save_format === "auto"}
            label="Auto (PNG/JPEG)"
            onClick={() => onChange({ save_format: "auto" as SaveFormat })}
          />
          <TooltipBadge text="Auto uses lossless PNG for UI & transparency, and high-quality JPEG for large photographic captures." />
        </div>

        <div className="text-right text-[12.5px] text-[#3A3A3C]">
          Resize retina screenshots
        </div>
        <div>
          <MacCheckbox
            checked={settings.resize_retina_1x}
            label="Downscale to 1× when saving"
            onClick={() =>
              onChange({ resize_retina_1x: !settings.resize_retina_1x })
            }
          />
        </div>
      </div>

      <div className="my-3 h-px bg-black/[0.07]" />

      {/* Scrolling settings */}
      <div className="grid grid-cols-[182px_1fr] items-center gap-x-3 gap-y-2">
        <div className="text-right text-[12.5px] text-[#3A3A3C]">
          Scrolling screenshot max height
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={heightDraft}
            onChange={(e) => setHeightDraft(e.target.value)}
            onBlur={commitMaxHeight}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitMaxHeight();
              }
            }}
            className="h-[25px] w-[88px] rounded-[6px] border border-black/[0.14] bg-white px-2 text-right text-[12.5px] tabular-nums text-[#1D1D1F] shadow-[inset_0_0.5px_1.5px_rgba(0,0,0,0.05)] outline-none transition focus:border-[#007AFF] focus:ring-[3px] focus:ring-[#007AFF]/20"
          />
          <span className="text-[12.5px] text-[#3A3A3C]">px</span>
        </div>

        <div className="text-right text-[12.5px] text-[#3A3A3C]">
          Scrolling screenshot speed
        </div>
        <div className="flex flex-col pt-0.5">
          <input
            type="range"
            min={1}
            max={100}
            value={speedPct}
            onChange={(e) =>
              onChange({ scrolling_speed: Number(e.target.value) })
            }
            className="gaze-slider w-full"
            style={{
              background: `linear-gradient(to right, #007AFF 0%, #007AFF ${speedPct}%, #E5E5EA ${speedPct}%, #E5E5EA 100%)`,
            }}
          />
          <div className="mt-1 flex justify-between px-1.5">
            {[0, 1, 2, 3].map((tick) => (
              <span
                key={tick}
                className="h-[3px] w-[1.5px] rounded-full bg-black/[0.16]"
              />
            ))}
          </div>
        </div>
      </div>

      <div className="my-3 h-px bg-black/[0.07]" />

      {/* Startup & Post-capture workflow */}
      <div className="grid grid-cols-[182px_1fr] items-center gap-x-3 gap-y-2">
        <div className="text-right text-[12.5px] text-[#3A3A3C]">Autostart</div>
        <div>
          <MacCheckbox
            checked={settings.autostart}
            label="Launch at startup"
            onClick={() => onChange({ autostart: !settings.autostart })}
          />
        </div>

        <div className="text-right text-[12.5px] text-[#3A3A3C]">
          After screenshot
        </div>
        <div className="flex items-center gap-3.5">
          <MacCheckbox
            checked={settings.after_screenshot_show}
            label="Show"
            onClick={() =>
              onChange({
                after_screenshot_show: !settings.after_screenshot_show,
              })
            }
          />
          <MacCheckbox
            checked={settings.after_screenshot_copy}
            label="Copy"
            onClick={() =>
              onChange({
                after_screenshot_copy: !settings.after_screenshot_copy,
              })
            }
          />
          <MacCheckbox
            checked={settings.after_screenshot_save}
            label="Save"
            onClick={() =>
              onChange({
                after_screenshot_save: !settings.after_screenshot_save,
              })
            }
          />
        </div>

        <div className="text-right text-[12.5px] text-[#3A3A3C]">
          After Area Crop, show
        </div>
        <div className="flex items-center gap-3.5">
          <MacRadio
            checked={settings.after_area_crop === "thumbnail"}
            label="Thumbnail"
            onClick={() =>
              onChange({ after_area_crop: "thumbnail" as AfterAreaCrop })
            }
          />
          <MacRadio
            checked={settings.after_area_crop === "editor"}
            label="Editor"
            onClick={() =>
              onChange({ after_area_crop: "editor" as AfterAreaCrop })
            }
          />
        </div>

        <div className="text-right text-[12.5px] text-[#3A3A3C]">
          Hide preview thumbnail
        </div>
        <div className="relative">
          <select
            disabled={thumbnailDisabled}
            value={settings.hide_preview_thumbnail}
            onChange={(e) =>
              onChange({
                hide_preview_thumbnail: e.target.value as ThumbnailAutoHide,
              })
            }
            className={`h-[26px] w-full appearance-none rounded-[6px] pl-2.5 pr-7 text-[12.5px] outline-none transition ${
              thumbnailDisabled
                ? "cursor-not-allowed bg-[#F2F2F4] text-[#AEAEB2]"
                : "cursor-pointer border border-black/[0.12] bg-white text-[#1D1D1F] shadow-[0_0.5px_1px_rgba(0,0,0,0.05)] focus:border-[#007AFF] focus:ring-[3px] focus:ring-[#007AFF]/20"
            }`}
          >
            <option value="manually">Manually (close button)</option>
            <option value="after5s">After 5 seconds</option>
            <option value="after10s">After 10 seconds</option>
            <option value="after30s">After 30 seconds</option>
          </select>
          <ChevronsUpDown
            className={`pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${
              thumbnailDisabled ? "text-[#C7C7CC]" : "text-[#6E6E73]"
            }`}
          />
        </div>
      </div>
    </div>
  );
}
