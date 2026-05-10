#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -e "const fs=require('fs'); process.stdout.write(JSON.parse(fs.readFileSync('package.json','utf8')).version)")"

detect_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *)
      printf 'Unsupported platform: %s\n' "$(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *)
      printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2
      exit 1
      ;;
  esac
}

PLATFORM="${AIMUX_RELEASE_PLATFORM:-$(detect_platform)}"
ARCH="${AIMUX_RELEASE_ARCH:-$(detect_arch)}"
ASSET="aimux-${PLATFORM}-${ARCH}.tar.gz"
OUT_DIR="${AIMUX_RELEASE_DIR:-"$ROOT_DIR/release"}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"
yarn build

PKG_DIR="$TMP_DIR/aimux"
mkdir -p "$PKG_DIR"

cp package.json yarn.lock README.md "$PKG_DIR/"
cp -R bin dist scripts "$PKG_DIR/"
printf '%s\n' "$VERSION" > "$PKG_DIR/VERSION"

(
  cd "$PKG_DIR"
  yarn install --production --frozen-lockfile --ignore-scripts
)

chmod +x "$PKG_DIR/bin/aimux"
chmod +x "$PKG_DIR/scripts/"*.sh 2>/dev/null || true
chmod +x "$PKG_DIR/node_modules/node-pty/prebuilds/darwin-"*/spawn-helper 2>/dev/null || true

if [ -d "$PKG_DIR/node_modules/node-pty/prebuilds" ]; then
  find "$PKG_DIR/node_modules/node-pty/prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name "$PLATFORM-$ARCH" -exec rm -rf {} +
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$ASSET" "$OUT_DIR/$ASSET.sha256"
tar -czf "$OUT_DIR/$ASSET" -C "$TMP_DIR" aimux
(
  cd "$OUT_DIR"
  shasum -a 256 "$ASSET" > "$ASSET.sha256"
)

printf 'Built %s\n' "$OUT_DIR/$ASSET"
