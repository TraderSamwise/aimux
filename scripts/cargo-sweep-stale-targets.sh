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

active_target_snapshot="$(mktemp "${TMPDIR:-/tmp}/aimux-cargo-sweep-active-targets.XXXXXX")"
active_target_raw_snapshot="$(mktemp "${TMPDIR:-/tmp}/aimux-cargo-sweep-active-targets-raw.XXXXXX")"
SCRIPT_COMPLETED=0
cleanup_temp_files() {
  cleanup_status=$?
  set +e
  if [ "$cleanup_status" -eq 0 ] && [ "${SCRIPT_COMPLETED:-0}" -ne 1 ]; then
    cleanup_status=1
  fi
  rm -f "$active_target_snapshot" "$active_target_raw_snapshot"
  exit "$cleanup_status"
}
trap cleanup_temp_files EXIT
if [ "${AIMUX_TRAP_STATUS_PROOF:-}" = "scripts/cargo-sweep-stale-targets.sh" ]; then
  : "${AIMUX_TRAP_STATUS_PROOF_UNSET}"
fi

process_scan_error=""

collect_proc_cargo_target_dirs() {
  local saw_proc=0
  local saw_readable_env=0
  [ -d /proc ] || {
    process_scan_error="missing /proc process environment filesystem"
    return 1
  }
  for env_file in /proc/[0-9]*/environ; do
    [ -e "$env_file" ] || continue
    saw_proc=1
    [ -r "$env_file" ] || continue
    if tr '\0' '\n' <"$env_file" 2>/dev/null | sed -n 's/^CARGO_TARGET_DIR=//p' >>"$active_target_raw_snapshot"; then
      saw_readable_env=1
    fi
  done
  if [ "$saw_proc" -eq 1 ] && [ "$saw_readable_env" -eq 0 ]; then
    process_scan_error="could not read any /proc process environments"
    return 1
  fi
}

collect_macos_cargo_target_dirs() {
  local output
  if ! output="$(python3 - "$active_target_raw_snapshot" <<'PY' 2>&1
import ctypes
import ctypes.util
import errno
import os
import struct
import subprocess
import sys

out_path = sys.argv[1]
libc_path = ctypes.util.find_library("c") or "libc.dylib"
libc = ctypes.CDLL(libc_path, use_errno=True)
CTL_KERN = 1
KERN_ARGMAX = 8
KERN_PROCARGS2 = 49


def sysctl_bytes(mib, size):
    array_type = ctypes.c_int * len(mib)
    name = array_type(*mib)
    buffer = ctypes.create_string_buffer(size)
    out_size = ctypes.c_size_t(size)
    result = libc.sysctl(
        name,
        len(mib),
        buffer,
        ctypes.byref(out_size),
        None,
        0,
    )
    if result != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return buffer.raw[: out_size.value]


argmax_raw = sysctl_bytes([CTL_KERN, KERN_ARGMAX], ctypes.sizeof(ctypes.c_int))
argmax = struct.unpack("i", argmax_raw[:4])[0]
current_uid = os.getuid()
ps_output = subprocess.check_output(["ps", "-axo", "pid=,uid="], text=True)
values = []
failed = []
for line in ps_output.splitlines():
    parts = line.split()
    if len(parts) < 2:
        continue
    try:
        pid = int(parts[0])
        uid = int(parts[1])
    except ValueError:
        continue
    if uid != current_uid:
        continue
    try:
        raw = sysctl_bytes([CTL_KERN, KERN_PROCARGS2, pid], argmax)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            continue
        failed.append(f"pid {pid}: {error}")
        continue
    if len(raw) < 4:
        failed.append(f"pid {pid}: short KERN_PROCARGS2 response")
        continue
    argc = struct.unpack("i", raw[:4])[0]
    payload = raw[4:]
    position = payload.find(b"\0")
    if position < 0:
        failed.append(f"pid {pid}: missing executable terminator")
        continue
    position += 1
    while position < len(payload) and payload[position] == 0:
        position += 1
    for _ in range(max(argc, 0)):
        next_null = payload.find(b"\0", position)
        if next_null < 0:
            position = len(payload)
            break
        position = next_null + 1
    for entry in payload[position:].split(b"\0"):
        if entry.startswith(b"CARGO_TARGET_DIR="):
            values.append(entry.split(b"=", 1)[1].decode("utf-8", "surrogateescape"))

if failed:
    raise SystemExit("; ".join(failed))
with open(out_path, "a", encoding="utf-8") as handle:
    for value in values:
        print(value, file=handle)
PY
)"; then
    process_scan_error="macOS KERN_PROCARGS2 environment scan failed: $output"
    return 1
  fi
}

canonicalize_active_target_dirs() {
  local dir
  local canonical
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    canonical="$(canonical_dir "$dir")" || continue
    printf '%s\n' "$canonical"
  done <"$active_target_raw_snapshot" | sort -u >"$active_target_snapshot"
}

process_scan_ok=1
open_file_scan_required=0
case "$(uname -s)" in
  Darwin)
    open_file_scan_required=1
    collect_macos_cargo_target_dirs || process_scan_ok=0
    ;;
  *)
    collect_proc_cargo_target_dirs || process_scan_ok=0
    ;;
esac
if [ "$process_scan_ok" -eq 1 ]; then
  canonicalize_active_target_dirs
fi

open_file_scan_error=""
target_has_open_files() {
  local dir="$1"
  local output
  local errors
  local status
  if ! command -v lsof >/dev/null 2>&1; then
    if [ "$open_file_scan_required" -eq 1 ]; then
      open_file_scan_error="lsof is required on macOS to inspect open target files"
      return 2
    fi
    return 1
  fi
  errors="$(mktemp "${TMPDIR:-/tmp}/aimux-cargo-sweep-lsof.XXXXXX")"
  set +e
  output="$(lsof -n +D "$dir" 2>"$errors")"
  status="$?"
  set -e
  if [ -n "$output" ]; then
    rm -f "$errors"
    return 0
  fi
  if [ "$status" -eq 1 ] && [ ! -s "$errors" ]; then
    rm -f "$errors"
    return 1
  fi
  open_file_scan_error="$(cat "$errors" 2>/dev/null || true)"
  rm -f "$errors"
  if [ -z "$open_file_scan_error" ]; then
    open_file_scan_error="lsof +D exited with status $status"
  fi
  return 2
}

actively_used() {
  local dir="$1"
  if [ -s "$active_target_snapshot" ] && grep -Fx -- "$dir" "$active_target_snapshot" >/dev/null 2>&1; then
    return 0
  fi
  if target_has_open_files "$dir"; then
    return 0
  fi
  local open_status="$?"
  if [ "$process_scan_ok" -ne 1 ] || [ "$open_status" -eq 2 ]; then
    return 2
  fi
  return 1
}

if [ "${#target_dirs[@]}" -gt 0 ]; then
  for target_dir in "${target_dirs[@]}"; do
    if actively_used "$target_dir"; then
      printf 'Skipping active target dir: %s\n' "$target_dir"
      continue
    fi
    active_status="$?"
    if [ "$active_status" -eq 2 ]; then
      skip_reason=""
      if [ "$process_scan_ok" -ne 1 ]; then
        skip_reason="$process_scan_error"
      fi
      if [ -n "$open_file_scan_error" ]; then
        if [ -n "$skip_reason" ]; then
          skip_reason="$skip_reason; $open_file_scan_error"
        else
          skip_reason="$open_file_scan_error"
        fi
      fi
      if [ -z "$skip_reason" ]; then
        skip_reason="could not determine active process usage"
      fi
      printf 'Skipping target dir because active-use scan failed: %s (%s)\n' "$target_dir" "$skip_reason" >&2
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
fi

if [ "$PRUNE_WORKTREES" = "0" ]; then
  SCRIPT_COMPLETED=1
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
SCRIPT_COMPLETED=1
