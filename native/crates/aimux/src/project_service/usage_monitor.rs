use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent_token_spend::{
    BASELINE_JUST_TAKEN, CODEX_TAIL_BYTES, SpendBaseline, SpendSinceBaseline,
    read_tail_window_lossy, try_spend_for_session,
};
use crate::atomic_write::write_json_atomic;
use crate::config::{merge_config_layers, project_config_path_for_known_root};
use crate::daemon_state::metadata_state_path;
use crate::paths::PathResolver;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture};
use super::usage_model::{
    CLAUDE_STATUSLINE_SOURCE, CODEX_RATE_LIMIT_SOURCE, UsageQuotaObservation, UsageState,
    claude_statusline_usage, codex_rate_limit_usage,
};

pub const USAGE_MONITOR_TASK_NAME: &str = "usage-monitor";
pub const USAGE_MONITOR_INTERVAL_MS: i64 = 300_000;
const STATE_VERSION: u8 = 1;
const TOKEN_SCOPE: &str = "billed-equivalent tokens since monitoring started";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub state: UsageState,
    pub observed_at: i64,
    pub started_at: i64,
    pub collection_interval_ms: i64,
    pub tools: Vec<UsageToolSummary>,
    pub display_lines: Vec<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageToolSummary {
    pub tool: String,
    pub label: String,
    pub token_spend: UsageTokenSummary,
    pub quota_sources: Vec<UsageSourceSummary>,
    pub display_lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokenSummary {
    pub state: UsageState,
    pub billed_tokens: Option<u64>,
    pub since: i64,
    pub measured_sessions: usize,
    pub unmeasured_sessions: usize,
    pub error_sessions: usize,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceSummary {
    pub session_id: Option<String>,
    pub observation: UsageQuotaObservation,
}

impl Default for UsageSnapshot {
    fn default() -> Self {
        Self {
            state: UsageState::Absent,
            observed_at: 0,
            started_at: 0,
            collection_interval_ms: USAGE_MONITOR_INTERVAL_MS,
            tools: Vec::new(),
            display_lines: vec![
                "Usage unknown: monitoring has not collected a snapshot yet".to_owned(),
            ],
            reason: Some("monitoring has not collected a snapshot yet".to_owned()),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct UsageMonitorCache {
    snapshot: Arc<Mutex<UsageSnapshot>>,
    collection: Arc<Mutex<()>>,
}

impl UsageMonitorCache {
    pub fn read(&self) -> Result<UsageSnapshot, String> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| "usage-monitor snapshot cache lock poisoned".to_owned())
    }

    pub fn publish(&self, snapshot: UsageSnapshot) -> Result<(), String> {
        *self
            .snapshot
            .lock()
            .map_err(|_| "usage-monitor snapshot cache lock poisoned".to_owned())? = snapshot;
        Ok(())
    }

    fn publish_error(&self, now: i64, reason: &str) -> Result<(), String> {
        let mut snapshot = self.read()?;
        snapshot.state = UsageState::Error;
        snapshot.observed_at = now;
        snapshot.reason = Some(reason.to_owned());
        snapshot
            .display_lines
            .retain(|line| !line.starts_with("Usage collection error:"));
        snapshot
            .display_lines
            .insert(0, format!("Usage collection error: {reason}"));
        self.publish(snapshot)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonitorState {
    version: u8,
    started_at: i64,
    sessions: BTreeMap<String, SessionSpend>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSpend {
    session_id: String,
    tool: String,
    runtime: String,
    backend_session_id: Option<String>,
    canonical_transcript: Option<String>,
    baseline: SpendBaseline,
    billed_tokens: u64,
    tool_totals: BTreeMap<String, u64>,
    state: UsageState,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeQuotaStore {
    version: u8,
    sessions: BTreeMap<String, UsageQuotaObservation>,
}

pub fn usage_monitor_state_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("usage-monitor.json")
}

pub fn claude_quota_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("usage-claude-quotas.json")
}

pub fn usage_monitor_task(context: &Arc<ProjectServiceRequestContext>) -> Box<dyn PeriodicTask> {
    Box::new(UsageMonitorTask {
        context: Arc::clone(context),
    })
}

struct UsageMonitorTask {
    context: Arc<ProjectServiceRequestContext>,
}

impl PeriodicTask for UsageMonitorTask {
    fn name(&self) -> &str {
        USAGE_MONITOR_TASK_NAME
    }
    fn interval_ms(&self) -> i64 {
        USAGE_MONITOR_INTERVAL_MS
    }
    fn run_immediately(&self) -> bool {
        true
    }
    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        let context = Arc::clone(&self.context);
        Box::pin(async move {
            let failure_context = Arc::clone(&context);
            let now = time::OffsetDateTime::now_utc().unix_timestamp();
            let snapshot = tokio::task::spawn_blocking(move || collect_usage(&context, now))
                .await
                .map_err(|error| {
                    let reason = format!("usage-monitor blocking collector failed: {error}");
                    if let Err(cache_error) =
                        failure_context.usage_monitor.publish_error(now, &reason)
                    {
                        return format!("{reason}; {cache_error}");
                    }
                    reason
                })??;
            if snapshot.state == UsageState::Error {
                return Err(snapshot
                    .reason
                    .unwrap_or_else(|| "usage-monitor source collection failed".to_owned()));
            }
            Ok(())
        })
    }
}

pub fn route_usage_monitor_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if method.eq_ignore_ascii_case("GET") && pathname == "/usage" {
        if path
            .split_once('?')
            .is_some_and(|(_, query)| query.split('&').any(|item| item == "refresh=1"))
        {
            context
                .scheduler
                .force_task_next_tick(USAGE_MONITOR_TASK_NAME);
        }
        return Some(match context.usage_monitor.read() {
            Ok(snapshot) => {
                let mut body = json!(snapshot);
                body["ok"] = Value::Bool(true);
                ProjectServiceDispatchResponse::json(200, body)
            }
            Err(reason) => ProjectServiceDispatchResponse::json(
                500,
                json!({"ok":false,"state":"error","error":reason}),
            ),
        });
    }
    if method.eq_ignore_ascii_case("POST") && pathname == "/usage/claude/statusline" {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        return Some(match store_claude_quota(context, body, now) {
            Ok(changed) => {
                if changed {
                    context
                        .scheduler
                        .force_task_next_tick(USAGE_MONITOR_TASK_NAME);
                }
                ProjectServiceDispatchResponse::json(200, json!({"ok":true,"changed":changed}))
            }
            Err((status, reason)) => {
                let reason = if status >= 500 {
                    let reason = format!("Claude statusline quota ingestion failed: {reason}");
                    let result = context.usage_monitor.publish_error(now, &reason);
                    context
                        .visual_clients
                        .schedule_project_refresh(context.project_root());
                    context.project_events.publish_project_update(
                        context.project_root(),
                        vec!["desktop-state"],
                        USAGE_MONITOR_TASK_NAME.to_owned(),
                        None,
                        None,
                    );
                    match result {
                        Ok(()) => reason,
                        Err(cache_error) => format!("{reason}; {cache_error}"),
                    }
                } else {
                    reason
                };
                ProjectServiceDispatchResponse::json(status, json!({"ok":false,"error":reason}))
            }
        });
    }
    None
}

fn store_claude_quota(
    context: &ProjectServiceRequestContext,
    body: Option<&Value>,
    now: i64,
) -> Result<bool, (u16, String)> {
    let body = body
        .and_then(Value::as_object)
        .ok_or_else(|| (400, "Claude statusline body must be an object".to_owned()))?;
    let session_id = body
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| (400, "sessionId is required".to_owned()))?;
    let observation = match body.get("collectorError") {
        Some(error) => {
            let error = error
                .as_str()
                .filter(|reason| !reason.trim().is_empty() && reason.len() <= 1024)
                .ok_or_else(|| {
                    (
                        400,
                        "collectorError must be a nonempty string of at most 1024 bytes".to_owned(),
                    )
                })?;
            UsageQuotaObservation::error(CLAUDE_STATUSLINE_SOURCE, now, error)
        }
        None => {
            let limits = body
                .get("rateLimits")
                .ok_or_else(|| (400, "rateLimits is required (object or null)".to_owned()))?;
            claude_statusline_usage(&json!({"rate_limits":limits}), now)
                .map_err(|reason| (400, reason))?
        }
    };
    let _guard = context
        .usage_monitor
        .collection
        .lock()
        .map_err(|_| (500, "usage-monitor collection lock poisoned".to_owned()))?;
    let metadata = read_metadata(context).map_err(|reason| (500, reason))?;
    let session = metadata
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get(session_id))
        .ok_or_else(|| (404, format!("unknown metadata session {session_id}")))?;
    let config = read_config(context).map_err(|reason| (500, reason))?;
    let topology = read_runtime_topology(runtime_topology_path(context.project_state_dir()))
        .map_err(|reason| (500, reason))?;
    let topology_session = topology
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        })
        .unwrap_or(&Value::Null);
    let tool_key = session_tool(session)
        .or_else(|| session_tool(topology_session))
        .unwrap_or("unknown");
    if session_runtime(tool_key, Some(session), topology_session, &config) != "claude" {
        return Err((400, format!("session {session_id} is not a Claude runtime")));
    }
    let path = claude_quota_path(context.project_state_dir());
    let mut store = load_claude_quotas(&path).map_err(|reason| (500, reason))?;
    let changed = store.sessions.get(session_id).is_none_or(|previous| {
        previous.state != observation.state
            || previous.source != observation.source
            || previous.windows != observation.windows
            || previous.reason != observation.reason
    });
    store.sessions.insert(session_id.to_owned(), observation);
    write_json_atomic(&path, &store).map_err(|error| {
        (
            500,
            format!("write Claude statusline quota {}: {error}", path.display()),
        )
    })?;
    Ok(changed)
}

pub fn collect_usage(
    context: &ProjectServiceRequestContext,
    now: i64,
) -> Result<UsageSnapshot, String> {
    let outcome = (|| {
        let _guard = context
            .usage_monitor
            .collection
            .lock()
            .map_err(|_| "usage-monitor collection lock poisoned".to_owned())?;
        collect_usage_inner(context, now)
    })();
    match outcome {
        Ok(snapshot) => {
            context.usage_monitor.publish(snapshot.clone())?;
            context
                .visual_clients
                .schedule_project_refresh(context.project_root());
            context.project_events.publish_project_update(
                context.project_root(),
                vec!["desktop-state"],
                USAGE_MONITOR_TASK_NAME.to_owned(),
                None,
                None,
            );
            Ok(snapshot)
        }
        Err(reason) => {
            context
                .usage_monitor
                .publish_error(now, &reason)
                .map_err(|cache_error| format!("{reason}; {cache_error}"))?;
            context
                .visual_clients
                .schedule_project_refresh(context.project_root());
            context.project_events.publish_project_update(
                context.project_root(),
                vec!["desktop-state"],
                USAGE_MONITOR_TASK_NAME.to_owned(),
                None,
                None,
            );
            Err(reason)
        }
    }
}

fn collect_usage_inner(
    context: &ProjectServiceRequestContext,
    now: i64,
) -> Result<UsageSnapshot, String> {
    let state_dir = context.project_state_dir();
    let state_path = usage_monitor_state_path(&state_dir);
    let mut state = load_monitor_state(&state_path, now)?;
    let topology_path = runtime_topology_path(&state_dir);
    let topology = read_runtime_topology(&topology_path).map_err(|error| {
        format!(
            "read usage-monitor topology {}: {error}",
            topology_path.display()
        )
    })?;
    let metadata = read_metadata(context)?;
    let metadata_sessions = metadata
        .get("sessions")
        .and_then(Value::as_object)
        .ok_or_else(|| "usage-monitor metadata.sessions must be an object".to_owned())?;
    let config = read_config(context)?;
    let mut tools: BTreeSet<String> = config
        .get("tools")
        .and_then(Value::as_object)
        .ok_or_else(|| "usage-monitor config.tools must be an object".to_owned())?
        .keys()
        .cloned()
        .collect();
    let claude_path = claude_quota_path(&state_dir);
    let claude_quotas = load_claude_quotas(&claude_path)?;
    let mut quota_sources: BTreeMap<String, Vec<UsageSourceSummary>> = BTreeMap::new();
    let mut sessions = list_topology_session_states(&topology, None);
    sessions.sort_by_key(|session| {
        !matches!(
            session.get("status").and_then(Value::as_str),
            Some("running" | "idle" | "starting")
        )
    });
    let mut seen_sources = BTreeSet::new();
    let mut seen_transcripts = BTreeSet::new();
    for session in sessions {
        let id = session
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "usage-monitor topology session missing id".to_owned())?;
        let meta = metadata_sessions.get(id);
        let tool = meta
            .and_then(session_tool)
            .or_else(|| session_tool(&session))
            .ok_or_else(|| format!("usage-monitor session {id} has no runtime tool identity"))?
            .to_owned();
        tools.insert(tool.clone());
        let raw_session = topology
            .get("sessions")
            .and_then(Value::as_array)
            .and_then(|sessions| {
                sessions
                    .iter()
                    .find(|session| session.get("id").and_then(Value::as_str) == Some(id))
            })
            .unwrap_or(&Value::Null);
        let runtime = session_runtime(&tool, meta, raw_session, &config);
        let transcript = meta
            .and_then(|meta| meta.get("context"))
            .and_then(|context| context.get("transcriptPath"))
            .and_then(Value::as_str)
            .map(Path::new);
        let backend_session_id = meta
            .and_then(|meta| meta.get("backendSessionId"))
            .or_else(|| session.get("backendSessionId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let canonical_transcript = transcript.map(canonical_transcript_identity).transpose()?;
        let source_identity = backend_session_id
            .as_deref()
            .map(|backend| ("backend", backend.to_owned()))
            .or_else(|| {
                canonical_transcript
                    .as_ref()
                    .map(|path| ("transcript", path.clone()))
            })
            .unwrap_or_else(|| ("session", id.to_owned()));
        let key = serde_json::to_string(&(&runtime, source_identity))
            .map_err(|error| format!("usage-monitor session key: {error}"))?;
        if !seen_sources.insert(key.clone())
            || canonical_transcript
                .as_ref()
                .is_some_and(|path| !seen_transcripts.insert((runtime.clone(), path.clone())))
        {
            continue;
        }
        if !state.sessions.contains_key(&key)
            && let Some(path) = &canonical_transcript
        {
            let previous = state
                .sessions
                .iter()
                .find(|(_, record)| {
                    record.runtime == runtime
                        && record.backend_session_id.is_none()
                        && record.canonical_transcript.as_ref() == Some(path)
                })
                .map(|(key, _)| key.clone());
            if let Some(previous) = previous
                && let Some(record) = state.sessions.remove(&previous)
            {
                state.sessions.insert(key.clone(), record);
            }
        }
        let spend = state.sessions.entry(key).or_insert_with(|| SessionSpend {
            session_id: id.to_owned(),
            tool: tool.clone(),
            runtime: runtime.clone(),
            backend_session_id: backend_session_id.clone(),
            canonical_transcript: canonical_transcript.clone(),
            baseline: SpendBaseline::default(),
            billed_tokens: 0,
            tool_totals: BTreeMap::new(),
            state: UsageState::Absent,
            reason: Some("measuring from now".to_owned()),
        });
        spend.session_id = id.to_owned();
        spend.tool = tool.clone();
        spend.canonical_transcript = canonical_transcript.clone();
        if spend.backend_session_id.is_some() && spend.backend_session_id != backend_session_id {
            spend.baseline = SpendBaseline::default();
        }
        spend.backend_session_id = backend_session_id;
        let prior_billed = spend.baseline.billed;
        match try_spend_for_session(
            &runtime,
            canonical_transcript.as_deref().map(Path::new),
            &mut spend.baseline,
        ) {
            Ok(SpendSinceBaseline::Measured(billed)) => {
                let delta = billed.saturating_sub(prior_billed);
                spend.billed_tokens = spend.billed_tokens.saturating_add(delta);
                let total = spend.tool_totals.entry(tool.clone()).or_default();
                *total = total.saturating_add(delta);
                spend.state = UsageState::Known;
                spend.reason = None;
            }
            Ok(SpendSinceBaseline::Unmeasured(reason)) => {
                if reason == BASELINE_JUST_TAKEN {
                    spend.baseline.billed = 0;
                }
                spend.state = UsageState::Absent;
                spend.reason = Some(reason.to_owned());
            }
            Err(reason) => {
                spend.state = UsageState::Error;
                spend.reason = Some(reason);
            }
        }
        let observations = match runtime.as_str() {
            "claude" => vec![claude_quotas.sessions.get(id).cloned().unwrap_or_else(|| {
                UsageQuotaObservation::absent(
                    CLAUDE_STATUSLINE_SOURCE,
                    now,
                    "Claude statusline has not reported quota windows",
                )
            })],
            "codex" => read_codex_quotas(transcript, now),
            _ => vec![UsageQuotaObservation::absent(
                "runtime",
                now,
                format!("{tool} does not report quota windows"),
            )],
        };
        quota_sources
            .entry(tool)
            .or_default()
            .extend(
                observations
                    .into_iter()
                    .map(|observation| UsageSourceSummary {
                        session_id: Some(id.to_owned()),
                        observation: expire_quota(observation, now),
                    }),
            );
    }
    tools.extend(state.sessions.values().map(|session| session.tool.clone()));
    tools.extend(
        state
            .sessions
            .values()
            .flat_map(|session| session.tool_totals.keys().cloned()),
    );
    write_json_atomic(&state_path, &state).map_err(|error| {
        format!(
            "write usage-monitor state {}: {error}",
            state_path.display()
        )
    })?;
    let mut result = UsageSnapshot {
        state: UsageState::Absent,
        observed_at: now,
        started_at: state.started_at,
        collection_interval_ms: USAGE_MONITOR_INTERVAL_MS,
        tools: Vec::new(),
        display_lines: Vec::new(),
        reason: None,
    };
    let mut errors = Vec::new();
    for tool in tools {
        let records: Vec<_> = state
            .sessions
            .values()
            .filter(|session| session.tool == tool || session.tool_totals.contains_key(&tool))
            .collect();
        let token_spend = summarize_tokens(&records, &tool, state.started_at);
        if token_spend.state == UsageState::Error {
            errors.push(format!(
                "{tool} token collection: {}",
                token_spend.reason.as_deref().unwrap_or("source failed")
            ));
        }
        let sources = quota_sources.remove(&tool).unwrap_or_else(|| {
            vec![UsageSourceSummary {
                session_id: None,
                observation: UsageQuotaObservation::absent(
                    "runtime",
                    now,
                    "no runtime quota observation available",
                ),
            }]
        });
        for source in &sources {
            if source.observation.state == UsageState::Error {
                errors.push(format!(
                    "{tool} quota collection: {}",
                    source
                        .observation
                        .reason
                        .as_deref()
                        .unwrap_or("source failed")
                ));
            }
        }
        let mut display_lines = vec![match token_spend.billed_tokens {
            Some(tokens) => format!("{tool}: {tokens} {TOKEN_SCOPE} ({})", state.started_at),
            None => format!(
                "{tool}: tokens unknown: {}",
                token_spend
                    .reason
                    .as_deref()
                    .unwrap_or("runtime has not reported usage")
            ),
        }];
        if token_spend.error_sessions > 0 {
            display_lines.push(format!(
                "{tool}: token collection error: {}",
                token_spend.reason.as_deref().unwrap_or("source failed")
            ));
        }
        for source in &sources {
            let identity = source.session_id.as_deref().unwrap_or("no session");
            display_lines.extend(
                source
                    .observation
                    .display_lines()
                    .into_iter()
                    .map(|line| format!("{tool} [{identity}]: {line}")),
            );
        }
        result.display_lines.extend(display_lines.clone());
        result.tools.push(UsageToolSummary {
            tool: tool.clone(),
            label: tool,
            token_spend,
            quota_sources: sources,
            display_lines,
        });
    }
    if !errors.is_empty() {
        result.state = UsageState::Error;
        result.reason = Some(errors.join("; "));
    } else if result.tools.iter().any(|tool| {
        tool.token_spend.state == UsageState::Known
            || tool
                .quota_sources
                .iter()
                .any(|source| source.observation.state == UsageState::Known)
    }) {
        result.state = UsageState::Known;
    } else {
        result.reason = Some("runtimes have not reported measured usage".to_owned());
    }
    Ok(result)
}

fn summarize_tokens(records: &[&SessionSpend], tool: &str, since: i64) -> UsageTokenSummary {
    let measured_sessions = records
        .iter()
        .filter(|session| session.tool == tool && session.state == UsageState::Known)
        .count();
    let error_sessions = records
        .iter()
        .filter(|session| session.tool == tool && session.state == UsageState::Error)
        .count();
    let unmeasured_sessions = records
        .iter()
        .filter(|session| session.tool == tool)
        .count()
        - measured_sessions
        - error_sessions;
    let total = records.iter().fold(0u64, |total, session| {
        total.saturating_add(session.tool_totals.get(tool).copied().unwrap_or(0))
    });
    let reason = records
        .iter()
        .filter(|session| session.tool == tool)
        .filter_map(|session| {
            session
                .reason
                .as_ref()
                .map(|reason| format!("{}: {reason}", session.session_id))
        })
        .collect::<Vec<_>>();
    UsageTokenSummary {
        state: if error_sessions > 0 {
            UsageState::Error
        } else if measured_sessions > 0 || total > 0 {
            UsageState::Known
        } else {
            UsageState::Absent
        },
        billed_tokens: (measured_sessions > 0 || total > 0).then_some(total),
        since,
        measured_sessions,
        unmeasured_sessions,
        error_sessions,
        reason: if reason.is_empty() {
            (records.is_empty()).then(|| "no observed runtime sessions".to_owned())
        } else {
            Some(reason.join("; "))
        },
    }
}

fn session_tool(session: &Value) -> Option<&str> {
    session
        .get("toolConfigKey")
        .and_then(Value::as_str)
        .or_else(|| {
            session
                .get("metadata")
                .and_then(|meta| meta.get("toolConfigKey"))
                .and_then(Value::as_str)
        })
        .or_else(|| session.get("tool").and_then(Value::as_str))
        .or_else(|| session.get("command").and_then(Value::as_str))
        .or_else(|| {
            session
                .get("metadata")
                .and_then(|meta| meta.get("command"))
                .and_then(Value::as_str)
        })
        .filter(|tool| !tool.trim().is_empty())
}

fn session_runtime(
    tool: &str,
    metadata: Option<&Value>,
    session: &Value,
    config: &Value,
) -> String {
    let command = session
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.get("command"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            config
                .get("tools")
                .and_then(|tools| tools.get(tool))
                .and_then(|tool| tool.get("command"))
                .and_then(Value::as_str)
        });
    command
        .and_then(|command| {
            Path::new(command)
                .file_name()
                .and_then(|name| name.to_str())
        })
        .unwrap_or(tool)
        .to_owned()
}

fn canonical_transcript_identity(path: &Path) -> Result<String, String> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path.to_string_lossy().into_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(path.to_string_lossy().into_owned())
        }
        Err(error) => Err(format!(
            "resolve usage-monitor transcript {}: {error}",
            path.display()
        )),
    }
}

fn read_metadata(context: &ProjectServiceRequestContext) -> Result<Value, String> {
    let path = metadata_state_path(context.project_state_dir());
    let value = read_optional_json(&path)?.unwrap_or_else(|| json!({"sessions":{}}));
    if !value.is_object() || !value.get("sessions").is_some_and(Value::is_object) {
        return Err(format!(
            "usage-monitor metadata {} must contain an object sessions",
            path.display()
        ));
    }
    Ok(value)
}

fn read_config(context: &ProjectServiceRequestContext) -> Result<Value, String> {
    let global = read_optional_json(&PathResolver::from_env().global_config_path())?;
    let project = read_optional_json(&project_config_path_for_known_root(context.project_root()))?;
    for layer in [&global, &project].into_iter().flatten() {
        if !layer.is_object() || layer.get("tools").is_some_and(|tools| !tools.is_object()) {
            return Err(
                "usage-monitor configuration must be an object with object tools".to_owned(),
            );
        }
    }
    Ok(merge_config_layers(global.as_ref(), project.as_ref()))
}

fn read_optional_json(path: &Path) -> Result<Option<Value>, String> {
    match fs::metadata(path) {
        Ok(stat) if !stat.is_file() => {
            return Err(format!(
                "read usage-monitor source {}: not a regular file",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "stat usage-monitor source {}: {error}",
                path.display()
            ));
        }
    }
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "read usage-monitor source {}: {error}",
                path.display()
            ));
        }
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("parse usage-monitor source {}: {error}", path.display()))
}

fn load_monitor_state(path: &Path, now: i64) -> Result<MonitorState, String> {
    let Some(value) = read_optional_json(path)? else {
        return Ok(MonitorState {
            version: STATE_VERSION,
            started_at: now,
            sessions: BTreeMap::new(),
        });
    };
    let state: MonitorState = serde_json::from_value(value)
        .map_err(|error| format!("parse usage-monitor state {}: {error}", path.display()))?;
    if state.version != STATE_VERSION {
        return Err(format!(
            "usage-monitor state {} version {} unsupported (expected {STATE_VERSION})",
            path.display(),
            state.version
        ));
    }
    Ok(state)
}

fn load_claude_quotas(path: &Path) -> Result<ClaudeQuotaStore, String> {
    let Some(value) = read_optional_json(path)? else {
        return Ok(ClaudeQuotaStore {
            version: STATE_VERSION,
            sessions: BTreeMap::new(),
        });
    };
    let state: ClaudeQuotaStore = serde_json::from_value(value)
        .map_err(|error| format!("parse Claude quota source {}: {error}", path.display()))?;
    if state.version != STATE_VERSION {
        return Err(format!(
            "Claude quota source {} version {} unsupported (expected {STATE_VERSION})",
            path.display(),
            state.version
        ));
    }
    Ok(state)
}

fn read_codex_quotas(transcript: Option<&Path>, now: i64) -> Vec<UsageQuotaObservation> {
    match try_read_codex_quotas(transcript, now) {
        Ok(observation) => observation,
        Err(reason) => vec![UsageQuotaObservation::error(
            CODEX_RATE_LIMIT_SOURCE,
            now,
            reason,
        )],
    }
}

fn try_read_codex_quotas(
    transcript: Option<&Path>,
    now: i64,
) -> Result<Vec<UsageQuotaObservation>, String> {
    let Some(transcript) = transcript else {
        return Ok(vec![UsageQuotaObservation::absent(
            CODEX_RATE_LIMIT_SOURCE,
            now,
            "no transcript path published yet",
        )]);
    };
    let stat = match fs::metadata(transcript) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(vec![UsageQuotaObservation::absent(
                CODEX_RATE_LIMIT_SOURCE,
                now,
                "no transcript written yet",
            )]);
        }
        Err(error) => {
            return Err(format!(
                "Codex quota stat {}: {error}",
                transcript.display()
            ));
        }
    };
    if !stat.is_file() {
        return Err(format!(
            "Codex quota read {}: transcript is not a regular file",
            transcript.display()
        ));
    }
    let (tail, leading_fragment) = read_tail_window_lossy(transcript, CODEX_TAIL_BYTES)
        .map_err(|reason| format!("Codex quota read {}: {reason}", transcript.display()))?;
    let tail = if leading_fragment {
        tail.split_once('\n')
            .map(|(_, complete)| complete)
            .unwrap_or("")
    } else {
        tail.as_str()
    };
    let mut observations = Vec::new();
    let mut seen_buckets = BTreeSet::new();
    for line in tail.split_inclusive('\n').rev() {
        if !line.ends_with('\n') {
            continue;
        }
        let entry: Value = match serde_json::from_str(line) {
            Ok(entry) => entry,
            Err(error) if line.contains("token_count") || line.contains("rate_limits") => {
                return Err(format!(
                    "parse Codex quota record {}: {error}",
                    transcript.display()
                ));
            }
            Err(_) => continue,
        };
        let Some(payload) = entry.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(limits) = payload
            .get("rate_limits")
            .filter(|limits| !limits.is_null())
        else {
            continue;
        };
        let bucket_id = limits
            .get("limit_id")
            .and_then(Value::as_str)
            .unwrap_or("codex");
        if !seen_buckets.insert(bucket_id.to_owned()) {
            continue;
        }
        let observed_at = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(super::usage::parse_recency_timestamp)
            .and_then(|ms| i64::try_from(ms / 1000).ok());
        let observation = match observed_at {
            None => UsageQuotaObservation::absent(
                CODEX_RATE_LIMIT_SOURCE,
                now,
                format!("Codex quota bucket {bucket_id} has no valid observation timestamp"),
            ),
            Some(observed_at) => match codex_rate_limit_usage(limits, observed_at) {
                Ok(observation) => observation,
                Err(error) => UsageQuotaObservation::error(
                    CODEX_RATE_LIMIT_SOURCE,
                    observed_at,
                    format!(
                        "Codex quota source {} bucket {bucket_id}: {error}",
                        transcript.display()
                    ),
                ),
            },
        };
        observations.push(observation);
    }
    if observations.is_empty() {
        observations.push(UsageQuotaObservation::absent(
            CODEX_RATE_LIMIT_SOURCE,
            now,
            "no complete Codex quota record in bounded transcript tail",
        ));
    }
    Ok(observations)
}

fn expire_quota(mut observation: UsageQuotaObservation, now: i64) -> UsageQuotaObservation {
    for window in &mut observation.windows {
        if window.state == UsageState::Known && window.resets_at.is_some_and(|reset| reset <= now) {
            window.state = UsageState::Absent;
            window.used_percent = None;
            window.used_usd = None;
            window.reason =
                Some("quota snapshot expired; runtime has not reported the new window".to_owned());
        }
    }
    if observation.state == UsageState::Known
        && !observation
            .windows
            .iter()
            .any(|window| window.state == UsageState::Known)
    {
        observation.state = UsageState::Absent;
        observation.reason =
            Some("quota snapshot expired; runtime has not reported the new window".to_owned());
    }
    observation
}
