use aimux::core_cli::{
    CORE_DIAGNOSTIC_TIMEOUT_MS, CoreCliAction, CoreCliContext, CoreCliFallback, CoreCliOperation,
    CoreCliOutputMode, CoreCliPlanError, CoreCommandResponseError, CoreHttpMethod,
    CoreLoopActorContext, build_core_command_transport_request, classify_core_cli,
    classify_core_cli_with_project_resolver, validate_core_command_response,
};
use aimux::core_command_contract::{CORE_API_ROUTES, CORE_COMMAND_NAMES};
use serde_json::{Value, json};

fn context(daemon_running: bool, has_credentials: bool) -> CoreCliContext {
    CoreCliContext {
        current_project_root: "/repo".into(),
        daemon_running,
        has_credentials,
        loop_actor: CoreLoopActorContext::default(),
    }
}

fn command_from(action: &CoreCliAction) -> (&str, Option<&Value>, bool, Option<u64>, bool) {
    let CoreCliAction::Command {
        request,
        open_dashboard_after,
    } = action
    else {
        panic!("expected command action, got {action:?}");
    };
    (
        request.command,
        request.payload.as_ref(),
        request.options.ensure_daemon,
        request.options.timeout_ms,
        *open_dashboard_after,
    )
}

#[test]
fn sidecar_owned_commands_map_to_authoritative_names_and_payloads() {
    let cases = [
        (
            vec!["host", "status"],
            CoreCliOperation::HostStatus,
            CORE_COMMAND_NAMES.status,
            None,
        ),
        (
            vec!["daemon", "ensure"],
            CoreCliOperation::DaemonEnsure,
            CORE_COMMAND_NAMES.status,
            None,
        ),
        (
            vec!["daemon", "projects"],
            CoreCliOperation::DaemonProjects,
            CORE_COMMAND_NAMES.projects_list,
            None,
        ),
        (
            vec!["projects", "list"],
            CoreCliOperation::ProjectsList,
            CORE_COMMAND_NAMES.projects_list,
            None,
        ),
        (
            vec!["serve"],
            CoreCliOperation::ProjectServe,
            CORE_COMMAND_NAMES.project_ensure,
            Some(json!({ "projectRoot": "/repo" })),
        ),
        (
            vec!["host", "stop"],
            CoreCliOperation::HostStop,
            CORE_COMMAND_NAMES.project_stop,
            Some(json!({ "projectRoot": "/repo" })),
        ),
        (
            vec!["host", "kill"],
            CoreCliOperation::HostKill,
            CORE_COMMAND_NAMES.project_kill,
            Some(json!({ "projectRoot": "/repo" })),
        ),
    ];

    for (args, operation, command, payload) in cases {
        let plan = classify_core_cli(&args, &context(true, true)).expect("valid plan");
        assert_eq!(plan.operation, operation, "{args:?}");
        let actual = command_from(&plan.action);
        assert_eq!(actual.0, command, "{args:?}");
        assert_eq!(actual.1, payload.as_ref(), "{args:?}");
        assert!(actual.2, "{args:?}");
        assert_eq!(actual.3, None, "{args:?}");
        assert!(!actual.4, "{args:?}");
    }
}

#[test]
fn project_ensure_and_restart_use_the_supplied_project_resolver() {
    let plan = classify_core_cli_with_project_resolver(
        &["daemon", "project-ensure", "--project", "./child", "--json"],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("project ensure plan");
    assert_eq!(plan.output_mode, CoreCliOutputMode::Json);
    assert_eq!(
        command_from(&plan.action).1,
        Some(&json!({ "projectRoot": "/resolved/./child" }))
    );

    let restart = classify_core_cli_with_project_resolver(
        &["restart", "--project=./child"],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("restart plan");
    assert_eq!(restart.operation, CoreCliOperation::Restart);
    assert_eq!(
        restart.action,
        CoreCliAction::RestartControlPlane {
            project_root: Some("/resolved/./child".into()),
        }
    );
}

#[test]
fn host_restart_always_sends_serve_and_preserves_open_as_a_local_followup() {
    for (args, serve, open) in [
        (vec!["host", "restart"], false, false),
        (vec!["host", "restart", "--serve"], true, false),
        (vec!["host", "restart", "--open"], false, true),
        (vec!["host", "restart", "--serve", "--open"], true, true),
    ] {
        let plan = classify_core_cli(&args, &context(true, true)).expect("host restart plan");
        let request = command_from(&plan.action);
        assert_eq!(request.0, CORE_COMMAND_NAMES.project_restart);
        assert_eq!(
            request.1,
            Some(&json!({ "projectRoot": "/repo", "serve": serve }))
        );
        assert_eq!(request.4, open);
        assert_eq!(
            plan.fallback,
            if open {
                CoreCliFallback::MissingDashboardTarget
            } else {
                CoreCliFallback::None
            }
        );
    }
}

#[test]
fn host_agent_read_plans_native_text_route_with_resolved_project_and_tail_math() {
    let plan = classify_core_cli_with_project_resolver(
        &[
            "host",
            "agent-read",
            "claude 1",
            "--project",
            "./child dir",
            "--lines",
            "200",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("host agent-read plan");
    assert_eq!(plan.operation, CoreCliOperation::HostAgentRead);
    assert_eq!(plan.output_mode, CoreCliOutputMode::Text);
    assert_eq!(
        plan.action,
        CoreCliAction::TextRoute {
            path: "/core/host-agent-read-text?project=%2Fresolved%2F.%2Fchild%20dir&sessionId=claude%201&startLine=-200".into(),
            body: None,
        }
    );

    let default_project =
        classify_core_cli(&["host", "agent-read", "codex-1"], &context(true, true))
            .expect("default host agent-read plan");
    assert_eq!(
        default_project.action,
        CoreCliAction::TextRoute {
            path: "/core/host-agent-read-text?project=%2Frepo&sessionId=codex-1&startLine=-120"
                .into(),
            body: None,
        }
    );
}

#[test]
fn invalid_host_agent_read_args_fail_before_node_fallback() {
    let invalid_lines = classify_core_cli(
        &["host", "agent-read", "claude-1", "--lines", "-5"],
        &context(true, true),
    )
    .expect_err("non-positive lines");
    assert_eq!(invalid_lines.exit_code(), 1);
    assert_eq!(
        invalid_lines.to_string(),
        "Error: --lines must be a positive integer"
    );

    let invalid_start = classify_core_cli(
        &["host", "agent-read", "claude-1", "--start-line", "10px"],
        &context(true, true),
    )
    .expect_err("invalid start-line");
    assert_eq!(invalid_start.exit_code(), 1);
    assert_eq!(
        invalid_start.to_string(),
        "Error: --start-line must be an integer"
    );

    let missing_session = classify_core_cli(
        &["host", "agent-read", "--project", "/repo"],
        &context(true, true),
    )
    .expect_err("missing session");
    assert_eq!(missing_session.exit_code(), 1);
    assert!(matches!(
        missing_session,
        CoreCliPlanError::InvalidArguments { .. }
    ));
}

#[test]
fn host_agent_stream_plans_native_text_route_with_stream_defaults() {
    let plan = classify_core_cli_with_project_resolver(
        &[
            "host",
            "agent-stream",
            "claude 1",
            "--project",
            "./child dir",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("host agent-stream plan");
    assert_eq!(plan.operation, CoreCliOperation::HostAgentStream);
    assert_eq!(
        plan.action,
        CoreCliAction::TextRoute {
            path: "/core/host-agent-stream-text?project=%2Fresolved%2F.%2Fchild%20dir&sessionId=claude%201&startLine=-2000&intervalMs=500".into(),
            body: None,
        }
    );

    let lines = classify_core_cli(
        &[
            "host",
            "agent-stream",
            "codex-1",
            "--lines=120",
            "--interval-ms",
            "250",
        ],
        &context(true, true),
    )
    .expect("host agent-stream --lines plan");
    assert_eq!(
        lines.action,
        CoreCliAction::TextRoute {
            path: "/core/host-agent-stream-text?project=%2Frepo&sessionId=codex-1&startLine=-120&intervalMs=250".into(),
            body: None,
        }
    );
}

#[test]
fn notification_aliases_plan_native_text_routes_with_resolved_project() {
    let notify = classify_core_cli_with_project_resolver(
        &[
            "notify",
            "--project",
            "./child dir",
            "--title",
            "Heads up",
            "--subtitle=Agent",
            "--body",
            "Ready",
            "--session=claude-1",
            "--kind",
            "attention",
            "--json",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("notify plan");
    assert_eq!(notify.operation, CoreCliOperation::NotificationSend);
    assert_eq!(
        notify.action,
        CoreCliAction::TextRoute {
            path: "/core/notifications/send-text?json=1".into(),
            body: Some(json!({
                "project": "/resolved/./child dir",
                "title": "Heads up",
                "subtitle": "Agent",
                "body": "Ready",
                "sessionId": "claude-1",
                "kind": "attention",
            })),
        }
    );

    let list = classify_core_cli(
        &[
            "list-notifications",
            "--unread",
            "--session",
            "claude 1",
            "--json",
        ],
        &context(true, true),
    )
    .expect("list notifications plan");
    assert_eq!(list.operation, CoreCliOperation::NotificationList);
    assert_eq!(
        list.action,
        CoreCliAction::TextRoute {
            path:
                "/core/notifications/list-text?project=%2Frepo&unread=1&sessionId=claude%201&json=1"
                    .into(),
            body: None,
        }
    );

    let read = classify_core_cli(
        &[
            "read-notifications",
            "--id=note-1",
            "--ids",
            "note-2,note-3",
            "--session=claude-1",
        ],
        &context(true, true),
    )
    .expect("read notifications plan");
    assert_eq!(read.operation, CoreCliOperation::NotificationRead);
    assert_eq!(
        read.action,
        CoreCliAction::TextRoute {
            path: "/core/notifications/read-text".into(),
            body: Some(json!({
                "project": "/repo",
                "id": "note-1",
                "ids": ["note-2", "note-3"],
                "sessionId": "claude-1",
            })),
        }
    );

    let clear = classify_core_cli(
        &["clear-notifications", "--ids=note-4,note-5"],
        &context(true, true),
    )
    .expect("clear notifications plan");
    assert_eq!(clear.operation, CoreCliOperation::NotificationClear);
    assert_eq!(
        clear.action,
        CoreCliAction::TextRoute {
            path: "/core/notifications/clear-text".into(),
            body: Some(json!({
                "project": "/repo",
                "id": null,
                "ids": ["note-4", "note-5"],
                "sessionId": null,
            })),
        }
    );
}

#[test]
fn collaboration_commands_plan_native_text_routes_with_resolved_project() {
    let message = classify_core_cli_with_project_resolver(
        &[
            "message",
            "send",
            "please",
            "--project",
            "./child",
            "--thread=thread-1",
            "--from=user",
            "--to=claude-1,codex-1",
            "--assignee=coder",
            "--tool=claude",
            "--worktree=feature",
            "--kind=decision",
            "--title=Ask",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("message send plan");
    assert_eq!(message.operation, CoreCliOperation::MessageSend);
    assert_eq!(
        message.action,
        CoreCliAction::TextRoute {
            path: "/core/message/send-text".into(),
            body: Some(json!({
                "project": "/resolved/./child",
                "thread": "thread-1",
                "from": "user",
                "to": "claude-1,codex-1",
                "assignee": "coder",
                "tool": "claude",
                "worktree": "feature",
                "kind": "decision",
                "body": "please",
                "title": "Ask",
            })),
        }
    );

    let handoff = classify_core_cli(
        &[
            "handoff",
            "send",
            "take over",
            "--to",
            "claude-1",
            "--title",
            "Takeover",
            "--json",
        ],
        &context(true, true),
    )
    .expect("handoff send plan");
    assert_eq!(handoff.operation, CoreCliOperation::HandoffSend);
    assert_eq!(
        handoff.action,
        CoreCliAction::TextRoute {
            path: "/core/handoff/send-text?json=1".into(),
            body: Some(json!({
                "project": "/repo",
                "from": null,
                "to": "claude-1",
                "assignee": null,
                "tool": null,
                "body": "take over",
                "title": "Takeover",
                "worktree": null,
            })),
        }
    );

    let accept = classify_core_cli(
        &[
            "handoff",
            "accept",
            "thread-1",
            "--from=claude-1",
            "--body=ok",
        ],
        &context(true, true),
    )
    .expect("handoff accept plan");
    assert_eq!(accept.operation, CoreCliOperation::HandoffAccept);
    assert_eq!(
        accept.action,
        CoreCliAction::TextRoute {
            path: "/core/handoff/accept-text".into(),
            body: Some(json!({
                "project": "/repo",
                "threadId": "thread-1",
                "from": "claude-1",
                "body": "ok",
            })),
        }
    );

    let complete = classify_core_cli(
        &["handoff", "complete", "thread-1", "--json"],
        &context(true, true),
    )
    .expect("handoff complete plan");
    assert_eq!(complete.operation, CoreCliOperation::HandoffComplete);
    assert_eq!(
        complete.action,
        CoreCliAction::TextRoute {
            path: "/core/handoff/complete-text?json=1".into(),
            body: Some(json!({
                "project": "/repo",
                "threadId": "thread-1",
                "from": null,
                "body": null,
            })),
        }
    );
}

#[test]
fn task_and_review_commands_plan_native_text_routes() {
    let list = classify_core_cli_with_project_resolver(
        &[
            "task",
            "list",
            "--session",
            "claude 1",
            "--status=todo",
            "--json",
            "--project",
            "./child",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("task list plan");
    assert_eq!(list.operation, CoreCliOperation::TaskList);
    assert_eq!(
        list.action,
        CoreCliAction::TextRoute {
            path: "/core/task/list-text?project=%2Fresolved%2F.%2Fchild&session=claude%201&status=todo&json=1".into(),
            body: None,
        }
    );

    let show = classify_core_cli(&["task", "show", "task 1"], &context(true, true))
        .expect("task show plan");
    assert_eq!(show.operation, CoreCliOperation::TaskShow);
    assert_eq!(
        show.action,
        CoreCliAction::TextRoute {
            path: "/core/task/show-text?project=%2Frepo&taskId=task%201".into(),
            body: None,
        }
    );

    let assign = classify_core_cli(
        &[
            "task",
            "assign",
            "Ship it",
            "--from=user",
            "--to=claude-1",
            "--assignee=coder",
            "--tool=claude",
            "--prompt=Implement",
            "--type=review",
            "--diff",
            "--- before\n+++ after",
            "--worktree=feature",
            "--json",
        ],
        &context(true, true),
    )
    .expect("task assign plan");
    assert_eq!(assign.operation, CoreCliOperation::TaskAssign);
    assert_eq!(
        assign.action,
        CoreCliAction::TextRoute {
            path: "/core/task/assign-text?json=1".into(),
            body: Some(json!({
                "project": "/repo",
                "from": "user",
                "to": "claude-1",
                "assignee": "coder",
                "tool": "claude",
                "description": "Ship it",
                "prompt": "Implement",
                "type": "review",
                "diff": "--- before\n+++ after",
                "worktree": "feature",
            })),
        }
    );

    let complete = classify_core_cli(
        &[
            "task",
            "complete",
            "task-1",
            "--from=claude-1",
            "--result=shipped",
        ],
        &context(true, true),
    )
    .expect("task complete plan");
    assert_eq!(complete.operation, CoreCliOperation::TaskComplete);
    assert_eq!(
        complete.action,
        CoreCliAction::TextRoute {
            path: "/core/task/complete-text".into(),
            body: Some(json!({
                "project": "/repo",
                "taskId": "task-1",
                "from": "claude-1",
                "body": null,
                "result": "shipped",
            })),
        }
    );

    let review = classify_core_cli(
        &[
            "review",
            "request-changes",
            "task-1",
            "--from=reviewer",
            "--body=fix",
            "--json",
        ],
        &context(true, true),
    )
    .expect("review request changes plan");
    assert_eq!(review.operation, CoreCliOperation::ReviewRequestChanges);
    assert_eq!(
        review.action,
        CoreCliAction::TextRoute {
            path: "/core/review/request-changes-text?json=1".into(),
            body: Some(json!({
                "project": "/repo",
                "taskId": "task-1",
                "from": "reviewer",
                "body": "fix",
            })),
        }
    );
}

#[test]
fn thread_commands_plan_native_text_routes() {
    let list = classify_core_cli_with_project_resolver(
        &[
            "thread",
            "list",
            "--session",
            "claude 1",
            "--json",
            "--project",
            "./child",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("thread list plan");
    assert_eq!(list.operation, CoreCliOperation::ThreadList);
    assert_eq!(
        list.action,
        CoreCliAction::TextRoute {
            path:
                "/core/thread/list-text?project=%2Fresolved%2F.%2Fchild&session=claude%201&json=1"
                    .into(),
            body: None,
        }
    );

    let show = classify_core_cli(&["thread", "show", "thread 1"], &context(true, true))
        .expect("thread show plan");
    assert_eq!(show.operation, CoreCliOperation::ThreadShow);
    assert_eq!(
        show.action,
        CoreCliAction::TextRoute {
            path: "/core/thread/show-text?project=%2Frepo&threadId=thread%201".into(),
            body: None,
        }
    );

    let open = classify_core_cli(
        &[
            "thread",
            "open",
            "--title=Plan",
            "--from=user",
            "--participants=claude-1,codex-1",
            "--kind=handoff",
            "--json",
        ],
        &context(true, true),
    )
    .expect("thread open plan");
    assert_eq!(open.operation, CoreCliOperation::ThreadOpen);
    assert_eq!(
        open.action,
        CoreCliAction::TextRoute {
            path: "/core/thread/open-text?json=1".into(),
            body: Some(json!({
                "project": "/repo",
                "title": "Plan",
                "from": "user",
                "participants": "claude-1,codex-1",
                "kind": "handoff",
            })),
        }
    );

    let send = classify_core_cli(
        &[
            "thread",
            "send",
            "thread-1",
            "body",
            "--from=user",
            "--to=claude-1",
            "--kind=reply",
        ],
        &context(true, true),
    )
    .expect("thread send plan");
    assert_eq!(send.operation, CoreCliOperation::ThreadSend);
    assert_eq!(
        send.action,
        CoreCliAction::TextRoute {
            path: "/core/thread/send-text".into(),
            body: Some(json!({
                "project": "/repo",
                "threadId": "thread-1",
                "from": "user",
                "to": "claude-1",
                "kind": "reply",
                "body": "body",
            })),
        }
    );

    let status = classify_core_cli(
        &[
            "thread",
            "status",
            "thread-1",
            "--status=waiting",
            "--owner=user",
            "--waiting-on=claude-1,codex-1",
        ],
        &context(true, true),
    )
    .expect("thread status plan");
    assert_eq!(status.operation, CoreCliOperation::ThreadStatus);
    assert_eq!(
        status.action,
        CoreCliAction::TextRoute {
            path: "/core/thread/status-text".into(),
            body: Some(json!({
                "project": "/repo",
                "threadId": "thread-1",
                "status": "waiting",
                "owner": "user",
                "waitingOn": "claude-1,codex-1",
            })),
        }
    );
}

#[test]
fn worktree_and_graveyard_commands_plan_native_text_routes() {
    let list = classify_core_cli_with_project_resolver(
        &["worktree", "list", "--project", "./child", "--json"],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("worktree list plan");
    assert_eq!(list.operation, CoreCliOperation::WorktreeList);
    assert_eq!(
        list.action,
        CoreCliAction::TextRoute {
            path: "/core/worktree/list-text?project=%2Fresolved%2F.%2Fchild&json=1".into(),
            body: None,
        }
    );

    let create = classify_core_cli(&["worktree", "create", "feature"], &context(true, true))
        .expect("worktree create plan");
    assert_eq!(create.operation, CoreCliOperation::WorktreeCreate);
    assert_eq!(
        create.action,
        CoreCliAction::TextRoute {
            path: "/core/worktree/create-text".into(),
            body: Some(json!({ "project": "/repo", "name": "feature" })),
        }
    );

    let cleanup = classify_core_cli(
        &[
            "worktree",
            "cleanup-caches",
            "--yes",
            "--include-active",
            "--json",
        ],
        &context(true, true),
    )
    .expect("worktree cleanup plan");
    assert_eq!(cleanup.operation, CoreCliOperation::WorktreeCacheCleanup);
    assert_eq!(
        cleanup.action,
        CoreCliAction::TextRoute {
            path: "/core/worktree/cache-cleanup-text?json=1".into(),
            body: Some(json!({
                "project": "/repo",
                "dryRun": false,
                "includeActive": true,
            })),
        }
    );

    let remove = classify_core_cli(
        &["worktree", "remove", "../feature", "--json"],
        &context(true, true),
    )
    .expect("worktree remove plan");
    assert_eq!(remove.operation, CoreCliOperation::WorktreeRemove);
    assert_eq!(
        remove.action,
        CoreCliAction::TextRoute {
            path: "/core/worktree/remove-text?json=1".into(),
            body: Some(json!({ "project": "/repo", "path": "../feature" })),
        }
    );

    let graveyard_list = classify_core_cli(&["graveyard", "list", "--json"], &context(true, true))
        .expect("graveyard list plan");
    assert_eq!(graveyard_list.operation, CoreCliOperation::GraveyardList);
    assert_eq!(
        graveyard_list.action,
        CoreCliAction::TextRoute {
            path: "/core/graveyard/list-text?project=%2Frepo&json=1".into(),
            body: None,
        }
    );

    let send = classify_core_cli(
        &["graveyard", "send", "claude-1", "--project=/repo"],
        &context(true, true),
    )
    .expect("graveyard send plan");
    assert_eq!(send.operation, CoreCliOperation::GraveyardSend);
    assert_eq!(
        send.action,
        CoreCliAction::TextRoute {
            path: "/core/graveyard/send-text".into(),
            body: Some(json!({ "project": "/repo", "sessionId": "claude-1" })),
        }
    );

    let cleanup_graveyard =
        classify_core_cli(&["graveyard", "cleanup", "--dry-run"], &context(true, true))
            .expect("graveyard cleanup plan");
    assert_eq!(
        cleanup_graveyard.operation,
        CoreCliOperation::GraveyardCleanup
    );
    assert_eq!(
        cleanup_graveyard.action,
        CoreCliAction::TextRoute {
            path: "/core/graveyard/cleanup-text".into(),
            body: Some(json!({ "project": "/repo", "dryRun": true })),
        }
    );
}

#[test]
fn metadata_and_repair_commands_plan_native_text_routes() {
    let metadata = classify_core_cli(
        &[
            "metadata",
            "event",
            "claude-1",
            "ready",
            "--message",
            "needs review",
        ],
        &context(true, true),
    )
    .expect("metadata plan");
    assert_eq!(metadata.operation, CoreCliOperation::Metadata);
    assert_eq!(
        metadata.action,
        CoreCliAction::TextRoute {
            path: "/core/metadata-text?project=%2Frepo&arg=metadata&arg=event&arg=claude-1&arg=ready&arg=--message&arg=needs%20review".into(),
            body: None,
        }
    );

    let repair = classify_core_cli_with_project_resolver(
        &["repair", "--project-root", "./child", "--open", "--json"],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("repair plan");
    assert_eq!(repair.operation, CoreCliOperation::Repair);
    assert_eq!(
        repair.action,
        CoreCliAction::TextRoute {
            path: "/core/repair-text?json=1".into(),
            body: Some(json!({ "projectRoot": "/resolved/./child", "open": true })),
        }
    );

    let exchange = classify_core_cli_with_project_resolver(
        &["repair", "exchange", "--project=./child", "--json"],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("repair exchange plan");
    assert_eq!(exchange.operation, CoreCliOperation::RepairExchange);
    assert_eq!(
        exchange.action,
        CoreCliAction::TextRoute {
            path: "/core/repair-exchange-text?json=1".into(),
            body: Some(json!({ "projectRoot": "/resolved/./child" })),
        }
    );
}

#[test]
fn doctor_disk_and_tmux_commands_plan_native_text_routes() {
    let disk = classify_core_cli_with_project_resolver(
        &[
            "doctor",
            "disk",
            "--project",
            "./child",
            "--include-active",
            "--json",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("doctor disk plan");
    assert_eq!(disk.operation, CoreCliOperation::DoctorDisk);
    assert_eq!(
        disk.action,
        CoreCliAction::TextRoute {
            path: "/core/doctor/disk-text?project=%2Fresolved%2F.%2Fchild&includeActive=1&json=1"
                .into(),
            body: None,
        }
    );

    let disk_all = classify_core_cli(&["doctor", "disk"], &context(true, true))
        .expect("doctor disk all projects plan");
    assert_eq!(
        disk_all.action,
        CoreCliAction::TextRoute {
            path: "/core/doctor/disk-text".into(),
            body: None,
        }
    );

    let exchange = classify_core_cli_with_project_resolver(
        &["doctor", "exchange", "--project=./child", "--json"],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("doctor exchange plan");
    assert_eq!(exchange.operation, CoreCliOperation::DoctorExchange);
    assert_eq!(
        exchange.action,
        CoreCliAction::TextRoute {
            path: "/core/doctor/exchange-text?projectRoot=%2Fresolved%2F.%2Fchild&json=1".into(),
            body: None,
        }
    );

    let lifecycle = classify_core_cli(&["doctor", "lifecycle"], &context(true, true))
        .expect("doctor lifecycle plan");
    assert_eq!(lifecycle.operation, CoreCliOperation::DoctorLifecycle);
    assert_eq!(
        lifecycle.action,
        CoreCliAction::TextRoute {
            path: "/core/doctor/lifecycle-text?projectRoot=%2Frepo".into(),
            body: None,
        }
    );

    let tmux = classify_core_cli_with_project_resolver(
        &[
            "doctor",
            "tmux",
            "--project-root=./child",
            "--session",
            "aimux-repo",
            "--window-id",
            "@1",
            "--json",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("doctor tmux plan");
    assert_eq!(tmux.operation, CoreCliOperation::DoctorTmux);
    assert_eq!(
        tmux.action,
        CoreCliAction::TextRoute {
            path: "/core/doctor/tmux-text?projectRoot=%2Fresolved%2F.%2Fchild&session=aimux-repo&windowId=%401&json=1".into(),
            body: None,
        }
    );
}

#[test]
fn agent_ps_plans_native_text_route_with_project_resolution() {
    let plan = classify_core_cli_with_project_resolver(
        &["ps", "--project", "./child dir", "--json"],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("ps plan");
    assert_eq!(plan.operation, CoreCliOperation::AgentPs);
    assert_eq!(plan.output_mode, CoreCliOutputMode::Json);
    assert_eq!(
        plan.action,
        CoreCliAction::TextRoute {
            path: "/core/agents/ps-text?project=%2Fresolved%2F.%2Fchild%20dir&json=1".into(),
            body: None,
        }
    );

    let default_project = classify_core_cli(&["ps"], &context(true, true)).expect("default ps");
    assert_eq!(
        default_project.action,
        CoreCliAction::TextRoute {
            path: "/core/agents/ps-text?project=%2Frepo".into(),
            body: None,
        }
    );

    let malformed = classify_core_cli(&["ps", "--project", "--json"], &context(true, true))
        .expect_err("malformed ps");
    assert_eq!(malformed.exit_code(), 1);
}

#[test]
fn agent_input_plans_native_text_route_with_variadic_text_body() {
    let plan = classify_core_cli_with_project_resolver(
        &[
            "input",
            "claude-1",
            "hello",
            "there",
            "--project",
            "./child",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("input plan");
    assert_eq!(plan.operation, CoreCliOperation::AgentInput);
    assert_eq!(
        plan.action,
        CoreCliAction::TextRoute {
            path: "/core/agents/input-text".into(),
            body: Some(json!({
                "project": "/resolved/./child",
                "sessionId": "claude-1",
                "text": "hello there",
            })),
        }
    );

    let literal = classify_core_cli(&["input", "claude-1", "--", "--flag"], &context(true, true))
        .expect("literal input plan");
    assert_eq!(
        literal.action,
        CoreCliAction::TextRoute {
            path: "/core/agents/input-text".into(),
            body: Some(json!({
                "project": "/repo",
                "sessionId": "claude-1",
                "text": "--flag",
            })),
        }
    );

    let empty = classify_core_cli(&["input", "claude-1", "  "], &context(true, true))
        .expect_err("empty input");
    assert_eq!(empty.to_string(), "aimux: input requires non-empty text");
    assert_eq!(empty.exit_code(), 1);
}

#[test]
fn agent_rename_and_migrate_plan_native_text_routes() {
    let rename = classify_core_cli_with_project_resolver(
        &[
            "rename",
            "claude-1",
            "--label",
            "reviewer",
            "--project",
            "./child",
            "--json",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("rename plan");
    assert_eq!(rename.operation, CoreCliOperation::AgentRename);
    assert_eq!(
        rename.action,
        CoreCliAction::TextRoute {
            path: "/core/agents/rename-text?json=1".into(),
            body: Some(json!({
                "project": "/resolved/./child",
                "sessionId": "claude-1",
                "label": "reviewer",
            })),
        }
    );

    let migrate = classify_core_cli(
        &["migrate", "claude-1", "--worktree", "feature"],
        &context(true, true),
    )
    .expect("migrate plan");
    assert_eq!(migrate.operation, CoreCliOperation::AgentMigrate);
    assert_eq!(
        migrate.action,
        CoreCliAction::TextRoute {
            path: "/core/agents/migrate-text".into(),
            body: Some(json!({
                "project": "/repo",
                "sessionId": "claude-1",
                "worktreePath": "feature",
            })),
        }
    );

    assert_eq!(
        classify_core_cli(&["rename", "claude-1"], &context(true, true))
            .expect_err("rename missing label")
            .exit_code(),
        1
    );
    assert_eq!(
        classify_core_cli(&["migrate", "claude-1"], &context(true, true))
            .expect_err("migrate missing worktree")
            .exit_code(),
        1
    );
}

#[test]
fn lifecycle_commands_plan_native_text_routes() {
    let spawn = classify_core_cli_with_project_resolver(
        &[
            "spawn",
            "--tool",
            "claude",
            "--project",
            "./child",
            "--worktree",
            "feature",
            "--no-open",
            "--json",
        ],
        &context(true, true),
        |project| format!("/resolved/{project}"),
    )
    .expect("spawn plan");
    assert_eq!(spawn.operation, CoreCliOperation::LifecycleSpawn);
    assert_eq!(
        spawn.action,
        CoreCliAction::TextRoute {
            path: "/core/lifecycle/spawn-text?json=1".into(),
            body: Some(json!({
                "project": "/resolved/./child",
                "tool": "claude",
                "worktreePath": "feature",
                "open": false,
            })),
        }
    );

    let stop = classify_core_cli(&["stop", "claude-1"], &context(true, true)).expect("stop plan");
    assert_eq!(stop.operation, CoreCliOperation::LifecycleStop);
    assert_eq!(
        stop.action,
        CoreCliAction::TextRoute {
            path: "/core/lifecycle/stop-text".into(),
            body: Some(json!({ "project": "/repo", "sessionId": "claude-1" })),
        }
    );

    let kill = classify_core_cli(&["kill", "claude-1", "--json"], &context(true, true))
        .expect("kill plan");
    assert_eq!(kill.operation, CoreCliOperation::LifecycleKill);
    assert_eq!(
        kill.action,
        CoreCliAction::TextRoute {
            path: "/core/lifecycle/kill-text?json=1".into(),
            body: Some(json!({ "project": "/repo", "sessionId": "claude-1" })),
        }
    );

    let fork = classify_core_cli(
        &[
            "fork",
            "claude-1",
            "--tool",
            "codex",
            "--instruction",
            "continue",
            "--worktree",
            "../other",
        ],
        &context(true, true),
    )
    .expect("fork plan");
    assert_eq!(fork.operation, CoreCliOperation::LifecycleFork);
    assert_eq!(
        fork.action,
        CoreCliAction::TextRoute {
            path: "/core/lifecycle/fork-text".into(),
            body: Some(json!({
                "project": "/repo",
                "sourceSessionId": "claude-1",
                "tool": "codex",
                "instruction": "continue",
                "worktreePath": "../other",
                "open": true,
            })),
        }
    );

    assert!(classify_core_cli(&["stop"], &context(true, true)).is_err());
}

#[test]
fn loop_commands_plan_native_text_routes_with_actor_defaults() {
    let add = classify_core_cli(
        &["loop", "add", "claude-1", "--goal", "keep going"],
        &context(true, true),
    )
    .expect("loop add plan");
    assert_eq!(add.operation, CoreCliOperation::LoopAdd);
    assert_eq!(
        add.action,
        CoreCliAction::TextRoute {
            path: "/core/loop/add-text".into(),
            body: Some(json!({
                "project": "/repo",
                "sessionId": "claude-1",
                "source": "human",
                "goal": "keep going",
            })),
        }
    );

    let remove = classify_core_cli(
        &["loop", "remove", "claude-1", "--project=/repo"],
        &context(true, true),
    )
    .expect("loop remove plan");
    assert_eq!(remove.operation, CoreCliOperation::LoopRemove);
    assert_eq!(
        remove.action,
        CoreCliAction::TextRoute {
            path: "/core/loop/remove-text".into(),
            body: Some(json!({
                "project": "/repo",
                "sessionId": "claude-1",
                "source": "human",
            })),
        }
    );

    let done = classify_core_cli(
        &[
            "loop",
            "done",
            "--session",
            "claude-1",
            "--reason",
            "done",
            "--json",
        ],
        &context(true, true),
    )
    .expect("loop done plan");
    assert_eq!(done.operation, CoreCliOperation::LoopDone);
    assert_eq!(
        done.action,
        CoreCliAction::TextRoute {
            path: "/core/loop/done-text?json=1".into(),
            body: Some(json!({
                "project": "/repo",
                "sessionId": "claude-1",
                "source": "agent",
                "reason": "done",
            })),
        }
    );

    let block = classify_core_cli(
        &["loop", "block", "--session=claude-1"],
        &context(true, true),
    )
    .expect("loop block plan");
    assert_eq!(block.operation, CoreCliOperation::LoopBlock);
    assert_eq!(
        block.action,
        CoreCliAction::TextRoute {
            path: "/core/loop/block-text".into(),
            body: Some(json!({
                "project": "/repo",
                "sessionId": "claude-1",
                "source": "agent",
            })),
        }
    );

    let missing_session = classify_core_cli(&["loop", "done"], &context(true, true))
        .expect_err("missing loop session");
    assert_eq!(
        missing_session.to_string(),
        "aimux: pass --session or run inside an aimux agent (AIMUX_SESSION_ID is unset)"
    );
}

#[test]
fn overseer_commands_plan_native_text_routes() {
    let start = classify_core_cli(
        &[
            "overseer",
            "start",
            "--tool",
            "claude",
            "--worktree",
            "feature",
            "--no-open",
            "--json",
        ],
        &context(true, true),
    )
    .expect("overseer start plan");
    assert_eq!(start.operation, CoreCliOperation::OverseerStart);
    assert_eq!(
        start.action,
        CoreCliAction::TextRoute {
            path: "/core/overseer/start-text?json=1".into(),
            body: Some(json!({
                "project": "/repo",
                "tool": "claude",
                "worktreePath": "feature",
                "open": false,
            })),
        }
    );

    let clear = classify_core_cli(
        &["overseer", "clear", "boss", "--project=/repo"],
        &context(true, true),
    )
    .expect("overseer clear plan");
    assert_eq!(clear.operation, CoreCliOperation::OverseerClear);
    assert_eq!(
        clear.action,
        CoreCliAction::TextRoute {
            path: "/core/overseer/clear-text".into(),
            body: Some(json!({ "project": "/repo", "sessionId": "boss" })),
        }
    );

    assert_eq!(
        classify_core_cli(&["overseer", "clear"], &context(true, true))
            .expect_err("missing overseer session")
            .exit_code(),
        1
    );
}

#[test]
fn team_commands_plan_native_text_routes() {
    let show = classify_core_cli(&["team", "show", "--project=/repo"], &context(true, true))
        .expect("team show plan");
    assert_eq!(show.operation, CoreCliOperation::TeamShow);
    assert_eq!(
        show.action,
        CoreCliAction::TextRoute {
            path: "/core/team/show-text?project=%2Frepo".into(),
            body: None,
        }
    );

    let init = classify_core_cli(&["team", "init", "--json"], &context(true, true))
        .expect("team init plan");
    assert_eq!(init.operation, CoreCliOperation::TeamInit);
    assert_eq!(
        init.action,
        CoreCliAction::TextRoute {
            path: "/core/team/init-text?json=1".into(),
            body: Some(json!({ "project": "/repo" })),
        }
    );

    let add = classify_core_cli(
        &[
            "team",
            "add",
            "planner",
            "-d",
            "Plans work",
            "--reviewed-by",
            "reviewer",
            "--can-edit",
            "--json",
        ],
        &context(true, true),
    )
    .expect("team add plan");
    assert_eq!(add.operation, CoreCliOperation::TeamAdd);
    assert_eq!(
        add.action,
        CoreCliAction::TextRoute {
            path: "/core/team/add-text?json=1".into(),
            body: Some(json!({
                "project": "/repo",
                "role": "planner",
                "description": "Plans work",
                "reviewedBy": "reviewer",
                "canEdit": true,
            })),
        }
    );

    let default_role = classify_core_cli(&["team", "default", "planner"], &context(true, true))
        .expect("team default plan");
    assert_eq!(default_role.operation, CoreCliOperation::TeamDefault);
    let remove = classify_core_cli(
        &["team", "remove", "--json", "planner"],
        &context(true, true),
    )
    .expect("team remove plan");
    assert_eq!(remove.operation, CoreCliOperation::TeamRemove);
}

#[test]
fn invalid_host_agent_stream_args_fail_before_node_fallback() {
    let invalid_lines = classify_core_cli(
        &["host", "agent-stream", "claude-1", "--lines", "-5"],
        &context(true, true),
    )
    .expect_err("non-positive stream lines");
    assert_eq!(
        invalid_lines.to_string(),
        "Error: --lines must be a positive integer"
    );

    let invalid_start = classify_core_cli(
        &["host", "agent-stream", "claude-1", "--start-line", "10px"],
        &context(true, true),
    )
    .expect_err("invalid stream start-line");
    assert_eq!(
        invalid_start.to_string(),
        "Error: --start-line must be an integer"
    );

    let invalid_interval = classify_core_cli(
        &["host", "agent-stream", "claude-1", "--interval-ms", "99"],
        &context(true, true),
    )
    .expect_err("invalid stream interval");
    assert_eq!(
        invalid_interval.to_string(),
        "Error: --interval-ms must be an integer >= 100"
    );
    assert_eq!(invalid_interval.exit_code(), 1);
}

#[test]
fn daemon_status_uses_a_bounded_existing_daemon_request_and_stored_state_fallback() {
    let plan = classify_core_cli(&["daemon", "status", "--json"], &context(false, false))
        .expect("daemon status plan");
    assert_eq!(plan.operation, CoreCliOperation::DaemonStatus);
    assert_eq!(plan.output_mode, CoreCliOutputMode::Json);
    assert_eq!(plan.fallback, CoreCliFallback::StoredDaemonStatus);
    let request = command_from(&plan.action);
    assert_eq!(request.0, CORE_COMMAND_NAMES.status);
    assert!(!request.2);
    assert_eq!(request.3, Some(CORE_DIAGNOSTIC_TIMEOUT_MS));
}

#[test]
fn local_diagnostics_and_restart_do_not_become_command_requests() {
    let logs = classify_core_cli(
        &["logs", "tail", "--project", "-foo", "-n", "-5"],
        &context(true, true),
    )
    .expect("logs plan");
    assert!(matches!(logs.action, CoreCliAction::Logs(_)));
    assert_eq!(logs.fallback, CoreCliFallback::EmptyLogTail);

    let daemon_restart = classify_core_cli(&["daemon", "restart", "--json"], &context(true, true))
        .expect("daemon restart plan");
    assert_eq!(daemon_restart.operation, CoreCliOperation::DaemonRestart);
    assert_eq!(daemon_restart.output_mode, CoreCliOutputMode::Json);
    assert_eq!(
        daemon_restart.action,
        CoreCliAction::RestartControlPlane { project_root: None }
    );
}

#[test]
fn remote_status_requests_the_relay_only_when_credentials_and_daemon_exist() {
    for (daemon, credentials, expects_request) in [
        (true, true, true),
        (true, false, false),
        (false, true, false),
        (false, false, false),
    ] {
        let plan = classify_core_cli(&["remote", "status"], &context(daemon, credentials))
            .expect("remote status plan");
        assert_eq!(plan.fallback, CoreCliFallback::RelayOff);
        let CoreCliAction::RemoteStatus { relay_request } = plan.action else {
            panic!("expected remote status action");
        };
        assert_eq!(relay_request.is_some(), expects_request);
        if let Some(request) = relay_request {
            assert_eq!(request.command, CORE_COMMAND_NAMES.relay_status);
            assert!(!request.options.ensure_daemon);
            assert_eq!(request.options.timeout_ms, Some(CORE_DIAGNOSTIC_TIMEOUT_MS));
        }
    }
}

#[test]
fn remote_enable_and_disable_preserve_credential_and_daemon_fallbacks() {
    let enable = classify_core_cli(&["remote", "enable"], &context(true, false))
        .expect("remote enable plan");
    assert_eq!(enable.fallback, CoreCliFallback::NotLoggedIn);
    assert!(matches!(
        enable.action,
        CoreCliAction::RemoteEnable {
            relay_request: None
        }
    ));

    let disable = classify_core_cli(&["remote", "disable"], &context(false, true))
        .expect("remote disable plan");
    assert_eq!(disable.fallback, CoreCliFallback::DisableRemoteLocally);
    assert!(matches!(
        disable.action,
        CoreCliAction::RemoteDisable {
            relay_request: None
        }
    ));

    let live_disable = classify_core_cli(&["remote", "disable"], &context(true, true))
        .expect("live remote disable plan");
    let CoreCliAction::RemoteDisable {
        relay_request: Some(request),
    } = live_disable.action
    else {
        panic!("expected relay disable request");
    };
    assert_eq!(request.command, CORE_COMMAND_NAMES.relay_disable);
    assert!(!request.options.ensure_daemon);
}

#[test]
fn auth_plans_capture_best_effort_relay_behavior() {
    let logout = classify_core_cli(&["logout"], &context(true, true)).expect("logout plan");
    assert_eq!(logout.fallback, CoreCliFallback::IgnoreRelayDisableFailure);
    assert!(matches!(
        logout.action,
        CoreCliAction::Logout {
            relay_disable: Some(_)
        }
    ));

    let login = classify_core_cli(&["login"], &context(true, false)).expect("login plan");
    assert_eq!(login.fallback, CoreCliFallback::RelayDisconnected);
    assert!(matches!(
        login.action,
        CoreCliAction::Login {
            security_unlock: false,
            relay_enable: Some(_)
        }
    ));

    let unlock = classify_core_cli(&["security", "unlock"], &context(false, false))
        .expect("security unlock plan");
    assert_eq!(
        unlock.fallback,
        CoreCliFallback::RelayDeferredUntilDaemonStart
    );
    assert!(matches!(
        unlock.action,
        CoreCliAction::Login {
            security_unlock: true,
            relay_enable: None
        }
    ));
}

#[test]
fn malformed_mutation_is_invalid_while_other_unknown_forms_are_unsupported() {
    let malformed = classify_core_cli(
        &["daemon", "project-ensure", "--project", "--json"],
        &context(true, true),
    )
    .expect_err("malformed project ensure must fail");
    assert_eq!(malformed.exit_code(), 1);
    assert!(matches!(
        malformed,
        CoreCliPlanError::InvalidArguments { .. }
    ));

    for args in [
        vec!["remote", "enable", "--json"],
        vec!["daemon", "status", "extra"],
        vec!["unknown", "command"],
    ] {
        let error = classify_core_cli(&args, &context(true, true)).expect_err("unsupported form");
        assert_eq!(error.exit_code(), 2, "{args:?}");
        assert!(matches!(error, CoreCliPlanError::Unsupported { .. }));
    }
}

#[test]
fn direct_core_planning_strips_global_logging_args_like_run_core_cli() {
    let plan = classify_core_cli(
        &["--debug", "remote", "--log-level", "trace", "status"],
        &context(true, true),
    )
    .expect("normalized core plan");
    assert_eq!(plan.args, ["remote", "status"]);
}

#[test]
fn command_transport_contract_matches_posted_json_envelope() {
    let request = build_core_command_transport_request(
        CORE_COMMAND_NAMES.project_restart,
        Some(json!({ "projectRoot": "/repo", "serve": false })),
        Some(1_234),
    )
    .expect("serializable request");
    assert_eq!(request.route, CORE_API_ROUTES.commands);
    assert_eq!(request.method, CoreHttpMethod::Post);
    assert_eq!(request.method.as_str(), "POST");
    assert_eq!(
        request.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
    assert_eq!(request.timeout_ms, Some(1_234));
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).expect("JSON body"),
        json!({
            "command": "core.project.restart",
            "payload": { "projectRoot": "/repo", "serve": false }
        })
    );

    let no_payload = build_core_command_transport_request(CORE_COMMAND_NAMES.ping, None, None)
        .expect("serializable request");
    assert_eq!(
        serde_json::from_str::<Value>(&no_payload.body).expect("JSON body"),
        json!({ "command": "core.ping" })
    );
}

#[test]
fn command_response_validation_matches_error_and_mismatch_behavior() {
    let response = validate_core_command_response(
        CORE_COMMAND_NAMES.ping,
        json!({
            "ok": true,
            "id": "test",
            "command": "core.ping",
            "issuedAt": "1970-01-01T00:00:00.000Z",
            "result": { "pong": true }
        }),
    )
    .expect("matching response");
    assert_eq!(response.result, json!({ "pong": true }));

    let command_error = validate_core_command_response(
        CORE_COMMAND_NAMES.ping,
        json!({ "ok": false, "error": "bad command" }),
    )
    .expect_err("command error");
    assert_eq!(command_error.to_string(), "bad command");

    let mismatch = validate_core_command_response(
        CORE_COMMAND_NAMES.ping,
        json!({
            "ok": true,
            "id": "test",
            "command": "core.status",
            "issuedAt": "1970-01-01T00:00:00.000Z",
            "result": { "pong": true }
        }),
    )
    .expect_err("mismatched response");
    assert_eq!(
        mismatch,
        CoreCommandResponseError::CommandMismatch {
            expected: "core.ping".into(),
            actual: "core.status".into(),
        }
    );
    assert_eq!(
        mismatch.to_string(),
        "core command response mismatch: expected core.ping, got core.status"
    );
}
