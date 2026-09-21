use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::agent_prompt_delivery::{current_composer_text, strip_agent_prompt_marker};
use crate::atomic_write::write_json_atomic;
use crate::backlog_metrics::{
    AGENT_INPUT_DELIVERY_BACKLOG, BacklogMetricSnapshot, backlog_metric, record_backlog_error,
};
use crate::debug_logging::{LogLevel, log_at};

use super::agent_output::{
    AgentOutputCaptureRuntime, LiveSessionTarget, deliver_prompt_to_tmux_async_for_tool,
    deliver_prompt_to_tmux_for_tool, resolve_live_session_target,
    tmux_agent_input_window_activity_async,
};
use super::operation_failures::{
    OperationFailureInput, OperationFailureMatch, WorktreePathMatch,
    add_dashboard_operation_failure, clear_dashboard_operation_failures,
};
use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture, scheduler_now_ms};

pub const AGENT_INPUT_DELIVERY_TASK_NAME: &str = "agent-input-delivery";
/// Default quiet window before Aimux may submit into an attended agent session.
pub const USER_TYPING_QUIET_WINDOW_MS: i64 = 15_000;
pub const ACTIVE_CLIENT_DWELL_MS: i64 = USER_TYPING_QUIET_WINDOW_MS;
pub const MAX_AGENT_INPUT_HOLD_MS: i64 = 15_000;
pub const DELIVERY_TASK_INTERVAL_MS: i64 = 500;

const DELIVERY_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(2);
const DELIVERY_SUBMIT_TIMEOUT: Duration = Duration::from_secs(10);
const DELIVERY_TASK_TIMEOUT: Duration = Duration::from_secs(15);
const DELIVERY_TASK_COMMIT_MARGIN: Duration = Duration::from_secs(1);
const MAX_DELIVERIES_PER_TICK: usize = 8;
const MAX_DELIVERY_ATTEMPTS_PER_TICK: usize = 1;
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
    UnsubmittedInputVisible {
        active_clients: usize,
        latest_activity_ms: Option<i64>,
    },
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

enum QueuedDeliveryTarget {
    Deliverable(LiveSessionTarget),
    Blocked(String),
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

    let (matched_clients, latest_activity_secs) =
        latest_client_activity_for_window(window_id, active_clients, clients_output)?;

    Ok(AgentInputWindowActivity::Attended {
        active_clients: matched_clients,
        latest_activity_ms: latest_activity_secs.saturating_mul(1_000),
    })
}

pub fn classify_agent_input_window_activity(
    window_id: &str,
    panes_output: &str,
    pane_output: &str,
    clients_output: Option<&str>,
) -> Result<AgentInputWindowActivity, String> {
    let active_clients = active_client_count_for_window(window_id, panes_output)?;
    if pane_has_unsubmitted_agent_input(pane_output) {
        if active_clients == 0 {
            return Ok(AgentInputWindowActivity::UnsubmittedInputVisible {
                active_clients,
                latest_activity_ms: None,
            });
        }
        let Some(clients_output) = clients_output else {
            return Err(format!(
                "tmux reported {active_clients} active client(s) for {window_id}, but client activity was not queried"
            ));
        };
        let (matched_clients, latest_activity_secs) =
            latest_client_activity_for_window(window_id, active_clients, clients_output)?;
        return Ok(AgentInputWindowActivity::UnsubmittedInputVisible {
            active_clients: matched_clients,
            latest_activity_ms: Some(latest_activity_secs.saturating_mul(1_000)),
        });
    }
    if active_clients == 0 {
        return Ok(AgentInputWindowActivity::Unattended);
    }
    let Some(clients_output) = clients_output else {
        return Err(format!(
            "tmux reported {active_clients} active client(s) for {window_id}, but client activity was not queried"
        ));
    };
    parse_agent_input_window_activity(window_id, panes_output, clients_output)
}

fn latest_client_activity_for_window(
    window_id: &str,
    active_clients: usize,
    clients_output: &str,
) -> Result<(usize, i64), String> {
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
    Ok((matched_clients, latest_activity_secs))
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
    let _ = created_at_ms;
    match activity {
        Ok(AgentInputWindowActivity::Unattended) => AgentInputDeliveryDecision::DeliverNow {
            reason: "unattended-window".into(),
        },
        Ok(AgentInputWindowActivity::UnsubmittedInputVisible {
            latest_activity_ms: Some(latest_activity_ms),
            ..
        }) => {
            let quiet_for_ms = now_ms.saturating_sub(latest_activity_ms).max(0);
            if quiet_for_ms >= USER_TYPING_QUIET_WINDOW_MS {
                AgentInputDeliveryDecision::DeliverNow {
                    reason: "visible-unsubmitted-input-idle".into(),
                }
            } else {
                AgentInputDeliveryDecision::Hold {
                    reason: "visible-unsubmitted-input-recent-user-input".into(),
                    quiet_for_ms: Some(quiet_for_ms),
                    retry_after_ms: USER_TYPING_QUIET_WINDOW_MS.saturating_sub(quiet_for_ms),
                }
            }
        }
        Ok(AgentInputWindowActivity::UnsubmittedInputVisible {
            latest_activity_ms: None,
            ..
        }) => AgentInputDeliveryDecision::DeliverNow {
            reason: "visible-unsubmitted-input-unattended".into(),
        },
        Ok(AgentInputWindowActivity::Attended {
            latest_activity_ms, ..
        }) => {
            let quiet_for_ms = now_ms.saturating_sub(latest_activity_ms).max(0);
            if quiet_for_ms >= USER_TYPING_QUIET_WINDOW_MS {
                AgentInputDeliveryDecision::DeliverNow {
                    reason: "active-client-idle".into(),
                }
            } else {
                AgentInputDeliveryDecision::Hold {
                    reason: "active-client-recent-input".into(),
                    quiet_for_ms: Some(quiet_for_ms),
                    retry_after_ms: USER_TYPING_QUIET_WINDOW_MS.saturating_sub(quiet_for_ms),
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
    if let Some(existing) = matching_dedupable_delivery(&state.pending, &pending) {
        backlog_metric(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
        )
        .set_depth(state.pending.len());
        return Ok(existing.clone());
    }
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
    let mut ready = VecDeque::from(deduplicate_pending_agent_input_deliveries(state.pending));
    let mut delivery_attempts = 0usize;
    while let Some(pending) = ready.pop_front() {
        if delivery_attempts >= MAX_DELIVERY_ATTEMPTS_PER_TICK {
            remaining.push(pending);
            remaining.extend(ready);
            break;
        }
        let target = match resolve_queued_delivery_target(context, &pending) {
            QueuedDeliveryTarget::Deliverable(target) => target,
            QueuedDeliveryTarget::Blocked(reason) => {
                record_agent_input_delivery_failure(
                    context,
                    Some(&pending.session_id),
                    "Agent input delivery blocked",
                    reason,
                );
                remaining.push(pending);
                continue;
            }
        };
        let decision = {
            let activity = runtime.agent_input_window_activity(&target.window_id);
            decide_agent_input_delivery(false, activity, now_ms, pending.created_at_ms)
        };
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
                delivery_attempts += 1;
                match deliver_prompt_to_tmux_for_tool(
                    runtime,
                    &target.window_id,
                    &pending.prompt,
                    target.tool.as_deref(),
                ) {
                    Ok(()) => {
                        clear_agent_input_delivery_failure(context, &pending.session_id);
                        log_at(
                            LogLevel::Info,
                            "queued agent input delivered",
                            "agent-input-delivery",
                            Some(json!({
                                "sessionId": pending.session_id,
                                "windowId": target.window_id,
                                "reason": reason,
                            })),
                        );
                    }
                    Err(error) => {
                        record_agent_input_delivery_failure(
                            context,
                            Some(&pending.session_id),
                            "Agent input delivery failed",
                            error,
                        );
                        remaining.push(pending);
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
) -> Result<(), String> {
    let task_deadline = Instant::now()
        .checked_add(DELIVERY_TASK_TIMEOUT.saturating_sub(DELIVERY_TASK_COMMIT_MARGIN))
        .unwrap_or_else(Instant::now);
    let path = agent_input_delivery_queue_path(context.project_state_dir());
    let state = {
        let _guard = context.agent_input_delivery_queue.lock();
        match load_delivery_state(&path) {
            Ok(state) => state,
            Err(_) => {
                let error = load_error_for_path(&path);
                record_backlog_error(
                    AGENT_INPUT_DELIVERY_BACKLOG,
                    Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
                    error.clone(),
                );
                record_agent_input_delivery_failure(
                    context,
                    None,
                    "Agent input delivery queue unavailable",
                    format!("Skipped queued agent input delivery because {error}"),
                );
                return Err(format!("agent input delivery queue unavailable: {error}"));
            }
        }
    };
    if state.pending.is_empty() {
        backlog_metric(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
        )
        .set_depth(0);
        return Ok(());
    }

    let loaded_ids = state
        .pending
        .iter()
        .map(|pending| pending.id.clone())
        .collect::<BTreeSet<_>>();
    let pending = deduplicate_pending_agent_input_deliveries(state.pending);
    let mut remaining = Vec::new();
    let mut ready = VecDeque::from(pending);
    let mut delivery_attempts = 0usize;
    let mut failures = Vec::new();
    while let Some(pending) = ready.pop_front() {
        if delivery_attempts >= MAX_DELIVERY_ATTEMPTS_PER_TICK
            || !has_budget_for_delivery_attempt(Instant::now(), task_deadline)
        {
            remaining.push(pending);
            remaining.extend(ready);
            break;
        }
        let target = match resolve_queued_delivery_target(context, &pending) {
            QueuedDeliveryTarget::Deliverable(target) => target,
            QueuedDeliveryTarget::Blocked(reason) => {
                record_agent_input_delivery_failure(
                    context,
                    Some(&pending.session_id),
                    "Agent input delivery blocked",
                    reason.clone(),
                );
                failures.push(reason);
                remaining.push(pending);
                continue;
            }
        };
        let decision = {
            let activity = tmux_agent_input_window_activity_async(
                &target.window_id,
                DELIVERY_ACTIVITY_TIMEOUT,
            )
            .await;
            decide_agent_input_delivery(false, activity, now_ms, pending.created_at_ms)
        };
        match decision {
            AgentInputDeliveryDecision::Hold { reason, .. } => {
                if reason.starts_with("tmux client activity probe failed") {
                    record_agent_input_delivery_failure(
                        context,
                        Some(&pending.session_id),
                        "Agent input delivery held",
                        reason.clone(),
                    );
                    failures.push(reason);
                }
                remaining.push(pending);
            }
            AgentInputDeliveryDecision::DeliverNow { reason } => {
                delivery_attempts += 1;
                match deliver_prompt_to_tmux_async_for_tool(
                    &target.window_id,
                    &pending.prompt,
                    DELIVERY_SUBMIT_TIMEOUT,
                    target.tool.as_deref(),
                )
                .await
                {
                    Ok(()) => {
                        clear_agent_input_delivery_failure(context, &pending.session_id);
                        log_at(
                            LogLevel::Info,
                            "queued agent input delivered",
                            "agent-input-delivery",
                            Some(json!({
                                "sessionId": pending.session_id,
                                "windowId": target.window_id,
                                "reason": reason,
                            })),
                        );
                    }
                    Err(error) => {
                        record_agent_input_delivery_failure(
                            context,
                            Some(&pending.session_id),
                            "Agent input delivery failed",
                            error.clone(),
                        );
                        failures.push(error);
                        remaining.push(pending);
                    }
                }
            }
        }
    }

    let _guard = context.agent_input_delivery_queue.lock();
    let mut pending = remaining;
    match load_delivery_state(&path) {
        Ok(current) => {
            pending.extend(
                current
                    .pending
                    .into_iter()
                    .filter(|entry| !loaded_ids.contains(&entry.id)),
            );
        }
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
                format!("Could not merge queued agent input delivery state: {error}"),
            );
            failures.push(error);
        }
    }
    let state = AgentInputDeliveryState {
        version: 1,
        pending: deduplicate_pending_agent_input_deliveries(pending),
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
            failures.push(error);
        }
    }
    finish_agent_input_delivery_task(failures)
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

fn resolve_queued_delivery_target(
    context: &ProjectServiceRequestContext,
    pending: &PendingAgentInputDelivery,
) -> QueuedDeliveryTarget {
    match resolve_live_session_target(context, &pending.session_id) {
        Ok(Some(target)) => QueuedDeliveryTarget::Deliverable(target),
        Ok(None) => QueuedDeliveryTarget::Blocked(format!(
            "Kept queued input for {} because runtime topology has no live tmux window for that session; refused stale queued tmux target {}",
            pending.session_id, pending.window_id
        )),
        Err(error) => QueuedDeliveryTarget::Blocked(format!(
            "Kept queued input for {} because {error}; refused stale queued tmux target {}",
            pending.session_id, pending.window_id
        )),
    }
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
            run_pending_agent_input_deliveries_async(&self.context, scheduler_now_ms()).await
        })
    }
}

fn finish_agent_input_delivery_task(failures: Vec<String>) -> Result<(), String> {
    if failures.is_empty() {
        return Ok(());
    }
    Err(format!(
        "agent input delivery could not complete: {}",
        failures.join("; ")
    ))
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
    if latest_composer_region_is_chrome_only(pane) {
        return false;
    }
    current_composer_text(pane).is_some_and(|composer| has_user_composer_text(&composer))
}

fn has_user_composer_text(value: &str) -> bool {
    let text = value.trim();
    !text.is_empty() && !is_empty_composer_placeholder(text)
}

fn latest_composer_region_is_chrome_only(pane: &str) -> bool {
    let lines = pane.lines().collect::<Vec<_>>();
    let Some((prompt_index, prompt_text)) =
        lines.iter().enumerate().rev().find_map(|(index, line)| {
            strip_agent_prompt_marker(line.trim()).map(|rest| (index, rest.trim()))
        })
    else {
        return false;
    };

    if !prompt_text.is_empty() {
        return is_agent_input_composer_chrome_text(prompt_text)
            && lines[prompt_index + 1..]
                .iter()
                .all(|line| is_agent_input_composer_tail_chrome(line.trim()));
    }

    let mut non_chrome_tail = lines[prompt_index + 1..]
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .filter(|line| !is_agent_input_composer_tail_chrome(line));

    let Some(first) = non_chrome_tail.next() else {
        return false;
    };
    is_agent_input_composer_chrome_text(first) && non_chrome_tail.next().is_none()
}

fn is_agent_input_composer_chrome_text(text: &str) -> bool {
    let normalized = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    normalized.is_empty()
        || matches!(
            normalized.as_str(),
            "ask codex to do anything" | "ask claude to do anything"
        )
        || normalized.contains("bypass permissions")
        || (normalized.contains("shift+tab") && normalized.contains("cycle"))
        || {
            let mut words = normalized.split_whitespace();
            matches!(words.next(), Some("press"))
                && words.next().is_some_and(is_keyboard_hint_token)
                && normalized.contains(" to ")
                && (normalized.contains("message")
                    || normalized.contains("prompt")
                    || normalized.contains("composer")
                    || normalized.contains("input")
                    || normalized.contains("send")
                    || normalized.contains("queue")
                    || normalized.contains("edit")
                    || normalized.contains("accept")
                    || normalized.contains("cancel"))
        }
}

fn is_keyboard_hint_token(token: &str) -> bool {
    matches!(
        token.trim_matches(|ch: char| matches!(ch, ',' | '.' | ':' | ';' | '(' | ')' | '[' | ']')),
        "up" | "down"
            | "left"
            | "right"
            | "tab"
            | "enter"
            | "return"
            | "esc"
            | "escape"
            | "space"
            | "backspace"
            | "delete"
            | "ctrl+c"
            | "ctrl+d"
            | "ctrl+j"
            | "ctrl+o"
            | "ctrl+r"
            | "shift+tab"
    )
}

fn is_agent_input_composer_tail_chrome(line: &str) -> bool {
    if line.is_empty() {
        return true;
    }
    let lower = line.to_ascii_lowercase();
    is_agent_input_horizontal_rule(line)
        || line.starts_with('⏵')
        || line.starts_with('⧉')
        || line.contains("[[aimux]")
        || lower.contains("bypass permissions")
        || lower.contains("shift+tab")
        || lower.contains(" context)")
        || lower.starts_with("gpt-")
        || lower.starts_with("claude-")
}

fn is_agent_input_horizontal_rule(line: &str) -> bool {
    let mut chars = line.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    matches!(first, '─' | '-') && chars.all(|character| character == first)
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

fn deduplicate_pending_agent_input_deliveries(
    pending: Vec<PendingAgentInputDelivery>,
) -> Vec<PendingAgentInputDelivery> {
    let mut seen = BTreeSet::new();
    let mut deduped = Vec::with_capacity(pending.len());
    for entry in pending {
        if is_dedupable_system_prompt(&entry.prompt) {
            let key = (entry.session_id.clone(), entry.prompt.clone());
            if !seen.insert(key) {
                continue;
            }
        }
        deduped.push(entry);
    }
    deduped
}

fn matching_dedupable_delivery<'a>(
    pending: &'a [PendingAgentInputDelivery],
    candidate: &PendingAgentInputDelivery,
) -> Option<&'a PendingAgentInputDelivery> {
    if !is_dedupable_system_prompt(&candidate.prompt) {
        return None;
    }
    pending.iter().find(|entry| {
        entry.session_id == candidate.session_id
            && entry.prompt == candidate.prompt
            && is_dedupable_system_prompt(&entry.prompt)
    })
}

fn is_dedupable_system_prompt(prompt: &str) -> bool {
    prompt.starts_with("[aimux loop check]")
}

fn has_budget_for_delivery_attempt(now: Instant, task_deadline: Instant) -> bool {
    now.checked_add(DELIVERY_SUBMIT_TIMEOUT)
        .is_some_and(|latest_finish| latest_finish <= task_deadline)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn async_delivery_task_timeout_covers_probe_submit_and_commit_margin() {
        assert!(
            DELIVERY_TASK_TIMEOUT
                >= DELIVERY_ACTIVITY_TIMEOUT
                    + DELIVERY_SUBMIT_TIMEOUT
                    + DELIVERY_TASK_COMMIT_MARGIN,
            "agent-input-delivery must not let the scheduler cancel after tmux input is written but before the queue removal is saved"
        );
    }

    #[test]
    fn delivery_attempt_is_deferred_when_submit_timeout_would_cross_tick_deadline() {
        let now = Instant::now();
        let deadline = now + DELIVERY_SUBMIT_TIMEOUT - Duration::from_millis(1);

        assert!(
            !has_budget_for_delivery_attempt(now, deadline),
            "a delivery that could overrun the tick must be deferred before it writes to tmux"
        );
    }

    #[test]
    fn delivery_attempt_starts_when_submit_timeout_fits_before_tick_deadline() {
        let now = Instant::now();
        let deadline = now + DELIVERY_SUBMIT_TIMEOUT;

        assert!(
            has_budget_for_delivery_attempt(now, deadline),
            "a delivery with enough remaining tick budget must not be deferred"
        );
    }
}
