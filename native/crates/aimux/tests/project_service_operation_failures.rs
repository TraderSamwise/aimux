use aimux::project_api_contract::routes;
use aimux::project_service::operation_failures::{
    OperationFailureInput, OperationFailureMatch, WorktreePathMatch,
    clear_dashboard_operation_failures, dashboard_operation_failures_path,
    try_add_dashboard_operation_failure,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn clears_matching_failures_and_leaves_others_active() {
    let project = temp_project("clear");
    let state_dir = project.join("state");
    seed_failures(&state_dir);

    let cleared = clear_dashboard_operation_failures(
        &state_dir,
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("create".into()),
            target_id: None,
            worktree_path: WorktreePathMatch::Exact("/repo/.aimux/worktrees/demo".into()),
        },
    );
    assert_eq!(cleared, 1);

    let state: serde_json::Value = serde_json::from_str(
        &read_to_string(dashboard_operation_failures_path(&state_dir)).unwrap(),
    )
    .unwrap();
    assert_eq!(state["failures"][0]["cleared"], true);
    assert!(state["failures"][1]["cleared"].is_null());
    assert!(state["failures"][2]["cleared"].is_null());
    cleanup(project);
}

#[test]
fn can_clear_only_main_checkout_failures() {
    let project = temp_project("main");
    let state_dir = project.join("state");
    seed_failures(&state_dir);

    let cleared = clear_dashboard_operation_failures(
        &state_dir,
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("create".into()),
            target_id: None,
            worktree_path: WorktreePathMatch::OnlyMissing,
        },
    );
    assert_eq!(cleared, 1);
    let state: serde_json::Value = serde_json::from_str(
        &read_to_string(dashboard_operation_failures_path(&state_dir)).unwrap(),
    )
    .unwrap();
    assert_eq!(state["failures"][1]["cleared"], true);
    assert!(state["failures"][0]["cleared"].is_null());
    cleanup(project);
}

#[test]
fn route_clears_failures_and_returns_count() {
    let project = temp_project("route");
    let state_dir = project.join("state");
    seed_failures(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::OPERATION_FAILURES_CLEAR,
        Some(&json!({
            "targetKind": "agent",
            "operation": "create",
            "worktreePath": "/repo/.aimux/worktrees/demo"
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true, "cleared": 1 }));
    cleanup(project);
}

#[test]
fn adding_failure_reports_persist_error() {
    let project = temp_project("persist-error");
    create_dir_all(&project).expect("project dir");
    let state_dir = project.join("state-file");
    write(&state_dir, "not a directory").expect("state marker");

    let result = try_add_dashboard_operation_failure(
        &state_dir,
        OperationFailureInput {
            target_kind: "agent".into(),
            operation: "agent.stop".into(),
            title: "Lifecycle response abandoned".into(),
            message: "caller disconnected".into(),
            target_id: Some("codex-live".into()),
            ..OperationFailureInput::default()
        },
    );

    let (error, failure) = result.expect_err("persist error");
    assert!(
        error.kind() == std::io::ErrorKind::AlreadyExists
            || error.kind() == std::io::ErrorKind::NotADirectory
    );
    assert_eq!(failure["operation"], "agent.stop");
    assert_eq!(failure["targetId"], "codex-live");
    assert!(
        !dashboard_operation_failures_path(&state_dir).exists(),
        "failed persistence must not fabricate a stored failure record"
    );
    cleanup(project);
}

fn seed_failures(state_dir: &PathBuf) {
    create_dir_all(state_dir).expect("state dir");
    write(
        dashboard_operation_failures_path(state_dir),
        json!({
            "version": 1,
            "failures": [
                {
                    "id": "failure-worktree",
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Failed to create codex agent",
                    "message": "in a worktree",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "worktreePath": "/repo/.aimux/worktrees/demo"
                },
                {
                    "id": "failure-main",
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Failed to create codex agent",
                    "message": "main checkout",
                    "createdAt": "2026-01-01T00:00:00.000Z"
                },
                {
                    "id": "failure-service",
                    "targetKind": "service",
                    "operation": "create",
                    "title": "Failed to create service",
                    "message": "port busy",
                    "createdAt": "2026-01-01T00:00:00.000Z"
                },
                {
                    "id": "failure-cleared",
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Already cleared",
                    "message": "done",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "worktreePath": "/repo/.aimux/worktrees/demo",
                    "cleared": true
                }
            ]
        })
        .to_string(),
    )
    .expect("seed failures");
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-operation-failures-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
