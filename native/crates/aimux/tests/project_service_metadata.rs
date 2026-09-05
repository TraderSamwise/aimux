use aimux::daemon_state::{load_metadata_state, metadata_state_path};
use aimux::project_api_contract::routes;
use aimux::project_service::metadata::{route_runtime_metadata_request, update_session_metadata};
use aimux::project_service::router::ProjectServiceRequestContext;
use serde_json::json;
use std::fs::{read_to_string, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn update_session_metadata_skips_write_when_payload_is_stable() {
    let project = temp_project("stable");
    let state_dir = project.join("state");
    let first = update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert("status".into(), json!({ "text": "idle" }));
        json!(object)
    })
    .expect("first update");
    assert!(first.changed);
    let first_file = read_to_string(metadata_state_path(&state_dir)).expect("metadata file");

    let second = update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert("status".into(), json!({ "text": "idle" }));
        json!(object)
    })
    .expect("second update");
    assert!(!second.changed);
    assert_eq!(
        read_to_string(metadata_state_path(&state_dir)).expect("metadata file"),
        first_file
    );
    cleanup(project);
}

#[test]
fn runtime_routes_write_status_progress_context_services_and_logs() {
    let project = temp_project("routes");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    for (route, body) in [
        (
            routes::runtime::SET_STATUS,
            json!({ "session": "codex-1", "text": "ready", "tone": "ok" }),
        ),
        (
            routes::runtime::SET_PROGRESS,
            json!({ "session": "codex-1", "current": 2, "total": 5, "label": "tests" }),
        ),
        (
            routes::runtime::SET_CONTEXT,
            json!({ "session": "codex-1", "context": { "cwd": "/repo", "pr": { "number": 7 } } }),
        ),
        (
            routes::runtime::SET_CONTEXT,
            json!({ "session": "codex-1", "context": { "branch": "feature", "pr": { "title": "Port" } } }),
        ),
        (
            routes::runtime::SET_SERVICES,
            json!({ "session": "codex-1", "services": [{ "label": "web", "port": 3000 }] }),
        ),
        (
            routes::runtime::LOG,
            json!({ "session": "codex-1", "message": "one", "source": "test", "tone": "info" }),
        ),
    ] {
        let response = route_runtime_metadata_request(&context, "POST", route, Some(&body))
            .expect("runtime route");
        assert_eq!(response.status, 200);
        assert_eq!(response.body, json!({ "ok": true }));
    }

    let state = load_metadata_state(&state_dir);
    let session = &state.sessions["codex-1"];
    assert_eq!(session["status"], json!({ "text": "ready", "tone": "ok" }));
    assert_eq!(
        session["progress"],
        json!({ "current": 2, "total": 5, "label": "tests" })
    );
    assert_eq!(session["context"]["cwd"], "/repo");
    assert_eq!(session["context"]["branch"], "feature");
    assert_eq!(
        session["context"]["pr"],
        json!({ "number": 7, "title": "Port" })
    );
    assert_eq!(
        session["derived"]["services"],
        json!([{ "label": "web", "port": 3000 }])
    );
    assert_eq!(session["logs"][0]["message"], "one");
    assert_eq!(session["logs"][0]["source"], "test");

    let clear = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::CLEAR_LOG,
        Some(&json!({ "session": "codex-1" })),
    )
    .expect("clear log route");
    assert_eq!(clear.status, 200);
    assert!(load_metadata_state(&state_dir).sessions["codex-1"]["logs"].is_null());
    cleanup(project);
}

#[test]
fn log_route_keeps_last_twenty_entries() {
    let project = temp_project("logs");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    for index in 0..25 {
        route_runtime_metadata_request(
            &context,
            "POST",
            routes::runtime::LOG,
            Some(&json!({ "session": "codex-1", "message": format!("log-{index}") })),
        )
        .expect("log route");
    }
    let state = load_metadata_state(&state_dir);
    let logs = state.sessions["codex-1"]["logs"].as_array().expect("logs");
    assert_eq!(logs.len(), 20);
    assert_eq!(logs[0]["message"], "log-5");
    assert_eq!(logs[19]["message"], "log-24");
    cleanup(project);
}

#[test]
fn unported_runtime_metadata_routes_stay_explicit() {
    let project = temp_project("unported");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));
    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::SET_ACTIVITY,
        Some(&json!({})),
    )
    .expect("known runtime route");
    assert_eq!(response.status, 501);
    assert_eq!(response.body["group"], "runtime");
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-metadata-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
