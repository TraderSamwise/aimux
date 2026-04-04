#!/bin/sh
set -eu

line=""
project_state_dir=""
current_session=""
current_window=""
current_window_id=""

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

[ -n "$line" ] || exit 0
[ -n "$project_state_dir" ] || exit 0

status_dir="$project_state_dir/tmux-statusline"

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
    ;;
  bottom)
    case "$current_window" in
      dashboard*)
        if [ -n "$current_session" ]; then
          cat_if_exists "$status_dir/bottom-dashboard-$current_session.txt"
        fi
        cat_if_exists "$status_dir/bottom-dashboard.txt"
        ;;
      *)
        if [ -n "$current_window_id" ]; then
          cat_if_exists "$status_dir/bottom-$current_window_id.txt"
        fi
        ;;
    esac
    ;;
esac

exit 0
