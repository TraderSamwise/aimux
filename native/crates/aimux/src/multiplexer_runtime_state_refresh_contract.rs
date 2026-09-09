use serde_json::{Map, Value, json};

const FIXED_NOW_MS: i64 = 1_780_272_000_000;
const IDLE_SETTLE_MS: i64 = 10_000;
const BACKGROUND_REFRESH_MS: i64 = 2_000;
const HIDDEN_VISIBILITY_RECHECK_TICKS: i64 = 10;

pub fn run_multiplexer_runtime_state_refresh_contract_case(input: &Value) -> Value {
    let mut runner = RefreshRunner::new(input);
    runner.run_steps(array_field(input, "steps"));
    if bool_field_default(input, "stop", true) {
        runner.status_interval_active = false;
    }
    runner.snapshot()
}

struct RefreshRunner {
    now_ms: i64,
    status_interval_active: bool,
    sessions: Vec<Value>,
    prev_statuses: Vec<(String, String)>,
    session_tool_keys: Vec<(String, String)>,
    session_worktree_paths: Vec<(String, String)>,
    session_labels: Map<String, Value>,
    idle_since: Map<String, Value>,
    capture_last_online_snapshot: bool,
    last_online_snapshot: Option<Value>,
    last_online_key: Option<String>,
    mode: String,
    dashboard_input_epoch: i64,
    dashboard_next_background_refresh_at: i64,
    dashboard_startup_priming: bool,
    dashboard_tui_visibility: Option<Value>,
    dashboard_hidden_visibility_skip_ticks: i64,
    dashboard_tui_visibility_wake_pending: bool,
    dashboard_fields_initialized: bool,
    started_in_dashboard: bool,
    feedback_changed: bool,
    visibility_sequence: Vec<bool>,
    refresh_steps: Vec<Value>,
    pending_refresh: Option<PendingRefresh>,
    screen: String,
    calls: Map<String, Value>,
}

#[derive(Debug)]
struct PendingRefresh {
    mode: String,
    input_epoch: i64,
}

impl RefreshRunner {
    fn new(input: &Value) -> Self {
        let host = value_field(input, "host");
        let mut calls = Map::new();
        for name in [
            "dashboardFeedbackTickFlashVisibilityChanged",
            "publishAlert",
            "refreshDashboardModelFromService",
            "refreshCoordinationFromService",
            "renderCurrentDashboardView",
            "isDashboardScreen",
            "isDashboardTuiVisible",
            "invalidateDashboardFrame",
        ] {
            calls.insert(name.to_string(), json!([]));
        }
        Self {
            now_ms: FIXED_NOW_MS,
            status_interval_active: true,
            sessions: array_field(host, "sessions"),
            prev_statuses: array_field(host, "prevStatuses")
                .into_iter()
                .map(|entry| (string_at(&entry, &[0]), string_at(&entry, &[1])))
                .collect(),
            session_tool_keys: array_field(host, "sessionToolKeys")
                .into_iter()
                .map(|entry| (string_at(&entry, &[0]), string_at(&entry, &[1])))
                .collect(),
            session_worktree_paths: array_field(host, "sessionWorktreePaths")
                .into_iter()
                .map(|entry| (string_at(&entry, &[0]), string_at(&entry, &[1])))
                .collect(),
            session_labels: host
                .get("sessionLabels")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            idle_since: Map::new(),
            capture_last_online_snapshot: bool_field(input, "withProject"),
            last_online_snapshot: None,
            last_online_key: None,
            mode: string_field_default(host, "mode", "agent"),
            dashboard_input_epoch: number_field(host, "dashboardInputEpoch"),
            dashboard_next_background_refresh_at: number_field(
                host,
                "dashboardNextBackgroundRefreshAt",
            ),
            dashboard_startup_priming: bool_field(host, "dashboardStartupPriming"),
            dashboard_tui_visibility: host.get("dashboardTuiVisibility").cloned(),
            dashboard_hidden_visibility_skip_ticks: number_field(
                host,
                "dashboardHiddenVisibilitySkipTicks",
            ),
            dashboard_tui_visibility_wake_pending: bool_field(
                host,
                "dashboardTuiVisibilityWakePending",
            ),
            dashboard_fields_initialized: false,
            started_in_dashboard: bool_field(host, "startedInDashboard"),
            feedback_changed: bool_field(host, "feedbackChanged"),
            visibility_sequence: array_field(host, "visibilitySequence")
                .into_iter()
                .map(|value| value.as_bool().unwrap_or(true))
                .collect(),
            refresh_steps: array_field(host, "refreshSteps"),
            pending_refresh: None,
            screen: string_field_default(host, "screen", "coordination"),
            calls,
        }
    }

    fn run_steps(&mut self, steps: Vec<Value>) {
        for step in steps {
            match string_field(&step, "type").as_str() {
                "tick" => self.tick(number_field(&step, "ms")),
                "setSessionStatus" => {
                    let session_id = string_field(&step, "sessionId");
                    let status = string_field(&step, "status");
                    for session in &mut self.sessions {
                        if string_field(session, "id") == session_id {
                            set_field(session, "status", json!(status));
                        }
                    }
                }
                "pushSession" => {
                    let session = step.get("session").cloned().unwrap_or(Value::Null);
                    let session_id = string_field(&session, "id");
                    self.sessions.push(session);
                    if let Some(tool) = step.get("tool").and_then(Value::as_str) {
                        self.set_pair("tool", &session_id, tool);
                    }
                    if let Some(worktree_path) = step.get("worktreePath").and_then(Value::as_str) {
                        self.set_pair("worktree", &session_id, worktree_path);
                    }
                }
                "setMode" => self.mode = string_field(&step, "mode"),
                "setInputEpoch" => self.dashboard_input_epoch = number_field(&step, "value"),
                "resolveRefresh" => self.resolve_pending_refresh(
                    step.get("value").and_then(Value::as_bool).unwrap_or(true),
                ),
                other => panic!("unknown runtime-state refresh step: {other}"),
            }
        }
    }

    fn tick(&mut self, ms: i64) {
        self.now_ms += ms;
        self.record("dashboardFeedbackTickFlashVisibilityChanged", json!([]));
        self.refresh_idle_alerts();
        if self.mode == "dashboard" {
            self.refresh_dashboard();
        }
    }

    fn refresh_idle_alerts(&mut self) {
        let sessions = self.sessions.clone();
        for session in sessions {
            let session_id = string_field(&session, "id");
            let status = string_field(&session, "status");
            let previous = self.prev_status(&session_id);
            if status == "idle" {
                if previous.as_deref() != Some("idle") {
                    self.idle_since
                        .insert(session_id.clone(), json!(self.now_ms));
                } else if let Some(since) = self.idle_since.get(&session_id).and_then(Value::as_i64)
                    && self.now_ms - since >= IDLE_SETTLE_MS
                {
                    self.record(
                        "publishAlert",
                        json!([{
                            "kind": "next_step",
                            "sessionId": session_id,
                            "title": format!("{session_id} ready for next step"),
                            "message": "Agent stopped after a turn.",
                            "dedupeKey": format!("idle-needs-input:{session_id}"),
                            "cooldownMs": 15000,
                        }]),
                    );
                    self.idle_since.remove(&session_id);
                }
            } else {
                self.idle_since.remove(&session_id);
            }
            self.set_prev_status(&session_id, &status);
        }
        self.record_online_agents_for_restore();
    }

    fn record_online_agents_for_restore(&mut self) {
        if !self.capture_last_online_snapshot {
            return;
        }
        let sessions = self
            .sessions
            .iter()
            .filter(|session| {
                let status = string_field(session, "status");
                !bool_field(session, "exited")
                    && status != "offline"
                    && status != "exited"
                    && session.get("pendingAction").is_none()
                    && !bool_field(session, "pending")
                    && !bool_field(session, "optimistic")
            })
            .map(|session| self.restore_session_entry(session))
            .filter(|session| !string_field(session, "id").is_empty())
            .collect::<Vec<_>>();
        let key = serde_json::to_string(&sessions).expect("serialize restore key");
        if self.last_online_key.as_deref() == Some(key.as_str()) {
            return;
        }
        if sessions.is_empty() && self.last_online_key.is_none() {
            return;
        }
        self.last_online_key = Some(key);
        if sessions.is_empty() {
            self.last_online_snapshot = None;
            return;
        }
        let session_ids = sessions
            .iter()
            .map(|session| Value::String(string_field(session, "id")))
            .collect::<Vec<_>>();
        self.last_online_snapshot = Some(json!({
            "version": 1,
            "id": "<online-snapshot-id:1>",
            "writerInstanceId": "<writer-instance-id:1>",
            "createdAt": self.now_iso(),
            "updatedAt": self.now_iso(),
            "sessionIds": session_ids,
            "sessions": sessions,
            "worktreeGroups": self.worktree_groups(&sessions),
        }));
    }

    fn restore_session_entry(&self, session: &Value) -> Value {
        let session_id = string_field(session, "id");
        let mut object = Map::new();
        object.insert("id".into(), Value::String(session_id.clone()));
        insert_string_if_present(&mut object, "tool", self.pair_value("tool", &session_id));
        insert_string_if_present(
            &mut object,
            "command",
            Some(string_field(session, "command")),
        );
        insert_string_if_present(
            &mut object,
            "label",
            self.session_labels
                .get(&session_id)
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        );
        insert_string_if_present(
            &mut object,
            "worktreePath",
            self.pair_value("worktree", &session_id),
        );
        Value::Object(object)
    }

    fn worktree_groups(&self, sessions: &[Value]) -> Vec<Value> {
        let count = sessions.len();
        if count == 0 {
            Vec::new()
        } else {
            vec![json!({ "name": "Main Checkout", "count": count })]
        }
    }

    fn set_pair(&mut self, kind: &str, session_id: &str, value: &str) {
        let pairs = if kind == "tool" {
            &mut self.session_tool_keys
        } else {
            &mut self.session_worktree_paths
        };
        if let Some((_, existing)) = pairs.iter_mut().find(|(id, _)| id == session_id) {
            *existing = value.to_owned();
        } else {
            pairs.push((session_id.to_owned(), value.to_owned()));
        }
    }

    fn pair_value(&self, kind: &str, session_id: &str) -> Option<String> {
        let pairs = if kind == "tool" {
            &self.session_tool_keys
        } else {
            &self.session_worktree_paths
        };
        pairs
            .iter()
            .find(|(id, _)| id == session_id)
            .map(|(_, value)| value.clone())
    }

    fn now_iso(&self) -> String {
        let seconds = ((self.now_ms - FIXED_NOW_MS) / 1000).max(0);
        format!("2026-06-01T00:00:{seconds:02}.000Z")
    }

    fn refresh_dashboard(&mut self) {
        self.dashboard_fields_initialized = true;
        let mut force_refresh = false;
        if self.started_in_dashboard {
            if self.dashboard_hidden_visibility_skip_ticks > 0 {
                self.dashboard_hidden_visibility_skip_ticks -= 1;
                return;
            }
            self.record("isDashboardTuiVisible", json!([]));
            let visible = if self.visibility_sequence.is_empty() {
                true
            } else {
                self.visibility_sequence.remove(0)
            };
            if visible {
                self.dashboard_tui_visibility = Some(
                    json!({ "attached": true, "activeWindow": true, "visible": true, "reason": "visible" }),
                );
                self.dashboard_hidden_visibility_skip_ticks = 0;
                if self.dashboard_tui_visibility_wake_pending {
                    self.dashboard_tui_visibility_wake_pending = false;
                    force_refresh = true;
                    self.record("invalidateDashboardFrame", json!([]));
                }
            } else {
                self.dashboard_tui_visibility = Some(
                    json!({ "attached": false, "activeWindow": false, "visible": false, "reason": "hidden" }),
                );
                self.dashboard_hidden_visibility_skip_ticks = HIDDEN_VISIBILITY_RECHECK_TICKS;
                self.dashboard_tui_visibility_wake_pending = false;
                return;
            }
        } else {
            self.dashboard_hidden_visibility_skip_ticks = 0;
            self.dashboard_tui_visibility_wake_pending = false;
        }

        if self.feedback_changed || force_refresh {
            self.record("renderCurrentDashboardView", json!([]));
        }

        let should_background_refresh = !self.dashboard_startup_priming
            && (force_refresh
                || self.dashboard_next_background_refresh_at == 0
                || self.now_ms >= self.dashboard_next_background_refresh_at);
        if should_background_refresh {
            self.dashboard_next_background_refresh_at = self.now_ms + BACKGROUND_REFRESH_MS;
            let lifecycle = json!({ "lifecycle": { "mode": self.mode } });
            self.record(
                "refreshDashboardModelFromService",
                json!([force_refresh, lifecycle]),
            );
            match self.consume_refresh_step() {
                RefreshStep::Pending => (),
                RefreshStep::Deferred => {
                    self.pending_refresh = Some(PendingRefresh {
                        mode: self.mode.clone(),
                        input_epoch: self.dashboard_input_epoch,
                    });
                }
                RefreshStep::Resolved(refreshed) => {
                    if refreshed {
                        self.finish_resolved_refresh(force_refresh);
                    }
                }
            }
        }
    }

    fn finish_resolved_refresh(&mut self, force_refresh: bool) {
        if self.is_dashboard_screen("coordination") {
            self.record(
                "refreshCoordinationFromService",
                json!([{ "lifecycle": {
                    "mode": self.mode,
                    "inputEpoch": self.dashboard_input_epoch,
                    "requiresInputEpoch": true,
                    "screen": "coordination",
                }}]),
            );
            self.is_dashboard_screen("coordination");
        }
        if force_refresh {
            self.is_dashboard_screen("coordination");
            self.record("renderCurrentDashboardView", json!([]));
        }
    }

    fn resolve_pending_refresh(&mut self, refreshed: bool) {
        let Some(pending) = self.pending_refresh.take() else {
            return;
        };
        if refreshed
            && self.mode == pending.mode
            && self.dashboard_input_epoch == pending.input_epoch
        {
            self.finish_resolved_refresh(false);
            self.record("renderCurrentDashboardView", json!([]));
        }
    }

    fn consume_refresh_step(&mut self) -> RefreshStep {
        if self.refresh_steps.is_empty() {
            return RefreshStep::Resolved(true);
        }
        let step = self.refresh_steps.remove(0);
        match string_field(&step, "type").as_str() {
            "pending" => RefreshStep::Pending,
            "defer" => RefreshStep::Deferred,
            "reject" => RefreshStep::Resolved(false),
            _ => RefreshStep::Resolved(step.get("value").and_then(Value::as_bool).unwrap_or(true)),
        }
    }

    fn is_dashboard_screen(&mut self, screen: &str) -> bool {
        self.record("isDashboardScreen", json!([screen]));
        self.screen == screen
    }

    fn prev_status(&self, session_id: &str) -> Option<String> {
        self.prev_statuses
            .iter()
            .find(|(id, _)| id == session_id)
            .map(|(_, status)| status.clone())
    }

    fn set_prev_status(&mut self, session_id: &str, status: &str) {
        if let Some((_, existing)) = self
            .prev_statuses
            .iter_mut()
            .find(|(id, _)| id == session_id)
        {
            *existing = status.to_string();
        } else {
            self.prev_statuses
                .push((session_id.to_string(), status.to_string()));
        }
    }

    fn record(&mut self, name: &str, args: Value) {
        self.calls
            .get_mut(name)
            .and_then(Value::as_array_mut)
            .expect("call log exists")
            .push(args);
    }

    fn snapshot(self) -> Value {
        let mut output = json!({
            "statusIntervalActive": self.status_interval_active,
            "sessions": self.sessions,
            "prevStatuses": self.prev_statuses.into_iter().map(|(id, status)| json!([id, status])).collect::<Vec<_>>(),
            "mode": self.mode,
            "dashboardInputEpoch": self.dashboard_input_epoch,
            "dashboardNextBackgroundRefreshAt": self.dashboard_next_background_refresh_at,
            "dashboardHiddenVisibilitySkipTicks": if self.dashboard_hidden_visibility_skip_ticks == 0 && self.mode != "dashboard" && !self.dashboard_fields_initialized {
                Value::Null
            } else {
                json!(self.dashboard_hidden_visibility_skip_ticks)
            },
            "dashboardTuiVisibility": self.dashboard_tui_visibility.unwrap_or(Value::Null),
            "dashboardTuiVisibilityWakePending": if self.mode == "dashboard" || self.dashboard_fields_initialized {
                json!(self.dashboard_tui_visibility_wake_pending)
            } else {
                Value::Null
            },
            "calls": self.calls,
        });
        if self.capture_last_online_snapshot
            && let Value::Object(object) = &mut output
        {
            object.insert(
                "lastOnlineSnapshot".into(),
                self.last_online_snapshot.unwrap_or(Value::Null),
            );
        }
        output
    }
}

enum RefreshStep {
    Resolved(bool),
    Pending,
    Deferred,
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, field: &str) -> String {
    string_field_default(value, field, "")
}

fn string_field_default(value: &Value, field: &str, default: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_string()
}

fn string_at(value: &Value, path: &[usize]) -> String {
    let mut current = value;
    for index in path {
        current = current.get(*index).unwrap_or(&Value::Null);
    }
    current.as_str().unwrap_or_default().to_string()
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or_default()
}

fn bool_field(value: &Value, field: &str) -> bool {
    value
        .get(field)
        .and_then(Value::as_bool)
        .unwrap_or_default()
}

fn bool_field_default(value: &Value, field: &str, default: bool) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(default)
}

fn insert_string_if_present(object: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        object.insert(key.into(), Value::String(value));
    }
}

fn set_field(value: &mut Value, field: &str, replacement: Value) {
    value
        .as_object_mut()
        .expect("object field target")
        .insert(field.to_string(), replacement);
}
