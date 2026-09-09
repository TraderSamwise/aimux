use serde_json::{Map, Value, json};
use std::collections::HashSet;

const FIXED_NOW_MS: i64 = 1_779_494_410_000;

pub fn run_notification_policy_contract_case(input: &Value) -> Value {
    let api = str_field(input, "api").unwrap_or_default();
    match api.as_str() {
        "snapshotSessionForNotifications" => {
            snapshot_session(input.get("session").unwrap_or(&Value::Null))
        }
        "evaluateAgentNotification" => evaluate_agent_notification(input),
        "evaluateNotificationRecord" => evaluate_notification_record(
            input.get("record").unwrap_or(&Value::Null),
            input.get("settings").unwrap_or(&Value::Null),
            input.get("context").unwrap_or(&Value::Null),
            FIXED_NOW_MS,
        )
        .unwrap_or(Value::Null),
        "evaluateNotificationRecordBatch" => evaluate_notification_record_batch(input),
        "evaluateAlertEvent" => evaluate_alert_event(input),
        "isRecentNotificationRecord" => json!(is_recent_notification_record(
            input.get("record").unwrap_or(&Value::Null),
            input
                .get("nowMs")
                .and_then(Value::as_i64)
                .unwrap_or(FIXED_NOW_MS)
        )),
        _ => panic!("unknown notification policy contract api: {api}"),
    }
}

fn snapshot_session(session: &Value) -> Value {
    json!({
        "id": str_field(session, "id").unwrap_or_default(),
        "status": str_field(session, "status").unwrap_or_default(),
        "attention": normalize_state(str_field(session, "attention").as_deref()),
        "activity": normalize_state(str_field(session, "activity").as_deref()),
        "label": agent_compact_identity(session),
        "headline": str_field(session, "headline")
            .or_else(|| str_field(session, "previewLine"))
            .unwrap_or_default(),
        "unseenCount": session.get("unseenCount").and_then(Value::as_i64).unwrap_or(0),
    })
}

fn evaluate_agent_notification(input: &Value) -> Value {
    let session = input.get("session").unwrap_or(&Value::Null);
    let Some(previous) = input.get("previous").filter(|previous| !previous.is_null()) else {
        return Value::Null;
    };
    let current = snapshot_session(session);
    let settings = input.get("settings").unwrap_or(&Value::Null);
    let context = input.get("context").unwrap_or(&Value::Null);

    if let Some(event) = evaluate_attention_transition(&current, previous, settings, context) {
        return event;
    }

    if is_agent_notification_enabled(settings, "completed")
        && str_field(&current, "activity").as_deref() == Some("done")
        && str_field(previous, "activity").as_deref() != Some("done")
    {
        return build_agent_event(
            "completed",
            &current,
            context,
            "completed",
            "Agent completed",
        );
    }

    if is_agent_notification_enabled(settings, "activity")
        && int_field(&current, "unseenCount") > int_field(previous, "unseenCount")
        && !matches!(
            str_field(&current, "attention").as_deref(),
            Some("needs_input" | "blocked" | "error")
        )
    {
        let transition = format!("activity:{}", int_field(&current, "unseenCount"));
        return build_agent_event(
            "activity",
            &current,
            context,
            &transition,
            "New agent activity",
        );
    }

    Value::Null
}

fn evaluate_attention_transition(
    current: &Value,
    previous: &Value,
    settings: &Value,
    context: &Value,
) -> Option<Value> {
    let current_attention = str_field(current, "attention").unwrap_or_default();
    if Some(current_attention.as_str()) == str_field(previous, "attention").as_deref() {
        return None;
    }
    match current_attention.as_str() {
        "needs_input" if is_agent_notification_enabled(settings, "needs_input") => {
            Some(build_agent_event(
                "needs_input",
                current,
                context,
                "attention:needs_input",
                "Agent needs input",
            ))
        }
        "blocked" if is_agent_notification_enabled(settings, "blocked") => Some(build_agent_event(
            "blocked",
            current,
            context,
            "attention:blocked",
            "Agent is blocked",
        )),
        "error" if is_agent_notification_enabled(settings, "error") => Some(build_agent_event(
            "error",
            current,
            context,
            "attention:error",
            "Agent hit an error",
        )),
        _ => None,
    }
}

fn build_agent_event(
    kind: &str,
    snapshot: &Value,
    context: &Value,
    transition_key: &str,
    title: &str,
) -> Value {
    let session_id = str_field(snapshot, "id").unwrap_or_default();
    let project_prefix = str_field(context, "projectName")
        .map(|name| format!("{name}: "))
        .unwrap_or_default();
    event_object(
        &format!("{session_id}:{transition_key}"),
        &format!("agent:{session_id}:{transition_key}"),
        kind,
        &format!("{project_prefix}{title}"),
        &truthy_field(snapshot, "headline")
            .or_else(|| str_field(snapshot, "label"))
            .unwrap_or_default(),
        str_field(context, "projectPath"),
        Some(session_id),
    )
}

fn evaluate_notification_record(
    record: &Value,
    settings: &Value,
    context: &Value,
    now_ms: i64,
) -> Option<Value> {
    if !record
        .get("unread")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || record
            .get("cleared")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return None;
    }
    if !is_recent_notification_record(record, now_ms) {
        return None;
    }
    let kind = map_notification_record_kind(str_field(record, "kind").as_deref())?;
    if !is_agent_notification_enabled(settings, &kind) {
        return None;
    }
    let id = str_field(record, "id").unwrap_or_default();
    let title = title_with_project(
        &truthy_field(record, "title").unwrap_or_else(|| "aimux".to_owned()),
        context,
        str_field(record, "projectName").as_deref(),
    );
    Some(event_object(
        &id,
        &truthy_field(record, "dedupeKey").unwrap_or_else(|| format!("notification:{id}")),
        &kind,
        &title,
        &truthy_field(record, "body")
            .or_else(|| truthy_field(record, "subtitle"))
            .or_else(|| str_field(record, "title"))
            .unwrap_or_default(),
        str_field(context, "projectPath"),
        str_field(record, "sessionId"),
    ))
}

fn evaluate_notification_record_batch(input: &Value) -> Value {
    let records = input
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let observed: HashSet<String> = input
        .get("observedIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect();
    let max_events = input
        .get("maxEvents")
        .and_then(Value::as_i64)
        .map(|value| value.max(0) as usize)
        .unwrap_or(usize::MAX);
    let settings = input.get("settings").unwrap_or(&Value::Null);
    let context = input.get("context").unwrap_or(&Value::Null);

    let mut events = Vec::new();
    let mut observed_ids = Vec::new();
    for record in records {
        let id = str_field(&record, "id").unwrap_or_default();
        if observed.contains(&id) {
            continue;
        }
        observed_ids.push(id);
        if events.len() >= max_events {
            continue;
        }
        if let Some(event) = evaluate_notification_record(&record, settings, context, FIXED_NOW_MS)
        {
            events.push(event);
        }
    }
    json!({ "events": events, "observedIds": observed_ids })
}

fn evaluate_alert_event(input: &Value) -> Value {
    let event = input.get("event").unwrap_or(&Value::Null);
    if event
        .get("interaction")
        .and_then(|interaction| interaction.get("telemetry"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Value::Null;
    }
    let settings = input.get("settings").unwrap_or(&Value::Null);
    let context = input.get("context").unwrap_or(&Value::Null);
    let Some(kind) = map_notification_record_kind(str_field(event, "kind").as_deref()) else {
        return Value::Null;
    };
    if !is_agent_notification_enabled(settings, &kind) {
        return Value::Null;
    }
    let notification_id = truthy_field(event, "notificationId");
    let id = notification_id.clone().unwrap_or_else(|| {
        format!(
            "alert:{}:{}:{}:{}",
            str_field(event, "projectId").unwrap_or_default(),
            str_field(event, "kind").unwrap_or_default(),
            str_field(event, "sessionId").unwrap_or_else(|| "project".to_owned()),
            str_field(event, "ts").unwrap_or_default()
        )
    });
    let dedupe_key = truthy_field(event, "dedupeKey").unwrap_or_else(|| {
        notification_id
            .map(|id| format!("notification:{id}"))
            .unwrap_or_else(|| id.clone())
    });
    let title = title_with_project(
        &truthy_field(event, "title").unwrap_or_else(|| "aimux".to_owned()),
        context,
        str_field(event, "projectName").as_deref(),
    );
    event_object(
        &id,
        &dedupe_key,
        &kind,
        &title,
        &truthy_field(event, "message")
            .or_else(|| truthy_field(event, "sessionId"))
            .or_else(|| str_field(event, "kind"))
            .unwrap_or_default(),
        str_field(context, "projectPath"),
        str_field(event, "sessionId"),
    )
}

fn event_object(
    id: &str,
    dedupe_key: &str,
    kind: &str,
    title: &str,
    body: &str,
    project_path: Option<String>,
    session_id: Option<String>,
) -> Value {
    let mut target = Map::new();
    if let Some(project_path) = project_path {
        target.insert("projectPath".to_owned(), Value::String(project_path));
    }
    if let Some(session_id) = session_id {
        target.insert("sessionId".to_owned(), Value::String(session_id));
    }
    json!({
        "id": id,
        "dedupeKey": dedupe_key,
        "category": "agent",
        "kind": kind,
        "title": title,
        "body": body,
        "target": target,
    })
}

fn is_recent_notification_record(record: &Value, now_ms: i64) -> bool {
    let Some(created_at_ms) =
        str_field(record, "createdAt").and_then(|created_at| parse_iso_ms(&created_at))
    else {
        return false;
    };
    now_ms - created_at_ms <= 30_000
}

fn map_notification_record_kind(kind: Option<&str>) -> Option<String> {
    match kind.map(str::trim) {
        Some(
            "needs_input"
            | "next_step"
            | "interaction_request"
            | "message_waiting"
            | "handoff_waiting"
            | "task_assigned"
            | "review_waiting",
        ) => Some("needs_input".to_owned()),
        Some("blocked") => Some("blocked".to_owned()),
        Some("error" | "task_failed") => Some("error".to_owned()),
        Some("completed" | "task_done") => Some("completed".to_owned()),
        Some("activity" | "notification" | "notify") => Some("activity".to_owned()),
        _ => None,
    }
}

fn is_agent_notification_enabled(settings: &Value, kind: &str) -> bool {
    if !settings
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || !settings
            .pointer("/categories/agent/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return false;
    }
    let key = match kind {
        "needs_input" => "needsInput",
        "blocked" => "blocked",
        "error" => "errors",
        "completed" => "completed",
        "activity" => "activity",
        _ => return false,
    };
    settings
        .pointer(&format!("/categories/agent/{key}"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn title_with_project(title: &str, context: &Value, server_project_name: Option<&str>) -> String {
    let trimmed = title.trim();
    let title = if trimmed.is_empty() { "aimux" } else { trimmed };
    let project_name = server_project_name
        .and_then(|value| non_empty_trimmed(Some(value)))
        .or_else(|| str_field(context, "projectName"));
    let Some(project_name) = project_name else {
        return title.to_owned();
    };
    if server_project_name
        .and_then(|value| non_empty_trimmed(Some(value)))
        .is_some()
    {
        return title.to_owned();
    }
    if title.starts_with(&format!("{project_name}: "))
        || title.contains(&format!("{project_name} /"))
    {
        return title.to_owned();
    }
    format!("{project_name}: {title}")
}

fn normalize_state(value: Option<&str>) -> String {
    non_empty_trimmed(value).unwrap_or_else(|| "none".to_owned())
}

fn str_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .map(ToOwned::to_owned)
}

fn truthy_field(value: &Value, field: &str) -> Option<String> {
    str_field(value, field).filter(|value| !value.is_empty())
}

fn int_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}

fn non_empty_trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn agent_compact_identity(agent: &Value) -> String {
    let name = agent_short_name(agent);
    let role = str_field(agent, "role").unwrap_or_default();
    if role.is_empty() {
        name
    } else {
        format!("{name} ({role})")
    }
}

fn agent_short_name(agent: &Value) -> String {
    if let Some(label) = truthy_field(agent, "label")
        && !is_generated_agent_label(&label, agent)
    {
        return label;
    }
    agent_tool_name(agent)
}

fn agent_tool_name(agent: &Value) -> String {
    truthy_field(agent, "toolConfigKey")
        .or_else(|| str_field(agent, "command").and_then(|command| first_token(&command)))
        .or_else(|| truthy_field(agent, "label").and_then(|label| generated_label_tool(&label)))
        .or_else(|| truthy_field(agent, "id").and_then(|id| generated_label_tool(&id)))
        .unwrap_or_else(|| "agent".to_owned())
}

fn is_generated_agent_label(label: &str, agent: &Value) -> bool {
    if label.trim().is_empty() {
        return false;
    }
    if truthy_field(agent, "id").is_some_and(|id| label == id) {
        return true;
    }
    if generated_label_tool(label).is_none() {
        return false;
    }
    let tool = agent_tool_name(agent).to_ascii_lowercase();
    label.to_ascii_lowercase().starts_with(&format!("{tool}-"))
}

fn first_token(command: &str) -> Option<String> {
    command
        .split_whitespace()
        .next()
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
}

fn generated_label_tool(value: &str) -> Option<String> {
    let (tool, suffix) = value.split_once('-')?;
    if !matches!(
        tool.to_ascii_lowercase().as_str(),
        "claude" | "codex" | "aider" | "shell"
    ) {
        return None;
    }
    if suffix.len() < 5
        || !suffix.chars().any(|ch| ch.is_ascii_digit())
        || !suffix.chars().all(|ch| ch.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(tool.to_ascii_lowercase())
}

fn parse_iso_ms(value: &str) -> Option<i64> {
    if value.len() != 24 || !value.ends_with('Z') {
        return None;
    }
    let year: i32 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    let millisecond: i64 = value.get(20..23)?.parse().ok()?;
    Some(
        days_from_civil(year, month, day)? * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1_000
            + millisecond,
    )
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - (month <= 2) as i32;
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) as i64)
}
