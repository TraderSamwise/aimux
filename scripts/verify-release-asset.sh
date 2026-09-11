#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

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

fail() {
  printf 'aimux release asset verification failed: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

append_standard_path_dirs

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf 'Usage: %s <asset.tar.gz> [platform-arch]\n' "$0" >&2
  exit 2
fi

for command in uname mktemp rm tar gzip sed strings awk; do
  need "$command"
done

ARCHIVE="$1"

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

PLATFORM_ARCH="${2:-"$(detect_platform)-$(detect_arch)"}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

tar -xzf "$ARCHIVE" -C "$TMP_DIR" aimux

ARCHIVE_STAMP="$(sed -n '1{s/[[:space:]]*$//;p;}' "$TMP_DIR/aimux/BUILD_STAMP" 2>/dev/null || true)"
NATIVE_ARTIFACT="$TMP_DIR/aimux/native/$PLATFORM_ARCH/aimux"
if [ -z "$ARCHIVE_STAMP" ]; then
  printf 'Release archive is missing BUILD_STAMP\n' >&2
  exit 1
fi
if [ ! -x "$NATIVE_ARTIFACT" ]; then
  printf 'Release archive is missing executable native aimux binary: native/%s/aimux\n' "$PLATFORM_ARCH" >&2
  exit 1
fi

BINARY_STAMP="$(
  strings "$NATIVE_ARTIFACT" \
    | awk -F= '/^AIMUX_EMBEDDED_BUILD_STAMP=/ && length($2) > 0 { print $2; exit }'
)"
if [ -z "$BINARY_STAMP" ]; then
  printf 'Release binary is missing embedded build stamp witness: native/%s/aimux\n' "$PLATFORM_ARCH" >&2
  exit 1
fi
if [ "$BINARY_STAMP" != "$ARCHIVE_STAMP" ]; then
  printf 'Release build stamp mismatch: archive %s, binary %s\n' "$ARCHIVE_STAMP" "$BINARY_STAMP" >&2
  exit 1
fi
