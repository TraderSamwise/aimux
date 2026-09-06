use serde_json::{Map, Value, json};
use std::path::Path;

use crate::daemon_state::{MetadataState, load_metadata_state, save_metadata_state};
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::notification_context::is_session_notification_focused;
use super::notification_display_context::{project_display_name, resolve_session_display_context};
use super::notifications::{NotificationWriteInput, add_notification};
use super::router::ProjectServiceRequestContext;
use super::runtime_events::{
    route_runtime_event_with_context, route_runtime_set_attention_with_context,
};
use super::runtime_exchange::{
    compact_runtime_exchange_file, inspect_runtime_exchange_store, runtime_exchange_path,
};

const MAX_SEGMENT_DATA_BYTES: usize = 4096;
const MAX_SEGMENT_TTL_SECONDS: f64 = 86_400.0;

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
    if pathname == routes::STATUSLINE_SEGMENT {
        return Some(route_statusline_segment_request(
            context.project_state_dir(),
            method,
            body.unwrap_or(&Value::Null),
        ));
    }

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
            metadata_update_response(update_session_metadata(
                &project_state_dir,
                &session,
                |current| {
                    object_insert(
                        current,
                        "status",
                        object_from_entries([
                            ("text", Value::String(text)),
                            ("tone", optional_value(tone)),
                        ]),
                    )
                },
            ))
        }
        routes::runtime::SET_PROGRESS => {
            let session = string_field(body, "session");
            let current_value = body.get("current").cloned().unwrap_or(Value::Null);
            let total = body.get("total").cloned().unwrap_or(Value::Null);
            let label = body.get("label").cloned();
            metadata_update_response(update_session_metadata(
                &project_state_dir,
                &session,
                |current| {
                    object_insert(
                        current,
                        "progress",
                        object_from_entries([
                            ("current", current_value),
                            ("total", total),
                            ("label", optional_value(label)),
                        ]),
                    )
                },
            ))
        }
        routes::runtime::SET_CONTEXT => {
            let session = string_field(body, "session");
            let input = body
                .get("context")
                .cloned()
                .unwrap_or(Value::Object(Map::new()));
            metadata_update_response(update_session_metadata(
                &project_state_dir,
                &session,
                |current| merge_session_context(current, input),
            ))
        }
        routes::runtime::SET_SERVICES => {
            let session = string_field(body, "session");
            let services = body.get("services").cloned().unwrap_or(Value::Null);
            metadata_update_response(update_session_metadata(
                &project_state_dir,
                &session,
                |current| set_derived_services(current, services),
            ))
        }
        routes::runtime::LOG => {
            let session = string_field(body, "session");
            let entry = object_from_entries([
                ("message", Value::String(string_field(body, "message"))),
                ("source", optional_value(body.get("source").cloned())),
                ("tone", optional_value(body.get("tone").cloned())),
                ("ts", Value::String(now_iso())),
            ]);
            metadata_update_response(update_session_metadata(
                &project_state_dir,
                &session,
                |current| append_log(current, entry),
            ))
        }
        routes::runtime::CLEAR_LOG => {
            let session = string_field(body, "session");
            metadata_update_response(update_session_metadata(
                &project_state_dir,
                &session,
                |mut current| {
                    if let Value::Object(map) = &mut current {
                        map.remove("logs");
                    }
                    current
                },
            ))
        }
        routes::runtime::SET_ACTIVITY => {
            let session = string_field(body, "session");
            let activity = string_field(body, "activity");
            metadata_update_response(update_session_metadata(
                &project_state_dir,
                &session,
                |current| set_derived_activity(current, activity),
            ))
        }
        routes::runtime::SET_ATTENTION => {
            let session = string_field(body, "session");
            let attention = string_field(body, "attention");
            route_runtime_set_attention_with_context(
                context,
                &project_state_dir,
                &session,
                attention,
            )
        }
        routes::runtime::MARK_SEEN => {
            let session = string_field(body, "session");
            metadata_update_response(update_session_metadata(
                &project_state_dir,
                &session,
                mark_seen,
            ))
        }
        routes::runtime::EVENT => {
            let session = string_field(body, "session");
            let event = body
                .get("event")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            route_runtime_event_with_context(context, &project_state_dir, &session, event)
        }
        routes::runtime::NOTIFY => Some(route_runtime_notify(context, &project_state_dir, body)),
        routes::runtime::COMPACT_EXCHANGE => {
            let path = runtime_exchange_path(&project_state_dir);
            let result = compact_runtime_exchange_file(&path);
            Some(match result {
                Ok(result) => json_response(
                    200,
                    json!({
                        "ok": true,
                        "result": result,
                        "runtimeExchange": inspect_runtime_exchange_store(path),
                    }),
                ),
                Err(error) => json_response(500, json!({ "ok": false, "error": error })),
            })
        }
        _ => None,
    }
}

fn route_runtime_notify(
    context: &ProjectServiceRequestContext,
    project_state_dir: impl AsRef<Path>,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let project_state_dir = project_state_dir.as_ref();
    let kind = normalize_notify_kind(event_string(body, "kind").as_deref());
    let session_id = trimmed_event_string(body, "sessionId");
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let message = notify_message(body);
    let force = body.get("force") == Some(&Value::Bool(true));
    let body_worktree_path = trimmed_event_string(body, "worktreePath");
    let display_context = session_id
        .as_deref()
        .map(|session_id| {
            resolve_session_display_context(context, session_id, body_worktree_path.as_deref())
        })
        .unwrap_or_default();
    let focused = session_id
        .as_deref()
        .is_some_and(|session_id| is_session_notification_focused(project_state_dir, session_id));
    let notification = NotificationWriteInput {
        kind: Some(kind.clone()),
        session_id: session_id.clone(),
        title: title.clone(),
        body: message,
        project_name: Some(project_display_name(context.project_root())),
        project_root: Some(context.project_root().to_string_lossy().into_owned()),
        worktree_path: body_worktree_path.or(display_context.worktree_path),
        worktree_name: trimmed_event_string(body, "worktreeName").or(display_context.worktree_name),
        branch: trimmed_event_string(body, "branch").or(display_context.branch),
        category_label: Some(notify_category_label(&kind).to_owned()),
        reason_label: Some(notify_reason_label(&kind).to_owned()),
        dedupe_key: notify_dedupe_key(&kind, session_id.as_deref(), &title, body),
        unread: force || !focused,
        force_notify: force,
        ..NotificationWriteInput::default()
    };
    let alert = notification.clone();
    match add_notification(project_state_dir, notification) {
        Ok(record) => {
            context.project_events.publish_alert_from_notification(
                context.project_root(),
                &alert,
                &record,
            );
            ok()
        }
        Err(error) => json_response(500, json!({ "ok": false, "error": error })),
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

fn metadata_update_response(
    result: Result<MetadataUpdateResult, String>,
) -> Option<ProjectServiceDispatchResponse> {
    Some(match result {
        Ok(_) => ok(),
        Err(error) => json_response(500, json!({ "ok": false, "error": error })),
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

fn set_derived_activity(current: Value, activity: String) -> Value {
    let mut derived = current
        .get("derived")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let previous_activity = derived
        .get("activity")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if activity == "running" {
        derived.remove("becameIdleAt");
    } else if previous_activity.as_deref() == Some("running") {
        derived.insert("becameIdleAt".to_owned(), Value::String(now_iso()));
    }
    derived.insert("activity".to_owned(), Value::String(activity));
    object_insert(current, "derived", Value::Object(derived))
}

fn mark_seen(current: Value) -> Value {
    let mut derived = current
        .get("derived")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    derived.insert("unseenCount".to_owned(), Value::Number(0.into()));
    object_insert(current, "derived", Value::Object(derived))
}

fn normalize_notify_kind(kind: Option<&str>) -> String {
    match kind.map(str::trim).unwrap_or_default() {
        "notification" | "generic" => "notification",
        "task_done" | "complete" => "task_done",
        "next_step" => "next_step",
        "task_failed" | "error" => "task_failed",
        "blocked" => "blocked",
        "message_waiting" => "message_waiting",
        "handoff_waiting" => "handoff_waiting",
        "task_assigned" => "task_assigned",
        "review_waiting" => "review_waiting",
        _ => "needs_input",
    }
    .to_owned()
}

fn notify_category_label(kind: &str) -> &'static str {
    match kind {
        "task_done" => "Done",
        "next_step" => "Next Step",
        "task_failed" => "Error",
        "blocked" => "Blocked",
        "message_waiting" => "Message",
        "handoff_waiting" => "Handoff",
        "task_assigned" => "Task",
        "review_waiting" => "Review",
        "notification" => "Notification",
        _ => "Needs Input",
    }
}

fn notify_reason_label(kind: &str) -> &'static str {
    match kind {
        "task_done" => "Task complete",
        "next_step" => "Next step",
        "task_failed" => "Task failed",
        "blocked" => "Agent blocked",
        "message_waiting" => "Message waiting",
        "handoff_waiting" => "Handoff waiting",
        "task_assigned" => "Task assigned",
        "review_waiting" => "Review waiting",
        "notification" => "Notification",
        _ => "Agent needs input",
    }
}

fn notify_message(body: &Value) -> String {
    let main = trimmed_event_string(body, "message")
        .or_else(|| trimmed_event_string(body, "title"))
        .unwrap_or_else(|| "aimux".to_owned());
    [trimmed_event_string(body, "subtitle"), Some(main)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" — ")
}

fn notify_dedupe_key(
    kind: &str,
    session_id: Option<&str>,
    title: &str,
    body: &Value,
) -> Option<String> {
    if body.get("force") == Some(&Value::Bool(true)) {
        return None;
    }
    match (kind, session_id) {
        ("needs_input", Some(session_id)) => Some(format!("needs_input:{session_id}")),
        ("next_step", Some(session_id)) => Some(format!("idle-needs-input:{session_id}")),
        ("blocked", Some(session_id)) => Some(format!("blocked:{session_id}")),
        ("task_failed", Some(session_id)) => Some(format!("error:{session_id}")),
        ("task_done", _) => {
            let subject = body
                .get("title")
                .and_then(Value::as_str)
                .or_else(|| body.get("message").and_then(Value::as_str))
                .unwrap_or(if title.is_empty() { "aimux" } else { title });
            Some(format!("notify:complete:{subject}"))
        }
        _ => None,
    }
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

fn route_statusline_segment_request(
    project_state_dir: impl AsRef<Path>,
    method: &str,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let session = string_field(body, "session");
    if session.is_empty() {
        return json_response(400, json!({ "ok": false, "error": "session is required" }));
    }
    let line = body.get("line").and_then(Value::as_str);
    if let Some(line) = line
        && line != "top"
        && line != "bottom"
    {
        return json_response(
            400,
            json!({ "ok": false, "error": "line must be top or bottom" }),
        );
    }

    if method.eq_ignore_ascii_case("DELETE") {
        let id = string_field(body, "id");
        if id.is_empty() {
            return json_response(400, json!({ "ok": false, "error": "id is required" }));
        }
        return match drop_statusline_segment(project_state_dir, &session, &id, line) {
            Ok(_) => ok(),
            Err(error) => json_response(500, json!({ "ok": false, "error": error })),
        };
    }

    if !method.eq_ignore_ascii_case("POST") {
        return json_response(405, json!({ "ok": false, "error": "use POST or DELETE" }));
    }

    let line = line.unwrap_or("bottom");
    let ttl = body.get("ttlSeconds").and_then(Value::as_f64);
    if body.get("ttlSeconds").is_some()
        && ttl.is_none_or(|ttl| !(ttl.is_finite() && ttl > 0.0 && ttl <= MAX_SEGMENT_TTL_SECONDS))
    {
        return json_response(
            400,
            json!({ "ok": false, "error": "ttlSeconds must be between 1 and 86400" }),
        );
    }

    let mut segment = Map::new();
    if let Some(id) = body.get("id").cloned() {
        segment.insert("id".to_owned(), id);
    }
    segment.insert(
        "text".to_owned(),
        Value::String(string_field_with_default(body, "text", "")),
    );
    if let Some(tone) = body.get("tone").cloned() {
        segment.insert("tone".to_owned(), tone);
    }
    if let Some(ttl) = ttl {
        segment.insert(
            "expiresAt".to_owned(),
            Value::String(now_iso_after_seconds(ttl)),
        );
    }
    if let Some(data) = body.get("data").cloned() {
        segment.insert("data".to_owned(), data);
    }
    let segment = Value::Object(segment);
    if let Some(rejection) = segment_rejection(&segment) {
        return json_response(400, json!({ "ok": false, "error": rejection }));
    }
    match put_statusline_segment(project_state_dir, &session, line, segment) {
        Ok(_) => ok(),
        Err(error) => json_response(500, json!({ "ok": false, "error": error })),
    }
}

fn put_statusline_segment(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    line: &str,
    segment: Value,
) -> Result<MetadataUpdateResult, String> {
    let id = segment
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    update_session_metadata(project_state_dir, session_id, |current| {
        let mut statusline = current
            .get("statusline")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut segments = statusline
            .get(line)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        segments.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id.as_str()));
        segments.push(segment);
        statusline.insert(line.to_owned(), Value::Array(segments));
        object_insert(current, "statusline", Value::Object(statusline))
    })
}

fn drop_statusline_segment(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    id: &str,
    line: Option<&str>,
) -> Result<MetadataUpdateResult, String> {
    update_session_metadata(project_state_dir, session_id, |mut current| {
        let Value::Object(session) = &mut current else {
            return current;
        };
        let Some(Value::Object(statusline)) = session.get_mut("statusline") else {
            return current;
        };
        let lines = line.map_or_else(|| vec!["top", "bottom"], |line| vec![line]);
        for current_line in lines {
            let Some(Value::Array(segments)) = statusline.get_mut(current_line) else {
                continue;
            };
            segments.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
            if segments.is_empty() {
                statusline.remove(current_line);
            }
        }
        let top_empty = statusline
            .get("top")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty);
        let bottom_empty = statusline
            .get("bottom")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty);
        if top_empty && bottom_empty {
            session.remove("statusline");
        }
        current
    })
}

fn segment_rejection(segment: &Value) -> Option<String> {
    if segment
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Some("a segment needs an id to be replaceable".into());
    }
    if !segment.get("text").is_some_and(Value::is_string) {
        return Some("a segment needs text".into());
    }
    if let Some(expires_at) = segment.get("expiresAt").and_then(Value::as_str)
        && parse_iso_millis(expires_at).is_none()
    {
        return Some("expiresAt is not a date".into());
    }
    if let Some(data) = segment.get("data") {
        let size = serde_json::to_string(data)
            .map(|value| value.len())
            .unwrap_or_default();
        if size > MAX_SEGMENT_DATA_BYTES {
            return Some(format!(
                "data is {size} bytes; the limit is {MAX_SEGMENT_DATA_BYTES}"
            ));
        }
    }
    None
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
    string_field_with_default(value, field, "")
}

fn event_string(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn trimmed_event_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_field_with_default(value: &Value, field: &str, default_value: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or(default_value)
        .to_owned()
}

fn ok() -> ProjectServiceDispatchResponse {
    json_response(200, json!({ "ok": true }))
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}

fn now_iso() -> String {
    format_offset_date_time(time::OffsetDateTime::now_utc())
}

fn now_iso_after_seconds(seconds: f64) -> String {
    let millis = (seconds * 1000.0).round() as i64;
    format_offset_date_time(time::OffsetDateTime::now_utc() + time::Duration::milliseconds(millis))
}

fn format_offset_date_time(now: time::OffsetDateTime) -> String {
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

fn parse_iso_millis(value: &str) -> Option<u128> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = time.strip_suffix('Z')?;
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 || millis.len() > 3 {
        return None;
    }
    let mut millis = millis.parse::<u128>().ok()?;
    for _ in 0..(3 - value
        .split_once('.')
        .map_or(0, |(_, rest)| rest.trim_end_matches('Z').len()))
    {
        millis *= 10;
    }
    let days = days_from_civil(year, month, day)?;
    Some(
        (((days as u128 * 24 + hour as u128) * 60 + minute as u128) * 60 + second as u128) * 1000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    (days >= 0).then_some(days)
}
