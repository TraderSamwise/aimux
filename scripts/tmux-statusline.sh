#!/bin/sh
set -eu

line=""
project_state_dir=""
current_session=""
current_window=""
current_window_id=""
status_dir=""
log_dir=""
log_file=""

log_error() {
  mkdir -p "$log_dir" 2>/dev/null || true
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$log_file" 2>/dev/null || true
}

fail_silent() {
  log_error "$*"
  printf '\n'
  exit 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --line)
      line="${2-}"
      shift 2
      ;;
    --project-state-dir)
      project_state_dir="${2-}"
      shift 2
      ;;
    --current-session)
      current_session="${2-}"
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
    *)
      shift
      ;;
  esac
done

[ -n "$line" ] || fail_silent "missing --line"
[ -n "$project_state_dir" ] || fail_silent "missing --project-state-dir"

status_dir="$project_state_dir/tmux-statusline"
log_dir="$project_state_dir/logs"
log_file="$log_dir/tmux-statusline.log"

cat_if_exists() {
  file="$1"
  if [ -f "$file" ]; then
    cat "$file"
    exit 0
  fi
}

case "$line" in
  top)
    if [ -n "$current_window_id" ]; then
      cat_if_exists "$status_dir/top-$current_window_id.txt"
    fi
    cat_if_exists "$status_dir/top-dashboard.txt"
    printf '\n'
    log_error "top render missing file current_window_id=$current_window_id current_window=$current_window current_session=$current_session"
    ;;
  bottom)
    case "$current_window" in
      dashboard*)
        if [ -n "$current_session" ]; then
          cat_if_exists "$status_dir/bottom-dashboard-$current_session.txt"
        fi
        cat_if_exists "$status_dir/bottom-dashboard.txt"
        printf '\n'
        log_error "dashboard bottom render missing file current_session=$current_session current_window_id=$current_window_id"
        ;;
      *)
        if [ -n "$current_window_id" ]; then
          cat_if_exists "$status_dir/bottom-$current_window_id.txt"
        fi
        printf '\n'
        log_error "window bottom render missing file current_window_id=$current_window_id current_window=$current_window current_session=$current_session"
        ;;
    esac
    ;;
  *)
    fail_silent "unsupported line=$line"
    ;;
esac

exit 0
