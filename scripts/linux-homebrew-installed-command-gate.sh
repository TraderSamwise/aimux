#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

TAP="${AIMUX_HOMEBREW_TAP:-tradersamwise/aimux}"
LOG_DIR="${AIMUX_HOMEBREW_LINUX_GATE_LOG_DIR:-}"
if [ -z "$LOG_DIR" ]; then
  LOG_DIR="$(mktemp -d)"
  CLEAN_LOG_DIR=1
else
  mkdir -p "$LOG_DIR"
  CLEAN_LOG_DIR=0
fi

cleanup() {
  local status=$?
  set +e
  brew uninstall --formula "$TAP/aimux-local" >/dev/null 2>&1 || true
  brew uninstall --formula "$TAP/aimux" >/dev/null 2>&1 || true
  if [ "${CLEAN_LOG_DIR:-0}" -eq 1 ] && [ "$status" -eq 0 ]; then
    rm -rf "$LOG_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'Linux Homebrew installed-command gate failed: %s\n' "$*" >&2
  exit 1
}

run_bounded() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

run_logged() {
  local label="$1"
  local failure="$2"
  local seconds="$3"
  local log_path="$4"
  shift 4
  local status

  set +e
  run_bounded "$seconds" "$@" >"$log_path" 2>&1
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    sed 's/^/  /' "$log_path" >&2
    fail "$failure (exit $status; log: $log_path)"
  fi
  printf '%s passed\n' "$label"
}

prove_installed_command() {
  local formula="$1"
  local label="$2"
  local command_path
  local help_log="$LOG_DIR/help-$label.log"
  local status

  command_path="$(brew --prefix)/bin/aimux"
  if [ ! -x "$command_path" ]; then
    fail "installed-command step for $label did not create executable command: $command_path"
  fi

  set +e
  AIMUX_HOME="$LOG_DIR/aimux-home-$label" \
    AIMUX_DAEMON_PORT=0 \
    AIMUX_SKIP_DAEMON_START=1 \
    run_bounded 30 "$command_path" --help >"$help_log" 2>&1
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    sed 's/^/  /' "$help_log" >&2
    fail "installed-command step for $label failed: $command_path --help exited $status"
  fi
  if ! grep -F "aimux" "$help_log" >/dev/null 2>&1; then
    sed 's/^/  /' "$help_log" >&2
    fail "installed-command step for $label failed: $command_path --help did not identify aimux"
  fi

  printf 'Linux Homebrew installed-command proof passed for %s: %s --help\n' "$label" "$command_path"
  printf 'Linux Homebrew %s formula installed version: ' "$label"
  brew list --formula --versions "$label"
}

install_and_prove() {
  local formula="$1"
  local label="$2"

  run_logged \
    "Linux Homebrew formula install for $label" \
    "formula install step for $label failed" \
    600 \
    "$LOG_DIR/install-$label.log" \
    brew install --formula "$formula"
  prove_installed_command "$formula" "$label"
  run_logged \
    "Linux Homebrew formula uninstall for $label" \
    "formula uninstall step for $label failed" \
    180 \
    "$LOG_DIR/uninstall-$label.log" \
    brew uninstall --formula "$formula"
}

case "$(uname -s)" in
  Linux) ;;
  *) fail "this gate must run on Linux; got $(uname -s)" ;;
esac

command -v brew >/dev/null 2>&1 || fail "Homebrew setup step did not leave brew on PATH"

export HOMEBREW_NO_AUTO_UPDATE="${HOMEBREW_NO_AUTO_UPDATE:-1}"
export HOMEBREW_NO_ENV_HINTS="${HOMEBREW_NO_ENV_HINTS:-1}"

run_logged \
  "Linux Homebrew tap fetch for $TAP" \
  "tap fetch step failed for $TAP" \
  180 \
  "$LOG_DIR/tap.log" \
  brew tap "$TAP"

if brew list --formula --versions aimux >/dev/null 2>&1; then
  fail "preflight found aimux already installed in $(brew --prefix); refusing to overwrite a live Homebrew formula"
fi
if brew list --formula --versions aimux-local >/dev/null 2>&1; then
  fail "preflight found aimux-local already installed in $(brew --prefix); refusing to overwrite a live Homebrew formula"
fi

install_and_prove "$TAP/aimux-local" aimux-local
install_and_prove "$TAP/aimux" aimux

printf 'Linux Homebrew installed-command gate passed for %s\n' "$TAP"
