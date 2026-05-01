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

while [ "$#" -gt 0 ]; do
  case "$1" in
    next|prev|attention|dashboard|inbox|menu|window|active)
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
[ -n "$project_state_dir" ] || exit 1

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

endpoint_file="$project_state_dir/metadata-api.txt"
project_root_file="$project_state_dir/project-root.txt"
statusline_json="$project_state_dir/statusline.json"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
aimux_bin="${AIMUX_BIN:-$script_dir/../bin/aimux}"
debug_log="${TMPDIR:-/tmp}/aimux-debug.log"

load_endpoint() {
  [ -f "$endpoint_file" ] || return 1
  endpoint=$(tr -d '\n' < "$endpoint_file")
  [ -n "$endpoint" ] || return 1
  return 0
}

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
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
    "${endpoint}${path}" >/dev/null 2>>"$debug_log"
}

focus_local_dashboard_target() {
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
  dashboard_switch_target="${dashboard_session}:${dashboard_index}"

  if [ "$(tmux display-message -p -t "$dashboard_switch_target" '#{pane_in_mode}' 2>/dev/null || printf '0')" = "1" ]; then
    tmux send-keys -t "$dashboard_switch_target" -X cancel >/dev/null 2>&1 || true
  fi

  dashboard_window_id=$(tmux list-windows -t "$dashboard_session" -F '#{window_index}|#{window_id}|#{window_name}' 2>/dev/null | awk -F '|' -v idx="$dashboard_index" '$1 == idx { print $2; exit }')
  if [ -n "$dashboard_window_id" ]; then
    dashboard_command=$(tmux display-message -p -t "$dashboard_window_id" '#{pane_current_command}' 2>/dev/null || true)
    case "$dashboard_command" in
      sh|bash|cat|tail)
        return 1
        ;;
    esac
    dashboard_preview=$(tmux capture-pane -p -t "$dashboard_window_id" -S -80 2>/dev/null || true)
    case "$dashboard_preview" in
      *"aimux dashboard failed to start."*)
        return 1
        ;;
    esac
  fi

  return 0
}

switch_local_dashboard() {
  focus_local_dashboard_target || return 1

  if [ -n "${live_client_tty-}" ]; then
    tmux switch-client -c "$live_client_tty" -t "$dashboard_switch_target" >/dev/null 2>&1 || return 1
  elif [ -n "$client_tty" ]; then
    tmux switch-client -c "$client_tty" -t "$dashboard_switch_target" >/dev/null 2>&1 || return 1
  else
    tmux switch-client -t "$dashboard_switch_target" >/dev/null 2>&1 || return 1
  fi
  if [ -n "${live_client_tty-}" ]; then
    tmux refresh-client -t "$live_client_tty" -S >/dev/null 2>&1 || true
  elif [ -n "$client_tty" ]; then
    tmux refresh-client -t "$client_tty" -S >/dev/null 2>&1 || true
  else
    tmux refresh-client -S >/dev/null 2>&1 || true
  fi
  tmux send-keys -t "$dashboard_switch_target" -H 1b 5b 49 >/dev/null 2>&1 || true
  exit 0
}

show_local_inbox_popup() {
  if [ -z "${live_client_session-}" ] && [ -z "${live_client_tty-}" ]; then
    resolve_live_client || return 1
  fi
  popup_client_tty="${live_client_tty-}"
  [ -n "$popup_client_tty" ] || popup_client_tty="$client_tty"
  popup_session="${live_client_session-}"
  [ -n "$popup_session" ] || popup_session="$current_client_session"
  inbox_cmd="exec $(shell_quote "$aimux_bin") inbox-popup --project-root $(shell_quote "$project_root") --project-state-dir $(shell_quote "$project_state_dir") --current-client-session $(shell_quote "$popup_session") --client-tty $(shell_quote "$popup_client_tty") --current-window $(shell_quote "$current_window") --current-window-id $(shell_quote "$current_window_id") --current-path $(shell_quote "$current_path") --pane-id $(shell_quote "$pane_id")"
  if [ -n "$popup_client_tty" ]; then
    tmux display-popup -c "$popup_client_tty" -T "aimux inbox" -x P -y P -w 96 -h 18 -E "$inbox_cmd" >/dev/null 2>&1 || return 1
  else
    tmux display-popup -T "aimux inbox" -x P -y P -w 96 -h 18 -E "$inbox_cmd" >/dev/null 2>&1 || return 1
  fi
  exit 0
}

open_dashboard_via_aimux() {
  if [ -z "$project_root" ] && [ -f "$project_root_file" ]; then
    project_root=$(tr -d '\n' < "$project_root_file")
  fi
  if [ -z "$project_root" ] && [ -n "$current_client_session" ]; then
    project_root=$(tmux show-options -v -t "$current_client_session" @aimux-project-root 2>/dev/null || true)
  fi
  [ -n "$project_root" ] || return 1
  [ -x "$aimux_bin" ] || return 1
  (cd "$project_root" && "$aimux_bin" dashboard-reload --open >/dev/null 2>&1) ||
    (cd "$project_root" && "$aimux_bin" >/dev/null 2>&1) ||
    return 1
  exit 0
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

mark_last_used_local() {
  item_id="$1"
  [ -n "$item_id" ] || return 0
  [ -n "${project_state_dir-}" ] || return 0
  python3 - "$project_state_dir" "$item_id" "${live_client_session-}" <<'PY' >/dev/null 2>&1
import json, sys
from datetime import datetime, timezone
from pathlib import Path

project_state_dir, item_id, client_session = sys.argv[1:]
state_path = Path(project_state_dir) / "last-used.json"
try:
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
except Exception:
    state = {}

state["version"] = 1
state.setdefault("items", {})
state.setdefault("clients", {})
state.setdefault("projectRecentIds", [])

used_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
state["items"][item_id] = {"lastUsedAt": used_at}
state["projectRecentIds"] = [item_id] + [entry for entry in state.get("projectRecentIds", []) if entry != item_id]
state["projectRecentIds"] = state["projectRecentIds"][:64]

if client_session:
    client = state["clients"].get(client_session) or {"recentIds": [], "updatedAt": used_at}
    recent_ids = [item_id] + [entry for entry in client.get("recentIds", []) if entry != item_id]
    client["recentIds"] = recent_ids[:64]
    client["updatedAt"] = used_at
    state["clients"][client_session] = client

state["updatedAt"] = used_at
state_path.write_text(json.dumps(state, indent=2) + "\n")
PY
}

switch_local_window() {
  target_window_id="$1"
  if [ -z "${live_client_session-}" ] && [ -z "${live_client_tty-}" ]; then
    resolve_live_client || return 1
  fi
  item_id="${2-}"
  target_index=$(ensure_linked_window "$target_window_id") || return 1
  if [ -n "${live_client_tty-}" ]; then
    tmux switch-client -c "$live_client_tty" -t "${live_client_session}:${target_index}" >/dev/null 2>&1 || return 1
  else
    tmux switch-client -t "${live_client_session}:${target_index}" >/dev/null 2>&1 || return 1
  fi
  mark_last_used_local "$item_id"
  if [ -n "${live_client_tty-}" ]; then
    tmux refresh-client -t "$live_client_tty" -S >/dev/null 2>&1 || true
  elif [ -n "$client_tty" ]; then
    tmux refresh-client -t "$client_tty" -S >/dev/null 2>&1 || true
  else
    tmux refresh-client -S >/dev/null 2>&1 || true
  fi
  exit 0
}

show_local_switcher() {
  if [ -z "${live_client_session-}" ] && [ -z "${live_client_tty-}" ]; then
    resolve_live_client || return 1
  fi
  popup_client_tty="${live_client_tty-}"
  [ -n "$popup_client_tty" ] || popup_client_tty="$client_tty"
  popup_session="${live_client_session-}"
  [ -n "$popup_session" ] || popup_session="$current_client_session"
  switcher_cmd="exec $(shell_quote "$aimux_bin") switcher --project-root $(shell_quote "$project_root") --project-state-dir $(shell_quote "$project_state_dir") --current-client-session $(shell_quote "$popup_session") --client-tty $(shell_quote "$popup_client_tty") --current-window $(shell_quote "$current_window") --current-window-id $(shell_quote "$current_window_id") --current-path $(shell_quote "$current_path") --pane-id $(shell_quote "$pane_id")"
  if [ -n "$popup_client_tty" ]; then
    tmux display-popup -c "$popup_client_tty" -T "aimux" -x P -y P -w 56 -h 10 -E "$switcher_cmd" >/dev/null 2>&1 || return 1
  else
    tmux display-popup -T "aimux" -x P -y P -w 56 -h 10 -E "$switcher_cmd" >/dev/null 2>&1 || return 1
  fi
  exit 0
}

resolve_local_target_from_statusline() {
  [ -f "$statusline_json" ] || return 1
  resolved_target=$(
    python3 - "$statusline_json" "$project_root" "$current_path" "$current_window_id" "$window_id" "$action" "$item_index" <<'PY'
import json, sys
path, project_root, current_path, current_window_id, explicit_window_id, action, item_index = sys.argv[1:]
try:
    data = json.load(open(path))
except Exception:
    raise SystemExit(1)
sessions = list(data.get("sessions") or [])
if explicit_window_id:
    print(explicit_window_id)
    raise SystemExit(0)
if not sessions:
    raise SystemExit(1)
current_worktree = None
for session in sessions:
    if session.get("tmuxWindowId") == current_window_id:
        current_worktree = session.get("worktreePath") or project_root
        break
matched = []
best_len = -1
for session in sessions:
    worktree = session.get("worktreePath") or project_root
    if not worktree:
        continue
    if current_worktree:
        if worktree != current_worktree:
            continue
    elif not current_path.startswith(worktree):
        continue
    length = len(worktree)
    if length > best_len:
        matched = [session]
        best_len = length
    elif length == best_len:
        matched.append(session)
items = matched if matched else sessions
items.sort(key=lambda s: (0 if s.get("kind") == "agent" else 1, int(s.get("tmuxWindowIndex") or 1_000_000)))
if not items:
    raise SystemExit(1)
current_index = 0
for idx, item in enumerate(items):
    if item.get("tmuxWindowId") == current_window_id:
        current_index = idx
        break
if action == "next":
    target = items[(current_index + 1) % len(items)]
    print(target.get("tmuxWindowId", ""))
    raise SystemExit(0)
if action == "prev":
    target = items[(current_index - 1) % len(items)]
    print(target.get("tmuxWindowId", ""))
    raise SystemExit(0)
if action == "attention":
    def rank(item):
        semantic = item.get("semantic") or {}
        return (
            int(semantic.get("waitingOnMeCount") or 0),
            int(semantic.get("unreadCount") or 0),
            int(semantic.get("blockedCount") or 0),
            int(semantic.get("pendingDeliveryCount") or 0),
        )
    ranked = sorted(items, key=rank, reverse=True)
    target = ranked[0]
    if rank(target) == (0, 0, 0, 0):
        raise SystemExit(1)
    print(target.get("tmuxWindowId", ""))
    raise SystemExit(0)
if action == "window":
    try:
        index = int(item_index)
    except Exception:
        raise SystemExit(1)
    if index < 1 or index > len(items):
        raise SystemExit(1)
    print(items[index - 1].get("tmuxWindowId", ""))
    raise SystemExit(0)
raise SystemExit(1)
PY
  ) || return 1
  [ -n "$resolved_target" ] || return 1
  printf '%s' "$resolved_target"
}

resolve_host_session_name() {
  session_name="${live_client_session-}"
  if [ -z "$session_name" ]; then
    session_name="$current_client_session"
  fi
  [ -n "$session_name" ] || return 1
  case "$session_name" in
    *-client-*) printf '%s' "${session_name%-client-*}" ;;
    *) printf '%s' "$session_name" ;;
  esac
}

resolve_local_target_from_tmux_metadata() {
  resolve_live_client || true
  host_session=$(resolve_host_session_name) || return 1
  resolved_target=$(
    python3 - "$host_session" "$project_root" "$current_path" "$current_window_id" "$window_id" "$action" "$item_index" <<'PY'
import json, subprocess, sys
host_session, project_root, current_path, current_window_id, explicit_window_id, action, item_index = sys.argv[1:]

def run(*args):
    return subprocess.check_output(["tmux", *args], text=True)

if explicit_window_id:
    print(explicit_window_id)
    raise SystemExit(0)

try:
    windows = run("list-windows", "-t", host_session, "-F", "#{window_id}|#{window_index}|#{window_name}").splitlines()
except Exception:
    raise SystemExit(1)

items = []
for line in windows:
    try:
        window_id, index, name = line.split("|", 2)
    except ValueError:
        continue
    try:
        raw = run("show-window-options", "-v", "-t", window_id, "@aimux-meta").strip()
        meta = json.loads(raw)
    except Exception:
        continue
    worktree = meta.get("worktreePath") or project_root
    if not worktree or not current_path.startswith(worktree):
        continue
    kind = meta.get("kind") or "agent"
    items.append({
        "windowId": window_id,
        "windowIndex": int(index),
        "kind": kind,
        "sessionId": meta.get("sessionId", ""),
        "worktreePath": worktree,
        "attention": meta.get("attention", ""),
        "unseenCount": int(meta.get("unseenCount") or 0),
        "statusText": meta.get("statusText", ""),
    })

if not items:
    raise SystemExit(1)

current_worktree = None
for item in items:
    if item.get("windowId") == current_window_id:
        current_worktree = item.get("worktreePath")
        break

if current_worktree:
    items = [item for item in items if item.get("worktreePath") == current_worktree]
else:
    items = [item for item in items if current_path.startswith(item.get("worktreePath") or "")]

items.sort(key=lambda s: (0 if s.get("kind") == "agent" else 1, s.get("windowIndex", 10**9)))
if not items:
    raise SystemExit(1)

current_index = 0
for idx, item in enumerate(items):
    if item.get("windowId") == current_window_id:
        current_index = idx
        break

if action == "next":
    print(items[(current_index + 1) % len(items)]["windowId"])
    raise SystemExit(0)
if action == "prev":
    print(items[(current_index - 1) % len(items)]["windowId"])
    raise SystemExit(0)
if action == "attention":
    def rank(item):
        return (
            1 if item.get("attention") == "needs-input" else 0,
            item.get("unseenCount", 0),
            1 if item.get("statusText") == "blocked" else 0,
        )
    ranked = sorted(items, key=rank, reverse=True)
    if rank(ranked[0]) == (0, 0, 0):
        raise SystemExit(1)
    print(ranked[0]["windowId"])
    raise SystemExit(0)
if action == "window":
    try:
        index = int(item_index)
    except Exception:
        raise SystemExit(1)
    if index < 1 or index > len(items):
        raise SystemExit(1)
    print(items[index - 1]["windowId"])
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
      switch_local_dashboard || open_dashboard_via_aimux
      ;;
    inbox)
      show_local_inbox_popup
      ;;
    menu)
      show_local_switcher
      ;;
    active)
      return 0
      ;;
    next|prev|attention|window)
      target_window_id=$(resolve_local_target_from_tmux_metadata || resolve_local_target_from_statusline) || return 1
      target_item_id=$(tmux show-window-options -v -t "$target_window_id" @aimux-meta 2>/dev/null | python3 -c 'import json,sys; import sys; raw=sys.stdin.read().strip(); print((json.loads(raw).get("sessionId","") if raw else ""))' 2>/dev/null || true)
      switch_local_window "$target_window_id" "$target_item_id"
      ;;
  esac
  return 1
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
  inbox) path="/control/open-inbox" ;;
  window) path="/control/focus-window" ;;
  active) path="/control/active-window" ;;
  menu) path="" ;;
  *) exit 1 ;;
esac

case "$action" in
  next|prev|attention|dashboard|inbox|menu|window|active)
    fallback_local_control && exit 0
    ;;
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

fallback_local_control && exit 0

exit 28
