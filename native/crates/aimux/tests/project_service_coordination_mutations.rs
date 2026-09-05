use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::AgentOutputCaptureRuntime;
use aimux::project_service::coordination_mutations::route_coordination_mutation_request_with_runtime;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{
    read_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use aimux::project_service::team::save_team_config;
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use aimux::tmux::CapturePaneOptions;
use serde_json::{Value, json};
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct FakeDeliveryRuntime {
    actions: Vec<FakeRuntimeAction>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FakeRuntimeAction {
    Capture(String),
    Resize(String, i64, i64),
    Text(String, String),
    Key(String, String),
    CarriageReturn(String),
    Escape(String),
}

impl AgentOutputCaptureRuntime for FakeDeliveryRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        _options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.actions
            .push(FakeRuntimeAction::Capture(window_id.to_owned()));
        Ok(String::new())
    }

    fn resize_window(&mut self, window_id: &str, cols: i64, rows: i64) -> Result<(), String> {
        self.actions
            .push(FakeRuntimeAction::Resize(window_id.to_owned(), cols, rows));
        Ok(())
    }

    fn send_text(&mut self, window_id: &str, text: &str) -> Result<(), String> {
        self.actions.push(FakeRuntimeAction::Text(
            window_id.to_owned(),
            text.to_owned(),
        ));
        Ok(())
    }

    fn send_key(&mut self, window_id: &str, key: &str) -> Result<(), String> {
        self.actions
            .push(FakeRuntimeAction::Key(window_id.to_owned(), key.to_owned()));
        Ok(())
    }

    fn send_carriage_return(&mut self, window_id: &str) -> Result<(), String> {
        self.actions
            .push(FakeRuntimeAction::CarriageReturn(window_id.to_owned()));
        Ok(())
    }

    fn send_escape(&mut self, window_id: &str) -> Result<(), String> {
        self.actions
            .push(FakeRuntimeAction::Escape(window_id.to_owned()));
        Ok(())
    }
}

#[test]
fn task_assign_creates_thread_message_and_derived_indexes() {
    let project = temp_project("task-assign");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::tasks::ASSIGN,
        Some(&json!({
            "from": "claude-lead",
            "to": "codex-worker",
            "description": "Audit the parser failure path",
            "worktreePath": "/repo/wt"
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["task"]["status"], "pending");
    assert_eq!(response.body["task"]["assignedBy"], "claude-lead");
    assert_eq!(response.body["task"]["assignedTo"], "codex-worker");
    assert_eq!(
        response.body["task"]["prompt"],
        "Audit the parser failure path"
    );
    assert_eq!(response.body["thread"]["kind"], "task");
    assert_eq!(
        response.body["thread"]["waitingOn"],
        json!(["codex-worker"])
    );
    assert_eq!(response.body["message"]["kind"], "request");
    assert_eq!(response.body["message"]["to"], json!(["codex-worker"]));
    assert_eq!(
        response.body["message"]["metadata"]["taskAction"],
        "assigned"
    );

    let exchange = read_exchange(&state_dir);
    assert_eq!(exchange["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(exchange["threads"].as_array().unwrap().len(), 1);
    assert_eq!(exchange["messages"].as_array().unwrap().len(), 1);
    assert!(
        exchange["waits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|wait| wait["subjectKind"] == "task"
                && wait["waitingOn"] == json!(["codex-worker"]))
    );
    assert!(
        exchange["inbox"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["participantId"] == "codex-worker" && entry["state"] == "waiting")
    );
    cleanup(project);
}

#[test]
fn task_assignment_delivers_to_live_session_and_records_message_delivery() {
    let project = temp_project("task-assignment-delivery");
    let state_dir = project.join("state");
    write_delivery_topology(&state_dir, &[("codex-worker", "@worker")]);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeDeliveryRuntime::default();

    let response = route_coordination_mutation_request_with_runtime(
        &context,
        "POST",
        routes::tasks::ASSIGN,
        Some(&json!({
            "from": "claude-lead",
            "to": "codex-worker",
            "description": "Audit the parser failure path",
            "prompt": "Run the focused parser checks."
        })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body["deliveredTo"], json!(["codex-worker"]));

    let delivered_text = text_sent_to(&runtime, "@worker");
    assert!(delivered_text.contains("[aimux task assigned]"));
    assert!(delivered_text.contains("Task id:"));
    assert!(delivered_text.contains("Run the focused parser checks."));
    assert!(delivered_text.contains("aimux task accept"));
    assert!(
        runtime
            .actions
            .contains(&FakeRuntimeAction::CarriageReturn("@worker".into()))
    );

    let exchange = read_exchange(&state_dir);
    let message_id = response.body["message"]["id"].as_str().unwrap();
    let message = exchange["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["id"] == message_id)
        .unwrap();
    assert_eq!(message["deliveredTo"], json!(["codex-worker"]));
    assert!(message["deliveredAt"].as_str().is_some());
    cleanup(project);
}

#[test]
fn task_lifecycle_updates_task_thread_and_indexes() {
    let project = temp_project("task-lifecycle");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let created = route_project_service_request(
        &context,
        "POST",
        routes::tasks::ASSIGN,
        Some(&json!({
            "from": "claude-lead",
            "to": "codex-worker",
            "description": "Audit lifecycle"
        })),
    );
    let task_id = created.body["task"]["id"].as_str().unwrap().to_owned();

    let accepted = route_project_service_request(
        &context,
        "POST",
        routes::tasks::ACCEPT,
        Some(&json!({ "taskId": task_id, "from": "codex-worker" })),
    );
    assert_eq!(accepted.status, 200);
    assert_eq!(accepted.body["task"]["status"], "in_progress");
    assert_eq!(accepted.body["thread"]["status"], "open");
    assert_eq!(
        accepted.body["message"]["metadata"]["taskAction"],
        "accepted"
    );

    let blocked = route_project_service_request(
        &context,
        "POST",
        routes::tasks::BLOCK,
        Some(&json!({
            "taskId": task_id,
            "from": "codex-worker",
            "body": "Need a failing reproduction case."
        })),
    );
    assert_eq!(blocked.status, 200);
    assert_eq!(blocked.body["task"]["status"], "blocked");
    assert_eq!(blocked.body["thread"]["status"], "blocked");
    assert_eq!(blocked.body["thread"]["waitingOn"], json!(["claude-lead"]));
    assert_eq!(blocked.body["message"]["metadata"]["taskAction"], "blocked");

    let completed = route_project_service_request(
        &context,
        "POST",
        routes::tasks::COMPLETE,
        Some(&json!({
            "taskId": task_id,
            "from": "codex-worker",
            "body": "Found and fixed the timeout branch."
        })),
    );
    assert_eq!(completed.status, 200);
    assert_eq!(completed.body["task"]["status"], "done");
    assert_eq!(
        completed.body["task"]["result"],
        "Found and fixed the timeout branch."
    );
    assert_eq!(completed.body["thread"]["status"], "waiting");
    assert_eq!(
        completed.body["thread"]["waitingOn"],
        json!(["claude-lead"])
    );
    assert_eq!(
        completed.body["message"]["metadata"]["taskAction"],
        "completed"
    );

    let exchange = read_exchange(&state_dir);
    assert!(
        exchange["inbox"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |entry| entry["participantId"] == "claude-lead" && entry["subjectKind"] == "thread"
            )
    );

    let thread_id = created.body["thread"]["id"].as_str().unwrap().to_owned();
    let rework = route_project_service_request(
        &context,
        "POST",
        routes::threads::SEND,
        Some(&json!({
            "threadId": thread_id,
            "from": "claude-lead",
            "to": ["codex-worker"],
            "kind": "reply",
            "body": "Three blockers remain; please fix them before commit."
        })),
    );
    assert_eq!(rework.status, 200);
    let exchange = read_exchange(&state_dir);
    let task = exchange["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == task_id)
        .unwrap();
    assert_eq!(task["status"], "pending");
    assert_eq!(task["assignedBy"], "claude-lead");
    assert_eq!(
        task["error"],
        "Three blockers remain; please fix them before commit."
    );
    assert!(task["notifiedAt"].is_null());
    cleanup(project);
}

#[test]
fn thread_send_delivers_to_each_live_recipient_with_recipient_reply_actions() {
    let project = temp_project("thread-delivery");
    let state_dir = project.join("state");
    write_delivery_topology(&state_dir, &[("codex-one", "@one"), ("codex-two", "@two")]);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let opened = route_project_service_request(
        &context,
        "POST",
        routes::threads::OPEN,
        Some(&json!({
            "from": "claude-lead",
            "title": "Coordination",
            "participants": ["codex-one", "codex-two"]
        })),
    );
    assert_eq!(opened.status, 200);
    let thread_id = opened.body["thread"]["id"].as_str().unwrap().to_owned();
    let mut runtime = FakeDeliveryRuntime::default();

    let sent = route_coordination_mutation_request_with_runtime(
        &context,
        "POST",
        routes::threads::SEND,
        Some(&json!({
            "threadId": thread_id,
            "from": "claude-lead",
            "to": ["codex-one", "codex-two"],
            "kind": "request",
            "body": "Please inspect this."
        })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(sent.status, 200);
    assert_eq!(sent.body["deliveredTo"], json!(["codex-one", "codex-two"]));

    let one_text = text_sent_to(&runtime, "@one");
    let two_text = text_sent_to(&runtime, "@two");
    assert!(one_text.contains("[aimux message]"));
    assert!(one_text.contains("Please inspect this."));
    assert!(one_text.contains("--from codex-one"));
    assert!(two_text.contains("[aimux message]"));
    assert!(two_text.contains("--from codex-two"));
    assert!(
        runtime
            .actions
            .contains(&FakeRuntimeAction::CarriageReturn("@one".into()))
    );
    assert!(
        runtime
            .actions
            .contains(&FakeRuntimeAction::CarriageReturn("@two".into()))
    );

    let exchange = read_exchange(&state_dir);
    let message_id = sent.body["message"]["id"].as_str().unwrap();
    let message = exchange["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["id"] == message_id)
        .unwrap();
    assert_eq!(message["deliveredTo"], json!(["codex-one", "codex-two"]));
    cleanup(project);
}

#[test]
fn handoff_send_accept_complete_updates_derived_handoffs() {
    let project = temp_project("handoff");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let sent = route_project_service_request(
        &context,
        "POST",
        routes::handoff::SEND,
        Some(&json!({
            "from": "claude-lead",
            "to": ["codex-worker"],
            "body": "Take over the UI debug pass.",
            "title": "UI handoff"
        })),
    );
    assert_eq!(sent.status, 200);
    assert_eq!(sent.body["thread"]["kind"], "handoff");
    assert_eq!(sent.body["thread"]["waitingOn"], json!(["codex-worker"]));
    assert_eq!(sent.body["message"]["kind"], "handoff");
    let thread_id = sent.body["thread"]["id"].as_str().unwrap().to_owned();

    let accepted = route_project_service_request(
        &context,
        "POST",
        routes::handoff::ACCEPT,
        Some(&json!({ "threadId": thread_id, "from": "codex-worker" })),
    );
    assert_eq!(accepted.status, 200);
    assert_eq!(accepted.body["thread"]["owner"], "codex-worker");
    assert_eq!(accepted.body["thread"]["waitingOn"], json!([]));
    assert_eq!(
        accepted.body["message"]["metadata"]["handoffAction"],
        "accepted"
    );

    let exchange = read_exchange(&state_dir);
    assert_eq!(exchange["handoffs"][0]["status"], "accepted");
    assert_eq!(exchange["handoffs"][0]["acceptedBy"], "codex-worker");

    let completed = route_project_service_request(
        &context,
        "POST",
        routes::handoff::COMPLETE,
        Some(&json!({ "threadId": thread_id, "from": "codex-worker" })),
    );
    assert_eq!(completed.status, 200);
    assert_eq!(completed.body["thread"]["status"], "waiting");
    assert_eq!(
        completed.body["thread"]["waitingOn"],
        json!(["claude-lead"])
    );
    assert_eq!(
        completed.body["message"]["metadata"]["handoffAction"],
        "completed"
    );

    let exchange = read_exchange(&state_dir);
    assert_eq!(exchange["handoffs"][0]["status"], "completed");
    assert_eq!(exchange["handoffs"][0]["completedBy"], "codex-worker");
    cleanup(project);
}

#[test]
fn review_approve_request_changes_and_reopen_workflow() {
    let project = temp_project("review");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let approved_review = route_project_service_request(
        &context,
        "POST",
        routes::tasks::ASSIGN,
        Some(&json!({
            "from": "claude-lead",
            "to": "codex-reviewer",
            "description": "Review the parser fix",
            "type": "review"
        })),
    );
    let approved_id = approved_review.body["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let approved = route_project_service_request(
        &context,
        "POST",
        routes::reviews::APPROVE,
        Some(&json!({
            "taskId": approved_id,
            "from": "codex-reviewer",
            "body": "Looks good."
        })),
    );
    assert_eq!(approved.status, 200);
    assert_eq!(approved.body["task"]["status"], "done");
    assert_eq!(approved.body["task"]["reviewStatus"], "approved");
    assert_eq!(approved.body["thread"]["status"], "waiting");

    let changes_review = route_project_service_request(
        &context,
        "POST",
        routes::tasks::ASSIGN,
        Some(&json!({
            "from": "claude-lead",
            "to": "codex-reviewer",
            "description": "Review follow-up parser fix",
            "type": "review"
        })),
    );
    let changes_id = changes_review.body["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let changes = route_project_service_request(
        &context,
        "POST",
        routes::reviews::REQUEST_CHANGES,
        Some(&json!({
            "taskId": changes_id,
            "from": "codex-reviewer",
            "body": "Please tighten timeout assertions."
        })),
    );
    assert_eq!(changes.status, 200);
    assert_eq!(changes.body["task"]["reviewStatus"], "changes_requested");
    assert_eq!(changes.body["followUpTask"]["status"], "pending");

    let reopened = route_project_service_request(
        &context,
        "POST",
        routes::tasks::REOPEN,
        Some(&json!({
            "taskId": changes_id,
            "from": "claude-lead",
            "body": "Retry with the latest patch."
        })),
    );
    assert_eq!(reopened.status, 200);
    assert_eq!(reopened.body["task"]["status"], "pending");
    assert_ne!(reopened.body["task"]["id"], changes_id);
    assert_eq!(reopened.body["task"]["reviewOf"], changes_id);

    let exchange = read_exchange(&state_dir);
    assert_eq!(exchange["reviews"].as_array().unwrap().len(), 2);
    assert!(
        exchange["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .any(|review| review["status"] == "changes_requested")
    );
    cleanup(project);
}

#[test]
fn task_completion_creates_review_task_from_team_config() {
    let project = temp_project("auto-review");
    let state_dir = project.join("state");
    save_team_config(
        &project,
        &json!({
            "defaultRole": "builder",
            "roles": {
                "builder": { "description": "Build", "reviewedBy": "reviewer", "canEdit": true },
                "reviewer": { "description": "Review", "canEdit": false }
            }
        }),
    )
    .expect("seed team config");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    create_dir_all(&state_dir).expect("state dir");
    write_runtime_exchange(
        runtime_exchange_path(&state_dir),
        &json!({
            "version": 1,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "threads": [],
            "messages": [],
            "tasks": [{
                "id": "task-reviewed",
                "status": "in_progress",
                "assignedBy": "claude-lead",
                "assignedTo": "codex-worker",
                "assignee": "builder",
                "assigner": "builder",
                "description": "Implement parser",
                "prompt": "Implement parser",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "type": "task",
                "diff": "diff --git"
            }],
            "handoffs": [],
            "reviews": [],
            "waits": [],
            "inbox": [],
            "planRefs": [],
            "continuityRefs": [],
            "attachmentRefs": []
        }),
    )
    .expect("seed exchange");

    let completed = route_project_service_request(
        &context,
        "POST",
        routes::tasks::COMPLETE,
        Some(&json!({
            "taskId": "task-reviewed",
            "from": "codex-worker",
            "body": "Parser implementation complete."
        })),
    );
    assert_eq!(completed.status, 200);

    let exchange = read_exchange(&state_dir);
    let reviews = exchange["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|task| task["type"] == "review")
        .collect::<Vec<_>>();
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0]["status"], "pending");
    assert_eq!(reviews[0]["assignee"], "reviewer");
    assert_eq!(reviews[0]["assigner"], "builder");
    assert_eq!(reviews[0]["reviewOf"], "task-reviewed");
    assert_eq!(exchange["reviews"].as_array().unwrap().len(), 1);
    cleanup(project);
}

#[test]
fn mutation_preserves_malformed_exchange_file() {
    let project = temp_project("invalid-exchange");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    let path = runtime_exchange_path(&state_dir);
    write(&path, "version: 1\nthreads: [").expect("invalid exchange");
    let before = read_to_string(&path).expect("before");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::threads::OPEN,
        Some(&json!({
            "from": "user",
            "title": "Should not write",
            "participants": ["codex-worker"]
        })),
    );
    assert_eq!(response.status, 500);
    assert_eq!(read_to_string(&path).expect("after"), before);
    cleanup(project);
}

#[test]
fn thread_routes_send_mark_seen_and_set_status() {
    let project = temp_project("threads");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let opened = route_project_service_request(
        &context,
        "POST",
        routes::threads::OPEN,
        Some(&json!({
            "from": "user",
            "title": "Coordination",
            "participants": ["codex-worker"]
        })),
    );
    assert_eq!(opened.status, 200);
    let thread_id = opened.body["thread"]["id"].as_str().unwrap().to_owned();

    let sent = route_project_service_request(
        &context,
        "POST",
        routes::threads::SEND,
        Some(&json!({
            "threadId": thread_id,
            "from": "user",
            "to": ["codex-worker"],
            "kind": "request",
            "body": "Please inspect this."
        })),
    );
    assert_eq!(sent.status, 200);
    assert_eq!(sent.body["thread"]["waitingOn"], json!(["codex-worker"]));
    assert_eq!(sent.body["message"]["kind"], "request");

    let seen = route_project_service_request(
        &context,
        "POST",
        routes::threads::MARK_SEEN,
        Some(&json!({ "threadId": thread_id, "session": "codex-worker" })),
    );
    assert_eq!(seen.status, 200);
    assert!(
        !seen.body["thread"]["unreadBy"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "codex-worker")
    );

    let default_existing_thread_send = route_project_service_request(
        &context,
        "POST",
        routes::threads::SEND,
        Some(&json!({
            "threadId": thread_id,
            "from": "codex-worker",
            "body": "No explicit kind."
        })),
    );
    assert_eq!(default_existing_thread_send.status, 200);
    assert_eq!(default_existing_thread_send.body["message"]["kind"], "note");

    let default_direct_send = route_project_service_request(
        &context,
        "POST",
        routes::threads::SEND,
        Some(&json!({
            "from": "user",
            "to": ["codex-reviewer"],
            "body": "Direct no explicit kind."
        })),
    );
    assert_eq!(default_direct_send.status, 200);
    assert_eq!(default_direct_send.body["message"]["kind"], "request");
    assert_eq!(default_direct_send.body["threadCreated"], true);

    let status = route_project_service_request(
        &context,
        "POST",
        routes::threads::STATUS,
        Some(&json!({
            "threadId": thread_id,
            "status": "done",
            "owner": "user"
        })),
    );
    assert_eq!(status.status, 200);
    assert_eq!(status.body["thread"]["status"], "done");
    assert_eq!(status.body["thread"]["waitingOn"], json!([]));
    cleanup(project);
}

fn read_exchange(state_dir: &PathBuf) -> Value {
    read_runtime_exchange(runtime_exchange_path(state_dir))
}

fn write_delivery_topology(state_dir: &PathBuf, sessions: &[(&str, &str)]) {
    create_dir_all(state_dir).expect("state dir");
    let nodes = sessions
        .iter()
        .map(|(session_id, _window_id)| {
            json!({
                "id": format!("node-{session_id}"),
                "rigId": "rig-1",
                "logicalId": session_id,
                "toolConfigKey": "codex",
                "createdAt": "2026-01-01T00:00:00.000Z"
            })
        })
        .collect::<Vec<_>>();
    let topology_sessions = sessions
        .iter()
        .map(|(session_id, _window_id)| {
            json!({
                "id": session_id,
                "nodeId": format!("node-{session_id}"),
                "tool": "codex",
                "command": "codex",
                "args": [],
                "status": "running",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z"
            })
        })
        .collect::<Vec<_>>();
    let bindings = sessions
        .iter()
        .enumerate()
        .map(|(index, (session_id, window_id))| {
            json!({
                "id": format!("tmux:{session_id}"),
                "nodeId": format!("node-{session_id}"),
                "tmuxSession": "aimux",
                "tmuxWindowId": window_id,
                "tmuxWindowIndex": index as i64 + 1,
                "tmuxWindowName": session_id,
                "updatedAt": "2026-01-01T00:00:00.000Z"
            })
        })
        .collect::<Vec<_>>();
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": nodes,
        "edges": [],
        "bindings": bindings,
        "sessions": topology_sessions,
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology");
    write(
        runtime_topology_path(state_dir),
        serde_yaml::to_string(&topology).expect("topology yaml"),
    )
    .expect("write topology");
}

fn text_sent_to(runtime: &FakeDeliveryRuntime, window_id: &str) -> String {
    runtime
        .actions
        .iter()
        .filter_map(|action| match action {
            FakeRuntimeAction::Text(target, text) if target == window_id => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-coordination-mutations-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
