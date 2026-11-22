# Gaze

A clean, fast, cross-platform (**macOS & Windows**) screenshot, scrolling capture, and annotation app built with **Tauri v2**, **Rust**, **React**, and **Tailwind CSS**.

## Features

- **Minimalist Native-Style UI**: Clean Preferences panel and distraction-free Editor with unified toolbar, checkerboard transparency canvas, live `#HEX` color inspector (`Tab` to copy), image dimensions, and zoom controls.
- **Flexible Capture Modes**:
  - **Area Capture** (`F1` by default): Frozen desktop snapshot with pixel magnifier loupe, adjustable selection handles, and quick action bar (Edit, Copy, Save, Pin, Scroll).
  - **Auto-Scrolling Long Screenshot** (`Shift+F1` or via Area bar): Automated mouse-wheel scrolling + edge-weighted vertical stitching engine resistant to sticky headers, sticky footers, and scrollbars, with configurable max height (`20,000 px` default) and scroll speed.
  - **Window Capture**: Hover-to-highlight window capture with configurable background (`Wallpaper`, `Transparent`, `Solid Color`, `Trim shadow`).
  - **Fullscreen Capture** & **Open from Clipboard** (`⌘⇧V` / `Ctrl+Shift+V`).
- **Lightweight Annotation Editor**:
  - Tools: Select/Move (`V`), Arrow (`A`), Text (`T`), Pixel Measure Ruler (`R`), Rectangle (`S`), Ellipse (`O`), Line (`L`), Frame & Backdrop (`F`), Freehand Pen/Highlighter (`P`), Blur (`B`), Pixelate (`X`), Step Counter (`N`), Crop (`C`), and Resize.
  - Full Undo/Redo (`⌘Z` / `⌘⇧Z`), high-DPI Retina 1× downscale option, PNG / Auto (PNG/JPEG) smart format saving, and floating always-on-top **Pin** windows.
- **Global Hotkeys & System Tray**: Lives quietly in the macOS menu bar / Windows system tray with customizable global shortcuts and launch-at-startup support.

## Development

### Prerequisites
- [Node.js](https://nodejs.org/) & `pnpm`
- [Rust](https://rustup.rs/) (stable)
- On macOS: Xcode Command Line Tools
- On Windows: Microsoft C++ Build Tools & WebView2

### Run in Development
```bash
pnpm install
pnpm tauri dev
```

### Run Tests & Checks
```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm typecheck
```

### Build Release Bundle (macOS / Windows)
```bash
pnpm tauri build
```

## macOS Permissions

On first use on macOS, grant permissions in **Preferences → Advanced** (or System Settings → Privacy & Security):
1. **Screen Recording** — required to capture screen pixels and windows.
2. **Accessibility** — required for automatic mouse-wheel scrolling during long screenshots.

> Tip: On macOS laptops where `F1` adjusts display brightness by default, press `Fn+F1` or enable *"Use F1, F2, etc. keys as standard function keys"* in Keyboard Settings, or rebind the shortcut in **Preferences → Hotkeys**.

## Install

macOS, through the Homebrew tap:

```sh
brew tap abcdlsj/tap
brew trust abcdlsj/tap
brew install --cask gaze
```

Otherwise download `gaze_<version>_darwin_universal.dmg` or `gaze_<version>_windows_amd64.zip` from
[Releases](https://github.com/abcdlsj/gaze/releases).

The macOS build is ad-hoc signed (no Developer ID, not notarised). Homebrew installs carry no
`com.apple.quarantine` attribute, so `brew install` launches normally; a dmg downloaded through a
browser is blocked by Gatekeeper — right-click → **Open**, or
`xattr -dr com.apple.quarantine /Applications/Gaze.app`.

## Releasing

Tagging `vX.Y.Z` runs [`.github/workflows/release.yml`](.github/workflows/release.yml): it builds the
universal macOS dmg and the Windows zip, publishes the GitHub release, and attaches a `gaze.rb`
cask generated from the real dmg checksum. Copy that file to `abcdlsj/homebrew-tap`'s `Casks/`.

Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` before
tagging; the About tab reads it from the bundle at runtime.
