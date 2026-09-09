use aimux::project_api_contract::routes;
use aimux::project_service::notification_context::{
    NotificationContextPatch, NotificationContextSource, load_notification_context_state,
    notification_context_path, update_notification_context,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::{read_to_string, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn route_writes_context_and_defaults_unknown_source_to_tui() {
    let project = temp_project("route");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::runtime::NOTIFICATION_CONTEXT,
        Some(&json!({
            "source": "desktop",
            "focused": true,
            "screen": " session ",
            "sessionId": " codex-1 ",
            "panelOpen": false
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["context"]["source"], "desktop");
    assert_eq!(response.body["context"]["focused"], true);
    assert_eq!(response.body["context"]["screen"], "session");
    assert_eq!(response.body["context"]["sessionId"], "codex-1");
    assert_eq!(response.body["context"]["panelOpen"], false);

    let tui = route_project_service_request(
        &context,
        "POST",
        routes::runtime::NOTIFICATION_CONTEXT,
        Some(&json!({ "source": "other" })),
    );
    assert_eq!(tui.status, 200);
    assert_eq!(tui.body["context"]["source"], "tui");
    assert_eq!(tui.body["context"]["focused"], false);
    assert!(tui.body["context"]["screen"].is_null());
    assert!(tui.body["context"]["sessionId"].is_null());
    assert_eq!(tui.body["context"]["panelOpen"], false);

    let state = load_notification_context_state(&state_dir);
    assert!(state.contexts.contains_key("desktop"));
    assert!(state.contexts.contains_key("tui"));
    assert!(
        read_to_string(notification_context_path(&state_dir))
            .expect("context file")
            .contains("\"contexts\"")
    );
    cleanup(project);
}

#[test]
fn route_missing_screen_and_session_clear_previous_values() {
    let project = temp_project("clear");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    route_project_service_request(
        &context,
        "POST",
        routes::runtime::NOTIFICATION_CONTEXT,
        Some(&json!({
            "source": "desktop",
            "focused": true,
            "screen": "session",
            "sessionId": "codex-1",
            "panelOpen": true
        })),
    );
    let response = route_project_service_request(
        &context,
        "POST",
        routes::runtime::NOTIFICATION_CONTEXT,
        Some(&json!({ "source": "desktop" })),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["context"]["focused"], false);
    assert!(response.body["context"]["screen"].is_null());
    assert!(response.body["context"]["sessionId"].is_null());
    assert_eq!(response.body["context"]["panelOpen"], false);
    cleanup(project);
}

#[test]
fn direct_update_preserves_previous_when_patch_key_is_absent() {
    let project = temp_project("preserve");
    let state_dir = project.join("state");
    let first = update_notification_context(
        &state_dir,
        NotificationContextSource::Desktop,
        NotificationContextPatch {
            focused: Some(true),
            screen: Some(Some("session".into())),
            session_id: Some(Some("codex-1".into())),
            panel_open: Some(false),
        },
    );
    let second = update_notification_context(
        &state_dir,
        NotificationContextSource::Desktop,
        NotificationContextPatch {
            focused: None,
            screen: None,
            session_id: None,
            panel_open: None,
        },
    );
    assert_eq!(second.focused, first.focused);
    assert_eq!(second.screen, first.screen);
    assert_eq!(second.session_id, first.session_id);
    assert_eq!(second.panel_open, first.panel_open);
    cleanup(project);
}

#[test]
fn invalid_state_loads_empty_without_quarantine() {
    let project = temp_project("invalid");
    let state_dir = project.join("state");
    std::fs::create_dir_all(&state_dir).expect("state dir");
    write(notification_context_path(&state_dir), "{").expect("invalid file");
    assert!(
        load_notification_context_state(&state_dir)
            .contexts
            .is_empty()
    );
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-notification-context-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
