#!/usr/bin/env sh
set -eu

detect_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *)
      printf 'aimux: unsupported platform: %s\n' "$(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *)
      printf 'aimux: unsupported architecture: %s\n' "$(uname -m)" >&2
      exit 1
      ;;
  esac
}

if [ -n "${AIMUX_NATIVE_BIN:-}" ]; then
  if [ -x "$AIMUX_NATIVE_BIN" ]; then
    exec "$AIMUX_NATIVE_BIN" "$@"
  fi
  printf 'aimux: native binary is not executable: %s\n' "$AIMUX_NATIVE_BIN" >&2
  exit 127
fi

if [ -z "${AIMUX_ROOT:-}" ]; then
  AIMUX_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
  export AIMUX_ROOT
fi

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch)"
AIMUX_NATIVE_BIN="$AIMUX_ROOT/native/$PLATFORM-$ARCH/aimux"
export AIMUX_NATIVE_BIN

if [ -x "$AIMUX_NATIVE_BIN" ]; then
  exec "$AIMUX_NATIVE_BIN" "$@"
fi

printf 'aimux: native binary not found or not executable: %s\n' "$AIMUX_NATIVE_BIN" >&2
exit 127
