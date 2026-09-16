#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/check-local-build-boundary.sh [options]

Checks that an aimux binary matches the full/local local-only build boundary.

Options:
  --variant <local|full>          Boundary to check (default: local)
  --binary <path>                Check an already-built aimux binary
  --archive <path>               Check a release archive containing aimux/
  --platform-arch <value>        Archive native subdir, e.g. darwin-arm64
  --skip-cargo-tree              Do not inspect the source cargo tree
  -h, --help                     Show this help
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT="local"
BINARY=""
ARCHIVE=""
PLATFORM_ARCH=""
SKIP_CARGO_TREE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --variant)
      VARIANT="${2:-}"
      shift 2
      ;;
    --binary)
      BINARY="${2:-}"
      shift 2
      ;;
    --archive)
      ARCHIVE="${2:-}"
      shift 2
      ;;
    --platform-arch)
      PLATFORM_ARCH="${2:-}"
      shift 2
      ;;
    --skip-cargo-tree)
      SKIP_CARGO_TREE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown check-local-build-boundary argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$VARIANT" in
  local | full) ;;
  *)
    printf 'Unsupported build variant: %s\n' "$VARIANT" >&2
    exit 2
    ;;
esac

if [ -n "$ARCHIVE" ] && [ -n "$BINARY" ]; then
  printf 'Use --archive or --binary, not both\n' >&2
  exit 2
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 127
  }
}

need grep
need strings

TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

if [ -n "$ARCHIVE" ]; then
  need tar
  if [ -z "$PLATFORM_ARCH" ]; then
    printf '--platform-arch is required with --archive\n' >&2
    exit 2
  fi
  TMP_DIR="$(mktemp -d)"
  tar -xzf "$ARCHIVE" -C "$TMP_DIR"
  STAMP="$TMP_DIR/aimux/BUILD_VARIANT"
  if [ ! -f "$STAMP" ]; then
    printf 'Archive is missing BUILD_VARIANT stamp: %s\n' "$ARCHIVE" >&2
    exit 1
  fi
  ARCHIVE_VARIANT="$(tr -d '[:space:]' < "$STAMP")"
  if [ "$ARCHIVE_VARIANT" != "$VARIANT" ]; then
    printf 'Archive BUILD_VARIANT mismatch: expected %s, got %s\n' "$VARIANT" "$ARCHIVE_VARIANT" >&2
    exit 1
  fi
  BINARY="$TMP_DIR/aimux/native/$PLATFORM_ARCH/aimux"
  if [ ! -x "$BINARY" ]; then
    printf 'Archive is missing executable native/%s/aimux\n' "$PLATFORM_ARCH" >&2
    exit 1
  fi
fi

if [ -z "$BINARY" ]; then
  need cargo
  TARGET_ROOT="${CARGO_TARGET_DIR:-"$ROOT_DIR/native/target"}"
  export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
  export AIMUX_BUILD_VARIANT="$VARIANT"
  if [ "$VARIANT" = "local" ]; then
    cargo build --manifest-path "$ROOT_DIR/native/Cargo.toml" -p aimux --release --no-default-features
  else
    cargo build --manifest-path "$ROOT_DIR/native/Cargo.toml" -p aimux --release
  fi
  BINARY="$TARGET_ROOT/release/aimux"
fi

if [ ! -x "$BINARY" ]; then
  printf 'Aimux binary is not executable: %s\n' "$BINARY" >&2
  exit 1
fi

WORK_DIR="${TMP_DIR:-$(mktemp -d)}"
if [ -z "$TMP_DIR" ]; then
  TMP_DIR="$WORK_DIR"
fi
HELP_FILE="$WORK_DIR/help.txt"
STRINGS_FILE="$WORK_DIR/strings.txt"
TREE_FILE="$WORK_DIR/cargo-tree.txt"

"$BINARY" --help > "$HELP_FILE"
strings "$BINARY" > "$STRINGS_FILE"

if [ "$SKIP_CARGO_TREE" -eq 0 ]; then
  need cargo
  if [ "$VARIANT" = "local" ]; then
    cargo tree --manifest-path "$ROOT_DIR/native/Cargo.toml" -p aimux --no-default-features > "$TREE_FILE"
  else
    cargo tree --manifest-path "$ROOT_DIR/native/Cargo.toml" -p aimux > "$TREE_FILE"
  fi
fi

remote_dependency_pattern='(^|[[:space:]])(tokio-tungstenite|tungstenite|ureq|reqwest|hyper|h2|native-tls|openssl|curl)[[:space:]]+v'
remote_help_pattern='^[[:space:]]{2}(remote|hosted|login|logout|whoami|security)([[:space:]]|$)'
remote_string_pattern='AIMUX_RELAY_URL|relay[.]aimux[.]app|wss://|ws://|relay_client|relay_runner|daemon::relay|daemon/relay|tokio[-_]tungstenite|tungstenite|ureq|hosted_server|hosted_cli|remote_login|remote_security_devices|maybe_host_published_attachment|attachments/hosted'

if [ "$VARIANT" = "local" ]; then
  if [ "$SKIP_CARGO_TREE" -eq 0 ] && grep -E "$remote_dependency_pattern" "$TREE_FILE" >/dev/null; then
    printf 'Local cargo tree contains remote-control dependencies:\n' >&2
    grep -E "$remote_dependency_pattern" "$TREE_FILE" >&2
    exit 1
  fi
  if grep -E "$remote_help_pattern" "$HELP_FILE" >/dev/null; then
    printf 'Local --help lists remote-control commands:\n' >&2
    grep -E "$remote_help_pattern" "$HELP_FILE" >&2
    exit 1
  fi
  if grep -E "$remote_string_pattern" "$STRINGS_FILE" >/dev/null; then
    printf 'Local binary contains remote-control strings:\n' >&2
    grep -E "$remote_string_pattern" "$STRINGS_FILE" >&2
    exit 1
  fi
else
  if [ "$SKIP_CARGO_TREE" -eq 0 ] && ! grep -E "$remote_dependency_pattern" "$TREE_FILE" >/dev/null; then
    printf 'Full cargo tree is missing remote-control dependencies\n' >&2
    exit 1
  fi
  if ! grep -E "$remote_help_pattern" "$HELP_FILE" >/dev/null; then
    printf 'Full --help is missing remote-control commands\n' >&2
    exit 1
  fi
  if ! grep -E 'AIMUX_RELAY_URL|wss://relay[.]aimux[.]app' "$STRINGS_FILE" >/dev/null; then
    printf 'Full binary is missing relay URL/config strings\n' >&2
    exit 1
  fi
fi

printf 'aimux %s build boundary check passed: %s\n' "$VARIANT" "$BINARY"
