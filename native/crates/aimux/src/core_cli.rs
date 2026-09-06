use crate::core_cli_routing::{
    CoreHostAgentReadArgsError, CoreHostAgentStreamArgsError, CoreHostRestartArgs, CoreLogsArgs,
    CoreLogsSubcommand, core_command_args, is_core_cli_command, parse_core_agent_input_args,
    parse_core_agent_migrate_args, parse_core_agent_ps_args, parse_core_agent_rename_args,
    parse_core_attachment_publish_args, parse_core_collaboration_args,
    parse_core_daemon_restart_args, parse_core_dashboard_reload_args, parse_core_doctor_args,
    parse_core_graveyard_args, parse_core_host_agent_read_args_result,
    parse_core_host_agent_stream_args_result, parse_core_host_restart_args,
    parse_core_host_topology_args, parse_core_lifecycle_fork_args, parse_core_lifecycle_spawn_args,
    parse_core_lifecycle_status_args, parse_core_logs_args, parse_core_loop_exit_args,
    parse_core_loop_mutation_args, parse_core_metadata_args, parse_core_notification_args,
    parse_core_outline_args, parse_core_overseer_clear_args, parse_core_overseer_start_args,
    parse_core_project_ensure_args, parse_core_repair_args, parse_core_restart_args,
    parse_core_runtime_restart_args, parse_core_scribe_clear_args, parse_core_scribe_start_args,
    parse_core_task_args, parse_core_team_args, parse_core_thread_args, parse_core_worktree_args,
};
use crate::core_command_contract::{CORE_API_ROUTES, CORE_COMMAND_NAMES, is_core_command_name};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};

pub const CORE_DIAGNOSTIC_TIMEOUT_MS: u64 = 1_000;

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
    AgentRename,
    AgentMigrate,
    AgentPs,
    LifecycleSpawn,
    LifecycleStop,
    LifecycleKill,
    LifecycleFork,
    LoopAdd,
    LoopRemove,
    LoopDone,
    LoopBlock,
    OverseerStart,
    OverseerClear,
    ScribeStart,
    ScribeClear,
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
    TaskComplete,
    TaskReopen,
    ReviewApprove,
    ReviewRequestChanges,
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
    DashboardReload,
    RuntimeRestart,
    ProjectServe,
    HostStop,
    HostKill,
    HostRestart,
    HostTopology,
    DaemonEnsure,
    DaemonRestart,
    DaemonStatus,
    DaemonProjects,
    DaemonProjectEnsure,
    DoctorVersions,
    Logs,
    ProjectsList,
    Restart,
    RemoteStatus,
    RemoteEnable,
    RemoteDisable,
    Whoami,
    Logout,
    Login,
    SecurityUnlock,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandRequestOptions {
    pub ensure_daemon: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl Default for CoreCommandRequestOptions {
    fn default() -> Self {
        Self {
            ensure_daemon: true,
            timeout_ms: None,
        }
    }
}

impl CoreCommandRequestOptions {
    fn existing_daemon() -> Self {
        Self {
            ensure_daemon: false,
            timeout_ms: Some(CORE_DIAGNOSTIC_TIMEOUT_MS),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

impl CoreCommandEnvelope {
    pub fn new(command: impl Into<String>, payload: Option<Value>) -> Self {
        Self {
            id: None,
            command: command.into(),
            payload,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum CoreHttpMethod {
    Post,
}

impl CoreHttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Post => "POST",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreCommandTransportRequest {
    pub route: &'static str,
    pub method: CoreHttpMethod,
    pub headers: BTreeMap<String, String>,
    pub body: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoreCommandCall {
    pub command: &'static str,
    pub payload: Option<Value>,
    pub options: CoreCommandRequestOptions,
}

impl CoreCommandCall {
    pub fn transport_request(&self) -> Result<CoreCommandTransportRequest, serde_json::Error> {
        build_core_command_transport_request(
            self.command,
            self.payload.clone(),
            self.options.timeout_ms,
        )
    }
}

pub fn build_core_command_transport_request(
    command: &str,
    payload: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<CoreCommandTransportRequest, serde_json::Error> {
    let body = serde_json::to_string(&CoreCommandEnvelope::new(command, payload))?;
    Ok(CoreCommandTransportRequest {
        route: CORE_API_ROUTES.commands,
        method: CoreHttpMethod::Post,
        headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
        body,
        timeout_ms,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandOk {
    pub ok: bool,
    pub id: String,
    pub command: String,
    pub issued_at: String,
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandError {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CoreCommandResponse {
    Ok(CoreCommandOk),
    Error(CoreCommandError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreCommandResponseError {
    InvalidResponse(String),
    CommandError(String),
    CommandMismatch { expected: String, actual: String },
}

impl Display for CoreCommandResponseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidResponse(message) | Self::CommandError(message) => {
                formatter.write_str(message)
            }
            Self::CommandMismatch { expected, actual } => write!(
                formatter,
                "core command response mismatch: expected {expected}, got {actual}"
            ),
        }
    }
}

impl Error for CoreCommandResponseError {}

/// Mirrors the response checks in `sendCoreCommand` without performing I/O.
pub fn validate_core_command_response(
    expected_command: &str,
    response: Value,
) -> Result<CoreCommandOk, CoreCommandResponseError> {
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("invalid core command error response");
        return Err(CoreCommandResponseError::CommandError(message.to_owned()));
    }
    let parsed: CoreCommandOk = serde_json::from_value(response).map_err(|error| {
        CoreCommandResponseError::InvalidResponse(format!("invalid core command response: {error}"))
    })?;
    if parsed.command != expected_command {
        return Err(CoreCommandResponseError::CommandMismatch {
            expected: expected_command.to_owned(),
            actual: parsed.command,
        });
    }
    Ok(parsed)
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
    Logs(CoreLogsArgs),
    InitProject,
    HostTopology {
        json: bool,
        raw: bool,
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
    DebugState {
        target: String,
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

fn call(
    command: &'static str,
    payload: Option<Value>,
    options: CoreCommandRequestOptions,
) -> CoreCommandCall {
    debug_assert!(is_core_command_name(command));
    CoreCommandCall {
        command,
        payload,
        options,
    }
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

fn project_payload(project_root: String) -> Value {
    json!({ "projectRoot": project_root })
}

fn project_restart_payload(project_root: String, options: CoreHostRestartArgs) -> Value {
    json!({ "projectRoot": project_root, "serve": options.serve })
}

fn dashboard_reload_payload(
    project_root: String,
    args: &[String],
) -> Result<Value, CoreCliPlanError> {
    let parsed = parse_core_dashboard_reload_args(args).ok_or_else(|| {
        CoreCliPlanError::InvalidArguments {
            args: args.to_vec(),
            message: "error: invalid dashboard-reload arguments",
        }
    })?;
    Ok(dashboard_text_payload(
        project_root,
        parsed.open,
        parsed.client_tty,
        parsed.current_client_session,
    ))
}

fn runtime_restart_payload(
    current_project_root: String,
    args: &[String],
    resolve_project_root: impl Fn(&str) -> String,
) -> Result<(Value, bool), CoreCliPlanError> {
    let parsed = parse_core_runtime_restart_args(args).ok_or_else(|| {
        CoreCliPlanError::InvalidArguments {
            args: args.to_vec(),
            message: "error: invalid restart-runtime arguments",
        }
    })?;
    if parsed.open && parsed.json {
        return Err(CoreCliPlanError::InvalidArguments {
            args: args.to_vec(),
            message: "Error: restart-runtime --open cannot be combined with --json",
        });
    }
    let project_root = parsed
        .project_root
        .as_deref()
        .map(resolve_project_root)
        .unwrap_or(current_project_root);
    Ok((
        dashboard_text_payload(
            project_root,
            parsed.open,
            parsed.client_tty,
            parsed.current_client_session,
        ),
        parsed.json,
    ))
}

fn dashboard_text_payload(
    project_root: String,
    open: bool,
    client_tty: Option<String>,
    current_client_session: Option<String>,
) -> Value {
    let mut payload = serde_json::Map::from_iter([("projectRoot".to_owned(), json!(project_root))]);
    if open {
        payload.insert("open".into(), Value::Bool(true));
    }
    if let Some(client_tty) = client_tty {
        payload.insert("clientTty".into(), Value::String(client_tty));
    }
    if let Some(current_client_session) = current_client_session {
        payload.insert(
            "currentClientSession".into(),
            Value::String(current_client_session),
        );
    }
    Value::Object(payload)
}

fn host_agent_read_text_path(project: &str, session_id: &str, start_line: i64) -> String {
    format!(
        "{}?project={}&sessionId={}&startLine={}",
        CORE_API_ROUTES.host_agent_read_text,
        encode_query_component(project),
        encode_query_component(session_id),
        start_line
    )
}

fn host_agent_stream_text_path(
    project: &str,
    session_id: &str,
    start_line: i64,
    interval_ms: i64,
) -> String {
    format!(
        "{}?project={}&sessionId={}&startLine={}&intervalMs={}",
        CORE_API_ROUTES.host_agent_stream_text,
        encode_query_component(project),
        encode_query_component(session_id),
        start_line,
        interval_ms
    )
}

fn agent_ps_text_path(project: &str, json: bool) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.agent_ps_text,
        encode_query_component(project)
    );
    if json {
        path.push_str("&json=1");
    }
    path
}

fn notification_list_text_path(
    project: &str,
    unread: bool,
    session_id: Option<&str>,
    json: bool,
) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.notification_list_text,
        encode_query_component(project)
    );
    if unread {
        path.push_str("&unread=1");
    }
    if let Some(session_id) = session_id {
        path.push_str("&sessionId=");
        path.push_str(&encode_query_component(session_id));
    }
    if json {
        path.push_str("&json=1");
    }
    path
}

struct OutlineListTextPathArgs<'a> {
    project: &'a str,
    entry_id: Option<&'a str>,
    session: Option<&'a str>,
    worktree: Option<&'a str>,
    status: Option<&'a str>,
    search: Option<&'a str>,
    limit: Option<&'a str>,
    json: bool,
}

fn outline_list_text_path(args: OutlineListTextPathArgs<'_>) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.outline_list_text,
        encode_query_component(args.project)
    );
    if let Some(entry_id) = args.entry_id {
        push_text_query(&mut path, "entryId", entry_id);
    }
    if let Some(session) = args.session {
        push_text_query(&mut path, "session", session);
    }
    if let Some(worktree) = args.worktree {
        push_text_query(&mut path, "worktree", worktree);
    }
    if let Some(status) = args.status {
        push_text_query(&mut path, "status", status);
    }
    if let Some(search) = args.search {
        push_text_query(&mut path, "search", search);
    }
    if let Some(limit) = args.limit {
        push_text_query(&mut path, "limit", limit);
    }
    if args.json {
        push_text_query(&mut path, "json", "1");
    }
    path
}

fn task_list_text_path(
    project: &str,
    session: Option<&str>,
    status: Option<&str>,
    json: bool,
) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.task_list_text,
        encode_query_component(project)
    );
    if let Some(session) = session {
        path.push_str("&session=");
        path.push_str(&encode_query_component(session));
    }
    if let Some(status) = status {
        path.push_str("&status=");
        path.push_str(&encode_query_component(status));
    }
    if json {
        path.push_str("&json=1");
    }
    path
}

fn task_show_text_path(project: &str, task_id: &str, json: bool) -> String {
    let mut path = format!(
        "{}?project={}&taskId={}",
        CORE_API_ROUTES.task_show_text,
        encode_query_component(project),
        encode_query_component(task_id)
    );
    if json {
        path.push_str("&json=1");
    }
    path
}

fn thread_list_text_path(project: &str, session: Option<&str>, json: bool) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.thread_list_text,
        encode_query_component(project)
    );
    if let Some(session) = session {
        path.push_str("&session=");
        path.push_str(&encode_query_component(session));
    }
    if json {
        path.push_str("&json=1");
    }
    path
}

fn thread_show_text_path(project: &str, thread_id: &str, json: bool) -> String {
    let mut path = format!(
        "{}?project={}&threadId={}",
        CORE_API_ROUTES.thread_show_text,
        encode_query_component(project),
        encode_query_component(thread_id)
    );
    if json {
        path.push_str("&json=1");
    }
    path
}

fn project_text_path(base: &str, project: &str, json: bool) -> String {
    let mut path = format!("{base}?project={}", encode_query_component(project));
    if json {
        path.push_str("&json=1");
    }
    path
}

fn text_route_path(path: &str, json: bool) -> String {
    if json {
        format!("{path}?json=1")
    } else {
        path.to_owned()
    }
}

fn metadata_text_path(project: &str, args: &[String]) -> String {
    let mut path = format!(
        "{}?project={}",
        CORE_API_ROUTES.metadata_text,
        encode_query_component(project)
    );
    for arg in args {
        path.push_str("&arg=");
        path.push_str(&encode_query_component(arg));
    }
    path
}

fn resolve_cwd_path(cwd: &str, path: &str) -> String {
    let path = PathBuf::from(path);
    let resolved = if path.is_absolute() {
        path
    } else {
        Path::new(cwd).join(path)
    };
    normalize_path_syntax(resolved)
        .to_string_lossy()
        .into_owned()
}

fn normalize_path_syntax(path: PathBuf) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                output.pop();
            }
            _ => output.push(component.as_os_str()),
        }
    }
    output
}

fn push_text_query(path: &mut String, name: &str, value: &str) {
    if path.contains('?') {
        path.push('&');
    } else {
        path.push('?');
    }
    path.push_str(name);
    path.push('=');
    path.push_str(&encode_query_component(value));
}

fn doctor_disk_text_path(project: Option<&str>, include_active: bool, json: bool) -> String {
    let mut path = CORE_API_ROUTES.doctor_disk_text.to_owned();
    if let Some(project) = project {
        push_text_query(&mut path, "project", project);
    }
    if include_active {
        push_text_query(&mut path, "includeActive", "1");
    }
    if json {
        push_text_query(&mut path, "json", "1");
    }
    path
}

fn doctor_project_text_path(route: &str, project_root: &str, json: bool) -> String {
    let mut path = route.to_owned();
    push_text_query(&mut path, "projectRoot", project_root);
    if json {
        push_text_query(&mut path, "json", "1");
    }
    path
}

fn doctor_tmux_text_path(
    project_root: &str,
    session: Option<&str>,
    window_id: Option<&str>,
    json: bool,
) -> String {
    let mut path = CORE_API_ROUTES.doctor_tmux_text.to_owned();
    push_text_query(&mut path, "projectRoot", project_root);
    if let Some(session) = session {
        push_text_query(&mut path, "session", session);
    }
    if let Some(window_id) = window_id {
        push_text_query(&mut path, "windowId", window_id);
    }
    if json {
        push_text_query(&mut path, "json", "1");
    }
    path
}

fn loop_actor_payload(
    actor: &CoreLoopActorContext,
    default_source: &str,
) -> serde_json::Map<String, Value> {
    let Some(session_id) = actor.session_id.clone() else {
        return serde_json::Map::from_iter([(
            "source".into(),
            Value::String(default_source.to_owned()),
        )]);
    };
    let source = if actor.overseer { "overseer" } else { "agent" };
    let mut payload = serde_json::Map::from_iter([
        ("source".into(), Value::String(source.into())),
        ("updatedBy".into(), Value::String(session_id.clone())),
        ("updatedBySessionId".into(), Value::String(session_id)),
    ]);
    if actor.overseer {
        payload.insert("updatedByRole".into(), Value::String("overseer".into()));
    } else if let Some(tool) = actor.tool.as_ref() {
        payload.insert("updatedByRole".into(), Value::String(tool.clone()));
    }
    payload
}

fn encode_query_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char);
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
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
    if !is_core_cli_command(&args) {
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
            (
                CoreCliOperation::LifecycleSpawn,
                CoreCliAction::TextRoute {
                    path: text_route_path(CORE_API_ROUTES.lifecycle_spawn_text, parsed.json),
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
        ("stop", _) => {
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
                    body: Some(json!({
                        "project": project_root,
                        "sourceSessionId": parsed.source_session_id,
                        "tool": parsed.tool,
                        "instruction": parsed.instruction,
                        "worktreePath": parsed.worktree,
                        "open": parsed.open,
                    })),
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
        ("task", "list" | "show" | "assign" | "accept" | "block" | "complete" | "reopen")
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
        ("thread", "list" | "show" | "open" | "send" | "mark-seen" | "status") => {
            let parsed = parse_core_thread_args(&args).ok_or_else(|| {
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
            "list" | "create" | "cleanup-caches" | "remove" | "graveyard" | "resurrect"
            | "delete-graveyard",
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
        ("graveyard", "list" | "send" | "resurrect" | "cleanup") => {
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
        ("dashboard-reload", _) => (
            CoreCliOperation::DashboardReload,
            CoreCliAction::TextRoute {
                path: CORE_API_ROUTES.dashboard_reload_text.to_owned(),
                body: Some(dashboard_reload_payload(
                    context.current_project_root.clone(),
                    &args,
                )?),
            },
            CoreCliFallback::None,
        ),
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
        ("host", "stop") => (
            CoreCliOperation::HostStop,
            command_action(default_call(
                CORE_COMMAND_NAMES.project_stop,
                Some(project_payload(context.current_project_root.clone())),
            )),
            CoreCliFallback::None,
        ),
        ("host", "kill") => (
            CoreCliOperation::HostKill,
            command_action(default_call(
                CORE_COMMAND_NAMES.project_kill,
                Some(project_payload(context.current_project_root.clone())),
            )),
            CoreCliFallback::None,
        ),
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
        ("doctor", "disk" | "exchange" | "lifecycle" | "tmux") => {
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
        ("projects", "list") => (
            CoreCliOperation::ProjectsList,
            command_action(default_call(CORE_COMMAND_NAMES.projects_list, None)),
            CoreCliFallback::None,
        ),
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
