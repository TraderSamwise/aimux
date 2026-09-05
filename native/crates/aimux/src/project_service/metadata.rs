use serde_json::{Map, Value, json};
use std::path::Path;

use crate::daemon_state::{MetadataState, load_metadata_state, save_metadata_state};
use crate::project_api_contract::routes;

use super::dispatcher::{
    ProjectServiceDispatchResponse, project_service_pathname,
    route_unimplemented_project_service_request,
};
use super::router::ProjectServiceRequestContext;

#[derive(Debug, Clone, PartialEq)]
pub struct MetadataUpdateResult {
    pub state: MetadataState,
    pub changed: bool,
}

pub fn route_runtime_metadata_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }

    let body = body.unwrap_or(&Value::Null);
    let project_state_dir = context.project_state_dir();
    match pathname {
        routes::runtime::SET_STATUS => {
            let session = string_field(body, "session");
            let text = string_field(body, "text");
            let tone = body.get("tone").cloned();
            let _ = update_session_metadata(&project_state_dir, &session, |current| {
                object_insert(
                    current,
                    "status",
                    object_from_entries([
                        ("text", Value::String(text)),
                        ("tone", optional_value(tone)),
                    ]),
                )
            });
            Some(ok())
        }
        routes::runtime::SET_PROGRESS => {
            let session = string_field(body, "session");
            let current_value = body.get("current").cloned().unwrap_or(Value::Null);
            let total = body.get("total").cloned().unwrap_or(Value::Null);
            let label = body.get("label").cloned();
            let _ = update_session_metadata(&project_state_dir, &session, |current| {
                object_insert(
                    current,
                    "progress",
                    object_from_entries([
                        ("current", current_value),
                        ("total", total),
                        ("label", optional_value(label)),
                    ]),
                )
            });
            Some(ok())
        }
        routes::runtime::SET_CONTEXT => {
            let session = string_field(body, "session");
            let input = body
                .get("context")
                .cloned()
                .unwrap_or(Value::Object(Map::new()));
            let _ = update_session_metadata(&project_state_dir, &session, |current| {
                merge_session_context(current, input)
            });
            Some(ok())
        }
        routes::runtime::SET_SERVICES => {
            let session = string_field(body, "session");
            let services = body.get("services").cloned().unwrap_or(Value::Null);
            let _ = update_session_metadata(&project_state_dir, &session, |current| {
                set_derived_services(current, services)
            });
            Some(ok())
        }
        routes::runtime::LOG => {
            let session = string_field(body, "session");
            let entry = object_from_entries([
                ("message", Value::String(string_field(body, "message"))),
                ("source", optional_value(body.get("source").cloned())),
                ("tone", optional_value(body.get("tone").cloned())),
                ("ts", Value::String(now_iso())),
            ]);
            let _ = update_session_metadata(&project_state_dir, &session, |current| {
                append_log(current, entry)
            });
            Some(ok())
        }
        routes::runtime::CLEAR_LOG => {
            let session = string_field(body, "session");
            let _ = update_session_metadata(&project_state_dir, &session, |mut current| {
                if let Value::Object(map) = &mut current {
                    map.remove("logs");
                }
                current
            });
            Some(ok())
        }
        routes::runtime::SET_ACTIVITY
        | routes::runtime::SET_ATTENTION
        | routes::runtime::EVENT
        | routes::runtime::MARK_SEEN
        | routes::runtime::NOTIFY
        | routes::runtime::NOTIFICATION_CONTEXT
        | routes::runtime::SHELL_STATE
        | routes::runtime::USAGE_MARK
        | routes::runtime::COMPACT_EXCHANGE
        | routes::hooks::CLAUDE
        | routes::hooks::CODEX
        | routes::STATUSLINE_REFRESH
        | routes::STATUSLINE_SEGMENT
        | routes::OPERATION_FAILURES_CLEAR => {
            Some(route_unimplemented_project_service_request(method, path))
        }
        _ => None,
    }
}

pub fn update_session_metadata(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    updater: impl FnOnce(Value) -> Value,
) -> Result<MetadataUpdateResult, String> {
    let project_state_dir = project_state_dir.as_ref();
    let mut state = load_metadata_state(project_state_dir);
    let current = state
        .sessions
        .get(session_id)
        .cloned()
        .unwrap_or_else(|| json!({ "updatedAt": now_iso() }));
    let next = updater(current.clone());
    if stable_metadata_payload(&current) == stable_metadata_payload(&next) {
        return Ok(MetadataUpdateResult {
            state,
            changed: false,
        });
    }
    let mut next = object_value(next);
    next.insert("updatedAt".to_owned(), Value::String(now_iso()));
    state
        .sessions
        .insert(session_id.to_owned(), Value::Object(next));
    save_metadata_state(project_state_dir, &state).map_err(|error| error.to_string())?;
    Ok(MetadataUpdateResult {
        state,
        changed: true,
    })
}

fn merge_session_context(mut current: Value, input: Value) -> Value {
    let existing_context = current
        .get("context")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let input_context = input.as_object().cloned().unwrap_or_default();
    let mut merged = existing_context.clone();
    for (key, value) in input_context.iter() {
        merged.insert(key.clone(), value.clone());
    }
    if existing_context.contains_key("pr") || input_context.contains_key("pr") {
        let mut pr = existing_context
            .get("pr")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(input_pr) = input_context.get("pr").and_then(Value::as_object) {
            for (key, value) in input_pr {
                pr.insert(key.clone(), value.clone());
            }
        }
        merged.insert("pr".to_owned(), Value::Object(pr));
    }
    current = object_insert(current, "context", Value::Object(merged));
    current
}

fn set_derived_services(current: Value, services: Value) -> Value {
    let mut derived = current
        .get("derived")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    derived.insert("services".to_owned(), services);
    object_insert(current, "derived", Value::Object(derived))
}

fn append_log(current: Value, entry: Value) -> Value {
    let mut logs = current
        .get("logs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let keep_from = logs.len().saturating_sub(19);
    logs = logs.split_off(keep_from);
    logs.push(entry);
    object_insert(current, "logs", Value::Array(logs))
}

fn object_insert(value: Value, key: &str, inserted: Value) -> Value {
    let mut object = object_value(value);
    object.insert(key.to_owned(), inserted);
    Value::Object(object)
}

fn object_from_entries<const N: usize>(entries: [(&str, Value); N]) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        if !value.is_null() {
            map.insert(key.to_owned(), value);
        }
    }
    Value::Object(map)
}

fn object_value(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn optional_value(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

fn stable_metadata_payload(value: &Value) -> String {
    let mut value = value.clone();
    if let Value::Object(map) = &mut value {
        map.remove("updatedAt");
    }
    serde_json::to_string(&value).unwrap_or_default()
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn ok() -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse {
        status: 200,
        body: json!({ "ok": true }),
    }
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    let millis = now.millisecond();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        millis
    )
}
