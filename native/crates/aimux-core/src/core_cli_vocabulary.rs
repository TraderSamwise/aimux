//! What a core CLI command is, before anyone runs it.
//!
//! Planning a command is the local crate's business; naming one is not. The
//! remote half plans the same commands over the relay, so the vocabulary --
//! the operations, the action to take, the context it is read in, and how
//! planning can fail -- lives where both can say it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::core_cli_routing::CoreLogsArgs;
use crate::core_cli_transport::CoreCommandCall;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoreCliOutputMode {
    Json,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoreCliOperation {
    Init,
    HostStatus,
    HostAgentRead,
    HostAgentStream,
    AgentInput,
    AgentList,
    AgentIdentity,
    Compact,
    AgentRename,
    AgentMigrate,
    AgentPlane,
    AgentPs,
    LifecycleSpawn,
    ServiceCreate,
    ServiceRemove,
    LifecycleStart,
    LifecycleStop,
    LifecycleKill,
    LifecycleFork,
    LoopAdd,
    LoopRemove,
    LoopPause,
    LoopUnpause,
    LoopList,
    LoopDone,
    LoopBlock,
    OverseerStart,
    OverseerClear,
    OverseerStatus,
    ScribeStart,
    ScribeClear,
    ScribeStatus,
    TeamShow,
    TeamInit,
    TeamAdd,
    TeamRemove,
    TeamDefault,
    NotificationSend,
    NotificationList,
    NotificationRead,
    NotificationClear,
    OutlineList,
    OutlineShow,
    OutlineUpdate,
    AttachmentPublish,
    MessageSend,
    HandoffSend,
    HandoffAccept,
    HandoffComplete,
    TaskList,
    TaskShow,
    TaskAssign,
    TaskAccept,
    TaskBlock,
    TaskCancel,
    TaskComplete,
    TaskReopen,
    JobRun,
    JobShow,
    JobList,
    JobTail,
    JobWait,
    JobCancel,
    JobNotify,
    JobTmuxAttach,
    ReviewApprove,
    ReviewRequestChanges,
    ReviewList,
    ThreadList,
    ThreadShow,
    ThreadOpen,
    ThreadSend,
    ThreadMarkSeen,
    ThreadStatus,
    WorktreeList,
    WorktreeCreate,
    WorktreePrune,
    WorktreeCacheCleanup,
    WorktreeRemove,
    WorktreeGraveyard,
    WorktreeResurrect,
    WorktreeDeleteGraveyard,
    GraveyardList,
    GraveyardSend,
    GraveyardReapDead,
    GraveyardResurrect,
    GraveyardCleanup,
    Metadata,
    Repair,
    RepairExchange,
    DoctorDisk,
    DoctorExchange,
    DoctorLifecycle,
    DoctorTmux,
    DoctorTasks,
    DoctorCoherence,
    DoctorServices,
    DoctorStability,
    DoctorInstalls,
    DoctorNotifications,
    NotificationsTest,
    DashboardReload,
    RuntimeRestart,
    ProjectServe,
    HostStop,
    HostKill,
    HostRestart,
    HostTopology,
    DaemonEnsure,
    DaemonStop,
    DaemonKill,
    RuntimeMigrationAudit,
    RuntimeMigrationImport,
    RuntimeMigrationRollback,
    DaemonRestart,
    DaemonStatus,
    DaemonProjects,
    DaemonProjectEnsure,
    DoctorVersions,
    Logs,
    ProjectsList,
    ProjectsRemove,
    Restart,
    Remote(crate::remote_cli_vocabulary::RemoteCliOperation),
    DebugState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoreCliFallback {
    None,
    StoredDaemonStatus,
    Remote(crate::remote_cli_vocabulary::RemoteCliFallback),
    MissingDashboardTarget,
    EmptyLogTail,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreCliContext {
    pub current_working_dir: String,
    /// The caller resolves the current working directory through `findMainRepo`
    /// before planning. This module intentionally has no filesystem dependency.
    pub current_project_root: String,
    pub daemon_running: bool,
    pub has_credentials: bool,
    pub loop_actor: CoreLoopActorContext,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoreLoopActorContext {
    pub session_id: Option<String>,
    pub tool: Option<String>,
    pub overseer: bool,
    pub project_root: Option<String>,
    pub delivery_ref: Option<String>,
}

impl CoreLoopActorContext {
    pub fn from_env() -> Self {
        Self {
            session_id: env_value("AIMUX_SESSION_ID"),
            tool: env_value("AIMUX_TOOL"),
            overseer: std::env::var("AIMUX_OVERSEER").ok().as_deref() == Some("1"),
            project_root: env_value("AIMUX_PROJECT_ROOT"),
            delivery_ref: env_value("AIMUX_DELIVERY_REF"),
        }
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, PartialEq)]
pub enum CoreCliAction {
    Command {
        request: CoreCommandCall,
        open_dashboard_after: bool,
    },
    TextRoute {
        path: String,
        body: Option<Value>,
    },
    JobRun {
        create_path: String,
        events_path: String,
        body: Value,
        detach: bool,
    },
    JobEventStream {
        events_path: String,
        quiet: bool,
    },
    JobTmuxAttach {
        show_path: String,
    },
    RestartControlPlane {
        project_root: Option<String>,
        force: bool,
        all: bool,
    },
    StopDaemon {
        signal: &'static str,
    },
    Logs(CoreLogsArgs),
    InitProject,
    HostTopology {
        json: bool,
        raw: bool,
    },
    AgentIdentity {
        project_root: String,
        session_id: String,
    },
    Compact {
        project_root: String,
    },
    Remote(crate::remote_cli_vocabulary::RemoteCliAction),
    DebugState {
        target: String,
    },
    InstallCleanup {
        fix: bool,
        retention_days: Option<String>,
        keep_recent: Option<String>,
    },
    DoctorNotifications,
    NotificationTest {
        title: String,
        body: String,
        open_url: Option<String>,
    },
    RuntimeMigrationAudit {
        project_root: String,
    },
    RuntimeMigrationImport {
        project_root: String,
    },
    RuntimeMigrationRollback {
        manifest: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoreCliPlan {
    pub args: Vec<String>,
    pub operation: CoreCliOperation,
    pub output_mode: CoreCliOutputMode,
    pub action: CoreCliAction,
    pub fallback: CoreCliFallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreCliPlanError {
    Unsupported { args: Vec<String> },
    InvalidArguments { args: Vec<String>, message: String },
}

impl CoreCliPlanError {
    pub const fn exit_code(&self) -> i32 {
        match self {
            Self::Unsupported { .. } => 2,
            Self::InvalidArguments { .. } => 1,
        }
    }
}

impl Display for CoreCliPlanError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported { args } => {
                write!(formatter, "unsupported core command: {}", args.join(" "))
            }
            Self::InvalidArguments { message, .. } => formatter.write_str(message),
        }
    }
}

impl Error for CoreCliPlanError {}
