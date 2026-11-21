#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

# Pick a stable macOS Code Signing identity so TCC permissions (Screen Recording & Accessibility)
# persist across rebuilds. Prefers APPLE_SIGNING_IDENTITY, then "abcdlsj Local Dev".
SIGN_ID="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$SIGN_ID" ]]; then
  if security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -Fq '"abcdlsj Local Dev"'; then
    SIGN_ID="abcdlsj Local Dev"
  fi
fi

if [[ -n "$SIGN_ID" ]]; then
  echo "Using signing identity: $SIGN_ID"
  APPLE_SIGNING_IDENTITY="$SIGN_ID" pnpm tauri build --bundles app
else
  echo "No trusted 'abcdlsj Local Dev' certificate found; using ad-hoc signing (-)."
  echo "Tip: run install.sh from abcdlsj/macos-codesign to trust 'abcdlsj Local Dev'."
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
