#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_VERSION="$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$ROOT_DIR/package.json")"
printf '%s\n' "$PACKAGE_VERSION" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+([.-][0-9A-Za-z.-]+)?$' \
  || { printf 'Failed to read package version from package.json\n' >&2; exit 1; }
VERSION="${AIMUX_RELEASE_VERSION:-$PACKAGE_VERSION}"
BUILD_PROFILE="${AIMUX_BUILD_PROFILE:-full}"
case "$BUILD_PROFILE" in
  full | local) ;;
  *) printf 'Unsupported AIMUX_BUILD_PROFILE: %s\n' "$BUILD_PROFILE" >&2; exit 1 ;;
esac
export AIMUX_BUILD_PROFILE="$BUILD_PROFILE"
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
CARGO_TARGET_ROOT="${CARGO_TARGET_DIR:-"$ROOT_DIR/native/target"}"

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

HOST_PLATFORM="$(detect_platform)"
HOST_ARCH="$(detect_arch)"
PLATFORM="${AIMUX_RELEASE_PLATFORM:-$HOST_PLATFORM}"
ARCH="${AIMUX_RELEASE_ARCH:-$HOST_ARCH}"
if [ "$PLATFORM" != "$HOST_PLATFORM" ] || [ "$ARCH" != "$HOST_ARCH" ]; then
  printf 'Cross-architecture release assets are not supported by this script: host is %s-%s, requested %s-%s\n' \
    "$HOST_PLATFORM" "$HOST_ARCH" "$PLATFORM" "$ARCH" >&2
  exit 1
fi
ASSET="aimux-${PLATFORM}-${ARCH}.tar.gz"
OUT_DIR="${AIMUX_RELEASE_DIR:-"$ROOT_DIR/release"}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"
if [ "$BUILD_PROFILE" = "full" ]; then
  yarn build:ui:local
fi

release_source_hash() {
  if git -C "$ROOT_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
    {
      git -C "$ROOT_DIR" rev-parse --verify HEAD
      git -C "$ROOT_DIR" diff --binary HEAD -- package.json yarn.lock scripts native app docs || true
    } | shasum -a 1 | awk '{ print substr($1, 1, 12) }'
  else
    find package.json yarn.lock scripts native app docs -type f 2>/dev/null \
      -exec shasum -a 1 {} + \
      | LC_ALL=C sort \
      | shasum -a 1 \
      | awk '{ print substr($1, 1, 12) }'
  fi
}

release_build_stamp() {
  local generation source_hash suffix
  generation="$(printf '%s000' "$(date +%s)")"
  source_hash="$(release_source_hash)"
  suffix="$(
    printf '%s:%s:%s:%s:%s\n' "$generation" "$$" "$RANDOM" "$BUILD_PROFILE" "$source_hash" \
      | shasum -a 1 \
      | awk '{ print substr($1, 1, 12) }'
  )"
  printf '%s-%s\n' "$generation" "$suffix"
}

BUILD_STAMP="$(release_build_stamp)"
export AIMUX_RELEASE_BUILD_STAMP="$BUILD_STAMP"

cargo build --manifest-path native/Cargo.toml -p aimux --release
NATIVE_BUILD_ARTIFACT="$CARGO_TARGET_ROOT/release/aimux"

PKG_DIR="$TMP_DIR/aimux"
mkdir -p "$PKG_DIR"

cp package.json yarn.lock README.md LICENSE "$PKG_DIR/"
mkdir -p "$PKG_DIR/bin"
cp bin/aimux "$PKG_DIR/bin/aimux"
mkdir -p "$PKG_DIR/native/$PLATFORM-$ARCH"
cp "$NATIVE_BUILD_ARTIFACT" "$PKG_DIR/native/$PLATFORM-$ARCH/aimux"
if [ "$BUILD_PROFILE" = "full" ]; then
  cp -R dist-ui docs "$PKG_DIR/"
fi
mkdir -p "$PKG_DIR/scripts"
cp scripts/tmux-control.sh scripts/tmux-open-hyperlink.sh scripts/tmux-statusline.sh "$PKG_DIR/scripts/"
printf '%s\n' "$VERSION" > "$PKG_DIR/VERSION"
printf '%s\n' "$BUILD_PROFILE" > "$PKG_DIR/BUILD_PROFILE"

NATIVE_ARTIFACT="$PKG_DIR/native/$PLATFORM-$ARCH/aimux"
printf '%s\n' "$BUILD_STAMP" > "$PKG_DIR/BUILD_STAMP"

if [ "$PLATFORM" = "darwin" ]; then
  AIMUX_NOTIFIER_ARCH="$ARCH" AIMUX_NOTIFIER_BUILD_DIR="$PKG_DIR/native/darwin" \
    bash "$ROOT_DIR/native/darwin/build-aimux-notifier.sh"
fi

chmod +x "$PKG_DIR/bin/aimux"
chmod +x "$PKG_DIR/native/$PLATFORM-$ARCH/aimux"
chmod +x "$PKG_DIR/scripts/"*.sh 2>/dev/null || true

find "$PKG_DIR" -name '*.map' -type f -delete

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$ASSET" "$OUT_DIR/$ASSET.sha256"
tar -czf "$OUT_DIR/$ASSET" -C "$TMP_DIR" aimux
bash "$ROOT_DIR/scripts/verify-release-asset.sh" "$OUT_DIR/$ASSET" "$PLATFORM-$ARCH"
(
  cd "$OUT_DIR"
  shasum -a 256 "$ASSET" > "$ASSET.sha256"
)

printf 'Built %s\n' "$OUT_DIR/$ASSET"
