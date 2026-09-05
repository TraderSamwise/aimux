use aimux::project_api_contract::routes;
use aimux::project_service::reads::route_read_request;
use aimux::project_service::router::ProjectServiceRequestContext;
use serde_json::Value;
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn health_route_matches_project_service_contract_shape() {
    let context = ProjectServiceRequestContext::with_project_state_dir("/repo", "/state/repo");
    let response = route_read_request(&context, "GET", routes::HEALTH).expect("health route");
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], Value::Bool(true));
    assert_eq!(response.body["projectStateDir"], "/state/repo");
    assert!(response.body["pid"].as_u64().is_some());
    assert_eq!(response.body["serviceInfo"]["apiVersion"], 5);
    assert_eq!(
        response.body["serviceInfo"]["capabilities"]["parsedAgentOutput"],
        Value::Bool(true)
    );
}

#[test]
fn read_split_returns_unimplemented_for_known_unported_reads() {
    let context = ProjectServiceRequestContext::with_project_state_dir("/repo", "/state/repo");
    let response = route_read_request(&context, "GET", routes::DIAGNOSTICS).expect("known read");
    assert_eq!(response.status, 501);
    assert_eq!(response.body["group"], "reads");
}

#[test]
fn state_route_loads_metadata_state_from_project_state_dir() {
    let project = temp_project("state");
    let project_state_dir = project.join("state-dir");
    create_dir_all(&project_state_dir).expect("create state dir");
    write(
        project_state_dir.join("metadata.json"),
        json!({
            "version": 1,
            "sessions": {
                "codex-1": {
                    "updatedAt": "now",
                    "backendSessionId": "runtime-owned",
                    "label": "runtime-owned",
                    "derived": { "activity": "idle" }
                }
            }
        })
        .to_string(),
    )
    .expect("write metadata");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, &project_state_dir);
    let response = route_read_request(&context, "GET", routes::STATE).expect("state route");
    assert_eq!(response.status, 200);
    assert_eq!(response.body["version"], 1);
    assert_eq!(
        response.body["sessions"]["codex-1"]["derived"]["activity"],
        "idle"
    );
    assert!(response.body["sessions"]["codex-1"]["backendSessionId"].is_null());
    assert!(response.body["sessions"]["codex-1"]["label"].is_null());
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-reads-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
