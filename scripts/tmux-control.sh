#!/bin/sh
set -eu

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
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
aimux_bin="$script_dir/../bin/aimux"

load_endpoint() {
  [ -f "$endpoint_file" ] || return 1
  endpoint=$(tr -d '\n' < "$endpoint_file")
  [ -n "$endpoint" ] || return 1
  return 0
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

repair_control_plane() {
  [ -n "$project_root" ] || return 1
  [ -x "$aimux_bin" ] || return 1
  "$aimux_bin" daemon project-ensure --project "$project_root" >/dev/null 2>&1 || return 1
  load_endpoint
}

load_endpoint || exit 1

case "$action" in
  next) path="/control/switch-next" ;;
  prev) path="/control/switch-prev" ;;
  attention) path="/control/switch-attention" ;;
  dashboard) path="/control/open-dashboard" ;;
  menu) path="/control/show-menu" ;;
  window) path="/control/focus-window" ;;
  *) exit 1 ;;
esac

request_control 0.35 && exit 0
request_control 1.2 && exit 0

if repair_control_plane; then
  request_control 1.5 && exit 0
fi

exit 28
