#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/build-release-from-source.sh [--variant full|local] [--release-dir DIR] [--skip-install-smoke]

Build an Aimux release archive from the checked-out source, then verify the
archive shape, provenance/SBOM, build boundary, and isolated install path.
USAGE
}

fail() {
  printf 'aimux source release build failed: %s\n' "$*" >&2
  exit 1
}

append_standard_path_dirs() {
  local current_path
  current_path="${PATH:-}"
  for dir in /usr/local/bin /opt/homebrew/bin /usr/bin /bin /usr/sbin /sbin; do
    [ -d "$dir" ] || continue
    case ":$current_path:" in
      *":$dir:"*) ;;
      *) current_path="${current_path:+$current_path:}$dir" ;;
    esac
  done
  PATH="$current_path"
  export PATH
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) fail "unsupported platform: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT="local"
RELEASE_DIR="${AIMUX_RELEASE_DIR:-"$ROOT_DIR/release"}"
INSTALL_SMOKE=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --variant)
      VARIANT="${2:-}"
      shift 2
      ;;
    --release-dir)
      RELEASE_DIR="${2:-}"
      shift 2
      ;;
    --skip-install-smoke)
      INSTALL_SMOKE=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

case "$VARIANT" in
  full | local) ;;
  *) fail "unsupported --variant: $VARIANT" ;;
esac

append_standard_path_dirs
for command in bash git mktemp rm tar node; do
  need "$command"
done

PLATFORM="${AIMUX_RELEASE_PLATFORM:-$(detect_platform)}"
ARCH="${AIMUX_RELEASE_ARCH:-$(detect_arch)}"
PLATFORM_ARCH="$PLATFORM-$ARCH"
if [ "$VARIANT" = "local" ]; then
  ASSET="aimux-local-${PLATFORM_ARCH}.tar.gz"
  DEFAULT_PACKAGE_PROFILE="minimal"
else
  ASSET="aimux-${PLATFORM_ARCH}.tar.gz"
  DEFAULT_PACKAGE_PROFILE="full"
fi
ASSET_PATH="$RELEASE_DIR/$ASSET"

SOURCE_REVISION="$(git -C "$ROOT_DIR" rev-parse --verify HEAD)"
SOURCE_SHORT="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
export AIMUX_BUILD_VARIANT="$VARIANT"
export AIMUX_PACKAGE_PROFILE="${AIMUX_PACKAGE_PROFILE:-$DEFAULT_PACKAGE_PROFILE}"
export AIMUX_RELEASE_DIR="$RELEASE_DIR"
export AIMUX_RELEASE_VERSION="${AIMUX_RELEASE_VERSION:-source-$SOURCE_SHORT}"
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-"/tmp/aimux-cargo-target-${AIMUX_SESSION_ID:-source-build}"}"

printf 'Building Aimux %s variant from source revision %s\n' "$VARIANT" "$SOURCE_REVISION"
printf 'Release directory: %s\n' "$RELEASE_DIR"
printf 'Package profile: %s\n' "$AIMUX_PACKAGE_PROFILE"

cd "$ROOT_DIR"
node scripts/run-yarn.mjs release:asset

[ -f "$ASSET_PATH" ] || fail "expected archive was not produced: $ASSET_PATH"
[ -f "$ASSET_PATH.sha256" ] || fail "expected checksum was not produced: $ASSET_PATH.sha256"
[ -f "$ASSET_PATH.provenance.json" ] || fail "expected provenance was not produced: $ASSET_PATH.provenance.json"
[ -f "$ASSET_PATH.sbom.spdx.json" ] || fail "expected SBOM was not produced: $ASSET_PATH.sbom.spdx.json"

bash "$ROOT_DIR/scripts/verify-release-asset.sh" "$ASSET_PATH" "$PLATFORM_ARCH"
bash "$ROOT_DIR/scripts/verify-release-provenance.sh" "$RELEASE_DIR" "$ASSET" "$PLATFORM_ARCH" "$VARIANT"
bash "$ROOT_DIR/scripts/check-local-build-boundary.sh" \
  --variant "$VARIANT" \
  --archive "$ASSET_PATH" \
  --platform-arch "$PLATFORM_ARCH"

if [ "$INSTALL_SMOKE" -eq 1 ]; then
  TMP_DIR="$(mktemp -d)"
  cleanup() {
    rm -rf "$TMP_DIR"
  }
  trap cleanup EXIT
  AIMUX_INSTALL_ROOT="$TMP_DIR/install-root" \
    AIMUX_BIN_DIR="$TMP_DIR/bin" \
    AIMUX_INSTALL_VARIANT="$VARIANT" \
    AIMUX_SKIP_POST_INSTALL_RESTART=1 \
    bash "$ROOT_DIR/scripts/install.sh" "$ASSET_PATH"
  "$TMP_DIR/bin/aimux" --help >/dev/null
  printf 'Install smoke passed for %s variant\n' "$VARIANT"
fi

cat <<EOF
Aimux source release build verified:
  archive: $ASSET_PATH
  checksum: $ASSET_PATH.sha256
  provenance: $ASSET_PATH.provenance.json
  SBOM: $ASSET_PATH.sbom.spdx.json
EOF
