/**
 * Generates Shotter's app icon & tray icon following the sculptural minimal
 * design language of ../hark:
 *   - Apple Icon Grid: 824x824 continuous superellipse (n=5) on 1024 canvas (100px margin)
 *   - Distinct deep Swiss Cobalt matte plate (#1D3D6E -> #0B1931)
 *   - Seamless unified sculptural L-bracket crop corners + luminous sky-ice aperture dot,
 *     tilted -8 deg, studio-lit metallic porcelain facets + soft elevated drop shadow
 *   - Crisp flat 32px variant & monochrome macOS template tray icon
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(rootDir, "src-tauri", "icons");
mkdirSync(iconsDir, { recursive: true });

const C = 512;
const PLATE_A = 412; // 824x824 squircle on 1024 canvas => 100px safe margin
const PLATE_N = 5;
const TILT = -8;
const PAPER = "#FAF9F6";

function squircle(steps = 720) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = C + PLATE_A * Math.sign(ct) * Math.abs(ct) ** (2 / PLATE_N);
    const y = C + PLATE_A * Math.sign(st) * Math.abs(st) ** (2 / PLATE_N);
    pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return `M${pts.join("L")}Z`;
}

/**
 * Single continuous closed SVG path for a sculptural top-left L-bracket with smooth
 * rounded outer corner, rounded arm tips, and a refined curved inner elbow — zero overlap seam.
 */
function lBracketPath(size = 290, thick = 88, rOuter = 40, rTip = 34, rInner = 18) {
  const x0 = -232;
  const y0 = -232;
  const x1 = x0 + size; // right end of top arm
  const y1 = y0 + size; // bottom end of left arm
  const xi = x0 + thick; // inner vertical edge
  const yi = y0 + thick; // inner horizontal edge

  return [
    `M ${x0 + rOuter} ${y0}`,
    `L ${x1 - rTip} ${y0}`,
    `Q ${x1} ${y0} ${x1} ${y0 + rTip}`,
    `L ${x1} ${yi - rTip}`,
    `Q ${x1} ${yi} ${x1 - rTip} ${yi}`,
    `L ${xi + rInner} ${yi}`,
    `Q ${xi} ${yi} ${xi} ${yi + rInner}`,
    `L ${xi} ${y1 - rTip}`,
    `Q ${xi} ${y1} ${xi - rTip} ${y1}`,
    `L ${x0 + rTip} ${y1}`,
    `Q ${x0} ${y1} ${x0} ${y1 - rTip}`,
    `L ${x0} ${y0 + rOuter}`,
    `Q ${x0} ${y0} ${x0 + rOuter} ${y0}`,
    "Z",
  ].join(" ");
}

function buildCropMark({ metal }) {
  const tlFill = metal ? "url(#facet-tl)" : PAPER;
  const brFill = metal ? "url(#facet-br)" : PAPER;
  const dotFill = metal ? "url(#facet-dot)" : PAPER;
  const d = lBracketPath();

  return `
  <g transform="translate(${C} ${C}) rotate(${TILT})"${metal ? ' filter="url(#lift)"' : ""}>
    <path d="${d}" fill="${tlFill}"/>
    <path d="${d}" transform="rotate(180)" fill="${brFill}"/>
    <circle cx="0" cy="0" r="64" fill="${dotFill}"/>
  </g>`;
}

const metalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <!-- Deep Swiss Cobalt matte plate with subtle studio overhead light -->
    <radialGradient id="plate-bg" cx="0.32" cy="0.22" r="0.88">
      <stop offset="0%" stop-color="#1E3F73"/>
      <stop offset="56%" stop-color="#132A4F"/>
      <stop offset="100%" stop-color="#0B1931"/>
    </radialGradient>
    <!-- Seamless studio-lit porcelain/silver facets (matching Hark's metallic depth) -->
    <linearGradient id="facet-tl" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#D7E0EE"/>
    </linearGradient>
    <linearGradient id="facet-br" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0%" stop-color="#F1F5FA"/>
      <stop offset="100%" stop-color="#9BAEC9"/>
    </linearGradient>
    <linearGradient id="facet-dot" x1="0.15" y1="0.05" x2="0.85" y2="0.95">
      <stop offset="0%" stop-color="#93E0FF"/>
      <stop offset="100%" stop-color="#38BDF8"/>
    </linearGradient>
    <filter id="lift" x="-25%" y="-25%" width="150%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#040B17" flood-opacity="0.62"/>
    </filter>
  </defs>
  <path d="${squircle()}" fill="url(#plate-bg)"/>
  ${buildCropMark({ metal: true })}
</svg>
`;

const flatSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <path d="${squircle()}" fill="#132A4F"/>
  ${buildCropMark({ metal: false })}
</svg>
`;

const trayD = lBracketPath(290, 96, 42, 36, 18);
const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 1024 1024">
  <g transform="translate(512 512) scale(1.42) rotate(-8)" fill="#18181B">
    <path d="${trayD}"/>
    <path d="${trayD}" transform="rotate(180)"/>
    <circle cx="0" cy="0" r="72"/>
  </g>
</svg>
`;

writeFileSync(join(iconsDir, "appicon.svg"), metalSvg);
writeFileSync(join(iconsDir, "appicon-flat.svg"), flatSvg);
writeFileSync(join(iconsDir, "tray-icon.svg"), traySvg);
console.log("Generated seamless SVG sources in src-tauri/icons/");
