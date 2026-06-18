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
    next|prev|attention|dashboard|inbox|menu|expose|meta|window|active|team)
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

debug_log_line() {
  printf '%s\n' "aimux-control: $*" >>"$debug_log" 2>/dev/null || true
}

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
    inbox) action_label="open coordination" ;;
    menu) action_label="open switcher" ;;
    expose) action_label="expose sessions" ;;
    meta) action_label="open meta" ;;
    team) action_label="reach teammate" ;;
    *) action_label="$action" ;;
  esac
  debug_log_line "control failure action=$action endpoint_available=${endpoint_available:-0} reason=$failure_reason"
  show_local_message "#[fg=colour203,bold]aimux#[default] couldn't $action_label — $failure_reason"
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

show_local_expose() {
  if [ -z "${live_client_session-}" ] && [ -z "${live_client_tty-}" ]; then
    resolve_live_client || return 1
  fi
  popup_client_tty="${live_client_tty-}"
  [ -n "$popup_client_tty" ] || popup_client_tty="$client_tty"
  popup_session="${live_client_session-}"
  [ -n "$popup_session" ] || popup_session="$current_client_session"
  home_arg=""
  [ -n "$aimux_home" ] && home_arg="--aimux-home $(shell_quote "$aimux_home")"
  # Snapshot the host BEFORE the popup opens; opening it transiently reflows the host pane,
  # so an in-popup capture would catch a mis-sized frame. Exposé reads then deletes this file.
  backdrop_arg=""
  prepaint=""
  expose_backdrop=$(mktemp 2>/dev/null || true)
  if [ -n "$expose_backdrop" ]; then
    capture_target="${current_window_id:-$popup_session}"
    if tmux capture-pane -p -e -t "$capture_target" -S 0 > "$expose_backdrop" 2>/dev/null; then
      backdrop_arg="--backdrop-file $(shell_quote "$expose_backdrop")"
      # Paint the captured screen instantly so the popup shows your work while the exposé
      # process cold-starts; exposé then atomically repaints it dimmed with the panel.
      prepaint="printf '\\033[H'; cat $(shell_quote "$expose_backdrop"); "
    else
      rm -f "$expose_backdrop"
    fi
  fi
  expose_cmd="${prepaint}exec $(shell_quote "$aimux_bin") expose --project-root $(shell_quote "$project_root") --project-state-dir $(shell_quote "$project_state_dir") --current-client-session $(shell_quote "$popup_session") --client-tty $(shell_quote "$popup_client_tty") --current-window $(shell_quote "$current_window") --current-window-id $(shell_quote "$current_window_id") --current-path $(shell_quote "$current_path") --pane-id $(shell_quote "$pane_id") $home_arg $backdrop_arg"
  if [ -n "$popup_client_tty" ]; then
    tmux display-popup -c "$popup_client_tty" -T "aimux exposé" -x C -y C -w 100% -h 100% -B -E "$expose_cmd" >/dev/null 2>&1 || { rm -f "$expose_backdrop"; return 1; }
  else
    tmux display-popup -T "aimux exposé" -x C -y C -w 100% -h 100% -B -E "$expose_cmd" >/dev/null 2>&1 || { rm -f "$expose_backdrop"; return 1; }
  fi
  exit 0
}

show_local_meta() {
  if [ -z "${live_client_session-}" ] && [ -z "${live_client_tty-}" ]; then
    resolve_live_client || return 1
  fi
  popup_session="${live_client_session-}"
  [ -n "$popup_session" ] || popup_session="$current_client_session"
  popup_client_tty="${live_client_tty-}"
  [ -n "$popup_client_tty" ] || popup_client_tty="$client_tty"
  [ -n "$popup_session" ] || return 1

  existing_index=$(tmux list-windows -t "$popup_session" -F '#{window_index}|#{window_name}' 2>/dev/null | awk -F '|' '$2 == "meta-dashboard" { print $1; exit }')
  if [ -n "$existing_index" ]; then
    if [ -n "$popup_client_tty" ]; then
      tmux switch-client -c "$popup_client_tty" -t "${popup_session}:${existing_index}" >/dev/null 2>&1 || return 1
    else
      tmux switch-client -t "${popup_session}:${existing_index}" >/dev/null 2>&1 || return 1
    fi
    exit 0
  fi

  home_arg=""
  [ -n "$aimux_home" ] && home_arg="--aimux-home $(shell_quote "$aimux_home")"
  meta_cmd="exec $(shell_quote "$aimux_bin") meta-dashboard --project-root $(shell_quote "$project_root") --project-state-dir $(shell_quote "$project_state_dir") --current-client-session $(shell_quote "$popup_session") --client-tty $(shell_quote "$popup_client_tty") --current-window $(shell_quote "$current_window") --current-window-id $(shell_quote "$current_window_id") --current-path $(shell_quote "$current_path") --pane-id $(shell_quote "$pane_id") $home_arg"
  tmux new-window -t "$popup_session" -n meta-dashboard "$meta_cmd" >/dev/null 2>&1 || return 1
  exit 0
}

resolve_local_target_from_statusline() {
  [ -f "$statusline_json" ] || return 1
  resolved_target=$(
    python3 - "$statusline_json" "$project_root" "$current_path" "$current_window_id" "$window_id" "$action" "$item_index" "$debug_log" <<'PY'
import json, sys
path, project_root, current_path, current_window_id, explicit_window_id, action, item_index, debug_log = sys.argv[1:]

def log(message):
    if action != "team":
        return
    try:
        with open(debug_log, "a") as handle:
            handle.write(f"aimux-control team statusline: {message}\n")
    except Exception:
        pass

try:
    data = json.load(open(path))
except Exception as error:
    log(f"read failed path={path!r} error={error}")
    raise SystemExit(1)
sessions = list(data.get("sessions") or [])
teammates = list(data.get("teammates") or [])
if explicit_window_id:
    log(f"explicit target {explicit_window_id}")
    print(explicit_window_id)
    raise SystemExit(0)
if action == "team":
    log(f"start currentWindowId={current_window_id!r} sessions={len(sessions)} teammates={len(teammates)}")
    all_sessions = sessions + teammates
    current = None
    for session in all_sessions:
        if session.get("tmuxWindowId") == current_window_id:
            current = session
            break
    if not current:
        live_ids = [
            f"{session.get('id')}:{session.get('tmuxWindowId') or '-'}:{(session.get('team') or {}).get('parentSessionId') or '-'}"
            for session in all_sessions
        ]
        log(f"current not found candidates={live_ids}")
        raise SystemExit(1)

    current_team = current.get("team") or {}
    parent_id = current_team.get("parentSessionId")
    log(f"current id={current.get('id')!r} parentId={parent_id!r} window={current.get('tmuxWindowId')!r}")
    if parent_id:
        parent = next((session for session in sessions if session.get("id") == parent_id), None)
        target = (parent or {}).get("tmuxWindowId") or ""
        if not target:
            log(f"parent target missing parentId={parent_id!r} parentFound={bool(parent)}")
            raise SystemExit(1)
        log(f"target parent window={target!r}")
        print(target)
        raise SystemExit(0)

    current_id = current.get("id")
    if not current_id:
        raise SystemExit(1)

    def parse_time(value):
        if not value:
            return float("inf")
        try:
            from datetime import datetime
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
        except Exception:
            return float("inf")

    direct = [
        session
        for session in teammates
        if (session.get("team") or {}).get("parentSessionId") == current_id
    ]
    log("direct candidates=" + repr([
        f"{session.get('id')}:{session.get('tmuxWindowId') or '-'}:{session.get('status') or '-'}"
        for session in direct
    ]))
    def teammate_order(session):
        order = (session.get("team") or {}).get("order")
        if isinstance(order, bool):
            return float("inf")
        return order if isinstance(order, (int, float)) else float("inf")

    direct.sort(key=lambda session: (
        teammate_order(session),
        parse_time(session.get("createdAt")),
        session.get("id") or "",
    ))
    direct = [session for session in direct if session.get("tmuxWindowId")]
    if not direct:
        log(f"no direct live teammates for currentId={current_id!r}")
        raise SystemExit(1)
    target = direct[0].get("tmuxWindowId")
    log(f"target teammate window={target!r} id={direct[0].get('id')!r}")
    print(target)
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

if explicit_window_id:
    log(f"explicit target {explicit_window_id}")
    print(explicit_window_id)
    raise SystemExit(0)

try:
    windows = run("list-windows", "-t", host_session, "-F", "#{window_id}|#{window_index}|#{window_name}").splitlines()
    log(f"start host={host_session!r} currentWindowId={current_window_id!r} currentPath={current_path!r} windows={len(windows)}")
except Exception as error:
    log(f"list windows failed host={host_session!r} error={error}")
    raise SystemExit(1)

items = []
for line in windows:
    try:
        window_id, index, name = line.split("|", 2)
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
    if not worktree or not current_path.startswith(worktree):
        log(f"skip window={window_id!r} session={meta.get('sessionId')!r} worktree mismatch worktree={worktree!r}")
        continue
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
    })

if not items:
    log("no metadata candidates after filtering")
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
log("items=" + repr([
    f"{item.get('windowId')}:{item.get('sessionId')}:{item.get('kind')}:{(item.get('team') or {}).get('parentSessionId') or '-'}:{item.get('statusText') or '-'}"
    for item in items
]))

items.sort(key=lambda s: (0 if s.get("kind") == "agent" else 1, s.get("windowIndex", 10**9)))
if not items:
    log("no metadata candidates in current worktree")
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
        parent = next((item for item in items if item.get("sessionId") == parent_id and not (item.get("team") or {}).get("parentSessionId")), None)
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
        if (item.get("team") or {}).get("parentSessionId") == current_id
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
      target_window_id=$(resolve_local_target_from_tmux_metadata || resolve_local_target_from_statusline) || return 1
      target_item_id=$(tmux show-window-options -v -t "$target_window_id" @aimux-meta 2>/dev/null | python3 -c 'import json,sys; import sys; raw=sys.stdin.read().strip(); print((json.loads(raw).get("sessionId","") if raw else ""))' 2>/dev/null || true)
      switch_local_window "$target_window_id" "$target_item_id"
      ;;
    team)
      debug_log_line "team requested session=${current_client_session:-unknown} window=${current_window_id:-unknown} path=${current_path:-unknown} pane=${pane_id:-unknown}"
      target_window_id=$(resolve_local_target_from_tmux_metadata || resolve_local_target_from_statusline) || {
        debug_log_line "team no live target session=${current_client_session:-unknown} window=${current_window_id:-unknown} path=${current_path:-unknown}"
        show_local_message "aimux: no live teammate target"
        return 0
      }
      target_item_id=$(tmux show-window-options -v -t "$target_window_id" @aimux-meta 2>/dev/null | python3 -c 'import json,sys; raw=sys.stdin.read().strip(); print((json.loads(raw).get("sessionId","") if raw else ""))' 2>/dev/null || true)
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
  team) path="" ;;
  menu) path="" ;;
  expose) path="" ;;
  meta) path="" ;;
  *) exit 1 ;;
esac

case "$action" in
  next|prev|attention|dashboard|inbox|menu|expose|meta|window|active|team)
    fallback_local_control && exit 0
    ;;
esac

if [ "$endpoint_available" -eq 1 ] && [ -n "$path" ]; then
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

if [ -z "$path" ]; then
  report_control_failure "no tmux target available"
elif [ "$endpoint_available" -eq 1 ]; then
  report_control_failure "runtime is not responding"
else
  report_control_failure "runtime is unavailable (restarting or stopped)"
fi
exit 0
