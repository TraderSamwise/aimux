use aimux::project_service::notifications::{
    NotificationMutation, NotificationQuery, clear_notifications, list_notification_snapshot,
    mark_notifications_read,
};
use aimux::project_service::runtime_exchange::{
    read_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use serde_json::{Value, json};
use std::fs::{create_dir_all, remove_dir_all};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const NOTIFICATIONS_STORE: &str =
    include_str!("../../../../testdata/contracts/v1/notifications/store.json");

struct TestProject {
    root: PathBuf,
    state_dir: PathBuf,
}

impl TestProject {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-notifications-store-fixture-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        let state_dir = root.join("state");
        create_dir_all(&state_dir).expect("create state dir");
        write_runtime_exchange(runtime_exchange_path(&state_dir), &seed_exchange())
            .expect("seed exchange");
        Self { root, state_dir }
    }
}

impl Drop for TestProject {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.root);
    }
}

#[test]
fn fixture_notifications_store_matches_typescript() {
    let contract: Value = serde_json::from_str(NOTIFICATIONS_STORE).expect("valid fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("notification store cases");
    assert_eq!(cases.len(), 5, "unexpected notifications-store case count");
    let mut failures = Vec::new();
    for case in cases {
        let project = TestProject::new(case["input"]["scenario"].as_str().unwrap_or("case"));
        let actual = run_case(&project, &case["input"]);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} notifications-store parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(project: &TestProject, input: &Value) -> Value {
    match input["scenario"].as_str().unwrap_or_default() {
        "list" => snapshot_value(list_notification_snapshot(
            &project.state_dir,
            NotificationQuery {
                limit: Some(10),
                ..NotificationQuery::default()
            },
        )),
        "filter-unread-session-limit" => snapshot_value(list_notification_snapshot(
            &project.state_dir,
            NotificationQuery {
                unread_only: true,
                session_id: Some("codex-2".into()),
                limit: Some(1),
                ..NotificationQuery::default()
            },
        )),
        "mark-read" => {
            let updated = mark_notifications_read(
                &project.state_dir,
                NotificationMutation {
                    id: Some("record-2".into()),
                    session_id: Some("codex-2".into()),
                    ..NotificationMutation::default()
                },
            );
            let exchange = read_runtime_exchange(runtime_exchange_path(&project.state_dir));
            json!({
                "updated": updated,
                "inbox": exchange["inbox"],
                "snapshot": snapshot_value(list_notification_snapshot(&project.state_dir, NotificationQuery::default())),
            })
        }
        "clear" => {
            let cleared = clear_notifications(
                &project.state_dir,
                NotificationMutation {
                    ids: Some(vec!["record-1".into(), "record-2".into()]),
                    ..NotificationMutation::default()
                },
            );
            let exchange = read_runtime_exchange(runtime_exchange_path(&project.state_dir));
            json!({
                "cleared": cleared,
                "messages": exchange["messages"],
                "snapshot": snapshot_value(list_notification_snapshot(&project.state_dir, NotificationQuery::default())),
                "includeCleared": snapshot_value(list_notification_snapshot(
                    &project.state_dir,
                    NotificationQuery { include_cleared: true, ..NotificationQuery::default() },
                )),
            })
        }
        "unread-count" => json!({
            "all": unread_count(&project.state_dir, None),
            "codex1": unread_count(&project.state_dir, Some("codex-1")),
            "codex2": unread_count(&project.state_dir, Some("codex-2")),
        }),
        scenario => json!({ "error": format!("unknown scenario: {scenario}") }),
    }
}

fn unread_count(state_dir: &Path, session_id: Option<&str>) -> usize {
    list_notification_snapshot(
        state_dir,
        NotificationQuery {
            unread_only: true,
            session_id: session_id.map(str::to_owned),
            ..NotificationQuery::default()
        },
    )
    .notifications
    .len()
}

fn snapshot_value(snapshot: aimux::project_service::notifications::NotificationSnapshot) -> Value {
    let mut value = json!({
        "notifications": snapshot.notifications,
        "total": snapshot.total,
        "unreadCount": snapshot.unread_count,
        "truncated": snapshot.truncated,
    });
    if let Some(limit) = snapshot.limit {
        value["limit"] = Value::from(limit);
    }
    value
}

fn seed_exchange() -> Value {
    json!({
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
    })
}
