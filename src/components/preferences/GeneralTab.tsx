import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, HelpCircle } from "lucide-react";
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
      <span className="inline-flex h-[18px] w-[18px] cursor-default items-center justify-center rounded-full bg-neutral-200/80 text-[11px] font-semibold text-neutral-600 transition hover:bg-neutral-300/80">
        <HelpCircle className="h-3.5 w-3.5 stroke-[2]" />
      </span>
      {open && (
        <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 w-56 -translate-x-1/2 rounded-lg border border-neutral-200 bg-white px-2.5 py-2 text-[11px] leading-snug text-neutral-600 shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}

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
      className="inline-flex items-center gap-1.5 text-[13px] text-neutral-800"
    >
      <span
        className={`flex h-[15px] w-[15px] items-center justify-center rounded-full transition ${
          checked
            ? "bg-[#0A84FF] shadow-xs"
            : "border border-neutral-300 bg-neutral-100/90 hover:border-neutral-400"
        }`}
      >
        {checked && <span className="h-[5px] w-[5px] rounded-full bg-white" />}
      </span>
      <span>{label}</span>
    </button>
  );
}

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
      className="inline-flex items-center gap-1.5 text-[13px] text-neutral-800"
    >
      <span
        className={`flex h-[15px] w-[15px] items-center justify-center rounded-[4px] transition ${
          checked
            ? "bg-[#0A84FF] text-white shadow-xs"
            : "border border-neutral-300 bg-neutral-100/90 hover:border-neutral-400"
        }`}
      >
        {checked && <Check className="h-3 w-3 stroke-[3]" />}
      </span>
      <span>{label}</span>
    </button>
  );
}

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
      className="group flex flex-col items-center gap-1.5 focus:outline-none"
    >
      <div
        className={`relative h-[66px] w-[96px] overflow-hidden rounded-[9px] transition ${
          selected
            ? "ring-[2.5px] ring-[#0A84FF] ring-offset-1"
            : "ring-1 ring-neutral-300/90 group-hover:ring-neutral-400"
        }`}
      >
        {mode === "wallpaper" && (
          <div
            className="h-full w-full"
            style={{
              background:
                "linear-gradient(135deg, #0b5d2a 0%, #249c4b 48%, #63d471 100%)",
            }}
          >
            <div className="absolute bottom-0 right-0 h-[50px] w-[72px] rounded-tl-[8px] bg-[#F7F7F8] p-2 shadow-md">
              <div className="flex gap-1">
                <span className="h-[6px] w-[6px] rounded-full bg-[#FF5F56]" />
                <span className="h-[6px] w-[6px] rounded-full bg-[#FFBD2E]" />
                <span className="h-[6px] w-[6px] rounded-full bg-[#27C93F]" />
              </div>
            </div>
          </div>
        )}

        {mode === "transparent" && (
          <div className="checkerboard-sm h-full w-full">
            <div className="absolute bottom-0 right-0 h-[50px] w-[72px] rounded-tl-[8px] border-l border-t border-black/10 bg-[#F7F7F8] p-2 shadow-md">
              <div className="flex gap-1">
                <span className="h-[6px] w-[6px] rounded-full bg-[#FF5F56]" />
                <span className="h-[6px] w-[6px] rounded-full bg-[#FFBD2E]" />
                <span className="h-[6px] w-[6px] rounded-full bg-[#27C93F]" />
              </div>
            </div>
          </div>
        )}

        {mode === "solid_color" && (
          <div className="h-full w-full" style={{ backgroundColor: solidColor }}>
            <div className="absolute bottom-0 right-0 h-[50px] w-[72px] rounded-tl-[8px] bg-[#F7F7F8] p-2 shadow-md">
              <div className="flex gap-1">
                <span className="h-[6px] w-[6px] rounded-full bg-[#FF5F56]" />
                <span className="h-[6px] w-[6px] rounded-full bg-[#FFBD2E]" />
                <span className="h-[6px] w-[6px] rounded-full bg-[#27C93F]" />
              </div>
            </div>
          </div>
        )}

        {mode === "trim_shadow" && (
          <div className="h-full w-full bg-[#F7F7F8] p-2">
            <div className="flex gap-1">
              <span className="h-[6px] w-[6px] rounded-full bg-[#FF5F56]" />
              <span className="h-[6px] w-[6px] rounded-full bg-[#FFBD2E]" />
              <span className="h-[6px] w-[6px] rounded-full bg-[#27C93F]" />
            </div>
          </div>
        )}
      </div>
      <span className="text-[12px] text-neutral-700">{labels[mode]}</span>
    </button>
  );
}

export function GeneralTab({ settings, onChange }: Props) {
  const [heightDraft, setHeightDraft] = useState(
    settings.scrolling_max_height.toLocaleString(),
  );

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
    <div className="flex flex-col px-7 py-5">
      {/* Window Screenshot Background */}
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-neutral-800">
          Window Screenshot Background
        </span>
        <TooltipBadge text="Choose how background & drop shadow are rendered when capturing an individual window." />
        {settings.window_background === "solid_color" && (
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-500">
            <span>Color</span>
            <input
              type="color"
              value={settings.solid_background_color}
              onChange={(e) =>
                onChange({ solid_background_color: e.target.value })
              }
              className="h-5 w-5 cursor-pointer rounded border border-neutral-300 bg-transparent p-0"
            />
          </label>
        )}
      </div>

      <div className="mt-3 grid grid-cols-4 gap-3">
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

      <hr className="my-4 border-neutral-200/80" />

      {/* Folder / Format / Retina */}
      <div className="grid grid-cols-[190px_1fr] items-center gap-x-4 gap-y-2.5">
        <div className="text-right text-[13px] text-neutral-700">
          Screenshots folder
        </div>
        <button
          type="button"
          onClick={() => void pickFolder()}
          title={settings.screenshots_folder}
          className="flex h-[28px] w-full items-center justify-center truncate rounded-[6px] border border-neutral-300/80 bg-neutral-200/65 px-3 text-[13px] font-normal text-neutral-800 transition hover:bg-neutral-200 active:bg-neutral-300/70"
        >
          <span className="truncate">{folderShortName}</span>
        </button>

        <div className="text-right text-[13px] text-neutral-700">
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

        <div className="text-right text-[13px] text-neutral-700">
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

      <hr className="my-4 border-neutral-200/80" />

      {/* Scrolling settings */}
      <div className="grid grid-cols-[190px_1fr] items-center gap-x-4 gap-y-3">
        <div className="text-right text-[13px] text-neutral-700">
          Scrolling screenshot max height
        </div>
        <div className="flex items-center gap-2">
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
            className="h-[26px] w-[94px] rounded-[6px] border border-neutral-300 bg-white px-2.5 text-right text-[13px] tabular-nums text-neutral-800 outline-none focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/20"
          />
          <span className="text-[13px] text-neutral-700">px</span>
        </div>

        <div className="text-right text-[13px] text-neutral-700">
          Scrolling screenshot speed
        </div>
        <div className="flex flex-col pt-1">
          <input
            type="range"
            min={1}
            max={100}
            value={speedPct}
            onChange={(e) =>
              onChange({ scrolling_speed: Number(e.target.value) })
            }
            className="shotter-slider w-full"
            style={{
              background: `linear-gradient(to right, #0A84FF 0%, #0A84FF ${speedPct}%, #E5E7EB ${speedPct}%, #E5E7EB 100%)`,
            }}
          />
          <div className="mt-1.5 flex justify-between px-1">
            {[0, 1, 2, 3].map((tick) => (
              <span
                key={tick}
                className="h-[3px] w-[1.5px] rounded-full bg-neutral-300"
              />
            ))}
          </div>
        </div>
      </div>

      <hr className="my-4 border-neutral-200/80" />

      {/* Startup & Post-capture workflow */}
      <div className="grid grid-cols-[190px_1fr] items-center gap-x-4 gap-y-2.5">
        <div className="text-right text-[13px] text-neutral-700">Autostart</div>
        <div>
          <MacCheckbox
            checked={settings.autostart}
            label="Launch at startup"
            onClick={() => onChange({ autostart: !settings.autostart })}
          />
        </div>

        <div className="text-right text-[13px] text-neutral-700">
          After screenshot
        </div>
        <div className="flex items-center gap-4">
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

        <div className="text-right text-[13px] text-neutral-700">
          After Area Crop, show
        </div>
        <div className="flex items-center gap-4">
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

        <div className="text-right text-[13px] text-neutral-700">
          Hide preview thumbnail
        </div>
        <div>
          <select
            disabled={thumbnailDisabled}
            value={settings.hide_preview_thumbnail}
            onChange={(e) =>
              onChange({
                hide_preview_thumbnail: e.target.value as ThumbnailAutoHide,
              })
            }
            className={`h-[26px] w-full rounded-[6px] border px-2.5 text-[13px] outline-none transition ${
              thumbnailDisabled
                ? "cursor-not-allowed border-neutral-200 bg-neutral-100 text-neutral-400"
                : "border-neutral-300 bg-white text-neutral-800 focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/20"
            }`}
          >
            <option value="manually">Manually (close button)</option>
            <option value="after5s">After 5 seconds</option>
            <option value="after10s">After 10 seconds</option>
            <option value="after30s">After 30 seconds</option>
          </select>
        </div>
      </div>
    </div>
  );
}
