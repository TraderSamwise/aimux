use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::coordination_worklist::{
    build_coordination_thread_entries, build_coordination_view, is_notification_stale,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{runtime_exchange_path, write_runtime_exchange};
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

mod support;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn builds_translation_first_coordination_buckets_and_sort_order() {
    let sessions = vec![
        json!({
            "id": "live",
            "status": "running",
            "semantic": {
                "user": { "label": "needs_input" },
                "presentation": { "attentionScore": 4 }
            }
        }),
        json!({
            "id": "moved-on",
            "status": "running",
            "semantic": {
                "user": { "label": "working" },
                "presentation": { "attentionScore": 0 }
            }
        }),
        json!({ "id": "cold", "status": "offline" }),
    ];
    let notifications = vec![
        notification("live-notice", Some("live"), "2026-01-04T00:00:00.000Z"),
        notification("cold-notice", Some("cold"), "2026-01-03T00:00:00.000Z"),
        notification("stale-notice", Some("moved-on"), "2026-01-02T00:00:00.000Z"),
        notification("ghost-notice", Some("ghost"), "2026-01-01T00:00:00.000Z"),
    ];
    let threads = vec![json!({
        "thread": {
            "id": "task-1",
            "kind": "task",
            "participants": ["live"],
            "waitingOn": ["user"],
            "updatedAt": "2026-01-05T00:00:00.000Z"
        },
        "displayTitle": "Ship release",
        "pendingDeliveries": 0,
        "urgency": 10
    })];

    let view = build_coordination_view(&sessions, &[], &[], &notifications, &threads, "user");
    let items = view["worklist"]["items"].as_array().unwrap();

    assert_eq!(
        keys(items),
        vec![
            "n:live".to_owned(),
            "t:task-1".to_owned(),
            "n:cold".to_owned(),
            "n:moved-on".to_owned(),
            "n:ghost".to_owned(),
        ]
    );
    assert_eq!(find(items, "n:live")["bucket"], "awake");
    assert_eq!(find(items, "n:cold")["bucket"], "asleep");
    assert_eq!(find(items, "n:moved-on")["bucket"], "handled");
    assert_eq!(find(items, "n:moved-on")["stale"], true);
    assert_eq!(find(items, "n:ghost")["bucket"], "unreachable");
    assert_eq!(view["worklist"]["needsYou"].as_array().unwrap().len(), 3);
    assert_eq!(view["worklist"]["tail"].as_array().unwrap().len(), 2);
    assert!(is_notification_stale(Some("working"), true));
    assert!(!is_notification_stale(Some("needs_response"), true));
}

#[test]
fn builds_read_only_thread_entries_with_task_family_and_pending_delivery_parity() {
    let exchange = exchange_fixture();
    let entries = build_coordination_thread_entries(&exchange, "sam");

    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry["thread"]["id"], "task-thread");
    assert_eq!(entry["displayTitle"], "Fix idle CPU");
    assert_eq!(entry["pendingDeliveries"], 1);
    assert_eq!(entry["latestPendingRecipients"], json!(["sam"]));
    assert_eq!(entry["urgency"], 19);
    assert_eq!(entry["stateLabel"], "on me");
    assert_eq!(entry["task"]["id"], "task-1");
    assert_eq!(entry["familyRootTaskId"], "task-1");
    assert_eq!(entry["familyTaskIds"], json!(["task-1", "review-1"]));
}

#[test]
fn route_keeps_live_cold_teammate_service_and_missing_targets_visible() {
    let project = temp_project("route");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&topology_fixture()).unwrap(),
    )
    .unwrap();
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "live".into(),
                    json!({
                        "derived": { "activity": "running", "attention": "needs_input" },
                        "updatedAt": "2026-01-01T00:00:00.000Z"
                    }),
                ),
                (
                    "teammate".into(),
                    json!({
                        "derived": { "attention": "needs_response" },
                        "updatedAt": "2026-01-01T00:00:00.000Z"
                    }),
                ),
            ]),
        },
    )
    .unwrap();
    write_runtime_exchange(runtime_exchange_path(&state_dir), &exchange_fixture()).unwrap();

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_live_window_ids(support::live_window_ids(&["@1", "@2"]));
    let response = route_project_service_request(
        &context,
        "GET",
        &format!("{}?participant=sam", routes::COORDINATION_WORKLIST),
        None,
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert!(response.body["serviceInfo"].is_object());
    let items = response.body["worklist"]["items"].as_array().unwrap();
    assert_eq!(find(items, "n:live")["reachability"], "live");
    assert_eq!(find(items, "n:cold")["bucket"], "asleep");
    assert_eq!(find(items, "n:teammate")["reachability"], "live");
    assert_eq!(find(items, "n:service")["reachability"], "live");
    assert_eq!(find(items, "n:ghost")["bucket"], "unreachable");
    assert!(items.iter().any(|item| item["key"] == "t:task-thread"));
    assert_eq!(response.body["threads"].as_array().unwrap().len(), 1);
    cleanup(project);
}

fn topology_fixture() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "aimux",
            "projectRoot": "/repo",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "nodes": [
            { "id": "node-live", "rigId": "rig-1", "logicalId": "live", "toolConfigKey": "codex", "cwd": "/repo", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-cold", "rigId": "rig-1", "logicalId": "cold", "toolConfigKey": "codex", "cwd": "/repo", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-teammate", "rigId": "rig-1", "logicalId": "teammate", "toolConfigKey": "codex", "cwd": "/repo", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-service", "rigId": "rig-1", "logicalId": "service", "toolConfigKey": "shell", "cwd": "/repo", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-live", "nodeId": "node-live", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "binding-teammate", "nodeId": "node-teammate", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "live", "nodeId": "node-live", "status": "running", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "cold", "nodeId": "node-cold", "status": "offline", "command": "codex", "backendSessionId": "backend-cold", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "teammate", "nodeId": "node-teammate", "status": "idle", "command": "codex", "team": { "parentSessionId": "live", "role": "reviewer" }, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "services": [{
            "id": "service",
            "rigId": "rig-1",
            "nodeId": "node-service",
            "status": "running",
            "command": "shell",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap()
}

fn exchange_fixture() -> Value {
    let targets = ["live", "cold", "teammate", "service", "ghost"];
    let mut threads = targets
        .iter()
        .enumerate()
        .map(|(index, target)| {
            json!({
                "id": format!("notice-{target}"),
                "title": format!("Needs {target}"),
                "kind": "conversation",
                "status": "open",
                "createdAt": format!("2026-01-01T00:00:0{index}.000Z"),
                "updatedAt": format!("2026-01-01T00:00:0{index}.000Z"),
                "createdBy": "aimux",
                "participants": ["aimux", target],
                "tags": ["notification"]
            })
        })
        .collect::<Vec<_>>();
    threads.push(json!({
        "id": "task-thread",
        "title": "Fix idle CPU",
        "kind": "task",
        "status": "open",
        "createdAt": "2026-01-01T00:00:10.000Z",
        "updatedAt": "2026-01-01T00:00:10.000Z",
        "createdBy": "live",
        "participants": ["live", "sam"],
        "owner": "live",
        "waitingOn": ["sam"],
        "unreadBy": ["sam"],
        "taskId": "task-1",
        "tags": []
    }));
    let mut messages = targets
        .iter()
        .enumerate()
        .map(|(index, target)| {
            json!({
                "id": format!("message-{target}"),
                "threadId": format!("notice-{target}"),
                "ts": format!("2026-01-01T00:00:0{index}.000Z"),
                "from": "aimux",
                "to": [target],
                "kind": "note",
                "body": "Input required",
                "metadata": {
                    "notificationRecordId": format!("record-{target}"),
                    "notificationSessionId": target,
                    "notificationKind": "needs_input"
                }
            })
        })
        .collect::<Vec<_>>();
    messages.push(json!({
        "id": "task-message",
        "threadId": "task-thread",
        "ts": "2026-01-01T00:00:10.000Z",
        "from": "live",
        "to": ["sam"],
        "deliveredTo": [],
        "kind": "request",
        "body": "Review the cut"
    }));
    let inbox = targets
        .iter()
        .map(|target| {
            json!({
                "id": format!("inbox-{target}"),
                "participantId": target,
                "subjectKind": "thread",
                "subjectId": format!("notice-{target}"),
                "state": "unread",
                "urgency": 3,
                "updatedAt": "2026-01-01T00:00:00.000Z"
            })
        })
        .collect::<Vec<_>>();
    json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:10.000Z",
        "threads": threads,
        "messages": messages,
        "tasks": [
            { "id": "task-1", "status": "assigned", "assignedBy": "live", "assignedTo": "sam", "description": "Fix idle CPU", "threadId": "task-thread", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:10.000Z" },
            { "id": "review-1", "status": "pending", "reviewOf": "task-1", "createdAt": "2026-01-01T00:00:01.000Z", "updatedAt": "2026-01-01T00:00:01.000Z" }
        ],
        "handoffs": [],
        "reviews": [],
        "waits": [],
        "inbox": inbox,
        "planRefs": [],
        "continuityRefs": [],
        "attachmentRefs": []
    })
}

fn notification(id: &str, session_id: Option<&str>, created_at: &str) -> Value {
    let mut value = json!({
        "id": id,
        "title": id,
        "body": "body",
        "kind": "needs_input",
        "unread": true,
        "cleared": false,
        "createdAt": created_at,
        "updatedAt": created_at
    });
    if let Some(session_id) = session_id {
        value["sessionId"] = Value::String(session_id.to_owned());
    }
    value
}

fn keys(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|item| item["key"].as_str().unwrap().to_owned())
        .collect()
}

fn find<'a>(items: &'a [Value], key: &str) -> &'a Value {
    items
        .iter()
        .find(|item| item["key"] == key)
        .unwrap_or_else(|| panic!("missing item {key}"))
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-project-service-coordination-worklist-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
