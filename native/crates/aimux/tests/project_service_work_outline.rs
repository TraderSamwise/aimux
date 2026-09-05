use aimux::project_api_contract::routes;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::work_outline::{
    WorkOutlineQuery, WorkOutlineStatus, list_work_outline_entries, read_work_outline_state,
    update_work_outline_entry, work_outline_path,
};
use serde_json::json;
use std::fs::{read_to_string, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn update_normalizes_and_reuses_topic_worktree_identity() {
    let project = temp_project("update");
    let state_dir = project.join("state");
    let first = update_work_outline_entry(
        &state_dir,
        &json!({
            "topicKey": "  Build   System ",
            "title": "  Build   System ",
            "summary": " first   pass ",
            "status": "done",
            "source": "scribe",
            "sessionId": "codex-2",
            "sessionIds": ["codex-1", "codex-2"],
            "worktreePath": "/repo/wt",
            "evidence": { "source": "log", "startLine": 7, "endLine": -1, "capturedAt": "now" }
        }),
        Some("2026-01-01T00:00:00.000Z"),
    )
    .expect("first outline entry");

    let second = update_work_outline_entry(
        &state_dir,
        &json!({
            "topicKey": "build system",
            "title": "Build system",
            "summary": "second pass",
            "sessionId": "codex-3",
            "worktreePath": "/repo/wt"
        }),
        Some("2026-01-01T00:00:01.000Z"),
    )
    .expect("second outline entry");

    assert_eq!(second.entry_id, first.entry_id);
    assert_eq!(second.topic_key, "build system");
    assert_eq!(second.summary, "second pass");
    assert_eq!(second.status, WorkOutlineStatus::Active);
    assert_eq!(second.session_ids, vec!["codex-1", "codex-2", "codex-3"]);
    assert_eq!(second.evidence, first.evidence);
    assert_eq!(second.created_at, "2026-01-01T00:00:00.000Z");
    assert_eq!(second.updated_at, "2026-01-01T00:00:01.000Z");
    assert!(
        read_to_string(work_outline_path(&state_dir))
            .expect("outline file")
            .contains("second pass")
    );
    cleanup(project);
}

#[test]
fn list_filters_search_status_session_worktree_and_limit() {
    let project = temp_project("list");
    let state_dir = project.join("state");
    for (topic, title, status, session, worktree, ts) in [
        (
            "alpha",
            "Alpha feature",
            "active",
            "codex-1",
            "/repo/a",
            "2026-01-01T00:00:01.000Z",
        ),
        (
            "beta",
            "Beta fix",
            "done",
            "codex-2",
            "/repo/b",
            "2026-01-01T00:00:03.000Z",
        ),
        (
            "gamma",
            "Gamma polish",
            "active",
            "codex-1",
            "/repo/a",
            "2026-01-01T00:00:02.000Z",
        ),
    ] {
        update_work_outline_entry(
            &state_dir,
            &json!({
                "topicKey": topic,
                "title": title,
                "summary": format!("{title} summary"),
                "status": status,
                "sessionId": session,
                "worktreePath": worktree
            }),
            Some(ts),
        )
        .expect("outline entry");
    }

    let entries = list_work_outline_entries(
        &state_dir,
        WorkOutlineQuery {
            q: Some("summary".into()),
            session_id: Some("codex-1".into()),
            worktree_path: Some("/repo/a".into()),
            status: Some(WorkOutlineStatus::Active),
            limit: Some(1),
        },
    );
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].topic_key, "gamma");
    cleanup(project);
}

#[test]
fn corrupt_state_is_quarantined_and_empty() {
    let project = temp_project("corrupt");
    let state_dir = project.join("state");
    std::fs::create_dir_all(&state_dir).expect("state dir");
    write(work_outline_path(&state_dir), "{").expect("corrupt file");

    let state = read_work_outline_state(&state_dir);
    assert!(state.entries.is_empty());
    let quarantined = std::fs::read_dir(&state_dir)
        .expect("state dir")
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"));
    assert!(quarantined);
    cleanup(project);
}

#[test]
fn routes_match_work_outline_response_shapes() {
    let project = temp_project("routes");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let invalid = route_project_service_request(
        &context,
        "POST",
        routes::work_outline::UPDATE,
        Some(&json!({ "title": "Only title" })),
    );
    assert_eq!(invalid.status, 400);
    assert_eq!(
        invalid.body,
        json!({ "ok": false, "error": "summary is required" })
    );

    let updated = route_project_service_request(
        &context,
        "POST",
        routes::work_outline::UPDATE,
        Some(&json!({ "title": "Route topic", "summary": "via route", "sessionId": "agent-1" })),
    );
    assert_eq!(updated.status, 200);
    let entry_id = updated.body["entry"]["entryId"]
        .as_str()
        .expect("entry id")
        .to_owned();

    let listed = route_project_service_request(
        &context,
        "GET",
        "/work-outline?q=route&sessionId=agent-1&limit=5",
        None,
    );
    assert_eq!(listed.status, 200);
    assert_eq!(listed.body["entries"].as_array().expect("entries").len(), 1);

    let fetched = route_project_service_request(
        &context,
        "GET",
        &format!("/work-outline?entryId={entry_id}"),
        None,
    );
    assert_eq!(fetched.status, 200);
    assert_eq!(fetched.body["entry"]["entryId"], entry_id);

    let bad_limit = route_project_service_request(&context, "GET", "/work-outline?limit=0", None);
    assert_eq!(bad_limit.status, 400);
    assert_eq!(bad_limit.body["error"], "limit must be an integer >= 1");
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-work-outline-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
