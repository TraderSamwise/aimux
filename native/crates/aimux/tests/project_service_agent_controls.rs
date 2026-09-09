use aimux::daemon_state::{MetadataState, load_metadata_state, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn loop_route_sets_and_clears_loop_metadata_with_provenance() {
    let project = temp_project("loop");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let add = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": " worker-1 ",
            "active": true,
            "goal": " ship ",
            "source": "dashboard",
            "updatedBy": "dashboard",
            "updatedBySessionId": "boss",
            "updatedByRole": "overseer",
            "reason": "keep moving"
        })),
    );

    assert_eq!(add.status, 200);
    assert_eq!(add.body["ok"], true);
    assert_eq!(add.body["sessionId"], "worker-1");
    assert_eq!(add.body["loop"]["active"], true);
    assert_eq!(add.body["loop"]["goal"], "ship");
    assert_eq!(add.body["loop"]["source"], "dashboard");
    assert!(add.body["loop"]["since"].as_str().unwrap().ends_with('Z'));
    let state = load_metadata_state(&state_dir);
    let worker = &state.sessions["worker-1"];
    assert_eq!(worker["loop"], add.body["loop"]);
    assert_eq!(worker["loopLastAction"]["action"], "add");
    assert_eq!(worker["loopLastAction"]["goal"], "ship");
    assert_eq!(worker["loopLastAction"]["source"], "dashboard");
    assert_eq!(worker["loopLastAction"]["updatedBySessionId"], "boss");

    let remove = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": false,
            "action": "done",
            "source": "overseer",
            "reason": "complete"
        })),
    );

    assert_eq!(remove.status, 200);
    assert!(remove.body["loop"].is_null());
    assert_eq!(remove.body["loopLastAction"]["action"], "done");
    assert_eq!(remove.body["loopLastAction"]["source"], "overseer");
    let state = load_metadata_state(&state_dir);
    let worker = &state.sessions["worker-1"];
    assert!(worker.get("loop").is_none());
    assert_eq!(worker["loopLastAction"], remove.body["loopLastAction"]);
    cleanup(project);
}

#[test]
fn loop_provenance_truncates_like_javascript_utf16_slice() {
    let project = temp_project("loop-utf16");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let emoji_reason = "😀".repeat(300);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::LOOP,
        Some(&json!({
            "sessionId": "worker-1",
            "active": true,
            "updatedBy": emoji_reason,
            "reason": "😀".repeat(1200)
        })),
    );

    assert_eq!(response.status, 200);
    let state = load_metadata_state(&state_dir);
    let updated_by = state.sessions["worker-1"]["loop"]["updatedBy"]
        .as_str()
        .unwrap();
    let reason = state.sessions["worker-1"]["loop"]["reason"]
        .as_str()
        .unwrap();
    assert_eq!(updated_by.encode_utf16().count(), 500);
    assert_eq!(reason.encode_utf16().count(), 2000);
    cleanup(project);
}

#[test]
fn loop_and_control_routes_validate_required_fields() {
    let project = temp_project("validation");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let missing_session =
        route_project_service_request(&context, "POST", routes::agents::LOOP, Some(&json!({})));
    assert_eq!(missing_session.status, 400);
    assert_eq!(missing_session.body["error"], "sessionId is required");

    let missing_active = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "boss" })),
    );
    assert_eq!(missing_active.status, 400);
    assert_eq!(missing_active.body["error"], "active (boolean) is required");

    let wrong_method = route_project_service_request(&context, "GET", routes::agents::SCRIBE, None);
    assert_eq!(wrong_method.status, 405);
    cleanup(project);
}

#[test]
fn overseer_route_enforces_single_project_overseer_and_clear_removes_flag() {
    let project = temp_project("overseer");
    let state_dir = project.join("state");
    seed_metadata(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "boss-2", "active": true })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["overseer"], true);
    let state = load_metadata_state(&state_dir);
    assert!(state.sessions["boss-1"].get("overseer").is_none());
    assert_eq!(state.sessions["boss-2"]["overseer"], true);

    let clear = route_project_service_request(
        &context,
        "POST",
        routes::agents::OVERSEER,
        Some(&json!({ "sessionId": "boss-2", "active": false })),
    );
    assert_eq!(clear.status, 200);
    assert_eq!(clear.body["overseer"], false);
    let state = load_metadata_state(&state_dir);
    assert!(state.sessions["boss-2"].get("overseer").is_none());
    cleanup(project);
}

#[test]
fn scribe_route_enforces_single_scribe_and_clear_sets_false_override() {
    let project = temp_project("scribe");
    let state_dir = project.join("state");
    seed_metadata(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::SCRIBE,
        Some(&json!({ "sessionId": "scribe-2", "active": true })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["scribe"], true);
    let state = load_metadata_state(&state_dir);
    assert!(state.sessions["scribe-1"].get("scribe").is_none());
    assert_eq!(state.sessions["scribe-2"]["scribe"], true);

    let clear = route_project_service_request(
        &context,
        "POST",
        routes::agents::SCRIBE,
        Some(&json!({ "sessionId": "scribe-2", "active": false })),
    );
    assert_eq!(clear.status, 200);
    assert_eq!(clear.body["scribe"], false);
    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["scribe-2"]["scribe"], false);
    cleanup(project);
}

fn seed_metadata(state_dir: &PathBuf) {
    save_metadata_state(
        state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "boss-1".into(),
                    json!({ "overseer": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
                (
                    "scribe-1".into(),
                    json!({ "scribe": true, "updatedAt": "2026-09-05T00:00:00.000Z" }),
                ),
            ]),
        },
    )
    .unwrap();
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-project-service-agent-controls-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
