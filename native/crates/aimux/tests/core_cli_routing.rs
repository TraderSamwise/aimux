use aimux::core_cli_routing::{
    CoreAgentPsArgs, CoreDaemonRestartArgs, CoreHostAgentReadArgs, CoreHostAgentStreamArgs,
    CoreHostRestartArgs, CoreLogsArgs, CoreLogsSubcommand, CoreProjectEnsureArgs, CoreRestartArgs,
    core_command_args, has_core_global_logging_args, is_core_cli_command,
    is_core_project_ensure_command, is_valid_core_project_ensure_args, parse_core_agent_ps_args,
    parse_core_daemon_restart_args, parse_core_dashboard_reload_args,
    parse_core_host_agent_read_args, parse_core_host_agent_stream_args,
    parse_core_host_restart_args, parse_core_logs_args, parse_core_project_ensure_args,
    parse_core_restart_args, parse_core_runtime_restart_args,
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
