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

aimux_matching_daemon_port() {
  command -v curl >/dev/null 2>&1 || return 1
  [ -f "$AIMUX_ROOT/BUILD_STAMP" ] || return 1
  expected_build="$(sed -n '1p' "$AIMUX_ROOT/BUILD_STAMP")"
  [ -n "$expected_build" ] || return 1

  stored_pid="$(aimux_daemon_info_number pid || true)"
  port="$(aimux_daemon_info_number port || true)"
  [ -n "$stored_pid" ] || return 1
  [ -n "$port" ] || return 1

  json="$(aimux_health_json "$port")"
  aimux_health_matches "$json" "$expected_build" || return 1
  live_pid="$(printf '%s' "$json" | aimux_json_number pid)"
  [ "$live_pid" = "$stored_pid" ] || return 1
  printf '%s\n' "$port"
}

aimux_try_daemon_ensure() {
  port="$(aimux_matching_daemon_port)" || return 1
  json="$(aimux_health_json "$port")"
  aimux_print_daemon_ensure "$json" "$port"
}

aimux_try_restart() {
  port="$(aimux_matching_daemon_port)" || return 1
  body_file="$(mktemp "${TMPDIR:-/tmp}/aimux-restart.XXXXXX")" || return 1
  trap 'rm -f "$body_file"' EXIT
  trap 'rm -f "$body_file"; exit 130' INT TERM
  status="$(
    curl -sS --max-time 300 -o "$body_file" -w '%{http_code}' -X POST \
      "http://127.0.0.1:$port/core/restart-text" 2>/dev/null || true
  )"
  case "$status" in
    '' | 000)
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 1
      ;;
  esac
  cat "$body_file"
  rm -f "$body_file"
  trap - EXIT INT TERM
  case "$status" in
    2*) return 0 ;;
    *) return 2 ;;
  esac
}

aimux_curl_text_route() {
  path="$1"
  port="$(aimux_matching_daemon_port)" || return 1
  curl -fsS --max-time 5 "http://127.0.0.1:$port$path" 2>/dev/null || return 1
}

aimux_curl_project_text_route() {
  path="$1"
  project_root="$(pwd -P 2>/dev/null)" || return 1
  port="$(aimux_matching_daemon_port)" || return 1
  curl -fsS --max-time 5 --get --data-urlencode "project=$project_root" \
    "http://127.0.0.1:$port$path" 2>/dev/null || return 1
}

case "${1:-} ${2:-}" in
  "host status")
    if [ "$#" -eq 2 ] && aimux_curl_project_text_route "/core/host-status-text"; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_project_text_route "/core/host-status-text?json=1"; then
      exit 0
    fi
    ;;
  "daemon ensure")
    if [ "$#" -eq 2 ] && aimux_try_daemon_ensure; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/daemon-ensure-text?json=1"; then
      exit 0
    fi
    ;;
  "daemon status")
    if [ "$#" -eq 2 ] && aimux_curl_text_route "/core/daemon-status-text"; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/daemon-status-text?json=1"; then
      exit 0
    fi
    ;;
  "daemon projects")
    if [ "$#" -eq 2 ] && aimux_curl_text_route "/core/daemon-projects-text"; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/daemon-projects-text?json=1"; then
      exit 0
    fi
    ;;
  "projects list")
    if [ "$#" -eq 2 ] && aimux_curl_text_route "/core/projects-list-text"; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/projects-list-text?json=1"; then
      exit 0
    fi
    ;;
  "restart ")
    if [ "$#" -eq 1 ]; then
      if aimux_try_restart; then
        exit 0
      else
        code="$?"
        if [ "$code" -eq 2 ]; then
          exit 1
        fi
      fi
    fi
    ;;
esac

aimux_exec_node "$@"
