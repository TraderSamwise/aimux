use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use crate::backend_session_ids::record_topology_backend_session_id;
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
    update_runtime_topology,
};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::metadata::{route_runtime_metadata_request, update_session_metadata};
use super::notifications::{
    NotificationMutation, NotificationWriteInput, add_notification, clear_notifications,
};
use super::router::ProjectServiceRequestContext;

pub fn route_hook_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let pathname = project_service_pathname(path);
    if pathname != routes::hooks::CLAUDE && pathname != routes::hooks::CODEX {
        return None;
    }
    let action = query_value(path, "action").unwrap_or_default();
    let session_id = hook_session_id(&context.request_headers, path);
    if action.is_empty() || session_id.is_empty() {
        return Some(json_response(
            400,
            json!({ "ok": false, "error": "action and sessionId are required" }),
        ));
    }
    let empty_body = Value::Object(Map::new());
    let body = body.unwrap_or(&empty_body);
    if pathname == routes::hooks::CLAUDE {
        Some(route_claude_hook(context, &action, &session_id, body))
    } else {
        Some(route_codex_hook(context, &action, &session_id, body))
    }
}

fn route_claude_hook(
    context: &ProjectServiceRequestContext,
    action: &str,
    explicit_session_id: &str,
    payload: &Value,
) -> ProjectServiceDispatchResponse {
    let backend_session_id = trimmed_payload_string(payload, "session_id");
    let session_id =
        resolve_hook_session_id(context, explicit_session_id, backend_session_id.as_deref());
    record_hook_backend_session_id(context, &session_id, backend_session_id.as_deref());
    if let Err(error) = record_hook_metadata(context, &session_id, payload, true) {
        return json_response(500, json!({ "ok": false, "error": error }));
    }
    match action {
        "session-start" | "active" | "session-end" => {}
        "prompt-submit" | "pre-tool-use" => {
            if let Err(error) = mark_hook_session_running(context, &session_id) {
                return json_response(500, json!({ "ok": false, "error": error }));
            }
        }
        "notification" | "notify" => {
            let summary = summarize_claude_notification(payload);
            return emit_hook_event(
                context,
                &session_id,
                json!({ "kind": "needs_input", "message": summary.body, "tone": "warn" }),
                trimmed_payload_string(payload, "cwd"),
            );
        }
        "stop" | "idle" => {
            let summary = summarize_claude_stop(payload);
            return emit_hook_event(
                context,
                &session_id,
                json!({ "kind": "task_done", "message": summary.body, "tone": "success" }),
                None,
            );
        }
        "permission-request" => return json_response(200, json!({})),
        _ => {
            return json_response(
                500,
                json!({ "ok": false, "error": format!("Unsupported claude hook action: {action}") }),
            );
        }
    }
    json_response(200, json!({}))
}

fn route_codex_hook(
    context: &ProjectServiceRequestContext,
    action: &str,
    session_id: &str,
    payload: &Value,
) -> ProjectServiceDispatchResponse {
    let backend_session_id = trimmed_payload_string(payload, "session_id");
    record_hook_backend_session_id(context, session_id, backend_session_id.as_deref());
    if let Err(error) = record_hook_metadata(context, session_id, payload, false) {
        return json_response(500, json!({ "ok": false, "error": error }));
    }
    match action {
        "session-start" => {}
        "prompt-submit" => {
            if let Err(error) = mark_hook_session_running(context, session_id) {
                return json_response(500, json!({ "ok": false, "error": error }));
            }
        }
        "stop" => {
            let message = trimmed_payload_string(payload, "message")
                .unwrap_or_else(|| "Codex completed its turn.".to_owned());
            return emit_hook_event(
                context,
                session_id,
                json!({ "kind": "task_done", "message": message, "tone": "success" }),
                None,
            );
        }
        "permission-request" => {
            if let Err(error) = notify_codex_permission_telemetry(context, session_id, payload) {
                return json_response(500, json!({ "ok": false, "error": error }));
            }
        }
        _ => {
            return json_response(
                500,
                json!({ "ok": false, "error": format!("Unsupported codex hook action: {action}") }),
            );
        }
    }
    json_response(200, json!({}))
}

fn resolve_hook_session_id(
    context: &ProjectServiceRequestContext,
    explicit_session_id: &str,
    backend_session_id: Option<&str>,
) -> String {
    let Some(backend_session_id) = backend_session_id
        .map(str::trim)
        .filter(|backend_session_id| !backend_session_id.is_empty())
    else {
        return explicit_session_id.to_owned();
    };
    let topology = match read_runtime_topology(runtime_topology_path(context.project_state_dir())) {
        Ok(topology) => topology,
        Err(_) => return explicit_session_id.to_owned(),
    };
    let sessions = list_topology_session_states(&topology, None);
    if let Some(explicit) = sessions.iter().find(|session| {
        session.get("id").and_then(Value::as_str) == Some(explicit_session_id)
            && backend_matches_or_missing(session, backend_session_id)
            && session_is_live_for_hook(context, session)
    }) {
        if let Some(id) = explicit.get("id").and_then(Value::as_str) {
            return id.to_owned();
        }
    }
    let best_backend_match = sessions
        .iter()
        .filter(|session| {
            session.get("backendSessionId").and_then(Value::as_str) == Some(backend_session_id)
        })
        .max_by_key(|session| session_match_score(context, session))
        .cloned();
    if let Some(session) = best_backend_match.as_ref()
        && session_is_live_for_hook(context, session)
    {
        if let Some(id) = session.get("id").and_then(Value::as_str) {
            return id.to_owned();
        }
    }
    if let Some(stale) = best_backend_match.as_ref()
        && let Some(live) = live_replacement_for_stale_session(context, &sessions, stale)
        && let Some(id) = live.get("id").and_then(Value::as_str)
    {
        return id.to_owned();
    }
    best_backend_match
        .and_then(|session| session.get("id").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| explicit_session_id.to_owned())
}

fn backend_matches_or_missing(session: &Value, backend_session_id: &str) -> bool {
    session
        .get("backendSessionId")
        .and_then(Value::as_str)
        .is_none_or(|existing| existing.trim().is_empty() || existing == backend_session_id)
}

fn session_match_score(context: &ProjectServiceRequestContext, session: &Value) -> i32 {
    if session_is_live_for_hook(context, session) {
        2
    } else if !matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited")
    ) {
        1
    } else {
        0
    }
}

fn session_is_live_for_hook(context: &ProjectServiceRequestContext, session: &Value) -> bool {
    if matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited")
    ) {
        return false;
    }
    let Some(live_window_ids) = context.live_window_ids() else {
        return true;
    };
    session
        .get("tmuxTarget")
        .and_then(|target| target.get("windowId"))
        .and_then(Value::as_str)
        .is_some_and(|window_id| live_window_ids.contains(window_id))
}

fn live_replacement_for_stale_session<'a>(
    context: &ProjectServiceRequestContext,
    sessions: &'a [Value],
    stale: &Value,
) -> Option<&'a Value> {
    sessions
        .iter()
        .filter(|session| session_is_live_for_hook(context, session))
        .filter(|session| same_hook_identity(session, stale))
        .max_by_key(|session| {
            session
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or("")
        })
}

fn same_hook_identity(candidate: &Value, stale: &Value) -> bool {
    same_non_empty_field(candidate, stale, "tool")
        && same_optional_field(candidate, stale, "toolConfigKey")
        && same_optional_field(candidate, stale, "command")
        && compatible_optional_field(candidate, stale, "worktreePath")
        && same_nested_optional_field(candidate, stale, &["team", "role"])
}

fn same_non_empty_field(left: &Value, right: &Value, key: &str) -> bool {
    let left = trimmed_value(left.get(key).and_then(Value::as_str));
    !left.is_empty() && left == trimmed_value(right.get(key).and_then(Value::as_str))
}

fn same_optional_field(left: &Value, right: &Value, key: &str) -> bool {
    trimmed_value(left.get(key).and_then(Value::as_str))
        == trimmed_value(right.get(key).and_then(Value::as_str))
}

fn compatible_optional_field(left: &Value, right: &Value, key: &str) -> bool {
    let left = trimmed_value(left.get(key).and_then(Value::as_str));
    let right = trimmed_value(right.get(key).and_then(Value::as_str));
    left.is_empty() || right.is_empty() || left == right
}

fn same_nested_optional_field(left: &Value, right: &Value, path: &[&str]) -> bool {
    trimmed_value(nested_string(left, path)) == trimmed_value(nested_string(right, path))
}

fn nested_string<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn trimmed_value(value: Option<&str>) -> &str {
    value.map(str::trim).unwrap_or_default()
}

fn record_hook_backend_session_id(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    backend_session_id: Option<&str>,
) {
    let Some(backend_session_id) = backend_session_id
        .map(str::trim)
        .filter(|backend_session_id| !backend_session_id.is_empty())
    else {
        return;
    };
    let _ = update_runtime_topology(
        runtime_topology_path(context.project_state_dir()),
        |mut topology| {
            let _ =
                record_topology_backend_session_id(&mut topology, session_id, backend_session_id);
            topology
        },
    );
}

fn mark_hook_session_running(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> Result<(), String> {
    clear_notifications(
        context.project_state_dir(),
        NotificationMutation {
            id: None,
            ids: None,
            session_id: Some(session_id.to_owned()),
        },
    );
    update_session_metadata(context.project_state_dir(), session_id, |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        let mut derived = object
            .get("derived")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        derived.insert("activity".to_owned(), Value::String("running".to_owned()));
        derived.insert("attention".to_owned(), Value::String("normal".to_owned()));
        derived.insert("unseenCount".to_owned(), Value::Number(0.into()));
        derived.remove("becameIdleAt");
        object.insert("derived".to_owned(), Value::Object(derived));
        Value::Object(object)
    })?;
    Ok(())
}

fn emit_hook_event(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    mut event: Value,
    worktree_path: Option<String>,
) -> ProjectServiceDispatchResponse {
    if let Some(worktree_path) = worktree_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        && let Some(event_object) = event.as_object_mut()
        && event_object
            .get("worktreePath")
            .and_then(Value::as_str)
            .is_none_or(|path| path.trim().is_empty())
    {
        event_object.insert(
            "worktreePath".to_owned(),
            Value::String(worktree_path.to_owned()),
        );
    }
    let response = route_runtime_metadata_request(
        context,
        "POST",
        routes::runtime::EVENT,
        Some(&json!({ "session": session_id, "event": event })),
    )
    .unwrap_or_else(|| {
        json_response(
            500,
            json!({ "ok": false, "error": "runtime event route unavailable" }),
        )
    });
    if response.status != 200 {
        return response;
    }
    if let Some(worktree_path) = worktree_path {
        let _ = update_latest_notification_worktree(context, session_id, &worktree_path);
    }
    json_response(200, json!({}))
}

fn update_latest_notification_worktree(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    worktree_path: &str,
) -> Result<(), String> {
    use super::runtime_exchange::{runtime_exchange_path, update_runtime_exchange};
    update_runtime_exchange(
        runtime_exchange_path(context.project_state_dir()),
        |mut exchange| {
            if let Some(message) = exchange
                .get_mut("messages")
                .and_then(Value::as_array_mut)
                .and_then(|messages| {
                    messages.iter_mut().rev().find(|message| {
                        message
                            .get("metadata")
                            .and_then(|metadata| metadata.get("notificationSessionId"))
                            .and_then(Value::as_str)
                            == Some(session_id)
                    })
                })
                && let Some(metadata) = message.get_mut("metadata").and_then(Value::as_object_mut)
            {
                metadata.insert(
                    "notificationWorktreePath".to_owned(),
                    Value::String(worktree_path.to_owned()),
                );
            }
            exchange
        },
    )?;
    Ok(())
}

fn notify_codex_permission_telemetry(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let summary = summarize_permission_request(payload);
    let dedupe_key = format!(
        "interaction:{session_id}:permission:{}",
        summary.fingerprint
    );
    add_notification(
        context.project_state_dir(),
        NotificationWriteInput {
            kind: Some("interaction_request".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} requests permission"),
            body: summary.summary.clone(),
            dedupe_key: Some(dedupe_key.clone()),
            interaction: Some(json!({
                "id": dedupe_key,
                "type": "permission",
                "summary": summary.summary,
                "telemetry": true,
                "toolName": summary.tool_name,
                "toolInputJSON": summary.input_json,
            })),
            ..NotificationWriteInput::default()
        },
    )?;
    Ok(())
}

fn record_hook_metadata(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    payload: &Value,
    include_transcript_path: bool,
) -> Result<(), String> {
    let backend_session_id = trimmed_payload_string(payload, "session_id");
    let transcript_path = include_transcript_path
        .then(|| trimmed_payload_string(payload, "transcript_path"))
        .flatten();
    if backend_session_id.is_none() && transcript_path.is_none() {
        return Ok(());
    }
    update_session_metadata(context.project_state_dir(), session_id, |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        if let Some(backend_session_id) = backend_session_id {
            object.insert(
                "backendSessionId".to_owned(),
                Value::String(backend_session_id),
            );
        }
        if let Some(transcript_path) = transcript_path {
            let mut context = object
                .get("context")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            context.insert("transcriptPath".to_owned(), Value::String(transcript_path));
            object.insert("context".to_owned(), Value::Object(context));
        }
        Value::Object(object)
    })?;
    Ok(())
}

struct HookSummary {
    body: String,
}

fn summarize_claude_notification(payload: &Value) -> HookSummary {
    let object = payload.get("object").and_then(Value::as_object);
    HookSummary {
        body: pick_string([
            payload.get("message"),
            object.and_then(|object| object.get("message")),
            object.and_then(|object| object.get("body")),
            object.and_then(|object| object.get("question")),
        ])
        .unwrap_or_else(|| "Claude needs your attention.".to_owned()),
    }
}

fn summarize_claude_stop(payload: &Value) -> HookSummary {
    let object = payload.get("object").and_then(Value::as_object);
    HookSummary {
        body: pick_string([
            payload.get("message"),
            object.and_then(|object| object.get("summary")),
            object.and_then(|object| object.get("message")),
        ])
        .unwrap_or_else(|| "Claude completed its turn.".to_owned()),
    }
}

struct PermissionSummary {
    tool_name: String,
    input_json: Option<String>,
    summary: String,
    fingerprint: String,
}

fn summarize_permission_request(payload: &Value) -> PermissionSummary {
    let tool_name =
        trimmed_payload_string(payload, "tool_name").unwrap_or_else(|| "tool".to_owned());
    let input = payload.get("tool_input").cloned();
    let detail = input.as_ref().and_then(|input| {
        pick_string([
            input.get("command"),
            input.get("file_path"),
            input.get("path"),
            input.get("url"),
        ])
    });
    let summary = detail
        .map(|detail| {
            let detail = if detail.len() > 200 {
                format!("{}…", detail.chars().take(200).collect::<String>())
            } else {
                detail
            };
            format!("{tool_name}: {detail}")
        })
        .unwrap_or_else(|| tool_name.clone());
    let input_json = input
        .as_ref()
        .filter(|input| input.is_object())
        .and_then(|input| serde_json::to_string(input).ok());
    let cwd = trimmed_payload_string(payload, "cwd");
    let fingerprint_source = json!({
        "type": "permission",
        "summary": summary,
        "payload": {
            "toolName": tool_name,
            "input": input,
            "cwd": cwd,
        }
    });
    PermissionSummary {
        tool_name,
        input_json,
        fingerprint: stable_hash(&fingerprint_source),
        summary,
    }
}

fn stable_hash(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    let json = serde_json::to_string(value).unwrap_or_default();
    let digest = Sha256::digest(json.as_bytes());
    base64_url_no_pad(&digest).chars().take(12).collect()
}

fn base64_url_no_pad(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(TABLE[(third & 0b0011_1111) as usize] as char);
        }
    }
    output
}

fn hook_session_id(headers: &BTreeMap<String, String>, path: &str) -> String {
    header_value(headers, "x-aimux-session-id")
        .or_else(|| query_value(path, "sessionId"))
        .unwrap_or_default()
}

fn header_value(headers: &BTreeMap<String, String>, name: &str) -> Option<String> {
    headers
        .iter()
        .find_map(|(key, value)| key.eq_ignore_ascii_case(name).then_some(value))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn query_value(path: &str, key: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (name == key)
            .then(|| percent_decode(value).trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn percent_decode(value: &str) -> String {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'+' {
            output.push(b' ');
            index += 1;
        } else if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &value[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                output.push(byte);
                index += 3;
            } else {
                output.push(bytes[index]);
                index += 1;
            }
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn pick_string<const N: usize>(values: [Option<&Value>; N]) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_owned)
}

fn trimmed_payload_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
