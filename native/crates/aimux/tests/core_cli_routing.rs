use aimux::core_cli_routing::{
    CoreDaemonRestartArgs, CoreHostRestartArgs, CoreLogsArgs, CoreLogsSubcommand,
    CoreProjectEnsureArgs, CoreRestartArgs, core_command_args, has_core_global_logging_args,
    is_core_cli_command, is_core_project_ensure_command, is_valid_core_project_ensure_args,
    parse_core_daemon_restart_args, parse_core_host_restart_args, parse_core_logs_args,
    parse_core_project_ensure_args, parse_core_restart_args,
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
fn core_cli_eligibility_matches_the_typescript_dispatch_boundary() {
    let accepted = [
        vec!["restart"],
        vec!["restart", "--project=/repo", "--json"],
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
        vec!["restart-runtime"],
        vec!["dashboard-reload"],
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
