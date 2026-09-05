use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::atomic_write::{atomic_write, write_json_atomic};
use crate::project_api_contract::routes;
use crate::remote_access::{RemoteActorRole, parse_remote_actor};
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
static ATTACHMENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

struct CreatePathAttachmentInput<'a> {
    source_path: &'a str,
    filename: Option<&'a str>,
    mime_type: Option<&'a str>,
    session_id: &'a str,
    hosted_attachment: Option<Value>,
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

fn hosted_attachment_from_body(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let content_url = object.get("contentUrl")?.as_str()?;
    let expires_at = object.get("expiresAt")?.as_str()?;
    let mut hosted = Map::new();
    hosted.insert("contentUrl".into(), Value::String(content_url.to_owned()));
    hosted.insert("expiresAt".into(), Value::String(expires_at.to_owned()));
    if let Some(sha256) = object.get("sha256").and_then(Value::as_str) {
        hosted.insert("sha256".into(), Value::String(sha256.to_owned()));
    }
    if let Some(size_bytes) = object.get("sizeBytes").and_then(Value::as_i64) {
        hosted.insert("sizeBytes".into(), Value::from(size_bytes));
    }
    Some(Value::Object(hosted))
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

fn is_sensitive_attachment_source(path: &Path) -> bool {
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

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
