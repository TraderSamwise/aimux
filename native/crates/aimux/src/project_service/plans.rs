use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::write_text_atomic;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};

const PLAN_ROUTE_PREFIX: &str = "/plans/";

pub fn route_plan_request(
    project_root: impl AsRef<Path>,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if !pathname.starts_with(PLAN_ROUTE_PREFIX) {
        return None;
    }

    match method.to_ascii_uppercase().as_str() {
        "GET" => Some(read_plan_route(project_root, pathname)),
        "PUT" => Some(write_plan_route(project_root, pathname, body)),
        _ => None,
    }
}

pub fn validate_plan_session_id(raw: &str) -> Option<&str> {
    if raw.is_empty() || raw.contains("..") {
        return None;
    }
    if raw
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Some(raw)
    } else {
        None
    }
}

pub fn plan_authority_dir_for_project_root(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join(".aimux").join("plans")
}

pub fn plan_authority_path_for_project_root(
    project_root: impl AsRef<Path>,
    session_id: &str,
) -> Result<PathBuf, String> {
    let Some(session_id) = validate_plan_session_id(session_id) else {
        return Err("invalid sessionId".into());
    };
    Ok(plan_authority_dir_for_project_root(project_root).join(format!("{session_id}.md")))
}

pub fn read_plan_content(
    project_root: impl AsRef<Path>,
    session_id: &str,
) -> Result<Option<String>, String> {
    let path = plan_authority_path_for_project_root(project_root, session_id)?;
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Every plan the authority directory holds, as (session id, content).
///
/// Node's plan-authority.ts listed these for the progress watcher; production
/// only ever read one plan at a time.
pub fn list_plan_authority_entries(project_root: impl AsRef<Path>) -> Vec<(String, String)> {
    let dir = plan_authority_dir_for_project_root(project_root);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut plans = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if validate_plan_session_id(stem).is_none() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            plans.push((stem.to_owned(), content));
        }
    }
    plans.sort_by(|left, right| left.0.cmp(&right.0));
    plans
}

pub fn write_plan_content(
    project_root: impl AsRef<Path>,
    session_id: &str,
    content: &str,
) -> Result<(), String> {
    let path = plan_authority_path_for_project_root(project_root, session_id)?;
    write_text_atomic(path, content).map_err(|error| error.to_string())
}

fn read_plan_route(
    project_root: impl AsRef<Path>,
    pathname: &str,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = decode_plan_session_id(pathname) else {
        return json_response(400, json!({ "ok": false, "error": "invalid sessionId" }));
    };
    match read_plan_content(project_root, &session_id) {
        Ok(Some(content)) => json_response(
            200,
            json!({ "ok": true, "sessionId": session_id, "content": content }),
        ),
        Ok(None) => json_response(404, json!({ "ok": false, "error": "Plan not found" })),
        Err(_) => json_response(500, json!({ "ok": false, "error": "Failed to read plan" })),
    }
}

fn write_plan_route(
    project_root: impl AsRef<Path>,
    pathname: &str,
    body: Option<&Value>,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = decode_plan_session_id(pathname) else {
        return json_response(400, json!({ "ok": false, "error": "invalid sessionId" }));
    };
    let Some(content) = body
        .and_then(|body| body.get("content"))
        .and_then(Value::as_str)
    else {
        return json_response(
            400,
            json!({ "ok": false, "error": "content must be a string" }),
        );
    };
    match write_plan_content(project_root, &session_id, content) {
        Ok(()) => json_response(200, json!({ "ok": true, "sessionId": session_id })),
        Err(_) => json_response(500, json!({ "ok": false, "error": "Failed to write plan" })),
    }
}

fn decode_plan_session_id(pathname: &str) -> Option<String> {
    let raw = pathname.strip_prefix(PLAN_ROUTE_PREFIX)?;
    let decoded = percent_decode_uri_component(raw).ok()?;
    validate_plan_session_id(&decoded).map(str::to_owned)
}

fn percent_decode_uri_component(input: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
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

pub fn plans_route_prefix() -> &'static str {
    routes::PLANS
}
