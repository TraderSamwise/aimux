#!/usr/bin/env sh
set -eu

aimux_exec_node() {
  exec "$AIMUX_NODE_BIN" "$AIMUX_ROOT/dist/launcher-bin.js" "$@"
}

aimux_daemon_info_path() {
  printf '%s/daemon/daemon.json\n' "${AIMUX_HOME:-$HOME/.aimux}"
}

aimux_daemon_info_number() {
  key="$1"
  info_file="$(aimux_daemon_info_path)"
  [ -f "$info_file" ] || return 1
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$info_file" | sed -n '1p'
}

aimux_health_json() {
  port="$1"
  curl -fsS --max-time 1 "http://127.0.0.1:$port/health" 2>/dev/null || true
}

aimux_json_number() {
  key="$1"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" | sed -n '1p'
}

aimux_health_matches() {
  json="$1"
  expected_build="$2"
  printf '%s' "$json" | grep -q '"kind"[[:space:]]*:[[:space:]]*"aimux-daemon"' || return 1
  printf '%s' "$json" | grep -q "\"buildStamp\"[[:space:]]*:[[:space:]]*\"$expected_build\"" || return 1
}

aimux_print_daemon_ensure() {
  json="$1"
  fallback_port="$2"
  pid="$(printf '%s' "$json" | aimux_json_number pid)"
  port="$(printf '%s' "$json" | aimux_json_number port)"
  [ -n "$pid" ] || return 1
  [ -n "$port" ] || port="$fallback_port"
  printf 'aimux daemon: pid %s on http://127.0.0.1:%s\n' "$pid" "$port"
}

aimux_try_daemon_ensure() {
  command -v curl >/dev/null 2>&1 || return 1
  [ -f "$AIMUX_ROOT/BUILD_STAMP" ] || return 1
  expected_build="$(sed -n '1p' "$AIMUX_ROOT/BUILD_STAMP")"
  [ -n "$expected_build" ] || return 1

  stored_pid="$(aimux_daemon_info_number pid || true)"
  port="$(aimux_daemon_info_number port || true)"
  [ -n "$stored_pid" ] || return 1
  [ -n "$port" ] || return 1

  json="$(aimux_health_json "$port")"
  if aimux_health_matches "$json" "$expected_build"; then
    live_pid="$(printf '%s' "$json" | aimux_json_number pid)"
    [ "$live_pid" = "$stored_pid" ] || return 1
    aimux_print_daemon_ensure "$json" "$port"
    return 0
  fi
  return 1
}

case "${1:-} ${2:-}" in
  "daemon ensure")
    if [ "$#" -eq 2 ] && aimux_try_daemon_ensure; then
      exit 0
    fi
    ;;
esac

aimux_exec_node "$@"
