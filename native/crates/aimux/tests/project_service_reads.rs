use aimux::plugin_project_service_host::ProjectServicePluginHost;
use aimux::plugin_project_service_host::native_plugin_statuses_for_context;
use aimux::plugin_registry::NativePluginRegistry;
use aimux::project_api_contract::routes;
use aimux::project_service::reads::route_read_request;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::router::route_project_service_request;
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
fn diagnostics_route_reports_resources_and_runtime_exchange() {
    let project = temp_project("diagnostics");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_read_request(&context, "GET", routes::DIAGNOSTICS).expect("diagnostics");
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(
        response.body["projectStateDir"],
        state_dir.to_string_lossy().as_ref()
    );
    assert!(response.body["pid"].as_u64().is_some());
    assert_eq!(response.body["serviceInfo"]["apiVersion"], 5);
    assert!(
        response.body["resources"]["memoryRssBytes"]
            .as_u64()
            .is_some()
    );
    assert!(
        response.body["resources"]["memoryHeapUsedBytes"]
            .as_u64()
            .is_some()
    );
    assert_eq!(response.body["recentSlowRequests"], json!([]));
    assert_eq!(response.body["plugins"], json!([]));
    assert_eq!(response.body["previews"], json!({}));
    assert_eq!(response.body["agentOutputReads"]["total"]["count"], 0);
    assert_eq!(response.body["runtimeExchange"]["exists"], false);
    cleanup(project);
}

#[test]
fn diagnostics_route_reports_native_plugin_statuses() {
    let project = temp_project("diagnostics-plugins");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("create state dir");
    let base_context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let plugin_statuses = native_plugin_statuses_for_context(&base_context);
    let context = base_context.with_plugin_statuses(plugin_statuses);
    let response = route_read_request(&context, "GET", routes::DIAGNOSTICS).expect("diagnostics");
    assert_eq!(response.status, 200);
    assert_eq!(response.body["plugins"][0]["name"], "gh-pr-context");
    assert_eq!(response.body["plugins"][0]["source"], "builtin");
    assert_eq!(response.body["plugins"][0]["status"], "loaded");
    assert_eq!(response.body["plugins"][1]["name"], "transcript-length");
    assert_eq!(response.body["plugins"][1]["source"], "builtin");
    assert_eq!(response.body["plugins"][1]["status"], "loaded");
    cleanup(project);
}

#[test]
fn diagnostics_lifecycle_route_reports_empty_rust_queue() {
    let project = temp_project("diagnostics-lifecycle");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));
    let response =
        route_read_request(&context, "GET", routes::DIAGNOSTICS_LIFECYCLE).expect("diagnostics");
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert!(response.body["pid"].as_u64().is_some());
    assert_eq!(
        response.body["projectRoot"],
        project.to_string_lossy().as_ref()
    );
    assert_eq!(response.body["queuedCount"], 0);
    assert_eq!(response.body["runningCount"], 0);
    assert_eq!(response.body["pending"], json!([]));
    assert_eq!(response.body["running"], json!([]));
    cleanup(project);
}

#[test]
fn desktop_state_is_owned_by_router_not_legacy_read_split() {
    let context = ProjectServiceRequestContext::with_project_state_dir("/repo", "/state/repo");
    assert!(route_read_request(&context, "GET", routes::DESKTOP_STATE).is_none());

    let response = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
}

#[test]
fn native_builtin_plugin_receives_event_and_writes_through_project_service_host() {
    let project = temp_project("plugin-event");
    let state_dir = project.join("state");
    create_dir_all(project.join(".aimux/history")).expect("create history dir");
    create_dir_all(&state_dir).expect("create state dir");
    write(
        state_dir.join("metadata.json"),
        json!({
            "version": 1,
            "sessions": {
                "codex-1": {
                    "updatedAt": "2026-09-09T00:00:00.000Z",
                    "context": {}
                }
            }
        })
        .to_string(),
    )
    .expect("write metadata");
    write(
        project.join(".aimux/history/codex-1.jsonl"),
        "{\"ts\":\"2026-09-09T00:00:00.000Z\",\"text\":\"hello\"}\n",
    )
    .expect("write history");

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut registry = NativePluginRegistry::builtins();
    let mut host = ProjectServicePluginHost::new(&context);
    let statuses = registry.start(&mut host);
    assert_eq!(statuses[1].name, "transcript-length");
    assert_eq!(statuses[1].status, "loaded");
    let initial = read_json(state_dir.join("metadata.json"));
    assert_eq!(
        initial["sessions"]["codex-1"]["statusline"]["top"][0]["id"],
        "transcript-length"
    );
    assert_eq!(
        initial["sessions"]["codex-1"]["statusline"]["top"][0]["text"],
        "49b"
    );

    write(
        project.join(".aimux/history/codex-1.jsonl"),
        "{\"ts\":\"2026-09-09T00:00:00.000Z\",\"text\":\"hello\"}\n{\"ts\":\"2026-09-09T00:00:01.000Z\",\"text\":\"second turn with more bytes\"}\n",
    )
    .expect("extend history");
    let mut host = ProjectServicePluginHost::new(&context);
    let statuses = registry.dispatch_event(
        json!({ "kind": "activity", "sessionId": "codex-1" }),
        &mut host,
    );
    assert_eq!(statuses[1].name, "transcript-length");
    assert_eq!(statuses[1].status, "loaded");
    let updated = read_json(state_dir.join("metadata.json"));
    assert_eq!(
        updated["sessions"]["codex-1"]["statusline"]["top"][0]["text"],
        "120b"
    );
    cleanup(project);
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

fn read_json(path: PathBuf) -> Value {
    let raw = std::fs::read_to_string(path).expect("read json");
    serde_json::from_str(&raw).expect("parse json")
}
