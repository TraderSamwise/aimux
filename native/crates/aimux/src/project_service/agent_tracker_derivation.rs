use serde_json::{Map, Value, json};

pub fn derive_agent_tracker_contract(actions: &[Value]) -> Value {
    let mut tracker = TrackerState::default();
    let mut snapshots = Vec::new();
    for action in actions {
        tracker.apply(action);
        snapshots.push(json!({
            "after": action,
            "state": tracker.state_json(),
        }));
    }
    json!({
        "snapshots": snapshots,
        "finalState": tracker.state_json(),
    })
}

#[derive(Debug, Default)]
struct TrackerState {
    sessions: Map<String, Value>,
    focus: Option<FocusState>,
}

#[derive(Debug, Clone)]
struct FocusState {
    focused: bool,
    session_id: String,
    panel_open: bool,
}

impl TrackerState {
    fn apply(&mut self, action: &Value) {
        let op = string_field(action, "op").unwrap_or_default();
        match op {
            "focus" => self.apply_focus(action),
            "emit" => self.apply_emit(action),
            "markSeen" => self.apply_mark_seen(action),
            "setActivity" => self.apply_set_activity(action),
            "setAttention" => self.apply_set_attention(action),
            _ => {}
        }
    }

    fn apply_focus(&mut self, action: &Value) {
        let context = &action["context"];
        let Some(session_id) = string_field(context, "sessionId") else {
            return;
        };
        self.focus = Some(FocusState {
            focused: context
                .get("focused")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            session_id: session_id.to_owned(),
            panel_open: context
                .get("panelOpen")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }

    fn apply_emit(&mut self, action: &Value) {
        let Some(session_id) = string_field(action, "session") else {
            return;
        };
        let at = action_at(action);
        let mut event = action["event"].clone();
        if event.get("ts").and_then(Value::as_str).is_none()
            && let Value::Object(event_object) = &mut event
        {
            event_object.insert("ts".to_owned(), Value::String(at.clone()));
        }
        let current = self
            .session_derived(session_id)
            .cloned()
            .unwrap_or_default();
        let derived_next = self.derive_from_event(session_id, &current, &event, &at);

        let mut derived = object_from_value(Some(current));
        for (key, value) in derived_next {
            derived.insert(key, value);
        }
        if is_agent_output_event_kind(string_field(&event, "kind").unwrap_or_default()) {
            derived.insert("lastOutputAt".to_owned(), Value::String(at.clone()));
        }
        if let Some(thread_id) = string_field(&event, "threadId") {
            derived.insert("threadId".to_owned(), Value::String(thread_id.to_owned()));
        }
        if let Some(thread_name) = string_field(&event, "threadName") {
            derived.insert(
                "threadName".to_owned(),
                Value::String(thread_name.to_owned()),
            );
        }
        derived.insert("lastEvent".to_owned(), event.clone());
        let mut events = derived
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if events.len() >= 20 {
            events.drain(0..events.len() - 19);
        }
        events.push(event);
        derived.insert("events".to_owned(), Value::Array(events));
        self.write_session(session_id, at, derived);
    }

    fn apply_mark_seen(&mut self, action: &Value) {
        let Some(session_id) = string_field(action, "session") else {
            return;
        };
        let mut derived = object_from_value(self.session_derived(session_id).cloned());
        derived.insert("unseenCount".to_owned(), Value::Number(0.into()));
        self.write_session(session_id, action_at(action), derived);
    }

    fn apply_set_activity(&mut self, action: &Value) {
        let Some(session_id) = string_field(action, "session") else {
            return;
        };
        let Some(activity) = string_field(action, "activity") else {
            return;
        };
        let at = action_at(action);
        let current = object_from_value(self.session_derived(session_id).cloned());
        if current.get("activity").and_then(Value::as_str) == Some(activity) {
            return;
        }
        let previous_was_running =
            current.get("activity").and_then(Value::as_str) == Some("running");
        let mut derived = current;
        derived.insert("activity".to_owned(), Value::String(activity.to_owned()));
        if activity == "running" {
            derived.remove("becameIdleAt");
        } else if previous_was_running {
            derived.insert("becameIdleAt".to_owned(), Value::String(at.clone()));
        }
        self.write_session(session_id, at, derived);
    }

    fn apply_set_attention(&mut self, action: &Value) {
        let Some(session_id) = string_field(action, "session") else {
            return;
        };
        let Some(attention) = string_field(action, "attention") else {
            return;
        };
        let current = object_from_value(self.session_derived(session_id).cloned());
        if current.get("attention").and_then(Value::as_str) == Some(attention) {
            return;
        }
        let mut derived = current;
        derived.insert("attention".to_owned(), Value::String(attention.to_owned()));
        self.write_session(session_id, action_at(action), derived);
    }

    fn derive_from_event(
        &self,
        session_id: &str,
        current: &Value,
        event: &Value,
        at: &str,
    ) -> Map<String, Value> {
        let kind = string_field(event, "kind").unwrap_or_default();
        let message = string_field(event, "message")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let tone = string_field(event, "tone");
        let suppress_unseen = self.is_focused(session_id);
        let mut activity = current
            .get("activity")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut attention = current
            .get("attention")
            .and_then(Value::as_str)
            .unwrap_or("normal")
            .to_owned();
        let mut unseen_count = current
            .get("unseenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mut became_idle_at = current
            .get("becameIdleAt")
            .and_then(Value::as_str)
            .map(str::to_owned);

        match kind {
            "prompt" | "task_assigned" => {
                activity = Some("running".to_owned());
                attention = "normal".to_owned();
            }
            "response" => {
                activity = Some("idle".to_owned());
                attention = "normal".to_owned();
                increment_unseen(&mut unseen_count, suppress_unseen);
            }
            "task_done" => {
                activity = Some("done".to_owned());
                attention = "normal".to_owned();
                increment_unseen(&mut unseen_count, suppress_unseen);
            }
            "task_failed" => {
                activity = Some("error".to_owned());
                attention = "error".to_owned();
                increment_unseen(&mut unseen_count, suppress_unseen);
            }
            "needs_input" => {
                activity = Some("waiting".to_owned());
                attention = "needs_input".to_owned();
                increment_unseen(&mut unseen_count, suppress_unseen);
            }
            "blocked" => {
                activity = Some("waiting".to_owned());
                attention = "blocked".to_owned();
                increment_unseen(&mut unseen_count, suppress_unseen);
            }
            "interrupted" => {
                activity = Some("interrupted".to_owned());
                attention = "normal".to_owned();
                increment_unseen(&mut unseen_count, suppress_unseen);
            }
            "notify" => {
                increment_unseen(&mut unseen_count, suppress_unseen);
                if tone == Some("error") {
                    attention = "error".to_owned();
                }
            }
            "status" => {
                if tone == Some("error") {
                    activity = Some("error".to_owned());
                    attention = "error".to_owned();
                    increment_unseen(&mut unseen_count, suppress_unseen);
                } else if status_needs_input(&message) {
                    activity = Some("waiting".to_owned());
                    attention = "needs_input".to_owned();
                    increment_unseen(&mut unseen_count, suppress_unseen);
                } else if status_blocked(&message) {
                    activity = Some("waiting".to_owned());
                    attention = "blocked".to_owned();
                    increment_unseen(&mut unseen_count, suppress_unseen);
                } else if tone == Some("success") || status_done(&message) {
                    activity = Some("done".to_owned());
                    attention = "normal".to_owned();
                    increment_unseen(&mut unseen_count, suppress_unseen);
                } else if status_running(&message) {
                    activity = Some("running".to_owned());
                    attention = "normal".to_owned();
                }
            }
            _ => {}
        }

        if activity.as_deref() == Some("running") {
            became_idle_at = None;
        } else if current.get("activity").and_then(Value::as_str) == Some("running")
            && activity.is_some()
        {
            became_idle_at = Some(at.to_owned());
        }

        let mut map = Map::new();
        if let Some(activity) = activity {
            map.insert("activity".to_owned(), Value::String(activity));
        }
        map.insert("attention".to_owned(), Value::String(attention));
        map.insert("unseenCount".to_owned(), Value::Number(unseen_count.into()));
        insert_or_remove(&mut map, "becameIdleAt", became_idle_at.map(Value::String));
        map
    }

    fn is_focused(&self, session_id: &str) -> bool {
        self.focus.as_ref().is_some_and(|focus| {
            focus.focused && !focus.panel_open && focus.session_id == session_id
        })
    }

    fn session_derived(&self, session_id: &str) -> Option<&Value> {
        self.sessions
            .get(session_id)
            .and_then(|session| session.get("derived"))
    }

    fn write_session(&mut self, session_id: &str, updated_at: String, derived: Map<String, Value>) {
        self.sessions.insert(
            session_id.to_owned(),
            json!({
                "updatedAt": updated_at,
                "derived": Value::Object(derived),
            }),
        );
    }

    fn state_json(&self) -> Value {
        json!({
            "version": 1,
            "sessions": self.sessions,
        })
    }
}

fn increment_unseen(unseen_count: &mut u64, suppress_unseen: bool) {
    if !suppress_unseen {
        *unseen_count += 1;
    }
}

fn is_agent_output_event_kind(kind: &str) -> bool {
    matches!(
        kind,
        "response"
            | "task_done"
            | "task_failed"
            | "needs_input"
            | "blocked"
            | "interrupted"
            | "notify"
            | "status"
    )
}

fn status_needs_input(message: &str) -> bool {
    (message.contains("need input") || message.contains("needs input"))
        || message.contains("need your input")
        || message.contains("needs your input")
        || message.contains("waiting for you")
        || message.contains("press enter")
        || message.contains("confirm")
        || message.contains("approval")
}

fn status_blocked(message: &str) -> bool {
    message.contains("blocked") || message.contains("waiting on") || message.contains("stuck")
}

fn status_done(message: &str) -> bool {
    ["done", "complete", "completed", "finished", "resolved"]
        .iter()
        .any(|needle| message.contains(needle))
}

fn status_running(message: &str) -> bool {
    [
        "working",
        "running",
        "thinking",
        "building",
        "deploying",
        "indexing",
        "searching",
        "editing",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

fn action_at(action: &Value) -> String {
    string_field(action, "at").unwrap_or_default().to_owned()
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn object_from_value(value: Option<Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(object)) => object,
        _ => Map::new(),
    }
}

fn insert_or_remove(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value);
    } else {
        map.remove(key);
    }
}
