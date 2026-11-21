import { Check } from "lucide-react";
import type { AppSettings } from "../../types";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

const PRESET_COLORS = [
  "#EF4444",
  "#F97316",
  "#EAB308",
  "#22C55E",
  "#0A84FF",
  "#8B5CF6",
  "#EC4899",
  "#18181B",
];

export function EditorTab({ settings, onChange }: Props) {
  const ed = settings.editor;
  const patchEditor = (patch: Partial<typeof ed>) =>
    onChange({ editor: { ...ed, ...patch } });

  return (
    <div className="flex flex-col px-7 py-5">
      <div className="grid grid-cols-[180px_1fr] items-center gap-x-4 gap-y-4">
        <div className="text-right text-[13px] text-neutral-700">
          Default annotation color
        </div>
        <div className="flex items-center gap-2">
          {PRESET_COLORS.map((hex) => {
            const active = ed.default_color.toLowerCase() === hex.toLowerCase();
            return (
              <button
                key={hex}
                type="button"
                onClick={() => patchEditor({ default_color: hex })}
                style={{ backgroundColor: hex }}
                className={`flex h-6 w-6 items-center justify-center rounded-full transition ${
                  active
                    ? "ring-2 ring-[#0A84FF] ring-offset-2"
                    : "ring-1 ring-black/15 hover:scale-105"
                }`}
              >
                {active && <Check className="h-3.5 w-3.5 text-white stroke-[3]" />}
              </button>
            );
          })}
        </div>

        <div className="text-right text-[13px] text-neutral-700">
          Default stroke width
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={12}
            value={ed.stroke_width}
            onChange={(e) =>
              patchEditor({ stroke_width: Number(e.target.value) })
            }
            className="shotter-slider flex-1"
            style={{
              background: `linear-gradient(to right, #0A84FF 0%, #0A84FF ${((ed.stroke_width - 1) / 11) * 100}%, #E5E7EB ${((ed.stroke_width - 1) / 11) * 100}%, #E5E7EB 100%)`,
            }}
          />
          <span className="w-10 text-right text-[12px] tabular-nums text-neutral-600">
            {ed.stroke_width} px
          </span>
        </div>

        <div className="text-right text-[13px] text-neutral-700">
          Default text size
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={12}
            max={40}
            value={ed.font_size}
            onChange={(e) => patchEditor({ font_size: Number(e.target.value) })}
            className="shotter-slider flex-1"
            style={{
              background: `linear-gradient(to right, #0A84FF 0%, #0A84FF ${((ed.font_size - 12) / 28) * 100}%, #E5E7EB ${((ed.font_size - 12) / 28) * 100}%, #E5E7EB 100%)`,
            }}
          />
          <span className="w-10 text-right text-[12px] tabular-nums text-neutral-600">
            {ed.font_size} pt
          </span>
        </div>

        <div className="text-right text-[13px] text-neutral-700">
          Blur / Pixelate strength
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={4}
            max={28}
            value={ed.blur_strength}
            onChange={(e) =>
              patchEditor({ blur_strength: Number(e.target.value) })
            }
            className="shotter-slider flex-1"
            style={{
              background: `linear-gradient(to right, #0A84FF 0%, #0A84FF ${((ed.blur_strength - 4) / 24) * 100}%, #E5E7EB ${((ed.blur_strength - 4) / 24) * 100}%, #E5E7EB 100%)`,
            }}
          />
          <span className="w-10 text-right text-[12px] tabular-nums text-neutral-600">
            {ed.blur_strength}
          </span>
        </div>
      </div>

      <hr className="my-5 border-neutral-200/80" />

      <div className="grid grid-cols-[180px_1fr] items-center gap-x-4 gap-y-3">
        <div className="text-right text-[13px] text-neutral-700">
          Window behavior
        </div>
        <div className="flex flex-col gap-2.5">
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-neutral-800">
            <input
              type="checkbox"
              checked={ed.copy_closes_editor}
              onChange={(e) =>
                patchEditor({ copy_closes_editor: e.target.checked })
              }
              className="h-3.5 w-3.5 accent-[#0A84FF]"
            />
            <span>Close Editor window after copying to clipboard</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-neutral-800">
            <input
              type="checkbox"
              checked={ed.save_closes_editor}
              onChange={(e) =>
                patchEditor({ save_closes_editor: e.target.checked })
              }
              className="h-3.5 w-3.5 accent-[#0A84FF]"
            />
            <span>Close Editor window after saving to disk</span>
          </label>
        </div>
      </div>
    </div>
  );
}
