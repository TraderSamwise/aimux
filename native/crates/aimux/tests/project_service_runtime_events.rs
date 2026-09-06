use aimux::daemon_state::load_metadata_state;
use aimux::project_api_contract::routes;
use aimux::project_service::metadata::route_runtime_metadata_request;
use aimux::project_service::metadata::update_session_metadata;
use aimux::project_service::notification_context::{
    NotificationContextPatch, NotificationContextSource, update_notification_context,
};
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::runtime_events::route_runtime_event;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
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
fn runtime_event_status_messages_emit_matching_alert_records() {
    let project = temp_project("status-alerts");
    let state_dir = project.join("state");

    for (session_id, event) in [
        (
            "needs-input",
            json!({
                "kind": "status",
                "message": "waiting for you to confirm",
                "ts": "2026-01-01T00:00:10.000Z"
            }),
        ),
        (
            "blocked",
            json!({
                "kind": "status",
                "message": "blocked on credentials",
                "ts": "2026-01-01T00:00:11.000Z"
            }),
        ),
        (
            "done",
            json!({
                "kind": "status",
                "message": "finished parser work",
                "ts": "2026-01-01T00:00:12.000Z"
            }),
        ),
        (
            "success",
            json!({
                "kind": "status",
                "tone": "success",
                "message": "ready",
                "ts": "2026-01-01T00:00:13.000Z"
            }),
        ),
        (
            "error",
            json!({
                "kind": "status",
                "tone": "error",
                "message": "crashed",
                "ts": "2026-01-01T00:00:14.000Z"
            }),
        ),
        (
            "task-done",
            json!({
                "kind": "task_done",
                "message": "completed",
                "ts": "2026-01-01T00:00:15.000Z"
            }),
        ),
    ] {
        let response = route_runtime_event(&state_dir, session_id, event).expect("event route");
        assert_eq!(response.status, 200);
    }

    let snapshot = list_notification_snapshot(
        &state_dir,
        NotificationQuery {
            unread_only: false,
            include_cleared: false,
            session_id: None,
            limit: Some(10),
        },
    );
    assert_eq!(snapshot.total, 3);
    let by_session = notifications_by_session(snapshot.notifications);
    assert_eq!(by_session["error"]["kind"], "task_failed");
    assert_eq!(by_session["error"]["dedupeKey"], "error:error");
    assert_eq!(by_session["blocked"]["kind"], "blocked");
    assert_eq!(by_session["blocked"]["dedupeKey"], "blocked:blocked");
    assert_eq!(by_session["needs-input"]["kind"], "needs_input");
    assert_eq!(
        by_session["needs-input"]["dedupeKey"],
        "needs_input:needs-input"
    );
    cleanup(project);
}

#[test]
fn runtime_event_dispatcher_publishes_alert_and_project_update_events() {
    let project = temp_project("dispatcher-publish");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::EVENT,
        Some(&json!({
            "session": "codex-1",
            "event": {
                "kind": "needs_input",
                "message": "Approve the command",
                "ts": "2026-01-01T00:00:30.000Z"
            }
        })),
    )
    .expect("runtime event route");

    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true }));
    let events = context.project_events.events_since(0, None);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event["type"], "alert");
    assert_eq!(events[0].event["kind"], "needs_input");
    assert_eq!(events[0].event["sessionId"], "codex-1");
    assert_eq!(events[0].event["message"], "Approve the command");
    assert!(
        events[0].event["notificationId"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(events[1].event["type"], "project_update");
    assert_eq!(events[1].event["reason"], "alert");
    assert_eq!(events[1].event["sessionId"], "codex-1");
    assert_eq!(
        events[1].event["views"],
        json!([
            "coordination-worklist",
            "notifications",
            "project-observability"
        ])
    );
    cleanup(project);
}

#[test]
fn runtime_set_attention_dispatcher_publishes_alert_and_project_update_events() {
    let project = temp_project("attention-dispatcher-publish");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::SET_ATTENTION,
        Some(&json!({
            "session": "codex-1",
            "attention": "needs_input"
        })),
    )
    .expect("set attention route");

    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true }));
    let events = context.project_events.events_since(0, None);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event["type"], "alert");
    assert_eq!(events[0].event["kind"], "needs_input");
    assert_eq!(events[0].event["sessionId"], "codex-1");
    assert_eq!(events[0].event["message"], "Agent is waiting for input.");
    assert!(
        events[0].event["notificationId"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(events[1].event["type"], "project_update");
    assert_eq!(events[1].event["reason"], "alert");
    assert_eq!(events[1].event["sessionId"], "codex-1");
    assert_eq!(
        events[1].event["views"],
        json!([
            "coordination-worklist",
            "notifications",
            "project-observability"
        ])
    );
    cleanup(project);
}

#[test]
fn runtime_event_task_done_updates_metadata_without_alert_event() {
    let project = temp_project("task-done-no-alert");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::EVENT,
        Some(&json!({
            "session": "codex-1",
            "event": {
                "kind": "task_done",
                "message": "Done",
                "ts": "2026-01-01T00:00:00.000Z"
            }
        })),
    )
    .expect("runtime event route");

    assert_eq!(response.status, 200);
    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["codex-1"]["derived"]["activity"], "done");
    let snapshot = list_notification_snapshot(
        &state_dir,
        NotificationQuery {
            unread_only: false,
            include_cleared: false,
            session_id: Some("codex-1".into()),
            limit: Some(10),
        },
    );
    assert_eq!(snapshot.total, 0);
    assert!(context.project_events.events_since(0, None).is_empty());
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

#[test]
fn runtime_event_records_focused_status_alerts_as_read() {
    let project = temp_project("focused-status-alert");
    let state_dir = project.join("state");
    update_notification_context(
        &state_dir,
        NotificationContextSource::Desktop,
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
            "kind": "status",
            "message": "waiting for you to confirm",
            "ts": "2026-01-01T00:00:00.000Z"
        }),
    )
    .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["codex-1"]["derived"]["unseenCount"], 0);
    assert_eq!(
        state.sessions["codex-1"]["derived"]["attention"],
        "needs_input"
    );
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
    assert_eq!(snapshot.notifications[0]["kind"], "needs_input");
    assert_eq!(snapshot.notifications[0]["unread"], false);
    cleanup(project);
}

#[test]
fn runtime_event_maps_completion_failure_thread_and_alert_state() {
    let project = temp_project("completion-failure-alert");
    let state_dir = project.join("state");
    update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert(
            "derived".into(),
            json!({
                "activity": "running",
                "attention": "normal",
                "unseenCount": 4
            }),
        );
        json!(object)
    })
    .expect("seed metadata");

    let response = route_runtime_event(
        &state_dir,
        "codex-1",
        json!({
            "kind": "response",
            "message": "Done.",
            "ts": "2026-01-01T00:00:10.000Z",
            "threadId": "thread-1",
            "threadName": "Parser"
        }),
    )
    .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "idle");
    assert_eq!(derived["attention"], "normal");
    assert_eq!(derived["unseenCount"], 5);
    assert_eq!(derived["becameIdleAt"], "2026-01-01T00:00:10.000Z");
    assert_eq!(derived["lastOutputAt"], "2026-01-01T00:00:10.000Z");
    assert_eq!(derived["threadId"], "thread-1");
    assert_eq!(derived["threadName"], "Parser");

    let response = route_runtime_event(
        &state_dir,
        "codex-1",
        json!({
            "kind": "task_failed",
            "message": "Tests failed",
            "ts": "2026-01-01T00:00:20.000Z"
        }),
    )
    .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "error");
    assert_eq!(derived["attention"], "error");
    assert_eq!(derived["unseenCount"], 6);
    assert_eq!(derived["lastOutputAt"], "2026-01-01T00:00:20.000Z");
    assert_eq!(derived["lastEvent"]["message"], "Tests failed");
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
    assert_eq!(snapshot.unread_count, 1);
    assert_eq!(snapshot.notifications[0]["kind"], "task_failed");
    assert_eq!(snapshot.notifications[0]["dedupeKey"], "error:codex-1");
    assert_eq!(snapshot.notifications[0]["body"], "Tests failed");
    cleanup(project);
}

#[test]
fn runtime_event_only_stamps_idle_transition_from_running() {
    let project = temp_project("cold-non-running");
    let state_dir = project.join("state");

    let response = route_runtime_event(
        &state_dir,
        "codex-1",
        json!({
            "kind": "response",
            "message": "Done.",
            "ts": "2026-01-01T00:00:10.000Z"
        }),
    )
    .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "idle");
    assert_eq!(derived["attention"], "normal");
    assert_eq!(derived["unseenCount"], 1);
    assert!(derived["becameIdleAt"].is_null());

    let response = route_runtime_event(
        &state_dir,
        "codex-2",
        json!({
            "kind": "task_failed",
            "message": "Failed.",
            "ts": "2026-01-01T00:00:20.000Z"
        }),
    )
    .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-2"]["derived"];
    assert_eq!(derived["activity"], "error");
    assert_eq!(derived["attention"], "error");
    assert_eq!(derived["unseenCount"], 1);
    assert!(derived["becameIdleAt"].is_null());
    cleanup(project);
}

#[test]
fn runtime_event_dispatcher_updates_history_alerts_and_focused_unread_state() {
    let project = temp_project("dispatcher-event");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert(
            "derived".into(),
            json!({
                "activity": "running",
                "attention": "normal",
                "unseenCount": 7
            }),
        );
        json!(object)
    })
    .expect("seed metadata");
    update_notification_context(
        &state_dir,
        NotificationContextSource::Desktop,
        NotificationContextPatch {
            focused: Some(true),
            screen: Some(Some("session".into())),
            session_id: Some(Some("codex-1".into())),
            panel_open: Some(false),
        },
    );

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::EVENT,
        Some(&json!({
            "session": "codex-1",
            "event": {
                "kind": "needs_input",
                "message": "Approve the command",
                "ts": "2026-01-01T00:00:30.000Z"
            }
        })),
    )
    .expect("runtime event route");

    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true }));
    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "waiting");
    assert_eq!(derived["attention"], "needs_input");
    assert_eq!(derived["unseenCount"], 7);
    assert_eq!(derived["becameIdleAt"], "2026-01-01T00:00:30.000Z");
    assert_eq!(derived["lastOutputAt"], "2026-01-01T00:00:30.000Z");
    assert_eq!(derived["lastEvent"]["kind"], "needs_input");
    assert_eq!(derived["events"].as_array().unwrap().len(), 1);

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
    assert_eq!(snapshot.notifications[0]["kind"], "needs_input");
    assert_eq!(snapshot.notifications[0]["unread"], false);
    assert_eq!(snapshot.notifications[0]["body"], "Approve the command");
    cleanup(project);
}

#[test]
fn runtime_event_alerts_include_project_and_worktree_display_context() {
    let project = temp_project("alert-display-context");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_desktop_state(json!({
            "sessions": [
                { "id": "codex-1", "worktreePath": "/repo/.aimux/worktrees/feature-a" }
            ],
            "worktrees": [
                {
                    "path": "/repo/.aimux/worktrees/feature-a",
                    "name": "feature-a",
                    "branch": "feat/a"
                }
            ]
        }));

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::EVENT,
        Some(&json!({
            "session": "codex-1",
            "event": {
                "kind": "needs_input",
                "message": "Approve the command",
                "ts": "2026-01-01T00:00:30.000Z"
            }
        })),
    )
    .expect("runtime event route");

    assert_eq!(response.status, 200);
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
    let notification = &snapshot.notifications[0];
    assert_eq!(
        notification["projectName"],
        project.file_name().unwrap().to_str().unwrap()
    );
    assert_eq!(notification["projectRoot"], project.to_str().unwrap());
    assert_eq!(
        notification["worktreePath"],
        "/repo/.aimux/worktrees/feature-a"
    );
    assert_eq!(notification["worktreeName"], "feature-a");
    assert_eq!(notification["branch"], "feat/a");
    assert_eq!(notification["categoryLabel"], "Needs Input");
    assert_eq!(notification["reasonLabel"], "Agent needs input");

    let events = context.project_events.events_since(0, None);
    assert_eq!(events[0].event["type"], "alert");
    assert_eq!(events[0].event["projectName"], notification["projectName"]);
    assert_eq!(events[0].event["projectRoot"], notification["projectRoot"]);
    assert_eq!(events[0].event["worktreeName"], "feature-a");
    assert_eq!(events[0].event["categoryLabel"], "Needs Input");
    assert_eq!(events[0].event["reasonLabel"], "Agent needs input");
    cleanup(project);
}

#[test]
fn runtime_event_notify_records_custom_alert_without_derived_state_change() {
    let project = temp_project("notify-alert");
    let state_dir = project.join("state");
    update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert(
            "derived".into(),
            json!({
                "activity": "waiting",
                "attention": "needs_input",
                "unseenCount": 2,
                "becameIdleAt": "2026-01-01T00:00:00.000Z"
            }),
        );
        json!(object)
    })
    .expect("seed metadata");

    let response = route_runtime_event(
        &state_dir,
        "codex-1",
        json!({
            "kind": "notify",
            "source": "watcher",
            "message": "Build log updated",
            "ts": "2026-01-01T00:00:30.000Z"
        }),
    )
    .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "waiting");
    assert_eq!(derived["attention"], "needs_input");
    assert_eq!(derived["unseenCount"], 3);
    assert_eq!(derived["becameIdleAt"], "2026-01-01T00:00:00.000Z");
    assert_eq!(derived["lastOutputAt"], "2026-01-01T00:00:30.000Z");
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
    assert_eq!(snapshot.notifications[0]["title"], "watcher");
    assert_eq!(snapshot.notifications[0]["kind"], "notification");
    assert_eq!(
        snapshot.notifications[0]["dedupeKey"],
        "notify:codex-1:Build log updated"
    );
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

fn notifications_by_session(notifications: Vec<Value>) -> BTreeMap<String, Value> {
    notifications
        .into_iter()
        .map(|notification| {
            let session_id = notification["sessionId"]
                .as_str()
                .expect("notification session")
                .to_owned();
            (session_id, notification)
        })
        .collect()
}
