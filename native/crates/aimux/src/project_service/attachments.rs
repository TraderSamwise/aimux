use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::remote_access::{RemoteActorRole, parse_remote_actor};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

pub fn route_attachment_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let pathname = project_service_pathname(path);
    let content_id = attachment_content_id(pathname);
    let metadata_id = attachment_metadata_id(pathname);
    if content_id.is_none() && metadata_id.is_none() {
        return None;
    }
    let raw_read_session = query_param(path, "sessionId");
    let attachment_read_session = raw_read_session.as_deref().map(str::trim);
    if attachment_read_session == Some("") {
        return Some(json_response(
            400,
            json!({ "ok": false, "error": "sessionId is invalid" }),
        ));
    }
    if parse_remote_actor(&context.request_headers)
        .as_ref()
        .is_some_and(|actor| actor.role == RemoteActorRole::Guest)
    {
        let actor = parse_remote_actor(&context.request_headers).expect("guest actor");
        if actor
            .share_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            != attachment_read_session
        {
            return Some(json_response(
                403,
                json!({ "ok": false, "error": "shared guest cannot access another session" }),
            ));
        }
        if metadata_id.is_some() {
            return Some(json_response(
                403,
                json!({ "ok": false, "error": "shared guests cannot read attachment metadata" }),
            ));
        }
    }
    if let Some(raw_id) = content_id {
        let Ok(id) = percent_decode_uri_component(raw_id) else {
            return Some(json_response(
                404,
                json!({ "ok": false, "error": "attachment not found" }),
            ));
        };
        let Some(content) =
            get_attachment_content(context.project_root(), &id, attachment_read_session)
        else {
            return Some(json_response(
                404,
                json!({ "ok": false, "error": "attachment not found" }),
            ));
        };
        return Some(ProjectServiceDispatchResponse::bytes(
            200,
            content.buffer,
            content
                .attachment
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream"),
        ));
    }
    let raw_id = metadata_id.expect("metadata id");
    let Ok(id) = percent_decode_uri_component(raw_id) else {
        return Some(json_response(
            404,
            json!({ "ok": false, "error": "attachment not found" }),
        ));
    };
    let Some(attachment) = get_attachment(context.project_root(), &id, attachment_read_session)
    else {
        return Some(json_response(
            404,
            json!({ "ok": false, "error": "attachment not found" }),
        ));
    };
    Some(json_response(
        200,
        json!({ "ok": true, "attachment": attachment }),
    ))
}

pub fn attachments_dir(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join(".aimux").join("attachments")
}

pub fn get_attachment(
    project_root: impl AsRef<Path>,
    id: &str,
    session_id: Option<&str>,
) -> Option<Value> {
    get_attachment_for_display(project_root, id, session_id).map(to_public_attachment)
}

pub struct AttachmentContent {
    pub attachment: Value,
    pub buffer: Vec<u8>,
}

pub fn get_attachment_content(
    project_root: impl AsRef<Path>,
    id: &str,
    session_id: Option<&str>,
) -> Option<AttachmentContent> {
    let record = get_attachment_for_display(project_root, id, session_id)?;
    let content_path = string_field(&record, "contentPath")?.to_owned();
    Some(AttachmentContent {
        attachment: to_public_attachment(record),
        buffer: fs::read(content_path).ok()?,
    })
}

fn get_attachment_for_display(
    project_root: impl AsRef<Path>,
    id: &str,
    session_id: Option<&str>,
) -> Option<Value> {
    let record = get_attachment_record(project_root, id)?;
    if let Some(session_id) = session_id
        && string_field(&record, "sessionId").is_some_and(|owner| owner != session_id)
    {
        return None;
    }
    Some(record)
}

fn get_attachment_record(project_root: impl AsRef<Path>, id: &str) -> Option<Value> {
    let normalized_id = id.trim();
    if normalized_id.is_empty() || !is_valid_attachment_id(normalized_id) {
        return None;
    }
    let metadata_path = attachments_dir(project_root).join(format!("{normalized_id}.json"));
    if !metadata_path.exists() {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(&fs::read_to_string(metadata_path).ok()?).ok()?;
    let content_path = string_field(&parsed, "contentPath")?;
    if !Path::new(content_path).exists() {
        return None;
    }
    Some(parsed)
}

fn to_public_attachment(record: Value) -> Value {
    let mut public = Map::new();
    for key in [
        "id",
        "kind",
        "filename",
        "mimeType",
        "sizeBytes",
        "sha256",
        "createdAt",
        "source",
    ] {
        if let Some(value) = record.get(key) {
            public.insert(key.into(), value.clone());
        }
    }
    if let Some(id) = string_field(&record, "id") {
        let content_url = if let Some(session_id) = string_field(&record, "sessionId") {
            format!(
                "/attachments/{id}/content?sessionId={}",
                encode_uri_component(session_id)
            )
        } else {
            format!("/attachments/{id}/content")
        };
        public.insert("contentUrl".into(), Value::String(content_url));
    }
    if let Some(hosted) = record.get("hostedAttachment").and_then(Value::as_object) {
        if let Some(value) = hosted.get("contentUrl") {
            public.insert("hostedContentUrl".into(), value.clone());
        }
        if let Some(value) = hosted.get("expiresAt") {
            public.insert("hostedExpiresAt".into(), value.clone());
        }
    }
    if let Some(value) = record.get("sessionId") {
        public.insert("sessionId".into(), value.clone());
    }
    Value::Object(public)
}

fn attachment_content_id(pathname: &str) -> Option<&str> {
    pathname
        .strip_prefix("/attachments/")?
        .strip_suffix("/content")
        .filter(|id| !id.is_empty() && !id.contains('/'))
}

fn attachment_metadata_id(pathname: &str) -> Option<&str> {
    pathname
        .strip_prefix("/attachments/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
}

fn is_valid_attachment_id(id: &str) -> bool {
    id.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn query_param(path: &str, name: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode_form(key) == name {
            return Some(percent_decode_form(value));
        }
    }
    None
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

fn encode_uri_component(input: &str) -> String {
    let mut output = String::new();
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
