#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAYS="${AIMUX_CARGO_SWEEP_DAYS:-7}"
MIN_AGE_MINUTES="${AIMUX_CARGO_SWEEP_MIN_AGE_MINUTES:-60}"
MODE="dry-run"

usage() {
  cat <<'EOF'
Usage: scripts/cargo-sweep-stale-targets.sh [--apply] [--days N] [--min-age-minutes N]

Prunes stale Aimux Cargo target artifacts with cargo-sweep without discarding
the whole warm cache. The default is a dry-run.

Environment:
  AIMUX_CARGO_SWEEP_DAYS             Artifact age threshold, default 7.
  AIMUX_CARGO_SWEEP_MIN_AGE_MINUTES  Skip target dirs touched recently, default 60.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      MODE="apply"
      shift
      ;;
    --days)
      DAYS="${2:?missing value for --days}"
      shift 2
      ;;
    --min-age-minutes)
      MIN_AGE_MINUTES="${2:?missing value for --min-age-minutes}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$DAYS" in
  '' | *[!0-9]*)
    printf 'AIMUX_CARGO_SWEEP_DAYS must be a non-negative integer, got %s\n' "$DAYS" >&2
    exit 2
    ;;
esac

case "$MIN_AGE_MINUTES" in
  '' | *[!0-9]*)
    printf 'AIMUX_CARGO_SWEEP_MIN_AGE_MINUTES must be a non-negative integer, got %s\n' "$MIN_AGE_MINUTES" >&2
    exit 2
    ;;
esac

if ! command -v cargo-sweep >/dev/null 2>&1 && ! cargo sweep --help >/dev/null 2>&1; then
  printf 'cargo-sweep is not installed. Install it with: cargo install cargo-sweep\n' >&2
  exit 127
fi

workspace_root="$ROOT_DIR/native"
if [ ! -f "$workspace_root/Cargo.toml" ]; then
  printf 'Missing native Cargo workspace: %s\n' "$workspace_root" >&2
  exit 1
fi

target_dirs=()
if [ -d "$workspace_root/target" ]; then
  target_dirs+=("$workspace_root/target")
fi
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  target_dirs+=("$dir")
done < <(find -H /tmp -maxdepth 1 -type d -name 'aimux-cargo-target-*' 2>/dev/null | sort)

if [ "${#target_dirs[@]}" -eq 0 ]; then
  printf 'No Aimux Cargo target dirs found.\n'
  exit 0
fi

recently_touched() {
  local dir="$1"
  [ "$MIN_AGE_MINUTES" -gt 0 ] || return 1
  find "$dir" -type f -mmin "-$MIN_AGE_MINUTES" -print -quit 2>/dev/null | grep -q .
}

for target_dir in "${target_dirs[@]}"; do
  if recently_touched "$target_dir"; then
    printf 'Skipping recently active target dir: %s\n' "$target_dir"
    continue
  fi

  printf 'Sweeping %s artifacts older than %s day(s).\n' "$target_dir" "$DAYS"
  if [ "$MODE" = "apply" ]; then
    CARGO_TARGET_DIR="$target_dir" cargo sweep --time "$DAYS" "$workspace_root"
  else
    CARGO_TARGET_DIR="$target_dir" cargo sweep --dry-run --time "$DAYS" "$workspace_root"
  fi
done
