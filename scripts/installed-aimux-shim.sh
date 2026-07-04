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

aimux_post_text_route() {
  path="$1"
  timeout="${2:-60}"
  port="$(aimux_matching_daemon_port)" || return 1
  body_file="$(mktemp "${TMPDIR:-/tmp}/aimux-core-post.XXXXXX")" || return 1
  trap 'rm -f "$body_file"' EXIT
  trap 'rm -f "$body_file"; exit 130' INT TERM
  status="$(
    curl -sS --max-time "$timeout" -o "$body_file" -w '%{http_code}' -X POST \
      "http://127.0.0.1:$port$path" 2>/dev/null || true
  )"
  case "$status" in
    '' | 000)
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 1
      ;;
  esac
  case "$status" in
    2*)
      cat "$body_file"
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 0
      ;;
    *)
      cat "$body_file" >&2
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 2
      ;;
  esac
}

aimux_post_query_text_route() {
  path="$1"
  timeout="${2:-60}"
  shift 2
  port="$(aimux_matching_daemon_port)" || return 1
  body_file="$(mktemp "${TMPDIR:-/tmp}/aimux-core-query-post.XXXXXX")" || return 1
  trap 'rm -f "$body_file"' EXIT
  trap 'rm -f "$body_file"; exit 130' INT TERM
  status="$(
    curl -sS --max-time "$timeout" -o "$body_file" -w '%{http_code}' -X POST --get "$@" \
      "http://127.0.0.1:$port$path" 2>/dev/null || true
  )"
  case "$status" in
    '' | 000)
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 1
      ;;
  esac
  case "$status" in
    2*)
      cat "$body_file"
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 0
      ;;
    *)
      cat "$body_file" >&2
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 2
      ;;
  esac
}

aimux_auth_text_route() {
  start_path="$1"
  wait_path="$2"
  timeout="${3:-360}"
  port="$(aimux_matching_daemon_port)" || return 1
  start_file="$(mktemp "${TMPDIR:-/tmp}/aimux-auth-start.XXXXXX")" || return 1
  wait_file="$(mktemp "${TMPDIR:-/tmp}/aimux-auth-wait.XXXXXX")" || return 1
  trap 'rm -f "$start_file" "$wait_file"' EXIT
  trap 'rm -f "$start_file" "$wait_file"; exit 130' INT TERM
  start_status="$(
    curl -sS --max-time 10 -o "$start_file" -w '%{http_code}' -X POST \
      "http://127.0.0.1:$port$start_path" 2>/dev/null || true
  )"
  case "$start_status" in
    2*) ;;
    '' | 000)
      rm -f "$start_file" "$wait_file"
      trap - EXIT INT TERM
      return 1
      ;;
    *)
      cat "$start_file" >&2
      rm -f "$start_file" "$wait_file"
      trap - EXIT INT TERM
      return 2
      ;;
  esac
  session_id="$(sed -n '1s/^auth-session: //p' "$start_file")"
  [ -n "$session_id" ] || {
    rm -f "$start_file" "$wait_file"
    trap - EXIT INT TERM
    return 1
  }
  sed '1d' "$start_file"
  wait_status="$(
    curl -sS --max-time "$timeout" -o "$wait_file" -w '%{http_code}' -X POST \
      "http://127.0.0.1:$port$wait_path?id=$session_id" 2>/dev/null || true
  )"
  case "$wait_status" in
    2*)
      cat "$wait_file"
      rm -f "$start_file" "$wait_file"
      trap - EXIT INT TERM
      return 0
      ;;
    '' | 000)
      rm -f "$start_file" "$wait_file"
      trap - EXIT INT TERM
      return 1
      ;;
    *)
      cat "$wait_file" >&2
      rm -f "$start_file" "$wait_file"
      trap - EXIT INT TERM
      return 2
      ;;
  esac
}

aimux_curl_project_text_route() {
  path="$1"
  project_root="$(pwd -P 2>/dev/null)" || return 1
  port="$(aimux_matching_daemon_port)" || return 1
  curl -fsS --max-time 5 --get --data-urlencode "project=$project_root" \
    "http://127.0.0.1:$port$path" 2>/dev/null || return 1
}

aimux_curl_project_arg_text_route() {
  path="$1"
  project_root="$2"
  port="$(aimux_matching_daemon_port)" || return 1
  curl -fsS --max-time 60 -X POST --get --data-urlencode "project=$project_root" \
    "http://127.0.0.1:$port$path" 2>/dev/null || return 1
}

aimux_resolve_project_arg() {
  project_arg="$1"
  if [ -d "$project_arg" ]; then
    (cd "$project_arg" && pwd -P) || return 1
    return 0
  fi
  case "$project_arg" in
    /*) printf '%s\n' "$project_arg" ;;
    *) printf '%s/%s\n' "$(pwd -P)" "$project_arg" ;;
  esac
}

aimux_try_daemon_project_ensure() {
  shift 2
  project_root=""
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --json)
        json=1
        ;;
      --project)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        project_root="$1"
        ;;
      --project=*)
        project_root="${1#--project=}"
        [ -n "$project_root" ] || return 1
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done
  [ -n "$project_root" ] || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  path="/core/project-ensure-text"
  [ "$json" -eq 1 ] && path="/core/project-ensure-text?json=1"
  aimux_curl_project_arg_text_route "$path" "$project_root"
}

aimux_try_lifecycle_spawn() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  worktree_path=""
  tool=""
  open=1
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tool)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        tool="$1"
        ;;
      --tool=*)
        tool="${1#--tool=}"
        [ -n "$tool" ] || return 1
        ;;
      --project)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        project_root="$1"
        ;;
      --project=*)
        project_root="${1#--project=}"
        [ -n "$project_root" ] || return 1
        ;;
      --worktree)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        worktree_path="$1"
        ;;
      --worktree=*)
        worktree_path="${1#--worktree=}"
        [ -n "$worktree_path" ] || return 1
        ;;
      --no-open)
        open=0
        ;;
      --json)
        json=1
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done
  [ -n "$tool" ] || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  if [ -n "$worktree_path" ]; then
    worktree_path="$(aimux_resolve_project_arg "$worktree_path")" || return 1
  fi
  path="/core/lifecycle/spawn-text"
  [ "$json" -eq 1 ] && path="/core/lifecycle/spawn-text?json=1"
  set -- --data-urlencode "project=$project_root" --data-urlencode "tool=$tool" --data-urlencode "open=$open"
  [ -n "$worktree_path" ] && set -- "$@" --data-urlencode "worktreePath=$worktree_path"
  aimux_post_query_text_route "$path" 120 "$@"
}

aimux_try_lifecycle_stop() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  session_id=""
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        project_root="$1"
        ;;
      --project=*)
        project_root="${1#--project=}"
        [ -n "$project_root" ] || return 1
        ;;
      --json)
        json=1
        ;;
      -*)
        return 1
        ;;
      *)
        [ -z "$session_id" ] || return 1
        session_id="$1"
        ;;
    esac
    shift
  done
  [ -n "$session_id" ] || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  path="/core/lifecycle/stop-text"
  [ "$json" -eq 1 ] && path="/core/lifecycle/stop-text?json=1"
  aimux_post_query_text_route "$path" 120 --data-urlencode "project=$project_root" --data-urlencode "sessionId=$session_id"
}

aimux_try_lifecycle_kill() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  session_id=""
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        project_root="$1"
        ;;
      --project=*)
        project_root="${1#--project=}"
        [ -n "$project_root" ] || return 1
        ;;
      --json)
        json=1
        ;;
      -*)
        return 1
        ;;
      *)
        [ -z "$session_id" ] || return 1
        session_id="$1"
        ;;
    esac
    shift
  done
  [ -n "$session_id" ] || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  path="/core/lifecycle/kill-text"
  [ "$json" -eq 1 ] && path="/core/lifecycle/kill-text?json=1"
  aimux_post_query_text_route "$path" 120 --data-urlencode "project=$project_root" --data-urlencode "sessionId=$session_id"
}

aimux_try_lifecycle_fork() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  source_session_id=""
  worktree_path=""
  instruction=""
  tool=""
  open=1
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tool)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        tool="$1"
        ;;
      --tool=*)
        tool="${1#--tool=}"
        [ -n "$tool" ] || return 1
        ;;
      --project)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        project_root="$1"
        ;;
      --project=*)
        project_root="${1#--project=}"
        [ -n "$project_root" ] || return 1
        ;;
      --worktree)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        worktree_path="$1"
        ;;
      --worktree=*)
        worktree_path="${1#--worktree=}"
        [ -n "$worktree_path" ] || return 1
        ;;
      --instruction)
        shift
        [ "$#" -gt 0 ] || return 1
        instruction="$1"
        ;;
      --instruction=*)
        instruction="${1#--instruction=}"
        ;;
      --no-open)
        open=0
        ;;
      --json)
        json=1
        ;;
      -*)
        return 1
        ;;
      *)
        [ -z "$source_session_id" ] || return 1
        source_session_id="$1"
        ;;
    esac
    shift
  done
  [ -n "$source_session_id" ] || return 1
  [ -n "$tool" ] || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  if [ -n "$worktree_path" ]; then
    worktree_path="$(aimux_resolve_project_arg "$worktree_path")" || return 1
  fi
  path="/core/lifecycle/fork-text"
  [ "$json" -eq 1 ] && path="/core/lifecycle/fork-text?json=1"
  set -- --data-urlencode "project=$project_root" --data-urlencode "sourceSessionId=$source_session_id" \
    --data-urlencode "tool=$tool" --data-urlencode "open=$open"
  [ -n "$worktree_path" ] && set -- "$@" --data-urlencode "worktreePath=$worktree_path"
  [ -n "$instruction" ] && set -- "$@" --data-urlencode "instruction=$instruction"
  aimux_post_query_text_route "$path" 120 "$@"
}

case "${1:-}" in
  spawn)
    if aimux_try_lifecycle_spawn "$@"; then
      exit 0
    else
      code="$?"
      if [ "$code" -eq 2 ]; then
        exit 1
      fi
    fi
    ;;
  stop)
    if aimux_try_lifecycle_stop "$@"; then
      exit 0
    else
      code="$?"
      if [ "$code" -eq 2 ]; then
        exit 1
      fi
    fi
    ;;
  kill)
    if aimux_try_lifecycle_kill "$@"; then
      exit 0
    else
      code="$?"
      if [ "$code" -eq 2 ]; then
        exit 1
      fi
    fi
    ;;
  fork)
    if aimux_try_lifecycle_fork "$@"; then
      exit 0
    else
      code="$?"
      if [ "$code" -eq 2 ]; then
        exit 1
      fi
    fi
    ;;
esac

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
  "daemon project-ensure")
    if aimux_try_daemon_project_ensure "$@"; then
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
  "remote status")
    if [ "$#" -eq 2 ] && aimux_curl_text_route "/core/remote-status-text"; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/remote-status-text?json=1"; then
      exit 0
    fi
    ;;
  "remote enable")
    if [ "$#" -eq 2 ]; then
      if aimux_post_text_route "/core/remote-enable-text"; then
        exit 0
      else
        code="$?"
        if [ "$code" -eq 2 ]; then
          exit 1
        fi
      fi
    fi
    ;;
  "remote disable")
    if [ "$#" -eq 2 ]; then
      if aimux_post_text_route "/core/remote-disable-text"; then
        exit 0
      else
        code="$?"
        if [ "$code" -eq 2 ]; then
          exit 1
        fi
      fi
    fi
    ;;
  "whoami " | "whoami --json")
    if [ "$#" -eq 1 ] && aimux_curl_text_route "/core/whoami-text"; then
      exit 0
    fi
    if [ "$#" -eq 2 ] && [ "${2:-}" = "--json" ] && aimux_curl_text_route "/core/whoami-text?json=1"; then
      exit 0
    fi
    ;;
  "logout ")
    if [ "$#" -eq 1 ]; then
      if aimux_post_text_route "/core/logout-text"; then
        exit 0
      else
        code="$?"
        if [ "$code" -eq 2 ]; then
          exit 1
        fi
      fi
    fi
    ;;
  "login ")
    if [ "$#" -eq 1 ]; then
      if aimux_auth_text_route "/core/login-start-text" "/core/login-wait-text" 360; then
        exit 0
      else
        code="$?"
        if [ "$code" -eq 2 ]; then
          exit 1
        fi
      fi
    fi
    ;;
  "security unlock")
    if [ "$#" -eq 2 ]; then
      if aimux_auth_text_route "/core/security-unlock-start-text" "/core/security-unlock-wait-text" 360; then
        exit 0
      else
        code="$?"
        if [ "$code" -eq 2 ]; then
          exit 1
        fi
      fi
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
