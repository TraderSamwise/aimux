use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::collaboration::{
    CLI_MESSAGE_SEND_TIMEOUT_MS, DaemonCollaborationTextRuntime, route_collaboration_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::worktrees::CLI_PROJECT_MUTATION_TIMEOUT_MS;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
struct Call {
    project: String,
    route_path: String,
    body: Option<Value>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Default)]
struct FakeCollaborationRuntime {
    calls: Vec<Call>,
    missing_thread: bool,
    missing_task: bool,
    invalid_message_thread_id: bool,
    invalid_message_id: bool,
    message_delivery_error: bool,
}

impl DaemonCollaborationTextRuntime for FakeCollaborationRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            project: project.into(),
            route_path: route_path.into(),
            body: None,
            timeout_ms: None,
        });
        match route_path {
            "/threads?session=claude-1" => ProjectServiceJsonResult::ok(
                "/repo",
                json!([{
                    "thread": {
                        "id": "thread-1",
                        "kind": "conversation",
                        "status": "open",
                        "title": "Hello",
                        "unreadBy": ["sam"],
                        "waitingOn": ["claude-1"]
                    },
                    "latestMessage": { "from": "sam", "kind": "note", "body": "hi" }
                }]),
            ),
            "/threads/thread-1" if !self.missing_thread => ProjectServiceJsonResult::ok(
                "/repo",
                json!({
                    "thread": {
                        "id": "thread-1",
                        "kind": "conversation",
                        "status": "open",
                        "title": "Hello",
                        "participants": ["sam", "claude-1"],
                        "owner": "sam",
                        "waitingOn": ["claude-1"]
                    },
                    "messages": [{ "ts": "now", "from": "sam", "kind": "note", "body": "hi" }]
                }),
            ),
            "/threads/missing" | "/threads/thread-1" => {
                ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "upstream\n"))
            }
            "/tasks?session=claude-1&status=todo" => ProjectServiceJsonResult::ok(
                "/repo",
                json!({
                    "ok": true,
                    "tasks": [{
                        "id": "task-1",
                        "type": "task",
                        "status": "todo",
                        "assignedTo": "claude-1",
                        "threadId": "thread-1",
                        "description": "Ship it"
                    }]
                }),
            ),
            "/tasks/task-1" if !self.missing_task => ProjectServiceJsonResult::ok(
                "/repo",
                json!({
                    "ok": true,
                    "task": {
                        "id": "task-1",
                        "type": "task",
                        "status": "todo",
                        "assignedBy": "sam",
                        "description": "Ship it",
                        "prompt": "do it"
                    },
                    "thread": { "id": "thread-1" },
                    "messages": []
                }),
            ),
            "/tasks/missing" | "/tasks/task-1" => {
                ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "upstream\n"))
            }
            _ => ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "not found\n")),
        }
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            project: project.into(),
            route_path: route_path.into(),
            body: Some(body.clone()),
            timeout_ms,
        });
        let response = match route_path {
            project_routes::threads::OPEN => {
                json!({ "thread": { "id": "thread-2", "status": "open" } })
            }
            project_routes::threads::SEND if body.get("threadId").is_some() => {
                json!({ "message": { "id": "msg-2" } })
            }
            project_routes::threads::SEND if self.message_delivery_error => {
                return ProjectServiceJsonResult::error(DaemonRouteResponse::text(
                    424,
                    "message msg-3 in thread thread-3 was recorded but not delivered: codex-missing: no live tmux window in runtime topology\n",
                ));
            }
            project_routes::threads::SEND if self.invalid_message_thread_id => {
                json!({ "thread": {}, "message": { "id": "msg-3" }, "deliveredTo": ["claude-1"] })
            }
            project_routes::threads::SEND if self.invalid_message_id => {
                json!({ "thread": { "id": "thread-3" }, "message": {}, "deliveredTo": ["claude-1"] })
            }
            project_routes::threads::SEND => {
                json!({ "thread": { "id": "thread-3" }, "message": { "id": "msg-3" }, "deliveredTo": ["claude-1"] })
            }
            project_routes::threads::MARK_SEEN => json!({ "ok": true }),
            project_routes::threads::STATUS => {
                json!({ "thread": { "id": body["threadId"].clone(), "status": body["status"].clone() } })
            }
            project_routes::handoff::SEND => {
                json!({ "thread": { "id": "thread-2" }, "message": { "id": "msg-2" }, "deliveredTo": ["claude-1"] })
            }
            project_routes::handoff::ACCEPT | project_routes::handoff::COMPLETE => {
                json!({ "thread": { "id": body["threadId"].clone() }, "message": { "id": "msg-3" } })
            }
            project_routes::tasks::ASSIGN => {
                json!({ "task": { "id": "task-2" }, "thread": { "id": "thread-3" } })
            }
            project_routes::tasks::ACCEPT
            | project_routes::tasks::BLOCK
            | project_routes::tasks::COMPLETE
            | project_routes::tasks::REOPEN
            | project_routes::reviews::APPROVE => {
                json!({ "task": { "id": body["taskId"].clone() }, "thread": { "id": "thread-1" } })
            }
            project_routes::reviews::REQUEST_CHANGES => {
                json!({
                    "task": { "id": body["taskId"].clone() },
                    "followUpTask": { "id": "task-follow-up" },
                    "thread": { "id": "thread-1" }
                })
            }
            _ => {
                return ProjectServiceJsonResult::error(DaemonRouteResponse::text(
                    404,
                    "not found\n",
                ));
            }
        };
        ProjectServiceJsonResult::ok("/repo", response)
    }
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

fn json_text(response: DaemonRouteResponse) -> Value {
    serde_json::from_str(&text_body(response)).expect("json text")
}

#[test]
fn thread_routes_match_text_json_and_project_service_contracts() {
    let mut runtime = FakeCollaborationRuntime::default();

    let listed = route_collaboration_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&session=%20claude-1%20",
            CORE_API_ROUTES.thread_list_text
        ),
        None,
    )
    .expect("thread list");
    assert!(text_body(listed).contains("thread-1  conversation  open unread=1 waiting=claude-1"));
    assert_eq!(
        runtime.calls.last().unwrap().route_path,
        "/threads?session=claude-1"
    );

    let listed_json = route_collaboration_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&session=claude-1&json=1",
            CORE_API_ROUTES.threads_list_text
        ),
        None,
    )
    .expect("thread list json");
    assert_eq!(json_text(listed_json)[0]["thread"]["id"], "thread-1");

    let shown = route_collaboration_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&threadId=thread-1",
            CORE_API_ROUTES.thread_show_text
        ),
        None,
    )
    .expect("thread show");
    assert!(text_body(shown).contains("Hello (conversation)"));

    let opened = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.thread_open_text,
        Some(&json!({
            "project": "/repo",
            "title": "New thread",
            "from": "sam",
            "participants": "claude-1,codex-1"
        })),
    )
    .expect("thread open");
    assert_eq!(text_body(opened), "thread-2\n");
    let open_call = runtime.calls.last().unwrap();
    assert_eq!(open_call.route_path, project_routes::threads::OPEN);
    assert_eq!(open_call.timeout_ms, Some(CLI_PROJECT_MUTATION_TIMEOUT_MS));
    assert_eq!(
        open_call.body.as_ref().unwrap(),
        &json!({
            "title": "New thread",
            "from": "sam",
            "participants": ["claude-1", "codex-1"],
            "kind": "conversation"
        })
    );

    let sent = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.thread_send_text,
        Some(
            &json!({ "project": "/repo", "threadId": "thread-1", "from": "sam", "body": "reply" }),
        ),
    )
    .expect("thread send");
    assert_eq!(text_body(sent), "msg-2\n");

    let seen = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.thread_mark_seen_text,
        Some(&json!({ "project": "/repo", "threadId": "thread-1", "session": "claude-1" })),
    )
    .expect("mark seen");
    assert_eq!(text_body(seen), "ok\n");

    let status = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.thread_status_text,
        Some(&json!({
            "project": "/repo",
            "threadId": "thread-1",
            "status": "waiting",
            "owner": "sam",
            "waitingOn": "claude-1,codex-1"
        })),
    )
    .expect("thread status");
    assert_eq!(text_body(status), "thread thread-1\nstatus waiting\n");

    let message = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.message_send_text,
        Some(&json!({ "project": "/repo", "to": "claude-1", "body": "please", "title": "Ask" })),
    )
    .expect("message send");
    assert_eq!(
        text_body(message),
        "thread thread-3\nmessage msg-3\ndelivered claude-1\n"
    );
    let message_call = runtime.calls.last().unwrap();
    assert_eq!(message_call.route_path, project_routes::threads::SEND);
    assert_eq!(message_call.timeout_ms, Some(CLI_MESSAGE_SEND_TIMEOUT_MS));
    assert_eq!(
        message_call.body.as_ref().unwrap(),
        &json!({
            "from": "user",
            "to": ["claude-1"],
            "kind": "request",
            "body": "please",
            "title": "Ask"
        })
    );
}

#[test]
fn collaboration_validation_and_not_found_errors_match_text_routes() {
    let mut runtime = FakeCollaborationRuntime::default();
    let bad_participants = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.thread_open_text,
        Some(&json!({ "project": "/repo", "title": "x", "from": "sam", "participants": " , " })),
    )
    .expect("thread open");
    assert_eq!(bad_participants.status, 400);
    assert_eq!(text_body(bad_participants), "participants is required\n");

    let bad_message = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.message_send_text,
        Some(&json!({ "project": "/repo", "body": "please" })),
    )
    .expect("message send");
    assert_eq!(bad_message.status, 400);
    assert_eq!(
        text_body(bad_message),
        "aimux: message send requires --to, --assignee, or --tool\n"
    );

    let missing_thread = route_collaboration_text_request(
        &mut FakeCollaborationRuntime {
            missing_thread: true,
            ..FakeCollaborationRuntime::default()
        },
        "GET",
        &format!(
            "{}?project=/repo&threadId=thread-1",
            CORE_API_ROUTES.thread_show_text
        ),
        None,
    )
    .expect("thread show");
    assert_eq!(missing_thread.status, 404);
    assert_eq!(
        text_body(missing_thread),
        "aimux: thread not found: thread-1\n"
    );

    let missing_task = route_collaboration_text_request(
        &mut FakeCollaborationRuntime {
            missing_task: true,
            ..FakeCollaborationRuntime::default()
        },
        "GET",
        &format!(
            "{}?project=/repo&taskId=task-1",
            CORE_API_ROUTES.task_show_text
        ),
        None,
    )
    .expect("task show");
    assert_eq!(missing_task.status, 404);
    assert_eq!(text_body(missing_task), "aimux: task not found: task-1\n");

    let bad_thread_id = route_collaboration_text_request(
        &mut FakeCollaborationRuntime {
            invalid_message_thread_id: true,
            ..FakeCollaborationRuntime::default()
        },
        "POST",
        CORE_API_ROUTES.message_send_text,
        Some(&json!({ "project": "/repo", "to": "claude-1", "body": "please" })),
    )
    .expect("message send");
    assert_eq!(bad_thread_id.status, 502);
    assert_eq!(
        text_body(bad_thread_id),
        "Error: project service returned invalid message send response: thread.id is required\n"
    );

    let bad_message_id = route_collaboration_text_request(
        &mut FakeCollaborationRuntime {
            invalid_message_id: true,
            ..FakeCollaborationRuntime::default()
        },
        "POST",
        CORE_API_ROUTES.message_send_text,
        Some(&json!({ "project": "/repo", "to": "claude-1", "body": "please" })),
    )
    .expect("message send");
    assert_eq!(bad_message_id.status, 502);
    assert_eq!(
        text_body(bad_message_id),
        "Error: project service returned invalid message send response: message.id is required\n"
    );

    let undelivered = route_collaboration_text_request(
        &mut FakeCollaborationRuntime {
            message_delivery_error: true,
            ..FakeCollaborationRuntime::default()
        },
        "POST",
        CORE_API_ROUTES.message_send_text,
        Some(&json!({ "project": "/repo", "to": "codex-missing", "body": "please" })),
    )
    .expect("message send");
    assert_eq!(undelivered.status, 424);
    let undelivered_body = text_body(undelivered);
    assert!(undelivered_body.contains("message msg-3 in thread thread-3"));
    assert!(undelivered_body.contains("recorded but not delivered"));
    assert!(undelivered_body.contains("codex-missing"));
    assert!(undelivered_body.contains("no live tmux window in runtime topology"));
}

#[test]
fn task_handoff_and_review_routes_match_text_and_mutation_contracts() {
    let mut runtime = FakeCollaborationRuntime::default();

    let tasks = route_collaboration_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&session=%20claude-1%20&status=todo",
            CORE_API_ROUTES.task_list_text
        ),
        None,
    )
    .expect("task list");
    assert!(text_body(tasks).contains("task-1  task  todo  target=claude-1 thread=thread-1"));
    assert_eq!(
        runtime.calls.last().unwrap().route_path,
        "/tasks?session=claude-1&status=todo"
    );

    let tasks_json = route_collaboration_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&session=claude-1&status=todo&json=1",
            CORE_API_ROUTES.task_list_text
        ),
        None,
    )
    .expect("task list json");
    assert_eq!(json_text(tasks_json)["tasks"][0]["id"], "task-1");

    let shown = route_collaboration_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&taskId=task-1",
            CORE_API_ROUTES.task_show_text
        ),
        None,
    )
    .expect("task show");
    assert!(text_body(shown).contains("Ship it (task)"));

    let handoff = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.handoff_send_text,
        Some(&json!({ "project": "/repo", "to": "claude-1", "body": "take this" })),
    )
    .expect("handoff send");
    assert_eq!(
        text_body(handoff),
        "thread thread-2\nmessage msg-2\ndelivered claude-1\n"
    );

    let accepted = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.handoff_accept_text,
        Some(&json!({ "project": "/repo", "threadId": "thread-2", "body": "ok" })),
    )
    .expect("handoff accept");
    assert_eq!(text_body(accepted), "thread thread-2\nmessage msg-3\n");

    let assigned = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.task_assign_text,
        Some(&json!({
            "project": "/repo",
            "to": "claude-1",
            "description": "Do it",
            "prompt": "details",
            "worktree": "/repo/wt"
        })),
    )
    .expect("task assign");
    assert_eq!(text_body(assigned), "task task-2\nthread thread-3\n");
    let assign_call = runtime.calls.last().unwrap();
    assert_eq!(assign_call.route_path, project_routes::tasks::ASSIGN);
    assert_eq!(
        assign_call.body.as_ref().unwrap(),
        &json!({
            "from": "user",
            "to": "claude-1",
            "description": "Do it",
            "prompt": "details",
            "type": "task",
            "worktreePath": "/repo/wt"
        })
    );

    let completed = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.task_complete_text,
        Some(&json!({ "project": "/repo", "taskId": "task-1", "result": "done" })),
    )
    .expect("task complete");
    assert_eq!(text_body(completed), "task task-1\nthread thread-1\n");
    assert_eq!(
        runtime.calls.last().unwrap().body.as_ref().unwrap()["body"],
        "done"
    );

    let approved = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.review_approve_text,
        Some(&json!({ "project": "/repo", "taskId": "task-1", "body": "ship" })),
    )
    .expect("review approve");
    assert_eq!(text_body(approved), "task task-1\nthread thread-1\n");

    let changes = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.review_request_changes_text,
        Some(&json!({ "project": "/repo", "taskId": "task-1", "body": "fix" })),
    )
    .expect("review request changes");
    assert_eq!(
        text_body(changes),
        "task task-1\nfollow-up task-follow-up\nthread thread-1\n"
    );

    let bad_handoff = route_collaboration_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.handoff_send_text,
        Some(&json!({ "project": "/repo", "body": "take this" })),
    )
    .expect("handoff send");
    assert_eq!(bad_handoff.status, 400);
    assert_eq!(
        text_body(bad_handoff),
        "aimux: handoff send requires --to, --assignee, or --tool\n"
    );

    assert!(
        runtime
            .calls
            .iter()
            .filter(|call| call.body.is_some())
            .all(|call| call.timeout_ms == Some(CLI_PROJECT_MUTATION_TIMEOUT_MS))
    );
}

#[test]
fn unrelated_collaboration_routes_are_left_for_other_modules() {
    assert!(
        route_collaboration_text_request(
            &mut FakeCollaborationRuntime::default(),
            "GET",
            CORE_API_ROUTES.worktree_list_text,
            None,
        )
        .is_none()
    );
}
