use aimux::core_cli_routing::{
    CoreAgentIdentityArgs, CoreAgentInputArgs, CoreAgentListArgs, CoreAgentPsArgs,
    CoreCollaborationArgs, CoreDaemonRestartArgs, CoreDoctorArgs, CoreGraveyardArgs,
    CoreHostAgentReadArgs, CoreHostAgentStreamArgs, CoreHostRestartArgs, CoreLogsArgs,
    CoreLogsSubcommand, CoreMetadataArgs, CoreNotificationArgs, CoreProjectEnsureArgs,
    CoreRepairArgs, CoreRestartArgs, CoreTaskArgs, CoreThreadArgs, CoreWorktreeArgs,
    core_command_args, has_core_global_logging_args, is_core_cli_command,
    is_core_project_ensure_command, is_valid_core_project_ensure_args,
    parse_core_agent_identity_args, parse_core_agent_input_args, parse_core_agent_list_args,
    parse_core_agent_migrate_args, parse_core_agent_ps_args, parse_core_agent_rename_args,
    parse_core_attachment_publish_args, parse_core_collaboration_args,
    parse_core_daemon_restart_args, parse_core_dashboard_reload_args, parse_core_doctor_args,
    parse_core_graveyard_args, parse_core_host_agent_read_args, parse_core_host_agent_stream_args,
    parse_core_host_restart_args, parse_core_host_topology_args, parse_core_lifecycle_fork_args,
    parse_core_lifecycle_spawn_args, parse_core_lifecycle_status_args, parse_core_logs_args,
    parse_core_loop_exit_args, parse_core_loop_mutation_args, parse_core_metadata_args,
    parse_core_notification_args, parse_core_outline_args, parse_core_overseer_clear_args,
    parse_core_overseer_start_args, parse_core_project_ensure_args, parse_core_project_stop_args,
    parse_core_repair_args, parse_core_restart_args, parse_core_runtime_restart_args,
    parse_core_scribe_clear_args, parse_core_scribe_start_args, parse_core_service_create_args,
    parse_core_task_args, parse_core_team_args, parse_core_thread_args, parse_core_worktree_args,
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
            "--force",
        ]),
        Some(CoreRestartArgs {
            json: true,
            force: true,
            project: Some("/repo".into()),
        })
    );
    assert_eq!(
        parse_core_daemon_restart_args(&["daemon", "restart", "--json", "--force"]),
        Some(CoreDaemonRestartArgs {
            json: true,
            force: true
        })
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
fn host_topology_parser_matches_local_read_forms() {
    let path = parse_core_host_topology_args(&["host", "topology"]).expect("path form");
    assert!(!path.json);
    assert!(!path.raw);

    let raw = parse_core_host_topology_args(&["host", "topology", "--raw"]).expect("raw form");
    assert!(raw.raw);
    assert!(!raw.json);

    let json = parse_core_host_topology_args(&["host", "topology", "--json"]).expect("json form");
    assert!(json.json);
    assert!(!json.raw);

    assert!(parse_core_host_topology_args(&["host", "topology", "--project=/repo"]).is_none());
    assert!(parse_core_host_topology_args(&["host", "topology", "--help"]).is_none());
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
fn agent_list_parser_matches_project_json_forms() {
    assert_eq!(
        parse_core_agent_list_args(&["list"]),
        Some(CoreAgentListArgs {
            project: None,
            json: false,
        })
    );
    assert_eq!(
        parse_core_agent_list_args(&["list", "--project=/repo", "--json"]),
        Some(CoreAgentListArgs {
            project: Some("/repo".into()),
            json: true,
        })
    );
    assert_eq!(
        parse_core_agent_list_args(&["list", "--project", "./child", "--project", "/repo"]),
        Some(CoreAgentListArgs {
            project: Some("/repo".into()),
            json: false,
        })
    );
    assert_eq!(parse_core_agent_list_args(&["list", "--project"]), None);
    assert_eq!(
        parse_core_agent_list_args(&["list", "--project=-repo"]),
        None
    );
    assert_eq!(parse_core_agent_list_args(&["list", "extra"]), None);
}

#[test]
fn agent_identity_parser_matches_project_json_forms() {
    assert_eq!(
        parse_core_agent_identity_args(&["id", "codex-1"]),
        Some(CoreAgentIdentityArgs {
            session_id: "codex-1".into(),
            project: None,
            json: false,
        })
    );
    assert_eq!(
        parse_core_agent_identity_args(&["id", "codex-1", "--project=/repo", "--json"]),
        Some(CoreAgentIdentityArgs {
            session_id: "codex-1".into(),
            project: Some("/repo".into()),
            json: true,
        })
    );
    assert_eq!(parse_core_agent_identity_args(&["id"]), None);
    assert_eq!(parse_core_agent_identity_args(&["id", "--json"]), None);
    assert_eq!(
        parse_core_agent_identity_args(&["id", "codex-1", "extra"]),
        None
    );
}

#[test]
fn agent_input_parser_preserves_variadic_text_and_project_option() {
    assert_eq!(
        parse_core_agent_input_args(&["input", "claude-1", "hello", "there", "--project", "/repo"]),
        Some(CoreAgentInputArgs {
            session_id: "claude-1".into(),
            text: "hello there".into(),
            project: Some("/repo".into()),
            force: false,
        })
    );
    assert_eq!(
        parse_core_agent_input_args(&["input", "claude-1", "--force", "--", "--flag"]),
        Some(CoreAgentInputArgs {
            session_id: "claude-1".into(),
            text: "--flag".into(),
            project: None,
            force: true,
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
fn metadata_and_repair_parsers_match_commander_compatible_forms() {
    assert_eq!(
        parse_core_metadata_args(&[
            "metadata",
            "set-status",
            "claude-1",
            "--tone",
            "warn",
            "--",
            "-waiting",
        ]),
        Some(CoreMetadataArgs {
            args: vec![
                "metadata".into(),
                "set-status".into(),
                "claude-1".into(),
                "--tone".into(),
                "warn".into(),
                "--".into(),
                "-waiting".into(),
            ],
        })
    );
    assert_eq!(
        parse_core_metadata_args(&["metadata", "set-status", "--help"]),
        None
    );
    assert_eq!(parse_core_metadata_args(&["metadata", "unknown"]), None);

    assert_eq!(
        parse_core_repair_args(&["repair", "--project-root=./child", "--open", "--json"]),
        Some(CoreRepairArgs {
            subcommand: "tmux".into(),
            project: None,
            project_root: Some("./child".into()),
            open: true,
            json: true,
        })
    );
    assert_eq!(
        parse_core_repair_args(&["repair", "exchange", "--project", "./child", "--json"]),
        Some(CoreRepairArgs {
            subcommand: "exchange".into(),
            project: Some("./child".into()),
            project_root: None,
            open: false,
            json: true,
        })
    );
    assert_eq!(
        parse_core_repair_args(&["repair", "exchange", "--open"]),
        None
    );
    assert_eq!(parse_core_repair_args(&["repair", "--project-root"]), None);
}

#[test]
fn doctor_disk_and_tmux_parsers_match_cli_forms() {
    assert_eq!(
        parse_core_doctor_args(&[
            "doctor",
            "disk",
            "--project=./child",
            "--include-active",
            "--json",
        ]),
        Some(CoreDoctorArgs {
            subcommand: "disk".into(),
            project: Some("./child".into()),
            project_root: None,
            session: None,
            window_id: None,
            include_active: true,
            fix: false,
            retention_days: None,
            keep_recent: None,
            json: true,
        })
    );
    assert_eq!(
        parse_core_doctor_args(&["doctor", "exchange", "--project", "./child", "--json",]),
        Some(CoreDoctorArgs {
            subcommand: "exchange".into(),
            project: Some("./child".into()),
            project_root: None,
            session: None,
            window_id: None,
            include_active: false,
            fix: false,
            retention_days: None,
            keep_recent: None,
            json: true,
        })
    );
    assert_eq!(
        parse_core_doctor_args(&["doctor", "lifecycle", "--project=./child", "--json",]),
        Some(CoreDoctorArgs {
            subcommand: "lifecycle".into(),
            project: Some("./child".into()),
            project_root: None,
            session: None,
            window_id: None,
            include_active: false,
            fix: false,
            retention_days: None,
            keep_recent: None,
            json: true,
        })
    );
    assert_eq!(
        parse_core_doctor_args(&[
            "doctor",
            "tmux",
            "--project-root",
            "./child",
            "--session",
            "aimux-repo",
            "--window-id=@1",
            "--json",
        ]),
        Some(CoreDoctorArgs {
            subcommand: "tmux".into(),
            project: None,
            project_root: Some("./child".into()),
            session: Some("aimux-repo".into()),
            window_id: Some("@1".into()),
            include_active: false,
            fix: false,
            retention_days: None,
            keep_recent: None,
            json: true,
        })
    );
    assert_eq!(
        parse_core_doctor_args(&["doctor", "disk", "--session", "x"]),
        None
    );
    assert_eq!(
        parse_core_doctor_args(&["doctor", "exchange", "--include-active"]),
        None
    );
    assert_eq!(
        parse_core_doctor_args(&["doctor", "tmux", "--project-root", "-repo"]),
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
    assert_eq!(fork.tool.as_deref(), Some("codex"));
    assert_eq!(fork.instruction.as_deref(), Some("continue"));
    assert_eq!(fork.worktree.as_deref(), Some("../other"));
    assert!(fork.open);

    assert!(parse_core_lifecycle_fork_args(&["fork", "claude-1"]).is_none());

    assert!(parse_core_lifecycle_spawn_args(&["spawn", "--tool"]).is_none());
    assert!(parse_core_lifecycle_spawn_args(&["spawn", "claude"]).is_none());
    assert!(parse_core_lifecycle_fork_args(&["fork"]).is_none());
    assert!(parse_core_lifecycle_status_args(&["stop"], "stop").is_none());
    let project_stop = parse_core_project_stop_args(&["stop", "--json"]).expect("project stop");
    assert!(project_stop.json);
    assert!(is_core_cli_command(&["stop"]));
    assert!(is_core_cli_command(&["stop", "claude-1"]));
    assert!(is_core_cli_command(&["stop", "--bad"]));
}

#[test]
fn service_create_parser_matches_top_level_shell_dispatch_forms() {
    let interactive =
        parse_core_service_create_args(&["service", "create"]).expect("interactive service create");
    assert_eq!(interactive.command, "");
    assert_eq!(interactive.project, None);
    assert_eq!(interactive.worktree, None);
    assert!(!interactive.json);

    let command = parse_core_service_create_args(&[
        "service",
        "create",
        "--project",
        "/repo",
        "--worktree=feature",
        "--json",
        "--",
        "yarn",
        "dev",
    ])
    .expect("service create command");
    assert_eq!(command.command, "yarn dev");
    assert_eq!(command.project.as_deref(), Some("/repo"));
    assert_eq!(command.worktree.as_deref(), Some("feature"));
    assert!(command.json);

    assert!(parse_core_service_create_args(&["service"]).is_none());
    assert!(parse_core_service_create_args(&["service", "create", "--worktree"]).is_none());
    assert!(parse_core_service_create_args(&["service", "create", "--bad"]).is_none());
}

#[test]
fn root_dispatch_delimiter_and_tool_forms_match_native_contract() {
    use aimux::config::default_config;
    use aimux::native_cli_dispatch::{
        is_known_aimux_command_word, native_tool_launch_args_for_config,
        normalize_root_dispatch_args,
    };

    let config = default_config();
    let root_delimited = normalize_root_dispatch_args(&["--".to_owned(), "codex".to_owned()]);
    assert_eq!(root_delimited, ["codex"]);
    assert_eq!(
        native_tool_launch_args_for_config(&root_delimited, &config),
        Some(vec![
            "spawn".to_owned(),
            "--tool".to_owned(),
            "codex".to_owned()
        ])
    );
    assert_eq!(
        native_tool_launch_args_for_config(
            &["claude".to_owned(), "--model".to_owned(), "opus".to_owned()],
            &config
        ),
        Some(vec![
            "spawn".to_owned(),
            "--tool".to_owned(),
            "claude".to_owned(),
            "--".to_owned(),
            "--model".to_owned(),
            "opus".to_owned()
        ])
    );
    assert_eq!(
        native_tool_launch_args_for_config(&["shell".to_owned()], &config),
        Some(vec!["service".to_owned(), "create".to_owned()])
    );
    assert_eq!(
        native_tool_launch_args_for_config(&["projects".to_owned()], &config),
        None
    );
    for command in ["list", "id", "compact", "clear-notifications"] {
        assert!(is_known_aimux_command_word(command), "{command}");
        assert_eq!(
            native_tool_launch_args_for_config(&[command.to_owned()], &config),
            None,
            "{command} must remain a command word, not a guessed tool"
        );
    }
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
fn scribe_parsers_match_start_and_clear_forms() {
    let start = parse_core_scribe_start_args(&[
        "scribe",
        "start",
        "--tool",
        "claude",
        "--worktree=feature",
        "--no-open",
        "--json",
    ])
    .expect("scribe start");
    assert_eq!(start.tool.as_deref(), Some("claude"));
    assert_eq!(start.worktree.as_deref(), Some("feature"));
    assert!(!start.open);
    assert!(start.json);

    let default_tool =
        parse_core_scribe_start_args(&["scribe", "start"]).expect("scribe start default tool");
    assert_eq!(default_tool.tool, None);

    let clear = parse_core_scribe_clear_args(&["scribe", "clear", "scribe-1", "--project=/repo"])
        .expect("scribe clear");
    assert_eq!(clear.session_id, "scribe-1");
    assert_eq!(clear.project.as_deref(), Some("/repo"));

    assert!(parse_core_scribe_start_args(&["scribe", "start", "--tool"]).is_none());
    assert!(parse_core_scribe_clear_args(&["scribe", "clear"]).is_none());
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
fn outline_and_attachment_parsers_match_cli_forms() {
    let list = parse_core_outline_args(&[
        "outline",
        "list",
        "--project=/repo",
        "--session",
        "codex-1",
        "--worktree=feature",
        "--status=active",
        "--search",
        "parser",
        "--limit=5",
        "--json",
    ])
    .expect("outline list args");
    assert_eq!(list.subcommand, "list");
    assert_eq!(list.project.as_deref(), Some("/repo"));
    assert_eq!(list.session.as_deref(), Some("codex-1"));
    assert_eq!(list.worktree.as_deref(), Some("feature"));
    assert_eq!(list.status.as_deref(), Some("active"));
    assert_eq!(list.search.as_deref(), Some("parser"));
    assert_eq!(list.limit.as_deref(), Some("5"));
    assert!(list.json);

    let show = parse_core_outline_args(&["outline", "show", "outline-1", "--project", "/repo"])
        .expect("outline show args");
    assert_eq!(show.entry_id.as_deref(), Some("outline-1"));
    assert_eq!(show.project.as_deref(), Some("/repo"));

    let update = parse_core_outline_args(&[
        "outline",
        "update",
        "--title=Parser",
        "--summary",
        "Port it",
        "--topic-key=parser",
        "--session=codex-1",
        "--worktree=feature",
        "--source=scribe",
    ])
    .expect("outline update args");
    assert_eq!(update.title.as_deref(), Some("Parser"));
    assert_eq!(update.summary.as_deref(), Some("Port it"));
    assert_eq!(update.topic_key.as_deref(), Some("parser"));
    assert_eq!(update.source.as_deref(), Some("scribe"));

    let attachment = parse_core_attachment_publish_args(&[
        "attachment",
        "publish",
        "notes.txt",
        "--session=codex-1",
        "--project=/repo",
        "--name",
        "Notes.md",
        "--mime=text/markdown",
        "--json",
    ])
    .expect("attachment publish args");
    assert_eq!(attachment.path, "notes.txt");
    assert_eq!(attachment.session, "codex-1");
    assert_eq!(attachment.project.as_deref(), Some("/repo"));
    assert_eq!(attachment.name.as_deref(), Some("Notes.md"));
    assert_eq!(attachment.mime.as_deref(), Some("text/markdown"));
    assert!(attachment.json);

    assert!(parse_core_outline_args(&["outline", "show"]).is_none());
    assert!(parse_core_outline_args(&["outline", "update", "--title", "x"]).is_none());
    assert!(parse_core_attachment_publish_args(&["attachment", "publish", "notes.txt"]).is_none());
    assert!(
        parse_core_attachment_publish_args(&[
            "attachment",
            "publish",
            "notes.txt",
            "--session",
            "-bad"
        ])
        .is_none()
    );
}

#[test]
fn collaboration_parser_matches_message_and_handoff_forms() {
    assert_eq!(
        parse_core_collaboration_args(&[
            "message",
            "send",
            "please",
            "--to",
            "claude-1,codex-1",
            "--assignee=coder",
            "--tool=claude",
            "--worktree=feature",
            "--project=/repo",
            "--from=user",
            "--title=Ask",
            "--kind=decision",
            "--thread=thread-1",
        ]),
        Some(CoreCollaborationArgs {
            command: "message".into(),
            subcommand: "send".into(),
            body: Some("please".into()),
            thread_id: Some("thread-1".into()),
            project: Some("/repo".into()),
            from: Some("user".into()),
            to: Some("claude-1,codex-1".into()),
            assignee: Some("coder".into()),
            tool: Some("claude".into()),
            worktree: Some("feature".into()),
            title: Some("Ask".into()),
            kind: Some("decision".into()),
            json: false,
        })
    );

    let handoff =
        parse_core_collaboration_args(&["handoff", "send", "take over", "--to=claude-1", "--json"])
            .expect("handoff send args");
    assert_eq!(handoff.command, "handoff");
    assert_eq!(handoff.body.as_deref(), Some("take over"));
    assert_eq!(handoff.to.as_deref(), Some("claude-1"));
    assert!(handoff.json);

    let accept = parse_core_collaboration_args(&[
        "handoff",
        "accept",
        "thread-1",
        "--from=claude-1",
        "--body=ok",
    ])
    .expect("handoff accept args");
    assert_eq!(accept.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(accept.from.as_deref(), Some("claude-1"));
    assert_eq!(accept.body.as_deref(), Some("ok"));

    assert!(parse_core_collaboration_args(&["message", "send", "please"]).is_none());
    assert!(parse_core_collaboration_args(&["handoff", "send", "please"]).is_none());
    assert!(parse_core_collaboration_args(&["handoff", "accept", "thread-1", "--body"]).is_none());
    assert!(
        parse_core_collaboration_args(&["message", "send", "please", "--from", "--body"]).is_none()
    );
}

#[test]
fn task_parser_matches_workflow_forms() {
    let list = parse_core_task_args(&[
        "task",
        "list",
        "--session",
        "claude-1",
        "--status=todo",
        "--json",
    ])
    .expect("task list args");
    assert_eq!(list.subcommand, "list");
    assert_eq!(list.session.as_deref(), Some("claude-1"));
    assert_eq!(list.status.as_deref(), Some("todo"));
    assert!(list.json);

    let assign = parse_core_task_args(&[
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
        "--project=/repo",
        "--json",
    ]);
    assert_eq!(
        assign,
        Some(CoreTaskArgs {
            command: "task".into(),
            subcommand: "assign".into(),
            task_id: None,
            description: Some("Ship it".into()),
            project: Some("/repo".into()),
            session: None,
            status: None,
            from: Some("user".into()),
            to: Some("claude-1".into()),
            assignee: Some("coder".into()),
            tool: Some("claude".into()),
            prompt: Some("Implement".into()),
            task_type: Some("review".into()),
            diff: Some("--- before\n+++ after".into()),
            worktree: Some("feature".into()),
            body: None,
            result: None,
            json: true,
        })
    );

    let complete = parse_core_task_args(&[
        "task",
        "complete",
        "task-1",
        "--from=claude-1",
        "--result=shipped",
    ])
    .expect("task complete args");
    assert_eq!(complete.task_id.as_deref(), Some("task-1"));
    assert_eq!(complete.result.as_deref(), Some("shipped"));

    let cancel = parse_core_task_args(&[
        "task",
        "cancel",
        "task-1",
        "--from=claude-1",
        "--body=obsolete",
    ])
    .expect("task cancel args");
    assert_eq!(cancel.task_id.as_deref(), Some("task-1"));
    assert_eq!(cancel.from.as_deref(), Some("claude-1"));
    assert_eq!(cancel.body.as_deref(), Some("obsolete"));

    let review = parse_core_task_args(&[
        "review",
        "request-changes",
        "task-1",
        "--from=reviewer",
        "--body",
        "fix",
    ])
    .expect("review args");
    assert_eq!(review.command, "review");
    assert_eq!(review.body.as_deref(), Some("fix"));

    assert!(parse_core_task_args(&["task", "assign", "--to", "codex-1"]).is_none());
    assert!(parse_core_task_args(&["task", "assign", "Ship it", "--to="]).is_none());
    assert!(parse_core_task_args(&["task", "block", "task-1", "--result=blocked"]).is_none());
    assert!(
        parse_core_task_args(&["review", "approve", "task-1", "--from", "--body=ok"]).is_none()
    );
}

#[test]
fn thread_parser_matches_orchestration_forms() {
    let list = parse_core_thread_args(&[
        "thread",
        "list",
        "--session",
        "claude-1",
        "--project=/repo",
        "--json",
    ])
    .expect("thread list args");
    assert_eq!(list.subcommand, "list");
    assert_eq!(list.session.as_deref(), Some("claude-1"));
    assert_eq!(list.project.as_deref(), Some("/repo"));
    assert!(list.json);

    let open = parse_core_thread_args(&[
        "thread",
        "open",
        "--title=Plan",
        "--from",
        "user",
        "--participants",
        "claude-1,codex-1",
        "--kind=handoff",
    ]);
    assert_eq!(
        open,
        Some(CoreThreadArgs {
            subcommand: "open".into(),
            thread_id: None,
            body: None,
            project: None,
            session: None,
            title: Some("Plan".into()),
            from: Some("user".into()),
            participants: Some("claude-1,codex-1".into()),
            kind: Some("handoff".into()),
            to: None,
            status: None,
            owner: None,
            waiting_on: None,
            json: false,
        })
    );

    let send = parse_core_thread_args(&[
        "thread",
        "send",
        "thread-1",
        "body",
        "--from=user",
        "--to=claude-1",
        "--kind=reply",
    ])
    .expect("thread send args");
    assert_eq!(send.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(send.body.as_deref(), Some("body"));
    assert_eq!(send.kind.as_deref(), Some("reply"));

    let status = parse_core_thread_args(&[
        "thread",
        "status",
        "thread-1",
        "--status=waiting",
        "--owner=user",
        "--waiting-on=claude-1,codex-1",
    ])
    .expect("thread status args");
    assert_eq!(status.status.as_deref(), Some("waiting"));
    assert_eq!(status.waiting_on.as_deref(), Some("claude-1,codex-1"));

    assert!(parse_core_thread_args(&["thread", "show"]).is_none());
    assert!(parse_core_thread_args(&["thread", "open", "--title", "Plan"]).is_none());
    assert!(parse_core_thread_args(&["thread", "send", "thread-1", "--from=user"]).is_none());
    assert!(parse_core_thread_args(&["thread", "mark-seen", "thread-1"]).is_none());
    assert!(parse_core_thread_args(&["thread", "status", "thread-1"]).is_none());
}

#[test]
fn worktree_and_graveyard_parsers_match_cli_forms() {
    let cleanup = parse_core_worktree_args(&[
        "worktree",
        "cleanup-caches",
        "--project=/repo",
        "--yes",
        "--include-active",
        "--json",
    ])
    .expect("worktree cleanup args");
    assert_eq!(
        cleanup,
        CoreWorktreeArgs {
            subcommand: "cleanup-caches".into(),
            project: Some("/repo".into()),
            name: None,
            path: None,
            yes: true,
            include_active: true,
            json: true,
        }
    );

    let create =
        parse_core_worktree_args(&["worktree", "create", "feature"]).expect("worktree create args");
    assert_eq!(create.name.as_deref(), Some("feature"));

    let remove = parse_core_worktree_args(&[
        "worktree",
        "remove",
        "../feature",
        "--project",
        "/repo",
        "--json",
    ])
    .expect("worktree remove args");
    assert_eq!(remove.path.as_deref(), Some("../feature"));
    assert_eq!(remove.project.as_deref(), Some("/repo"));
    assert!(remove.json);

    let graveyard =
        parse_core_graveyard_args(&["graveyard", "send", "claude-1", "--project=/repo", "--json"])
            .expect("graveyard send args");
    assert_eq!(
        graveyard,
        CoreGraveyardArgs {
            subcommand: "send".into(),
            project: Some("/repo".into()),
            session_id: Some("claude-1".into()),
            dry_run: false,
            json: true,
        }
    );
    let cleanup_graveyard = parse_core_graveyard_args(&["graveyard", "cleanup", "--dry-run"])
        .expect("graveyard cleanup args");
    assert!(cleanup_graveyard.dry_run);

    assert!(parse_core_worktree_args(&["worktree", "create"]).is_none());
    assert!(parse_core_worktree_args(&["worktree", "remove", "--project", "/repo"]).is_none());
    assert!(
        parse_core_worktree_args(&["worktree", "cleanup-caches", "--include-active=1"]).is_none()
    );
    assert!(parse_core_graveyard_args(&["graveyard", "send"]).is_none());
    assert!(parse_core_graveyard_args(&["graveyard", "cleanup", "--yes"]).is_none());
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

    assert!(parse_core_dashboard_reload_args(&["dashboard-reload", "--json"]).is_some());
    assert!(parse_core_dashboard_reload_args(&["dashboard-reload", "--client-tty=-x"]).is_none());
    assert!(parse_core_runtime_restart_args(&["restart-runtime", "--project-root=-x"]).is_none());
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
        vec!["service", "create"],
        vec!["service", "create", "--", "yarn", "dev"],
        vec!["debug-state", "codex-a1"],
        vec!["doctor", "versions"],
        vec!["doctor", "versions", "--json"],
        vec!["doctor", "exchange", "--project=/repo", "--json"],
        vec!["doctor", "lifecycle"],
        vec!["doctor", "lifecycle", "--project", "/repo"],
        vec!["logs", "path", "--daemon"],
        vec!["list", "--json"],
        vec!["id", "codex-1", "--project=/repo", "--json"],
        vec!["compact"],
        vec!["notify", "--title", "Heads up"],
        vec!["notify", "--body", "Ready"],
        vec!["list-notifications", "--unread"],
        vec!["read-notifications", "--ids", "note-1,note-2"],
        vec!["clear-notifications", "--bad"],
        vec!["message", "send", "please", "--to", "claude-1"],
        vec!["message", "send", "please"],
        vec!["handoff", "send", "please", "--to=claude-1"],
        vec!["handoff", "send", "please"],
        vec!["handoff", "accept", "thread-1", "--body"],
        vec!["handoff", "complete", "thread-1"],
        vec!["task", "list", "--session", "claude-1"],
        vec!["task", "assign", "Ship it", "--to="],
        vec!["task", "block", "task-1", "--result=blocked"],
        vec!["review", "approve", "task-1", "--from", "--body=ok"],
        vec!["review", "request-changes", "task-1", "--body", "-h"],
        vec!["thread", "list", "--json"],
        vec!["thread", "show", "thread-1"],
        vec!["thread", "send", "thread-1", "body", "--from", "user"],
        vec!["thread", "mark-seen", "thread-1", "--session"],
        vec!["thread", "status", "thread-1", "--status=waiting"],
        vec!["threads", "--json"],
        vec!["worktree", "list"],
        vec!["worktree", "create", "feature"],
        vec!["worktree", "remove", "../feature"],
        vec!["worktree", "cleanup-caches", "--include-active=1"],
        vec!["graveyard", "list"],
        vec!["graveyard", "send", "claude-1"],
        vec!["graveyard", "cleanup", "--dry-run"],
        vec!["projects"],
        vec!["projects", "list", "--json"],
        vec!["remote", "status", "--json"],
        vec!["remote", "enable"],
        vec!["remote", "disable"],
        vec!["whoami", "--json"],
        vec!["logout"],
        vec!["login"],
        vec!["security", "unlock"],
        vec!["security", "devices"],
        vec!["security", "devices", "--json"],
        vec!["security", "device", "approve"],
        vec!["security", "device", "approve", "dev-1", "--json"],
        vec!["security", "approve", "dev-1", "--code", "123456"],
        vec!["security", "block", "dev-1", "--json"],
        vec!["security", "revoke", "dev-1"],
        vec!["security", "unblock", "dev-1"],
        // Core intentionally claims malformed project-ensure to reject it safely.
        vec!["daemon", "project-ensure", "--dry-run"],
    ];
    for args in accepted {
        assert!(is_core_cli_command(&args), "rejected {args:?}");
    }

    let rejected = [
        vec!["serve", "--json"],
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
        vec!["restart-runtime", "--open", "--json"],
        vec!["dashboard-reload", "--json"],
        vec!["dashboard-reload", "--client-tty=-x"],
        vec!["restart-runtime", "--project-root=-x"],
        vec!["host", "stop", "--open"],
        vec!["service"],
        vec!["service", "create", "--worktree"],
        vec!["daemon", "restart", "--project", "/repo"],
        vec!["daemon", "status", "extra"],
        vec!["debug-state"],
        vec!["debug-state", "--help"],
        vec!["debug-state", "codex-a1", "extra"],
        vec!["doctor", "versions", "extra"],
        vec!["doctor", "exchange", "--project"],
        vec!["doctor", "lifecycle", "--include-active"],
        vec!["projects", "list", "extra", "--json"],
        vec!["remote", "enable", "--json"],
        vec!["remote", "disable", "extra"],
        vec!["remote", "enable", "--help"],
        vec!["message", "send", "--help"],
        vec!["handoff", "send", "--help"],
        vec!["handoff", "accept"],
        vec!["task", "assign", "--to", "codex-1"],
        vec!["task", "assign", "--help"],
        vec!["review", "approve"],
        vec!["thread", "show"],
        vec!["thread", "send", "thread-1", "--from", "user"],
        vec!["threads", "thread-1"],
        vec!["list", "extra"],
        vec!["id"],
        vec!["id", "--json"],
        vec!["id", "codex-1", "extra"],
        vec!["compact", "--json"],
        vec!["worktree", "create"],
        vec!["worktree", "create", "--help"],
        vec!["graveyard", "send"],
        vec!["graveyard", "send", "--help"],
        vec!["daemon", "project-ensure", "-h"],
        vec!["remote", "unlock"],
        vec!["security", "devices", "extra"],
        vec!["security", "device"],
        vec!["security", "device", "approve", "--bad"],
        vec!["security", "approve"],
        vec!["security", "approve", "dev-1", "--code"],
        vec!["security", "block", "dev-1", "--code=123456"],
        vec![],
    ];
    for args in rejected {
        assert!(!is_core_cli_command(&args), "accepted {args:?}");
    }
}
