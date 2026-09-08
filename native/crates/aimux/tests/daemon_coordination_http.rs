use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::process::handle_daemon_runtime_request;
use aimux::daemon::runtime::{
    ProjectServiceLauncher, ProjectServiceProcessVerifier, RealDaemonRuntime,
};
use aimux::daemon::server::DaemonHttpRequest;
use aimux::daemon_state::{
    save_daemon_state, save_metadata_endpoint, AimuxDaemonInfo, DaemonState, MetadataApiEndpoint,
    ProjectServiceState, ProjectServiceStatus,
};
use aimux::native_cli_dispatch::{CORE_LOOP_LIST_TEXT_ROUTE, CORE_REVIEW_LIST_TEXT_ROUTE};
use aimux::paths::PathResolver;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs::{self, remove_dir_all};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn thread_routes_round_trip_through_daemon_http_to_project_service() {
    let fixture = CoordinationHttpFixture::new("thread-routes");
    let project = fixture.project("repo");
    let project_text = project.to_string_lossy().into_owned();
    let project_query = percent_encode_query_value(&project_text);
    let server = ScriptedHttpServer::spawn(vec![
        json!([
            {
                "thread": {
                    "id": "thread-1",
                    "title": "Decision",
                    "kind": "conversation",
                    "status": "open",
                    "unreadBy": ["codex-1"],
                    "waitingOn": ["claude-1"]
                },
                "latestMessage": {
                    "from": "sam",
                    "kind": "request",
                    "body": "Need a call"
                }
            }
        ]),
        json!({
            "thread": {
                "id": "thread-1",
                "title": "Decision",
                "kind": "conversation",
                "status": "open",
                "participants": ["sam", "claude-1"],
                "waitingOn": ["claude-1"]
            },
            "messages": [
                {
                    "id": "msg-1",
                    "ts": "2026-09-05T00:00:00.000Z",
                    "from": "sam",
                    "kind": "request",
                    "body": "Need a call"
                }
            ]
        }),
        json!({ "thread": { "id": "thread-2", "status": "open" } }),
        json!({ "thread": { "id": "thread-1" }, "message": { "id": "msg-2" } }),
        json!({ "thread": { "id": "thread-1", "status": "done" } }),
        json!({ "ok": true }),
    ]);
    let mut runtime = fixture.runtime_for_project(&project, server.port);

    let listed = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!(
                "{}?project={}&session=%20claude-1%20",
                CORE_API_ROUTES.thread_list_text, project_query
            ),
            None,
        ),
    );
    assert_eq!(listed.status, 200);
    assert!(text_body(&listed).contains("thread-1  conversation  open unread=1 waiting=claude-1"));

    let shown = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!(
                "{}?project={}&threadId=thread-1",
                CORE_API_ROUTES.thread_show_text, project_query
            ),
            None,
        ),
    );
    assert_eq!(shown.status, 200);
    assert!(text_body(&shown).contains("Decision (conversation)"));
    assert!(text_body(&shown).contains("Need a call"));

    let opened = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.thread_open_text,
            Some(json!({
                "project": project_text,
                "title": "Follow-up",
                "from": "sam",
                "participants": "claude-1,codex-1",
                "kind": "handoff"
            })),
        ),
    );
    assert_eq!(opened.status, 200);
    assert_eq!(text_body(&opened), "thread-2\n");

    let replied = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.thread_send_text,
            Some(json!({
                "project": project_text,
                "threadId": "thread-1",
                "from": "sam",
                "to": "claude-1,codex-1",
                "kind": "reply",
                "body": "ack"
            })),
        ),
    );
    assert_eq!(replied.status, 200);
    assert_eq!(text_body(&replied), "msg-2\n");

    let resolved = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.thread_status_text,
            Some(json!({
                "project": project_text,
                "threadId": "thread-1",
                "status": "done",
                "owner": "sam",
                "waitingOn": "claude-1,codex-1"
            })),
        ),
    );
    assert_eq!(resolved.status, 200);
    assert_eq!(text_body(&resolved), "thread thread-1\nstatus done\n");

    let seen = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.thread_mark_seen_text,
            Some(json!({
                "project": project_text,
                "threadId": "thread-1",
                "session": "claude-1"
            })),
        ),
    );
    assert_eq!(seen.status, 200);
    assert_eq!(text_body(&seen), "ok\n");

    let requests = server.join();
    assert_request_path(&requests[0], "GET", "/threads?session=claude-1");
    assert_request_path(&requests[1], "GET", "/threads/thread-1");
    assert_request_path(&requests[2], "POST", project_routes::threads::OPEN);
    assert_eq!(
        request_json_body(&requests[2]),
        json!({
            "title": "Follow-up",
            "from": "sam",
            "participants": ["claude-1", "codex-1"],
            "kind": "handoff"
        })
    );
    assert_request_path(&requests[3], "POST", project_routes::threads::SEND);
    assert_eq!(
        request_json_body(&requests[3]),
        json!({
            "threadId": "thread-1",
            "from": "sam",
            "to": ["claude-1", "codex-1"],
            "kind": "reply",
            "body": "ack"
        })
    );
    assert_request_path(&requests[4], "POST", project_routes::threads::STATUS);
    assert_eq!(
        request_json_body(&requests[4]),
        json!({
            "threadId": "thread-1",
            "status": "done",
            "owner": "sam",
            "waitingOn": ["claude-1", "codex-1"]
        })
    );
    assert_request_path(&requests[5], "POST", project_routes::threads::MARK_SEEN);
    assert_eq!(
        request_json_body(&requests[5]),
        json!({ "threadId": "thread-1", "session": "claude-1" })
    );
    fixture.cleanup();
}

#[test]
fn task_routes_round_trip_through_daemon_http_to_project_service() {
    let fixture = CoordinationHttpFixture::new("task-routes");
    let project = fixture.project("repo");
    let project_text = project.to_string_lossy().into_owned();
    let project_query = percent_encode_query_value(&project_text);
    let server = ScriptedHttpServer::spawn(vec![
        json!({
            "tasks": [
                {
                    "id": "task-1",
                    "type": "task",
                    "status": "todo",
                    "assignedTo": "claude-1",
                    "threadId": "thread-1",
                    "description": "Ship it"
                }
            ]
        }),
        json!({
            "task": {
                "id": "task-1",
                "type": "task",
                "status": "todo",
                "assignedBy": "sam",
                "assignedTo": "claude-1",
                "threadId": "thread-1",
                "description": "Ship it",
                "prompt": "Use the real route"
            },
            "thread": { "id": "thread-1", "title": "Task" },
            "messages": [
                { "id": "msg-1", "from": "sam", "kind": "request", "body": "Ship it" }
            ]
        }),
        json!({ "task": { "id": "task-2" }, "thread": { "id": "thread-2" } }),
        json!({ "task": { "id": "task-1" }, "thread": { "id": "thread-1" } }),
        json!({ "task": { "id": "task-1" }, "thread": { "id": "thread-1" } }),
        json!({ "task": { "id": "task-1" }, "thread": { "id": "thread-1" } }),
        json!({ "task": { "id": "task-1" }, "thread": { "id": "thread-1" } }),
    ]);
    let mut runtime = fixture.runtime_for_project(&project, server.port);

    let listed = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!(
                "{}?project={}&session=%20claude-1%20&status=todo",
                CORE_API_ROUTES.task_list_text, project_query
            ),
            None,
        ),
    );
    assert_eq!(listed.status, 200);
    assert!(text_body(&listed).contains("task-1  task  todo  target=claude-1 thread=thread-1"));

    let shown = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!(
                "{}?project={}&taskId=task-1",
                CORE_API_ROUTES.task_show_text, project_query
            ),
            None,
        ),
    );
    assert_eq!(shown.status, 200);
    assert!(text_body(&shown).contains("Ship it (task)"));
    assert!(text_body(&shown).contains("Use the real route"));

    let assigned = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.task_assign_text,
            Some(json!({
                "project": project_text,
                "to": "claude-1",
                "description": "Do it",
                "prompt": "details",
                "worktree": "/repo/wt"
            })),
        ),
    );
    assert_eq!(assigned.status, 200);
    assert_eq!(text_body(&assigned), "task task-2\nthread thread-2\n");

    let accepted = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.task_accept_text,
            Some(json!({
                "project": project_text,
                "taskId": "task-1",
                "from": "claude-1",
                "body": "taking it"
            })),
        ),
    );
    assert_eq!(accepted.status, 200);
    assert_eq!(text_body(&accepted), "task task-1\nthread thread-1\n");

    let blocked = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.task_block_text,
            Some(json!({
                "project": project_text,
                "taskId": "task-1",
                "body": "missing input"
            })),
        ),
    );
    assert_eq!(blocked.status, 200);
    assert_eq!(text_body(&blocked), "task task-1\nthread thread-1\n");

    let completed = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.task_complete_text,
            Some(json!({
                "project": project_text,
                "taskId": "task-1",
                "result": "done"
            })),
        ),
    );
    assert_eq!(completed.status, 200);
    assert_eq!(text_body(&completed), "task task-1\nthread thread-1\n");

    let reopened = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.task_reopen_text,
            Some(json!({
                "project": project_text,
                "taskId": "task-1",
                "body": "follow-up"
            })),
        ),
    );
    assert_eq!(reopened.status, 200);
    assert_eq!(text_body(&reopened), "task task-1\nthread thread-1\n");

    let requests = server.join();
    assert_request_path(&requests[0], "GET", "/tasks?session=claude-1&status=todo");
    assert_request_path(&requests[1], "GET", "/tasks/task-1");
    assert_request_path(&requests[2], "POST", project_routes::tasks::ASSIGN);
    assert_eq!(
        request_json_body(&requests[2]),
        json!({
            "from": "user",
            "to": "claude-1",
            "description": "Do it",
            "prompt": "details",
            "type": "task",
            "worktreePath": "/repo/wt"
        })
    );
    assert_request_path(&requests[3], "POST", project_routes::tasks::ACCEPT);
    assert_eq!(
        request_json_body(&requests[3]),
        json!({ "taskId": "task-1", "from": "claude-1", "body": "taking it" })
    );
    assert_request_path(&requests[4], "POST", project_routes::tasks::BLOCK);
    assert_eq!(
        request_json_body(&requests[4]),
        json!({ "taskId": "task-1", "from": "user", "body": "missing input" })
    );
    assert_request_path(&requests[5], "POST", project_routes::tasks::COMPLETE);
    assert_eq!(
        request_json_body(&requests[5]),
        json!({ "taskId": "task-1", "from": "user", "body": "done" })
    );
    assert_request_path(&requests[6], "POST", project_routes::tasks::REOPEN);
    assert_eq!(
        request_json_body(&requests[6]),
        json!({ "taskId": "task-1", "from": "user", "body": "follow-up" })
    );
    fixture.cleanup();
}

#[test]
fn message_and_handoff_routes_preserve_delivery_and_attribution_over_daemon_http() {
    let fixture = CoordinationHttpFixture::new("message-handoff-routes");
    let project = fixture.project("repo");
    let project_text = project.to_string_lossy().into_owned();
    let server = ScriptedHttpServer::spawn(vec![
        json!({
            "thread": { "id": "thread-1", "kind": "conversation" },
            "message": { "id": "msg-1" },
            "deliveredTo": ["claude-1"]
        }),
        json!({
            "thread": { "id": "thread-2", "kind": "handoff" },
            "message": { "id": "msg-2" },
            "deliveredTo": ["codex-1", "claude-1"]
        }),
        json!({
            "thread": { "id": "thread-2" },
            "message": { "id": "msg-3" },
            "deliveredTo": ["sam"]
        }),
        json!({
            "thread": { "id": "thread-2" },
            "message": { "id": "msg-4" }
        }),
    ]);
    let mut runtime = fixture.runtime_for_project(&project, server.port);

    let message = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.message_send_text,
            Some(json!({
                "project": project_text,
                "thread": "thread-1",
                "to": "claude-1",
                "body": "please",
                "title": "Ask",
                "worktree": "/repo/wt"
            })),
        ),
    );
    assert_eq!(message.status, 200);
    assert_eq!(
        text_body(&message),
        "thread thread-1\nmessage msg-1\ndelivered claude-1\n"
    );

    let handoff = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.handoff_send_text,
            Some(json!({
                "project": project_text,
                "from": "sam",
                "to": "codex-1,claude-1",
                "body": "take over",
                "title": "Handoff",
                "worktree": "/repo/wt"
            })),
        ),
    );
    assert_eq!(handoff.status, 200);
    assert_eq!(
        text_body(&handoff),
        "thread thread-2\nmessage msg-2\ndelivered codex-1,claude-1\n"
    );

    let accepted = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.handoff_accept_text,
            Some(json!({
                "project": project_text,
                "threadId": "thread-2",
                "from": "codex-1",
                "body": "accepted"
            })),
        ),
    );
    assert_eq!(accepted.status, 200);
    assert_eq!(text_body(&accepted), "thread thread-2\nmessage msg-3\n");

    let completed = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.handoff_complete_text,
            Some(json!({
                "project": project_text,
                "threadId": "thread-2",
                "body": "complete"
            })),
        ),
    );
    assert_eq!(completed.status, 200);
    assert_eq!(text_body(&completed), "thread thread-2\nmessage msg-4\n");

    let requests = server.join();
    assert_request_path(&requests[0], "POST", project_routes::threads::SEND);
    assert_eq!(
        request_json_body(&requests[0]),
        json!({
            "threadId": "thread-1",
            "from": "user",
            "to": ["claude-1"],
            "worktreePath": "/repo/wt",
            "kind": "request",
            "body": "please",
            "title": "Ask"
        })
    );
    assert_request_path(&requests[1], "POST", project_routes::handoff::SEND);
    assert_eq!(
        request_json_body(&requests[1]),
        json!({
            "from": "sam",
            "to": ["codex-1", "claude-1"],
            "body": "take over",
            "title": "Handoff",
            "worktreePath": "/repo/wt"
        })
    );
    assert_request_path(&requests[2], "POST", project_routes::handoff::ACCEPT);
    assert_eq!(
        request_json_body(&requests[2]),
        json!({ "threadId": "thread-2", "from": "codex-1", "body": "accepted" })
    );
    assert_request_path(&requests[3], "POST", project_routes::handoff::COMPLETE);
    assert_eq!(
        request_json_body(&requests[3]),
        json!({ "threadId": "thread-2", "from": "user", "body": "complete" })
    );
    fixture.cleanup();
}

#[test]
fn review_routes_round_trip_through_daemon_http_to_project_service() {
    let fixture = CoordinationHttpFixture::new("review-routes");
    let project = fixture.project("repo");
    let project_text = project.to_string_lossy().into_owned();
    let project_query = percent_encode_query_value(&project_text);
    let server = ScriptedHttpServer::spawn(vec![
        json!({
            "tasks": [
                {
                    "id": "task-1",
                    "type": "task",
                    "status": "todo",
                    "assignedTo": "claude-1",
                    "description": "ordinary task"
                },
                {
                    "id": "review-1",
                    "type": "review",
                    "status": "todo",
                    "assignedTo": "codex-1",
                    "threadId": "thread-1",
                    "description": "Review diff"
                },
                {
                    "id": "task-2",
                    "status": "todo",
                    "reviewStatus": "changes_requested",
                    "description": "Review-shaped task"
                }
            ]
        }),
        json!({ "task": { "id": "review-1" }, "thread": { "id": "thread-1" } }),
        json!({
            "task": { "id": "review-1" },
            "followUpTask": { "id": "task-follow-up" },
            "thread": { "id": "thread-1" }
        }),
    ]);
    let mut runtime = fixture.runtime_for_project(&project, server.port);

    let listed = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!("{CORE_REVIEW_LIST_TEXT_ROUTE}?project={project_query}"),
            None,
        ),
    );
    assert_eq!(listed.status, 200);
    let listed_text = text_body(&listed);
    assert!(listed_text.contains("Review tasks:\n"));
    assert!(listed_text.contains("review-1  review  todo  target=codex-1 thread=thread-1"));
    assert!(listed_text.contains("task-2  task  todo  target=unassigned"));
    assert!(!listed_text.contains("ordinary task"));

    let approved = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.review_approve_text,
            Some(json!({
                "project": project_text,
                "taskId": "review-1",
                "from": "codex-1",
                "body": "ship it"
            })),
        ),
    );
    assert_eq!(approved.status, 200);
    assert_eq!(text_body(&approved), "task review-1\nthread thread-1\n");

    let changes = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.review_request_changes_text,
            Some(json!({
                "project": project_text,
                "taskId": "review-1",
                "body": "fix edge case"
            })),
        ),
    );
    assert_eq!(changes.status, 200);
    assert_eq!(
        text_body(&changes),
        "task review-1\nfollow-up task-follow-up\nthread thread-1\n"
    );

    let requests = server.join();
    assert_request_path(&requests[0], "GET", project_routes::tasks::LIST);
    assert_request_path(&requests[1], "POST", project_routes::reviews::APPROVE);
    assert_eq!(
        request_json_body(&requests[1]),
        json!({ "taskId": "review-1", "from": "codex-1", "body": "ship it" })
    );
    assert_request_path(
        &requests[2],
        "POST",
        project_routes::reviews::REQUEST_CHANGES,
    );
    assert_eq!(
        request_json_body(&requests[2]),
        json!({ "taskId": "review-1", "from": "user", "body": "fix edge case" })
    );
    fixture.cleanup();
}

#[test]
fn notification_routes_round_trip_through_daemon_http_to_project_service() {
    let fixture = CoordinationHttpFixture::new("notification-routes");
    let project = fixture.project("repo");
    let project_text = project.to_string_lossy().into_owned();
    let project_query = percent_encode_query_value(&project_text);
    let server = ScriptedHttpServer::spawn(vec![
        json!({
            "ok": true,
            "entry": { "id": "notification-1", "kind": "needs_input" }
        }),
        json!({
            "notifications": [
                {
                    "id": "notification-1",
                    "unread": true,
                    "sessionId": "claude-1",
                    "title": "claude-1 needs input",
                    "body": "Agent is waiting for input."
                }
            ],
            "unreadCount": 1
        }),
        json!({ "ok": true, "updated": 1 }),
        json!({ "ok": true, "cleared": 2 }),
    ]);
    let mut runtime = fixture.runtime_for_project(&project, server.port);

    let sent = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.notification_send_text,
            Some(json!({
                "project": project_text,
                "title": " claude-1 needs input ",
                "body": " Agent is waiting for input. ",
                "sessionId": " claude-1 ",
                "kind": " needs_input "
            })),
        ),
    );
    assert_eq!(sent.status, 200);
    assert_eq!(
        text_body(&sent),
        "Queued notification \"claude-1 needs input\".\n"
    );

    let listed = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!(
                "{}?project={}&unread=1&sessionId=%20claude-1%20",
                CORE_API_ROUTES.notification_list_text, project_query
            ),
            None,
        ),
    );
    assert_eq!(listed.status, 200);
    assert_eq!(
        text_body(&listed),
        "notification-1 unread [claude-1] claude-1 needs input: Agent is waiting for input.\n"
    );

    let read = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.notification_read_text,
            Some(json!({
                "project": project_text,
                "ids": " notification-1, notification-2 ",
                "sessionId": " claude-1 "
            })),
        ),
    );
    assert_eq!(read.status, 200);
    assert_eq!(text_body(&read), "Marked 1 notification as read.\n");

    let cleared = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.notification_clear_text,
            Some(json!({
                "project": project_text,
                "id": "notification-1"
            })),
        ),
    );
    assert_eq!(cleared.status, 200);
    assert_eq!(text_body(&cleared), "Cleared 2 notifications.\n");

    let requests = server.join();
    assert_request_path(&requests[0], "POST", project_routes::runtime::NOTIFY);
    assert_eq!(
        request_json_body(&requests[0]),
        json!({
            "title": "claude-1 needs input",
            "message": "Agent is waiting for input.",
            "sessionId": "claude-1",
            "kind": "needs_input",
            "force": true
        })
    );
    assert_request_path(
        &requests[1],
        "GET",
        "/notifications?unread=1&sessionId=claude-1",
    );
    assert_request_path(&requests[2], "POST", project_routes::notifications::READ);
    assert_eq!(
        request_json_body(&requests[2]),
        json!({ "ids": ["notification-1", "notification-2"], "sessionId": "claude-1" })
    );
    assert_request_path(&requests[3], "POST", project_routes::notifications::CLEAR);
    assert_eq!(
        request_json_body(&requests[3]),
        json!({ "id": "notification-1" })
    );
    fixture.cleanup();
}

#[test]
fn loop_routes_round_trip_through_daemon_http_to_project_service() {
    let fixture = CoordinationHttpFixture::new("loop-routes");
    let project = fixture.project("repo");
    let project_text = project.to_string_lossy().into_owned();
    let project_query = percent_encode_query_value(&project_text);
    let server = ScriptedHttpServer::spawn(vec![
        json!({
            "agents": [
                {
                    "id": "claude-1",
                    "tool": "claude",
                    "status": "running",
                    "loop": { "active": true, "goal": "ship the slice" }
                },
                {
                    "id": "codex-1",
                    "tool": "codex",
                    "status": "running",
                    "loop": { "active": false }
                }
            ]
        }),
        json!({
            "sessionId": "claude-1",
            "loop": { "active": true, "goal": "canonical goal" }
        }),
        json!({ "sessionId": "claude-1", "loop": { "active": false } }),
        json!({ "sessionId": "claude-1", "loop": { "active": false } }),
        json!({ "ok": true }),
        json!({ "sessionId": "claude-1", "loop": { "active": false } }),
        json!({ "ok": true }),
    ]);
    let mut runtime = fixture.runtime_for_project(&project, server.port);

    let listed = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!("{CORE_LOOP_LIST_TEXT_ROUTE}?project={project_query}"),
            None,
        ),
    );
    assert_eq!(listed.status, 200);
    let listed_text = text_body(&listed);
    assert!(listed_text.contains("Loop agents:\n"));
    assert!(listed_text.contains("claude-1  [claude]  running  {loop:ship the slice}"));
    assert!(!listed_text.contains("codex-1"));

    let added = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.loop_add_text,
            Some(json!({
                "project": project_text,
                "sessionId": "claude-1",
                "goal": "ship",
                "updatedBy": "sam",
                "updatedBySessionId": "overseer-1",
                "updatedByRole": "overseer"
            })),
        ),
    );
    assert_eq!(added.status, 200);
    assert_eq!(text_body(&added), "loop on claude-1 — canonical goal\n");

    let removed = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.loop_remove_text,
            Some(json!({
                "project": project_text,
                "sessionId": "claude-1",
                "source": "overseer"
            })),
        ),
    );
    assert_eq!(removed.status, 200);
    assert_eq!(text_body(&removed), "loop off claude-1\n");

    let done = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.loop_done_text,
            Some(json!({
                "project": project_text,
                "sessionId": "claude-1",
                "reason": "finished"
            })),
        ),
    );
    assert_eq!(done.status, 200);
    assert_eq!(text_body(&done), "loop done claude-1\n");

    let blocked = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.loop_block_text,
            Some(json!({
                "project": project_text,
                "sessionId": "claude-1"
            })),
        ),
    );
    assert_eq!(blocked.status, 200);
    assert_eq!(text_body(&blocked), "loop blocked claude-1\n");

    let requests = server.join();
    assert_request_path(&requests[0], "GET", project_routes::agents::LIST);
    assert_request_path(&requests[1], "POST", project_routes::agents::LOOP);
    assert_eq!(
        request_json_body(&requests[1]),
        json!({
            "sessionId": "claude-1",
            "source": "human",
            "updatedBy": "sam",
            "updatedBySessionId": "overseer-1",
            "updatedByRole": "overseer",
            "active": true,
            "action": "add",
            "goal": "ship"
        })
    );
    assert_request_path(&requests[2], "POST", project_routes::agents::LOOP);
    assert_eq!(
        request_json_body(&requests[2]),
        json!({
            "sessionId": "claude-1",
            "source": "overseer",
            "active": false,
            "action": "remove"
        })
    );
    assert_request_path(&requests[3], "POST", project_routes::agents::LOOP);
    assert_eq!(
        request_json_body(&requests[3]),
        json!({
            "sessionId": "claude-1",
            "source": "agent",
            "active": false,
            "action": "done",
            "reason": "finished"
        })
    );
    assert_request_path(&requests[4], "POST", project_routes::runtime::EVENT);
    assert_eq!(
        request_json_body(&requests[4]),
        json!({
            "session": "claude-1",
            "event": {
                "kind": "task_done",
                "message": "finished",
                "tone": "success",
                "source": "loop"
            }
        })
    );
    assert_request_path(&requests[5], "POST", project_routes::agents::LOOP);
    assert_eq!(
        request_json_body(&requests[5]),
        json!({
            "sessionId": "claude-1",
            "source": "agent",
            "active": false,
            "action": "block"
        })
    );
    assert_request_path(&requests[6], "POST", project_routes::runtime::EVENT);
    assert_eq!(
        request_json_body(&requests[6]),
        json!({
            "session": "claude-1",
            "event": {
                "kind": "blocked",
                "message": "Blocked beyond repair.",
                "source": "loop"
            }
        })
    );
    fixture.cleanup();
}

#[derive(Debug)]
struct CoordinationHttpFixture {
    root: PathBuf,
    home: PathBuf,
}

impl CoordinationHttpFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-rust-coordination-http-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        Self { root, home }
    }

    fn resolver(&self) -> PathResolver {
        PathResolver::new(
            &self.root,
            &self.home,
            Some(self.home.join(".aimux").to_string_lossy().into_owned()),
        )
    }

    fn project(&self, name: &str) -> PathBuf {
        let project = self.root.join(name);
        fs::create_dir_all(project.join(".git")).expect("project git");
        project
    }

    fn runtime_for_project(&self, project: &Path, endpoint_port: u16) -> RealDaemonRuntime {
        let mut resolver = self.resolver();
        let entry = resolver
            .register_project(project)
            .expect("register project")
            .expect("project entry");
        let pid = std::process::id() as i32;
        save_daemon_state(
            resolver.daemon_state_path(),
            &DaemonState {
                version: 1,
                updated_at: Some(json!("now")),
                projects: Map::from_iter([(
                    entry.id.clone(),
                    serde_json::to_value(ProjectServiceState {
                        project_id: entry.id,
                        project_root: project.to_string_lossy().into_owned(),
                        pid,
                        started_at: "then".into(),
                        updated_at: "now".into(),
                        status: Some(ProjectServiceStatus::Running),
                        restart_count: Some(0),
                        last_restart_at: None,
                        last_exit: None,
                    })
                    .expect("service json"),
                )]),
            },
        )
        .expect("daemon state");
        save_metadata_endpoint(
            resolver.project_state_dir_for(project),
            &MetadataApiEndpoint {
                host: "127.0.0.1".into(),
                port: endpoint_port,
                pid,
                updated_at: "now".into(),
            },
        )
        .expect("endpoint");
        RealDaemonRuntime::with_project_service_launcher_and_process_verifier(
            resolver,
            AimuxDaemonInfo {
                pid,
                port: 46_200,
                started_at: "then".into(),
                updated_at: "now".into(),
            },
            Arc::new(PanicLauncher),
            Arc::new(FakeProcessVerifier::native([pid])),
            0,
        )
    }

    fn cleanup(self) {
        let _ = remove_dir_all(self.root);
    }
}

#[derive(Debug)]
struct PanicLauncher;

impl ProjectServiceLauncher for PanicLauncher {
    fn launch(
        &self,
        _project_id: &str,
        _project_root: &Path,
        _project_state_dir: &Path,
    ) -> Result<i32, String> {
        panic!("coordination HTTP tests must reuse the scripted project-service endpoint")
    }

    fn terminate(&self, _service: &ProjectServiceState, _force: bool) -> Result<(), String> {
        Ok(())
    }
}

struct FakeProcessVerifier {
    native: BTreeSet<i32>,
}

impl FakeProcessVerifier {
    fn native(pids: impl IntoIterator<Item = i32>) -> Self {
        Self {
            native: pids.into_iter().collect(),
        }
    }
}

impl ProjectServiceProcessVerifier for FakeProcessVerifier {
    fn is_live(&self, pid: i32) -> bool {
        self.native.contains(&pid)
    }

    fn is_live_native_project_service(&self, service: &ProjectServiceState) -> bool {
        self.native.contains(&service.pid)
    }

    fn live_project_service_pids(&self, _project_id: &str, _project_root: &str) -> Vec<i32> {
        Vec::new()
    }
}

struct ScriptedHttpServer {
    port: u16,
    handle: std::thread::JoinHandle<Vec<String>>,
}

impl ScriptedHttpServer {
    fn spawn(responses: Vec<Value>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener");
        let port = listener.local_addr().expect("listener addr").port();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                let body = response.to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write headers");
                stream.write_all(body.as_bytes()).expect("write body");
                requests.push(request);
            }
            requests
        });
        Self { port, handle }
    }

    fn join(self) -> Vec<String> {
        self.handle.join().expect("server thread")
    }
}

fn request(method: &str, path: &str, body: Option<Value>) -> DaemonHttpRequest {
    DaemonHttpRequest {
        method: method.into(),
        path: path.into(),
        headers: Default::default(),
        body_chunks: body
            .map(|value| vec![value.to_string().into_bytes()])
            .unwrap_or_default(),
        stopping: false,
        issued_at: "issued".into(),
    }
}

fn text_body(response: &aimux::daemon::http::PreparedDaemonResponse) -> String {
    String::from_utf8(response.body.clone()).expect("text body")
}

fn read_http_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_millis(20)))
        .expect("set test request timeout");
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                break;
            }
            Err(error) => panic!("read request: {error}"),
        }
        if request_is_complete(&buffer) {
            break;
        }
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

fn request_is_complete(buffer: &[u8]) -> bool {
    let Some(header_end) = find_header_end(buffer) else {
        return false;
    };
    let headers = String::from_utf8_lossy(&buffer[..header_end]);
    let Some(content_length) = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    }) else {
        return true;
    };
    buffer.len() >= header_end + 4 + content_length
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn assert_request_path(request: &str, method: &str, path: &str) {
    let mut parts = request.lines().next().unwrap_or_default().split(' ');
    assert_eq!(parts.next(), Some(method));
    assert_eq!(parts.next(), Some(path));
}

fn request_json_body(request: &str) -> Value {
    let body = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.trim())
        .unwrap_or_default();
    if body.is_empty() {
        json!({})
    } else {
        serde_json::from_str(body).expect("request JSON body")
    }
}

fn percent_encode_query_value(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}
