use aimux::project_service::plans::{
    plan_authority_dir_for_project_root, plan_authority_path_for_project_root, plans_route_prefix,
    read_plan_content, route_plan_request, validate_plan_session_id, write_plan_content,
};
use serde_json::json;
use std::fs::{read_to_string, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn validates_plan_session_ids_like_typescript() {
    assert_eq!(validate_plan_session_id("codex-1"), Some("codex-1"));
    assert_eq!(validate_plan_session_id("agent_A"), Some("agent_A"));
    assert_eq!(validate_plan_session_id(""), None);
    assert_eq!(validate_plan_session_id("f..oo"), None);
    assert_eq!(validate_plan_session_id("foo/bar"), None);
    assert_eq!(validate_plan_session_id("foo\\bar"), None);
    assert_eq!(validate_plan_session_id("agent.md"), None);
}

#[test]
fn reads_missing_plan_as_none_and_route_404() {
    let project = temp_project("missing");
    let response =
        route_plan_request(&project, "GET", "/plans/missing-session", None).expect("plan route");
    assert_eq!(response.status, 404);
    assert_eq!(
        response.body,
        json!({ "ok": false, "error": "Plan not found" })
    );
    assert_eq!(read_plan_content(&project, "missing-session"), Ok(None));
    cleanup(project);
}

#[test]
fn put_then_get_roundtrip_returns_same_content() {
    let project = temp_project("roundtrip");
    let put = route_plan_request(
        &project,
        "PUT",
        "/plans/session-a",
        Some(&json!({ "content": "# Plan A\n\nFirst draft." })),
    )
    .expect("plan route");
    assert_eq!(put.status, 200);
    assert_eq!(put.body, json!({ "ok": true, "sessionId": "session-a" }));

    let get = route_plan_request(&project, "GET", "/plans/session-a", None).expect("plan route");
    assert_eq!(get.status, 200);
    assert_eq!(
        get.body,
        json!({ "ok": true, "sessionId": "session-a", "content": "# Plan A\n\nFirst draft." })
    );
    cleanup(project);
}

#[test]
fn second_put_overwrites_first_and_empty_content_is_allowed() {
    let project = temp_project("overwrite");
    write_plan_content(&project, "session-b", "first").expect("first write");
    write_plan_content(&project, "session-b", "second").expect("second write");
    assert_eq!(
        read_to_string(plan_authority_path_for_project_root(&project, "session-b").unwrap())
            .unwrap(),
        "second"
    );

    let empty = route_plan_request(
        &project,
        "PUT",
        "/plans/session-c",
        Some(&json!({ "content": "" })),
    )
    .expect("plan route");
    assert_eq!(empty.status, 200);
    assert_eq!(
        read_plan_content(&project, "session-c"),
        Ok(Some(String::new()))
    );
    cleanup(project);
}

#[test]
fn put_rejects_non_string_or_missing_content() {
    let project = temp_project("content");
    for body in [json!({ "content": 42 }), json!({})] {
        let response = route_plan_request(&project, "PUT", "/plans/session-d", Some(&body))
            .expect("plan route");
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "ok": false, "error": "content must be a string" })
        );
    }
    cleanup(project);
}

#[test]
fn rejects_invalid_session_id_variants_after_percent_decode() {
    let project = temp_project("invalid");
    for encoded in ["%66%2E%2E%6F%6F", "%66%6F%6F%2F%62%61%72", "foo%5Cbar"] {
        let get = route_plan_request(&project, "GET", &format!("/plans/{encoded}"), None)
            .expect("plan route");
        assert_eq!(get.status, 400);
        assert_eq!(
            get.body,
            json!({ "ok": false, "error": "invalid sessionId" })
        );

        let put = route_plan_request(
            &project,
            "PUT",
            &format!("/plans/{encoded}"),
            Some(&json!({ "content": "x" })),
        )
        .expect("plan route");
        assert_eq!(put.status, 400);
        assert_eq!(
            put.body,
            json!({ "ok": false, "error": "invalid sessionId" })
        );
    }
    cleanup(project);
}

#[test]
fn creates_parent_dir_when_missing_and_ignores_exact_plans_route() {
    let project = temp_project("mkdir");
    let plans_dir = plan_authority_dir_for_project_root(&project);
    let _ = remove_dir_all(&plans_dir);
    assert!(!plans_dir.exists());
    write_plan_content(&project, "session-f", "hello").expect("write creates parent");
    assert_eq!(
        read_to_string(plans_dir.join("session-f.md")).unwrap(),
        "hello"
    );
    assert!(route_plan_request(&project, "GET", plans_route_prefix(), None).is_none());
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-plans-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
