use crate::project_service::session_semantics::{SessionSemanticsInput, derive_session_semantics};
use serde_json::{Map, Value, json};

pub fn run_session_runtime_metadata_contract_case(input: &Value) -> Value {
    build_tmux_window_metadata(input)
}

fn build_tmux_window_metadata(input: &Value) -> Value {
    let session_id = string_field(input, "sessionId").unwrap_or_default();
    let command = string_field(input, "command").unwrap_or_default();
    let host = value_field(input, "host");
    let metadata = value_field(value_field(input, "metadata"), "sessions")
        .get(&session_id)
        .unwrap_or(&Value::Null);
    let runtime = array_field(host, "sessions")
        .into_iter()
        .find(|session| string_field(session, "id").as_deref() == Some(session_id.as_str()));
    let existing = input.get("existing").unwrap_or(&Value::Null);
    let team = runtime
        .as_ref()
        .and_then(|session| session.get("team").cloned())
        .or_else(|| existing.get("team").cloned());
    let derived = value_field(metadata, "derived");
    let status = runtime
        .as_ref()
        .and_then(|session| string_field(session, "status"))
        .unwrap_or_else(|| "running".to_owned());
    let semantic = derive_session_semantics(SessionSemanticsInput {
        status,
        activity: string_field(derived, "activity"),
        attention: string_field(derived, "attention"),
        unseen_count: integer_field(derived, "unseenCount"),
        ..Default::default()
    });
    let user_label =
        string_path(&semantic, &["user", "label"]).unwrap_or_else(|| "idle".to_owned());
    let last_output_at = string_field(derived, "lastOutputAt").or_else(|| {
        let last_event = value_field(derived, "lastEvent");
        let kind = string_field(last_event, "kind")?;
        if is_agent_output_event_kind(&kind) {
            string_field(last_event, "ts")
        } else {
            None
        }
    });
    let latest_unread_at = if wants_unread_recency(&user_label) {
        latest_unread_notification_at(input, &session_id)
    } else {
        None
    };
    let became_idle_at = string_field(derived, "becameIdleAt");
    let last_used_at = string_path(
        value_field(input, "lastUsed"),
        &["items", &session_id, "lastUsedAt"],
    );
    let anchor = session_recency_anchor(
        &user_label,
        latest_unread_at.as_deref(),
        last_output_at.as_deref(),
        became_idle_at.as_deref(),
        last_used_at.as_deref(),
    );

    let mut out = Map::new();
    out.insert("kind".into(), Value::String("agent".into()));
    out.insert("sessionId".into(), Value::String(session_id.clone()));
    out.insert("command".into(), Value::String(command.clone()));
    out.insert(
        "args".into(),
        map_value(host, "sessionOriginalArgs", &session_id).unwrap_or_else(|| json!([])),
    );
    out.insert(
        "toolConfigKey".into(),
        map_string(host, "sessionToolKeys", &session_id)
            .unwrap_or_else(|| command.clone())
            .into(),
    );
    insert_optional_value(
        &mut out,
        "backendSessionId",
        runtime
            .as_ref()
            .and_then(|session| session.get("backendSessionId").cloned()),
    );
    insert_optional_value(&mut out, "team", team.clone());
    out.insert(
        "overseer".into(),
        Value::Bool(metadata.get("overseer").and_then(Value::as_bool) == Some(true)),
    );
    out.insert(
        "scribe".into(),
        Value::Bool(metadata.get("scribe").and_then(Value::as_bool) == Some(true)),
    );
    out.insert(
        "projectControl".into(),
        Value::Bool(is_project_control_session(
            team.as_ref(),
            metadata.get("overseer").and_then(Value::as_bool),
            metadata.get("scribe").and_then(Value::as_bool),
        )),
    );
    insert_optional_string(
        &mut out,
        "worktreePath",
        map_string(host, "sessionWorktreePaths", &session_id),
    );
    insert_optional_string(&mut out, "label", session_label(host, &session_id));
    insert_optional_string(
        &mut out,
        "role",
        map_string(host, "sessionRoles", &session_id),
    );
    insert_optional_string(&mut out, "activity", string_field(derived, "activity"));
    insert_optional_string(&mut out, "attention", string_field(derived, "attention"));
    insert_optional_value(&mut out, "unseenCount", derived.get("unseenCount").cloned());
    insert_optional_string(
        &mut out,
        "statusText",
        string_path(metadata, &["status", "text"]),
    );
    out.insert("userLabel".into(), Value::String(user_label));
    if let Some(anchor) = anchor {
        insert_optional_string(&mut out, "recencyAt", anchor.value);
        out.insert("recencyLabel".into(), Value::String(anchor.label));
    }
    Value::Object(out)
}

struct RecencyAnchor {
    label: String,
    value: Option<String>,
}

fn session_recency_anchor(
    label: &str,
    latest_unread_at: Option<&str>,
    last_output_at: Option<&str>,
    became_idle_at: Option<&str>,
    last_used_at: Option<&str>,
) -> Option<RecencyAnchor> {
    let output = || {
        last_output_at.map(|value| RecencyAnchor {
            label: "output".into(),
            value: Some(value.to_owned()),
        })
    };
    match label {
        "needs_input" | "needs_response" => Some(RecencyAnchor {
            label: "prompted".into(),
            value: first_timestamp(&[
                latest_unread_at,
                last_output_at,
                became_idle_at,
                last_used_at,
            ]),
        }),
        "next_step" | "idle" | "interrupted" => output().or_else(|| {
            Some(RecencyAnchor {
                label: "idle".into(),
                value: first_timestamp(&[became_idle_at, last_used_at]),
            })
        }),
        "working" | "ready" => output(),
        "done" => output().or_else(|| {
            Some(RecencyAnchor {
                label: "done".into(),
                value: first_timestamp(&[became_idle_at, last_used_at]),
            })
        }),
        "offline" => output().or_else(|| {
            Some(RecencyAnchor {
                label: "offline".into(),
                value: last_used_at.map(str::to_owned),
            })
        }),
        "blocked" => Some(RecencyAnchor {
            label: "blocked".into(),
            value: first_timestamp(&[
                latest_unread_at,
                became_idle_at,
                last_output_at,
                last_used_at,
            ]),
        }),
        "error" => Some(RecencyAnchor {
            label: "failed".into(),
            value: first_timestamp(&[
                latest_unread_at,
                became_idle_at,
                last_output_at,
                last_used_at,
            ]),
        }),
        _ => output(),
    }
}

fn first_timestamp(values: &[Option<&str>]) -> Option<String> {
    values
        .iter()
        .find_map(|value| value.filter(|text| !text.is_empty()).map(str::to_owned))
}

fn latest_unread_notification_at(input: &Value, session_id: &str) -> Option<String> {
    array_field(input, "notifications")
        .into_iter()
        .filter(|notification| {
            string_field(notification, "sessionId").as_deref() == Some(session_id)
                && notification.get("unread").and_then(Value::as_bool) != Some(false)
                && notification.get("cleared").and_then(Value::as_bool) != Some(true)
        })
        .filter_map(|notification| string_field(notification, "createdAt"))
        .max()
}

fn wants_unread_recency(label: &str) -> bool {
    matches!(
        label,
        "needs_input" | "needs_response" | "blocked" | "error"
    )
}

fn is_agent_output_event_kind(kind: &str) -> bool {
    matches!(
        kind,
        "stdout" | "stderr" | "output" | "message" | "tool_use" | "tool_result"
    )
}

fn is_project_control_session(
    team: Option<&Value>,
    overseer: Option<bool>,
    scribe: Option<bool>,
) -> bool {
    if overseer == Some(true) {
        return true;
    }
    if scribe == Some(false) {
        return false;
    }
    if scribe == Some(true) {
        return true;
    }
    string_field(team.unwrap_or(&Value::Null), "role")
        .as_deref()
        .is_some_and(|role| matches!(role, "overseer" | "scribe"))
}

fn session_label(host: &Value, session_id: &str) -> Option<String> {
    map_string(host, "sessionLabels", session_id).or_else(|| {
        array_field(host, "offlineSessions")
            .into_iter()
            .find(|session| string_field(session, "id").as_deref() == Some(session_id))
            .and_then(|session| string_field(session, "label"))
    })
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn array_field<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_path(value: &Value, path: &[&str]) -> Option<String> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn integer_field(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn map_value(host: &Value, map_name: &str, key: &str) -> Option<Value> {
    host.get(map_name).and_then(|map| map.get(key)).cloned()
}

fn map_string(host: &Value, map_name: &str, key: &str) -> Option<String> {
    map_value(host, map_name, key).and_then(|value| value.as_str().map(str::to_owned))
}

fn insert_optional_string(out: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        out.insert(key.into(), Value::String(value));
    }
}

fn insert_optional_value(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.into(), value);
    }
}
