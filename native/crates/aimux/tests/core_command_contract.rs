use aimux::core_command_contract::{CORE_API_ROUTES, CORE_COMMAND_NAMES, is_core_command_name};

#[test]
fn core_api_routes_match_the_typescript_contract() {
    let expected = [
        ("commands", "/core/commands"),
        ("daemonEnsureText", "/core/daemon-ensure-text"),
        ("daemonProjectsText", "/core/daemon-projects-text"),
        ("daemonStatusText", "/core/daemon-status-text"),
        ("doctorTmuxText", "/core/doctor/tmux-text"),
        ("doctorVersionsText", "/core/doctor/versions-text"),
        ("doctorDiskText", "/core/doctor/disk-text"),
        ("dashboardReloadText", "/core/dashboard-reload-text"),
        ("exposeFocus", "/core/expose/focus"),
        ("exposeItems", "/core/expose/items"),
        ("hostAgentReadText", "/core/host-agent-read-text"),
        ("hostAgentStreamText", "/core/host-agent-stream-text"),
        ("hostStatusText", "/core/host-status-text"),
        ("agentInputText", "/core/agents/input-text"),
        ("agentMigrateText", "/core/agents/migrate-text"),
        ("agentPsText", "/core/agents/ps-text"),
        ("agentRenameText", "/core/agents/rename-text"),
        ("lifecycleForkText", "/core/lifecycle/fork-text"),
        ("lifecycleKillText", "/core/lifecycle/kill-text"),
        ("lifecycleSpawnText", "/core/lifecycle/spawn-text"),
        ("lifecycleStopText", "/core/lifecycle/stop-text"),
        ("loopAddText", "/core/loop/add-text"),
        ("loopBlockText", "/core/loop/block-text"),
        ("loopDoneText", "/core/loop/done-text"),
        ("loopRemoveText", "/core/loop/remove-text"),
        ("handoffAcceptText", "/core/handoff/accept-text"),
        ("handoffCompleteText", "/core/handoff/complete-text"),
        ("handoffSendText", "/core/handoff/send-text"),
        ("messageSendText", "/core/message/send-text"),
        ("notificationClearText", "/core/notifications/clear-text"),
        ("notificationListText", "/core/notifications/list-text"),
        ("notificationReadText", "/core/notifications/read-text"),
        ("notificationSendText", "/core/notifications/send-text"),
        ("overseerClearText", "/core/overseer/clear-text"),
        ("overseerStartText", "/core/overseer/start-text"),
        ("teamAddText", "/core/team/add-text"),
        ("teamDefaultText", "/core/team/default-text"),
        ("teamInitText", "/core/team/init-text"),
        ("teamRemoveText", "/core/team/remove-text"),
        ("teamShowText", "/core/team/show-text"),
        ("loginStartText", "/core/login-start-text"),
        ("loginText", "/core/login-text"),
        ("loginWaitText", "/core/login-wait-text"),
        ("logsClearText", "/core/logs/clear-text"),
        ("logsPathText", "/core/logs/path-text"),
        ("logsTailText", "/core/logs/tail-text"),
        ("metadataText", "/core/metadata-text"),
        ("logoutText", "/core/logout-text"),
        ("projectEnsureText", "/core/project-ensure-text"),
        ("projectKillText", "/core/project-kill-text"),
        ("projectRestartText", "/core/project-restart-text"),
        ("projectServeText", "/core/project-serve-text"),
        ("projectStopText", "/core/project-stop-text"),
        ("projectsListText", "/core/projects-list-text"),
        ("remoteDisableText", "/core/remote-disable-text"),
        ("remoteEnableText", "/core/remote-enable-text"),
        ("remoteStatusText", "/core/remote-status-text"),
        ("repairExchangeText", "/core/repair-exchange-text"),
        ("repairText", "/core/repair-text"),
        ("restartText", "/core/restart-text"),
        ("runtimeRestartText", "/core/runtime-restart-text"),
        (
            "securityUnlockStartText",
            "/core/security-unlock-start-text",
        ),
        ("securityUnlockText", "/core/security-unlock-text"),
        ("securityUnlockWaitText", "/core/security-unlock-wait-text"),
        ("reviewApproveText", "/core/review/approve-text"),
        (
            "reviewRequestChangesText",
            "/core/review/request-changes-text",
        ),
        ("taskAcceptText", "/core/task/accept-text"),
        ("taskAssignText", "/core/task/assign-text"),
        ("taskBlockText", "/core/task/block-text"),
        ("taskCompleteText", "/core/task/complete-text"),
        ("taskListText", "/core/task/list-text"),
        ("taskReopenText", "/core/task/reopen-text"),
        ("taskShowText", "/core/task/show-text"),
        ("whoamiText", "/core/whoami-text"),
        ("graveyardCleanupText", "/core/graveyard/cleanup-text"),
        ("graveyardListText", "/core/graveyard/list-text"),
        ("graveyardResurrectText", "/core/graveyard/resurrect-text"),
        ("graveyardSendText", "/core/graveyard/send-text"),
        ("threadListText", "/core/thread/list-text"),
        ("threadMarkSeenText", "/core/thread/mark-seen-text"),
        ("threadOpenText", "/core/thread/open-text"),
        ("threadSendText", "/core/thread/send-text"),
        ("threadShowText", "/core/thread/show-text"),
        ("threadStatusText", "/core/thread/status-text"),
        ("threadsListText", "/core/threads/list-text"),
        ("worktreeCreateText", "/core/worktree/create-text"),
        (
            "worktreeCacheCleanupText",
            "/core/worktree/cache-cleanup-text",
        ),
        (
            "worktreeDeleteGraveyardText",
            "/core/worktree/delete-graveyard-text",
        ),
        ("worktreeGraveyardText", "/core/worktree/graveyard-text"),
        ("worktreeListText", "/core/worktree/list-text"),
        ("worktreeRemoveText", "/core/worktree/remove-text"),
        ("worktreeResurrectText", "/core/worktree/resurrect-text"),
    ];

    assert_eq!(CORE_API_ROUTES.entries(), expected);
}

#[test]
fn core_api_routes_match_shared_contract_fixture() {
    let fixture = include_str!("../../../../testdata/contracts/v1/core-command/routes.json");
    let value: serde_json::Value = serde_json::from_str(fixture).expect("valid route fixture");
    let expected: Vec<(&str, &str)> = value["routes"]
        .as_array()
        .expect("routes array")
        .iter()
        .map(|entry| {
            let entry = entry.as_array().expect("route tuple");
            (
                entry[0].as_str().expect("route key"),
                entry[1].as_str().expect("route value"),
            )
        })
        .collect();

    assert_eq!(CORE_API_ROUTES.entries().to_vec(), expected);
}

#[test]
fn core_command_names_match_the_typescript_contract() {
    let expected = [
        ("ping", "core.ping"),
        ("status", "core.status"),
        ("projectsList", "core.projects.list"),
        ("projectEnsure", "core.project.ensure"),
        ("projectStop", "core.project.stop"),
        ("projectKill", "core.project.kill"),
        ("projectRestart", "core.project.restart"),
        ("overseerWatch", "core.overseer.watch"),
        ("restart", "core.restart"),
        ("relayStatus", "core.relay.status"),
        ("relayEnable", "core.relay.enable"),
        ("relayDisable", "core.relay.disable"),
    ];

    assert_eq!(CORE_COMMAND_NAMES.entries(), expected);
}

#[test]
fn core_command_names_match_shared_contract_fixture() {
    let fixture = include_str!("../../../../testdata/contracts/v1/core-command/commands.json");
    let value: serde_json::Value = serde_json::from_str(fixture).expect("valid command fixture");
    let expected: Vec<(&str, &str)> = value["commands"]
        .as_array()
        .expect("commands array")
        .iter()
        .map(|entry| {
            let entry = entry.as_array().expect("command tuple");
            (
                entry[0].as_str().expect("command key"),
                entry[1].as_str().expect("command value"),
            )
        })
        .collect();

    assert_eq!(CORE_COMMAND_NAMES.entries().to_vec(), expected);
}

#[test]
fn core_command_name_guard_accepts_only_exact_values() {
    for (_, command) in CORE_COMMAND_NAMES.entries() {
        assert!(is_core_command_name(command), "rejected {command}");
    }

    for command in [
        "",
        "core",
        "core.ping ",
        "CORE.PING",
        "core.projects",
        "core.relay.start",
        "/core/commands",
    ] {
        assert!(!is_core_command_name(command), "accepted {command}");
    }
}

#[test]
fn constant_objects_serialize_with_typescript_keys() {
    let routes = serde_json::to_value(CORE_API_ROUTES).expect("routes serialize");
    let commands = serde_json::to_value(CORE_COMMAND_NAMES).expect("commands serialize");

    assert_eq!(routes["doctorTmuxText"], "/core/doctor/tmux-text");
    assert_eq!(
        routes["worktreeResurrectText"],
        "/core/worktree/resurrect-text"
    );
    assert_eq!(commands["projectsList"], "core.projects.list");
    assert_eq!(commands["relayDisable"], "core.relay.disable");
}
