use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::atomic_write::write_json_atomic;
use crate::backlog_metrics::{
    AGENT_INPUT_DELIVERY_BACKLOG, BacklogMetricSnapshot, backlog_metric, record_backlog_error,
};
use crate::debug_logging::{LogLevel, log_at};

use super::agent_output::{
    AgentOutputCaptureRuntime, deliver_prompt_to_tmux, deliver_prompt_to_tmux_async,
    resolve_live_window_id, tmux_agent_input_window_activity_async,
};
use super::operation_failures::{
    OperationFailureInput, OperationFailureMatch, WorktreePathMatch,
    add_dashboard_operation_failure, clear_dashboard_operation_failures,
};
use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture, scheduler_now_ms};

pub const AGENT_INPUT_DELIVERY_TASK_NAME: &str = "agent-input-delivery";
pub const ACTIVE_CLIENT_DWELL_MS: i64 = 3_000;
pub const MAX_AGENT_INPUT_HOLD_MS: i64 = 15_000;
pub const DELIVERY_TASK_INTERVAL_MS: i64 = 500;

const DELIVERY_TASK_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DELIVERIES_PER_TICK: usize = 8;
pub const AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY: usize = MAX_DELIVERIES_PER_TICK
    * ((MAX_AGENT_INPUT_HOLD_MS as usize / DELIVERY_TASK_INTERVAL_MS as usize) + 1);

static DELIVERY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default)]
pub struct AgentInputDeliveryQueue {
    lock: Arc<Mutex<()>>,
}

impl AgentInputDeliveryQueue {
    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .expect("agent input delivery lock poisoned")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentInputWindowActivity {
    Unattended,
    UnsubmittedInputVisible,
    Attended {
        active_clients: usize,
        latest_activity_ms: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentInputDeliveryDecision {
    DeliverNow {
        reason: String,
    },
    Hold {
        reason: String,
        quiet_for_ms: Option<i64>,
        retry_after_ms: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingAgentInputDelivery {
    pub id: String,
    pub session_id: String,
    pub window_id: String,
    pub prompt: String,
    pub created_at_ms: i64,
    pub max_deliver_at_ms: i64,
    pub hold_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AgentInputDeliveryState {
    version: u64,
    pending: Vec<PendingAgentInputDelivery>,
}

pub fn agent_input_delivery_queue_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir
        .as_ref()
        .join("agent-input-delivery-queue.json")
}

pub fn parse_agent_input_window_activity(
    window_id: &str,
    panes_output: &str,
    clients_output: &str,
) -> Result<AgentInputWindowActivity, String> {
    let active_clients = active_client_count_for_window(window_id, panes_output)?;
    if active_clients == 0 {
        return Ok(AgentInputWindowActivity::Unattended);
    }

    let mut latest_activity = None;
    let mut matched_clients = 0usize;
    for line in clients_output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let name = parts.next().unwrap_or("");
        let activity = parts.next().unwrap_or("");
        let client_window_id = parts.next().unwrap_or("");
        if client_window_id != window_id {
            continue;
        }
        matched_clients += 1;
        let activity = activity.parse::<i64>().map_err(|_| {
            format!("tmux list-clients returned invalid client_activity for {name}: {activity:?}")
        })?;
        latest_activity =
            Some(latest_activity.map_or(activity, |current: i64| current.max(activity)));
    }

    let Some(latest_activity_secs) = latest_activity else {
        return Err(format!(
            "tmux reported {active_clients} active client(s) for {window_id}, but list-clients named none"
        ));
    };

    Ok(AgentInputWindowActivity::Attended {
        active_clients: matched_clients,
        latest_activity_ms: latest_activity_secs.saturating_mul(1_000),
    })
}

pub fn decide_agent_input_delivery(
    force: bool,
    activity: Result<AgentInputWindowActivity, String>,
    now_ms: i64,
    created_at_ms: i64,
) -> AgentInputDeliveryDecision {
    if force {
        return AgentInputDeliveryDecision::DeliverNow {
            reason: "force".into(),
        };
    }
    let max_deliver_at_ms = created_at_ms.saturating_add(MAX_AGENT_INPUT_HOLD_MS);
    match activity {
        Ok(AgentInputWindowActivity::Unattended) => {
            let reason = if now_ms >= max_deliver_at_ms {
                "max-hold-elapsed"
            } else {
                "unattended-window"
            };
            AgentInputDeliveryDecision::DeliverNow {
                reason: reason.into(),
            }
        }
        Ok(AgentInputWindowActivity::UnsubmittedInputVisible) => {
            if now_ms >= max_deliver_at_ms {
                AgentInputDeliveryDecision::DeliverNow {
                    reason: "max-hold-elapsed".into(),
                }
            } else {
                AgentInputDeliveryDecision::Hold {
                    reason: "visible-unsubmitted-input".into(),
                    quiet_for_ms: None,
                    retry_after_ms: DELIVERY_TASK_INTERVAL_MS,
                }
            }
        }
        Ok(AgentInputWindowActivity::Attended {
            latest_activity_ms, ..
        }) => {
            let quiet_for_ms = now_ms.saturating_sub(latest_activity_ms).max(0);
            if quiet_for_ms >= ACTIVE_CLIENT_DWELL_MS {
                AgentInputDeliveryDecision::DeliverNow {
                    reason: "active-client-idle".into(),
                }
            } else {
                AgentInputDeliveryDecision::Hold {
                    reason: "active-client-recent-input".into(),
                    quiet_for_ms: Some(quiet_for_ms),
                    retry_after_ms: ACTIVE_CLIENT_DWELL_MS.saturating_sub(quiet_for_ms),
                }
            }
        }
        Err(error) => AgentInputDeliveryDecision::Hold {
            reason: format!("tmux client activity probe failed: {error}"),
            quiet_for_ms: None,
            retry_after_ms: DELIVERY_TASK_INTERVAL_MS,
        },
    }
}

pub fn enqueue_agent_input_delivery(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    window_id: &str,
    prompt: &str,
    hold_reason: &str,
    now_ms: i64,
) -> Result<PendingAgentInputDelivery, String> {
    let _guard = context.agent_input_delivery_queue.lock();
    let path = agent_input_delivery_queue_path(context.project_state_dir());
    let mut state = load_delivery_state(&path).inspect_err(|error| {
        record_backlog_error(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
            error.clone(),
        );
    })?;
    let pending = PendingAgentInputDelivery {
        id: next_delivery_id(),
        session_id: session_id.to_owned(),
        window_id: window_id.to_owned(),
        prompt: prompt.to_owned(),
        created_at_ms: now_ms,
        max_deliver_at_ms: now_ms.saturating_add(MAX_AGENT_INPUT_HOLD_MS),
        hold_reason: hold_reason.to_owned(),
    };
    state.pending.push(pending.clone());
    let depth = state.pending.len();
    save_delivery_state(&path, state)?;
    backlog_metric(
        AGENT_INPUT_DELIVERY_BACKLOG,
        Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
    )
    .set_depth(depth);
    Ok(pending)
}

pub fn record_agent_input_delivery_probe_failure(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    reason: &str,
) {
    record_agent_input_delivery_failure(
        context,
        Some(session_id),
        "Agent input delivery held",
        reason,
    );
}

pub fn run_pending_agent_input_deliveries_with_runtime(
    context: &ProjectServiceRequestContext,
    runtime: &mut impl AgentOutputCaptureRuntime,
    now_ms: i64,
) {
    let _guard = context.agent_input_delivery_queue.lock();
    let path = agent_input_delivery_queue_path(context.project_state_dir());
    let Ok(state) = load_delivery_state(&path) else {
        record_backlog_error(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
            load_error_for_path(&path),
        );
        record_agent_input_delivery_failure(
            context,
            None,
            "Agent input delivery queue unavailable",
            format!(
                "Skipped queued agent input delivery because {}",
                load_error_for_path(&path)
            ),
        );
        return;
    };
    if state.pending.is_empty() {
        backlog_metric(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
        )
        .set_depth(0);
        return;
    }

    let mut remaining = Vec::new();
    let mut ready = VecDeque::from(state.pending);
    let mut delivered = 0usize;
    while let Some(pending) = ready.pop_front() {
        if delivered >= MAX_DELIVERIES_PER_TICK {
            remaining.push(pending);
            remaining.extend(ready);
            break;
        }
        let window_id = resolve_live_window_id(context, &pending.session_id)
            .unwrap_or_else(|| pending.window_id.clone());
        let force_due_to_max = now_ms >= pending.max_deliver_at_ms;
        let activity = runtime.agent_input_window_activity(&window_id);
        let decision = decide_agent_input_delivery(false, activity, now_ms, pending.created_at_ms);
        match decision {
            AgentInputDeliveryDecision::Hold { reason, .. } => {
                if reason.starts_with("tmux client activity probe failed") {
                    record_agent_input_delivery_failure(
                        context,
                        Some(&pending.session_id),
                        "Agent input delivery held",
                        reason,
                    );
                }
                remaining.push(pending);
            }
            AgentInputDeliveryDecision::DeliverNow { reason } => {
                if force_due_to_max {
                    record_agent_input_delivery_failure(
                        context,
                        Some(&pending.session_id),
                        "Agent input delivery forced after hold budget",
                        format!(
                            "Delivered queued input after holding for {}ms; last hold reason: {}",
                            now_ms.saturating_sub(pending.created_at_ms),
                            pending.hold_reason
                        ),
                    );
                }
                match deliver_prompt_to_tmux(runtime, &window_id, &pending.prompt) {
                    Ok(()) => {
                        if !force_due_to_max {
                            clear_agent_input_delivery_failure(context, &pending.session_id);
                        }
                        log_at(
                            LogLevel::Info,
                            "queued agent input delivered",
                            "agent-input-delivery",
                            Some(json!({
                                "sessionId": pending.session_id,
                                "windowId": window_id,
                                "reason": reason,
                            })),
                        );
                        delivered += 1;
                    }
                    Err(error) => {
                        record_agent_input_delivery_failure(
                            context,
                            Some(&pending.session_id),
                            "Agent input delivery failed",
                            error,
                        );
                        if now_ms < pending.max_deliver_at_ms {
                            remaining.push(pending);
                        }
                    }
                }
            }
        }
    }

    let state = AgentInputDeliveryState {
        version: 1,
        pending: remaining,
    };
    let depth = state.pending.len();
    match save_delivery_state(&path, state) {
        Ok(()) => backlog_metric(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
        )
        .set_depth(depth),
        Err(error) => {
            record_backlog_error(
                AGENT_INPUT_DELIVERY_BACKLOG,
                Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
                error.clone(),
            );
            record_agent_input_delivery_failure(
                context,
                None,
                "Agent input delivery queue unavailable",
                format!("Could not save queued agent input delivery state: {error}"),
            );
        }
    }
}

pub async fn run_pending_agent_input_deliveries_async(
    context: &ProjectServiceRequestContext,
    now_ms: i64,
) {
    let path = agent_input_delivery_queue_path(context.project_state_dir());
    let state = {
        let _guard = context.agent_input_delivery_queue.lock();
        match load_delivery_state(&path) {
            Ok(state) => state,
            Err(_) => {
                record_backlog_error(
                    AGENT_INPUT_DELIVERY_BACKLOG,
                    Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
                    load_error_for_path(&path),
                );
                record_agent_input_delivery_failure(
                    context,
                    None,
                    "Agent input delivery queue unavailable",
                    format!(
                        "Skipped queued agent input delivery because {}",
                        load_error_for_path(&path)
                    ),
                );
                return;
            }
        }
    };
    if state.pending.is_empty() {
        backlog_metric(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
        )
        .set_depth(0);
        return;
    }

    let original_ids = state
        .pending
        .iter()
        .map(|pending| pending.id.clone())
        .collect::<BTreeSet<_>>();
    let mut remaining = Vec::new();
    let mut ready = VecDeque::from(state.pending);
    let mut delivered = 0usize;
    while let Some(pending) = ready.pop_front() {
        if delivered >= MAX_DELIVERIES_PER_TICK {
            remaining.push(pending);
            remaining.extend(ready);
            break;
        }
        let window_id = resolve_live_window_id(context, &pending.session_id)
            .unwrap_or_else(|| pending.window_id.clone());
        let force_due_to_max = now_ms >= pending.max_deliver_at_ms;
        let activity =
            tmux_agent_input_window_activity_async(&window_id, DELIVERY_TASK_TIMEOUT).await;
        let decision = decide_agent_input_delivery(false, activity, now_ms, pending.created_at_ms);
        match decision {
            AgentInputDeliveryDecision::Hold { reason, .. } => {
                if reason.starts_with("tmux client activity probe failed") {
                    record_agent_input_delivery_failure(
                        context,
                        Some(&pending.session_id),
                        "Agent input delivery held",
                        reason,
                    );
                }
                remaining.push(pending);
            }
            AgentInputDeliveryDecision::DeliverNow { reason } => {
                if force_due_to_max {
                    record_agent_input_delivery_failure(
                        context,
                        Some(&pending.session_id),
                        "Agent input delivery forced after hold budget",
                        format!(
                            "Delivered queued input after holding for {}ms; last hold reason: {}",
                            now_ms.saturating_sub(pending.created_at_ms),
                            pending.hold_reason
                        ),
                    );
                }
                match deliver_prompt_to_tmux_async(
                    &window_id,
                    &pending.prompt,
                    DELIVERY_TASK_TIMEOUT,
                )
                .await
                {
                    Ok(()) => {
                        if !force_due_to_max {
                            clear_agent_input_delivery_failure(context, &pending.session_id);
                        }
                        log_at(
                            LogLevel::Info,
                            "queued agent input delivered",
                            "agent-input-delivery",
                            Some(json!({
                                "sessionId": pending.session_id,
                                "windowId": window_id,
                                "reason": reason,
                            })),
                        );
                        delivered += 1;
                    }
                    Err(error) => {
                        record_agent_input_delivery_failure(
                            context,
                            Some(&pending.session_id),
                            "Agent input delivery failed",
                            error,
                        );
                        if now_ms < pending.max_deliver_at_ms {
                            remaining.push(pending);
                        }
                    }
                }
            }
        }
    }

    let _guard = context.agent_input_delivery_queue.lock();
    let mut pending = remaining;
    if let Ok(current) = load_delivery_state(&path) {
        pending.extend(
            current
                .pending
                .into_iter()
                .filter(|entry| !original_ids.contains(&entry.id)),
        );
    }
    let state = AgentInputDeliveryState {
        version: 1,
        pending,
    };
    let depth = state.pending.len();
    match save_delivery_state(&path, state) {
        Ok(()) => backlog_metric(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
        )
        .set_depth(depth),
        Err(error) => {
            record_backlog_error(
                AGENT_INPUT_DELIVERY_BACKLOG,
                Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
                error.clone(),
            );
            record_agent_input_delivery_failure(
                context,
                None,
                "Agent input delivery queue unavailable",
                format!("Could not save queued agent input delivery state: {error}"),
            );
        }
    }
}

pub fn agent_input_delivery_backlog_snapshot(
    project_state_dir: impl AsRef<Path>,
) -> BacklogMetricSnapshot {
    let path = agent_input_delivery_queue_path(project_state_dir);
    let metric = backlog_metric(
        AGENT_INPUT_DELIVERY_BACKLOG,
        Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
    );
    match load_delivery_state(&path) {
        Ok(state) => metric.set_depth(state.pending.len()),
        Err(error) => metric.set_error(error),
    }
    metric.snapshot()
}

pub fn agent_input_delivery_task(
    context: &Arc<ProjectServiceRequestContext>,
) -> Box<dyn PeriodicTask> {
    Box::new(AgentInputDeliveryTask {
        context: Arc::clone(context),
    })
}

struct AgentInputDeliveryTask {
    context: Arc<ProjectServiceRequestContext>,
}

impl PeriodicTask for AgentInputDeliveryTask {
    fn name(&self) -> &str {
        AGENT_INPUT_DELIVERY_TASK_NAME
    }

    fn interval_ms(&self) -> i64 {
        DELIVERY_TASK_INTERVAL_MS
    }

    fn timeout(&self) -> Duration {
        DELIVERY_TASK_TIMEOUT + Duration::from_secs(1)
    }

    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            run_pending_agent_input_deliveries_async(&self.context, scheduler_now_ms()).await;
        })
    }
}

pub fn active_client_count_for_window(
    window_id: &str,
    panes_output: &str,
) -> Result<usize, String> {
    for line in panes_output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let pane_window_id = parts.next().unwrap_or("");
        let active_clients = parts.next().unwrap_or("");
        if pane_window_id != window_id {
            continue;
        }
        return active_clients.parse::<usize>().map_err(|_| {
            format!(
                "tmux list-panes returned invalid window_active_clients for {window_id}: {active_clients:?}"
            )
        });
    }
    Ok(0)
}

pub fn pane_has_unsubmitted_agent_input(pane: &str) -> bool {
    let visible_lines = pane
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !looks_like_agent_bottom_chrome(line))
        .collect::<Vec<_>>();
    for (index, trimmed) in visible_lines.iter().enumerate().rev() {
        if trimmed.is_empty() || looks_like_agent_bottom_chrome(trimmed) {
            continue;
        }
        let Some(rest) = strip_agent_prompt_marker(trimmed) else {
            if index > 0
                && strip_agent_prompt_marker(visible_lines[index - 1])
                    .is_some_and(|rest| rest.trim().is_empty())
            {
                return has_user_composer_text(trimmed);
            }
            return false;
        };
        return has_user_composer_text(rest);
    }
    false
}

fn strip_agent_prompt_marker(line: &str) -> Option<&str> {
    let mut chars = line.chars();
    let first = chars.next()?;
    if matches!(first, '›' | '>' | '❯') {
        Some(chars.as_str())
    } else {
        None
    }
}

fn looks_like_agent_bottom_chrome(line: &str) -> bool {
    (line.starts_with("gpt-") || line.starts_with("claude-"))
        && (line.contains(" · ~/") || line.contains(" · /"))
}

fn has_user_composer_text(value: &str) -> bool {
    let text = value.trim();
    !text.is_empty() && !is_empty_composer_placeholder(text)
}

fn is_empty_composer_placeholder(text: &str) -> bool {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    matches!(
        normalized.as_str(),
        "Ask Codex to do anything" | "Ask Claude to do anything"
    )
}

fn load_delivery_state(path: &Path) -> Result<AgentInputDeliveryState, String> {
    if !path.exists() {
        return Ok(AgentInputDeliveryState {
            version: 1,
            pending: Vec::new(),
        });
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let state: AgentInputDeliveryState = serde_json::from_str(&contents)
        .map_err(|error| format!("could not parse {}: {error}", path.display()))?;
    if state.version != 1 {
        return Err(format!(
            "unsupported agent input delivery queue version {} in {}",
            state.version,
            path.display()
        ));
    }
    Ok(state)
}

fn save_delivery_state(path: &Path, state: AgentInputDeliveryState) -> Result<(), String> {
    if state.pending.is_empty() {
        if path.exists() {
            fs::remove_file(path).map_err(|error| {
                format!(
                    "could not remove empty delivery queue {}: {error}",
                    path.display()
                )
            })?;
        }
        return Ok(());
    }
    write_json_atomic(path, &state)
        .map_err(|error| format!("could not save {}: {error}", path.display()))
}

fn load_error_for_path(path: &Path) -> String {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str::<Value>(&contents)
            .err()
            .map(|error| format!("{} could not be parsed: {error}", path.display()))
            .unwrap_or_else(|| format!("{} has an unsupported schema", path.display())),
        Err(error) => format!("{} could not be read: {error}", path.display()),
    }
}

fn record_agent_input_delivery_failure(
    context: &ProjectServiceRequestContext,
    session_id: Option<&str>,
    title: &str,
    message: impl Into<String>,
) {
    let message = message.into();
    log_at(
        LogLevel::Warn,
        title,
        "agent-input-delivery",
        Some(json!({
            "sessionId": session_id,
            "message": message,
        })),
    );
    let _ = add_dashboard_operation_failure(
        context.project_state_dir(),
        OperationFailureInput {
            target_kind: "agent".into(),
            operation: "input.delivery".into(),
            title: title.into(),
            message,
            target_id: session_id.map(str::to_owned),
            worktree_path: None,
            worktree_name: None,
            created_at: None,
        },
    );
}

fn clear_agent_input_delivery_failure(context: &ProjectServiceRequestContext, session_id: &str) {
    let _ = clear_dashboard_operation_failures(
        context.project_state_dir(),
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("input.delivery".into()),
            target_id: Some(session_id.to_owned()),
            worktree_path: WorktreePathMatch::Any,
        },
    );
}

fn next_delivery_id() -> String {
    let sequence = DELIVERY_SEQUENCE.fetch_add(1, Ordering::SeqCst);
    format!("agent-input-{}-{sequence}", std::process::id())
}
