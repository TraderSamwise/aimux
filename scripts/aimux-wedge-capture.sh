#!/usr/bin/env bash
# Capture everything about a wedged aimux process that can be had without a
# password, before anybody restarts it.
#
# The daemon wedge leaves the listener held and every thread parked, and the
# watchdog ends the process so commands stop hanging -- which also destroys the
# only copy of why. This runs first.
#
# Usage: aimux-wedge-capture [pid ...]
#   With no arguments it captures every running aimux process.
#
# Linux gets per-thread kernel state from /proc with no privileges at all, and
# userspace stacks only if eu-stack or gdb is installed. macOS gets named,
# symbolised userspace stacks from `sample`, which ships with the OS.

set -uo pipefail

OUT_DIR="${AIMUX_WEDGE_CAPTURE_DIR:-$HOME/.aimux/diagnostics}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR" || { echo "cannot write $OUT_DIR" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# elfutils is not installed system-wide on every box, and installing it needs
# root. `apt-get download` + `dpkg -x` into a user prefix needs neither, so the
# real distro binary can live here instead. Checked before PATH so an unpacked
# copy is used even when nothing is installed.
EU_ROOT="${AIMUX_EU_ROOT:-$HOME/.local/eu-root}"
EU_STACK=""
EU_LIBS=""
if [ -x "$EU_ROOT/usr/bin/eu-stack" ]; then
  EU_STACK="$EU_ROOT/usr/bin/eu-stack"
  # Found rather than hardcoded: `x86_64-linux-gnu` is wrong on aarch64, where
  # the unpacked binary would then fail to load its own libdw. And scoped to the
  # one call rather than exported, because an unpacked glibc tree on
  # LD_LIBRARY_PATH can break `ss`, `lsof` and `gdb` run later in this script.
  for libs in "$EU_ROOT"/usr/lib/*-linux-gnu*; do
    [ -d "$libs" ] || continue
    EU_LIBS="$libs"
    break
  done
elif have eu-stack; then
  EU_STACK="$(command -v eu-stack)"
fi

pids=("$@")
if [ ${#pids[@]} -eq 0 ]; then
  # A read loop rather than `mapfile`, because macOS ships bash 3.2 and this has
  # to run on the machine that is already broken, not the one with brew bash.
  # `-x` so this does not match its own command line, which is the mistake that
  # makes a capture report the shell's stack instead of the daemon's.
  while IFS= read -r line; do
    [ -n "$line" ] && pids+=("$line")
  done < <(pgrep -x aimux 2>/dev/null)
fi

if [ ${#pids[@]} -eq 0 ]; then
  echo "no aimux process found" >&2
  exit 1
fi

capture_linux() {
  local pid="$1" out="$2"
  {
    echo "## cmdline"
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null; echo
    echo
    echo "## process state"
    grep -E '^(State|Threads|VmRSS):' "/proc/$pid/status" 2>/dev/null
    echo
    echo "## threads: tid, name, kernel wait"
    # This alone is the evidence the wedge was described from -- every thread
    # parked in futex_do_wait with one in ep_poll -- and it needs no tool.
    local t
    for t in "/proc/$pid/task/"*; do
      [ -d "$t" ] || continue
      printf '%-10s %-24s %s\n' \
        "$(basename "$t")" \
        "$(cat "$t/comm" 2>/dev/null)" \
        "$(cat "$t/wchan" 2>/dev/null)"
    done
    echo
    echo "## listening sockets held by this pid"
    if have ss; then ss -lntp 2>/dev/null | grep -F "pid=$pid" || echo "(none reported)"; fi
    echo
    echo "## open fds"
    ls -l "/proc/$pid/fd" 2>/dev/null | head -40 || echo "(unreadable)"
    echo
    echo "## userspace stacks"
    local frames=""
    if [ -n "$EU_STACK" ]; then
      # Joined explicitly rather than with nested expansions: a stray leading
      # OR trailing colon means "the current directory" to the loader, and
      # `${A}${A:+:}${B}` produces a trailing one whenever B is empty.
      eu_path="$EU_LIBS"
      if [ -n "${LD_LIBRARY_PATH:-}" ]; then
        if [ -n "$eu_path" ]; then
          eu_path="$eu_path:$LD_LIBRARY_PATH"
        else
          eu_path="$LD_LIBRARY_PATH"
        fi
      fi
      frames="$(LD_LIBRARY_PATH="$eu_path" "$EU_STACK" -p "$pid" 2>&1)"
      echo "$frames"
    elif have gdb; then
      frames="$(gdb -p "$pid" -batch -ex 'thread apply all bt' 2>&1)"
      echo "$frames"
    else
      echo "NOT CAPTURED: no eu-stack and no gdb. Getting eu-stack needs no"
      echo "root: apt-get download elfutils && dpkg -x it into ~/.local/eu-root."
      echo "The kernel wait column above still says which threads are parked"
      echo "and in what; what is missing is the aimux frame that parked each."
    fi
    # Said out loud rather than left as a wall of identical errors: with
    # yama ptrace_scope=1 the tracer must be an ancestor, so nothing can attach
    # here unless the target opted in with prctl(PR_SET_PTRACER, ...) or the
    # capture runs as root. The frames above are empty for a reason, and the
    # reason is not that elfutils is missing.
    case "$frames" in
      *"Operation not permitted"*)
        echo
        echo "## why those frames are empty"
        echo "ptrace was denied. kernel.yama.ptrace_scope = $(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo unknown)."
        echo "At 1, only an ancestor may trace, so a capture started by hand"
        echo "cannot attach to a daemon it did not spawn. Fix is for the target"
        echo "to call prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY) -- verified to"
        echo "lift exactly this -- or to run this capture as root."
        ;;
    esac
  } >"$out" 2>&1
}

capture_macos() {
  local pid="$1" out="$2"
  {
    echo "## cmdline"
    ps -o command= -p "$pid" 2>/dev/null
    echo
    echo "## process state"
    ps -o pid=,stat=,etime=,rss= -p "$pid" 2>/dev/null
    echo
    echo "## listening sockets held by this pid"
    lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null || echo "(none reported)"
    echo
    echo "## userspace stacks (sample, per thread, symbolised)"
    # Ships with macOS: no install, no sudo, and it names the threads.
    sample "$pid" 1 -file /dev/stdout 2>&1
  } >"$out" 2>&1
}

rc=0
for pid in "${pids[@]}"; do
  [ -n "$pid" ] || continue
  # Digits only. A typo otherwise reached the capture, produced nothing, and
  # reported "produced nothing" -- which reads like the process was unreadable
  # rather than like the argument was wrong.
  case "$pid" in
    *[!0-9]*)
      echo "not a pid: $pid" >&2
      rc=1
      continue
      ;;
  esac
  # Numerically, not as the literal `0`: `00` passes the digit filter, and
  # `kill -0 00` succeeds, so it reached the capture and wrote a file with
  # nothing but section headers. `kill -0` on zero is a permission probe against
  # the whole process group.
  if [ "$pid" -eq 0 ] 2>/dev/null; then
    echo "not a pid: $pid" >&2
    rc=1
    continue
  fi
  # `/proc` first because it is the honest test where it exists; `kill -0` is
  # the macOS fallback. It returns EPERM rather than success for a process owned
  # by another user, so a root-owned aimux would read as absent -- said here
  # rather than papered over, because capturing another user's process needs
  # privileges this script does not have anyway.
  if [ ! -d "/proc/$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    echo "no such process, or not yours: $pid" >&2
    rc=1
    continue
  fi
  out="$OUT_DIR/wedge-$STAMP-pid$pid.txt"
  case "$(uname -s)" in
    Linux) capture_linux "$pid" "$out" ;;
    Darwin) capture_macos "$pid" "$out" ;;
    *) echo "unsupported platform $(uname -s)" >&2; rc=1; continue ;;
  esac
  if [ -s "$out" ]; then
    echo "$out"
  else
    echo "capture for pid $pid produced nothing: $out" >&2
    rc=1
  fi
done
exit "$rc"
