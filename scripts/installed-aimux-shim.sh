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

aimux_require_arg_value() {
  [ "$#" -gt 0 ] || return 1
  [ -n "$1" ] || return 1
  case "$1" in -*) return 1 ;; esac
  AIMUX_ARG_VALUE="$1"
}

aimux_require_inline_value() {
  [ -n "$1" ] || return 1
  AIMUX_ARG_VALUE="$1"
}

aimux_require_inline_arg_value() {
  aimux_require_inline_value "$1" || return 1
  case "$AIMUX_ARG_VALUE" in -*) return 1 ;; esac
}

aimux_require_any_arg_value() {
  [ "$#" -gt 0 ] || return 1
  [ -n "$1" ] || return 1
  AIMUX_ARG_VALUE="$1"
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

aimux_handle_fast_path_failure() {
  command_name="$1"
  code="$2"
  [ "$code" -eq 2 ] && exit 1
  if aimux_matching_daemon_port >/dev/null 2>&1; then
    printf 'Error: invalid or unsupported arguments for `aimux %s`.\n' "$command_name" >&2
    exit 1
  fi
}

aimux_args_include_help() {
  for arg do
    case "$arg" in
      -h | --help)
        return 0
        ;;
    esac
  done
  return 1
}

aimux_metadata_help_requested() {
  [ "$#" -eq 1 ] && return 0
  [ "${2:-}" = "help" ] && return 0
  aimux_args_include_help "$@"
}

aimux_try_daemon_ensure() {
  port="$(aimux_matching_daemon_port)" || return 1
  json="$(aimux_health_json "$port")"
  aimux_print_daemon_ensure "$json" "$port"
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
    curl -sS --max-time "$timeout" -o "$body_file" -w '%{http_code}' -X POST "$@" \
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

aimux_post_project_restart_open() {
  timeout="${1:-120}"
  shift
  port="$(aimux_matching_daemon_port)" || return 1
  body_file="$(mktemp "${TMPDIR:-/tmp}/aimux-project-restart-open.XXXXXX")" || return 1
  trap 'rm -f "$body_file"' EXIT
  trap 'rm -f "$body_file"; exit 130' INT TERM
  status="$(
    curl -sS --max-time "$timeout" -o "$body_file" -w '%{http_code}' -X POST "$@" \
      "http://127.0.0.1:$port/core/project-restart-text?json=1" 2>/dev/null || true
  )"
  case "$status" in
    '' | 000)
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 1
      ;;
  esac
  case "$status" in
    2*) ;;
    *)
      cat "$body_file" >&2
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 2
      ;;
  esac

  dashboard_session_name="$(sed -n 's/.*"dashboardSessionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | sed -n '1p')"
  project_root="$(sed -n 's/.*"projectRoot"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | sed -n '1p')"
  session_name="$(sed -n 's/.*"sessionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | sed -n '1p')"
  window_id="$(sed -n 's/.*"windowId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | sed -n '1p')"
  window_index="$(sed -n 's/.*"windowIndex"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$body_file" | sed -n '1p')"
  [ -n "$window_index" ] || window_index=0
  if [ -n "$dashboard_session_name" ]; then
    printf 'Restarted project service for %s\n' "$dashboard_session_name"
  else
    printf 'Restarted project service for %s\n' "$project_root"
  fi
  rm -f "$body_file"
  trap - EXIT INT TERM
  if [ -z "$session_name" ]; then
    printf 'Error: restarted project service, but no dashboard target was available to open\n' >&2
    return 2
  fi
  if ! command -v tmux >/dev/null 2>&1; then
    printf 'Error: restarted project service, but tmux is not available to open dashboard %s:%s\n' "$session_name" "$window_index" >&2
    return 2
  fi
  if ! tmux attach-session -t "$session_name:$window_index"; then
    printf 'Error: restarted project service, but failed to open dashboard %s:%s\n' "$session_name" "$window_index" >&2
    return 2
  fi
}

aimux_post_dashboard_open_route() {
  route_path="$1"
  success_kind="$2"
  timeout="${3:-120}"
  shift 3
  port="$(aimux_matching_daemon_port)" || return 1
  body_file="$(mktemp "${TMPDIR:-/tmp}/aimux-dashboard-open.XXXXXX")" || return 1
  trap 'rm -f "$body_file"' EXIT
  trap 'rm -f "$body_file"; exit 130' INT TERM
  status="$(
    curl -sS --max-time "$timeout" -o "$body_file" -w '%{http_code}' -X POST "$@" \
      "http://127.0.0.1:$port$route_path?json=1" 2>/dev/null || true
  )"
  case "$status" in
    '' | 000)
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 1
      ;;
  esac
  case "$status" in
    2*) ;;
    *)
      cat "$body_file" >&2
      rm -f "$body_file"
      trap - EXIT INT TERM
      return 2
      ;;
  esac

  dashboard_session_name="$(sed -n 's/.*"dashboardSessionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | sed -n '1p')"
  project_root="$(sed -n 's/.*"projectRoot"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | sed -n '1p')"
  session_name="$(sed -n 's/.*"sessionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | sed -n '1p')"
  window_index="$(sed -n 's/.*"windowIndex"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$body_file" | sed -n '1p')"
  [ -n "$window_index" ] || window_index=0
  case "$success_kind" in
    dashboard-reload)
      printf 'Reloaded dashboard for %s\n' "$dashboard_session_name"
      ;;
    runtime-restart)
      printf 'Restarted project runtime for %s\n' "$project_root"
      ;;
    *)
      cat "$body_file"
      ;;
  esac
  rm -f "$body_file"
  trap - EXIT INT TERM
  if [ -z "$session_name" ]; then
    printf 'Error: command completed, but no dashboard target was available to open\n' >&2
    return 2
  fi
  if [ "$success_kind" = "runtime-restart" ]; then
    printf 'Dashboard: %s:%s\n' "$dashboard_session_name" "$window_index"
  fi
  if ! command -v tmux >/dev/null 2>&1; then
    printf 'Error: command completed, but tmux is not available to open dashboard %s:%s\n' "$session_name" "$window_index" >&2
    return 2
  fi
  if ! tmux attach-session -t "$session_name:$window_index"; then
    printf 'Error: command completed, but failed to open dashboard %s:%s\n' "$session_name" "$window_index" >&2
    return 2
  fi
}

aimux_post_get_query_text_route() {
  path="$1"
  timeout="${2:-60}"
  shift 2
  port="$(aimux_matching_daemon_port)" || return 1
  body_file="$(mktemp "${TMPDIR:-/tmp}/aimux-core-query-post-get.XXXXXX")" || return 1
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

aimux_get_query_text_route() {
  path="$1"
  timeout="${2:-60}"
  shift 2
  port="$(aimux_matching_daemon_port)" || return 1
  body_file="$(mktemp "${TMPDIR:-/tmp}/aimux-core-query-get.XXXXXX")" || return 1
  trap 'rm -f "$body_file"' EXIT
  trap 'rm -f "$body_file"; exit 130' INT TERM
  status="$(
    curl -sS --max-time "$timeout" -o "$body_file" -w '%{http_code}' --get "$@" \
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
  project_root="${2:-}"
  [ -n "$project_root" ] || project_root="$(pwd -P 2>/dev/null)" || return 1
  aimux_get_query_text_route "$path" 5 --data-urlencode "project=$project_root"
}

aimux_curl_project_arg_text_route() {
  path="$1"
  project_root="$2"
  port="$(aimux_matching_daemon_port)" || return 1
  curl -fsS --max-time 60 -X POST --get --data-urlencode "project=$project_root" \
    "http://127.0.0.1:$port$path" 2>/dev/null || return 1
}

aimux_try_host_agent_read() {
  shift 2
  [ "$#" -gt 0 ] || return 1
  session_id="$1"
  case "$session_id" in -*) return 1 ;; esac
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  start_line="-120"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --start-line) shift; aimux_require_inline_value "${1:-}" || return 1; start_line="$AIMUX_ARG_VALUE" ;;
      --start-line=*) aimux_require_inline_value "${1#--start-line=}" || return 1; start_line="$AIMUX_ARG_VALUE" ;;
      *) return 1 ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  attempt=1
  while [ "$attempt" -le 3 ]; do
    aimux_get_query_text_route "/core/host-agent-read-text" 10 \
      --data-urlencode "project=$project_root" --data-urlencode "sessionId=$session_id" \
      --data-urlencode "startLine=$start_line"
    status="$?"
    [ "$status" -eq 0 ] && return 0
    [ "$status" -eq 2 ] && return 2
    attempt=$((attempt + 1))
    sleep 0.05
  done
  return 1
}

aimux_try_host_agent_stream() {
  shift 2
  [ "$#" -gt 0 ] || return 1
  session_id="$1"
  case "$session_id" in -*) return 1 ;; esac
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  start_line="-120"
  interval_ms="500"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --start-line) shift; aimux_require_inline_value "${1:-}" || return 1; start_line="$AIMUX_ARG_VALUE" ;;
      --start-line=*) aimux_require_inline_value "${1#--start-line=}" || return 1; start_line="$AIMUX_ARG_VALUE" ;;
      --interval-ms) shift; aimux_require_inline_value "${1:-}" || return 1; interval_ms="$AIMUX_ARG_VALUE" ;;
      --interval-ms=*) aimux_require_inline_value "${1#--interval-ms=}" || return 1; interval_ms="$AIMUX_ARG_VALUE" ;;
      *) return 1 ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  port="$(aimux_matching_daemon_port)" || return 1
  trap 'trap - INT TERM; exit 130' INT
  trap 'trap - INT TERM; exit 143' TERM
  if curl -fsS -N --get --data-urlencode "project=$project_root" --data-urlencode "sessionId=$session_id" \
    --data-urlencode "startLine=$start_line" --data-urlencode "intervalMs=$interval_ms" \
    "http://127.0.0.1:$port/core/host-agent-stream-text" 2>/dev/null; then
    trap - INT TERM
    return 0
  fi
  trap - INT TERM
  return 2
}

aimux_try_logs() {
  shift
  [ "$#" -gt 0 ] || return 1
  subcommand="$1"
  shift
  daemon=0
  project_root="$(pwd -P 2>/dev/null)" || return 1
  lines=""
  case "$subcommand" in
    path|tail|clear) ;;
    *) return 1 ;;
  esac
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --daemon)
        daemon=1
        ;;
      --project)
        shift
        aimux_require_any_arg_value "$@" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --project=*)
        aimux_require_inline_value "${1#--project=}" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      -n|--lines)
        [ "$subcommand" = "tail" ] || return 1
        shift
        aimux_require_any_arg_value "$@" || return 1
        lines="$AIMUX_ARG_VALUE"
        ;;
      --lines=*)
        [ "$subcommand" = "tail" ] || return 1
        aimux_require_inline_value "${1#--lines=}" || return 1
        lines="$AIMUX_ARG_VALUE"
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done
  set --
  if [ "$daemon" -eq 1 ]; then
    set -- --data-urlencode "daemon=1"
  else
    project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
    set -- --data-urlencode "project=$project_root"
  fi
  case "$subcommand" in
    path)
      aimux_get_query_text_route "/core/logs/path-text" 5 "$@"
      ;;
    tail)
      [ -n "$lines" ] && set -- "$@" --data-urlencode "lines=$lines"
      aimux_get_query_text_route "/core/logs/tail-text" 5 "$@"
      ;;
    clear)
      aimux_post_query_text_route "/core/logs/clear-text" 5 "$@"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_try_metadata() {
  project_root="$(pwd -P 2>/dev/null)" || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  metadata_arg_count="$#"
  while [ "$metadata_arg_count" -gt 0 ]; do
    metadata_arg="$1"
    shift
    metadata_arg_count=$((metadata_arg_count - 1))
    set -- "$@" --data-urlencode "arg=$metadata_arg"
  done
  set -- --data-urlencode "project=$project_root" "$@"
  aimux_post_get_query_text_route "/core/metadata-text" 30 "$@"
}

aimux_try_doctor() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    versions)
      shift
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      path="/core/doctor/versions-text"
      [ "$json" -eq 1 ] && path="/core/doctor/versions-text?json=1"
      aimux_curl_text_route "$path"
      ;;
    tmux)
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      session=""
      window_id=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project-root)
            shift
            aimux_require_arg_value "$@" || return 1
            project_root="$AIMUX_ARG_VALUE"
            ;;
          --project-root=*)
            aimux_require_inline_value "${1#--project-root=}" || return 1
            project_root="$AIMUX_ARG_VALUE"
            ;;
          --session)
            shift
            aimux_require_arg_value "$@" || return 1
            session="$AIMUX_ARG_VALUE"
            ;;
          --session=*)
            aimux_require_inline_value "${1#--session=}" || return 1
            session="$AIMUX_ARG_VALUE"
            ;;
          --window-id)
            shift
            aimux_require_arg_value "$@" || return 1
            window_id="$AIMUX_ARG_VALUE"
            ;;
          --window-id=*)
            aimux_require_inline_value "${1#--window-id=}" || return 1
            window_id="$AIMUX_ARG_VALUE"
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
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      path="/core/doctor/tmux-text"
      [ "$json" -eq 1 ] && path="/core/doctor/tmux-text?json=1"
      set -- --data-urlencode "projectRoot=$project_root"
      [ -n "$session" ] && set -- "$@" --data-urlencode "session=$session"
      [ -n "$window_id" ] && set -- "$@" --data-urlencode "windowId=$window_id"
      aimux_get_query_text_route "$path" 60 "$@"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_try_repair() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  open=0
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-root)
        shift
        aimux_require_arg_value "$@" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --project-root=*)
        aimux_require_inline_value "${1#--project-root=}" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --open)
        open=1
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
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  path="/core/repair-text"
  [ "$json" -eq 1 ] && path="/core/repair-text?json=1"
  aimux_post_query_text_route "$path" 120 --data-urlencode "projectRoot=$project_root" --data-urlencode "open=$open"
}

aimux_try_dashboard_reload() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  open=0
  client_tty=""
  current_client_session=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --open)
        open=1
        ;;
      --client-tty)
        shift
        aimux_require_arg_value "$@" || return 1
        client_tty="$AIMUX_ARG_VALUE"
        ;;
      --client-tty=*)
        aimux_require_inline_arg_value "${1#--client-tty=}" || return 1
        client_tty="$AIMUX_ARG_VALUE"
        ;;
      --current-client-session)
        shift
        aimux_require_arg_value "$@" || return 1
        current_client_session="$AIMUX_ARG_VALUE"
        ;;
      --current-client-session=*)
        aimux_require_inline_arg_value "${1#--current-client-session=}" || return 1
        current_client_session="$AIMUX_ARG_VALUE"
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  set -- --data-urlencode "projectRoot=$project_root"
  if [ "$open" -eq 1 ]; then
    if [ -z "$current_client_session" ] && [ -z "$client_tty" ] && [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
      current_client_session="$(tmux display-message -p "#{client_session}" 2>/dev/null || true)"
      client_tty="$(tmux display-message -p "#{client_tty}" 2>/dev/null || true)"
    fi
    if [ -n "$current_client_session" ] || [ -n "$client_tty" ]; then
      set -- "$@" --data-urlencode "open=1"
      [ -n "$current_client_session" ] && set -- "$@" --data-urlencode "currentClientSession=$current_client_session"
      [ -n "$client_tty" ] && set -- "$@" --data-urlencode "clientTty=$client_tty"
      aimux_post_query_text_route "/core/dashboard-reload-text" 120 "$@"
      return $?
    fi
    aimux_post_dashboard_open_route "/core/dashboard-reload-text" dashboard-reload 120 "$@"
    return $?
  fi
  aimux_post_query_text_route "/core/dashboard-reload-text" 120 "$@"
}

aimux_try_runtime_restart() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  open=0
  json=0
  client_tty=""
  current_client_session=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-root)
        shift
        aimux_require_arg_value "$@" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --project-root=*)
        aimux_require_inline_arg_value "${1#--project-root=}" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --open)
        open=1
        ;;
      --client-tty)
        shift
        aimux_require_arg_value "$@" || return 1
        client_tty="$AIMUX_ARG_VALUE"
        ;;
      --client-tty=*)
        aimux_require_inline_arg_value "${1#--client-tty=}" || return 1
        client_tty="$AIMUX_ARG_VALUE"
        ;;
      --current-client-session)
        shift
        aimux_require_arg_value "$@" || return 1
        current_client_session="$AIMUX_ARG_VALUE"
        ;;
      --current-client-session=*)
        aimux_require_inline_arg_value "${1#--current-client-session=}" || return 1
        current_client_session="$AIMUX_ARG_VALUE"
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
  if [ "$open" -eq 1 ] && [ "$json" -eq 1 ]; then
    printf 'Error: restart-runtime --open cannot be combined with --json\n' >&2
    return 2
  fi
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  set -- --data-urlencode "projectRoot=$project_root"
  if [ "$open" -eq 1 ]; then
    if [ -z "$current_client_session" ] && [ -z "$client_tty" ] && [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
      current_client_session="$(tmux display-message -p "#{client_session}" 2>/dev/null || true)"
      client_tty="$(tmux display-message -p "#{client_tty}" 2>/dev/null || true)"
    fi
    if [ -n "$current_client_session" ] || [ -n "$client_tty" ]; then
      set -- "$@" --data-urlencode "open=1"
      [ -n "$current_client_session" ] && set -- "$@" --data-urlencode "currentClientSession=$current_client_session"
      [ -n "$client_tty" ] && set -- "$@" --data-urlencode "clientTty=$client_tty"
      aimux_post_query_text_route "/core/runtime-restart-text" 120 "$@"
      return $?
    fi
    aimux_post_dashboard_open_route "/core/runtime-restart-text" runtime-restart 120 "$@"
    return $?
  fi
  path="/core/runtime-restart-text"
  [ "$json" -eq 1 ] && path="/core/runtime-restart-text?json=1"
  aimux_post_query_text_route "$path" 120 "$@"
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

aimux_resolve_path_arg() {
  path_arg="$1"
  case "$path_arg" in
    /*) printf '%s\n' "$path_arg" ;;
    *) printf '%s/%s\n' "$(pwd -P)" "$path_arg" ;;
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

aimux_try_project_serve() {
  shift
  [ "$#" -eq 0 ] || return 1
  project_root="$(pwd -P 2>/dev/null)" || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  aimux_post_query_text_route "/core/project-serve-text" 120 --data-urlencode "project=$project_root"
}

aimux_try_host_service() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    stop|kill|restart) ;;
    *) return 1 ;;
  esac
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  serve=0
  open=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --serve)
        [ "$subcommand" = "restart" ] || return 1
        serve=1
        ;;
      --open)
        [ "$subcommand" = "restart" ] || return 1
        open=1
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  case "$subcommand" in
    stop) path="/core/project-stop-text" ;;
    kill) path="/core/project-kill-text" ;;
    restart) path="/core/project-restart-text" ;;
    *) return 1 ;;
  esac
  set -- --data-urlencode "project=$project_root"
  [ "$serve" -eq 1 ] && set -- "$@" --data-urlencode "serve=1"
  if [ "$open" -eq 1 ]; then
    if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
      current_client_session="$(tmux display-message -p "#{client_session}" 2>/dev/null || true)"
      client_tty="$(tmux display-message -p "#{client_tty}" 2>/dev/null || true)"
      if [ "$serve" -eq 0 ] && { [ -n "$current_client_session" ] || [ -n "$client_tty" ]; }; then
        set -- "$@" --data-urlencode "open=1"
        [ -n "$current_client_session" ] && set -- "$@" --data-urlencode "currentClientSession=$current_client_session"
        [ -n "$client_tty" ] && set -- "$@" --data-urlencode "clientTty=$client_tty"
        aimux_post_query_text_route "$path" 120 "$@"
        return $?
      fi
    fi
    aimux_post_project_restart_open 120 "$@"
    return $?
  fi
  aimux_post_query_text_route "$path" 120 "$@"
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

aimux_is_project_runtime_stop_args() {
  [ "${1:-}" = "stop" ] || return 1
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project)
        shift
        aimux_require_arg_value "$@" || return 1
        ;;
      --project=*)
        aimux_require_inline_value "${1#--project=}" || return 1
        ;;
      --json)
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done
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
  path="/core/lifecycle/fork-text"
  [ "$json" -eq 1 ] && path="/core/lifecycle/fork-text?json=1"
  set -- --data-urlencode "project=$project_root" --data-urlencode "sourceSessionId=$source_session_id" \
    --data-urlencode "tool=$tool" --data-urlencode "open=$open"
  [ -n "$worktree_path" ] && set -- "$@" --data-urlencode "worktreePath=$worktree_path"
  [ -n "$instruction" ] && set -- "$@" --data-urlencode "instruction=$instruction"
  aimux_post_query_text_route "$path" 120 "$@"
}

aimux_try_agent_input() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  session_id=""
  text=""
  literal=0
  while [ "$#" -gt 0 ]; do
    if [ "$literal" -eq 1 ]; then
      if [ -z "$session_id" ]; then
        session_id="$1"
      else
        text="${text:+$text }$1"
      fi
      shift
      continue
    fi
    case "$1" in
      --project)
        shift
        aimux_require_arg_value "$@" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --project=*)
        aimux_require_inline_value "${1#--project=}" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --)
        literal=1
        ;;
      -*)
        return 1
        ;;
      *)
        if [ -z "$session_id" ]; then
          session_id="$1"
        else
          text="${text:+$text }$1"
        fi
        ;;
    esac
    shift
  done
  [ -n "$session_id" ] || return 1
  [ -n "$text" ] || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  aimux_post_query_text_route "/core/agents/input-text" 120 \
    --data-urlencode "project=$project_root" \
    --data-urlencode "sessionId=$session_id" \
    --data-urlencode "text=$text"
}

aimux_try_agent_ps() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project)
        shift
        aimux_require_arg_value "$@" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --project=*)
        aimux_require_inline_value "${1#--project=}" || return 1
        project_root="$AIMUX_ARG_VALUE"
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
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  path="/core/agents/ps-text"
  [ "$json" -eq 1 ] && path="/core/agents/ps-text?json=1"
  aimux_get_query_text_route "$path" 60 --data-urlencode "project=$project_root"
}

aimux_try_agent_rename() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  session_id=""
  label=""
  label_set=0
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project)
        shift
        aimux_require_arg_value "$@" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --project=*)
        aimux_require_inline_value "${1#--project=}" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --label)
        shift
        [ "$#" -gt 0 ] || return 1
        label="$1"
        label_set=1
        ;;
      --label=*)
        label="${1#--label=}"
        label_set=1
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
  [ "$label_set" -eq 1 ] || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  path="/core/agents/rename-text"
  [ "$json" -eq 1 ] && path="/core/agents/rename-text?json=1"
  aimux_post_query_text_route "$path" 120 \
    --data-urlencode "project=$project_root" \
    --data-urlencode "sessionId=$session_id" \
    --data-urlencode "label=$label"
}

aimux_try_agent_migrate() {
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  session_id=""
  worktree_path=""
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project)
        shift
        aimux_require_arg_value "$@" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --project=*)
        aimux_require_inline_value "${1#--project=}" || return 1
        project_root="$AIMUX_ARG_VALUE"
        ;;
      --worktree)
        shift
        aimux_require_arg_value "$@" || return 1
        worktree_path="$AIMUX_ARG_VALUE"
        ;;
      --worktree=*)
        aimux_require_inline_value "${1#--worktree=}" || return 1
        worktree_path="$AIMUX_ARG_VALUE"
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
  [ -n "$worktree_path" ] || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  path="/core/agents/migrate-text"
  [ "$json" -eq 1 ] && path="/core/agents/migrate-text?json=1"
  aimux_post_query_text_route "$path" 120 \
    --data-urlencode "project=$project_root" \
    --data-urlencode "sessionId=$session_id" \
    --data-urlencode "worktreePath=$worktree_path"
}

aimux_try_loop() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    add|remove)
      action="$subcommand"
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      session_id=""
      goal=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --goal) [ "$action" = "add" ] || return 1; shift; aimux_require_arg_value "$@" || return 1; goal="$AIMUX_ARG_VALUE" ;;
          --goal=*) [ "$action" = "add" ] || return 1; aimux_require_inline_value "${1#--goal=}" || return 1; goal="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          -*) return 1 ;;
          *) [ -z "$session_id" ] || return 1; session_id="$1" ;;
        esac
        shift
      done
      [ -n "$session_id" ] || return 1
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      case "$action" in
        add) path="/core/loop/add-text" ;;
        remove) path="/core/loop/remove-text" ;;
        *) return 1 ;;
      esac
      [ "$json" -eq 1 ] && path="$path?json=1"
      set -- --data-urlencode "project=$project_root" --data-urlencode "sessionId=$session_id"
      [ -n "$goal" ] && set -- "$@" --data-urlencode "goal=$goal"
      aimux_post_query_text_route "$path" 120 "$@"
      ;;
    done|block)
      action="$subcommand"
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      session_id="${AIMUX_SESSION_ID:-}"
      reason=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --session) shift; aimux_require_arg_value "$@" || return 1; session_id="$AIMUX_ARG_VALUE" ;;
          --session=*) aimux_require_inline_value "${1#--session=}" || return 1; session_id="$AIMUX_ARG_VALUE" ;;
          --reason) shift; aimux_require_arg_value "$@" || return 1; reason="$AIMUX_ARG_VALUE" ;;
          --reason=*) aimux_require_inline_value "${1#--reason=}" || return 1; reason="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      [ -n "$session_id" ] || return 1
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      case "$action" in
        done) path="/core/loop/done-text" ;;
        block) path="/core/loop/block-text" ;;
        *) return 1 ;;
      esac
      [ "$json" -eq 1 ] && path="$path?json=1"
      set -- --data-urlencode "project=$project_root" --data-urlencode "sessionId=$session_id"
      [ -n "$reason" ] && set -- "$@" --data-urlencode "reason=$reason"
      aimux_post_query_text_route "$path" 120 "$@"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_try_overseer() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    start)
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      worktree_path=""
      tool=""
      open=1
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --tool) shift; aimux_require_arg_value "$@" || return 1; tool="$AIMUX_ARG_VALUE" ;;
          --tool=*) aimux_require_inline_value "${1#--tool=}" || return 1; tool="$AIMUX_ARG_VALUE" ;;
          --worktree) shift; aimux_require_arg_value "$@" || return 1; worktree_path="$AIMUX_ARG_VALUE" ;;
          --worktree=*) aimux_require_inline_value "${1#--worktree=}" || return 1; worktree_path="$AIMUX_ARG_VALUE" ;;
          --no-open) open=0 ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      path="/core/overseer/start-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      set -- --data-urlencode "project=$project_root" --data-urlencode "open=$open"
      [ -n "$tool" ] && set -- "$@" --data-urlencode "tool=$tool"
      [ -n "$worktree_path" ] && set -- "$@" --data-urlencode "worktreePath=$worktree_path"
      aimux_post_query_text_route "$path" 120 "$@"
      ;;
    clear)
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      session_id=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          -*) return 1 ;;
          *) [ -z "$session_id" ] || return 1; session_id="$1" ;;
        esac
        shift
      done
      [ -n "$session_id" ] || return 1
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      path="/core/overseer/clear-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 --data-urlencode "project=$project_root" --data-urlencode "sessionId=$session_id"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_try_team() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    show|init)
      action="$subcommand"
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      case "$action" in
        show) path="/core/team/show-text"; [ "$json" -eq 1 ] && path="$path?json=1"; aimux_get_query_text_route "$path" 60 --data-urlencode "project=$project_root" ;;
        init) path="/core/team/init-text"; [ "$json" -eq 1 ] && path="$path?json=1"; aimux_post_query_text_route "$path" 120 --data-urlencode "project=$project_root" ;;
        *) return 1 ;;
      esac
      ;;
    add)
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      role=""
      description=""
      reviewed_by=""
      can_edit=0
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          -d|--description) shift; aimux_require_arg_value "$@" || return 1; description="$AIMUX_ARG_VALUE" ;;
          --description=*) aimux_require_inline_value "${1#--description=}" || return 1; description="$AIMUX_ARG_VALUE" ;;
          --reviewed-by) shift; aimux_require_arg_value "$@" || return 1; reviewed_by="$AIMUX_ARG_VALUE" ;;
          --reviewed-by=*) aimux_require_inline_value "${1#--reviewed-by=}" || return 1; reviewed_by="$AIMUX_ARG_VALUE" ;;
          --can-edit) can_edit=1 ;;
          --json) json=1 ;;
          -*) return 1 ;;
          *) [ -z "$role" ] || return 1; role="$1" ;;
        esac
        shift
      done
      [ -n "$role" ] || return 1
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      path="/core/team/add-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      set -- --data-urlencode "project=$project_root" --data-urlencode "role=$role" --data-urlencode "canEdit=$can_edit"
      [ -n "$description" ] && set -- "$@" --data-urlencode "description=$description"
      [ -n "$reviewed_by" ] && set -- "$@" --data-urlencode "reviewedBy=$reviewed_by"
      aimux_post_query_text_route "$path" 120 "$@"
      ;;
    remove|default)
      action="$subcommand"
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      role=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          -*) return 1 ;;
          *) [ -z "$role" ] || return 1; role="$1" ;;
        esac
        shift
      done
      [ -n "$role" ] || return 1
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      case "$action" in
        remove) path="/core/team/remove-text" ;;
        default) path="/core/team/default-text" ;;
        *) return 1 ;;
      esac
      [ "$json" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 --data-urlencode "project=$project_root" --data-urlencode "role=$role"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_parse_project_json_args() {
  project_root="$(pwd -P 2>/dev/null)" || return 1
  json=0
  dry_run=0
  allow_dry_run="${AIMUX_PARSE_ALLOW_DRY_RUN:-0}"
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
      --dry-run)
        [ "$allow_dry_run" -eq 1 ] || return 1
        dry_run=1
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  AIMUX_PARSED_PROJECT="$project_root"
  AIMUX_PARSED_JSON="$json"
  AIMUX_PARSED_DRY_RUN="$dry_run"
}

aimux_try_worktree() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    ""|list)
      if [ "$subcommand" = "list" ]; then
        shift
      fi
      aimux_parse_project_json_args "$@" || return 1
      path="/core/worktree/list-text"
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="/core/worktree/list-text?json=1"
      aimux_curl_project_text_route "$path" "$AIMUX_PARSED_PROJECT"
      ;;
    create)
      shift
      [ "$#" -gt 0 ] || return 1
      name="$1"
      case "$name" in -*) return 1 ;; esac
      shift
      aimux_parse_project_json_args "$@" || return 1
      path="/core/worktree/create-text"
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="/core/worktree/create-text?json=1"
      aimux_post_query_text_route "$path" 120 \
        --data-urlencode "project=$AIMUX_PARSED_PROJECT" --data-urlencode "name=$name"
      ;;
    remove|graveyard|resurrect|delete-graveyard)
      action="$subcommand"
      shift
      [ "$#" -gt 0 ] || return 1
      target_path="$1"
      case "$target_path" in -*) return 1 ;; esac
      target_path="$(aimux_resolve_path_arg "$target_path")" || return 1
      shift
      aimux_parse_project_json_args "$@" || return 1
      case "$action" in
        remove) path="/core/worktree/remove-text" ;;
        graveyard) path="/core/worktree/graveyard-text" ;;
        resurrect) path="/core/worktree/resurrect-text" ;;
        delete-graveyard) path="/core/worktree/delete-graveyard-text" ;;
      esac
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 \
        --data-urlencode "project=$AIMUX_PARSED_PROJECT" --data-urlencode "path=$target_path"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_try_graveyard() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    list)
      shift
      aimux_parse_project_json_args "$@" || return 1
      path="/core/graveyard/list-text"
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="/core/graveyard/list-text?json=1"
      aimux_curl_project_text_route "$path" "$AIMUX_PARSED_PROJECT"
      ;;
    send|resurrect)
      action="$subcommand"
      shift
      [ "$#" -gt 0 ] || return 1
      session_id="$1"
      case "$session_id" in -*) return 1 ;; esac
      shift
      aimux_parse_project_json_args "$@" || return 1
      case "$action" in
        send) path="/core/graveyard/send-text" ;;
        resurrect) path="/core/graveyard/resurrect-text" ;;
      esac
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 \
        --data-urlencode "project=$AIMUX_PARSED_PROJECT" --data-urlencode "sessionId=$session_id"
      ;;
    cleanup)
      shift
      AIMUX_PARSE_ALLOW_DRY_RUN=1
      aimux_parse_project_json_args "$@" || {
        AIMUX_PARSE_ALLOW_DRY_RUN=0
        return 1
      }
      AIMUX_PARSE_ALLOW_DRY_RUN=0
      path="/core/graveyard/cleanup-text"
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="/core/graveyard/cleanup-text?json=1"
      aimux_post_query_text_route "$path" 120 \
        --data-urlencode "project=$AIMUX_PARSED_PROJECT" --data-urlencode "dryRun=$AIMUX_PARSED_DRY_RUN"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_try_threads() {
  shift
  aimux_parse_project_json_args_with_session "$@" || return 1
  path="/core/threads/list-text"
  [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="$path?json=1"
  set -- --data-urlencode "project=$AIMUX_PARSED_PROJECT"
  [ -n "$AIMUX_PARSED_SESSION" ] && set -- "$@" --data-urlencode "session=$AIMUX_PARSED_SESSION"
  aimux_get_query_text_route "$path" 60 "$@"
}

aimux_parse_project_json_args_with_session() {
  project_root="$(pwd -P 2>/dev/null)" || return 1
  json=0
  session=""
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
      --session)
        shift
        [ "$#" -gt 0 ] || return 1
        case "$1" in -*) return 1 ;; esac
        session="$1"
        ;;
      --session=*)
        session="${1#--session=}"
        [ -n "$session" ] || return 1
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
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  AIMUX_PARSED_PROJECT="$project_root"
  AIMUX_PARSED_JSON="$json"
  AIMUX_PARSED_SESSION="$session"
}

aimux_try_thread() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    list)
      shift
      aimux_parse_project_json_args_with_session "$@" || return 1
      path="/core/thread/list-text"
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="$path?json=1"
      set -- --data-urlencode "project=$AIMUX_PARSED_PROJECT"
      [ -n "$AIMUX_PARSED_SESSION" ] && set -- "$@" --data-urlencode "session=$AIMUX_PARSED_SESSION"
      aimux_get_query_text_route "$path" 60 "$@"
      ;;
    show)
      shift
      [ "$#" -gt 0 ] || return 1
      thread_id="$1"
      case "$thread_id" in -*) return 1 ;; esac
      shift
      aimux_parse_project_json_args "$@" || return 1
      path="/core/thread/show-text"
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="$path?json=1"
      aimux_get_query_text_route "$path" 60 \
        --data-urlencode "project=$AIMUX_PARSED_PROJECT" --data-urlencode "threadId=$thread_id"
      ;;
    open)
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      title=""
      from=""
      participants=""
      kind="conversation"
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --title) shift; aimux_require_arg_value "$@" || return 1; title="$AIMUX_ARG_VALUE" ;;
          --title=*) aimux_require_inline_value "${1#--title=}" || return 1; title="$AIMUX_ARG_VALUE" ;;
          --from) shift; aimux_require_arg_value "$@" || return 1; from="$AIMUX_ARG_VALUE" ;;
          --from=*) aimux_require_inline_value "${1#--from=}" || return 1; from="$AIMUX_ARG_VALUE" ;;
          --participants) shift; aimux_require_arg_value "$@" || return 1; participants="$AIMUX_ARG_VALUE" ;;
          --participants=*) aimux_require_inline_value "${1#--participants=}" || return 1; participants="$AIMUX_ARG_VALUE" ;;
          --kind) shift; aimux_require_arg_value "$@" || return 1; kind="$AIMUX_ARG_VALUE" ;;
          --kind=*) aimux_require_inline_value "${1#--kind=}" || return 1; kind="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      [ -n "$title" ] || return 1
      [ -n "$from" ] || return 1
      [ -n "$participants" ] || return 1
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      path="/core/thread/open-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 \
        --data-urlencode "project=$project_root" --data-urlencode "title=$title" \
        --data-urlencode "from=$from" --data-urlencode "participants=$participants" --data-urlencode "kind=$kind"
      ;;
    send)
      shift
      [ "$#" -gt 1 ] || return 1
      thread_id="$1"
      body="$2"
      case "$thread_id" in -*) return 1 ;; esac
      shift 2
      project_root="$(pwd -P 2>/dev/null)" || return 1
      from=""
      to=""
      kind="note"
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --from) shift; aimux_require_arg_value "$@" || return 1; from="$AIMUX_ARG_VALUE" ;;
          --from=*) aimux_require_inline_value "${1#--from=}" || return 1; from="$AIMUX_ARG_VALUE" ;;
          --to) shift; aimux_require_arg_value "$@" || return 1; to="$AIMUX_ARG_VALUE" ;;
          --to=*) aimux_require_inline_value "${1#--to=}" || return 1; to="$AIMUX_ARG_VALUE" ;;
          --kind) shift; aimux_require_arg_value "$@" || return 1; kind="$AIMUX_ARG_VALUE" ;;
          --kind=*) aimux_require_inline_value "${1#--kind=}" || return 1; kind="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      [ -n "$from" ] || return 1
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      set -- --data-urlencode "project=$project_root" --data-urlencode "threadId=$thread_id" \
        --data-urlencode "body=$body" --data-urlencode "from=$from" --data-urlencode "kind=$kind"
      [ -n "$to" ] && set -- "$@" --data-urlencode "to=$to"
      path="/core/thread/send-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 "$@"
      ;;
    mark-seen)
      shift
      [ "$#" -gt 0 ] || return 1
      thread_id="$1"
      case "$thread_id" in -*) return 1 ;; esac
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      session=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --session) shift; aimux_require_arg_value "$@" || return 1; session="$AIMUX_ARG_VALUE" ;;
          --session=*) aimux_require_inline_value "${1#--session=}" || return 1; session="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      [ -n "$session" ] || return 1
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      path="/core/thread/mark-seen-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 \
        --data-urlencode "project=$project_root" --data-urlencode "threadId=$thread_id" --data-urlencode "session=$session"
      ;;
    status)
      shift
      [ "$#" -gt 0 ] || return 1
      thread_id="$1"
      case "$thread_id" in -*) return 1 ;; esac
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      status=""
      owner=""
      waiting_on=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --status) shift; aimux_require_arg_value "$@" || return 1; status="$AIMUX_ARG_VALUE" ;;
          --status=*) aimux_require_inline_value "${1#--status=}" || return 1; status="$AIMUX_ARG_VALUE" ;;
          --owner) shift; aimux_require_arg_value "$@" || return 1; owner="$AIMUX_ARG_VALUE" ;;
          --owner=*) aimux_require_inline_value "${1#--owner=}" || return 1; owner="$AIMUX_ARG_VALUE" ;;
          --waiting-on) shift; aimux_require_arg_value "$@" || return 1; waiting_on="$AIMUX_ARG_VALUE" ;;
          --waiting-on=*) aimux_require_inline_value "${1#--waiting-on=}" || return 1; waiting_on="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      [ -n "$status" ] || return 1
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      set -- --data-urlencode "project=$project_root" --data-urlencode "threadId=$thread_id" \
        --data-urlencode "status=$status"
      [ -n "$owner" ] && set -- "$@" --data-urlencode "owner=$owner"
      [ -n "$waiting_on" ] && set -- "$@" --data-urlencode "waitingOn=$waiting_on"
      path="/core/thread/status-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 "$@"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_try_message() {
  shift
  [ "${1:-}" = "send" ] || return 1
  shift
  [ "$#" -gt 0 ] || return 1
  body="$1"
  case "$body" in -*) return 1 ;; esac
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  from="user"
  to=""
  assignee=""
  tool=""
  worktree=""
  title=""
  kind="request"
  thread=""
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --to) shift; aimux_require_arg_value "$@" || return 1; to="$AIMUX_ARG_VALUE" ;;
      --to=*) aimux_require_inline_value "${1#--to=}" || return 1; to="$AIMUX_ARG_VALUE" ;;
      --assignee) shift; aimux_require_arg_value "$@" || return 1; assignee="$AIMUX_ARG_VALUE" ;;
      --assignee=*) aimux_require_inline_value "${1#--assignee=}" || return 1; assignee="$AIMUX_ARG_VALUE" ;;
      --tool) shift; aimux_require_arg_value "$@" || return 1; tool="$AIMUX_ARG_VALUE" ;;
      --tool=*) aimux_require_inline_value "${1#--tool=}" || return 1; tool="$AIMUX_ARG_VALUE" ;;
      --worktree) shift; aimux_require_arg_value "$@" || return 1; worktree="$AIMUX_ARG_VALUE" ;;
      --worktree=*) aimux_require_inline_value "${1#--worktree=}" || return 1; worktree="$AIMUX_ARG_VALUE" ;;
      --from) shift; aimux_require_arg_value "$@" || return 1; from="$AIMUX_ARG_VALUE" ;;
      --from=*) aimux_require_inline_value "${1#--from=}" || return 1; from="$AIMUX_ARG_VALUE" ;;
      --title) shift; aimux_require_arg_value "$@" || return 1; title="$AIMUX_ARG_VALUE" ;;
      --title=*) aimux_require_inline_value "${1#--title=}" || return 1; title="$AIMUX_ARG_VALUE" ;;
      --kind) shift; aimux_require_arg_value "$@" || return 1; kind="$AIMUX_ARG_VALUE" ;;
      --kind=*) aimux_require_inline_value "${1#--kind=}" || return 1; kind="$AIMUX_ARG_VALUE" ;;
      --thread) shift; aimux_require_arg_value "$@" || return 1; thread="$AIMUX_ARG_VALUE" ;;
      --thread=*) aimux_require_inline_value "${1#--thread=}" || return 1; thread="$AIMUX_ARG_VALUE" ;;
      --json) json=1 ;;
      *) return 1 ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  set -- --data-urlencode "project=$project_root" --data-urlencode "body=$body" \
    --data-urlencode "from=$from" --data-urlencode "kind=$kind"
  [ -n "$to" ] && set -- "$@" --data-urlencode "to=$to"
  [ -n "$assignee" ] && set -- "$@" --data-urlencode "assignee=$assignee"
  [ -n "$tool" ] && set -- "$@" --data-urlencode "tool=$tool"
  [ -n "$worktree" ] && set -- "$@" --data-urlencode "worktree=$worktree"
  [ -n "$title" ] && set -- "$@" --data-urlencode "title=$title"
  [ -n "$thread" ] && set -- "$@" --data-urlencode "thread=$thread"
  path="/core/message/send-text"
  [ "$json" -eq 1 ] && path="$path?json=1"
  aimux_post_query_text_route "$path" 120 "$@"
}

aimux_try_handoff() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    send)
      shift
      [ "$#" -gt 0 ] || return 1
      body="$1"
      case "$body" in -*) return 1 ;; esac
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      from="user"
      to=""
      assignee=""
      tool=""
      worktree=""
      title=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --from) shift; aimux_require_arg_value "$@" || return 1; from="$AIMUX_ARG_VALUE" ;;
          --from=*) aimux_require_inline_value "${1#--from=}" || return 1; from="$AIMUX_ARG_VALUE" ;;
          --to) shift; aimux_require_arg_value "$@" || return 1; to="$AIMUX_ARG_VALUE" ;;
          --to=*) aimux_require_inline_value "${1#--to=}" || return 1; to="$AIMUX_ARG_VALUE" ;;
          --assignee) shift; aimux_require_arg_value "$@" || return 1; assignee="$AIMUX_ARG_VALUE" ;;
          --assignee=*) aimux_require_inline_value "${1#--assignee=}" || return 1; assignee="$AIMUX_ARG_VALUE" ;;
          --tool) shift; aimux_require_arg_value "$@" || return 1; tool="$AIMUX_ARG_VALUE" ;;
          --tool=*) aimux_require_inline_value "${1#--tool=}" || return 1; tool="$AIMUX_ARG_VALUE" ;;
          --worktree) shift; aimux_require_arg_value "$@" || return 1; worktree="$AIMUX_ARG_VALUE" ;;
          --worktree=*) aimux_require_inline_value "${1#--worktree=}" || return 1; worktree="$AIMUX_ARG_VALUE" ;;
          --title) shift; aimux_require_arg_value "$@" || return 1; title="$AIMUX_ARG_VALUE" ;;
          --title=*) aimux_require_inline_value "${1#--title=}" || return 1; title="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      set -- --data-urlencode "project=$project_root" --data-urlencode "body=$body" --data-urlencode "from=$from"
      [ -n "$to" ] && set -- "$@" --data-urlencode "to=$to"
      [ -n "$assignee" ] && set -- "$@" --data-urlencode "assignee=$assignee"
      [ -n "$tool" ] && set -- "$@" --data-urlencode "tool=$tool"
      [ -n "$worktree" ] && set -- "$@" --data-urlencode "worktree=$worktree"
      [ -n "$title" ] && set -- "$@" --data-urlencode "title=$title"
      path="/core/handoff/send-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 "$@"
      ;;
    accept|complete)
      action="$subcommand"
      shift
      aimux_parse_thread_action_args "$@" || return 1
      case "$action" in
        accept) path="/core/handoff/accept-text" ;;
        complete) path="/core/handoff/complete-text" ;;
        *) return 1 ;;
      esac
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="$path?json=1"
      set -- --data-urlencode "project=$AIMUX_PARSED_PROJECT" --data-urlencode "threadId=$AIMUX_PARSED_THREAD" \
        --data-urlencode "from=$AIMUX_PARSED_FROM"
      [ -n "$AIMUX_PARSED_BODY" ] && set -- "$@" --data-urlencode "body=$AIMUX_PARSED_BODY"
      aimux_post_query_text_route "$path" 120 "$@"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_parse_thread_action_args() {
  [ "$#" -gt 0 ] || return 1
  thread_id="$1"
  case "$thread_id" in -*) return 1 ;; esac
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  from="user"
  body=""
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --from) shift; aimux_require_arg_value "$@" || return 1; from="$AIMUX_ARG_VALUE" ;;
      --from=*) aimux_require_inline_value "${1#--from=}" || return 1; from="$AIMUX_ARG_VALUE" ;;
      --body) shift; aimux_require_arg_value "$@" || return 1; body="$AIMUX_ARG_VALUE" ;;
      --body=*) aimux_require_inline_value "${1#--body=}" || return 1; body="$AIMUX_ARG_VALUE" ;;
      --json) json=1 ;;
      *) return 1 ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  AIMUX_PARSED_PROJECT="$project_root"
  AIMUX_PARSED_THREAD="$thread_id"
  AIMUX_PARSED_FROM="$from"
  AIMUX_PARSED_BODY="$body"
  AIMUX_PARSED_JSON="$json"
}

aimux_try_task() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    list)
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      session=""
      status=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --session) shift; aimux_require_arg_value "$@" || return 1; session="$AIMUX_ARG_VALUE" ;;
          --session=*) aimux_require_inline_value "${1#--session=}" || return 1; session="$AIMUX_ARG_VALUE" ;;
          --status) shift; aimux_require_arg_value "$@" || return 1; status="$AIMUX_ARG_VALUE" ;;
          --status=*) aimux_require_inline_value "${1#--status=}" || return 1; status="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      path="/core/task/list-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      set -- --data-urlencode "project=$project_root"
      [ -n "$session" ] && set -- "$@" --data-urlencode "session=$session"
      [ -n "$status" ] && set -- "$@" --data-urlencode "status=$status"
      aimux_get_query_text_route "$path" 60 "$@"
      ;;
    show)
      shift
      [ "$#" -gt 0 ] || return 1
      task_id="$1"
      case "$task_id" in -*) return 1 ;; esac
      shift
      aimux_parse_project_json_args "$@" || return 1
      path="/core/task/show-text"
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="$path?json=1"
      aimux_get_query_text_route "$path" 60 \
        --data-urlencode "project=$AIMUX_PARSED_PROJECT" --data-urlencode "taskId=$task_id"
      ;;
    assign)
      shift
      [ "$#" -gt 0 ] || return 1
      description="$1"
      case "$description" in -*) return 1 ;; esac
      shift
      project_root="$(pwd -P 2>/dev/null)" || return 1
      from="user"
      to=""
      assignee=""
      tool=""
      prompt=""
      type="task"
      diff=""
      worktree=""
      json=0
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
          --from) shift; aimux_require_arg_value "$@" || return 1; from="$AIMUX_ARG_VALUE" ;;
          --from=*) aimux_require_inline_value "${1#--from=}" || return 1; from="$AIMUX_ARG_VALUE" ;;
          --to) shift; aimux_require_arg_value "$@" || return 1; to="$AIMUX_ARG_VALUE" ;;
          --to=*) aimux_require_inline_value "${1#--to=}" || return 1; to="$AIMUX_ARG_VALUE" ;;
          --assignee) shift; aimux_require_arg_value "$@" || return 1; assignee="$AIMUX_ARG_VALUE" ;;
          --assignee=*) aimux_require_inline_value "${1#--assignee=}" || return 1; assignee="$AIMUX_ARG_VALUE" ;;
          --tool) shift; aimux_require_arg_value "$@" || return 1; tool="$AIMUX_ARG_VALUE" ;;
          --tool=*) aimux_require_inline_value "${1#--tool=}" || return 1; tool="$AIMUX_ARG_VALUE" ;;
          --prompt) shift; aimux_require_arg_value "$@" || return 1; prompt="$AIMUX_ARG_VALUE" ;;
          --prompt=*) aimux_require_inline_value "${1#--prompt=}" || return 1; prompt="$AIMUX_ARG_VALUE" ;;
          --type) shift; aimux_require_arg_value "$@" || return 1; type="$AIMUX_ARG_VALUE" ;;
          --type=*) aimux_require_inline_value "${1#--type=}" || return 1; type="$AIMUX_ARG_VALUE" ;;
          --diff) shift; [ "$#" -gt 0 ] || return 1; [ -n "$1" ] || return 1; diff="$1" ;;
          --diff=*) aimux_require_inline_value "${1#--diff=}" || return 1; diff="$AIMUX_ARG_VALUE" ;;
          --worktree) shift; aimux_require_arg_value "$@" || return 1; worktree="$AIMUX_ARG_VALUE" ;;
          --worktree=*) aimux_require_inline_value "${1#--worktree=}" || return 1; worktree="$AIMUX_ARG_VALUE" ;;
          --json) json=1 ;;
          *) return 1 ;;
        esac
        shift
      done
      project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
      set -- --data-urlencode "project=$project_root" --data-urlencode "description=$description" \
        --data-urlencode "from=$from" --data-urlencode "type=$type"
      [ -n "$to" ] && set -- "$@" --data-urlencode "to=$to"
      [ -n "$assignee" ] && set -- "$@" --data-urlencode "assignee=$assignee"
      [ -n "$tool" ] && set -- "$@" --data-urlencode "tool=$tool"
      [ -n "$prompt" ] && set -- "$@" --data-urlencode "prompt=$prompt"
      [ -n "$diff" ] && set -- "$@" --data-urlencode "diff=$diff"
      [ -n "$worktree" ] && set -- "$@" --data-urlencode "worktree=$worktree"
      path="/core/task/assign-text"
      [ "$json" -eq 1 ] && path="$path?json=1"
      aimux_post_query_text_route "$path" 120 "$@"
      ;;
    accept|block|complete|reopen)
      action="$subcommand"
      shift
      aimux_parse_task_action_args "$@" || return 1
      case "$action" in
        accept) path="/core/task/accept-text" ;;
        block) path="/core/task/block-text" ;;
        complete) path="/core/task/complete-text" ;;
        reopen) path="/core/task/reopen-text" ;;
        *) return 1 ;;
      esac
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="$path?json=1"
      aimux_post_task_action "$path"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_parse_task_action_args() {
  [ "$#" -gt 0 ] || return 1
  task_id="$1"
  case "$task_id" in -*) return 1 ;; esac
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  from="user"
  body=""
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --from) shift; aimux_require_arg_value "$@" || return 1; from="$AIMUX_ARG_VALUE" ;;
      --from=*) aimux_require_inline_value "${1#--from=}" || return 1; from="$AIMUX_ARG_VALUE" ;;
      --body) shift; aimux_require_arg_value "$@" || return 1; body="$AIMUX_ARG_VALUE" ;;
      --body=*) aimux_require_inline_value "${1#--body=}" || return 1; body="$AIMUX_ARG_VALUE" ;;
      --json) json=1 ;;
      *) return 1 ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  AIMUX_PARSED_PROJECT="$project_root"
  AIMUX_PARSED_TASK="$task_id"
  AIMUX_PARSED_FROM="$from"
  AIMUX_PARSED_BODY="$body"
  AIMUX_PARSED_JSON="$json"
}

aimux_post_task_action() {
  route_path="$1"
  set -- --data-urlencode "project=$AIMUX_PARSED_PROJECT" --data-urlencode "taskId=$AIMUX_PARSED_TASK" \
    --data-urlencode "from=$AIMUX_PARSED_FROM"
  [ -n "$AIMUX_PARSED_BODY" ] && set -- "$@" --data-urlencode "body=$AIMUX_PARSED_BODY"
  aimux_post_query_text_route "$route_path" 120 "$@"
}

aimux_try_review() {
  shift
  subcommand="${1:-}"
  case "$subcommand" in
    approve|request-changes)
      shift
      aimux_parse_task_action_args "$@" || return 1
      case "$subcommand" in
        approve) path="/core/review/approve-text" ;;
        request-changes) path="/core/review/request-changes-text" ;;
        *) return 1 ;;
      esac
      [ "$AIMUX_PARSED_JSON" -eq 1 ] && path="$path?json=1"
      aimux_post_task_action "$path"
      ;;
    *)
      return 1
      ;;
  esac
}

aimux_try_notify() {
  [ "${1:-}" = "notify" ] || return 1
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  title=""
  subtitle=""
  body=""
  session_id=""
  kind="notification"
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --title) shift; aimux_require_arg_value "$@" || return 1; title="$AIMUX_ARG_VALUE" ;;
      --title=*) aimux_require_inline_value "${1#--title=}" || return 1; title="$AIMUX_ARG_VALUE" ;;
      --subtitle) shift; aimux_require_arg_value "$@" || return 1; subtitle="$AIMUX_ARG_VALUE" ;;
      --subtitle=*) aimux_require_inline_value "${1#--subtitle=}" || return 1; subtitle="$AIMUX_ARG_VALUE" ;;
      --body) shift; aimux_require_arg_value "$@" || return 1; body="$AIMUX_ARG_VALUE" ;;
      --body=*) aimux_require_inline_value "${1#--body=}" || return 1; body="$AIMUX_ARG_VALUE" ;;
      --session) shift; aimux_require_arg_value "$@" || return 1; session_id="$AIMUX_ARG_VALUE" ;;
      --session=*) aimux_require_inline_value "${1#--session=}" || return 1; session_id="$AIMUX_ARG_VALUE" ;;
      --kind) shift; aimux_require_arg_value "$@" || return 1; kind="$AIMUX_ARG_VALUE" ;;
      --kind=*) aimux_require_inline_value "${1#--kind=}" || return 1; kind="$AIMUX_ARG_VALUE" ;;
      --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --json) json=1 ;;
      *) return 1 ;;
    esac
    shift
  done
  [ -n "$title" ] || return 1
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  path="/core/notifications/send-text"
  [ "$json" -eq 1 ] && path="$path?json=1"
  set -- --data-urlencode "project=$project_root" --data-urlencode "title=$title" --data-urlencode "kind=$kind"
  [ -n "$subtitle" ] && set -- "$@" --data-urlencode "subtitle=$subtitle"
  [ -n "$body" ] && set -- "$@" --data-urlencode "body=$body"
  [ -n "$session_id" ] && set -- "$@" --data-urlencode "sessionId=$session_id"
  aimux_post_query_text_route "$path" 60 "$@"
}

aimux_try_list_notifications() {
  [ "${1:-}" = "list-notifications" ] || return 1
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  unread=0
  session_id=""
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --unread) unread=1 ;;
      --session) shift; aimux_require_arg_value "$@" || return 1; session_id="$AIMUX_ARG_VALUE" ;;
      --session=*) aimux_require_inline_value "${1#--session=}" || return 1; session_id="$AIMUX_ARG_VALUE" ;;
      --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --json) json=1 ;;
      *) return 1 ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  path="/core/notifications/list-text"
  [ "$json" -eq 1 ] && path="$path?json=1"
  set -- --data-urlencode "project=$project_root"
  [ "$unread" -eq 1 ] && set -- "$@" --data-urlencode "unread=1"
  [ -n "$session_id" ] && set -- "$@" --data-urlencode "sessionId=$session_id"
  aimux_get_query_text_route "$path" 60 "$@"
}

aimux_try_notifications_mutation() {
  command="$1"
  shift
  project_root="$(pwd -P 2>/dev/null)" || return 1
  session_id=""
  notification_id=""
  notification_ids=""
  json=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --id) shift; aimux_require_arg_value "$@" || return 1; notification_id="$AIMUX_ARG_VALUE" ;;
      --id=*) aimux_require_inline_value "${1#--id=}" || return 1; notification_id="$AIMUX_ARG_VALUE" ;;
      --ids) shift; aimux_require_arg_value "$@" || return 1; notification_ids="$AIMUX_ARG_VALUE" ;;
      --ids=*) aimux_require_inline_value "${1#--ids=}" || return 1; notification_ids="$AIMUX_ARG_VALUE" ;;
      --session) shift; aimux_require_arg_value "$@" || return 1; session_id="$AIMUX_ARG_VALUE" ;;
      --session=*) aimux_require_inline_value "${1#--session=}" || return 1; session_id="$AIMUX_ARG_VALUE" ;;
      --project) shift; aimux_require_arg_value "$@" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --project=*) aimux_require_inline_value "${1#--project=}" || return 1; project_root="$AIMUX_ARG_VALUE" ;;
      --json) json=1 ;;
      *) return 1 ;;
    esac
    shift
  done
  project_root="$(aimux_resolve_project_arg "$project_root")" || return 1
  case "$command" in
    read-notifications) path="/core/notifications/read-text" ;;
    clear-notifications) path="/core/notifications/clear-text" ;;
    *) return 1 ;;
  esac
  [ "$json" -eq 1 ] && path="$path?json=1"
  set -- --data-urlencode "project=$project_root"
  [ -n "$notification_id" ] && set -- "$@" --data-urlencode "id=$notification_id"
  [ -n "$notification_ids" ] && set -- "$@" --data-urlencode "ids=$notification_ids"
  [ -n "$session_id" ] && set -- "$@" --data-urlencode "sessionId=$session_id"
  aimux_post_query_text_route "$path" 60 "$@"
}

case "${1:-}" in
  notify)
    if aimux_try_notify "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  list-notifications)
    if aimux_try_list_notifications "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  read-notifications|clear-notifications)
    if aimux_try_notifications_mutation "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  threads)
    if aimux_try_threads "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  thread)
    if aimux_try_thread "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  message)
    if aimux_try_message "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  handoff)
    if aimux_try_handoff "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  task)
    if aimux_try_task "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  review)
    if aimux_try_review "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  spawn)
    if aimux_try_lifecycle_spawn "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  serve)
    if aimux_try_project_serve "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  dashboard-reload)
    if aimux_try_dashboard_reload "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  restart-runtime)
    if aimux_try_runtime_restart "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  stop)
    if aimux_try_lifecycle_stop "$@"; then
      exit 0
    else
      code="$?"
      if ! aimux_is_project_runtime_stop_args "$@"; then
        aimux_handle_fast_path_failure "$*" "$code"
      fi
    fi
    ;;
  kill)
    if aimux_try_lifecycle_kill "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  fork)
    if aimux_try_lifecycle_fork "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  input)
    if aimux_try_agent_input "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  ps)
    if aimux_try_agent_ps "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  rename)
    if aimux_try_agent_rename "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  migrate)
    if aimux_try_agent_migrate "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  loop)
    if aimux_try_loop "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  overseer)
    if aimux_try_overseer "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  team)
    if aimux_try_team "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  worktree)
    if aimux_try_worktree "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  graveyard)
    if aimux_try_graveyard "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
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
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "host stop" | "host kill" | "host restart")
    if aimux_try_host_service "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  "host agent-read")
    if aimux_try_host_agent_read "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  "host agent-stream")
    if aimux_try_host_agent_stream "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  "logs path" | "logs tail" | "logs clear")
    if aimux_try_logs "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  "metadata "*)
    if aimux_metadata_help_requested "$@"; then
      :
    elif aimux_try_metadata "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  "daemon ensure")
    if [ "$#" -eq 2 ] && aimux_try_daemon_ensure; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/daemon-ensure-text?json=1"; then
      exit 0
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "daemon project-ensure")
    if aimux_try_daemon_project_ensure "$@"; then
      exit 0
    fi
    aimux_handle_fast_path_failure "$*" "$?"
    ;;
  "daemon status")
    if [ "$#" -eq 2 ] && aimux_curl_text_route "/core/daemon-status-text"; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/daemon-status-text?json=1"; then
      exit 0
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "daemon projects")
    if [ "$#" -eq 2 ] && aimux_curl_text_route "/core/daemon-projects-text"; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/daemon-projects-text?json=1"; then
      exit 0
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "projects list")
    if [ "$#" -eq 2 ] && aimux_curl_text_route "/core/projects-list-text"; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/projects-list-text?json=1"; then
      exit 0
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "remote status")
    if [ "$#" -eq 2 ] && aimux_curl_text_route "/core/remote-status-text"; then
      exit 0
    fi
    if [ "$#" -eq 3 ] && [ "${3:-}" = "--json" ] && aimux_curl_text_route "/core/remote-status-text?json=1"; then
      exit 0
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "remote enable")
    if [ "$#" -eq 2 ]; then
      if aimux_post_text_route "/core/remote-enable-text"; then
        exit 0
      else
        aimux_handle_fast_path_failure "$*" "$?"
      fi
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "remote disable")
    if [ "$#" -eq 2 ]; then
      if aimux_post_text_route "/core/remote-disable-text"; then
        exit 0
      else
        aimux_handle_fast_path_failure "$*" "$?"
      fi
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "whoami " | "whoami --json")
    if [ "$#" -eq 1 ] && aimux_curl_text_route "/core/whoami-text"; then
      exit 0
    fi
    if [ "$#" -eq 2 ] && [ "${2:-}" = "--json" ] && aimux_curl_text_route "/core/whoami-text?json=1"; then
      exit 0
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "logout ")
    if [ "$#" -eq 1 ]; then
      if aimux_post_text_route "/core/logout-text"; then
        exit 0
      else
        aimux_handle_fast_path_failure "$*" "$?"
      fi
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "login ")
    if [ "$#" -eq 1 ]; then
      if aimux_auth_text_route "/core/login-start-text" "/core/login-wait-text" 360; then
        exit 0
      else
        aimux_handle_fast_path_failure "$*" "$?"
      fi
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "security unlock")
    if [ "$#" -eq 2 ]; then
      if aimux_auth_text_route "/core/security-unlock-start-text" "/core/security-unlock-wait-text" 360; then
        exit 0
      else
        aimux_handle_fast_path_failure "$*" "$?"
      fi
    fi
    aimux_handle_fast_path_failure "$*" 1
    ;;
  "doctor versions" | "doctor tmux")
    if aimux_try_doctor "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
  "repair " | "repair --"*)
    if aimux_try_repair "$@"; then
      exit 0
    else
      aimux_handle_fast_path_failure "$*" "$?"
    fi
    ;;
esac

aimux_exec_node "$@"
