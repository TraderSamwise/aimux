use serde_json::{Map, Value, json};

pub fn run_session_runtime_label_update_contract_case(input: &Value) -> Value {
    let mut state = LabelUpdateState::new(input);
    state.update_session_label();
    state.summary()
}

struct LabelUpdateState {
    input: Value,
    mode: String,
    session_id: String,
    label: Option<String>,
    dashboard_input_epoch: Option<i64>,
    footer_flash: Value,
    footer_flash_ticks: Value,
    labels: Option<Vec<(String, String)>>,
    offline_sessions: Option<Vec<Value>>,
    dashboard_sessions_cache: Option<Vec<Value>>,
    dashboard_worktree_groups_cache: Option<Vec<Value>>,
    worktree_sessions: Option<Vec<Value>>,
    calls: Vec<Value>,
}

impl LabelUpdateState {
    fn new(input: &Value) -> Self {
        let mode = string_or(input, "mode", "session");
        let dashboard_mode = mode == "dashboard";
        Self {
            input: input.clone(),
            mode,
            session_id: string_field(input, "sessionId"),
            label: optional_string(input, "label"),
            dashboard_input_epoch: dashboard_mode.then(|| {
                input
                    .get("dashboardInputEpoch")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
            }),
            footer_flash: Value::Null,
            footer_flash_ticks: if dashboard_mode {
                json!(0)
            } else {
                Value::Null
            },
            labels: (!dashboard_mode).then(|| {
                array_field(input, "sessionLabels")
                    .into_iter()
                    .filter_map(|entry| {
                        let pair = entry.as_array()?;
                        Some((
                            pair.first()?.as_str()?.to_owned(),
                            pair.get(1)?.as_str()?.to_owned(),
                        ))
                    })
                    .collect()
            }),
            offline_sessions: (!dashboard_mode).then(|| array_field(input, "offlineSessions")),
            dashboard_sessions_cache: (!dashboard_mode)
                .then(|| array_field(input, "dashboardSessionsCache")),
            dashboard_worktree_groups_cache: (!dashboard_mode)
                .then(|| array_field(input, "dashboardWorktreeGroupsCache")),
            worktree_sessions: (!dashboard_mode).then(|| array_field(input, "worktreeSessions")),
            calls: Vec::new(),
        }
    }

    fn update_session_label(&mut self) {
        if self.mode == "dashboard" {
            self.update_dashboard_session_label();
        } else {
            self.update_local_session_label();
        }
    }

    fn update_dashboard_session_label(&mut self) {
        let pending_token = self
            .input
            .get("pendingToken")
            .cloned()
            .unwrap_or(Value::Null);
        self.call(
            "setPendingDashboardSessionAction",
            vec![json!(self.session_id), json!("renaming")],
        );
        self.call("writeStatuslineFile", vec![]);
        self.call("renderCurrentDashboardView", vec![]);

        let post_failed = optional_string(&self.input, "postThrows");
        self.call(
            "postToProjectService",
            vec![
                json!("/agents/rename"),
                json!({
                    "sessionId": self.session_id,
                    "label": self.label,
                }),
            ],
        );
        if bool_field(&self.input, "staleAfterPost")
            && let Some(epoch) = self.dashboard_input_epoch.as_mut()
        {
            *epoch += 1;
        }

        if post_failed.is_none() {
            self.call("invalidateDesktopStateSnapshot", vec![]);
            self.call_refresh_dashboard_model();
        } else {
            self.call_refresh_dashboard_model();
            if self.dashboard_lifecycle_current()
                && let Some(message) = post_failed
            {
                self.footer_flash = json!(format!("Rename failed: {message}"));
                self.footer_flash_ticks = json!(4);
            }
        }

        self.clear_pending_action(&pending_token);
        self.call("writeStatuslineFile", vec![]);
        if self.dashboard_lifecycle_current() {
            self.call("renderCurrentDashboardView", vec![]);
        }
    }

    fn call_refresh_dashboard_model(&mut self) {
        self.call(
            "refreshDashboardModelFromService",
            vec![json!(true), json!({ "lifecycle": { "mode": "dashboard" } })],
        );
    }

    fn dashboard_lifecycle_current(&self) -> bool {
        self.dashboard_input_epoch.unwrap_or_default()
            == self
                .input
                .get("dashboardInputEpoch")
                .and_then(Value::as_i64)
                .unwrap_or_default()
    }

    fn clear_pending_action(&mut self, token: &Value) {
        if token.as_i64().is_some() {
            if bool_field_default(&self.input, "withTokenClearer", true) {
                self.call(
                    "dashboardPendingActions.clearSessionActionIfToken",
                    vec![json!(self.session_id), token.clone()],
                );
                if bool_field_default(&self.input, "clearSessionActionIfToken", true) {
                    self.call("reapplyDashboardPendingActions", vec![]);
                }
                return;
            }
            self.call(
                "setPendingDashboardSessionAction",
                vec![json!(self.session_id), Value::Null],
            );
            return;
        }
        self.call(
            "setPendingDashboardSessionAction",
            vec![json!(self.session_id), Value::Null],
        );
    }

    fn update_local_session_label(&mut self) {
        let trimmed = self.label.as_deref().unwrap_or_default().trim().to_owned();
        if let Some(labels) = self.labels.as_mut() {
            labels.retain(|(id, _)| id != &self.session_id);
            if !trimmed.is_empty() {
                labels.push((self.session_id.clone(), trimmed.clone()));
            }
        }
        if let Some(offline_sessions) = self.offline_sessions.as_mut()
            && let Some(session) = offline_sessions.iter_mut().find(|session| {
                session.get("id").and_then(Value::as_str) == Some(self.session_id.as_str())
            })
            && let Some(object) = session.as_object_mut()
        {
            if trimmed.is_empty() {
                object.remove("label");
            } else {
                object.insert("label".to_owned(), json!(trimmed));
            }
        }
        self.call("invalidateDesktopStateSnapshot", vec![]);
        self.call("saveState", vec![]);
        self.call("writeStatuslineFile", vec![]);
        self.call("renderDashboard", vec![]);
    }

    fn summary(self) -> Value {
        let labels = self.labels.map(|labels| {
            Value::Array(
                labels
                    .into_iter()
                    .map(|(id, label)| json!([id, label]))
                    .collect(),
            )
        });
        let mut output = Map::new();
        output.insert("error".to_owned(), Value::Null);
        output.insert("labels".to_owned(), labels.unwrap_or(Value::Null));
        output.insert(
            "offlineSessions".to_owned(),
            self.offline_sessions
                .map(Value::Array)
                .unwrap_or(Value::Null),
        );
        output.insert(
            "dashboardSessionsCache".to_owned(),
            self.dashboard_sessions_cache
                .map(Value::Array)
                .unwrap_or(Value::Null),
        );
        output.insert(
            "dashboardWorktreeGroupsCache".to_owned(),
            self.dashboard_worktree_groups_cache
                .map(Value::Array)
                .unwrap_or(Value::Null),
        );
        output.insert(
            "worktreeSessions".to_owned(),
            self.worktree_sessions
                .map(Value::Array)
                .unwrap_or(Value::Null),
        );
        output.insert("footerFlash".to_owned(), self.footer_flash);
        output.insert("footerFlashTicks".to_owned(), self.footer_flash_ticks);
        output.insert(
            "dashboardInputEpoch".to_owned(),
            self.dashboard_input_epoch
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        output.insert("calls".to_owned(), Value::Array(self.calls));
        Value::Object(output)
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_or(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn bool_field_default(value: &Value, key: &str, fallback: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}
