use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreProjectEnsureArgs {
    pub project: String,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAgentPsArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAgentInputArgs {
    pub session_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAgentRenameArgs {
    pub session_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAgentMigrateArgs {
    pub session_id: String,
    pub worktree: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreLifecycleStatusArgs {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreLifecycleSpawnArgs {
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub open: bool,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreLifecycleForkArgs {
    pub source_session_id: String,
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub open: bool,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreLoopMutationArgs {
    pub subcommand: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreLoopExitArgs {
    pub subcommand: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoreLogsSubcommand {
    Clear,
    Path,
    Tail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreLogsArgs {
    pub daemon: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub subcommand: CoreLogsSubcommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRestartArgs {
    pub json: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreDaemonRestartArgs {
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreHostRestartArgs {
    pub open: bool,
    pub serve: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreHostAgentReadArgs {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub start_line: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreHostAgentReadArgsError {
    InvalidArguments,
    LinesNotPositive,
    StartLineNotInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreHostAgentStreamArgs {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub start_line: i64,
    pub interval_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreHostAgentStreamArgsError {
    InvalidArguments,
    LinesNotPositive,
    StartLineNotInteger,
    IntervalMsInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreDashboardReloadArgs {
    pub open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_tty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_client_session: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRuntimeRestartArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
    pub open: bool,
    pub json: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_tty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_client_session: Option<String>,
}
