use aimux::daemon_state::load_metadata_state;
use aimux::project_service::metadata::update_session_metadata;
use aimux::project_service::notification_context::{
    NotificationContextPatch, NotificationContextSource, update_notification_context,
};
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
use aimux::project_service::runtime_events::route_runtime_event;
use serde_json::json;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn runtime_event_status_messages_drive_derived_state() {
    let project = temp_project("status-derived");
    let state_dir = project.join("state");
    update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert(
            "derived".into(),
            json!({
                "activity": "idle",
                "attention": "normal",
                "unseenCount": 1,
                "becameIdleAt": "2026-01-01T00:00:00.000Z"
            }),
        );
        json!(object)
    })
    .expect("seed metadata");

    let running = route_runtime_event(
        &state_dir,
        "codex-1",
        json!({
            "kind": "status",
            "message": "working through the parser",
            "ts": "2026-01-01T00:00:10.000Z"
        }),
    )
    .expect("event route");
    assert_eq!(running.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "running");
    assert_eq!(derived["attention"], "normal");
    assert_eq!(derived["unseenCount"], 1);
    assert!(derived["becameIdleAt"].is_null());

    let blocked = route_runtime_event(
        &state_dir,
        "codex-1",
        json!({
            "kind": "status",
            "message": "waiting on credentials",
            "ts": "2026-01-01T00:00:20.000Z"
        }),
    )
    .expect("event route");
    assert_eq!(blocked.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "waiting");
    assert_eq!(derived["attention"], "blocked");
    assert_eq!(derived["unseenCount"], 2);
    assert_eq!(derived["becameIdleAt"], "2026-01-01T00:00:20.000Z");
    cleanup(project);
}

#[test]
fn runtime_event_normalizes_history_and_tracks_output_timestamp() {
    let project = temp_project("history");
    let state_dir = project.join("state");
    update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert(
            "derived".into(),
            json!({
                "events": (0..21).map(|index| json!({ "kind": "response", "message": format!("old-{index}") })).collect::<Vec<_>>()
            }),
        );
        json!(object)
    })
    .expect("seed metadata");

    let response = route_runtime_event(&state_dir, "codex-1", json!({ "kind": "response" }))
        .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    let events = derived["events"].as_array().expect("events");
    assert_eq!(events.len(), 20);
    assert_eq!(events[0]["message"], "old-2");
    assert_eq!(events[19]["kind"], "response");
    assert!(
        events[19]["ts"]
            .as_str()
            .is_some_and(|value| value.ends_with('Z'))
    );
    assert_eq!(derived["lastOutputAt"], events[19]["ts"]);
    assert_eq!(derived["lastEvent"], events[19]);
    cleanup(project);
}

#[test]
fn runtime_event_records_focused_alerts_as_read() {
    let project = temp_project("focused-alert");
    let state_dir = project.join("state");
    update_notification_context(
        &state_dir,
        NotificationContextSource::Tui,
        NotificationContextPatch {
            focused: Some(true),
            screen: Some(Some("session".into())),
            session_id: Some(Some("codex-1".into())),
            panel_open: Some(false),
        },
    );

    let response = route_runtime_event(
        &state_dir,
        "codex-1",
        json!({
            "kind": "needs_input",
            "message": "Approve the command",
            "ts": "2026-01-01T00:00:00.000Z"
        }),
    )
    .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    assert_eq!(
        state.sessions["codex-1"]["derived"]["attention"],
        "needs_input"
    );
    assert_eq!(state.sessions["codex-1"]["derived"]["unseenCount"], 0);
    let snapshot = list_notification_snapshot(
        &state_dir,
        NotificationQuery {
            unread_only: false,
            include_cleared: false,
            session_id: Some("codex-1".into()),
            limit: Some(10),
        },
    );
    assert_eq!(snapshot.total, 1);
    assert_eq!(snapshot.unread_count, 0);
    assert_eq!(snapshot.notifications[0]["body"], "Approve the command");
    assert_eq!(snapshot.notifications[0]["unread"], false);
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-runtime-events-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
