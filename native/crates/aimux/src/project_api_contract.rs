pub mod routes {
    pub const EVENTS: &str = "/events";
    pub const HEALTH: &str = "/health";
    pub const DIAGNOSTICS: &str = "/diagnostics";
    pub const DIAGNOSTICS_LIFECYCLE: &str = "/diagnostics/lifecycle";
    pub const STATE: &str = "/state";
    pub const DESKTOP_STATE: &str = "/desktop-state";
    pub const COORDINATION_WORKLIST: &str = "/coordination-worklist";
    pub const PROJECT_OBSERVABILITY: &str = "/project-observability";
    pub const TOPOLOGY: &str = "/topology";
    pub const LIBRARY: &str = "/library";
    pub const WORKTREES: &str = "/worktrees";
    pub const GRAVEYARD: &str = "/graveyard";
    pub const PLANS: &str = "/plans";
    pub const STATUSLINE_REFRESH: &str = "/statusline/refresh";
    pub const STATUSLINE_SEGMENT: &str = "/statusline/segment";
    pub const OPERATION_FAILURES_CLEAR: &str = "/operation-failures/clear";
    pub const ATTACHMENTS: &str = "/attachments";
    pub const ATTACHMENTS_PUBLISH: &str = "/attachments/publish";

    pub mod work_outline {
        pub const LIST: &str = "/work-outline";
        pub const UPDATE: &str = "/work-outline/update";
    }

    pub mod team {
        pub const CONFIG: &str = "/team/config";
        pub const INIT: &str = "/team/init";
        pub const ADD_ROLE: &str = "/team/roles/add";
        pub const REMOVE_ROLE: &str = "/team/roles/remove";
        pub const DEFAULT_ROLE: &str = "/team/default-role";
    }

    pub mod notifications {
        pub const LIST: &str = "/notifications";
        pub const READ: &str = "/notifications/read";
        pub const CLEAR: &str = "/notifications/clear";
    }

    pub mod hooks {
        pub const CLAUDE: &str = "/hooks/claude";
        pub const CODEX: &str = "/hooks/codex";
    }

    pub mod agents {
        pub const LIST: &str = "/agents";
        pub const OUTPUT: &str = "/agents/output";
        pub const OUTPUT_STREAM: &str = "/agents/output/stream";
        pub const HISTORY: &str = "/agents/history";
        pub const INPUT: &str = "/agents/input";
        pub const PROMPT_CONTEXT: &str = "/agents/prompt-context";
        pub const SPAWN: &str = "/agents/spawn";
        pub const FORK: &str = "/agents/fork";
        pub const SWITCH_TOOL: &str = "/agents/switch-tool";
        pub const STOP: &str = "/agents/stop";
        pub const RESUME: &str = "/agents/resume";
        pub const RESTORE_PREVIOUS: &str = "/agents/restore-previous";
        pub const DISMISS_RESTORE_PREVIOUS: &str = "/agents/restore-previous/dismiss";
        pub const KILL: &str = "/agents/kill";
        pub const INTERRUPT: &str = "/agents/interrupt";
        pub const RENAME: &str = "/agents/rename";
        pub const MIGRATE: &str = "/agents/migrate";
        pub const RECORD_BACKEND_SESSION: &str = "/agents/record-backend-session";
        pub const LOOP: &str = "/agents/loop";
        pub const OVERSEER: &str = "/agents/overseer";
        pub const SCRIBE: &str = "/agents/scribe";
        pub const TEAMMATES: &str = "/agents/teammates";
        pub const CREATE_TEAMMATE: &str = "/agents/teammates/create";
        pub const CREATE_TEAMMATE_TASK: &str = "/agents/teammates/tasks";
        pub const RAW_TEAMMATE_SEND: &str = "/agents/teammates/send";
        pub const STOP_TEAMMATE: &str = "/agents/teammates/stop";
        pub const RESUME_TEAMMATE: &str = "/agents/teammates/resume";
        pub const KILL_TEAMMATE: &str = "/agents/teammates/kill";
        pub const RESURRECT_TEAMMATE: &str = "/agents/teammates/resurrect";
        pub const INTERACTION_REGISTER: &str = "/agents/interaction/register";
        pub const INTERACTION_NOTIFY: &str = "/agents/interaction/notify";
        pub const INTERACTION_REQUEST: &str = "/agents/interaction/request";
        pub const INTERACTION_WAIT: &str = "/agents/interaction/wait";
        pub const INTERACTION_RESPOND: &str = "/agents/interaction/respond";
        pub const INTERACTION_PENDING: &str = "/agents/interaction/pending";
        pub const INTERACTION_STREAM: &str = "/agents/interaction/stream";
    }

    pub mod live_pane {
        pub const ATTACH: &str = "/live-pane/attach";
        pub const OUTPUT: &str = "/live-pane/output";
        pub const INPUT: &str = "/live-pane/input";
        pub const INTERRUPT: &str = "/live-pane/interrupt";
        pub const RESIZE: &str = "/live-pane/resize";
    }

    pub mod services {
        pub const CREATE: &str = "/services/create";
        pub const STOP: &str = "/services/stop";
        pub const RESUME: &str = "/services/resume";
        pub const REMOVE: &str = "/services/remove";
    }

    pub mod worktree_actions {
        pub const CREATE: &str = "/worktrees/create";
        pub const CACHE_CLEANUP: &str = "/worktrees/cache-cleanup";
        pub const REMOVE: &str = "/worktrees/remove";
        pub const GRAVEYARD: &str = "/worktrees/graveyard";
    }

    pub mod graveyard_actions {
        pub const RESURRECT_AGENT: &str = "/graveyard/resurrect";
        pub const RESURRECT_WORKTREE: &str = "/graveyard/worktrees/resurrect";
        pub const DELETE_WORKTREE: &str = "/graveyard/worktrees/delete";
        pub const CLEANUP: &str = "/graveyard/cleanup";
    }

    pub mod threads {
        pub const LIST: &str = "/threads";
        pub const OPEN: &str = "/threads/open";
        pub const SEND: &str = "/threads/send";
        pub const MARK_SEEN: &str = "/threads/mark-seen";
        pub const STATUS: &str = "/threads/status";
    }

    pub mod tasks {
        pub const LIST: &str = "/tasks";
        pub const ASSIGN: &str = "/tasks/assign";
        pub const ACCEPT: &str = "/tasks/accept";
        pub const BLOCK: &str = "/tasks/block";
        pub const CANCEL: &str = "/tasks/cancel";
        pub const COMPLETE: &str = "/tasks/complete";
        pub const REOPEN: &str = "/tasks/reopen";
    }

    pub mod handoff {
        pub const SEND: &str = "/handoff";
        pub const ACCEPT: &str = "/handoff/accept";
        pub const COMPLETE: &str = "/handoff/complete";
    }

    pub mod reviews {
        pub const APPROVE: &str = "/reviews/approve";
        pub const REQUEST_CHANGES: &str = "/reviews/request-changes";
    }

    pub mod orchestration {
        pub const ROUTES: &str = "/orchestration/routes";
    }

    pub mod controls {
        pub const SWITCHABLE_AGENTS: &str = "/control/switchable-agents";
        pub const OPEN_DASHBOARD: &str = "/control/open-dashboard";
        pub const OPEN_NOTIFICATION_TARGET: &str = "/control/open-notification-target";
        pub const FOCUS_WINDOW: &str = "/control/focus-window";
        pub const ACTIVE_WINDOW: &str = "/control/active-window";
        pub const SWITCH_NEXT: &str = "/control/switch-next";
        pub const SWITCH_PREV: &str = "/control/switch-prev";
        pub const SWITCH_ATTENTION: &str = "/control/switch-attention";
    }

    pub mod runtime {
        pub const USAGE_MARK: &str = "/usage/mark";
        pub const SET_STATUS: &str = "/set-status";
        pub const SET_PROGRESS: &str = "/set-progress";
        pub const SET_CONTEXT: &str = "/set-context";
        pub const SET_SERVICES: &str = "/set-services";
        pub const LOG: &str = "/log";
        pub const EVENT: &str = "/event";
        pub const MARK_SEEN: &str = "/mark-seen";
        pub const SET_ACTIVITY: &str = "/set-activity";
        pub const SET_ATTENTION: &str = "/set-attention";
        pub const CLEAR_LOG: &str = "/clear-log";
        pub const NOTIFY: &str = "/notify";
        pub const NOTIFICATION_CONTEXT: &str = "/notification-context";
        pub const SHELL_STATE: &str = "/shell-state";
        pub const COMPACT_EXCHANGE: &str = "/runtime/exchange/compact";
    }
}

pub mod event_names {
    pub const READY: &str = "ready";
    pub const ALERT: &str = "alert";
    pub const AGENT_OUTPUT: &str = "agent_output";
    pub const PROJECT_UPDATE: &str = "project_update";
    pub const ERROR: &str = "error";
}

pub const PROJECT_API_VIEWS: &[&str] = &[
    "agents",
    "coordination-worklist",
    "desktop-state",
    "graveyard",
    "library",
    "notifications",
    "plans",
    "project-observability",
    "services",
    "team",
    "tasks",
    "threads",
    "topology",
    "work-outline",
    "worktrees",
];

pub mod invalidations {
    use super::PROJECT_API_VIEWS;

    pub const ALL: &[&str] = PROJECT_API_VIEWS;
    pub const AGENT_LIFECYCLE: &[&str] = &[
        "agents",
        "coordination-worklist",
        "desktop-state",
        "graveyard",
        "project-observability",
        "team",
        "topology",
        "worktrees",
    ];
    pub const SERVICE_LIFECYCLE: &[&str] = &[
        "desktop-state",
        "project-observability",
        "services",
        "topology",
        "worktrees",
    ];
    pub const WORKTREE_LIFECYCLE: &[&str] = &[
        "agents",
        "desktop-state",
        "graveyard",
        "library",
        "project-observability",
        "topology",
        "worktrees",
    ];
    pub const WORKFLOW: &[&str] = &[
        "coordination-worklist",
        "project-observability",
        "tasks",
        "threads",
    ];
    pub const NOTIFICATIONS: &[&str] = &[
        "coordination-worklist",
        "notifications",
        "project-observability",
    ];
    pub const TEAM: &[&str] = &[
        "coordination-worklist",
        "project-observability",
        "tasks",
        "team",
        "threads",
    ];
    pub const LIBRARY: &[&str] = &["library"];
    pub const PLANS: &[&str] = &["plans"];
    pub const WORK_OUTLINE: &[&str] = &["work-outline"];
    pub const RUNTIME: &[&str] = &[
        "agents",
        "coordination-worklist",
        "desktop-state",
        "project-observability",
        "topology",
        "worktrees",
    ];
    pub const RUNTIME_SESSION: &[&str] = &["agents", "desktop-state", "project-observability"];
    pub const OPERATION_FAILURES: &[&str] = &["desktop-state", "project-observability"];
    pub const REPAIR: &[&str] = PROJECT_API_VIEWS;
}

pub fn project_api_mutation_reason_for_route(method: &str, pathname: &str) -> String {
    let method = method.to_uppercase();
    format!(
        "{} {}",
        if method.is_empty() {
            "REQUEST".to_string()
        } else {
            method
        },
        if pathname.is_empty() { "/" } else { pathname }
    )
}

pub fn project_api_views_for_mutation_route(
    method: &str,
    pathname: &str,
) -> Option<Vec<&'static str>> {
    use routes::*;
    let normalized_method = method.to_uppercase();
    if normalized_method == "GET"
        && [
            controls::OPEN_NOTIFICATION_TARGET,
            controls::FOCUS_WINDOW,
            controls::ACTIVE_WINDOW,
            controls::SWITCH_NEXT,
            controls::SWITCH_PREV,
            controls::SWITCH_ATTENTION,
        ]
        .contains(&pathname)
    {
        return Some(invalidations::RUNTIME.to_vec());
    }
    if normalized_method != "POST" && normalized_method != "PUT" {
        return None;
    }
    if normalized_method == "PUT" && pathname.starts_with(&format!("{PLANS}/")) {
        return Some(invalidations::PLANS.to_vec());
    }

    let views = match pathname {
        notifications::READ | notifications::CLEAR | runtime::NOTIFY => {
            invalidations::NOTIFICATIONS
        }

        team::INIT | team::ADD_ROLE | team::REMOVE_ROLE | team::DEFAULT_ROLE => invalidations::TEAM,

        threads::OPEN
        | threads::SEND
        | threads::MARK_SEEN
        | threads::STATUS
        | handoff::SEND
        | handoff::ACCEPT
        | handoff::COMPLETE
        | tasks::ASSIGN
        | tasks::ACCEPT
        | tasks::BLOCK
        | tasks::CANCEL
        | tasks::COMPLETE
        | tasks::REOPEN
        | reviews::APPROVE
        | reviews::REQUEST_CHANGES
        | agents::CREATE_TEAMMATE_TASK => invalidations::WORKFLOW,

        work_outline::UPDATE => invalidations::WORK_OUTLINE,

        agents::SPAWN
        | agents::FORK
        | agents::STOP
        | agents::RESUME
        | agents::KILL
        | agents::INTERRUPT
        | agents::RENAME
        | agents::MIGRATE
        | agents::RECORD_BACKEND_SESSION
        | agents::LOOP
        | agents::OVERSEER
        | agents::SCRIBE
        | live_pane::INTERRUPT
        | agents::CREATE_TEAMMATE
        | agents::STOP_TEAMMATE
        | agents::RESUME_TEAMMATE
        | agents::KILL_TEAMMATE
        | agents::RESURRECT_TEAMMATE
        | graveyard_actions::RESURRECT_AGENT => invalidations::AGENT_LIFECYCLE,

        services::CREATE | services::STOP | services::RESUME | services::REMOVE => {
            invalidations::SERVICE_LIFECYCLE
        }

        worktree_actions::CREATE
        | worktree_actions::CACHE_CLEANUP
        | worktree_actions::REMOVE
        | worktree_actions::GRAVEYARD
        | graveyard_actions::RESURRECT_WORKTREE
        | graveyard_actions::DELETE_WORKTREE
        | graveyard_actions::CLEANUP => invalidations::WORKTREE_LIFECYCLE,

        runtime::USAGE_MARK
        | runtime::SET_STATUS
        | runtime::SET_PROGRESS
        | runtime::SET_CONTEXT
        | runtime::SET_SERVICES
        | runtime::LOG
        | runtime::EVENT
        | runtime::MARK_SEEN
        | runtime::SET_ACTIVITY
        | runtime::SET_ATTENTION
        | runtime::CLEAR_LOG
        | runtime::SHELL_STATE
        | runtime::COMPACT_EXCHANGE
        | agents::INTERACTION_REGISTER
        | agents::INTERACTION_NOTIFY
        | agents::INTERACTION_REQUEST
        | agents::INTERACTION_RESPOND
        | agents::INPUT
        | agents::PROMPT_CONTEXT
        | live_pane::INPUT => invalidations::RUNTIME,

        STATUSLINE_REFRESH | STATUSLINE_SEGMENT => invalidations::RUNTIME,

        OPERATION_FAILURES_CLEAR => invalidations::OPERATION_FAILURES,

        _ => invalidations::ALL,
    };
    Some(views.to_vec())
}

pub fn collect_project_api_routes() -> Vec<&'static str> {
    use routes::*;
    vec![
        EVENTS,
        HEALTH,
        DIAGNOSTICS,
        DIAGNOSTICS_LIFECYCLE,
        STATE,
        DESKTOP_STATE,
        COORDINATION_WORKLIST,
        PROJECT_OBSERVABILITY,
        TOPOLOGY,
        LIBRARY,
        work_outline::LIST,
        work_outline::UPDATE,
        WORKTREES,
        GRAVEYARD,
        team::CONFIG,
        team::INIT,
        team::ADD_ROLE,
        team::REMOVE_ROLE,
        team::DEFAULT_ROLE,
        PLANS,
        STATUSLINE_REFRESH,
        STATUSLINE_SEGMENT,
        OPERATION_FAILURES_CLEAR,
        notifications::LIST,
        notifications::READ,
        notifications::CLEAR,
        hooks::CLAUDE,
        hooks::CODEX,
        agents::LIST,
        agents::OUTPUT,
        agents::OUTPUT_STREAM,
        agents::HISTORY,
        agents::INPUT,
        agents::PROMPT_CONTEXT,
        agents::SPAWN,
        agents::FORK,
        agents::SWITCH_TOOL,
        agents::STOP,
        agents::RESUME,
        agents::RESTORE_PREVIOUS,
        agents::DISMISS_RESTORE_PREVIOUS,
        agents::KILL,
        agents::INTERRUPT,
        agents::RENAME,
        agents::MIGRATE,
        agents::RECORD_BACKEND_SESSION,
        agents::LOOP,
        agents::OVERSEER,
        agents::SCRIBE,
        agents::TEAMMATES,
        agents::CREATE_TEAMMATE,
        agents::CREATE_TEAMMATE_TASK,
        agents::RAW_TEAMMATE_SEND,
        agents::STOP_TEAMMATE,
        agents::RESUME_TEAMMATE,
        agents::KILL_TEAMMATE,
        agents::RESURRECT_TEAMMATE,
        agents::INTERACTION_REGISTER,
        agents::INTERACTION_NOTIFY,
        agents::INTERACTION_REQUEST,
        agents::INTERACTION_WAIT,
        agents::INTERACTION_RESPOND,
        agents::INTERACTION_PENDING,
        agents::INTERACTION_STREAM,
        live_pane::ATTACH,
        live_pane::OUTPUT,
        live_pane::INPUT,
        live_pane::INTERRUPT,
        live_pane::RESIZE,
        services::CREATE,
        services::STOP,
        services::RESUME,
        services::REMOVE,
        worktree_actions::CREATE,
        worktree_actions::CACHE_CLEANUP,
        worktree_actions::REMOVE,
        worktree_actions::GRAVEYARD,
        graveyard_actions::RESURRECT_AGENT,
        graveyard_actions::RESURRECT_WORKTREE,
        graveyard_actions::DELETE_WORKTREE,
        graveyard_actions::CLEANUP,
        threads::LIST,
        threads::OPEN,
        threads::SEND,
        threads::MARK_SEEN,
        threads::STATUS,
        tasks::LIST,
        tasks::ASSIGN,
        tasks::ACCEPT,
        tasks::BLOCK,
        tasks::CANCEL,
        tasks::COMPLETE,
        tasks::REOPEN,
        handoff::SEND,
        handoff::ACCEPT,
        handoff::COMPLETE,
        reviews::APPROVE,
        reviews::REQUEST_CHANGES,
        orchestration::ROUTES,
        ATTACHMENTS,
        ATTACHMENTS_PUBLISH,
        controls::SWITCHABLE_AGENTS,
        controls::OPEN_DASHBOARD,
        controls::OPEN_NOTIFICATION_TARGET,
        controls::FOCUS_WINDOW,
        controls::ACTIVE_WINDOW,
        controls::SWITCH_NEXT,
        controls::SWITCH_PREV,
        controls::SWITCH_ATTENTION,
        runtime::USAGE_MARK,
        runtime::SET_STATUS,
        runtime::SET_PROGRESS,
        runtime::SET_CONTEXT,
        runtime::SET_SERVICES,
        runtime::LOG,
        runtime::EVENT,
        runtime::MARK_SEEN,
        runtime::SET_ACTIVITY,
        runtime::SET_ATTENTION,
        runtime::CLEAR_LOG,
        runtime::NOTIFY,
        runtime::NOTIFICATION_CONTEXT,
        runtime::SHELL_STATE,
        runtime::COMPACT_EXCHANGE,
    ]
}
