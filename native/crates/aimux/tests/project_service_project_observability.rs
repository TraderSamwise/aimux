use aimux::project_api_contract::routes;
use aimux::project_service::project_observability::{
    ProjectObservabilityInput, build_project_observability,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{runtime_exchange_path, write_runtime_exchange};
use serde_json::{Value, json};
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn rolls_up_agent_service_worktree_task_notification_summary() {
    let project = build_project_observability(ProjectObservabilityInput {
        sessions: vec![
            json!({ "id": "running", "status": "running" }),
            json!({ "id": "idle", "status": "idle" }),
            json!({ "id": "ready", "status": "ready" }),
            json!({ "id": "waiting", "status": "waiting" }),
            json!({ "id": "offline", "status": "offline" }),
            json!({ "id": "exited", "status": "exited" }),
        ],
        services: vec![json!({ "id": "svc-1" }), json!({ "id": "svc-2" })],
        worktrees: vec![json!({ "name": "main" })],
        tasks: vec![
            json!({ "id": "pending", "status": "pending" }),
            json!({ "id": "done", "status": "done" }),
            json!({ "id": "failed", "status": "failed" }),
            json!({ "id": "missing-status" }),
        ],
        notifications: vec![
            json!({ "id": "read", "unread": false }),
            json!({ "id": "unread", "unread": true }),
        ],
        notification_unread_count: None,
        story_limit: None,
    });

    assert_eq!(
        project["summary"],
        json!({
            "agentsRunning": 3,
            "agentsWaiting": 1,
            "agentsOffline": 2,
            "services": 2,
            "worktrees": 1,
            "openTasks": 2,
            "doneTasks": 1,
            "unreadNotifications": 1,
        })
    );
}

#[test]
fn counts_task_progress_by_status() {
    let project = build_project_observability(ProjectObservabilityInput {
        sessions: vec![],
        services: vec![],
        worktrees: vec![],
        tasks: vec![
            json!({ "id": "pending", "status": "pending" }),
            json!({ "id": "assigned", "status": "assigned" }),
            json!({ "id": "in-progress", "status": "in_progress" }),
            json!({ "id": "blocked", "status": "blocked" }),
            json!({ "id": "done", "status": "done" }),
            json!({ "id": "failed", "status": "failed" }),
            json!({ "id": "other", "status": "other" }),
        ],
        notifications: vec![],
        notification_unread_count: Some(7),
        story_limit: None,
    });

    assert_eq!(
        project["progress"],
        json!({
            "pending": 1,
            "assigned": 1,
            "in_progress": 1,
            "blocked": 1,
            "done": 1,
            "failed": 1,
            "total": 7,
        })
    );
    assert_eq!(project["summary"]["unreadNotifications"], 7);
}

#[test]
fn merges_tasks_and_notifications_into_story_sorted_newest_first() {
    let project = build_project_observability(ProjectObservabilityInput {
        sessions: vec![],
        services: vec![],
        worktrees: vec![],
        tasks: vec![
            json!({
                "id": "task-old",
                "description": "Old task",
                "prompt": "old prompt",
                "result": "old result",
                "status": "done",
                "assignedTo": "codex",
                "createdAt": "2026-01-01T00:00:01.000Z",
                "updatedAt": "2026-01-01T00:00:03.000Z"
            }),
            json!({
                "id": "task-new",
                "prompt": "Newest task",
                "error": "new error",
                "status": "failed",
                "createdAt": "2026-01-01T00:00:05.000Z"
            }),
        ],
        notifications: vec![json!({
            "id": "notif-mid",
            "title": "Middle notification",
            "kind": "needs_input",
            "sessionId": "claude",
            "body": "middle body",
            "createdAt": "2026-01-01T00:00:04.000Z",
            "unread": true
        })],
        notification_unread_count: None,
        story_limit: None,
    });

    let story = project["story"].as_array().unwrap();
    assert_eq!(story[0]["id"], "task:task-new");
    assert_eq!(story[0]["title"], "Newest task");
    assert_eq!(story[0]["body"], "new error");
    assert_eq!(story[1]["id"], "notif:notif-mid");
    assert_eq!(story[1]["meta"], "needs_input \u{00b7} claude");
    assert_eq!(story[1]["status"], "unread");
    assert_eq!(story[2]["id"], "task:task-old");
    assert_eq!(story[2]["title"], "Old task");
    assert_eq!(story[2]["meta"], "done \u{00b7} codex");
    assert_eq!(story[2]["createdAt"], "2026-01-01T00:00:03.000Z");
}

#[test]
fn tags_review_tasks_and_caps_story_limit() {
    let project = build_project_observability(ProjectObservabilityInput {
        sessions: vec![],
        services: vec![],
        worktrees: vec![],
        tasks: vec![
            json!({
                "id": "review-1",
                "type": "review",
                "description": "Review the branch",
                "status": "pending",
                "createdAt": "2026-01-01T00:00:01.000Z"
            }),
            json!({
                "id": "task-2",
                "description": "Second task",
                "status": "pending",
                "createdAt": "2026-01-01T00:00:02.000Z"
            }),
        ],
        notifications: vec![],
        notification_unread_count: None,
        story_limit: Some(1),
    });

    let story = project["story"].as_array().unwrap();
    assert_eq!(story.len(), 1);
    assert_eq!(story[0]["id"], "task:task-2");
    assert_eq!(story[0]["kind"], "task");

    let uncapped = build_project_observability(ProjectObservabilityInput {
        story_limit: Some(2),
        ..ProjectObservabilityInput {
            sessions: vec![],
            services: vec![],
            worktrees: vec![],
            tasks: vec![json!({
                "id": "review-1",
                "type": "review",
                "description": "Review the branch",
                "status": "pending",
                "createdAt": "2026-01-01T00:00:01.000Z"
            })],
            notifications: vec![],
            notification_unread_count: None,
            story_limit: None,
        }
    });
    assert_eq!(uncapped["story"][0]["kind"], "review");
}

#[test]
fn route_serves_observability_from_desktop_state_runtime_exchange_and_notifications() {
    let project = temp_project("route");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_desktop_state(json!({
            "sessions": [
                { "id": "agent-running", "status": "running" },
            ],
            "teammates": [
                { "id": "agent-waiting", "status": "waiting" },
            ],
            "services": [
                { "id": "service-1", "status": "running" },
            ],
            "worktrees": [
                { "name": "main", "path": project.to_string_lossy() },
            ],
        }));

    let response =
        route_project_service_request(&context, "GET", routes::PROJECT_OBSERVABILITY, None);
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["project"]["summary"]["agentsRunning"], 1);
    assert_eq!(response.body["project"]["summary"]["agentsWaiting"], 1);
    assert_eq!(response.body["project"]["summary"]["services"], 1);
    assert_eq!(response.body["project"]["summary"]["worktrees"], 1);
    assert_eq!(response.body["project"]["summary"]["openTasks"], 1);
    assert_eq!(response.body["project"]["summary"]["doneTasks"], 1);
    assert_eq!(
        response.body["project"]["summary"]["unreadNotifications"],
        1
    );
    assert_story_contains(&response.body["project"], "task:task-open");
    assert_story_contains(&response.body["project"], "notif:notif-1");

    let derived = route_project_service_request(
        &ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir),
        "GET",
        routes::PROJECT_OBSERVABILITY,
        None,
    );
    assert_eq!(derived.status, 200);
    assert_eq!(derived.body["ok"], true);
    assert_eq!(derived.body["project"]["summary"]["agentsRunning"], 0);
    assert_eq!(derived.body["project"]["summary"]["services"], 0);
    assert_eq!(derived.body["project"]["summary"]["openTasks"], 1);
    assert_eq!(derived.body["project"]["summary"]["doneTasks"], 1);
    cleanup(project);
}

fn assert_story_contains(project: &Value, id: &str) {
    assert!(
        project["story"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == id),
        "expected story to contain {id}"
    );
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
                    "createdAt": "2026-01-01T00:00:04.000Z",
                    "updatedAt": "2026-01-01T00:00:04.000Z",
                    "createdBy": "aimux",
                    "participants": ["aimux", "agent-waiting"],
                    "tags": ["notification"]
                }
            ],
            "messages": [
                {
                    "id": "message-1",
                    "threadId": "thread-1",
                    "ts": "2026-01-01T00:00:04.000Z",
                    "from": "aimux",
                    "to": ["agent-waiting"],
                    "kind": "note",
                    "body": "Need approval",
                    "metadata": {
                        "notificationRecordId": "notif-1",
                        "notificationSessionId": "agent-waiting",
                        "notificationTargetKey": "session:agent-waiting",
                        "notificationTargetKind": "session",
                        "notificationKind": "needs_input"
                    }
                }
            ],
            "tasks": [
                {
                    "id": "task-open",
                    "description": "Open task",
                    "status": "in_progress",
                    "createdAt": "2026-01-01T00:00:03.000Z"
                },
                {
                    "id": "task-done",
                    "description": "Done task",
                    "status": "done",
                    "createdAt": "2026-01-01T00:00:02.000Z"
                }
            ],
            "handoffs": [],
            "reviews": [],
            "waits": [],
            "inbox": [
                {
                    "id": "inbox:agent-waiting:thread:thread-1",
                    "participantId": "agent-waiting",
                    "subjectKind": "thread",
                    "subjectId": "thread-1",
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
        "aimux-rust-project-service-observability-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
