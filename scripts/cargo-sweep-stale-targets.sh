#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="${AIMUX_CARGO_SWEEP_WORKSPACE_ROOT:-$ROOT_DIR/native}"
DAYS="${AIMUX_CARGO_SWEEP_DAYS:-7}"
MIN_AGE_MINUTES="${AIMUX_CARGO_SWEEP_MIN_AGE_MINUTES:-60}"
TMP_ROOTS="${AIMUX_CARGO_SWEEP_TMP_ROOTS:-/tmp /private/tmp}"
WORKTREE_REPOS="${AIMUX_CARGO_SWEEP_WORKTREE_REPOS:-$ROOT_DIR}"
PRUNE_WORKTREES="${AIMUX_CARGO_SWEEP_PRUNE_WORKTREES:-1}"
MODE="dry-run"

usage() {
  cat <<'EOF'
Usage: scripts/cargo-sweep-stale-targets.sh [--apply] [--days N] [--min-age-minutes N]

Prunes stale Aimux Cargo target artifacts with cargo-sweep without discarding
the whole warm cache. The default is a dry-run. Also prunes stale git worktree
administrative entries with `git worktree prune`; it does not force-remove
working tree directories.

Environment:
  AIMUX_CARGO_SWEEP_DAYS             Artifact age threshold, default 7.
  AIMUX_CARGO_SWEEP_MIN_AGE_MINUTES  Skip target dirs touched recently, default 60.
  AIMUX_CARGO_SWEEP_WORKSPACE_ROOT    Cargo workspace to pass to cargo-sweep, default repo/native.
  AIMUX_CARGO_SWEEP_TMP_ROOTS         Space-separated temp roots, default /tmp /private/tmp.
  AIMUX_CARGO_SWEEP_WORKTREE_REPOS    Space-separated repos for git worktree prune, default repo root.
  AIMUX_CARGO_SWEEP_PRUNE_WORKTREES   Set to 0 to skip git worktree prune.
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

workspace_root="$WORKSPACE_ROOT"
if [ ! -f "$workspace_root/Cargo.toml" ]; then
  printf 'Missing native Cargo workspace: %s\n' "$workspace_root" >&2
  exit 1
fi

canonical_dir() {
  local dir="$1"
  (cd "$dir" 2>/dev/null && pwd -P)
}

target_dirs=()
add_target_dir() {
  local dir="$1"
  local canonical
  canonical="$(canonical_dir "$dir")" || {
    printf 'Skipping unreadable target dir: %s\n' "$dir" >&2
    return
  }
  local existing
  if [ "${#target_dirs[@]}" -gt 0 ]; then
    for existing in "${target_dirs[@]}"; do
      if [ "$existing" = "$canonical" ]; then
        return 0
      fi
    done
  fi
  target_dirs+=("$canonical")
}

if [ -d "$workspace_root/target" ]; then
  add_target_dir "$workspace_root/target"
fi
for tmp_root in $TMP_ROOTS; do
  [ -d "$tmp_root" ] || continue
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    add_target_dir "$dir"
  done < <(find -H "$tmp_root" -maxdepth 1 -type d -name 'aimux-cargo-target-*' 2>/dev/null | sort)
done

if [ "${#target_dirs[@]}" -eq 0 ]; then
  printf 'No Aimux Cargo target dirs found.\n'
fi

recently_touched() {
  local dir="$1"
  [ "$MIN_AGE_MINUTES" -gt 0 ] || return 1
  local errors
  errors="$(mktemp "${TMPDIR:-/tmp}/aimux-cargo-sweep-find.XXXXXX")"
  local found=""
  if ! found="$(find "$dir" -type f -mmin "-$MIN_AGE_MINUTES" -print -quit 2>"$errors")"; then
    cat "$errors" >&2
    rm -f "$errors"
    printf 'Skipping target dir because recent-file scan failed: %s\n' "$dir" >&2
    return 0
  fi
  if [ -s "$errors" ]; then
    cat "$errors" >&2
    rm -f "$errors"
    printf 'Skipping target dir because recent-file scan was incomplete: %s\n' "$dir" >&2
    return 0
  fi
  rm -f "$errors"
  [ -n "$found" ]
}

process_snapshot="$(mktemp "${TMPDIR:-/tmp}/aimux-cargo-sweep-ps.XXXXXX")"
proc_env_snapshot="$(mktemp "${TMPDIR:-/tmp}/aimux-cargo-sweep-proc-env.XXXXXX")"
cleanup_temp_files() {
  rm -f "$process_snapshot" "$proc_env_snapshot"
}
trap cleanup_temp_files EXIT

if ! ps -axo pid=,command= >"$process_snapshot"; then
  printf 'Refusing to sweep: could not inspect process command lines.\n' >&2
  exit 1
fi

if [ -d /proc ]; then
  for env_file in /proc/[0-9]*/environ; do
    [ -r "$env_file" ] || continue
    tr '\0' '\n' <"$env_file" 2>/dev/null | sed -n 's/^CARGO_TARGET_DIR=//p' >>"$proc_env_snapshot" || true
  done
fi

actively_used() {
  local dir="$1"
  grep -F -- "$dir" "$process_snapshot" >/dev/null 2>&1 && return 0
  if [ -s "$proc_env_snapshot" ] && grep -Fx -- "$dir" "$proc_env_snapshot" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

for target_dir in "${target_dirs[@]}"; do
  if actively_used "$target_dir"; then
    printf 'Skipping active target dir: %s\n' "$target_dir"
    continue
  fi

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

if [ "$PRUNE_WORKTREES" = "0" ]; then
  exit 0
fi

for repo in $WORKTREE_REPOS; do
  [ -d "$repo/.git" ] || [ -f "$repo/.git" ] || continue
  if [ "$MODE" = "apply" ]; then
    printf 'Pruning git worktree metadata in %s.\n' "$repo"
    git -C "$repo" worktree prune
  else
    printf 'Would prune git worktree metadata in %s.\n' "$repo"
    git -C "$repo" worktree prune --dry-run
  fi
done
