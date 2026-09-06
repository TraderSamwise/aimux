use aimux::core_cli_routing::{
    CoreAgentInputArgs, CoreAgentPsArgs, CoreDaemonRestartArgs, CoreHostAgentReadArgs,
    CoreHostAgentStreamArgs, CoreHostRestartArgs, CoreLogsArgs, CoreLogsSubcommand,
    CoreNotificationArgs, CoreProjectEnsureArgs, CoreRestartArgs, core_command_args,
    has_core_global_logging_args, is_core_cli_command, is_core_project_ensure_command,
    is_valid_core_project_ensure_args, parse_core_agent_input_args, parse_core_agent_migrate_args,
    parse_core_agent_ps_args, parse_core_agent_rename_args, parse_core_daemon_restart_args,
    parse_core_dashboard_reload_args, parse_core_host_agent_read_args,
    parse_core_host_agent_stream_args, parse_core_host_restart_args,
    parse_core_lifecycle_fork_args, parse_core_lifecycle_spawn_args,
    parse_core_lifecycle_status_args, parse_core_logs_args, parse_core_loop_exit_args,
    parse_core_loop_mutation_args, parse_core_notification_args, parse_core_overseer_clear_args,
    parse_core_overseer_start_args, parse_core_project_ensure_args, parse_core_restart_args,
    parse_core_runtime_restart_args, parse_core_team_args,
};

#[test]
fn core_command_args_matches_node_prefix_and_logging_normalization() {
    assert_eq!(
        core_command_args(&[
            "/opt/node/bin/node",
            "/opt/aimux/bin/aimux",
            "--debug",
            "remote",
            "--log-level",
            "debug",
            "status",
            "--log-category=http",
            "--trace",
        ]),
        ["remote", "status"]
    );
    assert_eq!(
        core_command_args(&[
            r"C:\Program Files\node.exe",
            r"C:\aimux\bin\aimux",
            "whoami",
        ]),
        ["whoami"]
    );
    assert_eq!(core_command_args(&["node"]), ["node"]);
    assert_eq!(
        core_command_args(&["logs", "tail", "--log-level", "--daemon", "--log-category=",]),
        ["logs", "tail", "--log-level", "--daemon", "--log-category="]
    );
}

#[test]
fn logging_arg_detection_matches_the_unstripped_input() {
    assert!(has_core_global_logging_args(&[
        "node", "aimux", "--debug", "whoami"
    ]));
    assert!(has_core_global_logging_args(&[
        "remote",
        "status",
        "--log-level=debug"
    ]));
    assert!(has_core_global_logging_args(&[
        "remote",
        "status",
        "--log-category="
    ]));
    assert!(!has_core_global_logging_args(&[
        "node", "aimux", "remote", "status"
    ]));
}

#[test]
fn project_ensure_parser_matches_commander_compatible_forms() {
    assert_eq!(
        parse_core_project_ensure_args(&[
            "daemon",
            "project-ensure",
            "--project=/wrong",
            "--project",
            "/repo",
            "--json",
        ]),
        Some(CoreProjectEnsureArgs {
            project: "/repo".into(),
            json: true,
        })
    );
    for args in [
        vec!["daemon", "project-ensure"],
        vec!["daemon", "project-ensure", "--project", "--json"],
        vec!["daemon", "project-ensure", "--project="],
        vec![
            "daemon",
            "project-ensure",
            "--project",
            "/repo",
            "--dry-run",
        ],
    ] {
        assert_eq!(parse_core_project_ensure_args(&args), None, "{args:?}");
        assert!(is_core_project_ensure_command(&args));
        assert!(!is_valid_core_project_ensure_args(&args));
    }
}

#[test]
fn restart_parsers_keep_global_and_daemon_forms_distinct() {
    assert_eq!(
        parse_core_restart_args(&[
            "restart",
            "--project",
            "/wrong",
            "--project=/repo",
            "--json",
        ]),
        Some(CoreRestartArgs {
            json: true,
            project: Some("/repo".into()),
        })
    );
    assert_eq!(
        parse_core_daemon_restart_args(&["daemon", "restart", "--json"]),
        Some(CoreDaemonRestartArgs { json: true })
    );
    assert_eq!(
        parse_core_daemon_restart_args(&["daemon", "restart", "--project", "/repo"]),
        None
    );
    assert_eq!(
        parse_core_restart_args(&["restart", "--project", "-repo"]),
        None
    );
}

#[test]
fn agent_ps_parser_matches_project_json_forms() {
    assert_eq!(
        parse_core_agent_ps_args(&["ps"]),
        Some(CoreAgentPsArgs {
            project: None,
            json: false,
        })
    );
    assert_eq!(
        parse_core_agent_ps_args(&["ps", "--project=/repo", "--json"]),
        Some(CoreAgentPsArgs {
            project: Some("/repo".into()),
            json: true,
        })
    );
    assert_eq!(
        parse_core_agent_ps_args(&["ps", "--project", "./child", "--project", "/repo"]),
        Some(CoreAgentPsArgs {
            project: Some("/repo".into()),
            json: false,
        })
    );
    assert_eq!(parse_core_agent_ps_args(&["ps", "--project"]), None);
    assert_eq!(parse_core_agent_ps_args(&["ps", "--project=-repo"]), None);
    assert_eq!(parse_core_agent_ps_args(&["ps", "extra"]), None);
}

#[test]
fn agent_input_parser_preserves_variadic_text_and_project_option() {
    assert_eq!(
        parse_core_agent_input_args(&["input", "claude-1", "hello", "there", "--project", "/repo"]),
        Some(CoreAgentInputArgs {
            session_id: "claude-1".into(),
            text: "hello there".into(),
            project: Some("/repo".into()),
        })
    );
    assert_eq!(
        parse_core_agent_input_args(&["input", "claude-1", "--", "--flag"]),
        Some(CoreAgentInputArgs {
            session_id: "claude-1".into(),
            text: "--flag".into(),
            project: None,
        })
    );
    assert_eq!(parse_core_agent_input_args(&["input", "claude-1"]), None);
    assert_eq!(
        parse_core_agent_input_args(&["input", "claude-1", "   "]),
        None
    );
    assert_eq!(
        parse_core_agent_input_args(&["input", "claude-1", "hello", "--project", "--bad"]),
        None
    );
}

#[test]
fn agent_rename_and_migrate_parsers_match_required_options() {
    let rename = parse_core_agent_rename_args(&[
        "rename",
        "claude-1",
        "--label",
        "reviewer",
        "--project=/repo",
        "--json",
    ])
    .expect("rename args");
    assert_eq!(rename.session_id, "claude-1");
    assert_eq!(rename.label, "reviewer");
    assert_eq!(rename.project.as_deref(), Some("/repo"));
    assert!(rename.json);

    let clear = parse_core_agent_rename_args(&["rename", "claude-1", "--label="])
        .expect("clear label args");
    assert_eq!(clear.label, "");

    let migrate = parse_core_agent_migrate_args(&[
        "migrate",
        "claude-1",
        "--worktree",
        "feature",
        "--project",
        "/repo",
    ])
    .expect("migrate args");
    assert_eq!(migrate.session_id, "claude-1");
    assert_eq!(migrate.worktree, "feature");
    assert_eq!(migrate.project.as_deref(), Some("/repo"));
    assert!(!migrate.json);

    assert!(parse_core_agent_rename_args(&["rename", "claude-1"]).is_none());
    assert!(parse_core_agent_migrate_args(&["migrate", "claude-1"]).is_none());
    assert!(parse_core_agent_migrate_args(&["migrate", "claude-1", "--worktree", "-x"]).is_none());
}

#[test]
fn lifecycle_parsers_match_spawn_stop_kill_and_fork_forms() {
    let spawn = parse_core_lifecycle_spawn_args(&[
        "spawn",
        "--tool",
        "claude",
        "--worktree=feature",
        "--no-open",
        "--json",
    ])
    .expect("spawn args");
    assert_eq!(spawn.tool, "claude");
    assert_eq!(spawn.worktree.as_deref(), Some("feature"));
    assert!(!spawn.open);
    assert!(spawn.json);

    let stop =
        parse_core_lifecycle_status_args(&["stop", "claude-1", "--project", "/repo"], "stop")
            .expect("stop args");
    assert_eq!(stop.session_id, "claude-1");
    assert_eq!(stop.project.as_deref(), Some("/repo"));

    let kill = parse_core_lifecycle_status_args(&["kill", "claude-1", "--json"], "kill")
        .expect("kill args");
    assert_eq!(kill.session_id, "claude-1");
    assert!(kill.json);

    let fork = parse_core_lifecycle_fork_args(&[
        "fork",
        "claude-1",
        "--tool=codex",
        "--instruction",
        "continue",
        "--worktree",
        "../other",
    ])
    .expect("fork args");
    assert_eq!(fork.source_session_id, "claude-1");
    assert_eq!(fork.tool, "codex");
    assert_eq!(fork.instruction.as_deref(), Some("continue"));
    assert_eq!(fork.worktree.as_deref(), Some("../other"));
    assert!(fork.open);

    assert!(parse_core_lifecycle_spawn_args(&["spawn", "--tool"]).is_none());
    assert!(parse_core_lifecycle_fork_args(&["fork", "claude-1"]).is_none());
    assert!(parse_core_lifecycle_status_args(&["stop"], "stop").is_none());
    assert!(!is_core_cli_command(&["stop"]));
    assert!(is_core_cli_command(&["stop", "claude-1"]));
    assert!(is_core_cli_command(&["stop", "--bad"]));
}

#[test]
fn loop_parsers_match_mutation_and_exit_forms() {
    let add = parse_core_loop_mutation_args(&[
        "loop",
        "add",
        "claude-1",
        "--goal",
        "keep going",
        "--project=/repo",
    ])
    .expect("loop add");
    assert_eq!(add.subcommand, "add");
    assert_eq!(add.session_id, "claude-1");
    assert_eq!(add.goal.as_deref(), Some("keep going"));
    assert_eq!(add.project.as_deref(), Some("/repo"));

    let remove =
        parse_core_loop_mutation_args(&["loop", "remove", "claude-1"]).expect("loop remove");
    assert_eq!(remove.subcommand, "remove");
    assert_eq!(remove.session_id, "claude-1");

    let done = parse_core_loop_exit_args(&[
        "loop",
        "done",
        "--session",
        "claude-1",
        "--reason=done",
        "--json",
    ])
    .expect("loop done");
    assert_eq!(done.subcommand, "done");
    assert_eq!(done.session_id.as_deref(), Some("claude-1"));
    assert_eq!(done.reason.as_deref(), Some("done"));
    assert!(done.json);

    let block =
        parse_core_loop_exit_args(&["loop", "block", "--project", "/repo"]).expect("loop block");
    assert_eq!(block.subcommand, "block");
    assert_eq!(block.project.as_deref(), Some("/repo"));

    assert!(parse_core_loop_mutation_args(&["loop", "add"]).is_none());
    assert!(
        parse_core_loop_mutation_args(&["loop", "remove", "claude-1", "--goal", "x"]).is_none()
    );
    assert!(parse_core_loop_exit_args(&["loop", "done", "--session"]).is_none());
}

#[test]
fn overseer_parsers_match_start_and_clear_forms() {
    let start = parse_core_overseer_start_args(&[
        "overseer",
        "start",
        "--tool",
        "claude",
        "--worktree=feature",
        "--no-open",
        "--json",
    ])
    .expect("overseer start");
    assert_eq!(start.tool.as_deref(), Some("claude"));
    assert_eq!(start.worktree.as_deref(), Some("feature"));
    assert!(!start.open);
    assert!(start.json);

    let default_tool = parse_core_overseer_start_args(&["overseer", "start"])
        .expect("overseer start default tool");
    assert_eq!(default_tool.tool, None);

    let clear = parse_core_overseer_clear_args(&["overseer", "clear", "boss", "--project=/repo"])
        .expect("overseer clear");
    assert_eq!(clear.session_id, "boss");
    assert_eq!(clear.project.as_deref(), Some("/repo"));

    assert!(parse_core_overseer_start_args(&["overseer", "start", "--tool"]).is_none());
    assert!(parse_core_overseer_clear_args(&["overseer", "clear"]).is_none());
}

#[test]
fn team_parser_matches_show_init_role_mutation_forms() {
    let show = parse_core_team_args(&["team", "show", "--project=/repo"]).expect("team show");
    assert_eq!(show.subcommand, "show");
    assert_eq!(show.project.as_deref(), Some("/repo"));

    let init = parse_core_team_args(&["team", "init", "--json"]).expect("team init");
    assert_eq!(init.subcommand, "init");
    assert!(init.json);

    let add = parse_core_team_args(&[
        "team",
        "add",
        "planner",
        "-d",
        "Plans work",
        "--reviewed-by",
        "reviewer",
        "--can-edit",
    ])
    .expect("team add");
    assert_eq!(add.role.as_deref(), Some("planner"));
    assert_eq!(add.description.as_deref(), Some("Plans work"));
    assert_eq!(add.reviewed_by.as_deref(), Some("reviewer"));
    assert!(add.can_edit);

    let remove =
        parse_core_team_args(&["team", "remove", "--json", "planner"]).expect("team remove");
    assert_eq!(remove.role.as_deref(), Some("planner"));
    assert!(remove.json);

    assert!(parse_core_team_args(&["team", "add"]).is_none());
    assert!(parse_core_team_args(&["team", "show", "planner"]).is_none());
    assert!(parse_core_team_args(&["team", "default", "--project"]).is_none());
}

#[test]
fn notification_parser_matches_cli_alias_forms() {
    assert_eq!(
        parse_core_notification_args(&[
            "notify",
            "--project=/repo",
            "--title",
            "Heads up",
            "--subtitle=Agent",
            "--body",
            "Ready",
            "--session",
            "claude-1",
            "--kind=attention",
            "--json",
        ]),
        Some(CoreNotificationArgs {
            command: "notify".into(),
            project: Some("/repo".into()),
            title: Some("Heads up".into()),
            subtitle: Some("Agent".into()),
            body: Some("Ready".into()),
            session_id: Some("claude-1".into()),
            kind: Some("attention".into()),
            id: None,
            ids: Vec::new(),
            unread: false,
            json: true,
        })
    );

    let list = parse_core_notification_args(&[
        "list-notifications",
        "--project",
        "/repo",
        "--unread",
        "--session=claude-1",
    ])
    .expect("list notification args");
    assert_eq!(list.command, "list-notifications");
    assert!(list.unread);
    assert_eq!(list.session_id.as_deref(), Some("claude-1"));

    let mutation = parse_core_notification_args(&[
        "read-notifications",
        "--id=note-1",
        "--ids",
        " note-2, ,note-3 ",
        "--json",
    ])
    .expect("read notification args");
    assert_eq!(mutation.id.as_deref(), Some("note-1"));
    assert_eq!(mutation.ids, ["note-2", "note-3"]);
    assert!(mutation.json);

    assert!(parse_core_notification_args(&["notify", "--body", "Ready"]).is_none());
    assert!(parse_core_notification_args(&["list-notifications", "--title", "x"]).is_none());
    assert!(parse_core_notification_args(&["clear-notifications", "--project", "-repo"]).is_none());
}

#[test]
fn logs_parser_preserves_values_that_start_with_hyphens() {
    assert_eq!(
        parse_core_logs_args(&["logs", "tail", "--project", "-foo", "-n", "-5", "--daemon",]),
        Some(CoreLogsArgs {
            daemon: true,
            lines: Some("-5".into()),
            project: Some("-foo".into()),
            subcommand: CoreLogsSubcommand::Tail,
        })
    );
    assert_eq!(
        parse_core_logs_args(&["logs", "path", "--lines", "5"]),
        None
    );
    assert_eq!(parse_core_logs_args(&["logs", "tail", "--lines="]), None);
}

#[test]
fn host_restart_parser_accepts_only_open_and_serve() {
    assert_eq!(
        parse_core_host_restart_args(&["host", "restart", "--serve", "--open", "--serve"]),
        Some(CoreHostRestartArgs {
            open: true,
            serve: true,
        })
    );
    assert_eq!(
        parse_core_host_restart_args(&["host", "restart", "--json"]),
        None
    );
}

#[test]
fn host_agent_read_parser_matches_commander_flag_math() {
    assert_eq!(
        parse_core_host_agent_read_args(&["host", "agent-read", "claude-1"]),
        Some(CoreHostAgentReadArgs {
            session_id: "claude-1".into(),
            project: None,
            start_line: -120,
        })
    );
    assert_eq!(
        parse_core_host_agent_read_args(&[
            "host",
            "agent-read",
            "--project=/repo space",
            "--start-line",
            "-80",
            "claude-1",
        ]),
        Some(CoreHostAgentReadArgs {
            session_id: "claude-1".into(),
            project: Some("/repo space".into()),
            start_line: -80,
        })
    );
    assert_eq!(
        parse_core_host_agent_read_args(&[
            "host",
            "agent-read",
            "claude-1",
            "--project",
            "/repo",
            "--lines=160",
        ]),
        Some(CoreHostAgentReadArgs {
            session_id: "claude-1".into(),
            project: Some("/repo".into()),
            start_line: -160,
        })
    );
    assert_eq!(
        parse_core_host_agent_read_args(&[
            "host",
            "agent-read",
            "claude-1",
            "--lines",
            "not-an-int",
            "--start-line",
            "-42",
        ]),
        Some(CoreHostAgentReadArgs {
            session_id: "claude-1".into(),
            project: None,
            start_line: -42,
        })
    );
    assert_eq!(
        parse_core_host_agent_read_args(&["host", "agent-read", "claude-1", "--lines", "0"]),
        None
    );
    assert_eq!(
        parse_core_host_agent_read_args(
            &["host", "agent-read", "claude-1", "--start-line", "1.5",]
        ),
        None
    );
}

#[test]
fn host_agent_stream_parser_matches_commander_flag_math() {
    assert_eq!(
        parse_core_host_agent_stream_args(&["host", "agent-stream", "claude-1"]),
        Some(CoreHostAgentStreamArgs {
            session_id: "claude-1".into(),
            project: None,
            start_line: -2000,
            interval_ms: 500,
        })
    );
    assert_eq!(
        parse_core_host_agent_stream_args(&[
            "host",
            "agent-stream",
            "--project=/repo",
            "--start-line",
            "-80",
            "--interval-ms=250",
            "claude-1",
        ]),
        Some(CoreHostAgentStreamArgs {
            session_id: "claude-1".into(),
            project: Some("/repo".into()),
            start_line: -80,
            interval_ms: 250,
        })
    );
    assert_eq!(
        parse_core_host_agent_stream_args(&[
            "host",
            "agent-stream",
            "claude-1",
            "--lines",
            "160",
            "--interval-ms",
            "100",
        ]),
        Some(CoreHostAgentStreamArgs {
            session_id: "claude-1".into(),
            project: None,
            start_line: -160,
            interval_ms: 100,
        })
    );
    assert_eq!(
        parse_core_host_agent_stream_args(&["host", "agent-stream", "claude-1", "--lines", "0"]),
        None
    );
    assert_eq!(
        parse_core_host_agent_stream_args(&[
            "host",
            "agent-stream",
            "claude-1",
            "--interval-ms",
            "99",
        ]),
        None
    );
    assert_eq!(
        parse_core_host_agent_stream_args(&[
            "host",
            "agent-stream",
            "claude-1",
            "--interval-ms",
            "fast",
        ]),
        None
    );
}

#[test]
fn dashboard_and_runtime_restart_parsers_match_shell_shim_forms() {
    let reload = parse_core_dashboard_reload_args(&[
        "dashboard-reload",
        "--open",
        "--client-tty=/dev/ttys001",
        "--current-client-session",
        "aimux-repo-client-abc12345",
    ])
    .expect("reload args");
    assert!(reload.open);
    assert_eq!(reload.client_tty.as_deref(), Some("/dev/ttys001"));
    assert_eq!(
        reload.current_client_session.as_deref(),
        Some("aimux-repo-client-abc12345")
    );

    let restart = parse_core_runtime_restart_args(&[
        "restart-runtime",
        "--project-root",
        "/repo",
        "--json",
        "--client-tty=/dev/ttys001",
    ])
    .expect("runtime restart args");
    assert_eq!(restart.project_root.as_deref(), Some("/repo"));
    assert!(restart.json);
    assert_eq!(restart.client_tty.as_deref(), Some("/dev/ttys001"));

    assert!(parse_core_dashboard_reload_args(&["dashboard-reload", "--json"]).is_none());
    assert!(parse_core_dashboard_reload_args(&["dashboard-reload", "--client-tty=-x"]).is_none());
    assert!(parse_core_runtime_restart_args(&["restart-runtime", "--project-root=-x"]).is_none());
}

#[test]
fn core_cli_eligibility_matches_the_typescript_dispatch_boundary() {
    let accepted = [
        vec!["restart"],
        vec!["restart", "--project=/repo", "--json"],
        vec!["dashboard-reload"],
        vec!["dashboard-reload", "--open", "--client-tty", "/dev/ttys001"],
        vec![
            "dashboard-reload",
            "--open",
            "--current-client-session=aimux-repo-client-1234abcd",
        ],
        vec!["restart-runtime"],
        vec!["restart-runtime", "--project-root=/repo", "--json"],
        vec!["restart-runtime", "--open", "--client-tty", "/dev/ttys001"],
        // Core claims malformed dashboard/runtime commands to reject them before fallback.
        vec!["restart-runtime", "--open", "--json"],
        vec!["dashboard-reload", "--json"],
        vec!["dashboard-reload", "--client-tty=-x"],
        vec!["restart-runtime", "--project-root=-x"],
        vec!["serve"],
        vec!["host", "status", "--json"],
        vec!["host", "stop"],
        vec!["host", "kill"],
        vec!["host", "restart", "--serve", "--open"],
        vec!["daemon", "ensure", "--json"],
        vec!["daemon", "status"],
        vec!["daemon", "projects"],
        vec!["daemon", "restart", "--json"],
        vec!["doctor", "versions"],
        vec!["doctor", "versions", "--json"],
        vec!["logs", "path", "--daemon"],
        vec!["notify", "--title", "Heads up"],
        vec!["notify", "--body", "Ready"],
        vec!["list-notifications", "--unread"],
        vec!["read-notifications", "--ids", "note-1,note-2"],
        vec!["clear-notifications", "--bad"],
        vec!["projects", "list", "--json"],
        vec!["remote", "status", "--json"],
        vec!["remote", "enable"],
        vec!["remote", "disable"],
        vec!["whoami", "--json"],
        vec!["logout"],
        vec!["login"],
        vec!["security", "unlock"],
        // Core intentionally claims malformed project-ensure to reject it safely.
        vec!["daemon", "project-ensure", "--dry-run"],
    ];
    for args in accepted {
        assert!(is_core_cli_command(&args), "rejected {args:?}");
    }

    let rejected = [
        vec!["serve", "--json"],
        vec!["host", "stop", "--open"],
        vec!["daemon", "restart", "--project", "/repo"],
        vec!["daemon", "status", "extra"],
        vec!["doctor", "versions", "extra"],
        vec!["projects", "list", "extra", "--json"],
        vec!["remote", "enable", "--json"],
        vec!["remote", "disable", "extra"],
        vec!["remote", "enable", "--help"],
        vec!["daemon", "project-ensure", "-h"],
        vec!["remote", "unlock"],
        vec![],
    ];
    for args in rejected {
        assert!(!is_core_cli_command(&args), "accepted {args:?}");
    }
}
