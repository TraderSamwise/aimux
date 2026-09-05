use aimux::daemon_state::{load_metadata_state, metadata_state_path};
use aimux::project_api_contract::routes;
use aimux::project_service::metadata::{route_runtime_metadata_request, update_session_metadata};
use aimux::project_service::notification_context::{
    NotificationContextPatch, NotificationContextSource, update_notification_context,
};
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
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
fn statusline_segment_posts_to_default_bottom_and_replaces_by_id() {
    let project = temp_project("statusline-post");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let first = route_runtime_metadata_request(
        &context,
        "POST",
        routes::STATUSLINE_SEGMENT,
        Some(&json!({ "session": "codex-1", "id": "build", "text": "red", "tone": "warning" })),
    )
    .expect("statusline route");
    assert_eq!(first.status, 200);

    let second = route_runtime_metadata_request(
        &context,
        "POST",
        routes::STATUSLINE_SEGMENT,
        Some(&json!({ "session": "codex-1", "id": "build", "text": "green", "data": { "ok": true } })),
    )
    .expect("statusline route");
    assert_eq!(second.status, 200);

    let state = load_metadata_state(&state_dir);
    let bottom = state.sessions["codex-1"]["statusline"]["bottom"]
        .as_array()
        .expect("bottom segments");
    assert_eq!(bottom.len(), 1);
    assert_eq!(bottom[0]["id"], "build");
    assert_eq!(bottom[0]["text"], "green");
    assert_eq!(bottom[0]["data"], json!({ "ok": true }));
    cleanup(project);
}

#[test]
fn statusline_segment_delete_removes_named_rail_or_both() {
    let project = temp_project("statusline-delete");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    for (line, id) in [("top", "same"), ("bottom", "same"), ("bottom", "other")] {
        route_runtime_metadata_request(
            &context,
            "POST",
            routes::STATUSLINE_SEGMENT,
            Some(&json!({ "session": "codex-1", "line": line, "id": id, "text": id })),
        )
        .expect("statusline post");
    }

    route_runtime_metadata_request(
        &context,
        "DELETE",
        routes::STATUSLINE_SEGMENT,
        Some(&json!({ "session": "codex-1", "line": "top", "id": "same" })),
    )
    .expect("statusline delete");
    let state = load_metadata_state(&state_dir);
    assert!(state.sessions["codex-1"]["statusline"]["top"].is_null());
    assert_eq!(
        state.sessions["codex-1"]["statusline"]["bottom"]
            .as_array()
            .expect("bottom")
            .len(),
        2
    );

    route_runtime_metadata_request(
        &context,
        "DELETE",
        routes::STATUSLINE_SEGMENT,
        Some(&json!({ "session": "codex-1", "id": "same" })),
    )
    .expect("statusline delete both");
    let state = load_metadata_state(&state_dir);
    let bottom = state.sessions["codex-1"]["statusline"]["bottom"]
        .as_array()
        .expect("bottom");
    assert_eq!(bottom.len(), 1);
    assert_eq!(bottom[0]["id"], "other");
    cleanup(project);
}

#[test]
fn statusline_segment_validates_body_like_typescript() {
    let project = temp_project("statusline-validation");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));
    for (method, body, error) in [
        ("POST", json!({}), "session is required"),
        (
            "POST",
            json!({ "session": "codex-1", "line": "middle" }),
            "line must be top or bottom",
        ),
        ("DELETE", json!({ "session": "codex-1" }), "id is required"),
        (
            "POST",
            json!({ "session": "codex-1", "id": "a", "ttlSeconds": 0 }),
            "ttlSeconds must be between 1 and 86400",
        ),
        (
            "POST",
            json!({ "session": "codex-1", "id": "a", "text": "x", "data": "x".repeat(4097) }),
            "data is 4099 bytes; the limit is 4096",
        ),
        (
            "POST",
            json!({ "session": "codex-1", "text": "x" }),
            "a segment needs an id to be replaceable",
        ),
    ] {
        let response = route_runtime_metadata_request(
            &context,
            method,
            routes::STATUSLINE_SEGMENT,
            Some(&body),
        )
        .expect("statusline route");
        assert_eq!(response.status, 400);
        assert_eq!(response.body["error"], error);
    }
    let response = route_runtime_metadata_request(
        &context,
        "PUT",
        routes::STATUSLINE_SEGMENT,
        Some(&json!({ "session": "codex-1" })),
    )
    .expect("statusline route");
    assert_eq!(response.status, 405);
    assert_eq!(response.body["error"], "use POST or DELETE");
    cleanup(project);
}

#[test]
fn runtime_set_activity_tracks_idle_transitions() {
    let project = temp_project("activity");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let running = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::SET_ACTIVITY,
        Some(&json!({ "session": "codex-1", "activity": "running" })),
    )
    .expect("set activity");
    assert_eq!(running.status, 200);

    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["codex-1"]["derived"]["activity"], "running");
    assert!(
        state.sessions["codex-1"]["derived"]["becameIdleAt"].is_null(),
        "running clears the idle timestamp"
    );

    let idle = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::SET_ACTIVITY,
        Some(&json!({ "session": "codex-1", "activity": "idle" })),
    )
    .expect("set activity");
    assert_eq!(idle.status, 200);

    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["codex-1"]["derived"]["activity"], "idle");
    assert!(
        state.sessions["codex-1"]["derived"]["becameIdleAt"]
            .as_str()
            .is_some_and(|value| value.ends_with('Z')),
        "leaving running stamps becameIdleAt"
    );
    cleanup(project);
}

#[test]
fn runtime_set_attention_updates_derived_attention() {
    let project = temp_project("attention");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::SET_ATTENTION,
        Some(&json!({ "session": "codex-1", "attention": "needs_input" })),
    )
    .expect("set attention");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    assert_eq!(
        state.sessions["codex-1"]["derived"]["attention"],
        "needs_input"
    );
    cleanup(project);
}

#[test]
fn runtime_mark_seen_clears_unseen_and_dismisses_actionable_attention() {
    let project = temp_project("mark-seen");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert(
            "derived".into(),
            json!({
                "unseenCount": 9,
                "attention": "needs_input",
                "activity": "waiting",
                "services": [{ "label": "web" }]
            }),
        );
        json!(object)
    })
    .expect("seed metadata");

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::MARK_SEEN,
        Some(&json!({ "session": "codex-1" })),
    )
    .expect("mark seen");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["unseenCount"], 0);
    assert_eq!(derived["attention"], "normal");
    assert_eq!(derived["activity"], "idle");
    assert_eq!(derived["services"], json!([{ "label": "web" }]));
    cleanup(project);
}

#[test]
fn runtime_event_derives_state_and_keeps_bounded_event_history() {
    let project = temp_project("event-state");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    update_session_metadata(&state_dir, "codex-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert(
            "derived".into(),
            json!({
                "activity": "running",
                "attention": "normal",
                "unseenCount": 2,
                "events": (0..25).map(|index| json!({ "kind": "response", "message": format!("old-{index}") })).collect::<Vec<_>>()
            }),
        );
        json!(object)
    })
    .expect("seed metadata");

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::EVENT,
        Some(&json!({
            "session": "codex-1",
            "event": {
                "kind": "status",
                "message": "waiting for you to confirm",
                "tone": "warn",
                "ts": "2026-01-01T00:00:10.000Z",
                "threadId": "thread-1",
                "threadName": "Build"
            }
        })),
    )
    .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "waiting");
    assert_eq!(derived["attention"], "needs_input");
    assert_eq!(derived["unseenCount"], 3);
    assert_eq!(derived["becameIdleAt"], "2026-01-01T00:00:10.000Z");
    assert_eq!(derived["lastOutputAt"], "2026-01-01T00:00:10.000Z");
    assert_eq!(derived["threadId"], "thread-1");
    assert_eq!(derived["threadName"], "Build");
    assert_eq!(
        derived["lastEvent"]["message"],
        "waiting for you to confirm"
    );
    let events = derived["events"].as_array().expect("events");
    assert_eq!(events.len(), 20);
    assert_eq!(events[0]["message"], "old-6");
    assert_eq!(events[19]["kind"], "status");
    cleanup(project);
}

#[test]
fn runtime_event_emits_attention_notifications() {
    let project = temp_project("event-alert");
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
                "message": "Approve deploy",
                "ts": "2026-01-01T00:00:10.000Z"
            }
        })),
    )
    .expect("event route");
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
    assert_eq!(snapshot.unread_count, 1);
    assert_eq!(snapshot.notifications[0]["title"], "codex-1 needs input");
    assert_eq!(snapshot.notifications[0]["body"], "Approve deploy");
    assert_eq!(snapshot.notifications[0]["kind"], "needs_input");
    assert_eq!(
        snapshot.notifications[0]["dedupeKey"],
        "needs_input:codex-1"
    );
    cleanup(project);
}

#[test]
fn runtime_event_suppresses_unseen_and_unread_when_session_is_focused() {
    let project = temp_project("event-focused");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
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

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::EVENT,
        Some(&json!({
            "session": "codex-1",
            "event": {
                "kind": "needs_input",
                "message": "Still here",
                "ts": "2026-01-01T00:00:10.000Z"
            }
        })),
    )
    .expect("event route");
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
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
    assert_eq!(snapshot.notifications[0]["unread"], false);
    cleanup(project);
}

#[test]
fn runtime_notify_maps_legacy_body_to_notification_record() {
    let project = temp_project("notify");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::NOTIFY,
        Some(&json!({
            "kind": "complete",
            "title": "claude-1 finished",
            "subtitle": "Done",
            "message": "Finished parser audit.",
            "worktreePath": "/repo/wt",
            "worktreeName": "wt",
            "branch": "feature"
        })),
    )
    .expect("notify route");
    assert_eq!(response.status, 200);

    let snapshot = list_notification_snapshot(
        &state_dir,
        NotificationQuery {
            unread_only: false,
            include_cleared: false,
            session_id: None,
            limit: Some(10),
        },
    );
    assert_eq!(snapshot.total, 1);
    assert_eq!(snapshot.unread_count, 1);
    let record = &snapshot.notifications[0];
    assert_eq!(record["title"], "claude-1 finished");
    assert_eq!(record["body"], "Done — Finished parser audit.");
    assert_eq!(record["kind"], "task_done");
    assert_eq!(record["dedupeKey"], "notify:complete:claude-1 finished");
    assert_eq!(record["worktreePath"], "/repo/wt");
    assert_eq!(record["worktreeName"], "wt");
    assert_eq!(record["branch"], "feature");
    cleanup(project);
}

#[test]
fn runtime_notify_honors_focused_session_unless_forced() {
    let project = temp_project("notify-focused");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
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

    let focused = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::NOTIFY,
        Some(&json!({
            "sessionId": "codex-1",
            "kind": "blocked",
            "message": "Need credentials"
        })),
    )
    .expect("notify route");
    assert_eq!(focused.status, 200);

    let forced = route_runtime_metadata_request(
        &context,
        "POST",
        routes::runtime::NOTIFY,
        Some(&json!({
            "sessionId": "codex-1",
            "kind": "blocked",
            "message": "Still blocked",
            "force": true
        })),
    )
    .expect("notify route");
    assert_eq!(forced.status, 200);

    let snapshot = list_notification_snapshot(
        &state_dir,
        NotificationQuery {
            unread_only: false,
            include_cleared: false,
            session_id: Some("codex-1".into()),
            limit: Some(10),
        },
    );
    assert_eq!(snapshot.total, 2);
    assert_eq!(snapshot.unread_count, 1);
    assert_eq!(snapshot.notifications[0]["body"], "Still blocked");
    assert_eq!(
        snapshot.notifications[0]["dedupeKey"],
        serde_json::Value::Null
    );
    assert_eq!(snapshot.notifications[0]["unread"], true);
    assert_eq!(snapshot.notifications[1]["body"], "Need credentials");
    assert_eq!(snapshot.notifications[1]["dedupeKey"], "blocked:codex-1");
    assert_eq!(snapshot.notifications[1]["unread"], false);
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
        routes::runtime::SHELL_STATE,
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
