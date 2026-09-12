use aimux::project_api_contract::routes;
use aimux::project_service::notifications::{
    NotificationMutation, NotificationQuery, clear_notifications, list_notification_snapshot,
    mark_notifications_read,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{
    read_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all, set_permissions, write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn lists_notification_threads_from_latest_message_metadata() {
    let project = temp_project("list");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);

    let snapshot = list_notification_snapshot(
        &state_dir,
        NotificationQuery {
            unread_only: false,
            include_cleared: false,
            session_id: None,
            limit: Some(10),
        },
    );
    assert_eq!(snapshot.total, 2);
    assert_eq!(snapshot.unread_count, 1);
    assert!(!snapshot.truncated);
    assert_eq!(snapshot.notifications[0]["id"], "record-2");
    assert_eq!(snapshot.notifications[0]["body"], "new body");
    assert_eq!(snapshot.notifications[0]["sessionId"], "codex-2");
    assert_eq!(snapshot.notifications[0]["interaction"]["id"], "interact-2");
    assert_eq!(snapshot.notifications[1]["id"], "record-1");
    cleanup(project);
}

#[test]
fn list_route_filters_unread_session_and_limit() {
    let project = temp_project("route-list");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "GET",
        "/notifications?unread=1&sessionId=codex-2&limit=1",
        None,
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["notifications"].as_array().unwrap().len(), 1);
    assert_eq!(response.body["notifications"][0]["id"], "record-2");
    assert_eq!(response.body["unreadCount"], 1);
    assert_eq!(response.body["total"], 1);
    assert_eq!(response.body["limit"], 1);
    assert_eq!(response.body["truncated"], false);

    let bad_limit = route_project_service_request(&context, "GET", "/notifications?limit=0", None);
    assert_eq!(bad_limit.status, 400);
    assert_eq!(bad_limit.body["error"], "limit must be an integer >= 1");
    cleanup(project);
}

#[test]
fn mark_read_updates_matching_thread_inbox_entries() {
    let project = temp_project("read");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);

    let updated = mark_notifications_read(
        &state_dir,
        NotificationMutation {
            id: Some("record-2".into()),
            ids: None,
            session_id: Some("codex-2".into()),
        },
    )
    .expect("mark notifications read");
    assert_eq!(updated, 1);
    let exchange = read_runtime_exchange(runtime_exchange_path(&state_dir));
    let inbox = exchange["inbox"].as_array().unwrap();
    assert_eq!(inbox[1]["state"], "done");
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).unread_count,
        0
    );
    cleanup(project);
}

#[test]
fn clear_marks_matching_messages_cleared_and_inbox_done() {
    let project = temp_project("clear");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);

    let cleared = clear_notifications(
        &state_dir,
        NotificationMutation {
            id: None,
            ids: Some(vec!["record-1".into(), "record-2".into()]),
            session_id: None,
        },
    )
    .expect("clear notifications");
    assert_eq!(cleared, 2);
    let exchange = read_runtime_exchange(runtime_exchange_path(&state_dir));
    for message in exchange["messages"].as_array().unwrap() {
        if message["threadId"] == "thread-other" {
            assert!(message["metadata"]["notificationCleared"].is_null());
        } else {
            assert_eq!(message["metadata"]["notificationCleared"], true);
        }
    }
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).total,
        0
    );
    cleanup(project);
}

#[test]
fn mutation_routes_validate_ids_shape() {
    let project = temp_project("validate");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let invalid = route_project_service_request(
        &context,
        "POST",
        routes::notifications::READ,
        Some(&json!({ "ids": ["record-1", 7] })),
    );
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.body["error"], "ids must be an array of strings");

    let read = route_project_service_request(
        &context,
        "POST",
        routes::notifications::READ,
        Some(&json!({ "id": "record-2" })),
    );
    assert_eq!(read.status, 200);
    assert_eq!(read.body, json!({ "ok": true, "updated": 1 }));

    let clear = route_project_service_request(
        &context,
        "POST",
        routes::notifications::CLEAR,
        Some(&json!({ "id": "record-1" })),
    );
    assert_eq!(clear.status, 200);
    assert_eq!(clear.body, json!({ "ok": true, "cleared": 1 }));
    cleanup(project);
}

#[test]
fn missing_exchange_lists_empty_notifications_quietly() {
    let project = temp_project("missing-list");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", "/notifications", None);

    assert_eq!(response.status, 200);
    assert_eq!(response.body["notifications"], json!([]));
    assert_eq!(response.body["unreadCount"], 0);
    assert_eq!(response.body["total"], 0);
    cleanup(project);
}

#[test]
fn corrupt_exchange_makes_notification_routes_fail_instead_of_empty() {
    let project = temp_project("corrupt-routes");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    write(runtime_exchange_path(&state_dir), "version: [").expect("corrupt exchange");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let list = route_project_service_request(&context, "GET", "/notifications", None);
    assert_eq!(list.status, 500);
    assert!(
        list.body["error"]
            .as_str()
            .is_some_and(|error| error.contains("notification store unavailable")),
        "list must name unreadable notification store: {}",
        list.body
    );

    let read = route_project_service_request(
        &context,
        "POST",
        routes::notifications::READ,
        Some(&json!({ "id": "record-2" })),
    );
    assert_eq!(read.status, 500);
    assert!(
        read.body["error"]
            .as_str()
            .is_some_and(|error| error.contains("notification store unavailable")),
        "read must not report success over an unreadable store: {}",
        read.body
    );
    cleanup(project);
}

#[test]
fn notification_write_failure_is_reported_not_counted_successful() {
    let project = temp_project("write-failure");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    set_permissions(&state_dir, std::fs::Permissions::from_mode(0o500)).expect("lock state dir");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::notifications::CLEAR,
        Some(&json!({ "id": "record-1" })),
    );

    set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700)).expect("unlock state dir");
    assert_eq!(response.status, 500);
    assert_eq!(response.body["ok"], false);
    assert!(
        response.body["error"]
            .as_str()
            .is_some_and(|error| error.contains("failed to update notification store")),
        "write failure must be visible, not counted as cleared: {}",
        response.body
    );
    let snapshot = list_notification_snapshot(
        &state_dir,
        NotificationQuery {
            include_cleared: true,
            ..NotificationQuery::default()
        },
    );
    assert_eq!(snapshot.total, 2);
    cleanup(project);
}

fn seed_exchange(state_dir: &PathBuf) {
    write_runtime_exchange(
        runtime_exchange_path(state_dir),
        &json!({
            "version": 1,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "threads": [
                {
                    "id": "thread-1",
                    "title": "Needs input",
                    "kind": "conversation",
                    "status": "open",
                    "createdAt": "2026-01-01T00:00:01.000Z",
                    "updatedAt": "2026-01-01T00:00:03.000Z",
                    "createdBy": "aimux",
                    "participants": ["aimux", "codex-1"],
                    "tags": ["notification"]
                },
                {
                    "id": "thread-2",
                    "title": "Build done",
                    "kind": "conversation",
                    "status": "open",
                    "createdAt": "2026-01-01T00:00:02.000Z",
                    "updatedAt": "2026-01-01T00:00:04.000Z",
                    "createdBy": "aimux",
                    "participants": ["aimux", "codex-2"],
                    "tags": ["notification"]
                },
                {
                    "id": "thread-other",
                    "title": "Workflow",
                    "kind": "conversation",
                    "status": "open",
                    "createdAt": "2026-01-01T00:00:05.000Z",
                    "updatedAt": "2026-01-01T00:00:05.000Z",
                    "createdBy": "user",
                    "participants": ["user", "codex-1"],
                    "tags": []
                }
            ],
            "messages": [
                {
                    "id": "message-1",
                    "threadId": "thread-1",
                    "ts": "2026-01-01T00:00:01.000Z",
                    "from": "aimux",
                    "to": ["codex-1"],
                    "kind": "note",
                    "body": "old body",
                    "metadata": {
                        "notificationRecordId": "record-1",
                        "notificationSessionId": "codex-1",
                        "notificationTargetKey": "session:codex-1",
                        "notificationTargetKind": "session"
                    }
                },
                {
                    "id": "message-2",
                    "threadId": "thread-2",
                    "ts": "2026-01-01T00:00:04.000Z",
                    "from": "aimux",
                    "to": ["codex-2"],
                    "kind": "note",
                    "body": "new body",
                    "metadata": {
                        "notificationRecordId": "record-2",
                        "notificationSessionId": "codex-2",
                        "notificationTargetKey": "session:codex-2",
                        "notificationTargetKind": "session",
                        "notificationKind": "needs_input",
                        "notificationInteractionId": "interact-2",
                        "notificationInteractionType": "permission",
                        "notificationInteractionSummary": "Allow command",
                        "notificationInteractionTelemetry": true
                    }
                },
                {
                    "id": "message-other",
                    "threadId": "thread-other",
                    "ts": "2026-01-01T00:00:05.000Z",
                    "from": "user",
                    "to": ["codex-1"],
                    "kind": "request",
                    "body": "not a notification"
                }
            ],
            "tasks": [],
            "handoffs": [],
            "reviews": [],
            "waits": [],
            "inbox": [
                {
                    "id": "inbox:codex-1:thread:thread-1",
                    "participantId": "codex-1",
                    "subjectKind": "thread",
                    "subjectId": "thread-1",
                    "state": "done",
                    "urgency": 0,
                    "updatedAt": "2026-01-01T00:00:03.000Z"
                },
                {
                    "id": "inbox:codex-2:thread:thread-2",
                    "participantId": "codex-2",
                    "subjectKind": "thread",
                    "subjectId": "thread-2",
                    "state": "unread",
                    "urgency": 3,
                    "updatedAt": "2026-01-01T00:00:04.000Z"
                }
            ],
            "planRefs": [],
            "continuityRefs": [],
            "attachmentRefs": []
        }),
    )
    .expect("seed runtime exchange");
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-notifications-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
