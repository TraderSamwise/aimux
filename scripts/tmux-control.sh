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
    --pane-id)
      pane_id="${2-}"
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
aimux_bin="$script_dir/../bin/aimux"
debug_log="${TMPDIR:-/tmp}/aimux-debug.log"

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
    "${endpoint}${path}" >/dev/null 2>>"$debug_log"
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
  target_index=$(ensure_linked_window "$target_window_id") || return 1
  if [ -n "${live_client_tty-}" ]; then
    tmux switch-client -c "$live_client_tty" -t "${live_client_session}:${target_index}" >/dev/null 2>&1 || return 1
  else
    tmux switch-client -t "${live_client_session}:${target_index}" >/dev/null 2>&1 || return 1
  fi
  tmux refresh-client -S >/dev/null 2>&1 || true
  exit 0
}

resolve_local_target_from_statusline() {
  [ -f "$statusline_json" ] || return 1
  resolved_target=$(
    python3 - "$statusline_json" "$current_path" "$current_window_id" "$window_id" "$action" <<'PY'
import json, sys
path, current_path, current_window_id, explicit_window_id, action = sys.argv[1:]
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
        current_worktree = session.get("worktreePath")
        break
matched = []
best_len = -1
for session in sessions:
    worktree = session.get("worktreePath")
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
    python3 - "$host_session" "$current_path" "$current_window_id" "$window_id" "$action" <<'PY'
import json, subprocess, sys
host_session, current_path, current_window_id, explicit_window_id, action = sys.argv[1:]

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
    worktree = meta.get("worktreePath")
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
raise SystemExit(1)
PY
  ) || return 1
  [ -n "$resolved_target" ] || return 1
  printf '%s' "$resolved_target"
}

fallback_local_control() {
  case "$action" in
    dashboard)
      switch_local_dashboard
      ;;
    next|prev|attention|window)
      target_window_id=$(resolve_local_target_from_statusline || resolve_local_target_from_tmux_metadata) || return 1
      switch_local_window "$target_window_id"
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
  menu) path="/control/show-menu" ;;
  window) path="/control/focus-window" ;;
  *) exit 1 ;;
esac

case "$action" in
  next|prev|attention|dashboard|window)
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
