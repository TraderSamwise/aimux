use aimux::project_service::attachments::{attachments_dir, get_attachment};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn reads_attachment_metadata_and_content_bytes() {
    let project = temp_project("read");
    let content_path = seed_attachment(&project, "att_1", Some("codex-1"));
    let context = ProjectServiceRequestContext::new(&project);

    let metadata = route_project_service_request(&context, "GET", "/attachments/att_1", None);
    assert_eq!(metadata.status, 200);
    assert_eq!(metadata.body["ok"], true);
    assert_eq!(metadata.body["attachment"]["id"], "att_1");
    assert_eq!(metadata.body["attachment"]["kind"], "text");
    assert_eq!(metadata.body["attachment"]["filename"], "notes.txt");
    assert_eq!(metadata.body["attachment"]["mimeType"], "text/plain");
    assert_eq!(metadata.body["attachment"]["sizeBytes"], 11);
    assert_eq!(metadata.body["attachment"]["sha256"], "abc123");
    assert_eq!(
        metadata.body["attachment"]["createdAt"],
        "2026-05-25T00:00:00.000Z"
    );
    assert_eq!(metadata.body["attachment"]["source"], "upload");
    assert_eq!(
        metadata.body["attachment"]["contentUrl"],
        "/attachments/att_1/content?sessionId=codex-1"
    );
    assert_eq!(metadata.body["attachment"]["sessionId"], "codex-1");

    let content = route_project_service_request(
        &context,
        "GET",
        "/attachments/att_1/content?sessionId=codex-1",
        None,
    );
    assert_eq!(content.status, 200);
    assert_eq!(content.bytes, Some(b"hello world".to_vec()));
    assert_eq!(content.content_type, Some("text/plain".to_owned()));
    assert!(content_path.exists());
    cleanup(project);
}

#[test]
fn session_query_refuses_other_owned_record_but_allows_unowned_legacy_record() {
    let project = temp_project("session");
    seed_attachment(&project, "att_owned", Some("codex-1"));
    seed_attachment(&project, "att_legacy", None);

    let context = ProjectServiceRequestContext::new(&project);
    let other = route_project_service_request(
        &context,
        "GET",
        "/attachments/att_owned/content?sessionId=codex-2",
        None,
    );
    assert_eq!(other.status, 404);
    assert_eq!(other.body["error"], "attachment not found");

    let legacy = route_project_service_request(
        &context,
        "GET",
        "/attachments/att_legacy/content?sessionId=codex-2",
        None,
    );
    assert_eq!(legacy.status, 200);
    assert_eq!(legacy.bytes, Some(b"hello world".to_vec()));
    let public = get_attachment(&project, "att_legacy", Some("codex-2")).expect("legacy public");
    assert_eq!(public["contentUrl"], "/attachments/att_legacy/content");
    cleanup(project);
}

#[test]
fn validates_blank_session_and_missing_attachments_like_node_route() {
    let project = temp_project("errors");
    let context = ProjectServiceRequestContext::new(&project);

    let blank =
        route_project_service_request(&context, "GET", "/attachments/att_1?sessionId=", None);
    assert_eq!(blank.status, 400);
    assert_eq!(blank.body["error"], "sessionId is invalid");

    let missing =
        route_project_service_request(&context, "GET", "/attachments/att_1/content", None);
    assert_eq!(missing.status, 404);
    assert_eq!(missing.body["error"], "attachment not found");
    cleanup(project);
}

#[test]
fn shared_guest_can_read_own_content_but_not_metadata_or_other_session() {
    let project = temp_project("guest");
    seed_attachment(&project, "att_1", Some("codex-1"));
    let context = ProjectServiceRequestContext::new(&project).with_request_headers([
        ("x-aimux-actor-role", "guest"),
        ("x-aimux-share-id", "share-1"),
        ("x-aimux-share-session-id", "codex-1"),
    ]);

    let own = route_project_service_request(
        &context,
        "GET",
        "/attachments/att_1/content?sessionId=codex-1",
        None,
    );
    assert_eq!(own.status, 200);
    assert_eq!(own.bytes, Some(b"hello world".to_vec()));

    let metadata = route_project_service_request(
        &context,
        "GET",
        "/attachments/att_1?sessionId=codex-1",
        None,
    );
    assert_eq!(metadata.status, 403);
    assert_eq!(
        metadata.body["error"],
        "shared guests cannot read attachment metadata"
    );

    let other = route_project_service_request(
        &context,
        "GET",
        "/attachments/att_1/content?sessionId=codex-2",
        None,
    );
    assert_eq!(other.status, 403);
    assert_eq!(
        other.body["error"],
        "shared guest cannot access another session"
    );
    cleanup(project);
}

fn seed_attachment(project: &Path, id: &str, session_id: Option<&str>) -> PathBuf {
    let dir = attachments_dir(project);
    create_dir_all(&dir).expect("attachments dir");
    let content_path = dir.join(format!("{id}.txt"));
    write(&content_path, b"hello world").expect("content");
    let mut record = json!({
        "id": id,
        "kind": "text",
        "filename": "notes.txt",
        "mimeType": "text/plain",
        "sizeBytes": 11,
        "sha256": "abc123",
        "createdAt": "2026-05-25T00:00:00.000Z",
        "source": "upload",
        "contentPath": content_path,
    });
    if let Some(session_id) = session_id {
        record["sessionId"] = json!(session_id);
    }
    write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec(&record).unwrap(),
    )
    .expect("record");
    content_path
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-attachments-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    create_dir_all(&path).expect("project dir");
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
