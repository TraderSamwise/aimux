use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;

use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::parse_bounded_limit;
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{
    read_runtime_exchange, runtime_exchange_path, update_runtime_exchange,
};

const NOTIFICATION_TAG: &str = "notification";
const DEFAULT_PROJECT_LIST_LIMIT: i64 = 200;
const MAX_PROJECT_LIST_LIMIT: i64 = 500;

pub fn route_notifications_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if method.eq_ignore_ascii_case("GET") && pathname == routes::notifications::LIST {
        return Some(route_list(context, path));
    }
    if method.eq_ignore_ascii_case("POST") && pathname == routes::notifications::READ {
        return Some(route_mark_read(context, body.unwrap_or(&Value::Null)));
    }
    if method.eq_ignore_ascii_case("POST") && pathname == routes::notifications::CLEAR {
        return Some(route_clear(context, body.unwrap_or(&Value::Null)));
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NotificationQuery {
    pub unread_only: bool,
    pub include_cleared: bool,
    pub session_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NotificationMutation {
    pub id: Option<String>,
    pub ids: Option<Vec<String>>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationSnapshot {
    pub notifications: Vec<Value>,
    pub total: usize,
    pub unread_count: usize,
    pub limit: Option<usize>,
    pub truncated: bool,
}

pub fn list_notification_snapshot(
    project_state_dir: impl AsRef<Path>,
    query: NotificationQuery,
) -> NotificationSnapshot {
    let exchange = read_runtime_exchange(runtime_exchange_path(project_state_dir));
    let all_records = notification_records(&exchange);
    let unread_count = all_records
        .iter()
        .filter(|record| {
            if !query.include_cleared && bool_field(record, "cleared") {
                return false;
            }
            if let Some(session_id) = query.session_id.as_deref()
                && string_field(record, "sessionId") != Some(session_id)
            {
                return false;
            }
            bool_field(record, "unread")
        })
        .count();
    let records = all_records
        .into_iter()
        .filter(|record| {
            if !query.include_cleared && bool_field(record, "cleared") {
                return false;
            }
            if query.unread_only && !bool_field(record, "unread") {
                return false;
            }
            if let Some(session_id) = query.session_id.as_deref()
                && string_field(record, "sessionId") != Some(session_id)
            {
                return false;
            }
            true
        })
        .collect::<Vec<_>>();
    let limit = query.limit;
    let bounded = limit
        .map(|limit| records.iter().take(limit).cloned().collect())
        .unwrap_or_else(|| records.clone());
    NotificationSnapshot {
        total: records.len(),
        truncated: bounded.len() < records.len(),
        unread_count,
        notifications: bounded,
        limit,
    }
}

pub fn mark_notifications_read(
    project_state_dir: impl AsRef<Path>,
    mutation: NotificationMutation,
) -> usize {
    mutate_notifications(project_state_dir, mutation, NotificationMutationKind::Read)
}

pub fn clear_notifications(
    project_state_dir: impl AsRef<Path>,
    mutation: NotificationMutation,
) -> usize {
    mutate_notifications(project_state_dir, mutation, NotificationMutationKind::Clear)
}

fn route_list(
    context: &ProjectServiceRequestContext,
    path: &str,
) -> ProjectServiceDispatchResponse {
    let query_params = query_params(path);
    let parsed_limit = parse_bounded_limit(
        query_params.get("limit").map(String::as_str),
        "limit",
        DEFAULT_PROJECT_LIST_LIMIT,
        MAX_PROJECT_LIST_LIMIT,
    );
    let limit = match parsed_limit {
        Ok(limit) => limit as usize,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let snapshot = list_notification_snapshot(
        context.project_state_dir(),
        NotificationQuery {
            unread_only: query_params.get("unread").map(String::as_str) == Some("1"),
            include_cleared: false,
            session_id: query_params
                .get("sessionId")
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            limit: Some(limit),
        },
    );
    json_response(
        200,
        json!({
            "ok": true,
            "notifications": snapshot.notifications,
            "unreadCount": snapshot.unread_count,
            "total": snapshot.total,
            "limit": snapshot.limit,
            "truncated": snapshot.truncated,
        }),
    )
}

fn route_mark_read(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let mutation = match parse_notification_mutation(body) {
        Ok(mutation) => mutation,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let updated = mark_notifications_read(context.project_state_dir(), mutation);
    json_response(200, json!({ "ok": true, "updated": updated }))
}

fn route_clear(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let mutation = match parse_notification_mutation(body) {
        Ok(mutation) => mutation,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let cleared = clear_notifications(context.project_state_dir(), mutation);
    json_response(200, json!({ "ok": true, "cleared": cleared }))
}

fn parse_notification_mutation(body: &Value) -> Result<NotificationMutation, String> {
    let ids = if body
        .as_object()
        .is_some_and(|body| body.contains_key("ids"))
    {
        let Some(raw_ids) = body.get("ids").and_then(Value::as_array) else {
            return Err("ids must be an array of strings".into());
        };
        if raw_ids.iter().any(|id| !id.is_string()) {
            return Err("ids must be an array of strings".into());
        }
        Some(
            raw_ids
                .iter()
                .filter_map(|id| {
                    id.as_str()
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                })
                .collect(),
        )
    } else {
        None
    };
    Ok(NotificationMutation {
        id: trimmed_string(body.get("id")),
        ids,
        session_id: trimmed_string(body.get("sessionId")),
    })
}

enum NotificationMutationKind {
    Read,
    Clear,
}

fn mutate_notifications(
    project_state_dir: impl AsRef<Path>,
    mutation: NotificationMutation,
    kind: NotificationMutationKind,
) -> usize {
    let path = runtime_exchange_path(project_state_dir);
    let exchange = read_runtime_exchange(&path);
    let records = notification_records(&exchange)
        .into_iter()
        .filter(|record| match kind {
            NotificationMutationKind::Read => {
                !bool_field(record, "cleared") && bool_field(record, "unread")
            }
            NotificationMutationKind::Clear => !bool_field(record, "cleared"),
        })
        .filter(|record| {
            if let Some(ids) = mutation.ids.as_ref()
                && !ids
                    .iter()
                    .any(|id| string_field(record, "id") == Some(id.as_str()))
            {
                return false;
            }
            if let Some(id) = mutation.id.as_deref()
                && string_field(record, "id") != Some(id)
            {
                return false;
            }
            if let Some(session_id) = mutation.session_id.as_deref()
                && string_field(record, "sessionId") != Some(session_id)
            {
                return false;
            }
            true
        })
        .collect::<Vec<_>>();
    if records.is_empty() {
        return 0;
    }
    let record_ids = records
        .iter()
        .filter_map(|record| string_field(record, "id").map(str::to_owned))
        .collect::<Vec<_>>();
    let updated_count = records.len();
    let _ = update_runtime_exchange(&path, |mut exchange| {
        let thread_ids = thread_ids_for_record_ids(&exchange, &record_ids);
        if let Some(inbox) = exchange.get_mut("inbox").and_then(Value::as_array_mut) {
            for entry in inbox {
                if entry.get("subjectKind").and_then(Value::as_str) == Some("thread")
                    && entry
                        .get("subjectId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| thread_ids.iter().any(|thread_id| thread_id == id))
                    && let Value::Object(entry) = entry
                {
                    entry.insert("state".into(), Value::String("done".into()));
                }
            }
        }
        if matches!(kind, NotificationMutationKind::Clear)
            && let Some(messages) = exchange.get_mut("messages").and_then(Value::as_array_mut)
        {
            for message in messages {
                if message
                    .get("threadId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| thread_ids.iter().any(|thread_id| thread_id == id))
                    && let Value::Object(message) = message
                {
                    let metadata = message
                        .entry("metadata")
                        .or_insert_with(|| Value::Object(Map::new()));
                    if let Value::Object(metadata) = metadata {
                        metadata.insert("notificationCleared".into(), Value::Bool(true));
                    }
                }
            }
        }
        exchange
    });
    updated_count
}

fn notification_records(exchange: &Value) -> Vec<Value> {
    let mut records = exchange
        .get("threads")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|thread| {
            thread
                .get("tags")
                .and_then(Value::as_array)
                .is_some_and(|tags| {
                    tags.iter()
                        .any(|tag| tag.as_str() == Some(NOTIFICATION_TAG))
                })
        })
        .filter_map(|thread| {
            let thread_id = thread.get("id").and_then(Value::as_str)?;
            let message = thread_latest_message(exchange, thread_id)?;
            Some(notification_record(exchange, thread, message))
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        string_field(right, "createdAt")
            .unwrap_or("")
            .cmp(string_field(left, "createdAt").unwrap_or(""))
    });
    records
}

fn notification_record(exchange: &Value, thread: &Value, message: &Value) -> Value {
    let entry = entry_for_thread(
        exchange,
        thread.get("id").and_then(Value::as_str).unwrap_or(""),
    );
    let mut record = Map::new();
    record.insert(
        "id".into(),
        Value::String(
            metadata_string(message, "notificationRecordId")
                .or_else(|| thread.get("id").and_then(Value::as_str))
                .unwrap_or("")
                .to_owned(),
        ),
    );
    record.insert(
        "title".into(),
        Value::String(
            thread
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ),
    );
    insert_optional(
        &mut record,
        "subtitle",
        metadata_string(message, "notificationSubtitle"),
    );
    record.insert(
        "body".into(),
        Value::String(
            message
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ),
    );
    for (field, metadata_key) in [
        ("sessionId", "notificationSessionId"),
        ("targetKey", "notificationTargetKey"),
        ("targetKind", "notificationTargetKind"),
        ("kind", "notificationKind"),
        ("projectName", "notificationProjectName"),
        ("projectRoot", "notificationProjectRoot"),
        ("worktreePath", "notificationWorktreePath"),
        ("worktreeName", "notificationWorktreeName"),
        ("branch", "notificationBranch"),
        ("categoryLabel", "notificationCategoryLabel"),
        ("reasonLabel", "notificationReasonLabel"),
    ] {
        insert_optional(&mut record, field, metadata_string(message, metadata_key));
    }
    record.insert(
        "unread".into(),
        Value::Bool(
            entry.is_some_and(|entry| entry.get("state").and_then(Value::as_str) != Some("done")),
        ),
    );
    record.insert(
        "cleared".into(),
        Value::Bool(metadata_boolean(message, "notificationCleared")),
    );
    record.insert(
        "createdAt".into(),
        Value::String(
            thread
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ),
    );
    record.insert(
        "updatedAt".into(),
        Value::String(
            thread
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ),
    );
    insert_optional(
        &mut record,
        "dedupeKey",
        metadata_string(message, "notificationDedupeKey"),
    );
    if let Some(interaction) = notification_interaction(message) {
        record.insert("interaction".into(), interaction);
    }
    Value::Object(record)
}

fn thread_latest_message<'a>(exchange: &'a Value, thread_id: &str) -> Option<&'a Value> {
    exchange
        .get("messages")
        .and_then(Value::as_array)?
        .iter()
        .filter(|message| message.get("threadId").and_then(Value::as_str) == Some(thread_id))
        .max_by(|left, right| {
            left.get("ts")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(right.get("ts").and_then(Value::as_str).unwrap_or(""))
        })
}

fn entry_for_thread<'a>(exchange: &'a Value, thread_id: &str) -> Option<&'a Value> {
    exchange
        .get("inbox")
        .and_then(Value::as_array)?
        .iter()
        .find(|entry| {
            entry.get("subjectKind").and_then(Value::as_str) == Some("thread")
                && entry.get("subjectId").and_then(Value::as_str) == Some(thread_id)
        })
}

fn thread_ids_for_record_ids(exchange: &Value, record_ids: &[String]) -> Vec<String> {
    exchange
        .get("threads")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|thread| {
            let thread_id = thread.get("id").and_then(Value::as_str)?;
            let message = thread_latest_message(exchange, thread_id)?;
            let record = notification_record(exchange, thread, message);
            let record_id = string_field(&record, "id")?;
            record_ids
                .iter()
                .any(|id| id == record_id)
                .then(|| thread_id.to_owned())
        })
        .collect()
}

fn notification_interaction(message: &Value) -> Option<Value> {
    let id = metadata_string(message, "notificationInteractionId")?;
    let interaction_type = metadata_string(message, "notificationInteractionType")?;
    let mut interaction = Map::new();
    interaction.insert("id".into(), Value::String(id.to_owned()));
    interaction.insert("type".into(), Value::String(interaction_type.to_owned()));
    insert_optional(
        &mut interaction,
        "summary",
        metadata_string(message, "notificationInteractionSummary"),
    );
    interaction.insert(
        "telemetry".into(),
        Value::Bool(metadata_boolean(
            message,
            "notificationInteractionTelemetry",
        )),
    );
    insert_optional(
        &mut interaction,
        "toolName",
        metadata_string(message, "notificationInteractionToolName"),
    );
    insert_optional(
        &mut interaction,
        "toolInputJSON",
        metadata_string(message, "notificationInteractionToolInputJSON"),
    );
    Some(Value::Object(interaction))
}

fn metadata_string<'a>(message: &'a Value, key: &str) -> Option<&'a str> {
    message
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn metadata_boolean(message: &Value, key: &str) -> bool {
    message
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(key))
        == Some(&Value::Bool(true))
}

fn insert_optional(record: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        record.insert(key.into(), Value::String(value.to_owned()));
    }
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn query_params(path: &str) -> BTreeMap<String, String> {
    let Some((_, query)) = path.split_once('?') else {
        return BTreeMap::new();
    };
    let mut params = BTreeMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode_form(key);
        if key.is_empty() {
            continue;
        }
        params.insert(key, percent_decode_form(value));
    }
    params
}

fn percent_decode_form(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'+' => {
                bytes.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < raw.len() => {
                let hex = std::str::from_utf8(&raw[index + 1..index + 3]).unwrap_or("");
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    bytes.push(value);
                    index += 3;
                } else {
                    bytes.push(raw[index]);
                    index += 1;
                }
            }
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
