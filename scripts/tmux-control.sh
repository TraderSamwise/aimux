#!/bin/sh
set -u

action=""
project_root=""
project_state_dir=""
current_client_session=""
client_tty=""
current_window=""
current_window_id=""
current_path=""
window_id=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    next|prev|attention|dashboard|menu|window)
      action="$1"
      shift
      ;;
    --project-state-dir)
      project_state_dir="${2-}"
      shift 2
      ;;
    --project-root)
      project_root="${2-}"
      shift 2
      ;;
    --current-client-session)
      current_client_session="${2-}"
      shift 2
      ;;
    --client-tty)
      client_tty="${2-}"
      shift 2
      ;;
    --current-window)
      current_window="${2-}"
      shift 2
      ;;
    --current-window-id)
      current_window_id="${2-}"
      shift 2
      ;;
    --current-path)
      current_path="${2-}"
      shift 2
      ;;
    --window-id)
      window_id="${2-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[ -n "$action" ] || exit 1
[ -n "$project_state_dir" ] || exit 1

endpoint_file="$project_state_dir/metadata-api.txt"
project_root_file="$project_state_dir/project-root.txt"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
aimux_bin="$script_dir/../bin/aimux"

load_endpoint() {
  [ -f "$endpoint_file" ] || return 1
  endpoint=$(tr -d '\n' < "$endpoint_file")
  [ -n "$endpoint" ] || return 1
  return 0
}

resolve_live_client() {
  if [ -n "$client_tty" ]; then
    live_client=$(tmux list-clients -F '#{client_tty}|#{session_name}|#{window_id}' 2>/dev/null | awk -F '|' -v tty="$client_tty" '$1 == tty { print; exit }')
    if [ -n "$live_client" ]; then
      live_client_tty=$(printf '%s' "$live_client" | cut -d '|' -f1)
      live_client_session=$(printf '%s' "$live_client" | cut -d '|' -f2)
      return 0
    fi
  fi

  if [ -n "$current_window_id" ]; then
    live_client=$(tmux list-clients -F '#{client_tty}|#{session_name}|#{window_id}' 2>/dev/null | awk -F '|' -v window_id="$current_window_id" '$3 == window_id { print; exit }')
    if [ -n "$live_client" ]; then
      live_client_tty=$(printf '%s' "$live_client" | cut -d '|' -f1)
      live_client_session=$(printf '%s' "$live_client" | cut -d '|' -f2)
      return 0
    fi
  fi

  if [ -n "$current_client_session" ]; then
    live_client=$(tmux list-clients -F '#{client_tty}|#{session_name}|#{window_id}' 2>/dev/null | awk -F '|' -v session_name="$current_client_session" '$2 == session_name { print; exit }')
    if [ -n "$live_client" ]; then
      live_client_tty=$(printf '%s' "$live_client" | cut -d '|' -f1)
      live_client_session=$(printf '%s' "$live_client" | cut -d '|' -f2)
      return 0
    fi
  fi

  return 1
}

request_control() {
  max_time="$1"
  curl \
    --silent \
    --show-error \
    --fail \
    --max-time "$max_time" \
    --get \
    --data-urlencode "currentClientSession=$current_client_session" \
    --data-urlencode "clientTty=$client_tty" \
    --data-urlencode "currentWindow=$current_window" \
    --data-urlencode "currentWindowId=$current_window_id" \
    --data-urlencode "currentPath=$current_path" \
    --data-urlencode "windowId=$window_id" \
    "${endpoint}${path}" >/dev/null
}

switch_local_dashboard() {
  resolve_live_client || true

  dashboard_session=""
  dashboard_index=""

  if [ -n "${live_client_session-}" ]; then
    dashboard_index=$(tmux list-windows -t "$live_client_session" -F '#{window_index}|#{window_name}' 2>/dev/null | awk -F '|' '$2 ~ /^dashboard/ { print $1; exit }')
    if [ -n "$dashboard_index" ]; then
      dashboard_session="$live_client_session"
    fi
  fi

  if [ -z "$dashboard_session" ] && [ -n "$current_client_session" ]; then
    dashboard_index=$(tmux list-windows -t "$current_client_session" -F '#{window_index}|#{window_name}' 2>/dev/null | awk -F '|' '$2 ~ /^dashboard/ { print $1; exit }')
    if [ -n "$dashboard_index" ]; then
      dashboard_session="$current_client_session"
    fi
  fi

  if [ -z "$dashboard_session" ]; then
    session_prefix="$current_client_session"
    case "$session_prefix" in
      *-client-*) session_prefix=${session_prefix%-client-*} ;;
    esac
    dashboard_target=$(tmux list-windows -a -F '#{session_name}|#{window_index}|#{window_name}' 2>/dev/null | awk -F '|' -v prefix="$session_prefix" '$1 ~ ("^" prefix "(-client-[a-f0-9]{8})?$") && $3 ~ /^dashboard/ { print $1 "|" $2; exit }')
    if [ -n "$dashboard_target" ]; then
      dashboard_session=$(printf '%s' "$dashboard_target" | cut -d '|' -f1)
      dashboard_index=$(printf '%s' "$dashboard_target" | cut -d '|' -f2)
    fi
  fi

  [ -n "$dashboard_session" ] || return 1
  [ -n "$dashboard_index" ] || return 1
  target="${dashboard_session}:${dashboard_index}"

  if [ -n "${live_client_tty-}" ]; then
    tmux switch-client -c "$live_client_tty" -t "$target" >/dev/null 2>&1 || return 1
  elif [ -n "$client_tty" ]; then
    tmux switch-client -c "$client_tty" -t "$target" >/dev/null 2>&1 || return 1
  else
    tmux switch-client -t "$target" >/dev/null 2>&1 || return 1
  fi
  tmux send-keys -t "$target" -H 1b 5b 49 >/dev/null 2>&1 || true
  exit 0
}

repair_control_plane() {
  if [ -z "$project_root" ] && [ -f "$project_root_file" ]; then
    project_root=$(tr -d '\n' < "$project_root_file")
  fi
  if [ -z "$project_root" ] && [ -n "$current_client_session" ]; then
    project_root=$(tmux show-options -v -t "$current_client_session" @aimux-project-root 2>/dev/null || true)
  fi
  [ -n "$project_root" ] || return 1
  [ -x "$aimux_bin" ] || return 1
  "$aimux_bin" daemon project-ensure --project "$project_root" >/dev/null 2>&1 || return 1
  load_endpoint
}

endpoint_available=0
if load_endpoint; then
  endpoint_available=1
fi

case "$action" in
  next) path="/control/switch-next" ;;
  prev) path="/control/switch-prev" ;;
  attention) path="/control/switch-attention" ;;
  dashboard) path="/control/open-dashboard" ;;
  menu) path="/control/show-menu" ;;
  window) path="/control/focus-window" ;;
  *) exit 1 ;;
esac

if [ "$endpoint_available" -eq 1 ]; then
  if request_control 0.35; then
    exit 0
  fi

  if request_control 1.2; then
    exit 0
  fi

  if repair_control_plane; then
    if request_control 1.5; then
      exit 0
    fi
  fi
fi

if [ "$action" = "dashboard" ]; then
  switch_local_dashboard
fi

exit 28
