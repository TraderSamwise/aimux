use serde::Serialize;

macro_rules! define_string_contract {
    (
        $type_name:ident,
        $constant_name:ident,
        $entry_count:expr,
        { $( $field:ident => ($typescript_key:literal, $value:literal) ),+ $(,)? }
    ) => {
        #[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
        #[serde(rename_all = "camelCase")]
        pub struct $type_name {
            $(pub $field: &'static str),+
        }

        pub const $constant_name: $type_name = $type_name {
            $($field: $value),+
        };

        impl $type_name {
            pub fn entries(&self) -> [(&'static str, &'static str); $entry_count] {
                [$(($typescript_key, self.$field)),+]
            }
        }
    };
}

define_string_contract!(
    CoreApiRoutes,
    CORE_API_ROUTES,
    97,
    {
        commands => ("commands", "/core/commands"),
        daemon_ensure_text => ("daemonEnsureText", "/core/daemon-ensure-text"),
        daemon_projects_text => ("daemonProjectsText", "/core/daemon-projects-text"),
        daemon_status_text => ("daemonStatusText", "/core/daemon-status-text"),
        doctor_exchange_text => ("doctorExchangeText", "/core/doctor/exchange-text"),
        doctor_lifecycle_text => ("doctorLifecycleText", "/core/doctor/lifecycle-text"),
        doctor_tmux_text => ("doctorTmuxText", "/core/doctor/tmux-text"),
        doctor_versions_text => ("doctorVersionsText", "/core/doctor/versions-text"),
        doctor_disk_text => ("doctorDiskText", "/core/doctor/disk-text"),
        dashboard_reload_text => ("dashboardReloadText", "/core/dashboard-reload-text"),
        expose_focus => ("exposeFocus", "/core/expose/focus"),
        expose_items => ("exposeItems", "/core/expose/items"),
        host_agent_read_text => ("hostAgentReadText", "/core/host-agent-read-text"),
        host_agent_stream_text => ("hostAgentStreamText", "/core/host-agent-stream-text"),
        host_status_text => ("hostStatusText", "/core/host-status-text"),
        agent_input_text => ("agentInputText", "/core/agents/input-text"),
        agent_migrate_text => ("agentMigrateText", "/core/agents/migrate-text"),
        agent_ps_text => ("agentPsText", "/core/agents/ps-text"),
        agent_rename_text => ("agentRenameText", "/core/agents/rename-text"),
        attachment_publish_text => ("attachmentPublishText", "/core/attachment/publish-text"),
        lifecycle_fork_text => ("lifecycleForkText", "/core/lifecycle/fork-text"),
        lifecycle_kill_text => ("lifecycleKillText", "/core/lifecycle/kill-text"),
        lifecycle_spawn_text => ("lifecycleSpawnText", "/core/lifecycle/spawn-text"),
        lifecycle_stop_text => ("lifecycleStopText", "/core/lifecycle/stop-text"),
        loop_add_text => ("loopAddText", "/core/loop/add-text"),
        loop_block_text => ("loopBlockText", "/core/loop/block-text"),
        loop_done_text => ("loopDoneText", "/core/loop/done-text"),
        loop_remove_text => ("loopRemoveText", "/core/loop/remove-text"),
        handoff_accept_text => ("handoffAcceptText", "/core/handoff/accept-text"),
        handoff_complete_text => ("handoffCompleteText", "/core/handoff/complete-text"),
        handoff_send_text => ("handoffSendText", "/core/handoff/send-text"),
        message_send_text => ("messageSendText", "/core/message/send-text"),
        notification_clear_text => ("notificationClearText", "/core/notifications/clear-text"),
        notification_list_text => ("notificationListText", "/core/notifications/list-text"),
        notification_read_text => ("notificationReadText", "/core/notifications/read-text"),
        notification_send_text => ("notificationSendText", "/core/notifications/send-text"),
        outline_list_text => ("outlineListText", "/core/outline/list-text"),
        outline_update_text => ("outlineUpdateText", "/core/outline/update-text"),
        overseer_clear_text => ("overseerClearText", "/core/overseer/clear-text"),
        overseer_start_text => ("overseerStartText", "/core/overseer/start-text"),
        team_add_text => ("teamAddText", "/core/team/add-text"),
        team_default_text => ("teamDefaultText", "/core/team/default-text"),
        team_init_text => ("teamInitText", "/core/team/init-text"),
        team_remove_text => ("teamRemoveText", "/core/team/remove-text"),
        team_show_text => ("teamShowText", "/core/team/show-text"),
        login_start_text => ("loginStartText", "/core/login-start-text"),
        login_text => ("loginText", "/core/login-text"),
        login_wait_text => ("loginWaitText", "/core/login-wait-text"),
        logs_clear_text => ("logsClearText", "/core/logs/clear-text"),
        logs_path_text => ("logsPathText", "/core/logs/path-text"),
        logs_tail_text => ("logsTailText", "/core/logs/tail-text"),
        metadata_text => ("metadataText", "/core/metadata-text"),
        logout_text => ("logoutText", "/core/logout-text"),
        project_ensure_text => ("projectEnsureText", "/core/project-ensure-text"),
        project_kill_text => ("projectKillText", "/core/project-kill-text"),
        project_restart_text => ("projectRestartText", "/core/project-restart-text"),
        project_serve_text => ("projectServeText", "/core/project-serve-text"),
        project_stop_text => ("projectStopText", "/core/project-stop-text"),
        projects_list_text => ("projectsListText", "/core/projects-list-text"),
        remote_disable_text => ("remoteDisableText", "/core/remote-disable-text"),
        remote_enable_text => ("remoteEnableText", "/core/remote-enable-text"),
        remote_status_text => ("remoteStatusText", "/core/remote-status-text"),
        repair_exchange_text => ("repairExchangeText", "/core/repair-exchange-text"),
        repair_text => ("repairText", "/core/repair-text"),
        restart_text => ("restartText", "/core/restart-text"),
        runtime_restart_text => ("runtimeRestartText", "/core/runtime-restart-text"),
        security_unlock_start_text => ("securityUnlockStartText", "/core/security-unlock-start-text"),
        security_unlock_text => ("securityUnlockText", "/core/security-unlock-text"),
        security_unlock_wait_text => ("securityUnlockWaitText", "/core/security-unlock-wait-text"),
        review_approve_text => ("reviewApproveText", "/core/review/approve-text"),
        review_request_changes_text => ("reviewRequestChangesText", "/core/review/request-changes-text"),
        task_accept_text => ("taskAcceptText", "/core/task/accept-text"),
        task_assign_text => ("taskAssignText", "/core/task/assign-text"),
        task_block_text => ("taskBlockText", "/core/task/block-text"),
        task_complete_text => ("taskCompleteText", "/core/task/complete-text"),
        task_list_text => ("taskListText", "/core/task/list-text"),
        task_reopen_text => ("taskReopenText", "/core/task/reopen-text"),
        task_show_text => ("taskShowText", "/core/task/show-text"),
        whoami_text => ("whoamiText", "/core/whoami-text"),
        graveyard_cleanup_text => ("graveyardCleanupText", "/core/graveyard/cleanup-text"),
        graveyard_list_text => ("graveyardListText", "/core/graveyard/list-text"),
        graveyard_resurrect_text => ("graveyardResurrectText", "/core/graveyard/resurrect-text"),
        graveyard_send_text => ("graveyardSendText", "/core/graveyard/send-text"),
        thread_list_text => ("threadListText", "/core/thread/list-text"),
        thread_mark_seen_text => ("threadMarkSeenText", "/core/thread/mark-seen-text"),
        thread_open_text => ("threadOpenText", "/core/thread/open-text"),
        thread_send_text => ("threadSendText", "/core/thread/send-text"),
        thread_show_text => ("threadShowText", "/core/thread/show-text"),
        thread_status_text => ("threadStatusText", "/core/thread/status-text"),
        threads_list_text => ("threadsListText", "/core/threads/list-text"),
        worktree_create_text => ("worktreeCreateText", "/core/worktree/create-text"),
        worktree_cache_cleanup_text => ("worktreeCacheCleanupText", "/core/worktree/cache-cleanup-text"),
        worktree_delete_graveyard_text => ("worktreeDeleteGraveyardText", "/core/worktree/delete-graveyard-text"),
        worktree_graveyard_text => ("worktreeGraveyardText", "/core/worktree/graveyard-text"),
        worktree_list_text => ("worktreeListText", "/core/worktree/list-text"),
        worktree_remove_text => ("worktreeRemoveText", "/core/worktree/remove-text"),
        worktree_resurrect_text => ("worktreeResurrectText", "/core/worktree/resurrect-text"),
    }
);

define_string_contract!(
    CoreCommandNames,
    CORE_COMMAND_NAMES,
    12,
    {
        ping => ("ping", "core.ping"),
        status => ("status", "core.status"),
        projects_list => ("projectsList", "core.projects.list"),
        project_ensure => ("projectEnsure", "core.project.ensure"),
        project_stop => ("projectStop", "core.project.stop"),
        project_kill => ("projectKill", "core.project.kill"),
        project_restart => ("projectRestart", "core.project.restart"),
        overseer_watch => ("overseerWatch", "core.overseer.watch"),
        restart => ("restart", "core.restart"),
        relay_status => ("relayStatus", "core.relay.status"),
        relay_enable => ("relayEnable", "core.relay.enable"),
        relay_disable => ("relayDisable", "core.relay.disable"),
    }
);

pub fn is_core_command_name(value: &str) -> bool {
    CORE_COMMAND_NAMES
        .entries()
        .iter()
        .any(|(_, command)| *command == value)
}
