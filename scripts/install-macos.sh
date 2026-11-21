#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Pick a stable macOS Code Signing identity so TCC permissions (Screen Recording & Accessibility)
# persist across rebuilds. Override via APPLE_SIGNING_IDENTITY="Your Cert Name".
SIGN_ID="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$SIGN_ID" ]]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(.*\)".*/\1/p' | head -n 1 || true)"
fi

if [[ -n "$SIGN_ID" ]]; then
  echo "Using signing identity: $SIGN_ID"
  APPLE_SIGNING_IDENTITY="$SIGN_ID" pnpm tauri build --bundles app
else
  echo "No local code-signing certificate found; using ad-hoc signing (-)."
  echo "Tip: create a self-signed Code Signing cert in Keychain Access to keep macOS permissions across rebuilds."
  pnpm tauri build --bundles app
fi

pkill -x gaze 2>/dev/null || true
rm -rf /Applications/Gaze.app
cp -R src-tauri/target/release/bundle/macos/Gaze.app /Applications/Gaze.app

if [[ -n "$SIGN_ID" ]]; then
  codesign --force --deep --sign "$SIGN_ID" /Applications/Gaze.app
else
  codesign --force --deep --sign - /Applications/Gaze.app
fi

sleep 0.5
open /Applications/Gaze.app
echo "Installed and launched /Applications/Gaze.app"
