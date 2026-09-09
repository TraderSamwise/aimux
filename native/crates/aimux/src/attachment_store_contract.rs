use std::collections::BTreeMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use crate::project_api_contract::routes;
use crate::project_service::attachments::{
    anchor_session_attachment, forget_session_attachments, get_attachment_content,
    get_attachment_record, is_sensitive_attachment_source, list_session_attachments,
};
use crate::project_service::router::{ProjectServiceRequestContext, route_project_service_request};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn attachment_store_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "createPathAttachment" => create_path_contract(case),
        "createUploadedAttachment" => create_uploaded_contract(case),
        "assertPublishableSource" => assert_publishable_contract(case),
        "listSessionAttachments" => list_session_attachments_contract(case),
        "anchorSessionAttachment/listSessionAttachments" => {
            anchor_session_attachments_contract(case)
        }
        "isSensitiveAttachmentSource" => Value::Bool(is_sensitive_attachment_source(Path::new(
            case["input"]["sourcePath"].as_str().unwrap_or_default(),
        ))),
        api => json!({ "error": format!("unimplemented attachment-store api: {api}") }),
    }
}

pub fn attachment_store_contract_is_supported(case: &Value) -> bool {
    matches!(
        case["api"].as_str().unwrap_or_default(),
        "createPathAttachment"
            | "createUploadedAttachment"
            | "assertPublishableSource"
            | "listSessionAttachments"
            | "anchorSessionAttachment/listSessionAttachments"
            | "isSensitiveAttachmentSource"
    )
}

fn create_path_contract(case: &Value) -> Value {
    with_temp_project("attachment-store", |project, roots| {
        let context = ProjectServiceRequestContext::new(&project);
        let input = &case["input"];
        let (source_path, extra_root) = source_file_for_path_case(&project, case);
        let mut roots = roots;
        if let Some((label, root)) = extra_root {
            roots.insert(label, root);
        }
        let body = if let Some(hosted) = input.get("hostedAttachment") {
            json!({ "path": source_path, "sessionId": "codex-1", "hostedAttachment": hosted })
        } else {
            json!({ "path": source_path, "sessionId": "codex-1" })
        };
        let response = route_project_service_request(
            &context,
            "POST",
            routes::ATTACHMENTS_PUBLISH,
            Some(&body),
        );
        if response.status != 200 {
            return normalize_value(
                json!({ "ok": false, "error": response.body["error"] }),
                &roots,
            );
        }
        let attachment = response.body["attachment"].clone();
        let Some(attachment_id) = attachment.get("id").and_then(Value::as_str) else {
            return normalize_value(
                json!({ "ok": false, "error": "missing attachment id" }),
                &roots,
            );
        };
        if input.get("sourcePath").is_some() {
            return normalize_value(json!({ "ok": true, "value": attachment }), &roots);
        }
        let stored = attachment_snapshot(&project, attachment_id, "codex-1");
        normalize_value(
            json!({ "attachment": attachment, "stored": stored }),
            &roots,
        )
    })
}

fn create_uploaded_contract(case: &Value) -> Value {
    with_temp_project("attachment-store", |project, roots| {
        let context = ProjectServiceRequestContext::new(&project);
        let hosted = case["input"].get("hostedAttachment").cloned().unwrap_or_else(|| {
            json!({
                "contentUrl": "https://relay.aimux.app/attachments/hosted/ha_1234567890123456789012345678901234567890123/content",
                "expiresAt": "2099-01-01T00:00:00.000Z",
                "sha256": "ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56",
                "sizeBytes": 9
            })
        });
        let data = if case["name"]
            .as_str()
            .is_some_and(|name| name.starts_with("rejects uploaded hosted"))
        {
            "b3RoZXI="
        } else {
            "cG5nLWJ5dGVz"
        };
        let response = route_project_service_request(
            &context,
            "POST",
            routes::ATTACHMENTS,
            Some(&json!({
                "filename": "screen.png",
                "mimeType": "image/png",
                "dataBase64": data,
                "sessionId": "codex-1",
                "hostedAttachment": hosted,
            })),
        );
        if response.status != 200 {
            return normalize_value(
                json!({ "ok": false, "error": response.body["error"] }),
                &roots,
            );
        }
        let attachment = response.body["attachment"].clone();
        let Some(attachment_id) = attachment.get("id").and_then(Value::as_str) else {
            return normalize_value(
                json!({ "ok": false, "error": "missing attachment id" }),
                &roots,
            );
        };
        let stored = attachment_snapshot(&project, attachment_id, "codex-1");
        normalize_value(
            json!({ "attachment": attachment, "stored": stored }),
            &roots,
        )
    })
}

fn assert_publishable_contract(case: &Value) -> Value {
    with_temp_project("publishable", |project, mut roots| {
        let source = case["input"]["sourcePath"].as_str().unwrap_or_default();
        let source_path = if let Some(file) = source.strip_prefix("<scratch>/") {
            let scratch = temp_dir("publishable-scratch");
            let path = scratch.join(file);
            let bytes = if file == "deploy.pem" {
                b"-----BEGIN PRIVATE KEY-----".as_slice()
            } else {
                b"png".as_slice()
            };
            fs::write(&path, bytes).expect("write scratch source");
            roots.insert("scratch".into(), scratch);
            path
        } else {
            PathBuf::from(source)
        };
        let project_root = case["input"]["projectRoot"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or(project);
        let result = assert_publishable_source_for_contract(&source_path, &project_root);
        normalize_value(
            match result {
                Ok(path) => json!({ "ok": true, "value": path.to_string_lossy() }),
                Err(error) => json!({ "ok": false, "error": error }),
            },
            &roots,
        )
    })
}

fn list_session_attachments_contract(case: &Value) -> Value {
    with_temp_project("recent-attachments", |project, roots| {
        let context = ProjectServiceRequestContext::new(&project);
        let session_id = case["input"]["sessionId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        match case["id"].as_str().unwrap_or_default() {
            "attachment-store-028" => {
                for name in ["one.txt", "two.txt"] {
                    let source_path = project.join(name);
                    fs::write(&source_path, name).expect("write recent source");
                    publish_path_attachment(&context, &source_path, "codex-1");
                }
            }
            "attachment-store-029" => {
                let source_path = project.join("mine.txt");
                fs::write(&source_path, "mine").expect("write mine source");
                publish_path_attachment(&context, &source_path, "codex-1");
            }
            "attachment-store-030" => {
                upload_attachment(
                    &context,
                    "screenshot.png",
                    "image/png",
                    "cG5nLWJ5dGVz",
                    "codex-1",
                );
            }
            "attachment-store-031" => {
                let source_path = project.join("earlier.txt");
                fs::write(&source_path, "earlier").expect("write earlier source");
                publish_path_attachment(&context, &source_path, "codex-1");
                forget_session_attachments();
            }
            "attachment-store-033" => {
                let source_path = project.join("old-chart.png");
                fs::write(&source_path, "png").expect("write old chart source");
                let attachment = publish_path_attachment(&context, &source_path, "codex-1");
                let attachment_id = attachment["id"].as_str().expect("attachment id");
                let mut record = get_attachment_record(&project, attachment_id, Some("codex-1"))
                    .expect("record");
                let old = old_iso_timestamp();
                if let Value::Object(record) = &mut record {
                    record.insert("createdAt".into(), Value::String(old));
                    record.remove("anchorMessageId");
                }
                fs::write(
                    project
                        .join(".aimux")
                        .join("attachments")
                        .join(format!("{attachment_id}.json")),
                    format!(
                        "{}\n",
                        serde_json::to_string_pretty(&record).expect("serialize old record")
                    ),
                )
                .expect("write old record");
                forget_session_attachments();
            }
            _ => {}
        }
        normalize_value(
            Value::Array(list_session_attachments(&project, &session_id, None)),
            &roots,
        )
    })
}

fn anchor_session_attachments_contract(_case: &Value) -> Value {
    with_temp_project("hydrate-attachments", |project, roots| {
        let context = ProjectServiceRequestContext::new(&project);
        let source_path = project.join("chart.png");
        fs::write(&source_path, "png").expect("write chart source");
        let attachment = publish_path_attachment(&context, &source_path, "codex-1");
        let attachment_id = attachment["id"].as_str().expect("attachment id").to_owned();
        anchor_session_attachment(
            &project,
            "codex-1",
            &attachment_id,
            "assistant:published-turn",
        );
        let anchored = get_attachment_record(&project, &attachment_id, Some("codex-1"));
        forget_session_attachments();
        normalize_value(
            json!({
                "anchored": anchored,
                "listed": list_session_attachments(&project, "codex-1", None),
            }),
            &roots,
        )
    })
}

fn publish_path_attachment(
    context: &ProjectServiceRequestContext,
    source_path: &Path,
    session_id: &str,
) -> Value {
    let response = route_project_service_request(
        context,
        "POST",
        routes::ATTACHMENTS_PUBLISH,
        Some(&json!({
            "path": source_path,
            "sessionId": session_id,
        })),
    );
    assert_eq!(response.status, 200, "path attachment publish failed");
    response.body["attachment"].clone()
}

fn upload_attachment(
    context: &ProjectServiceRequestContext,
    filename: &str,
    mime_type: &str,
    data_base64: &str,
    session_id: &str,
) -> Value {
    let response = route_project_service_request(
        context,
        "POST",
        routes::ATTACHMENTS,
        Some(&json!({
            "filename": filename,
            "mimeType": mime_type,
            "dataBase64": data_base64,
            "sessionId": session_id,
        })),
    );
    assert_eq!(response.status, 200, "attachment upload failed");
    response.body["attachment"].clone()
}

fn source_file_for_path_case(project: &Path, case: &Value) -> (PathBuf, Option<(String, PathBuf)>) {
    let input = &case["input"];
    if input["sourcePath"].as_str() == Some("/etc/hosts") {
        return (PathBuf::from("/etc/hosts"), None);
    }
    if input["sourcePath"]
        .as_str()
        .is_some_and(|path| path.starts_with("<temp>/"))
    {
        let scratch = temp_dir("agent-scratch");
        let path = scratch.join("generated.txt");
        fs::write(&path, b"generated by the agent").expect("write scratch");
        return (path, Some(("scratch".into(), scratch)));
    }
    if let Some(file) = input["file"].as_str() {
        if file == ".ssh/known_hosts" {
            let path = project.join(".ssh").join("known_hosts");
            fs::create_dir_all(path.parent().expect("ssh parent")).expect("mkdir ssh");
            fs::write(&path, b"not really a key, but the directory is off limits")
                .expect("write known hosts");
            return (path, None);
        }
        if file == "secret-link.txt" {
            return symlink_source(project);
        }
        let path = project.join(file);
        let bytes = if file == "screen.png" {
            b"png-bytes".as_slice()
        } else if file == "notes.txt" {
            b"hello attachment".as_slice()
        } else {
            b"secret".as_slice()
        };
        fs::write(&path, bytes).expect("write project source");
        return (path, None);
    }
    let path = project.join("notes.txt");
    fs::write(&path, b"hello attachment").expect("write default source");
    (path, None)
}

#[cfg(unix)]
fn symlink_source(project: &Path) -> (PathBuf, Option<(String, PathBuf)>) {
    let outside = temp_dir("attachment-outside");
    let outside_path = outside.join("secret.txt");
    fs::write(&outside_path, b"nope").expect("write outside");
    let link = project.join("secret-link.txt");
    symlink(&outside_path, &link).expect("symlink outside");
    (link, Some(("outside".into(), outside)))
}

#[cfg(not(unix))]
fn symlink_source(project: &Path) -> (PathBuf, Option<(String, PathBuf)>) {
    let link = project.join("secret-link.txt");
    fs::create_dir(&link).expect("mkdir stand-in");
    (link, None)
}

fn assert_publishable_source_for_contract(
    source_path: &Path,
    project_root: &Path,
) -> Result<PathBuf, String> {
    let requested = if source_path.is_absolute() {
        source_path.to_path_buf()
    } else {
        project_root.join(source_path)
    };
    let metadata = fs::symlink_metadata(&requested)
        .map_err(|_| format!("attachment source does not exist: {}", requested.display()))?;
    let real = fs::canonicalize(&requested)
        .map_err(|_| format!("attachment source does not exist: {}", requested.display()))?;
    if !metadata.file_type().is_file() {
        return Err("attachment source must be a regular file".into());
    }
    if is_sensitive_attachment_source(&real) {
        return Err(format!(
            "attachment source looks like a credential or secret file and cannot be published: {}",
            real.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("attachment")
        ));
    }
    let roots = [
        project_root.to_path_buf(),
        std::env::temp_dir(),
        PathBuf::from("/tmp"),
    ];
    if !roots.iter().any(|root| {
        fs::canonicalize(root)
            .ok()
            .is_some_and(|root| real == root || real.starts_with(root))
    }) {
        return Err(format!(
            "attachment source must be inside the project, one of its worktrees, or a temporary directory: {}",
            real.display()
        ));
    }
    Ok(real)
}

fn attachment_snapshot(project: &Path, attachment_id: &str, session_id: &str) -> Value {
    let content = get_attachment_content(project, attachment_id, Some(session_id));
    json!({
        "record": get_attachment_record(project, attachment_id, Some(session_id)),
        "contentUtf8": content
            .as_ref()
            .and_then(|content| String::from_utf8(content.buffer.clone()).ok()),
        "contentMimeType": Value::Null,
    })
}

fn with_temp_project(
    label: &str,
    run: impl FnOnce(PathBuf, BTreeMap<String, PathBuf>) -> Value,
) -> Value {
    let project = temp_dir(label);
    fs::create_dir_all(project.join(".git")).expect("mkdir git");
    let mut roots = BTreeMap::new();
    roots.insert("project".into(), project.clone());
    roots.insert("temp".into(), std::env::temp_dir());
    let output = run(project.clone(), roots);
    let _ = fs::remove_dir_all(project);
    output
}

fn normalize_value(value: Value, roots: &BTreeMap<String, PathBuf>) -> Value {
    let mut ids = Vec::<String>::new();
    normalize_value_inner(value, roots, &mut ids)
}

fn normalize_value_inner(
    value: Value,
    roots: &BTreeMap<String, PathBuf>,
    ids: &mut Vec<String>,
) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_value_inner(item, roots, ids))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let value = if key == "createdAt" {
                        Value::String("<createdAt>".into())
                    } else {
                        normalize_value_inner(value, roots, ids)
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::String(text) => Value::String(normalize_string(&text, roots, ids)),
        value => value,
    }
}

fn normalize_string(
    text: &str,
    roots: &BTreeMap<String, PathBuf>,
    ids: &mut Vec<String>,
) -> String {
    let mut output = text.to_owned();
    for (label, root) in roots {
        output = output.replace(&root.to_string_lossy().to_string(), &format!("<{label}>"));
    }
    let mut normalized = String::new();
    let mut rest = output.as_str();
    while let Some(index) = rest.find("att_") {
        normalized.push_str(&rest[..index]);
        let suffix = &rest[index..];
        let end = suffix
            .char_indices()
            .find_map(|(offset, character)| {
                (offset > 4
                    && !(character.is_ascii_alphanumeric() || character == '_' || character == '-'))
                    .then_some(offset)
            })
            .unwrap_or(suffix.len());
        let raw_id = &suffix[..end];
        let position = ids.iter().position(|id| id == raw_id).unwrap_or_else(|| {
            ids.push(raw_id.to_owned());
            ids.len() - 1
        });
        normalized.push_str(&format!("<att:{}>", position + 1));
        rest = &suffix[end..];
    }
    normalized.push_str(rest);
    normalized
}

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-{label}-fixture-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("mkdir temp");
    path
}

fn old_iso_timestamp() -> String {
    let now = time::OffsetDateTime::now_utc() - time::Duration::minutes(5);
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
