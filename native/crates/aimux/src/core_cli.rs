use crate::core_cli_routing::{
    CoreHostAgentReadArgsError, CoreHostAgentStreamArgsError, CoreLogsArgs, CoreLogsSubcommand,
    core_command_args, is_core_cli_command, parse_core_agent_identity_args,
    parse_core_agent_input_args, parse_core_agent_list_args, parse_core_agent_migrate_args,
    parse_core_agent_ps_args, parse_core_agent_rename_args, parse_core_attachment_publish_args,
    parse_core_collaboration_args, parse_core_daemon_restart_args, parse_core_doctor_args,
    parse_core_graveyard_args, parse_core_host_agent_read_args_result,
    parse_core_host_agent_stream_args_result, parse_core_host_project_stop_args,
    parse_core_host_restart_args, parse_core_host_topology_args, parse_core_lifecycle_fork_args,
    parse_core_lifecycle_spawn_args, parse_core_lifecycle_status_args, parse_core_logs_args,
    parse_core_loop_exit_args, parse_core_loop_mutation_args, parse_core_metadata_args,
    parse_core_migration_args, parse_core_notification_args, parse_core_notification_test_args,
    parse_core_outline_args, parse_core_overseer_clear_args, parse_core_overseer_start_args,
    parse_core_project_ensure_args, parse_core_project_stop_args, parse_core_projects_remove_args,
    parse_core_repair_args, parse_core_restart_args, parse_core_scribe_clear_args,
    parse_core_scribe_start_args, parse_core_service_create_args, parse_core_task_args,
    parse_core_team_args, parse_core_thread_args, parse_core_worktree_args,
};
use crate::core_command_contract::{CORE_API_ROUTES, CORE_COMMAND_NAMES};
use crate::native_cli_dispatch::{
    CORE_LOOP_LIST_TEXT_ROUTE, CORE_OVERSEER_STATUS_TEXT_ROUTE, CORE_REVIEW_LIST_TEXT_ROUTE,
    CORE_SCRIBE_STATUS_TEXT_ROUTE, CORE_SERVICE_CREATE_TEXT_ROUTE,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

pub const CORE_DIAGNOSTIC_TIMEOUT_MS: u64 = 1_000;

mod paths;
mod transport;
use paths::*;
use transport::call;
pub use transport::{
    CoreCommandCall, CoreCommandEnvelope, CoreCommandError, CoreCommandOk,
    CoreCommandRequestOptions, CoreCommandResponse, CoreCommandResponseError,
    CoreCommandTransportRequest, CoreHttpMethod, build_core_command_transport_request,
    validate_core_command_response,
};

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
    AgentPs,
    LifecycleSpawn,
    ServiceCreate,
    LifecycleStop,
    LifecycleKill,
    LifecycleFork,
    LoopAdd,
    LoopRemove,
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
    WorktreeCacheCleanup,
    WorktreeRemove,
    WorktreeGraveyard,
    WorktreeResurrect,
    WorktreeDeleteGraveyard,
    GraveyardList,
    GraveyardSend,
    GraveyardResurrect,
    GraveyardCleanup,
    Metadata,
    Repair,
    RepairExchange,
    DoctorDisk,
    DoctorExchange,
    DoctorLifecycle,
    DoctorTmux,
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
    RemoteStatus,
    RemoteEnable,
    RemoteDisable,
    Whoami,
    Logout,
    Login,
    SecurityUnlock,
    SecurityDevices,
    SecurityDeviceApprove,
    SecurityDeviceBlock,
    SecurityDeviceUnblock,
    DebugState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoreCliFallback {
    None,
    StoredDaemonStatus,
    RelayOff,
    NotLoggedIn,
    DisableRemoteLocally,
    IgnoreRelayDisableFailure,
    RelayDisconnected,
    RelayDeferredUntilDaemonStart,
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
}

impl CoreLoopActorContext {
    pub fn from_env() -> Self {
        Self {
            session_id: env_value("AIMUX_SESSION_ID"),
            tool: env_value("AIMUX_TOOL"),
            overseer: std::env::var("AIMUX_OVERSEER").ok().as_deref() == Some("1"),
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
    RestartControlPlane {
        project_root: Option<String>,
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
    RemoteStatus {
        relay_request: Option<CoreCommandCall>,
    },
    RemoteEnable {
        relay_request: Option<CoreCommandCall>,
    },
    RemoteDisable {
        relay_request: Option<CoreCommandCall>,
    },
    Whoami,
    Logout {
        relay_disable: Option<CoreCommandCall>,
    },
    Login {
        security_unlock: bool,
        relay_enable: Option<CoreCommandCall>,
    },
    SecurityDevices {
        json: bool,
    },
    SecurityDeviceApproveLive {
        device_id: Option<String>,
        json: bool,
    },
    SecurityDeviceUpdate {
        device_id: String,
        action: &'static str,
        approval_code: Option<String>,
        json: bool,
    },
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
    Unsupported {
        args: Vec<String>,
    },
    InvalidArguments {
        args: Vec<String>,
        message: &'static str,
    },
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

fn output_mode(args: &[String]) -> CoreCliOutputMode {
    if args.iter().any(|arg| arg == "--json") {
        CoreCliOutputMode::Json
    } else {
        CoreCliOutputMode::Text
    }
}

fn has_only_json_flag(args: &[String]) -> bool {
    args.iter().all(|arg| arg == "--json")
}

fn default_call(command: &'static str, payload: Option<Value>) -> CoreCommandCall {
    call(command, payload, CoreCommandRequestOptions::default())
}

fn existing_daemon_call(command: &'static str) -> CoreCommandCall {
    call(command, None, CoreCommandRequestOptions::existing_daemon())
}

fn command_action(request: CoreCommandCall) -> CoreCliAction {
    CoreCliAction::Command {
        request,
        open_dashboard_after: false,
    }
}

fn parse_project_read_options(
    args: &[String],
    label: &'static str,
) -> Result<(Option<String>, bool), CoreCliPlanError> {
    let mut project = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = args.get(index + 1).map(String::as_str).unwrap_or("");
            if value.is_empty() || value.starts_with('-') {
                return Err(CoreCliPlanError::InvalidArguments {
                    args: args.to_vec(),
                    message: "error: invalid project argument",
                });
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return Err(CoreCliPlanError::InvalidArguments {
                    args: args.to_vec(),
                    message: "error: invalid project argument",
                });
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        return Err(CoreCliPlanError::InvalidArguments {
            args: args.to_vec(),
            message: match label {
                "loop list" => "error: invalid loop list arguments",
                "overseer status" => "error: invalid overseer status arguments",
                "scribe status" => "error: invalid scribe status arguments",
                "review list" => "error: invalid review list arguments",
                _ => "error: invalid arguments",
            },
        });
    }
    Ok((project, json))
}

/// Produces the high-level execution decision made by `runCoreCli` while
/// leaving filesystem access, credential mutation, tmux opening, and HTTP I/O
/// to the caller. Explicit project arguments are passed through unchanged.
pub fn classify_core_cli<S: AsRef<str>>(
    raw_args: &[S],
    context: &CoreCliContext,
) -> Result<CoreCliPlan, CoreCliPlanError> {
    classify_core_cli_with_project_resolver(raw_args, context, str::to_owned)
}

/// Variant used by an integrating CLI to apply the TypeScript
/// `pathResolve`/`findMainRepo` behavior before a project path enters a payload.
pub fn classify_core_cli_with_project_resolver<S, F>(
    raw_args: &[S],
    context: &CoreCliContext,
    resolve_project_root: F,
) -> Result<CoreCliPlan, CoreCliPlanError>
where
    S: AsRef<str>,
    F: Fn(&str) -> String,
{
    let args = core_command_args(raw_args);
    let native_cutover_command = matches!(
        args.first().map(String::as_str),
        Some("dashboard-reload" | "restart-runtime")
    );
    if !native_cutover_command && !is_core_cli_command(&args) {
        return Err(CoreCliPlanError::Unsupported { args });
    }
    let mode = output_mode(&args);
    let command = args.first().map(String::as_str).unwrap_or("");
    let subcommand = args.get(1).map(String::as_str).unwrap_or("");

    let (operation, action, fallback) = match (command, subcommand) {
        ("init", _) => (
            CoreCliOperation::Init,
            CoreCliAction::InitProject,
            CoreCliFallback::None,
        ),
        ("restart", _) => {
            let parsed = parse_core_restart_args(&args).expect("eligible restart must parse");
            let project_root = parsed.project.as_deref().map(&resolve_project_root);
            (
                CoreCliOperation::Restart,
                CoreCliAction::RestartControlPlane { project_root },
                CoreCliFallback::None,
            )
        }
        ("input", _) => {
            let parsed = parse_core_agent_input_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "aimux: input requires non-empty text",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::AgentInput,
                CoreCliAction::TextRoute {
                    path: CORE_API_ROUTES.agent_input_text.to_owned(),
                    body: Some(json!({
                        "project": project_root,
                        "sessionId": parsed.session_id,
                        "text": parsed.text,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("list", _) => {
            let parsed = parse_core_agent_list_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid list arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::AgentList,
                CoreCliAction::TextRoute {
                    path: agent_list_text_path(&project_root, parsed.json),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("id", _) => {
            let parsed = parse_core_agent_identity_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid id arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::AgentIdentity,
                CoreCliAction::AgentIdentity {
                    project_root,
                    session_id: parsed.session_id,
                },
                CoreCliFallback::None,
            )
        }
        ("compact", _) => (
            CoreCliOperation::Compact,
            CoreCliAction::Compact {
                project_root: context.current_project_root.clone(),
            },
            CoreCliFallback::None,
        ),
        ("rename", _) => {
            let parsed = parse_core_agent_rename_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid rename arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::AgentRename,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.agent_rename_text, parsed.json),
                    body: Some(json!({
                        "project": project_root,
                        "sessionId": parsed.session_id,
                        "label": parsed.label,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("migrate", _) => {
            let parsed = parse_core_agent_migrate_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid migrate arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::AgentMigrate,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.agent_migrate_text, parsed.json),
                    body: Some(json!({
                        "project": project_root,
                        "sessionId": parsed.session_id,
                        "worktreePath": parsed.worktree,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("spawn", _) => {
            let parsed = parse_core_lifecycle_spawn_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid spawn arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let mut body = serde_json::Map::from_iter([
                ("project".into(), json!(project_root)),
                ("tool".into(), json!(parsed.tool)),
                ("worktreePath".into(), json!(parsed.worktree)),
                ("open".into(), json!(parsed.open)),
            ]);
            if !parsed.extra_args.is_empty() {
                body.insert("extraArgs".into(), json!(parsed.extra_args));
            }
            (
                CoreCliOperation::LifecycleSpawn,
                CoreCliAction::TextRoute {
                    path: lifecycle_spawn_text_path(&parsed, &project_root),
                    body: Some(Value::Object(body)),
                },
                CoreCliFallback::None,
            )
        }
        ("service", "create") => {
            let parsed = parse_core_service_create_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid service create arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::ServiceCreate,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_SERVICE_CREATE_TEXT_ROUTE, parsed.json),
                    body: Some(json!({
                        "project": project_root,
                        "command": parsed.command,
                        "worktreePath": parsed.worktree,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("stop", _) => {
            if let Some(parsed) = parse_core_project_stop_args(&args) {
                let project_root = parsed
                    .project
                    .as_deref()
                    .map(&resolve_project_root)
                    .unwrap_or_else(|| context.current_project_root.clone());
                (
                    CoreCliOperation::HostStop,
                    CoreCliAction::TextRoute {
                        path: project_text_path(
                            CORE_API_ROUTES.project_stop_text,
                            &project_root,
                            parsed.json,
                        ),
                        body: None,
                    },
                    CoreCliFallback::None,
                )
            } else {
                let parsed = parse_core_lifecycle_status_args(&args, "stop").ok_or_else(|| {
                    CoreCliPlanError::InvalidArguments {
                        args: args.clone(),
                        message: "error: invalid stop arguments",
                    }
                })?;
                let project_root = parsed
                    .project
                    .as_deref()
                    .map(&resolve_project_root)
                    .unwrap_or_else(|| context.current_project_root.clone());
                (
                    CoreCliOperation::LifecycleStop,
                    CoreCliAction::TextRoute {
                        path: text_route_path(CORE_API_ROUTES.lifecycle_stop_text, parsed.json),
                        body: Some(json!({
                            "project": project_root,
                            "sessionId": parsed.session_id,
                        })),
                    },
                    CoreCliFallback::None,
                )
            }
        }
        ("kill", _) => {
            let parsed = parse_core_lifecycle_status_args(&args, "kill").ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid kill arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::LifecycleKill,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.lifecycle_kill_text, parsed.json),
                    body: Some(json!({
                        "project": project_root,
                        "sessionId": parsed.session_id,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("fork", _) => {
            let parsed = parse_core_lifecycle_fork_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid fork arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::LifecycleFork,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.lifecycle_fork_text, parsed.json),
                    body: Some(json_without_null_fields(json!({
                        "project": project_root,
                        "sourceSessionId": parsed.source_session_id,
                        "tool": parsed.tool,
                        "instruction": parsed.instruction,
                        "worktreePath": parsed.worktree,
                        "open": parsed.open,
                    }))),
                },
                CoreCliFallback::None,
            )
        }
        ("loop", "add" | "remove") => {
            let parsed = parse_core_loop_mutation_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid loop arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let mut body = serde_json::Map::from_iter([
                ("project".into(), Value::String(project_root)),
                ("sessionId".into(), Value::String(parsed.session_id)),
            ]);
            body.extend(loop_actor_payload(&context.loop_actor, "human"));
            if let Some(goal) = parsed.goal {
                body.insert("goal".into(), Value::String(goal));
            }
            let (operation, route) = if parsed.subcommand == "add" {
                (CoreCliOperation::LoopAdd, CORE_API_ROUTES.loop_add_text)
            } else {
                (
                    CoreCliOperation::LoopRemove,
                    CORE_API_ROUTES.loop_remove_text,
                )
            };
            (
                operation,
                CoreCliAction::TextRoute {
                    path: text_route_path(route, parsed.json),
                    body: Some(Value::Object(body)),
                },
                CoreCliFallback::None,
            )
        }
        ("loop", "done" | "block") => {
            let parsed = parse_core_loop_exit_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid loop arguments",
                }
            })?;
            let session_id = parsed
                .session_id
                .or_else(|| context.loop_actor.session_id.clone())
                .ok_or_else(|| CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "aimux: pass --session or run inside an aimux agent (AIMUX_SESSION_ID is unset)",
                })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let mut body = serde_json::Map::from_iter([
                ("project".into(), Value::String(project_root)),
                ("sessionId".into(), Value::String(session_id)),
            ]);
            body.extend(loop_actor_payload(&context.loop_actor, "agent"));
            if let Some(reason) = parsed.reason {
                body.insert("reason".into(), Value::String(reason));
            }
            let (operation, route) = if parsed.subcommand == "done" {
                (CoreCliOperation::LoopDone, CORE_API_ROUTES.loop_done_text)
            } else {
                (CoreCliOperation::LoopBlock, CORE_API_ROUTES.loop_block_text)
            };
            (
                operation,
                CoreCliAction::TextRoute {
                    path: text_route_path(route, parsed.json),
                    body: Some(Value::Object(body)),
                },
                CoreCliFallback::None,
            )
        }
        ("loop", "list") => {
            let (project, json) = parse_project_read_options(&args, "loop list")?;
            let project_root = project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::LoopList,
                CoreCliAction::TextRoute {
                    path: project_text_path(CORE_LOOP_LIST_TEXT_ROUTE, &project_root, json),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("overseer", "status") => {
            let (project, json) = parse_project_read_options(&args, "overseer status")?;
            let project_root = project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::OverseerStatus,
                CoreCliAction::TextRoute {
                    path: project_text_path(CORE_OVERSEER_STATUS_TEXT_ROUTE, &project_root, json),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("scribe", "status") => {
            let (project, json) = parse_project_read_options(&args, "scribe status")?;
            let project_root = project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::ScribeStatus,
                CoreCliAction::TextRoute {
                    path: project_text_path(CORE_SCRIBE_STATUS_TEXT_ROUTE, &project_root, json),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("review", "list") => {
            let (project, json) = parse_project_read_options(&args, "review list")?;
            let project_root = project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::ReviewList,
                CoreCliAction::TextRoute {
                    path: project_text_path(CORE_REVIEW_LIST_TEXT_ROUTE, &project_root, json),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("overseer", "start") => {
            let parsed = parse_core_overseer_start_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid overseer start arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::OverseerStart,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.overseer_start_text, parsed.json),
                    body: Some(json!({
                        "project": project_root,
                        "tool": parsed.tool,
                        "worktreePath": parsed.worktree,
                        "open": parsed.open,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("overseer", "clear") => {
            let parsed = parse_core_overseer_clear_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid overseer clear arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::OverseerClear,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.overseer_clear_text, parsed.json),
                    body: Some(json!({
                        "project": project_root,
                        "sessionId": parsed.session_id,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("scribe", "start") => {
            let parsed = parse_core_scribe_start_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid scribe start arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::ScribeStart,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.scribe_start_text, parsed.json),
                    body: Some(json!({
                        "project": project_root,
                        "tool": parsed.tool,
                        "worktreePath": parsed.worktree,
                        "open": parsed.open,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("scribe", "clear") => {
            let parsed = parse_core_scribe_clear_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid scribe clear arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::ScribeClear,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.scribe_clear_text, parsed.json),
                    body: Some(json!({
                        "project": project_root,
                        "sessionId": parsed.session_id,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("team", "show" | "init" | "add" | "default" | "remove") => {
            let parsed =
                parse_core_team_args(&args).ok_or_else(|| CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid team arguments",
                })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let (operation, route, body) = match parsed.subcommand.as_str() {
                "show" => (
                    CoreCliOperation::TeamShow,
                    CORE_API_ROUTES.team_show_text,
                    None,
                ),
                "init" => (
                    CoreCliOperation::TeamInit,
                    CORE_API_ROUTES.team_init_text,
                    Some(json!({ "project": project_root.clone() })),
                ),
                "add" => (
                    CoreCliOperation::TeamAdd,
                    CORE_API_ROUTES.team_add_text,
                    Some(json!({
                        "project": project_root.clone(),
                        "role": parsed.role,
                        "description": parsed.description,
                        "reviewedBy": parsed.reviewed_by,
                        "canEdit": parsed.can_edit,
                    })),
                ),
                "remove" => (
                    CoreCliOperation::TeamRemove,
                    CORE_API_ROUTES.team_remove_text,
                    Some(json!({ "project": project_root.clone(), "role": parsed.role })),
                ),
                "default" => (
                    CoreCliOperation::TeamDefault,
                    CORE_API_ROUTES.team_default_text,
                    Some(json!({ "project": project_root.clone(), "role": parsed.role })),
                ),
                _ => unreachable!("validated team subcommand"),
            };
            let path = if parsed.subcommand == "show" {
                let mut path = format!(
                    "{}?project={}",
                    CORE_API_ROUTES.team_show_text,
                    encode_query_component(&project_root)
                );
                if parsed.json {
                    path.push_str("&json=1");
                }
                path
            } else {
                text_route_path(route, parsed.json)
            };
            (
                operation,
                CoreCliAction::TextRoute { path, body },
                CoreCliFallback::None,
            )
        }
        ("notify", _)
        | ("list-notifications", _)
        | ("read-notifications", _)
        | ("clear-notifications", _) => {
            let parsed = parse_core_notification_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid notification arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let (operation, path, body) = match parsed.command.as_str() {
                "notify" => (
                    CoreCliOperation::NotificationSend,
                    text_route_path(CORE_API_ROUTES.notification_send_text, parsed.json),
                    Some(json!({
                        "project": project_root,
                        "title": parsed.title,
                        "subtitle": parsed.subtitle,
                        "body": parsed.body,
                        "sessionId": parsed.session_id,
                        "kind": parsed.kind,
                    })),
                ),
                "list-notifications" => (
                    CoreCliOperation::NotificationList,
                    notification_list_text_path(
                        &project_root,
                        parsed.unread,
                        parsed.session_id.as_deref(),
                        parsed.json,
                    ),
                    None,
                ),
                "read-notifications" => (
                    CoreCliOperation::NotificationRead,
                    text_route_path(CORE_API_ROUTES.notification_read_text, parsed.json),
                    Some(json!({
                        "project": project_root,
                        "id": parsed.id,
                        "ids": parsed.ids,
                        "sessionId": parsed.session_id,
                    })),
                ),
                "clear-notifications" => (
                    CoreCliOperation::NotificationClear,
                    text_route_path(CORE_API_ROUTES.notification_clear_text, parsed.json),
                    Some(json!({
                        "project": project_root,
                        "id": parsed.id,
                        "ids": parsed.ids,
                        "sessionId": parsed.session_id,
                    })),
                ),
                _ => unreachable!("validated notification command"),
            };
            (
                operation,
                CoreCliAction::TextRoute { path, body },
                CoreCliFallback::None,
            )
        }
        ("notifications", "test") => {
            let parsed = parse_core_notification_test_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid notifications test arguments",
                }
            })?;
            (
                CoreCliOperation::NotificationsTest,
                CoreCliAction::NotificationTest {
                    title: parsed.title,
                    body: parsed.body,
                    open_url: parsed.open_url,
                },
                CoreCliFallback::None,
            )
        }
        ("outline", "list" | "show" | "update") => {
            let parsed = parse_core_outline_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid outline arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let (operation, path, body) = match parsed.subcommand.as_str() {
                "list" => (
                    CoreCliOperation::OutlineList,
                    outline_list_text_path(OutlineListTextPathArgs {
                        project: &project_root,
                        entry_id: None,
                        session: parsed.session.as_deref(),
                        worktree: parsed.worktree.as_deref(),
                        status: parsed.status.as_deref(),
                        search: parsed.search.as_deref(),
                        limit: parsed.limit.as_deref(),
                        json: parsed.json,
                    }),
                    None,
                ),
                "show" => (
                    CoreCliOperation::OutlineShow,
                    outline_list_text_path(OutlineListTextPathArgs {
                        project: &project_root,
                        entry_id: parsed.entry_id.as_deref(),
                        session: None,
                        worktree: None,
                        status: None,
                        search: None,
                        limit: None,
                        json: parsed.json,
                    }),
                    None,
                ),
                "update" => (
                    CoreCliOperation::OutlineUpdate,
                    text_route_path(CORE_API_ROUTES.outline_update_text, parsed.json),
                    Some(json!({
                        "project": project_root,
                        "title": parsed.title,
                        "summary": parsed.summary,
                        "topicKey": parsed.topic_key,
                        "sessionId": parsed.session,
                        "worktreePath": parsed.worktree,
                        "status": parsed.status,
                        "source": parsed.source,
                    })),
                ),
                _ => unreachable!("validated outline subcommand"),
            };
            (
                operation,
                CoreCliAction::TextRoute { path, body },
                CoreCliFallback::None,
            )
        }
        ("attachment", "publish") => {
            let parsed = parse_core_attachment_publish_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid attachment publish arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::AttachmentPublish,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.attachment_publish_text, parsed.json),
                    body: Some(json!({
                        "project": project_root,
                        "path": resolve_cwd_path(&context.current_working_dir, &parsed.path),
                        "sessionId": parsed.session,
                        "filename": parsed.name,
                        "mimeType": parsed.mime,
                    })),
                },
                CoreCliFallback::None,
            )
        }
        ("message", "send") | ("handoff", "send" | "accept" | "complete") => {
            let parsed = parse_core_collaboration_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid collaboration arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let (operation, route, body) =
                match (parsed.command.as_str(), parsed.subcommand.as_str()) {
                    ("message", "send") => (
                        CoreCliOperation::MessageSend,
                        CORE_API_ROUTES.message_send_text,
                        json!({
                            "project": project_root,
                            "thread": parsed.thread_id,
                            "from": parsed.from,
                            "to": parsed.to,
                            "assignee": parsed.assignee,
                            "tool": parsed.tool,
                            "worktree": parsed.worktree,
                            "kind": parsed.kind,
                            "body": parsed.body,
                            "title": parsed.title,
                        }),
                    ),
                    ("handoff", "send") => (
                        CoreCliOperation::HandoffSend,
                        CORE_API_ROUTES.handoff_send_text,
                        json!({
                            "project": project_root,
                            "from": parsed.from,
                            "to": parsed.to,
                            "assignee": parsed.assignee,
                            "tool": parsed.tool,
                            "body": parsed.body,
                            "title": parsed.title,
                            "worktree": parsed.worktree,
                        }),
                    ),
                    ("handoff", "accept") => (
                        CoreCliOperation::HandoffAccept,
                        CORE_API_ROUTES.handoff_accept_text,
                        json!({
                            "project": project_root,
                            "threadId": parsed.thread_id,
                            "from": parsed.from,
                            "body": parsed.body,
                        }),
                    ),
                    ("handoff", "complete") => (
                        CoreCliOperation::HandoffComplete,
                        CORE_API_ROUTES.handoff_complete_text,
                        json!({
                            "project": project_root,
                            "threadId": parsed.thread_id,
                            "from": parsed.from,
                            "body": parsed.body,
                        }),
                    ),
                    _ => unreachable!("validated collaboration command"),
                };
            (
                operation,
                CoreCliAction::TextRoute {
                    path: text_route_path(route, parsed.json),
                    body: Some(body),
                },
                CoreCliFallback::None,
            )
        }
        (
            "task",
            "list" | "show" | "assign" | "accept" | "block" | "cancel" | "complete" | "reopen",
        )
        | ("review", "approve" | "request-changes") => {
            let parsed =
                parse_core_task_args(&args).ok_or_else(|| CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid workflow arguments",
                })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let (operation, path, body) =
                match (parsed.command.as_str(), parsed.subcommand.as_str()) {
                    ("task", "list") => (
                        CoreCliOperation::TaskList,
                        task_list_text_path(
                            &project_root,
                            parsed.session.as_deref(),
                            parsed.status.as_deref(),
                            parsed.json,
                        ),
                        None,
                    ),
                    ("task", "show") => (
                        CoreCliOperation::TaskShow,
                        task_show_text_path(
                            &project_root,
                            parsed.task_id.as_deref().unwrap_or(""),
                            parsed.json,
                        ),
                        None,
                    ),
                    ("task", "assign") => (
                        CoreCliOperation::TaskAssign,
                        text_route_path(CORE_API_ROUTES.task_assign_text, parsed.json),
                        Some(json!({
                            "project": project_root,
                            "from": parsed.from,
                            "to": parsed.to,
                            "assignee": parsed.assignee,
                            "tool": parsed.tool,
                            "description": parsed.description,
                            "prompt": parsed.prompt,
                            "type": parsed.task_type,
                            "diff": parsed.diff,
                            "worktree": parsed.worktree,
                        })),
                    ),
                    ("task", "accept") => (
                        CoreCliOperation::TaskAccept,
                        text_route_path(CORE_API_ROUTES.task_accept_text, parsed.json),
                        Some(json!({
                            "project": project_root,
                            "taskId": parsed.task_id,
                            "from": parsed.from,
                            "body": parsed.body,
                        })),
                    ),
                    ("task", "block") => (
                        CoreCliOperation::TaskBlock,
                        text_route_path(CORE_API_ROUTES.task_block_text, parsed.json),
                        Some(json!({
                            "project": project_root,
                            "taskId": parsed.task_id,
                            "from": parsed.from,
                            "body": parsed.body,
                        })),
                    ),
                    ("task", "cancel") => (
                        CoreCliOperation::TaskCancel,
                        text_route_path(CORE_API_ROUTES.task_cancel_text, parsed.json),
                        Some(json!({
                            "project": project_root,
                            "taskId": parsed.task_id,
                            "from": parsed.from,
                            "body": parsed.body,
                        })),
                    ),
                    ("task", "complete") => (
                        CoreCliOperation::TaskComplete,
                        text_route_path(CORE_API_ROUTES.task_complete_text, parsed.json),
                        Some(json!({
                            "project": project_root,
                            "taskId": parsed.task_id,
                            "from": parsed.from,
                            "body": parsed.body,
                            "result": parsed.result,
                        })),
                    ),
                    ("task", "reopen") => (
                        CoreCliOperation::TaskReopen,
                        text_route_path(CORE_API_ROUTES.task_reopen_text, parsed.json),
                        Some(json!({
                            "project": project_root,
                            "taskId": parsed.task_id,
                            "from": parsed.from,
                            "body": parsed.body,
                        })),
                    ),
                    ("review", "approve") => (
                        CoreCliOperation::ReviewApprove,
                        text_route_path(CORE_API_ROUTES.review_approve_text, parsed.json),
                        Some(json!({
                            "project": project_root,
                            "taskId": parsed.task_id,
                            "from": parsed.from,
                            "body": parsed.body,
                        })),
                    ),
                    ("review", "request-changes") => (
                        CoreCliOperation::ReviewRequestChanges,
                        text_route_path(CORE_API_ROUTES.review_request_changes_text, parsed.json),
                        Some(json!({
                            "project": project_root,
                            "taskId": parsed.task_id,
                            "from": parsed.from,
                            "body": parsed.body,
                        })),
                    ),
                    _ => unreachable!("validated workflow command"),
                };
            (
                operation,
                CoreCliAction::TextRoute { path, body },
                CoreCliFallback::None,
            )
        }
        ("thread", "list" | "show" | "open" | "send" | "mark-seen" | "status") | ("threads", _) => {
            let thread_args = if command == "threads" {
                let mut alias = vec!["thread".to_owned(), "list".to_owned()];
                alias.extend(args.iter().skip(1).cloned());
                alias
            } else {
                args.clone()
            };
            let parsed = parse_core_thread_args(&thread_args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid thread arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let (operation, path, body) = match parsed.subcommand.as_str() {
                "list" => (
                    CoreCliOperation::ThreadList,
                    thread_list_text_path(&project_root, parsed.session.as_deref(), parsed.json),
                    None,
                ),
                "show" => (
                    CoreCliOperation::ThreadShow,
                    thread_show_text_path(
                        &project_root,
                        parsed.thread_id.as_deref().unwrap_or(""),
                        parsed.json,
                    ),
                    None,
                ),
                "open" => (
                    CoreCliOperation::ThreadOpen,
                    text_route_path(CORE_API_ROUTES.thread_open_text, parsed.json),
                    Some(json!({
                        "project": project_root,
                        "title": parsed.title,
                        "from": parsed.from,
                        "participants": parsed.participants,
                        "kind": parsed.kind,
                    })),
                ),
                "send" => (
                    CoreCliOperation::ThreadSend,
                    text_route_path(CORE_API_ROUTES.thread_send_text, parsed.json),
                    Some(json!({
                        "project": project_root,
                        "threadId": parsed.thread_id,
                        "from": parsed.from,
                        "to": parsed.to,
                        "kind": parsed.kind,
                        "body": parsed.body,
                    })),
                ),
                "mark-seen" => (
                    CoreCliOperation::ThreadMarkSeen,
                    text_route_path(CORE_API_ROUTES.thread_mark_seen_text, parsed.json),
                    Some(json!({
                        "project": project_root,
                        "threadId": parsed.thread_id,
                        "session": parsed.session,
                    })),
                ),
                "status" => (
                    CoreCliOperation::ThreadStatus,
                    text_route_path(CORE_API_ROUTES.thread_status_text, parsed.json),
                    Some(json!({
                        "project": project_root,
                        "threadId": parsed.thread_id,
                        "status": parsed.status,
                        "owner": parsed.owner,
                        "waitingOn": parsed.waiting_on,
                    })),
                ),
                _ => unreachable!("validated thread subcommand"),
            };
            (
                operation,
                CoreCliAction::TextRoute { path, body },
                CoreCliFallback::None,
            )
        }
        (
            "worktree",
            "" | "list" | "add" | "create" | "cleanup-caches" | "remove" | "graveyard"
            | "resurrect" | "delete-graveyard",
        ) => {
            let parsed = parse_core_worktree_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid worktree arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let (operation, path, body) = match parsed.subcommand.as_str() {
                "list" => (
                    CoreCliOperation::WorktreeList,
                    project_text_path(
                        CORE_API_ROUTES.worktree_list_text,
                        &project_root,
                        parsed.json,
                    ),
                    None,
                ),
                "create" => (
                    CoreCliOperation::WorktreeCreate,
                    text_route_path(CORE_API_ROUTES.worktree_create_text, parsed.json),
                    Some(json!({ "project": project_root, "name": parsed.name })),
                ),
                "cleanup-caches" => (
                    CoreCliOperation::WorktreeCacheCleanup,
                    text_route_path(CORE_API_ROUTES.worktree_cache_cleanup_text, parsed.json),
                    Some(json!({
                        "project": project_root,
                        "dryRun": !parsed.yes,
                        "includeActive": parsed.include_active,
                    })),
                ),
                "remove" => (
                    CoreCliOperation::WorktreeRemove,
                    text_route_path(CORE_API_ROUTES.worktree_remove_text, parsed.json),
                    Some(json!({ "project": project_root, "path": parsed.path })),
                ),
                "graveyard" => (
                    CoreCliOperation::WorktreeGraveyard,
                    text_route_path(CORE_API_ROUTES.worktree_graveyard_text, parsed.json),
                    Some(json!({ "project": project_root, "path": parsed.path })),
                ),
                "resurrect" => (
                    CoreCliOperation::WorktreeResurrect,
                    text_route_path(CORE_API_ROUTES.worktree_resurrect_text, parsed.json),
                    Some(json!({ "project": project_root, "path": parsed.path })),
                ),
                "delete-graveyard" => (
                    CoreCliOperation::WorktreeDeleteGraveyard,
                    text_route_path(CORE_API_ROUTES.worktree_delete_graveyard_text, parsed.json),
                    Some(json!({ "project": project_root, "path": parsed.path })),
                ),
                _ => unreachable!("validated worktree subcommand"),
            };
            (
                operation,
                CoreCliAction::TextRoute { path, body },
                CoreCliFallback::None,
            )
        }
        ("graveyard", _) => {
            let parsed = parse_core_graveyard_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid graveyard arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            let (operation, path, body) = match parsed.subcommand.as_str() {
                "list" => (
                    CoreCliOperation::GraveyardList,
                    project_text_path(
                        CORE_API_ROUTES.graveyard_list_text,
                        &project_root,
                        parsed.json,
                    ),
                    None,
                ),
                "send" => (
                    CoreCliOperation::GraveyardSend,
                    text_route_path(CORE_API_ROUTES.graveyard_send_text, parsed.json),
                    Some(json!({ "project": project_root, "sessionId": parsed.session_id })),
                ),
                "resurrect" => (
                    CoreCliOperation::GraveyardResurrect,
                    text_route_path(CORE_API_ROUTES.graveyard_resurrect_text, parsed.json),
                    Some(json!({ "project": project_root, "sessionId": parsed.session_id })),
                ),
                "cleanup" => (
                    CoreCliOperation::GraveyardCleanup,
                    text_route_path(CORE_API_ROUTES.graveyard_cleanup_text, parsed.json),
                    Some(json!({ "project": project_root, "dryRun": parsed.dry_run })),
                ),
                _ => unreachable!("validated graveyard subcommand"),
            };
            (
                operation,
                CoreCliAction::TextRoute { path, body },
                CoreCliFallback::None,
            )
        }
        ("ps", _) => {
            let parsed = parse_core_agent_ps_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid ps arguments",
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::AgentPs,
                CoreCliAction::TextRoute {
                    path: agent_ps_text_path(&project_root, parsed.json),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("dashboard-reload", _) => {
            let (payload, json) =
                dashboard_reload_payload(context.current_project_root.clone(), &args)?;
            (
                CoreCliOperation::DashboardReload,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.dashboard_reload_text, json),
                    body: Some(payload),
                },
                CoreCliFallback::None,
            )
        }
        ("restart-runtime", _) => {
            let (payload, json) = runtime_restart_payload(
                context.current_project_root.clone(),
                &args,
                &resolve_project_root,
            )?;
            (
                CoreCliOperation::RuntimeRestart,
                CoreCliAction::TextRoute {
                    path: if json {
                        format!("{}?json=1", CORE_API_ROUTES.runtime_restart_text)
                    } else {
                        CORE_API_ROUTES.runtime_restart_text.to_owned()
                    },
                    body: Some(payload),
                },
                CoreCliFallback::None,
            )
        }
        ("host", "status") => (
            CoreCliOperation::HostStatus,
            command_action(default_call(CORE_COMMAND_NAMES.status, None)),
            CoreCliFallback::None,
        ),
        ("host", "agent-read") => {
            let parsed = parse_core_host_agent_read_args_result(&args).map_err(|error| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: match error {
                        CoreHostAgentReadArgsError::LinesNotPositive => {
                            "Error: --lines must be a positive integer"
                        }
                        CoreHostAgentReadArgsError::StartLineNotInteger => {
                            "Error: --start-line must be an integer"
                        }
                        CoreHostAgentReadArgsError::InvalidArguments => {
                            "error: invalid host agent-read arguments"
                        }
                    },
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::HostAgentRead,
                CoreCliAction::TextRoute {
                    path: host_agent_read_text_path(
                        &project_root,
                        &parsed.session_id,
                        parsed.start_line,
                    ),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("host", "agent-stream") => {
            let parsed = parse_core_host_agent_stream_args_result(&args).map_err(|error| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: match error {
                        CoreHostAgentStreamArgsError::LinesNotPositive => {
                            "Error: --lines must be a positive integer"
                        }
                        CoreHostAgentStreamArgsError::StartLineNotInteger => {
                            "Error: --start-line must be an integer"
                        }
                        CoreHostAgentStreamArgsError::IntervalMsInvalid => {
                            "Error: --interval-ms must be an integer >= 100"
                        }
                        CoreHostAgentStreamArgsError::InvalidArguments => {
                            "error: invalid host agent-stream arguments"
                        }
                    },
                }
            })?;
            let project_root = parsed
                .project
                .as_deref()
                .map(&resolve_project_root)
                .unwrap_or_else(|| context.current_project_root.clone());
            (
                CoreCliOperation::HostAgentStream,
                CoreCliAction::TextRoute {
                    path: host_agent_stream_text_path(
                        &project_root,
                        &parsed.session_id,
                        parsed.start_line,
                        parsed.interval_ms,
                    ),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("serve", _) => (
            CoreCliOperation::ProjectServe,
            command_action(default_call(
                CORE_COMMAND_NAMES.project_ensure,
                Some(project_payload(context.current_project_root.clone())),
            )),
            CoreCliFallback::None,
        ),
        ("host", "stop") => {
            let parsed =
                parse_core_host_project_stop_args(&args).expect("eligible host stop must parse");
            if parsed.project.is_none() && !parsed.json {
                (
                    CoreCliOperation::HostStop,
                    command_action(default_call(
                        CORE_COMMAND_NAMES.project_stop,
                        Some(project_payload(context.current_project_root.clone())),
                    )),
                    CoreCliFallback::None,
                )
            } else {
                let project_root = parsed
                    .project
                    .as_deref()
                    .map(&resolve_project_root)
                    .unwrap_or_else(|| context.current_project_root.clone());
                (
                    CoreCliOperation::HostStop,
                    CoreCliAction::TextRoute {
                        path: project_text_path(
                            CORE_API_ROUTES.project_stop_text,
                            &project_root,
                            parsed.json,
                        ),
                        body: None,
                    },
                    CoreCliFallback::None,
                )
            }
        }
        ("host", "kill") => {
            let parsed =
                parse_core_host_project_stop_args(&args).expect("eligible host kill must parse");
            if parsed.project.is_none() && !parsed.json {
                (
                    CoreCliOperation::HostKill,
                    command_action(default_call(
                        CORE_COMMAND_NAMES.project_kill,
                        Some(project_payload(context.current_project_root.clone())),
                    )),
                    CoreCliFallback::None,
                )
            } else {
                let project_root = parsed
                    .project
                    .as_deref()
                    .map(&resolve_project_root)
                    .unwrap_or_else(|| context.current_project_root.clone());
                (
                    CoreCliOperation::HostKill,
                    CoreCliAction::TextRoute {
                        path: project_text_path(
                            CORE_API_ROUTES.project_kill_text,
                            &project_root,
                            parsed.json,
                        ),
                        body: None,
                    },
                    CoreCliFallback::None,
                )
            }
        }
        ("host", "restart") => {
            let parsed =
                parse_core_host_restart_args(&args).expect("eligible host restart must parse");
            (
                CoreCliOperation::HostRestart,
                CoreCliAction::Command {
                    request: default_call(
                        CORE_COMMAND_NAMES.project_restart,
                        Some(project_restart_payload(
                            context.current_project_root.clone(),
                            parsed,
                        )),
                    ),
                    open_dashboard_after: parsed.open,
                },
                if parsed.open {
                    CoreCliFallback::MissingDashboardTarget
                } else {
                    CoreCliFallback::None
                },
            )
        }
        ("host", "topology") => {
            let parsed =
                parse_core_host_topology_args(&args).expect("eligible host topology must parse");
            (
                CoreCliOperation::HostTopology,
                CoreCliAction::HostTopology {
                    json: parsed.json,
                    raw: parsed.raw,
                },
                CoreCliFallback::None,
            )
        }
        ("daemon", "ensure") => (
            CoreCliOperation::DaemonEnsure,
            command_action(default_call(CORE_COMMAND_NAMES.status, None)),
            CoreCliFallback::None,
        ),
        ("daemon", "stop" | "kill") if has_only_json_flag(&args[2..]) => (
            if args[1] == "stop" {
                CoreCliOperation::DaemonStop
            } else {
                CoreCliOperation::DaemonKill
            },
            CoreCliAction::StopDaemon {
                signal: if args[1] == "stop" {
                    "SIGTERM"
                } else {
                    "SIGKILL"
                },
            },
            CoreCliFallback::None,
        ),
        ("daemon", "restart") => {
            parse_core_daemon_restart_args(&args).expect("eligible daemon restart must parse");
            (
                CoreCliOperation::DaemonRestart,
                CoreCliAction::RestartControlPlane { project_root: None },
                CoreCliFallback::None,
            )
        }
        ("daemon", "status") => (
            CoreCliOperation::DaemonStatus,
            command_action(existing_daemon_call(CORE_COMMAND_NAMES.status)),
            CoreCliFallback::StoredDaemonStatus,
        ),
        ("daemon", "projects") => (
            CoreCliOperation::DaemonProjects,
            command_action(default_call(CORE_COMMAND_NAMES.projects_list, None)),
            CoreCliFallback::None,
        ),
        ("daemon", "project-ensure") => {
            let parsed = parse_core_project_ensure_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid daemon project-ensure arguments",
                }
            })?;
            let project_root = resolve_project_root(&parsed.project);
            (
                CoreCliOperation::DaemonProjectEnsure,
                command_action(default_call(
                    CORE_COMMAND_NAMES.project_ensure,
                    Some(project_payload(project_root)),
                )),
                CoreCliFallback::None,
            )
        }
        ("migration", "audit" | "import" | "rollback") => {
            let parsed = parse_core_migration_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid migration arguments",
                }
            })?;
            match parsed.subcommand.as_str() {
                "audit" => {
                    let project_root = parsed
                        .project
                        .as_deref()
                        .map(&resolve_project_root)
                        .unwrap_or_else(|| context.current_project_root.clone());
                    (
                        CoreCliOperation::RuntimeMigrationAudit,
                        CoreCliAction::RuntimeMigrationAudit { project_root },
                        CoreCliFallback::None,
                    )
                }
                "import" => {
                    let project_root = parsed
                        .project
                        .as_deref()
                        .map(&resolve_project_root)
                        .unwrap_or_else(|| context.current_project_root.clone());
                    (
                        CoreCliOperation::RuntimeMigrationImport,
                        CoreCliAction::RuntimeMigrationImport { project_root },
                        CoreCliFallback::None,
                    )
                }
                "rollback" => (
                    CoreCliOperation::RuntimeMigrationRollback,
                    CoreCliAction::RuntimeMigrationRollback {
                        manifest: parsed.manifest.unwrap_or_default(),
                    },
                    CoreCliFallback::None,
                ),
                _ => unreachable!("validated migration command"),
            }
        }
        ("doctor", "versions") => (
            CoreCliOperation::DoctorVersions,
            CoreCliAction::TextRoute {
                path: if mode == CoreCliOutputMode::Json {
                    format!("{}?json=1", CORE_API_ROUTES.doctor_versions_text)
                } else {
                    CORE_API_ROUTES.doctor_versions_text.to_owned()
                },
                body: None,
            },
            CoreCliFallback::None,
        ),
        ("debug-state", _) if args.len() == 2 && !args[1].starts_with('-') => (
            CoreCliOperation::DebugState,
            CoreCliAction::DebugState {
                target: args[1].clone(),
            },
            CoreCliFallback::None,
        ),
        ("doctor", "disk" | "exchange" | "lifecycle" | "tmux" | "installs" | "notifications") => {
            let parsed = parse_core_doctor_args(&args).expect("eligible doctor must parse");
            if parsed.subcommand == "disk" {
                let project_root = parsed.project.as_deref().map(&resolve_project_root);
                (
                    CoreCliOperation::DoctorDisk,
                    CoreCliAction::TextRoute {
                        path: doctor_disk_text_path(
                            project_root.as_deref(),
                            parsed.include_active,
                            parsed.json,
                        ),
                        body: None,
                    },
                    CoreCliFallback::None,
                )
            } else if parsed.subcommand == "installs" {
                (
                    CoreCliOperation::DoctorInstalls,
                    CoreCliAction::InstallCleanup {
                        fix: parsed.fix,
                        retention_days: parsed.retention_days,
                        keep_recent: parsed.keep_recent,
                    },
                    CoreCliFallback::None,
                )
            } else if parsed.subcommand == "notifications" {
                (
                    CoreCliOperation::DoctorNotifications,
                    CoreCliAction::DoctorNotifications,
                    CoreCliFallback::None,
                )
            } else if parsed.subcommand == "exchange" {
                let project_root = parsed
                    .project
                    .as_deref()
                    .map(&resolve_project_root)
                    .unwrap_or_else(|| context.current_project_root.clone());
                (
                    CoreCliOperation::DoctorExchange,
                    CoreCliAction::TextRoute {
                        path: doctor_project_text_path(
                            CORE_API_ROUTES.doctor_exchange_text,
                            &project_root,
                            parsed.json,
                        ),
                        body: None,
                    },
                    CoreCliFallback::None,
                )
            } else if parsed.subcommand == "lifecycle" {
                let project_root = parsed
                    .project
                    .as_deref()
                    .map(&resolve_project_root)
                    .unwrap_or_else(|| context.current_project_root.clone());
                (
                    CoreCliOperation::DoctorLifecycle,
                    CoreCliAction::TextRoute {
                        path: doctor_project_text_path(
                            CORE_API_ROUTES.doctor_lifecycle_text,
                            &project_root,
                            parsed.json,
                        ),
                        body: None,
                    },
                    CoreCliFallback::None,
                )
            } else {
                let project_root = parsed
                    .project_root
                    .as_deref()
                    .map(&resolve_project_root)
                    .unwrap_or_else(|| context.current_project_root.clone());
                (
                    CoreCliOperation::DoctorTmux,
                    CoreCliAction::TextRoute {
                        path: doctor_tmux_text_path(
                            &project_root,
                            parsed.session.as_deref(),
                            parsed.window_id.as_deref(),
                            parsed.json,
                        ),
                        body: None,
                    },
                    CoreCliFallback::None,
                )
            }
        }
        ("metadata", _) => {
            let parsed = parse_core_metadata_args(&args).expect("eligible metadata must parse");
            (
                CoreCliOperation::Metadata,
                CoreCliAction::TextRoute {
                    path: metadata_text_path(&context.current_project_root, &parsed.args),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("repair", _) => {
            let parsed = parse_core_repair_args(&args).expect("eligible repair must parse");
            if parsed.subcommand == "exchange" {
                let project_root = parsed
                    .project
                    .as_deref()
                    .map(&resolve_project_root)
                    .unwrap_or_else(|| context.current_project_root.clone());
                (
                    CoreCliOperation::RepairExchange,
                    CoreCliAction::TextRoute {
                        path: text_route_path(CORE_API_ROUTES.repair_exchange_text, parsed.json),
                        body: Some(json!({ "projectRoot": project_root })),
                    },
                    CoreCliFallback::None,
                )
            } else {
                let project_root = parsed
                    .project_root
                    .as_deref()
                    .map(&resolve_project_root)
                    .unwrap_or_else(|| context.current_project_root.clone());
                (
                    CoreCliOperation::Repair,
                    CoreCliAction::TextRoute {
                        path: text_route_path(CORE_API_ROUTES.repair_text, parsed.json),
                        body: Some(json!({ "projectRoot": project_root, "open": parsed.open })),
                    },
                    CoreCliFallback::None,
                )
            }
        }
        ("logs", _) => {
            let parsed = parse_core_logs_args(&args).expect("eligible logs command must parse");
            let fallback = if parsed.subcommand == CoreLogsSubcommand::Tail {
                CoreCliFallback::EmptyLogTail
            } else {
                CoreCliFallback::None
            };
            (
                CoreCliOperation::Logs,
                CoreCliAction::Logs(parsed),
                fallback,
            )
        }
        ("projects", "") | ("projects", "list") => (
            CoreCliOperation::ProjectsList,
            command_action(default_call(CORE_COMMAND_NAMES.projects_list, None)),
            CoreCliFallback::None,
        ),
        ("projects", "remove" | "unregister") => {
            let parsed = parse_core_projects_remove_args(&args)
                .expect("eligible projects remove must parse");
            let project_root = resolve_project_root(&parsed.project);
            (
                CoreCliOperation::ProjectsRemove,
                CoreCliAction::TextRoute {
                    path: project_remove_text_path(
                        CORE_API_ROUTES.projects_remove_text,
                        &project_root,
                        parsed.force,
                        parsed.json,
                    ),
                    body: None,
                },
                CoreCliFallback::None,
            )
        }
        ("remote", "status") => {
            let relay_request = (context.has_credentials && context.daemon_running)
                .then(|| existing_daemon_call(CORE_COMMAND_NAMES.relay_status));
            (
                CoreCliOperation::RemoteStatus,
                CoreCliAction::RemoteStatus { relay_request },
                CoreCliFallback::RelayOff,
            )
        }
        ("remote", "enable") => {
            let relay_request = context
                .has_credentials
                .then(|| default_call(CORE_COMMAND_NAMES.relay_enable, None));
            (
                CoreCliOperation::RemoteEnable,
                CoreCliAction::RemoteEnable { relay_request },
                if context.has_credentials {
                    CoreCliFallback::None
                } else {
                    CoreCliFallback::NotLoggedIn
                },
            )
        }
        ("remote", "disable") => {
            let relay_request = context
                .daemon_running
                .then(|| existing_daemon_call(CORE_COMMAND_NAMES.relay_disable));
            (
                CoreCliOperation::RemoteDisable,
                CoreCliAction::RemoteDisable { relay_request },
                if context.daemon_running {
                    CoreCliFallback::None
                } else {
                    CoreCliFallback::DisableRemoteLocally
                },
            )
        }
        ("whoami", _) => (
            CoreCliOperation::Whoami,
            CoreCliAction::Whoami,
            CoreCliFallback::None,
        ),
        ("logout", _) => (
            CoreCliOperation::Logout,
            CoreCliAction::Logout {
                relay_disable: context
                    .daemon_running
                    .then(|| existing_daemon_call(CORE_COMMAND_NAMES.relay_disable)),
            },
            if context.daemon_running {
                CoreCliFallback::IgnoreRelayDisableFailure
            } else {
                CoreCliFallback::None
            },
        ),
        ("login", _) | ("security", "unlock") => {
            let security_unlock = command == "security";
            let relay_enable = context
                .daemon_running
                .then(|| existing_daemon_call(CORE_COMMAND_NAMES.relay_enable));
            (
                if security_unlock {
                    CoreCliOperation::SecurityUnlock
                } else {
                    CoreCliOperation::Login
                },
                CoreCliAction::Login {
                    security_unlock,
                    relay_enable,
                },
                if context.daemon_running {
                    CoreCliFallback::RelayDisconnected
                } else {
                    CoreCliFallback::RelayDeferredUntilDaemonStart
                },
            )
        }
        ("security", "devices") if args[2..].iter().all(|arg| arg == "--json") => (
            CoreCliOperation::SecurityDevices,
            CoreCliAction::SecurityDevices {
                json: args[2..].iter().any(|arg| arg == "--json"),
            },
            CoreCliFallback::None,
        ),
        ("security", "device") if args.get(2).map(String::as_str) == Some("approve") => {
            let parsed = parse_security_device_approve_live_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid security device approve arguments",
                }
            })?;
            (
                CoreCliOperation::SecurityDeviceApprove,
                CoreCliAction::SecurityDeviceApproveLive {
                    device_id: parsed.device_id,
                    json: parsed.json,
                },
                CoreCliFallback::None,
            )
        }
        ("security", "approve" | "block" | "revoke" | "unblock") => {
            let parsed = parse_security_device_update_args(&args).ok_or_else(|| {
                CoreCliPlanError::InvalidArguments {
                    args: args.clone(),
                    message: "error: invalid security device arguments",
                }
            })?;
            (
                match parsed.action {
                    "approve" => CoreCliOperation::SecurityDeviceApprove,
                    "block" | "revoke" => CoreCliOperation::SecurityDeviceBlock,
                    "unblock" => CoreCliOperation::SecurityDeviceUnblock,
                    _ => unreachable!("validated security action"),
                },
                CoreCliAction::SecurityDeviceUpdate {
                    device_id: parsed.device_id,
                    action: if parsed.action == "revoke" {
                        "block"
                    } else {
                        parsed.action
                    },
                    approval_code: parsed.approval_code,
                    json: parsed.json,
                },
                CoreCliFallback::None,
            )
        }
        _ => return Err(CoreCliPlanError::Unsupported { args }),
    };

    Ok(CoreCliPlan {
        args,
        operation,
        output_mode: mode,
        action,
        fallback,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SecurityDeviceApproveLiveArgs {
    device_id: Option<String>,
    json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SecurityDeviceUpdateArgs {
    device_id: String,
    action: &'static str,
    approval_code: Option<String>,
    json: bool,
}

fn parse_security_device_approve_live_args(
    args: &[String],
) -> Option<SecurityDeviceApproveLiveArgs> {
    let mut device_id = None;
    let mut json = false;
    let mut index = 3;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--json" {
            json = true;
            index += 1;
        } else if device_id.is_none() && !arg.starts_with('-') {
            device_id = Some(arg.to_owned());
            index += 1;
        } else {
            return None;
        }
    }
    Some(SecurityDeviceApproveLiveArgs { device_id, json })
}

fn parse_security_device_update_args(args: &[String]) -> Option<SecurityDeviceUpdateArgs> {
    let action = match args.get(1)?.as_str() {
        "approve" => "approve",
        "block" => "block",
        "revoke" => "revoke",
        "unblock" => "unblock",
        _ => return None,
    };
    let mut device_id = None;
    let mut approval_code = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--json" {
            json = true;
            index += 1;
        } else if action == "approve" && arg == "--code" {
            let value = args.get(index + 1)?;
            if value.starts_with('-') {
                return None;
            }
            approval_code = Some(value.clone());
            index += 2;
        } else if action == "approve"
            && let Some(value) = arg.strip_prefix("--code=")
        {
            if value.is_empty() {
                return None;
            }
            approval_code = Some(value.to_owned());
            index += 1;
        } else if device_id.is_none() && !arg.starts_with('-') {
            device_id = Some(arg.to_owned());
            index += 1;
        } else {
            return None;
        }
    }
    Some(SecurityDeviceUpdateArgs {
        device_id: device_id?,
        action,
        approval_code,
        json,
    })
}

fn json_without_null_fields(value: Value) -> Value {
    let Value::Object(fields) = value else {
        return value;
    };
    Value::Object(
        fields
            .into_iter()
            .filter(|(_, value)| !value.is_null())
            .collect::<Map<_, _>>(),
    )
}
