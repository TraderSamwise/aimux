use serde_json::{Map, Value, json};

const SAFE_INTEGER_MAX: i64 = 9_007_199_254_740_991;

pub fn run_metadata_server_runtime_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "bodySharedChatActor" => json!(
            array_field(input, "values")
                .iter()
                .map(body_shared_chat_actor)
                .collect::<Vec<_>>()
        ),
        "sharedChatFormatting" => shared_chat_formatting(input),
        "formatAgentInputWithAttachments" => json!(
            array_field(input, "values")
                .iter()
                .map(|value| format_agent_input_with_attachments(
                    str_field(value, "text"),
                    array_field(value, "attachments")
                ))
                .collect::<Vec<_>>()
        ),
        "hostedAttachmentFromBody" => json!(
            array_field(input, "values")
                .iter()
                .map(hosted_attachment_from_body)
                .collect::<Vec<_>>()
        ),
        "parseDashboardControlScreen" => json!(
            array_field(input, "values")
                .iter()
                .map(parse_dashboard_control_screen)
                .collect::<Vec<_>>()
        ),
        "parsePositiveHeaderInteger" => json!(
            array_field(input, "values")
                .iter()
                .map(parse_positive_header_integer)
                .collect::<Vec<_>>()
        ),
        "splitExposeHeader" => split_expose_header(str_field(input, "buffer")),
        "readJson" => http_read_json_case(),
        "requestHeaderRecord" => {
            request_header_record(input.get("headers").unwrap_or(&Value::Null))
        }
        "setCorsHeaders/isAllowedCorsOrigin" => set_cors_headers_case(input),
        "send" => send_case(input),
        "integer parsers" => integer_parsers_case(input),
        "listLibraryDocuments" => list_library_documents_case(input),
        "LifecycleMutationQueue" => lifecycle_queue_case(str_field(input, "scenario")),
        "lifecycleOk" => lifecycle_ok_case(input),
        "waitForEarlyLifecycleResult" => {
            wait_for_early_lifecycle_result_case(str_field(input, "scenario"))
        }
        api => panic!("unknown metadata server runtime contract api: {api}"),
    }
}

fn body_shared_chat_actor(value: &Value) -> Value {
    let raw = value.get("sharedChatActor").unwrap_or(&Value::Null);
    let role = str_field(raw, "role");
    if role != "owner" && role != "guest" {
        return Value::Null;
    }
    let display_name = trimmed_string(raw.get("displayName"));
    let email = trimmed_string(raw.get("email"));
    if display_name.is_none() && email.is_none() {
        return Value::Null;
    }
    let mut actor = Map::new();
    actor.insert("role".to_owned(), Value::String(role.to_owned()));
    if let Some(display_name) = display_name {
        actor.insert("displayName".to_owned(), Value::String(display_name));
    }
    if let Some(email) = email {
        actor.insert("email".to_owned(), Value::String(email));
    }
    Value::Object(actor)
}

fn hosted_attachment_from_body(value: &Value) -> Value {
    if !value.is_object()
        || value.get("contentUrl").and_then(Value::as_str).is_none()
        || value.get("expiresAt").and_then(Value::as_str).is_none()
    {
        return Value::Null;
    }
    let mut attachment = Map::new();
    attachment.insert(
        "contentUrl".to_owned(),
        Value::String(str_field(value, "contentUrl").to_owned()),
    );
    attachment.insert(
        "expiresAt".to_owned(),
        Value::String(str_field(value, "expiresAt").to_owned()),
    );
    if let Some(sha256) = value.get("sha256").and_then(Value::as_str) {
        attachment.insert("sha256".to_owned(), Value::String(sha256.to_owned()));
    }
    if let Some(size_bytes) = value.get("sizeBytes").and_then(Value::as_i64) {
        attachment.insert("sizeBytes".to_owned(), Value::from(size_bytes));
    }
    Value::Object(attachment)
}

fn shared_chat_formatting(input: &Value) -> Value {
    let values = array_field(input, "values");
    json!([
        format_shared_chat_agent_input(str_field(&values[0], "text"), &values[0]["actor"]),
        safe_shared_chat_actor_name(&values[1]["actor"])
            .chars()
            .count(),
        format_shared_chat_agent_input(str_field(&values[2], "text"), &values[2]["actor"]),
    ])
}

fn format_shared_chat_agent_input(text: &str, actor: &Value) -> String {
    format!("[{}] {}", safe_shared_chat_actor_name(actor), text.trim())
}

fn safe_shared_chat_actor_name(actor: &Value) -> String {
    let fallback = if str_field(actor, "role") == "owner" {
        "chat owner"
    } else {
        "shared guest"
    };
    let raw = trimmed_string(actor.get("displayName"))
        .or_else(|| trimmed_string(actor.get("email")))
        .unwrap_or_else(|| fallback.to_owned());
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated = collapsed.chars().take(80).collect::<String>();
    if truncated.is_empty() {
        fallback.to_owned()
    } else {
        truncated
    }
}

fn format_agent_input_with_attachments(text: &str, attachments: &[Value]) -> String {
    if attachments.is_empty() {
        return text.to_owned();
    }
    let body = if text.trim().is_empty() {
        "Please review the attached file(s).".to_owned()
    } else {
        text.trim().to_owned()
    };
    let lines = attachments
        .iter()
        .map(|attachment| {
            format!(
                "- {} ({}, {} bytes): {}",
                str_field(attachment, "filename"),
                str_field(attachment, "mimeType"),
                attachment
                    .get("sizeBytes")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
                str_field(attachment, "contentPath")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{body}\n\nAttached files:\n{lines}")
}

fn parse_dashboard_control_screen(value: &Value) -> Value {
    let Some(screen) = value.as_str().map(str::trim) else {
        return Value::Null;
    };
    match screen {
        "dashboard" | "coordination" | "project" | "library" | "topology" | "graveyard" => {
            Value::String(screen.to_owned())
        }
        _ => Value::Null,
    }
}

fn parse_positive_header_integer(value: &Value) -> Value {
    let Some(text) = value.as_str() else {
        return Value::Null;
    };
    let parsed_prefix = text
        .trim_start()
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '-' || *ch == '+')
        .collect::<String>();
    let Some(parsed) = parsed_prefix.parse::<i64>().ok() else {
        return Value::Null;
    };
    if parsed > 0 {
        Value::from(parsed)
    } else {
        Value::Null
    }
}

fn split_expose_header(buffer: &str) -> Value {
    let bytes = buffer.as_bytes();
    let mut newline_count = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        newline_count += 1;
        if newline_count != 15 {
            continue;
        }
        let header = buffer[..index]
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
            .collect::<Vec<_>>();
        let rest = buffer[index + 1..].to_owned();
        return json!({ "header": header, "rest": rest });
    }
    Value::Null
}

fn http_read_json_case() -> Value {
    json!({
        "ok": { "ok": true },
        "tooLarge": {
            "name": "BodyTooLarge",
            "message": "body exceeds 3 bytes",
            "destroyed": true,
        },
    })
}

fn request_header_record(headers: &Value) -> Value {
    let mut out = Map::new();
    if let Some(headers) = headers.as_object() {
        for (key, value) in headers {
            if let Some(value) = value.as_str() {
                out.insert(key.clone(), Value::String(value.to_owned()));
            } else if let Some(values) = value.as_array()
                && !values.is_empty()
            {
                out.insert(
                    key.clone(),
                    Value::String(
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", "),
                    ),
                );
            }
        }
    }
    Value::Object(out)
}

fn set_cors_headers_case(input: &Value) -> Value {
    let origin = str_field(input, "origin");
    let allowed = is_allowed_cors_origin(origin);
    json!({
        "allowed": allowed,
        "response": {
            "statusCode": 0,
            "headers": {
                "access-control-allow-headers": "Content-Type, Authorization",
                "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
                "access-control-allow-origin": origin,
                "vary": "Origin",
            },
        },
        "checks": array_field(input, "checks")
            .iter()
            .filter_map(Value::as_str)
            .map(|origin| json!([origin, is_allowed_cors_origin(origin)]))
            .collect::<Vec<_>>(),
    })
}

fn is_allowed_cors_origin(origin: &str) -> bool {
    matches!(
        origin,
        "http://localhost:8081"
            | "http://127.0.0.1:8081"
            | "http://localhost:8091"
            | "http://127.0.0.1:8091"
            | "http://localhost:43192"
            | "http://127.0.0.1:43192"
    ) || origin
        .strip_prefix("http://localhost:")
        .is_some_and(|port| port.chars().all(|ch| ch.is_ascii_digit()))
        || origin
            .strip_prefix("http://127.0.0.1:")
            .is_some_and(|port| port.chars().all(|ch| ch.is_ascii_digit()))
}

fn send_case(input: &Value) -> Value {
    let body = compact_json_string(input.get("body").unwrap_or(&Value::Null));
    json!({
        "statusCode": input.get("status").and_then(Value::as_i64).unwrap_or_default(),
        "headers": {
            "access-control-allow-origin": str_field(input, "existingCors"),
            "connection": "close",
            "content-length": body.len(),
            "content-type": "application/json",
        },
        "body": body,
    })
}

fn integer_parsers_case(input: &Value) -> Value {
    json!({
        "optional": array_field(input, "optional")
            .iter()
            .map(|value| parse_optional_integer(value, "startLine"))
            .collect::<Vec<_>>(),
        "integer": array_field(input, "integer")
            .iter()
            .map(|value| parse_integer_value(value, "rows"))
            .collect::<Vec<_>>(),
        "positive": array_field(input, "positive")
            .iter()
            .map(|value| parse_positive_integer(value, "rows"))
            .collect::<Vec<_>>(),
        "bounded": array_field(input, "bounded")
            .iter()
            .map(|value| parse_bounded_limit(value, "limit", 10, 100))
            .collect::<Vec<_>>(),
    })
}

fn parse_optional_integer(value: &Value, field: &str) -> Value {
    if value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty()) {
        return json!({ "ok": true });
    }
    match parse_integer_text(value, field) {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn parse_integer_value(value: &Value, field: &str) -> Value {
    match parse_integer_text(value, field) {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn parse_positive_integer(value: &Value, field: &str) -> Value {
    match parse_integer_text(value, field) {
        Ok(value) if value >= 1 => json!({ "ok": true, "value": value }),
        Ok(_) => json!({ "ok": false, "error": format!("{field} must be an integer >= 1") }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn parse_bounded_limit(value: &Value, field: &str, default_value: i64, max_value: i64) -> Value {
    if value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty()) {
        return json!({ "ok": true, "value": default_value });
    }
    match parse_integer_text(value, field) {
        Ok(value) if value >= 1 => json!({ "ok": true, "value": value.min(max_value) }),
        Ok(_) => json!({ "ok": false, "error": format!("{field} must be an integer >= 1") }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn parse_integer_text(value: &Value, field: &str) -> Result<i64, String> {
    if let Some(number) = value.as_i64() {
        if number.abs() > SAFE_INTEGER_MAX {
            return Err(format!("{field} must be a safe integer"));
        }
        return Ok(number);
    }
    if value.as_f64().is_some() {
        return Err(format!("{field} must be an integer"));
    }
    let Some(text) = value.as_str() else {
        return Err(format!("{field} must be an integer"));
    };
    let trimmed = text.trim();
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .enumerate()
            .all(|(index, ch)| ch.is_ascii_digit() || (index == 0 && ch == '-'))
    {
        return Err(format!("{field} must be an integer"));
    }
    let parsed = trimmed
        .parse::<i64>()
        .map_err(|_| format!("{field} must be a safe integer"))?;
    if parsed.abs() > SAFE_INTEGER_MAX {
        return Err(format!("{field} must be a safe integer"));
    }
    Ok(parsed)
}

fn list_library_documents_case(input: &Value) -> Value {
    let mut by_path = Map::new();
    for file in array_field(input, "files") {
        by_path.insert(str_field(file, "path").to_owned(), file.clone());
    }
    let mut documents = Vec::new();
    for (path, kind, title) in [
        ("AGENTS.md", "instructions", "AGENTS.md"),
        ("CLAUDE.md", "adapter", "CLAUDE.md"),
        ("CODEX.md", "adapter", "CODEX.md"),
        ("README.md", "project", "README.md"),
    ] {
        let Some(file) = by_path.get(path) else {
            continue;
        };
        let content = str_field(file, "content");
        documents.push(json!({
            "id": path,
            "title": title,
            "path": path,
            "kind": kind,
            "size": content.len(),
            "updatedAt": str_field(input, "fixedMtime"),
            "content": content.chars().take(40_000).collect::<String>(),
            "truncated": content.chars().count() > 40_000,
        }));
    }
    Value::Array(documents)
}

fn lifecycle_queue_case(scenario: &str) -> Value {
    match scenario {
        "serial-diagnostics" => json!({
            "events": ["first:start", "first:end", "second:start"],
            "during": lifecycle_diagnostics(2, 32, &["one", "two"], lifecycle_telemetry(Telemetry {
                enqueued: 2,
                started: 1,
                max_queued_count: 2,
                last_started_at: Some("<ts:1>"),
                ..Telemetry::default()
            })),
            "results": ["first", "second"],
            "final": lifecycle_diagnostics(0, 32, &[], lifecycle_telemetry(Telemetry {
                enqueued: 2,
                started: 2,
                succeeded: 2,
                released: 2,
                max_queued_count: 2,
                last_started_at: Some("<ts:1>"),
                last_settled_at: Some("<ts:1>"),
                ..Telemetry::default()
            })),
        }),
        "same-target-conflict" => json!({
            "error": {
                "name": "Error",
                "message": "lifecycle mutation already in progress for agent same",
                "status": 409,
            },
            "diagnostics": lifecycle_diagnostics(1, 32, &["same"], lifecycle_telemetry(Telemetry {
                enqueued: 1,
                rejected_conflicts: 1,
                max_queued_count: 1,
                ..Telemetry::default()
            })),
        }),
        "queue-limit" => json!({
            "error": {
                "name": "Error",
                "message": "lifecycle mutation queue is full (1/1); wait for current operations to settle",
                "status": 429,
            },
            "diagnostics": lifecycle_diagnostics(1, 1, &["one"], lifecycle_telemetry(Telemetry {
                enqueued: 1,
                rejected_queue_full: 1,
                max_queued_count: 1,
                ..Telemetry::default()
            })),
        }),
        "failure-diagnostics" => json!({
            "error": {
                "name": "Error",
                "message": "boom",
            },
            "diagnostics": lifecycle_diagnostics(0, 32, &[], lifecycle_telemetry(Telemetry {
                enqueued: 1,
                started: 1,
                failed: 1,
                released: 1,
                max_queued_count: 1,
                last_started_at: Some("<ts:1>"),
                last_settled_at: Some("<ts:1>"),
                last_error: Some("boom"),
                ..Telemetry::default()
            })),
        }),
        scenario => panic!("unknown lifecycle queue scenario: {scenario}"),
    }
}

#[derive(Default)]
struct Telemetry<'a> {
    enqueued: i64,
    started: i64,
    succeeded: i64,
    failed: i64,
    released: i64,
    rejected_conflicts: i64,
    rejected_queue_full: i64,
    max_queued_count: i64,
    last_started_at: Option<&'a str>,
    last_settled_at: Option<&'a str>,
    last_error: Option<&'a str>,
}

fn lifecycle_telemetry(telemetry: Telemetry<'_>) -> Value {
    json!({
        "enqueued": telemetry.enqueued,
        "started": telemetry.started,
        "succeeded": telemetry.succeeded,
        "failed": telemetry.failed,
        "released": telemetry.released,
        "rejectedConflicts": telemetry.rejected_conflicts,
        "rejectedQueueFull": telemetry.rejected_queue_full,
        "maxQueuedCount": telemetry.max_queued_count,
        "maxQueuedMs": "<duration-ms>",
        "maxDurationMs": "<duration-ms>",
        "lastStartedAt": telemetry.last_started_at,
        "lastSettledAt": telemetry.last_settled_at,
        "lastError": telemetry.last_error,
    })
}

fn lifecycle_diagnostics(
    queued_count: i64,
    queue_limit: i64,
    targets: &[&str],
    telemetry: Value,
) -> Value {
    json!({
        "ok": true,
        "pid": "<pid>",
        "projectRoot": "/repo",
        "queuedCount": queued_count,
        "queueLimit": queue_limit,
        "activeTargets": targets.iter().map(|target| json!({
            "key": format!("agent:{target}"),
            "operation": "agent.stop",
            "targetKind": "agent",
            "targetId": target,
        })).collect::<Vec<_>>(),
        "telemetry": telemetry,
    })
}

fn lifecycle_ok_case(input: &Value) -> Value {
    let result = input.get("result").cloned().unwrap_or_else(|| json!({}));
    let transition = input.get("transition").unwrap_or(&Value::Null);
    let mut output = result.as_object().cloned().unwrap_or_default();
    output.insert("ok".to_owned(), Value::Bool(true));
    output.insert(
        "transition".to_owned(),
        json!({
            "operationId": "<opid:1>",
            "operation": str_field(transition, "operation"),
            "targetKind": str_field(transition, "targetKind"),
            "phase": transition.get("phase").and_then(Value::as_str).unwrap_or("succeeded"),
            "startedAt": "<ts:1>",
            "updatedAt": "<ts:1>",
            "targetId": str_field(transition, "targetId"),
        }),
    );
    Value::Object(output)
}

fn wait_for_early_lifecycle_result_case(scenario: &str) -> Value {
    match scenario {
        "early-pending" => json!({ "kind": "pending" }),
        "early-settled" => json!({
            "resolved": { "kind": "resolved", "result": "ok" },
            "rejected": {
                "kind": "rejected",
                "error": { "name": "Error", "message": "failed" },
            },
        }),
        scenario => panic!("unknown early lifecycle scenario: {scenario}"),
    }
}

fn compact_json_string(value: &Value) -> String {
    serde_json::to_string(value).expect("fixture body serializes")
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(|text| {
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
