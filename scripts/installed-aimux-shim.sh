#!/usr/bin/env sh
set -eu

aimux_exec_node() {
  exec "$AIMUX_NODE_BIN" "$AIMUX_ROOT/dist/launcher-bin.js" "$@"
}

aimux_state_port() {
  state_file="${AIMUX_HOME:-$HOME/.aimux}/daemon.json"
  [ -f "$state_file" ] || return 1
  sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$state_file" | sed -n '1p'
}

aimux_start_lock_path() {
  printf '%s/locks/daemon-start\n' "${AIMUX_HOME:-$HOME/.aimux}"
}

aimux_lock_pid() {
  lock_path="$1"
  [ -f "$lock_path/owner.json" ] || return 1
  sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$lock_path/owner.json" | sed -n '1p'
}

aimux_pid_alive() {
  pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

aimux_try_start_lock() {
  lock_path="$(aimux_start_lock_path)"
  mkdir -p "$(dirname "$lock_path")"
  if mkdir "$lock_path" 2>/dev/null; then
    printf '{"pid":%s}\n' "$$" > "$lock_path/owner.json"
    return 0
  fi
  pid="$(aimux_lock_pid "$lock_path" || true)"
  if aimux_pid_alive "$pid"; then
    return 1
  fi
  rm -rf "$lock_path"
  if mkdir "$lock_path" 2>/dev/null; then
    printf '{"pid":%s}\n' "$$" > "$lock_path/owner.json"
    return 0
  fi
  return 1
}

aimux_release_start_lock() {
  lock_path="$(aimux_start_lock_path)"
  pid="$(aimux_lock_pid "$lock_path" || true)"
  [ "$pid" = "$$" ] || return 0
  rm -rf "$lock_path"
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

  port="$(aimux_state_port || true)"
  [ -n "$port" ] || port="${AIMUX_DAEMON_PORT:-43190}"
  json="$(aimux_health_json "$port")"
  if aimux_health_matches "$json" "$expected_build"; then
    aimux_print_daemon_ensure "$json" "$port"
    return 0
  fi
  [ -z "$json" ] || return 1

  if ! aimux_try_start_lock; then
    deadline=100
    while [ "$deadline" -gt 0 ]; do
      json="$(aimux_health_json "$port")"
      if aimux_health_matches "$json" "$expected_build"; then
        aimux_print_daemon_ensure "$json" "$port"
        return 0
      fi
      deadline=$((deadline - 1))
      sleep 0.1
    done
    return 1
  fi

  json="$(aimux_health_json "$port")"
  if aimux_health_matches "$json" "$expected_build"; then
    aimux_release_start_lock
    aimux_print_daemon_ensure "$json" "$port"
    return 0
  fi
  if [ -n "$json" ]; then
    aimux_release_start_lock
    return 1
  fi

  "$AIMUX_NODE_BIN" "$AIMUX_ROOT/dist/launcher-bin.js" daemon run >/dev/null 2>&1 &
  deadline=100
  while [ "$deadline" -gt 0 ]; do
    json="$(aimux_health_json "$port")"
    if aimux_health_matches "$json" "$expected_build"; then
      aimux_release_start_lock
      aimux_print_daemon_ensure "$json" "$port"
      return 0
    fi
    deadline=$((deadline - 1))
    sleep 0.1
  done
  aimux_release_start_lock
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
