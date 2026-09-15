#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${AIMUX_CARGO_SWEEP_LABEL:-dev.aimux.cargo-sweep}"
REPO="$ROOT_DIR"
HOUR="${AIMUX_CARGO_SWEEP_HOUR:-3}"
MINUTE="${AIMUX_CARGO_SWEEP_MINUTE:-17}"
INTERVAL_SECONDS="${AIMUX_CARGO_SWEEP_INTERVAL_SECONDS:-}"
MODE="install"

usage() {
  cat <<'EOF'
Usage: scripts/install-cargo-sweep-schedule.sh [--repo PATH] [--label NAME] [--dry-run]

Installs a local daily schedule for scripts/cargo-sweep-stale-targets.sh --apply.
macOS uses a per-user launchd agent. Linux uses a per-user systemd timer when
available, with a cron fallback.

Environment:
  AIMUX_CARGO_SWEEP_HOUR              Daily local hour, default 3.
  AIMUX_CARGO_SWEEP_MINUTE            Daily local minute, default 17.
  AIMUX_CARGO_SWEEP_INTERVAL_SECONDS  Use interval timer instead of daily time.
  AIMUX_CARGO_SWEEP_LABEL             Service label/name, default dev.aimux.cargo-sweep.
  AIMUX_CARGO_SWEEP_*                 Explicit sweep env overrides are persisted.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:?missing value for --repo}"
      shift 2
      ;;
    --label)
      LABEL="${2:?missing value for --label}"
      shift 2
      ;;
    --dry-run)
      MODE="dry-run"
      shift
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

case "$HOUR" in
  '' | *[!0-9]*)
    printf 'AIMUX_CARGO_SWEEP_HOUR must be a non-negative integer, got %s\n' "$HOUR" >&2
    exit 2
    ;;
esac
case "$MINUTE" in
  '' | *[!0-9]*)
    printf 'AIMUX_CARGO_SWEEP_MINUTE must be a non-negative integer, got %s\n' "$MINUTE" >&2
    exit 2
    ;;
esac
case "$INTERVAL_SECONDS" in
  '') ;;
  *[!0-9]*)
    printf 'AIMUX_CARGO_SWEEP_INTERVAL_SECONDS must be a positive integer, got %s\n' "$INTERVAL_SECONDS" >&2
    exit 2
    ;;
  0)
    printf 'AIMUX_CARGO_SWEEP_INTERVAL_SECONDS must be greater than zero.\n' >&2
    exit 2
    ;;
esac

if [ ! -f "$REPO/scripts/cargo-sweep-stale-targets.sh" ]; then
  printf 'Missing sweep script under repo: %s\n' "$REPO" >&2
  exit 1
fi

mkdir -p "$HOME/.aimux/logs"
LOG="$HOME/.aimux/logs/cargo-sweep.log"
printf -v QUOTED_REPO '%q' "$REPO"
printf -v QUOTED_LOG '%q' "$LOG"
RUN_COMMAND="cd $QUOTED_REPO && bash scripts/cargo-sweep-stale-targets.sh --apply >> $QUOTED_LOG 2>&1"
SWEEP_ENV_NAMES=(
  AIMUX_CARGO_SWEEP_DAYS
  AIMUX_CARGO_SWEEP_MIN_AGE_MINUTES
  AIMUX_CARGO_SWEEP_WORKSPACE_ROOT
  AIMUX_CARGO_SWEEP_TMP_ROOTS
  AIMUX_CARGO_SWEEP_WORKTREE_REPOS
  AIMUX_CARGO_SWEEP_PRUNE_WORKTREES
)

env_is_set() {
  local name="$1"
  [ "${!name+x}" = "x" ]
}

install_launchd() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist="$plist_dir/$LABEL.plist"
  mkdir -p "$plist_dir"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '  <key>Label</key><string>%s</string>\n' "$LABEL"
    printf '  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>%s</string></array>\n' "$RUN_COMMAND"
    local env_started=0
    local name
    for name in "${SWEEP_ENV_NAMES[@]}"; do
      env_is_set "$name" || continue
      if [ "$env_started" -eq 0 ]; then
        printf '%s\n' '  <key>EnvironmentVariables</key><dict>'
        env_started=1
      fi
      printf '    <key>%s</key><string>%s</string>\n' "$name" "${!name}"
    done
    if [ "$env_started" -eq 1 ]; then
      printf '%s\n' '  </dict>'
    fi
    if [ -n "$INTERVAL_SECONDS" ]; then
      printf '  <key>StartInterval</key><integer>%s</integer>\n' "$INTERVAL_SECONDS"
    else
      printf '  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>%s</integer></dict>\n' "$HOUR" "$MINUTE"
    fi
    printf '%s\n' '  <key>StandardOutPath</key><string>/tmp/aimux-cargo-sweep.launchd.out</string>'
    printf '%s\n' '  <key>StandardErrorPath</key><string>/tmp/aimux-cargo-sweep.launchd.err</string>'
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
  } >"$plist"
  if [ "$MODE" = "dry-run" ]; then
    printf 'Would install launchd agent: %s\n' "$plist"
    return 0
  fi
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "gui/$(id -u)/$LABEL"
  printf 'Installed launchd agent: %s\n' "$plist"
}

install_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  local service="$unit_dir/$LABEL.service"
  local timer="$unit_dir/$LABEL.timer"
  mkdir -p "$unit_dir"
  {
    printf '%s\n' '[Unit]'
    printf '%s\n' 'Description=Aimux stale Cargo target sweep'
    printf '%s\n' ''
    printf '%s\n' '[Service]'
    printf '%s\n' 'Type=oneshot'
    local name
    for name in "${SWEEP_ENV_NAMES[@]}"; do
      env_is_set "$name" || continue
      printf 'Environment=%s=%q\n' "$name" "${!name}"
    done
    printf 'WorkingDirectory=%s\n' "$REPO"
    printf 'ExecStart=/bin/bash -lc %q\n' "bash scripts/cargo-sweep-stale-targets.sh --apply >> $QUOTED_LOG 2>&1"
  } >"$service"
  {
    printf '%s\n' '[Unit]'
    printf '%s\n' 'Description=Daily Aimux stale Cargo target sweep'
    printf '%s\n' ''
    printf '%s\n' '[Timer]'
    if [ -n "$INTERVAL_SECONDS" ]; then
      printf 'OnBootSec=%ss\n' "$INTERVAL_SECONDS"
      printf 'OnUnitActiveSec=%ss\n' "$INTERVAL_SECONDS"
    else
      printf 'OnCalendar=*-*-* %02d:%02d:00\n' "$HOUR" "$MINUTE"
      printf '%s\n' 'Persistent=true'
    fi
    printf '%s\n' ''
    printf '%s\n' '[Install]'
    printf '%s\n' 'WantedBy=timers.target'
  } >"$timer"
  if [ "$MODE" = "dry-run" ]; then
    printf 'Would install systemd user timer: %s\n' "$timer"
    return 0
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now "$LABEL.timer"
  printf 'Installed systemd user timer: %s\n' "$timer"
}

install_cron() {
  local marker="# aimux cargo sweep schedule"
  local env_prefix=""
  local name
  for name in "${SWEEP_ENV_NAMES[@]}"; do
    env_is_set "$name" || continue
    local quoted_value
    printf -v quoted_value '%q' "${!name}"
    env_prefix="$env_prefix$name=$quoted_value "
  done
  local line="$MINUTE $HOUR * * * ${env_prefix}cd $QUOTED_REPO && bash scripts/cargo-sweep-stale-targets.sh --apply >> $QUOTED_LOG 2>&1 $marker"
  if [ "$MODE" = "dry-run" ]; then
    printf 'Would install cron entry: %s\n' "$line"
    return 0
  fi
  local current
  current="$(crontab -l 2>/dev/null | grep -Fv "$marker" || true)"
  {
    [ -z "$current" ] || printf '%s\n' "$current"
    printf '%s\n' "$line"
  } | crontab -
  printf 'Installed cron entry for Aimux cargo sweep.\n'
}

case "$(uname -s)" in
  Darwin)
    install_launchd
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      install_systemd
    else
      install_cron
    fi
    ;;
  *)
    install_cron
    ;;
esac
