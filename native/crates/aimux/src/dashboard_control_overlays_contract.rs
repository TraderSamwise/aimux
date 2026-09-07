use serde_json::{Value, json};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub fn run_dashboard_control_overlays_contract_case(input: &Value) -> Value {
    let mut state = OverlayState {
        mode: string_or(input, "mode", "dashboard"),
        active_index: input
            .get("activeIndex")
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize,
        busy_state: value_field(input, "dashboardBusyState").clone(),
        error_state: value_field(input, "dashboardErrorState").clone(),
        overlay_state: value_or(input, "dashboardOverlayState", json!({ "kind": "none" })),
        dashboard_state: DashboardState {
            screen: string_or(input, "screen", "dashboard"),
            level: string_or(input, "level", "sessions"),
            session_index: input
                .get("sessionIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            worktree_entries: array_field(input, "worktreeEntries"),
            worktree_sessions: array_field(input, "worktreeSessions"),
        },
        agent_restore_confirm_selection: string_or(
            input,
            "agentRestoreConfirmSelection",
            "restore",
        ),
        dashboard_agent_restore_offer_cache: value_field(input, "dashboardAgentRestoreOfferCache")
            .clone(),
        footer_flash: Value::Null,
        footer_flash_ticks: 0,
        pending_local_navigation: Value::Null,
        coordination_loaded: Value::Null,
        dashboard_sessions: array_field(input, "dashboardSessions"),
        calls: Vec::new(),
    };
    let handled = handle_active_dashboard_overlay_key(&mut state, &string_field(input, "key"));
    json!({
        "handled": handled,
        "overlayKind": state.overlay_kind(),
        "errorState": state.error_state,
        "busyState": state.busy_state,
        "selection": state.agent_restore_confirm_selection,
        "footerFlash": state.footer_flash,
        "footerFlashTicks": state.footer_flash_ticks,
        "pendingLocalNavigation": state.pending_local_navigation,
        "coordinationLoaded": state.coordination_loaded,
        "calls": state.calls,
    })
}

fn handle_active_dashboard_overlay_key(state: &mut OverlayState, raw_key: &str) -> bool {
    if !state.busy_state.is_null() {
        let event = key_event(raw_key);
        if is_guarded_local_dashboard_navigation(state, &event) {
            return false;
        }
        if is_dashboard_local_navigation_event(state, &event) {
            state.pending_local_navigation = json!({
                "data": buffer_json(raw_key),
                "key": event.command,
                "queuedAt": 1_700_000_000_000_i64,
            });
        }
        return true;
    }
    if !state.error_state.is_null() {
        let event = key_event(raw_key);
        if matches!(event.command.as_str(), "escape" | "enter" | "return") {
            state.call("dismissDashboardError", vec![]);
            state.error_state = Value::Null;
        }
        return true;
    }
    match state.overlay_kind().as_deref() {
        Some("agent-restore-confirm") => {
            handle_agent_restore_confirm_key(state, raw_key);
            true
        }
        Some("tool-picker") => state.call_and_handle("handleToolPickerKey", raw_key),
        Some("tool-options") => state.call_and_handle("handleToolOptionsKey", raw_key),
        Some("teammate-picker") => state.call_and_handle("handleTeammatePickerKey", raw_key),
        Some("overseer") => state.call_and_handle("handleOverseerOverlayKey", raw_key),
        Some("overseer-watch-instructions") => {
            state.call_and_handle("handleOverseerWatchInstructionsKey", raw_key)
        }
        Some("work-outline") => state.call_and_handle("handleWorkOutlineOverlayKey", raw_key),
        Some("worktree-remove-confirm") => {
            state.call_and_handle("handleWorktreeRemoveConfirmKey", raw_key)
        }
        Some("worktree-cache-cleanup-confirm") => {
            state.call_and_handle("handleWorktreeCacheCleanupConfirmKey", raw_key)
        }
        Some("worktree-input") => state.call_and_handle("handleWorktreeInputKey", raw_key),
        Some("service-input") => state.call_and_handle("handleServiceInputKey", raw_key),
        Some("worktree-list") => state.call_and_handle("handleWorktreeListKey", raw_key),
        Some("migrate-picker") => state.call_and_handle("handleMigratePickerKey", raw_key),
        Some("switcher") => state.call_and_handle("handleSwitcherKey", raw_key),
        Some("thread-reply") => state.call_and_handle("handleThreadReplyKey", raw_key),
        Some("orchestration-route-picker") => {
            state.call_and_handle("handleOrchestrationRoutePickerKey", raw_key)
        }
        Some("orchestration-input") => {
            state.call_and_handle("handleOrchestrationInputKey", raw_key)
        }
        Some("label-input") => state.call_and_handle("handleLabelInputKey", raw_key),
        _ => false,
    }
}

fn handle_agent_restore_confirm_key(state: &mut OverlayState, raw_key: &str) {
    let event = key_event(raw_key);
    match event.command.as_str() {
        "left" | "right" => {
            state.agent_restore_confirm_selection =
                if state.agent_restore_confirm_selection == "cancel" {
                    "restore".into()
                } else {
                    "cancel".into()
                };
            state.call("redrawDashboardWithOverlay", vec![]);
        }
        "escape" => dismiss_agent_restore_offer(state),
        "enter" | "return" => {
            if state.agent_restore_confirm_selection == "cancel" {
                dismiss_agent_restore_offer(state);
            } else {
                restore_agent_restore_offer(state);
            }
        }
        _ => {}
    }
}

fn restore_agent_restore_offer(state: &mut OverlayState) {
    let session_ids = session_ids_from_restore_offer(state);
    state.clear_dashboard_overlay();
    state.agent_restore_confirm_selection = "restore".into();
    let count = session_ids.len();
    state.footer_flash = Value::String(if count > 0 {
        format!(
            "Restoring {count} previously running agent{}",
            if count == 1 { "" } else { "s" }
        )
    } else {
        "Restoring previously running agents".into()
    });
    state.footer_flash_ticks = MAX_SAFE_INTEGER;
    for session_id in &session_ids {
        state.call(
            "setPendingDashboardSessionAction",
            vec![
                Value::String(session_id.clone()),
                Value::String("starting".into()),
            ],
        );
    }
    state.call("renderDashboard", vec![]);
    state.call(
        "postToProjectService",
        vec![
            Value::String("/agents/restore-previous".into()),
            json!({}),
            json!({ "timeoutMs": 10000 }),
        ],
    );
    state.call(
        "refreshDashboardModelFromService",
        vec![Value::Bool(true), lifecycle_arg()],
    );
    if !session_ids.is_empty() {
        state.call("getDashboardSessions", vec![]);
        let restored = session_ids
            .iter()
            .filter(|session_id| {
                state.dashboard_sessions.iter().any(|session| {
                    string_field(session, "id") == **session_id
                        && is_restored_dashboard_session(session)
                })
            })
            .count();
        state.footer_flash =
            Value::String(format!("Restoring agents {restored}/{}", session_ids.len()));
        state.footer_flash_ticks = MAX_SAFE_INTEGER;
        state.call("renderDashboard", vec![]);
    }
}

fn dismiss_agent_restore_offer(state: &mut OverlayState) {
    state.clear_dashboard_overlay();
    state.agent_restore_confirm_selection = "restore".into();
    state.footer_flash = Value::String("Dismissed agent restore".into());
    state.footer_flash_ticks = 3;
    state.call("renderDashboard", vec![]);
    state.call(
        "postToProjectService",
        vec![
            Value::String("/agents/restore-previous/dismiss".into()),
            json!({}),
        ],
    );
    state.call(
        "refreshDashboardModelFromService",
        vec![Value::Bool(true), lifecycle_arg()],
    );
    state.call("renderDashboard", vec![]);
}

fn session_ids_from_restore_offer(state: &OverlayState) -> Vec<String> {
    state
        .dashboard_agent_restore_offer_cache
        .get("sessionIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn lifecycle_arg() -> Value {
    json!({
        "lifecycle": {
            "mode": "dashboard",
            "inputEpoch": 0,
            "requiresInputEpoch": true,
        }
    })
}

fn is_restored_dashboard_session(session: &Value) -> bool {
    !matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited")
    ) && session.get("pendingAction").is_none()
        && session.get("optimistic").and_then(Value::as_bool) != Some(true)
}

fn is_dashboard_local_navigation_event(state: &OverlayState, event: &ParsedKey) -> bool {
    state.mode == "dashboard"
        && state.dashboard_state.screen == "dashboard"
        && is_plain_local_navigation_event(event)
}

fn is_guarded_local_dashboard_navigation(state: &OverlayState, event: &ParsedKey) -> bool {
    if !is_dashboard_local_navigation_event(state, event) {
        return false;
    }
    if matches!(event.command.as_str(), "escape" | "left" | "h") {
        return true;
    }
    if state.dashboard_state.level == "worktrees" {
        return true;
    }
    let selected = state
        .dashboard_state
        .worktree_entries
        .get(state.dashboard_state.session_index);
    if selected.is_none() {
        return state
            .dashboard_sessions
            .get(state.active_index)
            .is_some_and(is_live_dashboard_session);
    }
    let selected = selected.unwrap_or(&Value::Null);
    if selected.get("kind").and_then(Value::as_str) == Some("service") {
        return true;
    }
    let selected_id = selected.get("id").and_then(Value::as_str);
    state
        .dashboard_state
        .worktree_sessions
        .iter()
        .any(|session| {
            selected_id == session.get("id").and_then(Value::as_str)
                && is_live_dashboard_session(session)
        })
}

fn is_live_dashboard_session(session: &Value) -> bool {
    !matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited")
    )
}

fn is_plain_local_navigation_event(event: &ParsedKey) -> bool {
    if event.shift {
        return false;
    }
    matches!(
        event.command.as_str(),
        "escape" | "left" | "right" | "enter" | "return" | "h" | "l"
    )
}

#[derive(Debug)]
struct ParsedKey {
    command: String,
    shift: bool,
}

fn key_event(raw_key: &str) -> ParsedKey {
    match raw_key {
        "\r" | "\n" => ParsedKey {
            command: "enter".into(),
            shift: false,
        },
        "\u{1b}" => ParsedKey {
            command: "escape".into(),
            shift: false,
        },
        "\u{1b}[C" => ParsedKey {
            command: "right".into(),
            shift: false,
        },
        "\u{1b}[D" => ParsedKey {
            command: "left".into(),
            shift: false,
        },
        value => ParsedKey {
            command: value.chars().next().unwrap_or_default().to_string(),
            shift: value
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_uppercase()),
        },
    }
}

fn buffer_json(raw_key: &str) -> Value {
    json!({
        "type": "Buffer",
        "data": raw_key.as_bytes(),
    })
}

struct OverlayState {
    mode: String,
    active_index: usize,
    busy_state: Value,
    error_state: Value,
    overlay_state: Value,
    dashboard_state: DashboardState,
    agent_restore_confirm_selection: String,
    dashboard_agent_restore_offer_cache: Value,
    footer_flash: Value,
    footer_flash_ticks: i64,
    pending_local_navigation: Value,
    coordination_loaded: Value,
    dashboard_sessions: Vec<Value>,
    calls: Vec<Value>,
}

impl OverlayState {
    fn overlay_kind(&self) -> Option<String> {
        self.overlay_state
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn call_and_handle(&mut self, method: &str, raw_key: &str) -> bool {
        self.call(method, vec![buffer_json(raw_key)]);
        true
    }

    fn clear_dashboard_overlay(&mut self) {
        self.call("clearDashboardOverlay", vec![]);
        self.overlay_state = json!({ "kind": "none" });
    }
}

struct DashboardState {
    screen: String,
    level: String,
    session_index: usize,
    worktree_entries: Vec<Value>,
    worktree_sessions: Vec<Value>,
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn value_or(value: &Value, key: &str, default: Value) -> Value {
    value.get(key).cloned().unwrap_or(default)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_or(value: &Value, key: &str, default: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_owned()
}
