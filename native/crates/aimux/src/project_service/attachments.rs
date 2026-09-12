use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::atomic_write::{atomic_write, write_json_atomic};
use crate::project_api_contract::routes;
use crate::remote_access::{RemoteActorRole, parse_remote_actor};
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};

use super::agent_input::hosted_attachment_from_body;
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const RECENT_PUBLISHED_PER_SESSION: usize = 5;
const UNANCHORED_HYDRATE_GRACE_MS: u128 = 2 * 60 * 1000;
static ATTACHMENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static RECENT_PUBLISHED_BY_SESSION: OnceLock<Mutex<HashMap<String, Vec<Value>>>> = OnceLock::new();
static HYDRATED_SESSIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub fn route_attachment_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if method.eq_ignore_ascii_case("POST") && pathname == routes::ATTACHMENTS_PUBLISH {
        return Some(route_attachment_publish(
            context,
            body.unwrap_or(&Value::Null),
        ));
    }
    if method.eq_ignore_ascii_case("POST") && pathname == routes::ATTACHMENTS {
        return Some(route_attachment_upload(
            context,
            body.unwrap_or(&Value::Null),
        ));
    }
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
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

pub fn is_attachment_route(method: &str, path: &str) -> bool {
    let pathname = project_service_pathname(path);
    if method.eq_ignore_ascii_case("POST") {
        return matches!(pathname, routes::ATTACHMENTS_PUBLISH | routes::ATTACHMENTS);
    }
    if !method.eq_ignore_ascii_case("GET") {
        return false;
    }
    attachment_content_id(pathname).is_some() || attachment_metadata_id(pathname).is_some()
}

pub async fn route_attachment_request_async(
    context: Arc<ProjectServiceRequestContext>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Option<ProjectServiceDispatchResponse> {
    if !is_attachment_route(&method, &path) {
        return None;
    }
    let task_name = crate::async_runtime::scoped_task_name(
        "project-service",
        "attachment-route",
        &format!("{method} {path}"),
    );
    match crate::async_runtime::spawn_blocking_named(task_name, move || {
        route_attachment_request(&context, &method, &path, body.as_ref())
    })
    .await
    {
        Ok(response) => response,
        Err(error) => Some(ProjectServiceDispatchResponse::json(
            500,
            json!({ "ok": false, "error": format!("attachment route task failed: {error}") }),
        )),
    }
}

fn route_attachment_publish(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    if parse_remote_actor(&context.request_headers).is_some() {
        return json_response(
            403,
            json!({ "ok": false, "error": "attachment publish is local only" }),
        );
    }
    let raw_session_id = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if raw_session_id.is_empty() {
        return json_response(
            400,
            json!({ "ok": false, "error": "sessionId is required" }),
        );
    }
    if !is_valid_session_id(raw_session_id) {
        return json_response(400, json!({ "ok": false, "error": "sessionId is invalid" }));
    }
    let source_path = body
        .get("path")
        .and_then(Value::as_str)
        .or_else(|| body.get("sourcePath").and_then(Value::as_str))
        .map(str::trim)
        .unwrap_or("");
    if source_path.is_empty() {
        return json_response(400, json!({ "ok": false, "error": "path is required" }));
    }
    let hosted_attachment = hosted_attachment_from_body(body.get("hostedAttachment"));
    let result = create_path_attachment(
        context,
        CreatePathAttachmentInput {
            source_path,
            filename: body.get("filename").and_then(Value::as_str),
            mime_type: body.get("mimeType").and_then(Value::as_str),
            session_id: raw_session_id,
            hosted_attachment,
        },
    );
    let attachment = match result {
        Ok(attachment) => attachment,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let record = match get_attachment_record(
        context.project_root(),
        string_field(&attachment, "id").unwrap_or_default(),
        Some(raw_session_id),
    ) {
        Some(record) => record,
        None => {
            return json_response(
                500,
                json!({ "ok": false, "error": "published attachment could not be read" }),
            );
        }
    };
    let reference_line = format!(
        "- {} ({}, {} bytes): {}",
        string_field(&record, "filename").unwrap_or("attachment"),
        string_field(&record, "mimeType").unwrap_or("application/octet-stream"),
        record
            .get("sizeBytes")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        string_field(&record, "contentPath").unwrap_or("")
    );
    json_response(
        200,
        json!({
            "ok": true,
            "attachment": attachment,
            "referenceText": format!("Attached files:\n{reference_line}"),
        }),
    )
}

fn route_attachment_upload(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let filename = body.get("filename").and_then(Value::as_str);
    let mime_type = body.get("mimeType").and_then(Value::as_str);
    let data_base64 = body.get("dataBase64").and_then(Value::as_str);
    if filename.is_none() || mime_type.is_none() || data_base64.is_none() {
        return json_response(
            400,
            json!({ "ok": false, "error": "filename, mimeType, and dataBase64 are required" }),
        );
    }
    let raw_session_id = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if raw_session_id.is_empty() {
        return json_response(
            400,
            json!({ "ok": false, "error": "sessionId is required" }),
        );
    }
    if !is_valid_session_id(raw_session_id) {
        return json_response(400, json!({ "ok": false, "error": "sessionId is invalid" }));
    }
    if parse_remote_actor(&context.request_headers)
        .as_ref()
        .is_some_and(|actor| {
            actor.role == RemoteActorRole::Guest
                && actor.share_session_id.as_deref() != Some(raw_session_id)
        })
    {
        return json_response(
            403,
            json!({ "ok": false, "error": "shared guest cannot access another session" }),
        );
    }
    let hosted_attachment = hosted_attachment_from_body(body.get("hostedAttachment"));
    match create_uploaded_attachment(
        context,
        CreateUploadedAttachmentInput {
            filename: filename.expect("validated filename"),
            mime_type: mime_type.expect("validated mime type"),
            data_base64: data_base64.expect("validated data"),
            session_id: raw_session_id,
            hosted_attachment,
        },
    ) {
        Ok(attachment) => json_response(200, json!({ "ok": true, "attachment": attachment })),
        Err(error) => json_response(400, json!({ "ok": false, "error": error })),
    }
}

struct CreatePathAttachmentInput<'a> {
    source_path: &'a str,
    filename: Option<&'a str>,
    mime_type: Option<&'a str>,
    session_id: &'a str,
    hosted_attachment: Option<Value>,
}

struct CreateUploadedAttachmentInput<'a> {
    filename: &'a str,
    mime_type: &'a str,
    data_base64: &'a str,
    session_id: &'a str,
    hosted_attachment: Option<Value>,
}

fn create_uploaded_attachment(
    context: &ProjectServiceRequestContext,
    input: CreateUploadedAttachmentInput<'_>,
) -> Result<Value, String> {
    let mime_type = normalize_mime_type(input.mime_type)?;
    let kind = infer_attachment_kind(&mime_type);
    let filename = sanitize_filename(input.filename);
    let buffer = decode_attachment_base64(input.data_base64)?;
    if buffer.is_empty() {
        return Err("attachment content is required".into());
    }
    if buffer.len() > MAX_ATTACHMENT_BYTES {
        return Err("attachment exceeds 10 MB".into());
    }
    let buffer_sha256 = sha256_hex(&buffer);
    let hosted_attachment = match input.hosted_attachment {
        Some(hosted) => Some(normalize_hosted_attachment_reference(
            hosted,
            &buffer_sha256,
            buffer.len() as i64,
        )?),
        None => None,
    };
    let id = next_attachment_id();
    let extension = extension_for_attachment(&mime_type, &filename);
    let attachment_dir = attachments_dir(context.project_root());
    let content_path = attachment_dir.join(format!("{id}{extension}"));
    let sha256 = hosted_attachment
        .as_ref()
        .and_then(|hosted| string_field(hosted, "sha256").map(str::to_owned))
        .unwrap_or(buffer_sha256);
    let mut record = Map::new();
    record.insert("id".into(), Value::String(id.clone()));
    record.insert("kind".into(), Value::String(kind));
    record.insert("filename".into(), Value::String(filename));
    record.insert("mimeType".into(), Value::String(mime_type));
    record.insert("sizeBytes".into(), Value::from(buffer.len() as i64));
    record.insert("sha256".into(), Value::String(sha256));
    record.insert("createdAt".into(), Value::String(now_iso()));
    record.insert("source".into(), Value::String("upload".into()));
    record.insert(
        "contentPath".into(),
        Value::String(content_path.to_string_lossy().into_owned()),
    );
    record.insert(
        "sessionId".into(),
        Value::String(input.session_id.to_owned()),
    );
    if let Some(hosted) = hosted_attachment {
        record.insert("hostedAttachment".into(), hosted);
    }
    let record = Value::Object(record);
    atomic_write(&content_path, &buffer).map_err(|error| error.to_string())?;
    write_json_atomic(attachment_dir.join(format!("{id}.json")), &record)
        .map_err(|error| error.to_string())?;
    remember_published_attachment(context.project_root(), &record);
    Ok(to_public_attachment(record))
}

fn create_path_attachment(
    context: &ProjectServiceRequestContext,
    input: CreatePathAttachmentInput<'_>,
) -> Result<Value, String> {
    let source_path = PathBuf::from(input.source_path);
    let source_real_path = assert_publishable_source(
        &source_path,
        context.project_root(),
        &publishable_roots(context),
    )?;
    let buffer = fs::read(&source_real_path).map_err(|error| error.to_string())?;
    if buffer.is_empty() {
        return Err("attachment content is required".into());
    }
    if buffer.len() > MAX_ATTACHMENT_BYTES {
        return Err("attachment exceeds 10 MB".into());
    }
    let buffer_sha256 = sha256_hex(&buffer);
    let hosted_attachment = match input.hosted_attachment {
        Some(hosted) => Some(normalize_hosted_attachment_reference(
            hosted,
            &buffer_sha256,
            buffer.len() as i64,
        )?),
        None => None,
    };
    let fallback_filename = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment");
    let filename = sanitize_filename(input.filename.unwrap_or(fallback_filename));
    let mime_type = normalize_mime_type(
        input
            .mime_type
            .unwrap_or_else(|| mime_type_from_filename(&filename)),
    )?;
    let kind = infer_attachment_kind(&mime_type);
    let id = next_attachment_id();
    let extension = extension_for_attachment(&mime_type, &filename);
    let attachment_dir = attachments_dir(context.project_root());
    let content_path = attachment_dir.join(format!("{id}{extension}"));
    let sha256 = hosted_attachment
        .as_ref()
        .and_then(|hosted| string_field(hosted, "sha256").map(str::to_owned))
        .unwrap_or(buffer_sha256);
    let mut record = Map::new();
    record.insert("id".into(), Value::String(id.clone()));
    record.insert("kind".into(), Value::String(kind));
    record.insert("filename".into(), Value::String(filename));
    record.insert("mimeType".into(), Value::String(mime_type));
    record.insert("sizeBytes".into(), Value::from(buffer.len() as i64));
    record.insert("sha256".into(), Value::String(sha256));
    record.insert("createdAt".into(), Value::String(now_iso()));
    record.insert("source".into(), Value::String("path".into()));
    record.insert(
        "contentPath".into(),
        Value::String(content_path.to_string_lossy().into_owned()),
    );
    record.insert(
        "sessionId".into(),
        Value::String(input.session_id.to_owned()),
    );
    if let Some(hosted) = hosted_attachment {
        record.insert("hostedAttachment".into(), hosted);
    }
    let record = Value::Object(record);
    atomic_write(&content_path, &buffer).map_err(|error| error.to_string())?;
    write_json_atomic(attachment_dir.join(format!("{id}.json")), &record)
        .map_err(|error| error.to_string())?;
    Ok(to_public_attachment(record))
}

fn assert_publishable_source(
    source_path: &Path,
    project_root: &Path,
    roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let requested_path = if source_path.is_absolute() {
        source_path.to_path_buf()
    } else {
        project_root.join(source_path)
    };
    let metadata = fs::symlink_metadata(&requested_path).map_err(|_| {
        format!(
            "attachment source does not exist: {}",
            requested_path.display()
        )
    })?;
    let source_real_path = fs::canonicalize(&requested_path).map_err(|_| {
        format!(
            "attachment source does not exist: {}",
            requested_path.display()
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err("attachment source must be a regular file".into());
    }
    if is_sensitive_attachment_source(&source_real_path) {
        return Err(format!(
            "attachment source looks like a credential or secret file and cannot be published: {}",
            source_real_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("attachment")
        ));
    }
    if !is_path_under_any_root(&source_real_path, roots) {
        return Err(format!(
            "attachment source must be inside the project, one of its worktrees, or a temporary directory: {}",
            source_real_path.display()
        ));
    }
    Ok(source_real_path)
}

fn publishable_roots(context: &ProjectServiceRequestContext) -> Vec<PathBuf> {
    let mut roots = vec![context.project_root().to_path_buf()];
    let project_state_dir = context.project_state_dir();
    if let Ok(topology) = read_runtime_topology(runtime_topology_path(project_state_dir)) {
        roots.extend(
            topology
                .get("worktrees")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|worktree| string_field(worktree, "path"))
                .map(PathBuf::from),
        );
    }
    roots.push(std::env::temp_dir());
    roots.push(PathBuf::from("/tmp"));
    roots
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
    let record = get_attachment_record(project_root, id, None)?;
    if let Some(session_id) = session_id
        && string_field(&record, "sessionId").is_some_and(|owner| owner != session_id)
    {
        return None;
    }
    Some(record)
}

pub fn get_attachment_record(
    project_root: impl AsRef<Path>,
    id: &str,
    session_id: Option<&str>,
) -> Option<Value> {
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
    if let Some(session_id) = session_id
        && string_field(&parsed, "sessionId") != Some(session_id)
    {
        return None;
    }
    Some(parsed)
}

pub fn list_session_attachments(
    project_root: impl AsRef<Path>,
    session_id: &str,
    limit: Option<usize>,
) -> Vec<Value> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Vec::new();
    }
    let project_root = project_root.as_ref();
    hydrate_session_attachments(project_root, session_id);
    let key = recent_session_key(project_root, session_id);
    recent_published_by_session()
        .lock()
        .expect("recent attachment mutex poisoned")
        .get(&key)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .take(limit.unwrap_or(RECENT_PUBLISHED_PER_SESSION))
        .collect()
}

pub fn anchor_session_attachment(
    project_root: impl AsRef<Path>,
    session_id: &str,
    attachment_id: &str,
    message_id: &str,
) {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return;
    }
    let project_root = project_root.as_ref();
    let key = recent_session_key(project_root, session_id);
    {
        let mut recent = recent_published_by_session()
            .lock()
            .expect("recent attachment mutex poisoned");
        if let Some(entries) = recent.get_mut(&key)
            && let Some(entry) = entries
                .iter_mut()
                .find(|entry| entry["record"]["id"].as_str() == Some(attachment_id))
            && let Value::Object(entry) = entry
        {
            entry.insert(
                "anchorMessageId".into(),
                Value::String(message_id.to_owned()),
            );
        }
    }
    let Some(mut record) = get_attachment_record(project_root, attachment_id, Some(session_id))
    else {
        return;
    };
    if string_field(&record, "source") != Some("path") {
        return;
    }
    if let Value::Object(record_object) = &mut record {
        record_object.insert(
            "anchorMessageId".into(),
            Value::String(message_id.to_owned()),
        );
    }
    let _ = write_json_atomic(
        attachments_dir(project_root).join(format!("{attachment_id}.json")),
        &record,
    );
}

pub fn forget_session_attachments() {
    recent_published_by_session()
        .lock()
        .expect("recent attachment mutex poisoned")
        .clear();
    hydrated_sessions()
        .lock()
        .expect("hydrated attachment mutex poisoned")
        .clear();
}

fn remember_published_attachment(project_root: impl AsRef<Path>, record: &Value) {
    if string_field(record, "source") != Some("path") {
        return;
    }
    let Some(session_id) = string_field(record, "sessionId") else {
        return;
    };
    let Some(record_id) = string_field(record, "id") else {
        return;
    };
    let key = recent_session_key(project_root.as_ref(), session_id);
    let mut recent = recent_published_by_session()
        .lock()
        .expect("recent attachment mutex poisoned");
    let entries = recent.entry(key).or_default();
    entries.retain(|entry| entry["record"]["id"].as_str() != Some(record_id));
    entries.insert(0, json!({ "record": to_public_attachment(record.clone()) }));
    entries.truncate(RECENT_PUBLISHED_PER_SESSION);
}

fn hydrate_session_attachments(project_root: &Path, session_id: &str) {
    let key = recent_session_key(project_root, session_id);
    {
        let mut hydrated = hydrated_sessions()
            .lock()
            .expect("hydrated attachment mutex poisoned");
        if !hydrated.insert(key.clone()) {
            return;
        }
    }
    let attachments_dir = attachments_dir(project_root);
    let Ok(entries) = fs::read_dir(attachments_dir) else {
        return;
    };
    let mut records = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(|record| {
            string_field(record, "source") == Some("path")
                && attachment_belongs_to_session(record, session_id)
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        string_field(right, "createdAt")
            .unwrap_or("")
            .cmp(string_field(left, "createdAt").unwrap_or(""))
    });
    let known_ids = recent_published_by_session()
        .lock()
        .expect("recent attachment mutex poisoned")
        .get(&key)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            entry
                .get("record")
                .and_then(|record| string_field(record, "id"))
                .map(ToOwned::to_owned)
        })
        .collect::<HashSet<_>>();
    let now = unix_epoch_millis_now();
    let hydrated = records
        .into_iter()
        .filter(|record| string_field(record, "id").is_some_and(|id| !known_ids.contains(id)))
        .filter(|record| {
            string_field(record, "anchorMessageId").is_some()
                || string_field(record, "createdAt")
                    .and_then(parse_iso_millis)
                    .is_some_and(|created_at| {
                        now.saturating_sub(created_at) < UNANCHORED_HYDRATE_GRACE_MS
                    })
        })
        .take(RECENT_PUBLISHED_PER_SESSION)
        .map(|record| {
            let mut entry = Map::new();
            entry.insert("record".into(), to_public_attachment(record.clone()));
            if let Some(anchor_message_id) = string_field(&record, "anchorMessageId") {
                entry.insert(
                    "anchorMessageId".into(),
                    Value::String(anchor_message_id.to_owned()),
                );
            }
            Value::Object(entry)
        })
        .collect::<Vec<_>>();
    let mut recent = recent_published_by_session()
        .lock()
        .expect("recent attachment mutex poisoned");
    let entries = recent.entry(key).or_default();
    entries.extend(hydrated);
    entries.truncate(RECENT_PUBLISHED_PER_SESSION);
}

fn attachment_belongs_to_session(record: &Value, session_id: &str) -> bool {
    string_field(record, "sessionId").is_some_and(|owner| owner == session_id)
}

fn recent_session_key(project_root: &Path, session_id: &str) -> String {
    format!("{}\0{session_id}", project_root.to_string_lossy())
}

fn recent_published_by_session() -> &'static Mutex<HashMap<String, Vec<Value>>> {
    RECENT_PUBLISHED_BY_SESSION.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hydrated_sessions() -> &'static Mutex<HashSet<String>> {
    HYDRATED_SESSIONS.get_or_init(|| Mutex::new(HashSet::new()))
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

fn is_valid_session_id(value: &str) -> bool {
    !value.contains("..")
        && (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn decode_attachment_base64(value: &str) -> Result<Vec<u8>, String> {
    let normalized = normalize_base64(value)?;
    let bytes = normalized.as_bytes();
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let a =
            base64_value(chunk[0]).ok_or_else(|| "attachment content must be base64".to_owned())?;
        let b =
            base64_value(chunk[1]).ok_or_else(|| "attachment content must be base64".to_owned())?;
        let c = if chunk[2] == b'=' {
            None
        } else {
            Some(
                base64_value(chunk[2])
                    .ok_or_else(|| "attachment content must be base64".to_owned())?,
            )
        };
        let d = if chunk[3] == b'=' {
            None
        } else {
            Some(
                base64_value(chunk[3])
                    .ok_or_else(|| "attachment content must be base64".to_owned())?,
            )
        };
        if c.is_none() && d.is_some() {
            return Err("attachment content must be base64".into());
        }
        output.push((a << 2) | (b >> 4));
        if let Some(c) = c {
            output.push(((b & 0x0f) << 4) | (c >> 2));
            if let Some(d) = d {
                output.push(((c & 0x03) << 6) | d);
            }
        }
    }
    Ok(output)
}

fn normalize_base64(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let without_prefix = if trimmed.starts_with("data:") {
        match trimmed.find(";base64,") {
            Some(index) => &trimmed[index + ";base64,".len()..],
            None => trimmed,
        }
    } else {
        trimmed
    };
    let normalized = without_prefix
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    if normalized.len() % 4 != 0
        || !normalized
            .bytes()
            .enumerate()
            .all(|(index, byte)| is_base64_payload_byte(byte, index, normalized.len()))
    {
        return Err("attachment content must be base64".into());
    }
    Ok(normalized)
}

fn is_base64_payload_byte(byte: u8, index: usize, len: usize) -> bool {
    base64_value(byte).is_some() || (byte == b'=' && index >= len.saturating_sub(2))
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn sanitize_filename(filename: &str) -> String {
    let safe = filename
        .trim()
        .rsplit(|character| ['/', '\\'].contains(&character))
        .next()
        .unwrap_or("")
        .replace(['/', '\\'], "")
        .trim()
        .to_owned();
    if safe.is_empty() {
        "attachment".into()
    } else {
        safe
    }
}

fn normalize_mime_type(mime_type: &str) -> Result<String, String> {
    let normalized = mime_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let Some((left, right)) = normalized.split_once('/') else {
        return Err("attachment mime type is invalid".into());
    };
    if left.is_empty()
        || right.is_empty()
        || right.contains('/')
        || !normalized.bytes().all(is_mime_byte)
    {
        return Err("attachment mime type is invalid".into());
    }
    if is_active_mime_type(&normalized) {
        return Err("unsupported attachment mime type".into());
    }
    Ok(normalized)
}

fn is_mime_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase()
        || byte.is_ascii_digit()
        || matches!(
            byte,
            b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-' | b'/'
        )
}

fn is_active_mime_type(value: &str) -> bool {
    matches!(
        value,
        "application/javascript"
            | "application/ecmascript"
            | "application/xhtml+xml"
            | "image/svg+xml"
            | "text/ecmascript"
            | "text/html"
            | "text/javascript"
    )
}

fn infer_attachment_kind(mime_type: &str) -> String {
    if mime_type.starts_with("image/") {
        "image"
    } else if mime_type.starts_with("audio/") {
        "audio"
    } else if mime_type.starts_with("video/") {
        "video"
    } else if mime_type == "application/pdf" {
        "pdf"
    } else if mime_type.starts_with("text/") || mime_type == "application/json" {
        "text"
    } else {
        "file"
    }
    .into()
}

fn extension_for_attachment(mime_type: &str, filename: &str) -> String {
    if let Some(extension) = extension_for_mime_type(mime_type) {
        return extension.into();
    }
    let extension = Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .unwrap_or_default();
    if is_safe_extension(&extension) {
        extension
    } else {
        ".bin".into()
    }
}

fn mime_type_from_filename(filename: &str) -> &'static str {
    match Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("aac") => "audio/aac",
        Some("csv") => "text/csv",
        Some("flac") => "audio/flac",
        Some("gif") => "image/gif",
        Some("jpeg") | Some("jpg") => "image/jpeg",
        Some("json") => "application/json",
        Some("m4a") => "audio/m4a",
        Some("mov") => "video/quicktime",
        Some("mp3") => "audio/mpeg",
        Some("mp4") => "video/mp4",
        Some("ogg") => "audio/ogg",
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("txt") => "text/plain",
        Some("wav") => "audio/wav",
        Some("webm") => "audio/webm",
        Some("webp") => "image/webp",
        Some("md") => "text/markdown",
        Some("mjs") | Some("cjs") => "application/javascript",
        Some("html") | Some("htm") => "text/html",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn extension_for_mime_type(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some(".png"),
        "image/jpeg" => Some(".jpg"),
        "image/webp" => Some(".webp"),
        "image/gif" => Some(".gif"),
        "audio/aac" => Some(".aac"),
        "audio/flac" => Some(".flac"),
        "audio/m4a" | "audio/mp4" => Some(".m4a"),
        "audio/mpeg" => Some(".mp3"),
        "audio/ogg" => Some(".ogg"),
        "audio/wav" => Some(".wav"),
        "audio/webm" => Some(".webm"),
        "video/mp4" => Some(".mp4"),
        "video/quicktime" => Some(".mov"),
        "video/webm" => Some(".webm"),
        "application/pdf" => Some(".pdf"),
        "application/json" => Some(".json"),
        "text/csv" => Some(".csv"),
        "text/markdown" => Some(".md"),
        "text/plain" => Some(".txt"),
        _ => None,
    }
}

fn is_safe_extension(extension: &str) -> bool {
    let raw = extension.as_bytes();
    raw.len() >= 2
        && raw.len() <= 13
        && raw[0] == b'.'
        && raw[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn normalize_hosted_attachment_reference(
    hosted: Value,
    expected_sha256: &str,
    expected_size_bytes: i64,
) -> Result<Value, String> {
    let content_url = string_field(&hosted, "contentUrl")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "hosted attachment contentUrl is required".to_owned())?;
    if !is_allowed_hosted_content_url(content_url) {
        return Err("hosted attachment contentUrl must be HTTPS".into());
    }
    let expires_at = string_field(&hosted, "expiresAt")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "hosted attachment expiresAt is invalid".to_owned())?;
    if !looks_like_iso_timestamp(expires_at) {
        return Err("hosted attachment expiresAt is invalid".into());
    }
    if expires_at <= now_iso().as_str() {
        return Err("hosted attachment is expired".into());
    }
    if let Some(sha256) = string_field(&hosted, "sha256")
        && sha256 != expected_sha256
    {
        return Err("hosted attachment checksum mismatch".into());
    }
    if let Some(size_bytes) = hosted.get("sizeBytes").and_then(Value::as_i64)
        && size_bytes != expected_size_bytes
    {
        return Err("hosted attachment size mismatch".into());
    }
    let mut normalized = Map::new();
    normalized.insert("contentUrl".into(), Value::String(content_url.to_owned()));
    normalized.insert("expiresAt".into(), Value::String(expires_at.to_owned()));
    if let Some(sha256) = string_field(&hosted, "sha256") {
        normalized.insert("sha256".into(), Value::String(sha256.to_owned()));
    }
    if let Some(size_bytes) = hosted.get("sizeBytes").and_then(Value::as_i64) {
        normalized.insert("sizeBytes".into(), Value::from(size_bytes));
    }
    Ok(Value::Object(normalized))
}

fn is_allowed_hosted_content_url(value: &str) -> bool {
    value.starts_with("https://")
        || value.starts_with("http://localhost/")
        || value.starts_with("http://localhost:")
}

fn looks_like_iso_timestamp(value: &str) -> bool {
    value.len() >= 20
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && value.ends_with('Z')
}

pub fn is_sensitive_attachment_source(path: &Path) -> bool {
    let sensitive_directories = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".gcloud"];
    if path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        sensitive_directories.contains(&value.as_str())
    }) {
        return true;
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        name.as_str(),
        ".env.dist" | ".env.example" | ".env.sample" | ".env.template"
    ) {
        return false;
    }
    if matches!(
        name.as_str(),
        ".envrc"
            | ".git-credentials"
            | ".netrc"
            | ".npmrc"
            | ".pgpass"
            | ".pypirc"
            | "auth.json"
            | "credentials"
            | "credentials.json"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
            | "id_rsa"
    ) {
        return true;
    }
    if name == ".env" || name.starts_with(".env.") {
        return true;
    }
    matches!(
        Path::new(&name)
            .extension()
            .and_then(|extension| extension.to_str()),
        Some("jks" | "key" | "keystore" | "p12" | "pem" | "pfx")
    )
}

fn is_path_under_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        fs::canonicalize(root)
            .ok()
            .is_some_and(|root| path == root || path.starts_with(root))
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn next_attachment_id() -> String {
    let sequence = ATTACHMENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    format!("att_{}{:x}{:x}", std::process::id(), now, sequence)
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

fn unix_epoch_millis_now() -> u128 {
    time::OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .max(0) as u128
        / 1_000_000
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

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
