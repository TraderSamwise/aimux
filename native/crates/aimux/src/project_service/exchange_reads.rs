use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::parse_bounded_limit;
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{runtime_exchange_path, try_read_runtime_exchange};

const DEFAULT_PROJECT_LIST_LIMIT: i64 = 200;
const MAX_PROJECT_LIST_LIMIT: i64 = 500;
const DEFAULT_PROJECT_DETAIL_MESSAGE_LIMIT: i64 = 500;
const MAX_PROJECT_DETAIL_MESSAGE_LIMIT: i64 = 1_000;

pub fn route_exchange_read_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let pathname = project_service_pathname(path);
    if pathname == routes::threads::LIST {
        return Some(route_thread_list(context, path));
    }
    if pathname == routes::tasks::LIST {
        return Some(route_task_list(context, path));
    }
    let thread_prefix = format!("{}/", routes::threads::LIST);
    if let Some(raw_thread_id) = pathname.strip_prefix(&thread_prefix) {
        return Some(route_thread_detail(context, path, raw_thread_id));
    }
    let task_prefix = format!("{}/", routes::tasks::LIST);
    if let Some(raw_task_id) = pathname.strip_prefix(&task_prefix) {
        return Some(route_task_detail(context, path, raw_task_id));
    }
    None
}

pub fn list_thread_summaries(
    exchange: &Value,
    participant_id: Option<&str>,
    limit: usize,
) -> Vec<Value> {
    let mut threads = exchange
        .get("threads")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|thread| {
            participant_id.is_none_or(|participant_id| {
                string_array(thread.get("participants"))
                    .iter()
                    .any(|participant| participant == participant_id)
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    threads.sort_by(|left, right| {
        string_field(right, "updatedAt")
            .unwrap_or("")
            .cmp(string_field(left, "updatedAt").unwrap_or(""))
    });
    threads.truncate(limit);
    threads
        .into_iter()
        .map(|thread| {
            let mut summary = Map::new();
            let thread_id = string_field(&thread, "id").unwrap_or("");
            summary.insert("thread".into(), thread.clone());
            if let Some(message) = latest_message(exchange, thread_id) {
                summary.insert("latestMessage".into(), message.clone());
            }
            Value::Object(summary)
        })
        .collect()
}

pub fn list_tasks(
    exchange: &Value,
    session_id: Option<&str>,
    status: Option<&str>,
    limit: usize,
) -> Value {
    let all_tasks = exchange
        .get("tasks")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|task| {
            session_id.is_none_or(|session_id| {
                string_field(task, "assignedTo") == Some(session_id)
                    || string_field(task, "assignedBy") == Some(session_id)
            })
        })
        .filter(|task| status.is_none_or(|status| string_field(task, "status") == Some(status)))
        .cloned()
        .collect::<Vec<_>>();
    let tasks = all_tasks.iter().take(limit).cloned().collect::<Vec<_>>();
    json!({
        "ok": true,
        "tasks": tasks,
        "total": all_tasks.len(),
        "limit": limit,
        "truncated": tasks.len() < all_tasks.len(),
    })
}

pub fn read_message_snapshot(
    exchange: &Value,
    thread_id: &str,
    limit: usize,
) -> (Vec<Value>, usize, bool) {
    let mut messages = exchange
        .get("messages")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|message| string_field(message, "threadId") == Some(thread_id))
        .cloned()
        .collect::<Vec<_>>();
    messages.sort_by(|left, right| {
        string_field(left, "ts")
            .unwrap_or("")
            .cmp(string_field(right, "ts").unwrap_or(""))
    });
    let total = messages.len();
    let start = total.saturating_sub(limit);
    let bounded = messages.split_off(start);
    let truncated = bounded.len() < total;
    (bounded, total, truncated)
}

fn route_thread_list(
    context: &ProjectServiceRequestContext,
    path: &str,
) -> ProjectServiceDispatchResponse {
    let query = query_params(path);
    let limit = match parse_bounded_limit(
        query.get("limit").map(String::as_str),
        "limit",
        DEFAULT_PROJECT_LIST_LIMIT,
        MAX_PROJECT_LIST_LIMIT,
    ) {
        Ok(limit) => limit as usize,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let exchange =
        match try_read_runtime_exchange(runtime_exchange_path(context.project_state_dir())) {
            Ok(exchange) => exchange,
            Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
        };
    json_response(
        200,
        Value::Array(list_thread_summaries(
            &exchange,
            query
                .get("session")
                .map(String::as_str)
                .filter(|value| !value.is_empty()),
            limit,
        )),
    )
}

fn route_task_list(
    context: &ProjectServiceRequestContext,
    path: &str,
) -> ProjectServiceDispatchResponse {
    let query = query_params(path);
    let limit = match parse_bounded_limit(
        query.get("limit").map(String::as_str),
        "limit",
        DEFAULT_PROJECT_LIST_LIMIT,
        MAX_PROJECT_LIST_LIMIT,
    ) {
        Ok(limit) => limit as usize,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let exchange =
        match try_read_runtime_exchange(runtime_exchange_path(context.project_state_dir())) {
            Ok(exchange) => exchange,
            Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
        };
    json_response(
        200,
        list_tasks(
            &exchange,
            query
                .get("session")
                .map(|value| value.trim())
                .filter(|value| !value.is_empty()),
            query
                .get("status")
                .map(|value| value.trim())
                .filter(|value| !value.is_empty()),
            limit,
        ),
    )
}

fn route_thread_detail(
    context: &ProjectServiceRequestContext,
    path: &str,
    raw_thread_id: &str,
) -> ProjectServiceDispatchResponse {
    let thread_id = match percent_decode_uri_component(raw_thread_id) {
        Ok(thread_id) => thread_id,
        Err(_) => return json_response(400, json!({ "ok": false, "error": "invalid threadId" })),
    };
    let exchange =
        match try_read_runtime_exchange(runtime_exchange_path(context.project_state_dir())) {
            Ok(exchange) => exchange,
            Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
        };
    let Some(thread) = find_by_id(&exchange, "threads", &thread_id) else {
        return json_response(404, json!({ "ok": false, "error": "thread not found" }));
    };
    let query = query_params(path);
    let limit = match parse_bounded_limit(
        query.get("messageLimit").map(String::as_str),
        "messageLimit",
        DEFAULT_PROJECT_DETAIL_MESSAGE_LIMIT,
        MAX_PROJECT_DETAIL_MESSAGE_LIMIT,
    ) {
        Ok(limit) => limit as usize,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let (messages, total, truncated) = read_message_snapshot(&exchange, &thread_id, limit);
    json_response(
        200,
        json!({
            "thread": thread,
            "messages": messages,
            "messageTotal": total,
            "messageLimit": limit,
            "messagesTruncated": truncated,
        }),
    )
}

fn route_task_detail(
    context: &ProjectServiceRequestContext,
    path: &str,
    raw_task_id: &str,
) -> ProjectServiceDispatchResponse {
    let task_id = match percent_decode_uri_component(raw_task_id) {
        Ok(task_id) => task_id,
        Err(_) => return json_response(400, json!({ "ok": false, "error": "invalid taskId" })),
    };
    let exchange =
        match try_read_runtime_exchange(runtime_exchange_path(context.project_state_dir())) {
            Ok(exchange) => exchange,
            Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
        };
    let Some(task) = find_by_id(&exchange, "tasks", &task_id) else {
        return json_response(404, json!({ "ok": false, "error": "task not found" }));
    };
    let query = query_params(path);
    let limit = match parse_bounded_limit(
        query.get("messageLimit").map(String::as_str),
        "messageLimit",
        DEFAULT_PROJECT_DETAIL_MESSAGE_LIMIT,
        MAX_PROJECT_DETAIL_MESSAGE_LIMIT,
    ) {
        Ok(limit) => limit as usize,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let thread_id = string_field(&task, "threadId");
    let thread = thread_id.and_then(|thread_id| find_by_id(&exchange, "threads", thread_id));
    let (messages, total, truncated) = thread_id
        .map(|thread_id| read_message_snapshot(&exchange, thread_id, limit))
        .unwrap_or_else(|| (Vec::new(), 0, false));
    let mut response = Map::new();
    response.insert("ok".into(), Value::Bool(true));
    response.insert("task".into(), task);
    if let Some(thread) = thread {
        response.insert("thread".into(), thread);
    }
    response.insert("messages".into(), Value::Array(messages));
    response.insert("messageTotal".into(), Value::from(total));
    response.insert("messageLimit".into(), Value::from(limit));
    response.insert("messagesTruncated".into(), Value::Bool(truncated));
    json_response(200, Value::Object(response))
}

fn latest_message<'a>(exchange: &'a Value, thread_id: &str) -> Option<&'a Value> {
    exchange
        .get("messages")
        .and_then(Value::as_array)?
        .iter()
        .filter(|message| string_field(message, "threadId") == Some(thread_id))
        .max_by(|left, right| {
            string_field(left, "ts")
                .unwrap_or("")
                .cmp(string_field(right, "ts").unwrap_or(""))
        })
}

fn find_by_id(exchange: &Value, key: &str, id: &str) -> Option<Value> {
    exchange
        .get(key)
        .and_then(Value::as_array)?
        .iter()
        .find(|entry| string_field(entry, "id") == Some(id))
        .cloned()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
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
    percent_decode_bytes(input, true).unwrap_or_else(|_| input.to_owned())
}

fn percent_decode_uri_component(input: &str) -> Result<String, String> {
    percent_decode_bytes(input, false)
}

fn percent_decode_bytes(input: &str, plus_as_space: bool) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'+' if plus_as_space => {
                bytes.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < raw.len() => {
                let hex = std::str::from_utf8(&raw[index + 1..index + 3])
                    .map_err(|error| error.to_string())?;
                let value = u8::from_str_radix(hex, 16).map_err(|_| "invalid percent escape")?;
                bytes.push(value);
                index += 3;
            }
            b'%' => return Err("invalid percent escape".into()),
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
