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
  "#007AFF",
  "#8B5CF6",
  "#EC4899",
  "#18181B",
];

function SoftCheckbox({
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
      className="group inline-flex cursor-pointer items-center gap-[7px] text-[13px] text-[#1D1D1F]"
    >
      <span
        className={`flex h-[16px] w-[16px] items-center justify-center rounded-[4.5px] transition-all ${
          checked
            ? "mac-blue-fill text-white"
            : "bg-[#E5E5EA] group-hover:bg-[#DADAE0]"
        }`}
      >
        {checked && <Check className="h-[11px] w-[11px] stroke-[3.2]" />}
      </span>
      <span>{label}</span>
    </button>
  );
}

export function EditorTab({ settings, onChange }: Props) {
  const ed = settings.editor;
  const patchEditor = (patch: Partial<typeof ed>) =>
    onChange({ editor: { ...ed, ...patch } });

  return (
    <div className="flex flex-col px-8 py-5">
      <div className="grid grid-cols-[184px_1fr] items-center gap-x-4 gap-y-4">
        <div className="text-right text-[13px] text-[#3A3A3C]">
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
                className={`flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] transition ${
                  active
                    ? "ring-2 ring-[#007AFF] ring-offset-2"
                    : "hover:scale-110"
                }`}
              >
                {active && (
                  <Check className="h-3 w-3 text-white stroke-[3.2]" />
                )}
              </button>
            );
          })}
        </div>

        <div className="text-right text-[13px] text-[#3A3A3C]">
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
              background: `linear-gradient(to right, #007AFF 0%, #007AFF ${((ed.stroke_width - 1) / 11) * 100}%, #E5E5EA ${((ed.stroke_width - 1) / 11) * 100}%, #E5E5EA 100%)`,
            }}
          />
          <span className="w-10 text-right text-[12px] font-medium tabular-nums text-[#6E6E73]">
            {ed.stroke_width} px
          </span>
        </div>

        <div className="text-right text-[13px] text-[#3A3A3C]">
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
              background: `linear-gradient(to right, #007AFF 0%, #007AFF ${((ed.font_size - 12) / 28) * 100}%, #E5E5EA ${((ed.font_size - 12) / 28) * 100}%, #E5E5EA 100%)`,
            }}
          />
          <span className="w-10 text-right text-[12px] font-medium tabular-nums text-[#6E6E73]">
            {ed.font_size} pt
          </span>
        </div>

        <div className="text-right text-[13px] text-[#3A3A3C]">
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
              background: `linear-gradient(to right, #007AFF 0%, #007AFF ${((ed.blur_strength - 4) / 24) * 100}%, #E5E5EA ${((ed.blur_strength - 4) / 24) * 100}%, #E5E5EA 100%)`,
            }}
          />
          <span className="w-10 text-right text-[12px] font-medium tabular-nums text-[#6E6E73]">
            {ed.blur_strength}
          </span>
        </div>
      </div>

      <div className="my-5 h-px bg-black/[0.07]" />

      <div className="grid grid-cols-[184px_1fr] items-start gap-x-4">
        <div className="pt-0.5 text-right text-[13px] text-[#3A3A3C]">
          Window behavior
        </div>
        <div className="flex flex-col gap-3">
          <SoftCheckbox
            checked={ed.copy_closes_editor}
            label="Close Editor after copying to clipboard"
            onClick={() =>
              patchEditor({ copy_closes_editor: !ed.copy_closes_editor })
            }
          />
          <SoftCheckbox
            checked={ed.save_closes_editor}
            label="Close Editor after saving to disk"
            onClick={() =>
              patchEditor({ save_closes_editor: !ed.save_closes_editor })
            }
          />
        </div>
      </div>
    </div>
  );
}
