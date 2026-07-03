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
pane_id=""
item_index=""
aimux_home=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    next|prev|attention|dashboard|coordination|menu|expose|meta|window|active|team)
      action="$1"
      shift
      ;;
    --aimux-home)
      aimux_home="${2-}"
      shift 2
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
    --pane-id)
      pane_id="${2-}"
      shift 2
      ;;
    --window-id)
      window_id="${2-}"
      shift 2
      ;;
    --index)
      item_index="${2-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[ -n "$action" ] || exit 1

hydrate_from_tmux_pane() {
  pane_target="$pane_id"
  if [ -z "$pane_target" ]; then
    pane_target="${TMUX_PANE-}"
  fi
  [ -n "$pane_target" ] || return 1
  pane_context=$(tmux display-message -p -t "$pane_target" '#{session_name}|#{window_id}|#{window_name}|#{client_tty}|#{pane_current_path}' 2>/dev/null || true)
  [ -n "$pane_context" ] || return 1
  pane_session=$(printf '%s' "$pane_context" | cut -d '|' -f1)
  pane_window_id=$(printf '%s' "$pane_context" | cut -d '|' -f2)
  pane_window_name=$(printf '%s' "$pane_context" | cut -d '|' -f3)
  pane_client_tty=$(printf '%s' "$pane_context" | cut -d '|' -f4)
  pane_current_path=$(printf '%s' "$pane_context" | cut -d '|' -f5-)
  [ -n "$pane_session" ] || return 1
  current_client_session="$pane_session"
  [ -n "$pane_window_id" ] && current_window_id="$pane_window_id"
  [ -n "$pane_window_name" ] && current_window="$pane_window_name"
  [ -n "$pane_client_tty" ] && client_tty="$pane_client_tty"
  [ -n "$pane_current_path" ] && current_path="$pane_current_path"
  return 0
}

hydrate_from_tmux_pane || true

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
debug_log="${TMPDIR:-/tmp}/aimux-debug.log"

project_context_session() {
  context_session="$current_client_session"
  [ -n "$context_session" ] || return 1
  case "$context_session" in
    *-client-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      context_session=${context_session%-client-????????}
      ;;
  esac
  printf '%s' "$context_session"
}

hydrate_project_context() {
  context_session=$(project_context_session) || return 1
  if [ -z "$project_root" ]; then
    project_root=$(tmux show-options -v -t "$context_session" @aimux-project-root 2>/dev/null || true)
  fi
  if [ -z "$project_state_dir" ]; then
    project_state_dir=$(tmux show-options -v -t "$context_session" @aimux-project-state-dir 2>/dev/null || true)
  fi
}

hydrate_project_context || true

[ -n "$project_state_dir" ] || exit 1

debug_log_line() {
  printf '%s\n' "aimux-control: $*" >>"$debug_log" 2>/dev/null || true
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

switch_client_to_target() {
  switch_target="$1"
  switch_tty="${2-}"
  if [ -n "$switch_tty" ]; then
    tmux switch-client -c "$switch_tty" -t "$switch_target" >/dev/null 2>&1 || return 1
  else
    tmux switch-client -t "$switch_target" >/dev/null 2>&1 || return 1
  fi
}

refresh_navigation_client() {
  refresh_tty="${1-}"
  if [ -n "$refresh_tty" ]; then
    tmux refresh-client -t "$refresh_tty" -S >/dev/null 2>&1 || true
  else
    tmux refresh-client -S >/dev/null 2>&1 || true
  fi
}

dashboard_ready_for_build() {
  ready_window_id="$1"
  ready_build="$2"
  ready_value=$(tmux show-window-options -v -t "$ready_window_id" @aimux-dashboard-ready 2>/dev/null || true)
  [ -n "$ready_build" ] && [ "$ready_value" = "$ready_build" ]
}

wait_for_dashboard_ready() {
  ready_window_id="$1"
  ready_build="$2"
  ready_attempt=0
  while [ "$ready_attempt" -lt 40 ]; do
    dashboard_ready_for_build "$ready_window_id" "$ready_build" && return 0
    ready_attempt=$((ready_attempt + 1))
    sleep 0.05
  done
  return 1
}

validate_dashboard_target() {
  validate_session="$1"
  validate_index="$2"
  validate_target="${validate_session}:${validate_index}"
  dashboard_row=$(tmux list-windows -t "$validate_session" -F '#{window_index}|#{window_id}|#{window_name}|#{pane_dead}' 2>/dev/null | awk -F '|' -v idx="$validate_index" '$1 == idx { print; exit }')
  [ -n "$dashboard_row" ] || return 1
  dashboard_window_id=$(printf '%s' "$dashboard_row" | cut -d '|' -f2)
  dashboard_pane_dead=$(printf '%s' "$dashboard_row" | cut -d '|' -f4)
  [ -n "$dashboard_window_id" ] || return 1
  [ "$dashboard_pane_dead" != "1" ] && [ -n "$dashboard_pane_dead" ] || return 1

  validate_host_session="$validate_session"
  case "$validate_host_session" in
    *-client-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      validate_host_session=${validate_host_session%-client-????????}
      ;;
  esac

  target_project_root=$(tmux show-options -v -t "$validate_host_session" @aimux-project-root 2>/dev/null || true)
  [ -n "$project_root" ] && [ "$target_project_root" = "$project_root" ] || return 1

  expected_dashboard_build=$(tmux show-options -v -t "$validate_host_session" @aimux-dashboard-build 2>/dev/null || true)
  dashboard_build=$(tmux show-window-options -v -t "$dashboard_window_id" @aimux-dashboard-build 2>/dev/null || true)
  [ -n "$expected_dashboard_build" ] && [ "$dashboard_build" = "$expected_dashboard_build" ] || return 1
  wait_for_dashboard_ready "$dashboard_window_id" "$expected_dashboard_build" || return 1

  expected_runtime_owner=$(tmux show-options -v -t "$validate_host_session" @aimux-runtime-owner 2>/dev/null || true)
  target_runtime_owner=$(tmux show-options -v -t "$validate_session" @aimux-runtime-owner 2>/dev/null || true)
  dashboard_owner=$(tmux show-window-options -v -t "$dashboard_window_id" @aimux-dashboard-owner 2>/dev/null || true)
  [ -n "$expected_runtime_owner" ] && [ "$target_runtime_owner" = "$expected_runtime_owner" ] && [ "$dashboard_owner" = "$expected_runtime_owner" ] || return 1

  if [ "$(tmux display-message -p -t "$dashboard_window_id" '#{pane_in_mode}' 2>/dev/null || printf '0')" = "1" ]; then
    tmux send-keys -t "$dashboard_window_id" -X cancel >/dev/null 2>&1 || true
  fi

  dashboard_command=$(tmux display-message -p -t "$dashboard_window_id" '#{pane_current_command}' 2>/dev/null || true)
  case "$dashboard_command" in
    cat|tail)
      return 1
      ;;
  esac
  dashboard_preview=$(tmux capture-pane -p -t "$dashboard_window_id" -S -80 2>/dev/null || true)
  case "$dashboard_preview" in
    *"aimux dashboard failed to start."*)
      return 1
      ;;
  esac
  return 0
}

find_dashboard_candidate() {
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
      *-client-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
        session_prefix=${session_prefix%-client-????????}
        ;;
    esac
    dashboard_target=$(tmux list-windows -a -F '#{session_name}|#{window_index}|#{window_name}' 2>/dev/null | awk -F '|' -v prefix="$session_prefix" '$1 ~ ("^" prefix "(-client-[a-f0-9]{8})?$") && $3 ~ /^dashboard/ { print $1 "|" $2; exit }')
    if [ -n "$dashboard_target" ]; then
      dashboard_session=$(printf '%s' "$dashboard_target" | cut -d '|' -f1)
      dashboard_index=$(printf '%s' "$dashboard_target" | cut -d '|' -f2)
    fi
  fi

  [ -n "$dashboard_session" ] && [ -n "$dashboard_index" ]
}

dashboard_candidate_needs_reload() {
  find_dashboard_candidate || return 0
  dashboard_row=$(tmux list-windows -t "$dashboard_session" -F '#{window_index}|#{window_id}|#{window_name}|#{pane_dead}' 2>/dev/null | awk -F '|' -v idx="$dashboard_index" '$1 == idx { print; exit }')
  dashboard_window_id=$(printf '%s' "$dashboard_row" | cut -d '|' -f2)
  dashboard_pane_dead=$(printf '%s' "$dashboard_row" | cut -d '|' -f4)
  [ -n "$dashboard_window_id" ] || return 0
  [ "$dashboard_pane_dead" != "1" ] && [ -n "$dashboard_pane_dead" ] || return 0

  validate_host_session="$dashboard_session"
  case "$validate_host_session" in
    *-client-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      validate_host_session=${validate_host_session%-client-????????}
      ;;
  esac
  expected_dashboard_build=$(tmux show-options -v -t "$validate_host_session" @aimux-dashboard-build 2>/dev/null || true)
  dashboard_build=$(tmux show-window-options -v -t "$dashboard_window_id" @aimux-dashboard-build 2>/dev/null || true)
  [ -n "$expected_dashboard_build" ] && [ -n "$dashboard_build" ] || return 0
  [ "$dashboard_build" != "$expected_dashboard_build" ] && return 0
  dashboard_ready_for_build "$dashboard_window_id" "$expected_dashboard_build" || return 0

  dashboard_preview=$(tmux capture-pane -p -t "$dashboard_window_id" -S -80 2>/dev/null || true)
  case "$dashboard_preview" in
    *"aimux dashboard failed to start."*)
      return 0
      ;;
  esac
  return 1
}

switch_fast_current_session_dashboard() {
  [ -n "$current_client_session" ] || return 1
  dashboard_index=$(tmux list-windows -t "$current_client_session" -F '#{window_index}|#{window_name}' 2>/dev/null | awk -F '|' '$2 ~ /^dashboard/ { print $1; exit }')
  [ -n "$dashboard_index" ] || return 1
  validate_dashboard_target "$current_client_session" "$dashboard_index" || return 1
  dashboard_switch_target="${current_client_session}:${dashboard_index}"
  switch_client_to_target "$dashboard_switch_target" "$client_tty" || return 1
  refresh_navigation_client "$client_tty"
  tmux send-keys -t "$dashboard_switch_target" -H 1b 5b 49 >/dev/null 2>&1 || true
  exit 0
}

focus_local_dashboard_target() {
  resolve_live_client || true
  find_dashboard_candidate || return 1
  dashboard_switch_target="${dashboard_session}:${dashboard_index}"
  validate_dashboard_target "$dashboard_session" "$dashboard_index" || return 1

  return 0
}

switch_local_dashboard() {
  switch_fast_current_session_dashboard || true
  focus_local_dashboard_target || return 1

  if [ -n "${live_client_tty-}" ]; then
    switch_client_to_target "$dashboard_switch_target" "$live_client_tty" || return 1
  elif [ -n "$client_tty" ]; then
    switch_client_to_target "$dashboard_switch_target" "$client_tty" || return 1
  else
    switch_client_to_target "$dashboard_switch_target" "" || return 1
  fi
  if [ -n "${live_client_tty-}" ]; then
    refresh_navigation_client "$live_client_tty"
  elif [ -n "$client_tty" ]; then
    refresh_navigation_client "$client_tty"
  else
    refresh_navigation_client ""
  fi
  tmux send-keys -t "$dashboard_switch_target" -H 1b 5b 49 >/dev/null 2>&1 || true
  exit 0
}

reload_local_dashboard() {
  [ -n "$project_root" ] || return 1
  debug_log_line "dashboard reload fallback project_root=$project_root"
  show_local_message "#[fg=colour220,bold]aimux#[default] reloading dashboard"
  (
    reload_client_tty="${live_client_tty-${client_tty-}}"
    reload_client_session="${live_client_session-${current_client_session-}}"
    metadata_api=$(cat "$project_state_dir/metadata-api.txt" 2>/dev/null || true)
    [ -n "$metadata_api" ] || exit 1
    reload_body=$(python3 - "$reload_client_tty" "$reload_client_session" "$current_window_id" <<'PY'
import json
import sys

client_tty, current_client_session, current_window_id = sys.argv[1:4]
body = {"focus": True, "forceReload": True}
if client_tty:
    body["clientTty"] = client_tty
if current_client_session:
    body["currentClientSession"] = current_client_session
if current_window_id:
    body["currentWindowId"] = current_window_id
print(json.dumps(body))
PY
)
    curl -fsS --max-time 8 -H "content-type: application/json" --data-binary "$reload_body" "$metadata_api/control/open-dashboard"
  ) >/dev/null 2>&1 &
  return 0
}

persist_dashboard_screen() {
  target_client_session="$1"
  target_screen="$2"
  [ -n "$project_state_dir" ] || return 1
  [ -n "$target_client_session" ] || return 1
  python3 - "$project_state_dir" "$target_client_session" "$target_screen" <<'PY'
import json
import os
import re
import sys

state_dir, session, screen = sys.argv[1:4]
client_key = re.sub(r"[^a-zA-Z0-9._-]", "_", session)
path = os.path.join(state_dir, f"dashboard-ui-client-{client_key}.json")
try:
    with open(path, "r", encoding="utf-8") as fh:
        snapshot = json.load(fh)
except Exception:
    snapshot = {}
snapshot["screen"] = screen
tmp = f"{path}.tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(snapshot, fh)
os.replace(tmp, path)
PY
}

show_local_coordination() {
  if [ -z "${live_client_session-}" ] && [ -z "${live_client_tty-}" ]; then
    resolve_live_client || return 1
  fi
  coordination_session="${live_client_session-}"
  [ -n "$coordination_session" ] || coordination_session="$current_client_session"
  persist_dashboard_screen "$coordination_session" "coordination" || true
  switch_local_dashboard || { dashboard_candidate_needs_reload && reload_local_dashboard && return 0; }
}

ensure_linked_window() {
  target_window_id="$1"
  target_session="${live_client_session-}"
  [ -n "$target_session" ] || return 1
  linked_index=$(tmux list-windows -t "$target_session" -F '#{window_index}|#{window_id}' 2>/dev/null | awk -F '|' -v window_id="$target_window_id" '$2 == window_id { print $1; exit }')
  if [ -z "$linked_index" ]; then
    tmux link-window -d -s "$target_window_id" -t "$target_session" >/dev/null 2>&1 || return 1
    linked_index=$(tmux list-windows -t "$target_session" -F '#{window_index}|#{window_id}' 2>/dev/null | awk -F '|' -v window_id="$target_window_id" '$2 == window_id { print $1; exit }')
  fi
  [ -n "$linked_index" ] || return 1
  printf '%s' "$linked_index"
}

switch_local_window() {
  target_window_id="$1"
  if [ -z "${live_client_session-}" ] && [ -z "${live_client_tty-}" ]; then
    resolve_live_client || return 1
  fi
  is_live_window "$target_window_id" || return 1
  target_index=$(ensure_linked_window "$target_window_id") || return 1
  if [ -n "${live_client_tty-}" ]; then
    tmux switch-client -c "$live_client_tty" -t "${live_client_session}:${target_index}" >/dev/null 2>&1 || return 1
  else
    tmux switch-client -t "${live_client_session}:${target_index}" >/dev/null 2>&1 || return 1
  fi
  if [ -n "${live_client_tty-}" ]; then
    tmux refresh-client -t "$live_client_tty" -S >/dev/null 2>&1 || true
  elif [ -n "$client_tty" ]; then
    tmux refresh-client -t "$client_tty" -S >/dev/null 2>&1 || true
  else
    tmux refresh-client -S >/dev/null 2>&1 || true
  fi
  exit 0
}

is_live_window() {
  target_window_id="$1"
  [ -n "$target_window_id" ] || return 1
  pane_dead=$(tmux display-message -p -t "$target_window_id" '#{pane_dead}' 2>/dev/null || true)
  [ "$pane_dead" != "1" ] && [ -n "$pane_dead" ]
}

show_local_message() {
  message="$1"
  if [ -n "${pane_id-}" ]; then
    tmux display-message -t "$pane_id" "$message" >/dev/null 2>&1 || true
  else
    tmux display-message "$message" >/dev/null 2>&1 || true
  fi
}

report_control_failure() {
  failure_reason="$1"
  case "$action" in
    next | prev | window) action_label="switch window" ;;
    attention) action_label="jump to attention" ;;
    dashboard) action_label="open dashboard" ;;
    coordination) action_label="open coordination" ;;
    menu) action_label="open switcher" ;;
    expose) action_label="expose sessions" ;;
    meta) action_label="open meta" ;;
    team) action_label="reach teammate" ;;
    *) action_label="$action" ;;
  esac
  debug_log_line "control failure action=$action reason=$failure_reason"
  show_local_message "#[fg=colour203,bold]aimux#[default] couldn't $action_label — $failure_reason"
}

show_local_switcher() {
  show_metadata_menu "worktree" "aimux"
  exit 0
}

show_local_expose() {
  show_metadata_menu "global" "aimux expose"
  exit 0
}

show_local_meta() {
  show_metadata_menu "global" "aimux projects"
  exit 0
}

show_metadata_menu() {
  menu_scope="$1"
  menu_title="$2"
  if [ -z "${live_client_session-}" ] && [ -z "${live_client_tty-}" ]; then
    resolve_live_client || return 1
  fi
  menu_session="${live_client_session-}"
  [ -n "$menu_session" ] || menu_session="$current_client_session"
  menu_client_tty="${live_client_tty-}"
  [ -n "$menu_client_tty" ] || menu_client_tty="$client_tty"
  host_session=$(resolve_host_session_name) || return 1
  python3 - "$menu_scope" "$menu_title" "$host_session" "$project_root" "$current_path" "$current_window_id" "$script_dir/tmux-control.sh" "$project_state_dir" "$menu_session" "$menu_client_tty" "$current_window" "$pane_id" <<'PY'
import json
import os
import shlex
import subprocess
import sys

scope, title, host_session, project_root, current_path, current_window_id, script, state_dir, menu_session, client_tty, current_window, pane_id = sys.argv[1:13]

def run(*args):
    return subprocess.check_output(["tmux", *args], text=True, stderr=subprocess.DEVNULL)

def same_or_child(path, parent):
    path = (path or "").rstrip("/")
    parent = (parent or "").rstrip("/")
    return bool(path and parent and (path == parent or path.startswith(parent + "/")))

def safe_label(value, limit=64):
    cleaned = " ".join(str(value or "").split())
    if len(cleaned) > limit:
        return cleaned[: limit - 3] + "..."
    return cleaned

def list_windows():
    if scope == "global":
        raw = run("list-windows", "-a", "-F", "#{session_name}|#{window_index}|#{window_id}|#{window_name}|#{pane_dead}")
    else:
        raw = run("list-windows", "-t", host_session, "-F", "#{session_name}|#{window_index}|#{window_id}|#{window_name}|#{pane_dead}")
    rows = []
    for line in raw.splitlines():
        try:
            session, index, window_id, name, pane_dead = line.split("|", 4)
        except ValueError:
            continue
        if pane_dead == "1":
            continue
        try:
            meta = json.loads(run("show-window-options", "-v", "-t", window_id, "@aimux-meta").strip())
        except Exception:
            continue
        worktree = meta.get("worktreePath") or project_root
        if scope == "worktree" and current_path and not (same_or_child(current_path, worktree) or same_or_child(worktree, current_path)):
            continue
        rows.append({
            "session": session,
            "index": int(index),
            "windowId": window_id,
            "name": name,
            "kind": meta.get("kind") or "agent",
            "command": meta.get("command") or name,
            "role": meta.get("role") or "",
            "status": meta.get("statusText") or "",
            "worktree": worktree,
            "current": window_id == current_window_id,
        })
    return rows

items = list_windows()
items.sort(key=lambda item: (item["worktree"], 0 if item["kind"] == "agent" else 1, item["index"]))
if not items:
    raise SystemExit(1)

args = ["display-menu"]
if client_tty:
    args += ["-c", client_tty]
args += ["-T", title]
keys = list("123456789abcdefghijklmnopqrstuvwxyz")
for idx, item in enumerate(items[:36]):
    basename = os.path.basename(item["worktree"].rstrip("/")) or item["worktree"]
    status = f" {item['status']}" if item["status"] else ""
    marker = "* " if item["current"] else ""
    label = safe_label(f"{marker}{basename} - {item['command']} {item['role']}{status}")
    command = ["sh", script, "window"]
    for flag, value in [
        ("--project-state-dir", state_dir),
        ("--project-root", project_root),
        ("--current-client-session", menu_session),
        ("--client-tty", client_tty),
        ("--current-window", current_window),
        ("--current-window-id", current_window_id),
        ("--current-path", current_path),
        ("--pane-id", pane_id),
        ("--window-id", item["windowId"]),
    ]:
        if value:
            command.extend([flag, value])
    args += [label, keys[idx], " ".join(shlex.quote(part) for part in command)]

subprocess.run(["tmux", *args], check=True)
PY
}

resolve_host_session_name() {
  session_name="${live_client_session-}"
  if [ -z "$session_name" ]; then
    session_name="$current_client_session"
  fi
  [ -n "$session_name" ] || return 1
  case "$session_name" in
    *-client-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      printf '%s' "${session_name%-client-????????}"
      ;;
    *) printf '%s' "$session_name" ;;
  esac
}

resolve_local_target_from_tmux_metadata() {
  resolve_live_client || true
  host_session=$(resolve_host_session_name) || return 1
  resolved_target=$(
    python3 - "$host_session" "$project_root" "$current_path" "$current_window_id" "$window_id" "$action" "$item_index" "$debug_log" <<'PY'
import json, subprocess, sys
host_session, project_root, current_path, current_window_id, explicit_window_id, action, item_index, debug_log = sys.argv[1:]

def log(message):
    if action != "team":
        return
    try:
        with open(debug_log, "a") as handle:
            handle.write(f"aimux-control team metadata: {message}\n")
    except Exception:
        pass

def run(*args):
    return subprocess.check_output(["tmux", *args], text=True)

def is_same_or_child_path(path, parent):
    if not path or not parent:
        return False
    path = path.rstrip("/")
    parent = parent.rstrip("/")
    return path == parent or path.startswith(parent + "/")

if explicit_window_id:
    log(f"explicit target {explicit_window_id}")
    print(explicit_window_id)
    raise SystemExit(0)

try:
    windows = run("list-windows", "-t", host_session, "-F", "#{window_id}|#{window_index}|#{window_name}|#{pane_dead}").splitlines()
    log(f"start host={host_session!r} currentWindowId={current_window_id!r} currentPath={current_path!r} windows={len(windows)}")
except Exception as error:
    log(f"list windows failed host={host_session!r} error={error}")
    raise SystemExit(1)

items = []
for line in windows:
    try:
        window_id, index, name, pane_dead = line.split("|", 3)
    except ValueError:
        log(f"skip malformed window line={line!r}")
        continue
    try:
        raw = run("show-window-options", "-v", "-t", window_id, "@aimux-meta").strip()
        meta = json.loads(raw)
    except Exception as error:
        log(f"skip window={window_id!r} name={name!r} no/invalid meta error={error}")
        continue
    worktree = meta.get("worktreePath") or project_root
    kind = meta.get("kind") or "agent"
    team = meta.get("team") or {}
    items.append({
        "windowId": window_id,
        "windowIndex": int(index),
        "kind": kind,
        "sessionId": meta.get("sessionId", ""),
        "worktreePath": worktree,
        "attention": meta.get("attention", ""),
        "unseenCount": int(meta.get("unseenCount") or 0),
        "statusText": meta.get("statusText", ""),
        "team": team if isinstance(team, dict) else {},
        "createdAt": meta.get("createdAt", ""),
        "alive": pane_dead != "1",
    })

if not items:
    log("no metadata candidates after filtering")
    raise SystemExit(1)

current_worktree = None
for item in items:
    if item.get("windowId") == current_window_id:
        current_worktree = item.get("worktreePath")
        break

items = [item for item in items if item.get("alive") or item.get("windowId") == current_window_id]
log("items=" + repr([
    f"{item.get('windowId')}:{item.get('sessionId')}:{item.get('kind')}:{(item.get('team') or {}).get('parentSessionId') or '-'}:{item.get('statusText') or '-'}:{'live' if item.get('alive') else 'dead'}"
    for item in items
]))

if not items:
    log("no live metadata candidates")
    raise SystemExit(1)

current = next((item for item in items if item.get("windowId") == current_window_id), None)
if action == "team":
    if not current:
        log(f"current metadata item not found currentWindowId={current_window_id!r}")
        raise SystemExit(1)
    current_team = current.get("team") or {}
    parent_id = current_team.get("parentSessionId")
    log(f"current id={current.get('sessionId')!r} parentId={parent_id!r} window={current.get('windowId')!r}")
    if parent_id:
        parent = next((item for item in items if item.get("alive") and item.get("sessionId") == parent_id and not (item.get("team") or {}).get("parentSessionId")), None)
        if not parent:
            log(f"parent metadata target missing parentId={parent_id!r}")
            raise SystemExit(1)
        log(f"target parent window={parent['windowId']!r}")
        print(parent["windowId"])
        raise SystemExit(0)

    current_id = current.get("sessionId")
    if not current_id:
        log("current metadata item has no session id")
        raise SystemExit(1)

    direct = [
        item
        for item in items
        if item.get("alive") and (item.get("team") or {}).get("parentSessionId") == current_id
    ]
    log("direct candidates=" + repr([
        f"{item.get('windowId')}:{item.get('sessionId')}:{item.get('statusText') or '-'}"
        for item in direct
    ]))
    def teammate_order(item):
        order = (item.get("team") or {}).get("order")
        if isinstance(order, bool):
            return 10**9
        return order if isinstance(order, (int, float)) else 10**9

    direct.sort(key=lambda item: (teammate_order(item), item.get("windowIndex", 10**9), item.get("createdAt") or "", item.get("sessionId") or ""))
    if not direct:
        log(f"no direct live teammate metadata candidates currentId={current_id!r}")
        raise SystemExit(1)
    log(f"target teammate window={direct[0]['windowId']!r} id={direct[0].get('sessionId')!r}")
    print(direct[0]["windowId"])
    raise SystemExit(0)

if current_worktree:
    items = [item for item in items if item.get("worktreePath") == current_worktree]
else:
    items = [item for item in items if is_same_or_child_path(current_path, item.get("worktreePath") or "")]
items.sort(key=lambda s: (0 if s.get("kind") == "agent" else 1, s.get("windowIndex", 10**9)))
if not items:
    log("no metadata candidates in current worktree")
    raise SystemExit(1)
current = next((item for item in items if item.get("windowId") == current_window_id), None)

if current and (current.get("team") or {}).get("parentSessionId"):
    parent_id = (current.get("team") or {}).get("parentSessionId")
    items = [item for item in items if (item.get("team") or {}).get("parentSessionId") == parent_id]
    def teammate_nav_order(item):
        order = (item.get("team") or {}).get("order")
        if isinstance(order, bool):
            return 10**9
        return order if isinstance(order, (int, float)) else 10**9

    items.sort(key=lambda s: (teammate_nav_order(s), s.get("windowIndex", 10**9), s.get("createdAt") or "", s.get("sessionId") or ""))
else:
    items = [item for item in items if not (item.get("team") or {}).get("parentSessionId")]
    items.sort(key=lambda s: (0 if s.get("kind") == "agent" else 1, s.get("windowIndex", 10**9)))

if not items:
    raise SystemExit(1)

current_index = 0
for idx, item in enumerate(items):
    if item.get("windowId") == current_window_id:
        current_index = idx
        break

if action == "next":
    for offset in range(1, len(items) + 1):
        target = items[(current_index + offset) % len(items)]
        if target.get("alive"):
            print(target["windowId"])
            raise SystemExit(0)
    raise SystemExit(1)
if action == "prev":
    for offset in range(1, len(items) + 1):
        target = items[(current_index - offset) % len(items)]
        if target.get("alive"):
            print(target["windowId"])
            raise SystemExit(0)
    raise SystemExit(1)
if action == "attention":
    def rank(item):
        attention = item.get("attention")
        attention_score = {
            "error": 5,
            "needs_input": 4,
            "needs_response": 4,
            "blocked": 3,
        }.get(attention, 0)
        return (
            attention_score,
            item.get("unseenCount", 0),
            1 if item.get("statusText") == "blocked" else 0,
        )
    ranked = sorted([item for item in items if item.get("alive")], key=rank, reverse=True)
    if not ranked:
        raise SystemExit(1)
    if rank(ranked[0]) == (0, 0, 0):
        raise SystemExit(1)
    print(ranked[0]["windowId"])
    raise SystemExit(0)
if action == "window":
    try:
        index = int(item_index)
    except Exception:
        raise SystemExit(1)
    live_items = [item for item in items if item.get("alive")]
    if index < 1 or index > len(live_items):
        raise SystemExit(1)
    print(live_items[index - 1]["windowId"])
    raise SystemExit(0)
raise SystemExit(1)
PY
  ) || return 1
  [ -n "$resolved_target" ] || return 1
  printf '%s' "$resolved_target"
}

fallback_local_control() {
  case "$action" in
    dashboard)
      printf '%s\n' "aimux: tmux dashboard fallback for session=${current_client_session:-unknown} window=${current_window_id:-unknown}" >>"$debug_log"
      switch_local_dashboard || { dashboard_candidate_needs_reload && reload_local_dashboard && return 0; }
      ;;
    coordination)
      show_local_coordination
      ;;
    menu)
      show_local_switcher
      ;;
    expose)
      show_local_expose
      ;;
    meta)
      show_local_meta
      ;;
    active)
      return 0
      ;;
    next|prev|attention|window)
      target_window_id=$(resolve_local_target_from_tmux_metadata) || return 1
      switch_local_window "$target_window_id"
      ;;
    team)
      debug_log_line "team requested session=${current_client_session:-unknown} window=${current_window_id:-unknown} path=${current_path:-unknown} pane=${pane_id:-unknown}"
      target_window_id=$(resolve_local_target_from_tmux_metadata) || {
        debug_log_line "team no live target session=${current_client_session:-unknown} window=${current_window_id:-unknown} path=${current_path:-unknown}"
        show_local_message "aimux: no live teammate target"
        return 0
      }
      switch_local_window "$target_window_id"
      ;;
  esac
  return 1
}

case "$action" in
  next|prev|attention|dashboard|coordination|menu|expose|meta|window|active|team)
    fallback_local_control && exit 0
    report_control_failure "no local tmux target available"
    exit 0
    ;;
  *) exit 1 ;;
esac
