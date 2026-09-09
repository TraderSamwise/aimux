use serde_json::{Map, Value, json};

pub fn run_session_launch_actions_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "focusSession" => focus_session_case(input),
        "handleAction" => handle_action_case(input),
        api => panic!("unknown session launch actions api: {api}"),
    }
}

fn focus_session_case(input: &Value) -> Value {
    let sessions = array_field(input, "sessions");
    let mut state = FocusState {
        active_index: input
            .get("activeIndex")
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize,
        session_mru: string_array(input, "sessionMRU"),
        targets: pair_array(input, "targets"),
        calls: Vec::new(),
        resolved_targets: pair_array(input, "resolvedTargets"),
        metadata: pair_array(input, "metadata"),
        project_windows: array_field(input, "projectWindows"),
        open_result: string_field(input, "openResult"),
        project_root: input
            .get("projectRoot")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("<REPO>")
            .to_owned(),
    };
    let index = input.get("index").and_then(Value::as_i64).unwrap_or(-1);
    if index >= 0 && (index as usize) < sessions.len() {
        focus_session(&sessions, &mut state, index as usize);
    }
    json!({
        "activeIndex": state.active_index,
        "sessionMRU": state.session_mru,
        "targets": state.targets,
        "calls": state.calls,
    })
}

fn focus_session(sessions: &[Value], state: &mut FocusState, index: usize) {
    let session = &sessions[index];
    let session_id = string_field(session, "id");
    if session_id.is_empty() {
        return;
    }
    if let Some(target) = state.target_for(&session_id).cloned()
        && let Some(resolved) = resolve_live_session_tmux_target(state, &session_id, &target)
    {
        state.call("selectLinkedOrOpenTarget", vec![resolved]);
        mark_focused_session(state, index, &session_id);
        state.call("saveState", vec![]);
        post_focus_telemetry(state, &session_id);
        return;
    }

    let mut entry = Map::new();
    entry.insert("id".into(), Value::String(session_id.clone()));
    if let Some(backend_session_id) = session.get("backendSessionId").and_then(Value::as_str) {
        entry.insert(
            "backendSessionId".into(),
            Value::String(backend_session_id.to_owned()),
        );
    }
    state.call("openLiveTmuxWindowForEntry", vec![Value::Object(entry)]);
    if state.open_result == "opened" {
        mark_focused_session(state, index, &session_id);
        state.call("saveState", vec![]);
        post_focus_telemetry(state, &session_id);
    }
}

fn resolve_live_session_tmux_target(
    state: &mut FocusState,
    session_id: &str,
    candidate: &Value,
) -> Option<Value> {
    let session_name = string_field(candidate, "sessionName");
    let window_id = string_field(candidate, "windowId");
    state.call(
        "tmuxRuntimeManager.getTargetByWindowId",
        vec![
            Value::String(session_name),
            Value::String(window_id.clone()),
        ],
    );
    if let Some(resolved) = state.pair_value("resolvedTargets", &window_id).cloned() {
        if resolved.is_null() {
            state.remove_target(session_id);
        } else {
            state.call(
                "tmuxRuntimeManager.getWindowMetadata",
                vec![resolved.clone()],
            );
            let metadata = state.pair_value("metadata", &window_id);
            if metadata
                .and_then(|value| value.get("kind"))
                .and_then(Value::as_str)
                == Some("agent")
                && metadata
                    .and_then(|value| value.get("sessionId"))
                    .and_then(Value::as_str)
                    == Some(session_id)
            {
                state.set_target(session_id, resolved.clone());
                return Some(resolved);
            }
            state.remove_target(session_id);
        }
    } else {
        state.remove_target(session_id);
    }

    state.call(
        "tmuxRuntimeManager.listProjectManagedWindows",
        vec![Value::String(state.project_root.clone())],
    );
    for row in state.project_windows.clone() {
        let metadata = row.get("metadata").unwrap_or(&Value::Null);
        if metadata.get("kind").and_then(Value::as_str) != Some("agent")
            || metadata.get("sessionId").and_then(Value::as_str) != Some(session_id)
        {
            continue;
        }
        let target = row.get("target").cloned().unwrap_or(Value::Null);
        if target.get("alive").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        state.set_target(session_id, target.clone());
        return Some(target);
    }
    None
}

fn mark_focused_session(state: &mut FocusState, index: usize, session_id: &str) {
    state.active_index = index;
    state.session_mru.retain(|id| id != session_id);
    state.session_mru.insert(0, session_id.to_owned());
    state.call(
        "noteLastUsedItem",
        vec![Value::String(session_id.to_owned())],
    );
}

fn post_focus_telemetry(state: &mut FocusState, session_id: &str) {
    state.call(
        "postToProjectService",
        vec![
            Value::String("/notification-context".into()),
            json!({
                "source": "tui",
                "focused": true,
                "screen": "agent",
                "sessionId": session_id,
                "panelOpen": false,
            }),
            json!({ "timeoutMs": 3000 }),
        ],
    );
    state.call(
        "postToProjectService",
        vec![
            Value::String("/mark-seen".into()),
            json!({ "session": session_id }),
        ],
    );
}

fn handle_action_case(input: &Value) -> Value {
    let mut state = ActionState {
        sessions: array_field(input, "sessions"),
        active_index: input
            .get("activeIndex")
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize,
        coordination_loaded: Value::Null,
        calls: Vec::new(),
    };
    for action in array_field(input, "actions") {
        handle_action(&mut state, &action);
    }
    json!({
        "activeIndex": state.active_index,
        "coordinationLoaded": state.coordination_loaded,
        "calls": state.calls,
    })
}

fn handle_action(state: &mut ActionState, action: &Value) {
    match action.get("type").and_then(Value::as_str) {
        Some("dashboard") => state.call("openTmuxDashboardTarget", vec![]),
        Some("coordination") => {
            state.call("clearDashboardSubscreens", vec![]);
            state.call(
                "setDashboardScreen",
                vec![Value::String("coordination".into())],
            );
            state.coordination_loaded = Value::Bool(false);
            state.call("persistDashboardUiState", vec![]);
            state.call("openTmuxDashboardTarget", vec![]);
            state.call("refreshCoordinationFromService", vec![]);
        }
        Some("help") => state.call("showHelp", vec![]),
        Some("focus") => {
            let scoped = scoped_session_entries(&state.sessions);
            let index = action
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(usize::MAX as u64) as usize;
            if index < scoped.len() {
                state.call("focusSession", vec![Value::from(scoped[index])]);
            }
        }
        Some("next") => {
            let scoped = scoped_session_entries(&state.sessions);
            if scoped.len() > 1
                && let Some(position) = scoped.iter().position(|index| *index == state.active_index)
            {
                state.call(
                    "focusSession",
                    vec![Value::from(scoped[(position + 1) % scoped.len()])],
                );
            }
        }
        Some("prev") => {
            let scoped = scoped_session_entries(&state.sessions);
            if scoped.len() > 1
                && let Some(position) = scoped.iter().position(|index| *index == state.active_index)
            {
                state.call(
                    "focusSession",
                    vec![Value::from(
                        scoped[(position + scoped.len() - 1) % scoped.len()],
                    )],
                );
            }
        }
        Some("create") => state.call("showToolPicker", vec![]),
        Some("kill") => {
            if let Some(session) = state.sessions.get(state.active_index) {
                let id = string_field(session, "id");
                state.call(&format!("session.{id}.kill"), vec![]);
            }
        }
        Some("switcher") => {
            if scoped_session_entries(&state.sessions).len() > 1 {
                state.call("showSwitcher", vec![]);
            }
        }
        Some("worktree-create") => state.call("showWorktreeCreatePrompt", vec![]),
        Some("worktree-list") => state.call("showWorktreeList", vec![]),
        Some("work-outline") => {
            state.call("openTmuxDashboardTarget", vec![]);
            state.call(
                "showWorkOutlineOverlay",
                vec![active_human_session_id(state)],
            );
        }
        Some("review") => state.call("handleReviewRequest", vec![]),
        _ => {}
    }
}

struct FocusState {
    active_index: usize,
    session_mru: Vec<String>,
    targets: Vec<(String, Value)>,
    calls: Vec<Value>,
    resolved_targets: Vec<(String, Value)>,
    metadata: Vec<(String, Value)>,
    project_windows: Vec<Value>,
    open_result: String,
    project_root: String,
}

impl FocusState {
    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn pair_value(&self, name: &str, key: &str) -> Option<&Value> {
        let pairs = match name {
            "resolvedTargets" => &self.resolved_targets,
            "metadata" => &self.metadata,
            _ => &self.targets,
        };
        pairs
            .iter()
            .find_map(|(candidate, value)| (candidate == key).then_some(value))
    }

    fn target_for(&self, key: &str) -> Option<&Value> {
        self.targets
            .iter()
            .find_map(|(candidate, value)| (candidate == key).then_some(value))
    }

    fn set_target(&mut self, key: &str, value: Value) {
        if let Some((_, existing)) = self
            .targets
            .iter_mut()
            .find(|(candidate, _)| candidate == key)
        {
            *existing = value;
        } else {
            self.targets.push((key.to_owned(), value));
        }
    }

    fn remove_target(&mut self, key: &str) {
        self.targets.retain(|(candidate, _)| candidate != key);
    }
}

struct ActionState {
    sessions: Vec<Value>,
    active_index: usize,
    coordination_loaded: Value,
    calls: Vec<Value>,
}

impl ActionState {
    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn scoped_session_entries(sessions: &[Value]) -> Vec<usize> {
    sessions
        .iter()
        .enumerate()
        .filter(|(_, session)| !is_project_control_session(session))
        .map(|(index, _)| index)
        .collect()
}

fn active_human_session_id(state: &ActionState) -> Value {
    state
        .sessions
        .get(state.active_index)
        .filter(|session| !is_project_control_session(session))
        .and_then(|session| session.get("id"))
        .and_then(Value::as_str)
        .map_or(Value::Null, |id| Value::String(id.to_owned()))
}

fn is_project_control_session(session: &Value) -> bool {
    let team = session.get("team").unwrap_or(&Value::Null);
    team.get("projectControl").and_then(Value::as_bool) == Some(true)
        || matches!(
            team.get("role").and_then(Value::as_str),
            Some("scribe" | "overseer")
        )
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    array_field(value, key)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn pair_array(value: &Value, key: &str) -> Vec<(String, Value)> {
    array_field(value, key)
        .iter()
        .filter_map(|entry| {
            let pair = entry.as_array()?;
            let key = pair.first()?.as_str()?.to_owned();
            let value = pair.get(1).cloned().unwrap_or(Value::Null);
            Some((key, value))
        })
        .collect()
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
