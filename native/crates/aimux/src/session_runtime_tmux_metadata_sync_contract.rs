use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

pub fn run_session_runtime_tmux_metadata_sync_contract_case(input: &Value) -> Value {
    let mut state = TmuxMetadataSyncState::new(input);
    let before = state.build_metadata(false);
    for _ in 0..state.sync_count {
        state.sync_tmux_window_metadata();
    }
    json!({
        "before": before,
        "targetAfter": state.current_target,
        "sessionTmuxTargets": { state.session_id.clone(): state.current_target },
        "calls": state.calls,
    })
}

struct TmuxMetadataSyncState {
    input: Value,
    session_id: String,
    command: String,
    current_target: Value,
    existing_metadata: Value,
    sync_count: usize,
    policy_applied_windows: Vec<String>,
    calls: Vec<Value>,
}

impl TmuxMetadataSyncState {
    fn new(input: &Value) -> Self {
        Self {
            input: input.clone(),
            session_id: string_field(input, "sessionId"),
            command: string_or(input, "command", "codex"),
            current_target: input.get("target").cloned().unwrap_or_else(
                || json!({ "sessionName": "aimux-test", "windowId": "@1", "windowIndex": 1 }),
            ),
            existing_metadata: input.get("existing").cloned().unwrap_or(Value::Null),
            sync_count: input.get("syncCount").and_then(Value::as_u64).unwrap_or(1) as usize,
            policy_applied_windows: Vec::new(),
            calls: Vec::new(),
        }
    }

    fn sync_tmux_window_metadata(&mut self) {
        let Some(target) = self.resolve_live_session_tmux_target() else {
            return;
        };
        let existing = self.get_window_metadata(&target);
        let mut metadata = self.build_metadata(false);
        if let Some(created_at) = existing.get("createdAt").cloned().or_else(|| {
            self.input
                .get("startTime")
                .and_then(Value::as_i64)
                .map(timestamp_ms_to_iso)
                .map(Value::String)
        }) && let Some(object) = metadata.as_object_mut()
        {
            insert_optional_value(object, "createdAt", Some(created_at));
        }
        let changed = existing != metadata;
        if changed {
            self.set_window_metadata(&target, metadata.clone());
        }
        let window_id = string_field(&target, "windowId");
        if changed
            || !self
                .policy_applied_windows
                .iter()
                .any(|id| id == &window_id)
        {
            self.policy_applied_windows.push(window_id);
            self.call(
                "applyManagedAgentWindowPolicy",
                vec![
                    target,
                    Value::String(
                        self.tool_config_key()
                            .unwrap_or_else(|| self.command.clone()),
                    ),
                ],
            );
        }
    }

    fn resolve_live_session_tmux_target(&mut self) -> Option<Value> {
        let candidate = self.current_target.clone();
        let session_name = string_field(&candidate, "sessionName");
        let window_id = string_field(&candidate, "windowId");
        let resolved = self.get_target_by_window_id(&session_name, &window_id)?;
        let metadata = self.get_window_metadata(&resolved);
        if metadata.get("kind").and_then(Value::as_str) == Some("agent")
            && metadata.get("sessionId").and_then(Value::as_str) == Some(self.session_id.as_str())
        {
            self.current_target = resolved.clone();
            return Some(resolved);
        }
        None
    }

    fn build_metadata(&self, include_created_at: bool) -> Value {
        let mut out = Map::new();
        out.insert("kind".into(), json!("agent"));
        out.insert("sessionId".into(), json!(self.session_id));
        out.insert("command".into(), json!(self.command));
        out.insert(
            "args".into(),
            map_array(&self.input, "sessionOriginalArgs", &self.session_id),
        );
        out.insert(
            "toolConfigKey".into(),
            json!(
                self.tool_config_key()
                    .unwrap_or_else(|| self.command.clone())
            ),
        );
        insert_optional_string(
            &mut out,
            "backendSessionId",
            optional_string(&self.input, "backendSessionId"),
        );
        out.insert("overseer".into(), json!(false));
        out.insert("scribe".into(), json!(false));
        out.insert("projectControl".into(), json!(false));
        insert_optional_string(
            &mut out,
            "label",
            map_string(&self.input, "sessionLabels", &self.session_id),
        );
        insert_optional_string(
            &mut out,
            "role",
            map_string(&self.input, "sessionRoles", &self.session_id),
        );
        let derived = self
            .input
            .get("metadata")
            .and_then(|metadata| metadata.get("sessions"))
            .and_then(|sessions| sessions.get(&self.session_id))
            .and_then(|session| session.get("derived"))
            .unwrap_or(&Value::Null);
        insert_optional_string(&mut out, "activity", optional_string(derived, "activity"));
        insert_optional_string(&mut out, "attention", optional_string(derived, "attention"));
        insert_optional_value(&mut out, "unseenCount", derived.get("unseenCount").cloned());
        insert_optional_string(
            &mut out,
            "statusText",
            self.input
                .get("metadata")
                .and_then(|metadata| metadata.get("sessions"))
                .and_then(|sessions| sessions.get(&self.session_id))
                .and_then(|session| session.get("status"))
                .and_then(|status| optional_string(status, "text")),
        );
        let user_label = user_label(derived);
        out.insert("userLabel".into(), Value::String(user_label.clone()));
        if user_label == "needs_input" {
            out.insert("recencyLabel".into(), json!("prompted"));
        }
        if include_created_at
            && let Some(created_at) = self.existing_metadata.get("createdAt").cloned()
        {
            out.insert("createdAt".into(), created_at);
        }
        Value::Object(out)
    }

    fn tool_config_key(&self) -> Option<String> {
        map_string(&self.input, "sessionToolKeys", &self.session_id)
    }

    fn get_target_by_window_id(&mut self, session_name: &str, window_id: &str) -> Option<Value> {
        self.call(
            "getTargetByWindowId",
            vec![json!(session_name), json!(window_id)],
        );
        Some(
            self.input
                .get("resolvedTarget")
                .cloned()
                .unwrap_or_else(|| self.current_target.clone()),
        )
    }

    fn get_window_metadata(&mut self, target: &Value) -> Value {
        self.call("getWindowMetadata", vec![target.clone()]);
        self.existing_metadata.clone()
    }

    fn set_window_metadata(&mut self, target: &Value, metadata: Value) {
        self.call("setWindowMetadata", vec![target.clone(), metadata.clone()]);
        self.existing_metadata = metadata;
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn user_label(derived: &Value) -> String {
    match (
        derived.get("activity").and_then(Value::as_str),
        derived.get("attention").and_then(Value::as_str),
    ) {
        (Some("waiting"), Some("needs_input")) => "needs_input".to_owned(),
        (Some("done"), _) => "done".to_owned(),
        (Some("running"), _) => "working".to_owned(),
        _ => "ready".to_owned(),
    }
}

fn map_array(input: &Value, field: &str, key: &str) -> Value {
    for entry in array_field(input, field) {
        let Some(pair) = entry.as_array() else {
            continue;
        };
        if pair.first().and_then(Value::as_str) == Some(key) {
            return pair.get(1).cloned().unwrap_or_else(|| json!([]));
        }
    }
    json!([])
}

fn map_string(input: &Value, field: &str, key: &str) -> Option<String> {
    for entry in array_field(input, field) {
        let Some(pair) = entry.as_array() else {
            continue;
        };
        if pair.first().and_then(Value::as_str) == Some(key) {
            return pair.get(1).and_then(Value::as_str).map(str::to_owned);
        }
    }
    None
}

fn insert_optional_string(out: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), Value::String(value));
    }
}

fn insert_optional_value(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value
        && !value.is_null()
    {
        out.insert(key.to_owned(), value);
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

fn timestamp_ms_to_iso(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    (OffsetDateTime::UNIX_EPOCH + Duration::seconds(seconds) + Duration::milliseconds(millis))
        .format(&Rfc3339)
        .expect("fixture timestamp formats")
}
