#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_VERSION="$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$ROOT_DIR/package.json")"
printf '%s\n' "$PACKAGE_VERSION" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+([.-][0-9A-Za-z.-]+)?$' \
  || { printf 'Failed to read package version from package.json\n' >&2; exit 1; }
VERSION="${AIMUX_RELEASE_VERSION:-$PACKAGE_VERSION}"

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
yarn build:release
yarn build:ui:local

PKG_DIR="$TMP_DIR/aimux"
mkdir -p "$PKG_DIR"

cp package.json yarn.lock README.md "$PKG_DIR/"
cp -R bin dist dist-ui scripts "$PKG_DIR/"
printf '%s\n' "$VERSION" > "$PKG_DIR/VERSION"

artifact_mtime_ms() {
  [ -f "$1" ] || { printf 'Missing build artifact: %s\n' "$1" >&2; exit 1; }
  case "$(uname -s)" in
    Darwin) timestamp="$(stat -f %m "$1")" ;;
    *) timestamp="$(stat -c %Y "$1")" ;;
  esac
  [ -n "$timestamp" ] || { printf 'Failed to stat build artifact: %s\n' "$1" >&2; exit 1; }
  printf '%s000' "$timestamp"
}

MAIN_ARTIFACT="$PKG_DIR/dist/main".js
BUILD_STAMP="$(artifact_mtime_ms "$PKG_DIR/dist/launcher-bin.js").$(artifact_mtime_ms "$MAIN_ARTIFACT")-$(cat "$PKG_DIR/dist/launcher-bin.js" "$MAIN_ARTIFACT" | shasum -a 1 | awk '{ print substr($1, 1, 12) }')"
printf '%s\n' "$BUILD_STAMP" > "$PKG_DIR/BUILD_STAMP"

if [ "$PLATFORM" = "darwin" ]; then
  AIMUX_NOTIFIER_ARCH="$ARCH" AIMUX_NOTIFIER_BUILD_DIR="$PKG_DIR/native/darwin" \
    bash "$ROOT_DIR/native/darwin/build-aimux-notifier.sh"
fi

(
  cd "$PKG_DIR"
  yarn install --production --frozen-lockfile --ignore-scripts --ignore-engines
)

chmod +x "$PKG_DIR/bin/aimux"
chmod +x "$PKG_DIR/scripts/"*.sh 2>/dev/null || true
chmod +x "$PKG_DIR/node_modules/node-pty/prebuilds/darwin-"*/spawn-helper 2>/dev/null || true

if [ -d "$PKG_DIR/node_modules/node-pty/prebuilds" ]; then
  find "$PKG_DIR/node_modules/node-pty/prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name "$PLATFORM-$ARCH" -exec rm -rf {} +
fi

find "$PKG_DIR" -name '*.map' -type f -delete

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$ASSET" "$OUT_DIR/$ASSET.sha256"
tar -czf "$OUT_DIR/$ASSET" -C "$TMP_DIR" aimux
(
  cd "$OUT_DIR"
  shasum -a 256 "$ASSET" > "$ASSET.sha256"
)

printf 'Built %s\n' "$OUT_DIR/$ASSET"
