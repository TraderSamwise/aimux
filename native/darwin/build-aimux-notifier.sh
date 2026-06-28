#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT_DIR/native/darwin/aimux-notifier-src"
OUT_DIR="${AIMUX_NOTIFIER_BUILD_DIR:-"$ROOT_DIR/native/darwin"}"
ARCH="${AIMUX_NOTIFIER_ARCH:-$(uname -m)}"
APP_DIR="$OUT_DIR/aimux-notifier.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [ "$(uname -s)" != "Darwin" ]; then
  echo "aimux-notifier can only be built on macOS" >&2
  exit 1
fi

command -v swiftc >/dev/null 2>&1 || {
  echo "missing required command: swiftc" >&2
  exit 1
}

case "$ARCH" in
  x64 | x86_64 | amd64) SWIFT_TARGET="x86_64-apple-macos11" ;;
  arm64 | aarch64) SWIFT_TARGET="arm64-apple-macos11" ;;
  *)
    echo "unsupported aimux-notifier architecture: $ARCH" >&2
    exit 1
    ;;
esac

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$SRC_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"
swiftc \
  -suppress-warnings \
  -target "$SWIFT_TARGET" \
  "$SRC_DIR/main.swift" \
  -framework AppKit \
  -framework UserNotifications \
  -o "$MACOS_DIR/aimux-notifier"

ICON_SRC="$ROOT_DIR/app/assets/images/icon.png"
if [ -f "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$TMP_DIR/Aimux.iconset"
  mkdir -p "$ICONSET"
  sips -z 16 16 "$ICON_SRC" --out "$ICONSET/icon_16x16.png" >/dev/null
  sips -z 32 32 "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
  sips -z 32 32 "$ICON_SRC" --out "$ICONSET/icon_32x32.png" >/dev/null
  sips -z 64 64 "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
  sips -z 128 128 "$ICON_SRC" --out "$ICONSET/icon_128x128.png" >/dev/null
  sips -z 256 256 "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
  sips -z 256 256 "$ICON_SRC" --out "$ICONSET/icon_256x256.png" >/dev/null
  sips -z 512 512 "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
  sips -z 512 512 "$ICON_SRC" --out "$ICONSET/icon_512x512.png" >/dev/null
  cp "$ICON_SRC" "$ICONSET/icon_512x512@2x.png"
  if ! iconutil -c icns "$ICONSET" -o "$RESOURCES_DIR/Aimux.icns"; then
    echo "warning: failed to build Aimux.icns; continuing with default app icon" >&2
    if command -v plutil >/dev/null 2>&1; then
      plutil -remove CFBundleIconFile "$CONTENTS_DIR/Info.plist" >/dev/null 2>&1 || true
    fi
  fi
fi

chmod +x "$MACOS_DIR/aimux-notifier"
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null
fi

echo "Built $APP_DIR"
