use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::agent_prompt_delivery::{
    current_composer_text, is_agent_input_composer_chrome_text,
    is_agent_input_composer_tail_chrome, is_agent_input_horizontal_rule, strip_agent_prompt_marker,
};
use crate::atomic_write::write_json_atomic;
use crate::backlog_metrics::{
    AGENT_INPUT_DELIVERY_BACKLOG, BacklogMetricSnapshot, backlog_metric, record_backlog_error,
};
use crate::daemon_state::{metadata_state_path, save_metadata_state, try_load_metadata_state};
use crate::debug_logging::{LogLevel, log_at};
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::state_update_lock::acquire_state_update_lock;

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
use super::session_visibility::LIVE_SESSION_STATUSES;

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
    /// `pub` so a test can hold it.
    ///
    /// Not a test hook: production really does hold this from another thread --
    /// the enqueue path takes it while the tick is running -- and the gate for
    /// "the tick does not wait for this lock on an async worker" has no way to
    /// create that state otherwise. Everything that takes it in production is
    /// in this module and holds it across a bounded file operation; a caller
    /// outside the module holding it across anything longer is the bug this
    /// accessor makes testable, not one it introduces.
    pub fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
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
pub struct AgentInputDeliveryState {
    version: u64,
    pending: Vec<PendingAgentInputDelivery>,
}

enum QueuedDeliveryTarget {
    Deliverable(LiveSessionTarget),
    /// The agent is not running, so there is nothing to deliver into yet. A
    /// wait, not a failure: the input stays queued and the agent's own row
    /// carries it, and it goes in when the agent comes back.
    Waiting(String),
    /// Something broke. We could not ask whether the agent is running.
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
    let saved_pending = state.pending.clone();
    save_delivery_state(&path, state)?;
    // Published here as well as after a tick, so a message to an agent that is
    // not running reads as waiting the moment it is queued rather than on the
    // next pass.
    publish_queued_input_counts(context, &saved_pending);
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
        record_agent_input_delivery_queue_failure(
            context,
            QUEUE_LOAD_OPERATION,
            format!(
                "Skipped queued agent input delivery because {}",
                load_error_for_path(&path)
            ),
        );
        return;
    };
    clear_agent_input_delivery_queue_failure(context, QUEUE_LOAD_OPERATION);
    // Deliberately clears nothing here. An empty queue does not prove the last
    // write landed -- it is also what the disk looks like when the write is
    // what failed -- so a save failure stays until a save succeeds. It records
    // input that was lost, and that loss does not resolve itself.
    if state.pending.is_empty() {
        backlog_metric(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
        )
        .set_depth(0);
        // Clears the agent rows too. Returning here without publishing left a
        // count on a row whose queue was already empty -- for ever, because
        // nothing else writes or clears it.
        publish_queued_input_counts(context, &[]);
        return;
    }

    let mut remaining = Vec::new();
    // Sessions whose stale banner this pass wants to retire, and sessions this
    // pass raised a banner for. A session in both keeps its banner.
    let mut retiring = BTreeSet::<String>::new();
    let mut reported = BTreeSet::<String>::new();
    let mut ready = VecDeque::from(deduplicate_pending_agent_input_deliveries(state.pending));
    let mut delivery_attempts = 0usize;
    while let Some(pending) = ready.pop_front() {
        if delivery_attempts >= MAX_DELIVERY_ATTEMPTS_PER_TICK {
            remaining.push(pending);
            remaining.extend(ready);
            break;
        }
        let target = match resolve_queued_delivery_target(context, &pending, now_ms) {
            QueuedDeliveryTarget::Deliverable(target) => target,
            QueuedDeliveryTarget::Waiting(reason) => {
                // Whatever banner an earlier tick raised about this session
                // described a probe against a window, and the session has
                // since moved on to a state the dashboard already shows on its
                // own row -- offline, or live without a binding. Nothing else
                // retires that record: it is cleared only where a delivery
                // SUCCEEDS, which a session in this state can never reach, so
                // without this it outlives its own truth for ever. Measured on
                // one project, a probe failure from five days earlier was
                // still the banner on the dashboard.
                //
                // Deferred to the end of the pass rather than done here: two
                // entries for ONE session can resolve differently in the same
                // drain -- one past its hold budget and so Blocked, a newer
                // one still Waiting -- and clearing inline would erase the
                // blocked banner the other entry had just raised.
                retiring.insert(pending.session_id.clone());
                log_at(
                    LogLevel::Debug,
                    "Agent input waiting for its agent",
                    "agent-input-delivery",
                    Some(json!({ "sessionId": pending.session_id, "message": reason })),
                );
                remaining.push(pending);
                continue;
            }
            QueuedDeliveryTarget::Blocked(reason) => {
                reported.insert(pending.session_id.clone());
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
                let attempt = match super::input_delivery_receipt::begin_input_delivery(
                    context,
                    &pending.session_id,
                    &target.window_id,
                ) {
                    Ok(attempt) => attempt,
                    Err(error) => {
                        record_agent_input_delivery_failure(
                            context,
                            Some(&pending.session_id),
                            "Agent input delivery receipt failed before send",
                            error,
                        );
                        remaining.push(pending);
                        continue;
                    }
                };
                match deliver_prompt_to_tmux_for_tool(
                    runtime,
                    &target.window_id,
                    &pending.prompt,
                    target.tool.as_deref(),
                ) {
                    Ok(verification) => {
                        let receipt = super::input_delivery_receipt::finish_input_delivery(
                            context,
                            &attempt,
                            Ok(verification),
                        );
                        clear_agent_input_delivery_failure(context, &pending.session_id);
                        log_at(
                            LogLevel::Info,
                            "queued agent input delivered",
                            "agent-input-delivery",
                            Some(json!({
                                "sessionId": pending.session_id,
                                "windowId": target.window_id,
                                "reason": reason,
                                "delivery": receipt,
                            })),
                        );
                    }
                    Err(error) => {
                        super::input_delivery_receipt::finish_input_delivery(
                            context,
                            &attempt,
                            Err(error.as_str()),
                        );
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

    for session_id in retiring.difference(&reported) {
        clear_agent_input_delivery_failure(context, session_id);
    }

    let state = AgentInputDeliveryState {
        version: 1,
        pending: remaining,
    };
    let depth = state.pending.len();
    let saved_pending = state.pending.clone();
    match save_delivery_state(&path, state) {
        Ok(()) => {
            clear_agent_input_delivery_queue_failure(context, QUEUE_SAVE_OPERATION);
            publish_queued_input_counts(context, &saved_pending);
            backlog_metric(
                AGENT_INPUT_DELIVERY_BACKLOG,
                Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
            )
            .set_depth(depth);
        }
        Err(error) => {
            record_backlog_error(
                AGENT_INPUT_DELIVERY_BACKLOG,
                Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
                error.clone(),
            );
            record_agent_input_delivery_queue_failure(
                context,
                QUEUE_SAVE_OPERATION,
                format!("Could not save queued agent input delivery state: {error}"),
            );
        }
    }
}

pub async fn run_pending_agent_input_deliveries_async(
    context: &Arc<ProjectServiceRequestContext>,
    now_ms: i64,
) -> Result<(), String> {
    let task_deadline = Instant::now()
        .checked_add(DELIVERY_TASK_TIMEOUT.saturating_sub(DELIVERY_TASK_COMMIT_MARGIN))
        .unwrap_or_else(Instant::now);
    let path = agent_input_delivery_queue_path(context.project_state_dir());
    let state = load_delivery_queue_off_the_worker(context, &path).await?;
    if state.pending.is_empty() {
        backlog_metric(
            AGENT_INPUT_DELIVERY_BACKLOG,
            Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
        )
        .set_depth(0);
        // Same as the sync runner: an empty queue clears the rows -- and off
        // the worker, because `publish_queued_input_counts` acquires a state
        // update lock whose retry loop sleeps up to ACQUIRE_TIMEOUT, then
        // reads and rewrites session metadata. This is the STEADY STATE path,
        // twice a second, so it was the worst of the three on this stack and
        // the one my first gate could not see.
        publish_queued_input_counts_off_the_worker(context, Vec::new()).await?;
        return Ok(());
    }

    let loaded_ids = state
        .pending
        .iter()
        .map(|pending| pending.id.clone())
        .collect::<BTreeSet<_>>();
    let pending = deduplicate_pending_agent_input_deliveries(state.pending);
    let mut remaining = Vec::new();
    // Sessions whose stale banner this pass wants to retire, and sessions this
    // pass raised a banner for. A session in both keeps its banner.
    let mut retiring = BTreeSet::<String>::new();
    let mut reported = BTreeSet::<String>::new();
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
        let resolved =
            match resolve_queued_delivery_target_off_the_worker(context, &pending, now_ms).await {
                Ok(resolved) => resolved,
                // A hop that never ran is a failure of the tick, not a target that
                // could not be resolved: collapsing it into Waiting or Blocked
                // would report an agent problem for a pool problem.
                Err(error) => {
                    failures.push(error);
                    remaining.push(pending);
                    continue;
                }
            };
        let target = match resolved {
            QueuedDeliveryTarget::Deliverable(target) => target,
            QueuedDeliveryTarget::Waiting(reason) => {
                // No `failures.push` either: an agent that is not running is
                // not a failed tick, and reporting one every half second is
                // how a wait became an error on every project.
                //
                // See the sibling branch above for why the stale banner is
                // retired, and why it waits until the pass is over.
                retiring.insert(pending.session_id.clone());
                log_at(
                    LogLevel::Debug,
                    "Agent input waiting for its agent",
                    "agent-input-delivery",
                    Some(json!({ "sessionId": pending.session_id, "message": reason })),
                );
                remaining.push(pending);
                continue;
            }
            QueuedDeliveryTarget::Blocked(reason) => {
                reported.insert(pending.session_id.clone());
                record_agent_input_delivery_failure_off_the_worker(
                    context,
                    Some(&pending.session_id),
                    "Agent input delivery blocked",
                    reason.clone(),
                )
                .await;
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
                    record_agent_input_delivery_failure_off_the_worker(
                        context,
                        Some(&pending.session_id),
                        "Agent input delivery held",
                        reason.clone(),
                    )
                    .await;
                    failures.push(reason);
                }
                remaining.push(pending);
            }
            AgentInputDeliveryDecision::DeliverNow { reason } => {
                delivery_attempts += 1;
                // Off the worker: this takes the metadata state-update lock
                // and can sleep in its retry loop until ACQUIRE_TIMEOUT.
                let attempt =
                    match super::input_delivery_receipt::begin_input_delivery_off_the_worker(
                        context,
                        pending.session_id.clone(),
                        target.window_id.clone(),
                    )
                    .await
                    {
                        Ok(attempt) => attempt,
                        Err(error) => {
                            failures.push(error.clone());
                            record_agent_input_delivery_failure_off_the_worker(
                                context,
                                Some(&pending.session_id),
                                "Agent input delivery receipt failed before send",
                                error,
                            )
                            .await;
                            remaining.push(pending);
                            continue;
                        }
                    };
                match deliver_prompt_to_tmux_async_for_tool(
                    &target.window_id,
                    &pending.prompt,
                    DELIVERY_SUBMIT_TIMEOUT,
                    target.tool.as_deref(),
                )
                .await
                {
                    Ok(verification) => {
                        // A join failure is reported, not logged as a null
                        // receipt. My first version of this hop wrote
                        // `.unwrap_or(Value::Null)` here, which would have put
                        // `"delivery": null` in a line that says the input was
                        // delivered, with nothing anywhere saying the receipt
                        // write never finished.
                        let receipt =
                            match super::input_delivery_receipt::finish_input_delivery_off_the_worker(
                                context,
                                attempt,
                                Ok(verification),
                            )
                            .await
                            {
                                Ok(receipt) => receipt,
                                Err(error) => {
                                    failures.push(error.clone());
                                    record_agent_input_delivery_failure_off_the_worker(
                                        context,
                                        Some(&pending.session_id),
                                        "Agent input delivery receipt did not finish",
                                        error,
                                    ).await;
                                    continue;
                                }
                            };
                        clear_agent_input_delivery_failure_off_the_worker(
                            context,
                            &pending.session_id,
                        )
                        .await;
                        log_at(
                            LogLevel::Info,
                            "queued agent input delivered",
                            "agent-input-delivery",
                            Some(json!({
                                "sessionId": pending.session_id,
                                "windowId": target.window_id,
                                "reason": reason,
                                "delivery": receipt,
                            })),
                        );
                    }
                    Err(error) => {
                        // The receipt Value was discarded here before and still
                        // is -- but a JOIN failure is not the same as a
                        // discarded value, so it is collected rather than
                        // swallowed by a bare `let _ =`.
                        if let Err(join_error) =
                            super::input_delivery_receipt::finish_input_delivery_off_the_worker(
                                context,
                                attempt,
                                Err(error.clone()),
                            )
                            .await
                        {
                            failures.push(join_error);
                        }
                        record_agent_input_delivery_failure_off_the_worker(
                            context,
                            Some(&pending.session_id),
                            "Agent input delivery failed",
                            error.clone(),
                        )
                        .await;
                        failures.push(error);
                        remaining.push(pending);
                    }
                }
            }
        }
    }

    for session_id in retiring.difference(&reported) {
        clear_agent_input_delivery_failure_off_the_worker(context, session_id).await;
    }

    let merge_failures =
        merge_and_save_delivery_queue_off_the_worker(context, path, remaining, loaded_ids).await?;
    failures.extend(merge_failures);
    finish_agent_input_delivery_task(failures)
}

/// Each of these is a named `async fn` rather than an inline `spawn_blocking`
/// at the call site, and that is deliberate.
///
/// My first gate drove the whole tick with the queue lock held, and it proved
/// only the FIRST of the three spans: every task parked in the load and never
/// returned, and even with a free lock an empty queue returns before the merge.
/// Put the merge back inline on the worker and that gate passed unchanged --
/// a review caught it, and I reproduced it. A test that proves the half
/// already safe is the shape I have hit five times on this branch.
///
/// Naming each hop gives each one a gate that drives the real production call,
/// and each is mutation-proved on its own.
pub async fn load_delivery_queue_off_the_worker(
    context: &Arc<ProjectServiceRequestContext>,
    path: &Path,
) -> Result<AgentInputDeliveryState, String> {
    let context = Arc::clone(context);
    let path = path.to_path_buf();
    crate::async_runtime::spawn_blocking_named(
        crate::async_runtime::scoped_task_name(
            AGENT_INPUT_DELIVERY_TASK_NAME,
            "queue-load",
            "project-service",
        ),
        move || load_delivery_queue_under_lock(&context, &path),
    )
    .await
    // A pool task that never ran is not an unreadable queue.
    .map_err(|error| format!("agent input delivery queue load did not finish: {error}"))?
}

/// Record a delivery failure without holding an async worker.
///
/// `record_agent_input_delivery_failure` read-modify-writes
/// `dashboard-operation-failures.json` and may mirror a notification.
async fn record_agent_input_delivery_failure_off_the_worker(
    context: &Arc<ProjectServiceRequestContext>,
    session_id: Option<&str>,
    title: &'static str,
    message: String,
) {
    let context = Arc::clone(context);
    let session_id = session_id.map(str::to_owned);
    let joined = crate::async_runtime::spawn_blocking_named(
        crate::async_runtime::scoped_task_name(
            AGENT_INPUT_DELIVERY_TASK_NAME,
            "failure-record",
            "project-service",
        ),
        move || {
            record_agent_input_delivery_failure(&context, session_id.as_deref(), title, message);
        },
    )
    .await;
    if let Err(error) = joined {
        // Not silently dropped: a pool task that never ran means the failure
        // the caller was reporting is now unrecorded, and saying so is the only
        // way anyone finds out.
        log_at(
            LogLevel::Warn,
            "Agent input delivery failure was not recorded",
            "agent-input-delivery",
            Some(json!({ "error": error.to_string() })),
        );
    }
}

/// Clear a delivery failure without holding an async worker.
///
/// This is the steady-state one: the end-of-tick retiring loop runs it per
/// offline session on every tick.
async fn clear_agent_input_delivery_failure_off_the_worker(
    context: &Arc<ProjectServiceRequestContext>,
    session_id: &str,
) {
    let context = Arc::clone(context);
    let session_id = session_id.to_owned();
    let joined = crate::async_runtime::spawn_blocking_named(
        crate::async_runtime::scoped_task_name(
            AGENT_INPUT_DELIVERY_TASK_NAME,
            "failure-clear",
            "project-service",
        ),
        move || clear_agent_input_delivery_failure(&context, &session_id),
    )
    .await;
    if let Err(error) = joined {
        log_at(
            LogLevel::Warn,
            "Agent input delivery failure was not cleared",
            "agent-input-delivery",
            Some(json!({ "error": error.to_string() })),
        );
    }
}

/// Resolve one queued entry's target without holding an async worker.
///
/// `resolve_queued_delivery_target` reads the runtime topology file through
/// `resolve_live_session_target`, once per queued entry. Inline on the async
/// path that is a file read on one of TWO workers, per entry, every tick.
async fn resolve_queued_delivery_target_off_the_worker(
    context: &Arc<ProjectServiceRequestContext>,
    pending: &PendingAgentInputDelivery,
    now_ms: i64,
) -> Result<QueuedDeliveryTarget, String> {
    let context = Arc::clone(context);
    // Only the three fields the resolve actually reads, NOT a clone of the
    // whole entry: `prompt` is the agent input itself and can be kilobytes,
    // and copying it per entry per tick to a callee that never looks at it is
    // pure cost at 2 Hz.
    let probe = PendingAgentInputDelivery {
        id: String::new(),
        session_id: pending.session_id.clone(),
        window_id: pending.window_id.clone(),
        prompt: String::new(),
        created_at_ms: pending.created_at_ms,
        max_deliver_at_ms: pending.max_deliver_at_ms,
        hold_reason: String::new(),
    };
    crate::async_runtime::spawn_blocking_named(
        crate::async_runtime::scoped_task_name(
            AGENT_INPUT_DELIVERY_TASK_NAME,
            "target-resolve",
            "project-service",
        ),
        move || resolve_queued_delivery_target(&context, &probe, now_ms),
    )
    .await
    // A pool task that never ran is not an unresolvable target.
    .map_err(|error| format!("agent input delivery target resolve did not finish: {error}"))
}

/// Publishes the queued-input counts off the worker.
///
/// `publish_queued_input_counts` acquires a state update lock whose retry loop
/// sleeps, then reads and rewrites session metadata. On the empty-queue path
/// that runs twice a second in the steady state.
pub async fn publish_queued_input_counts_off_the_worker(
    context: &Arc<ProjectServiceRequestContext>,
    pending: Vec<PendingAgentInputDelivery>,
) -> Result<(), String> {
    let context = Arc::clone(context);
    crate::async_runtime::spawn_blocking_named(
        crate::async_runtime::scoped_task_name(
            AGENT_INPUT_DELIVERY_TASK_NAME,
            "publish-counts",
            "project-service",
        ),
        move || publish_queued_input_counts(&context, &pending),
    )
    .await
    .map_err(|error| format!("agent input delivery count publish did not finish: {error}"))
}

/// Merges, saves and republishes off the worker.
pub async fn merge_and_save_delivery_queue_off_the_worker(
    context: &Arc<ProjectServiceRequestContext>,
    path: PathBuf,
    remaining: Vec<PendingAgentInputDelivery>,
    loaded_ids: BTreeSet<String>,
) -> Result<Vec<String>, String> {
    let context = Arc::clone(context);
    crate::async_runtime::spawn_blocking_named(
        crate::async_runtime::scoped_task_name(
            AGENT_INPUT_DELIVERY_TASK_NAME,
            "merge-and-save",
            "project-service",
        ),
        move || merge_and_save_delivery_queue(&context, &path, remaining, &loaded_ids),
    )
    .await
    // A pool task that never ran is not an empty failure list.
    .map_err(|error| format!("agent input delivery merge did not finish: {error}"))
}

/// Reads the queue under the shared lock.
///
/// Separate from its async caller for the same reason as
/// `merge_and_save_delivery_queue`: a function that waits for this lock on an
/// async worker parks it, and the project service runs two.
///
/// `Err` is the queue being unreadable, which is not the same as an empty
/// queue and is reported rather than skipped.
fn load_delivery_queue_under_lock(
    context: &ProjectServiceRequestContext,
    path: &Path,
) -> Result<AgentInputDeliveryState, String> {
    let _guard = context.agent_input_delivery_queue.lock();
    match load_delivery_state(path) {
        Ok(state) => {
            clear_agent_input_delivery_queue_failure(context, QUEUE_LOAD_OPERATION);
            Ok(state)
        }
        Err(_) => {
            let error = load_error_for_path(path);
            record_backlog_error(
                AGENT_INPUT_DELIVERY_BACKLOG,
                Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
                error.clone(),
            );
            record_agent_input_delivery_queue_failure(
                context,
                QUEUE_LOAD_OPERATION,
                format!("Skipped queued agent input delivery because {error}"),
            );
            Err(format!("agent input delivery queue unavailable: {error}"))
        }
    }
}

/// Merges the queue back, saves it, and republishes the counts.
///
/// Separate from its async caller so the whole span can run on the blocking
/// pool. It holds the shared delivery-queue lock from its first line to its
/// last, and in that span it does a file read, a `write_json_atomic` -- a temp
/// file plus a rename -- and `publish_queued_input_counts`, which on a changed
/// fingerprint takes a lock directory and rewrites session metadata. That
/// function's own comment says doing it twice a second eats the budget the tick
/// has for actually delivering.
///
/// It used to run inline on the project service's async worker, because
/// `AgentInputDeliveryTask::run` awaits its caller directly and
/// `periodic_scheduler.rs` awaits task futures on its own async task -- the
/// `spawn_blocking_named` in that file is for alert sinks, not task bodies. The
/// daemon's ten `PeriodicTask` impls each offload their own body; this one did
/// not, which is the same defect the two daemon stream interceptors had.
///
/// Returns the failures it collected rather than taking a `&mut Vec`, so the
/// closure that runs it owns everything it touches.
fn merge_and_save_delivery_queue(
    context: &ProjectServiceRequestContext,
    path: &Path,
    remaining: Vec<PendingAgentInputDelivery>,
    loaded_ids: &BTreeSet<String>,
) -> Vec<String> {
    let mut failures = Vec::new();
    let _guard = context.agent_input_delivery_queue.lock();
    let mut pending = remaining;
    match load_delivery_state(path) {
        Ok(current) => {
            clear_agent_input_delivery_queue_failure(context, QUEUE_MERGE_OPERATION);
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
            record_agent_input_delivery_queue_failure(
                context,
                QUEUE_MERGE_OPERATION,
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
    let saved_pending = state.pending.clone();
    match save_delivery_state(path, state) {
        Ok(()) => {
            clear_agent_input_delivery_queue_failure(context, QUEUE_SAVE_OPERATION);
            publish_queued_input_counts(context, &saved_pending);
            backlog_metric(
                AGENT_INPUT_DELIVERY_BACKLOG,
                Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
            )
            .set_depth(depth);
        }
        Err(error) => {
            record_backlog_error(
                AGENT_INPUT_DELIVERY_BACKLOG,
                Some(AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY),
                error.clone(),
            );
            record_agent_input_delivery_queue_failure(
                context,
                QUEUE_SAVE_OPERATION,
                format!("Could not save queued agent input delivery state: {error}"),
            );
            failures.push(error);
        }
    }
    failures
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
    now_ms: i64,
) -> QueuedDeliveryTarget {
    let settled = now_ms >= pending.max_deliver_at_ms;
    match resolve_live_session_target(context, &pending.session_id) {
        Ok(Some(target)) => QueuedDeliveryTarget::Deliverable(target),
        // "No target" is three different answers, and only one of them is a
        // wait. An agent the dashboard shows as OFFLINE will be back, and its
        // row carries the count. An agent the dashboard shows as RUNNING with
        // no usable window binding cannot receive anything and nobody would
        // know -- the topology attaches `tmuxTarget` only when the session,
        // window id and index are all present, and unbound live rows are a
        // shape the runtime has a repair pass for. And an agent with no
        // dashboard row at all -- graveyarded, stopped, deleted -- has no
        // surface that could carry a chip, so the project-level record is the
        // only place left to say it.
        Ok(None) => match queued_session_disposition(context, &pending.session_id) {
            // Reported only once the entry has outlived the hold budget it was
            // given at enqueue.
            QueuedSessionDisposition::ComingBack => QueuedDeliveryTarget::Waiting(format!(
                "Holding queued input for {} until it is running again; it is offline and the queued target {} is stale",
                pending.session_id, pending.window_id
            )),
            // Both of these are reported, but not instantly. A live row is
            // briefly unbound while its window is being created, and a restart
            // rewrites the topology, so a message sent in that moment would
            // raise a banner for an ordinary lifecycle event -- which is the
            // noise this whole change is about, in a new costume. The entry
            // carries a deadline nothing read until now: before it, hold
            // quietly; after it, say so.
            // It has a row, so the row says it. Keying a banner to the
            // ENTRY's age was wrong twice over: a message that waited out an
            // offline agent is always past its deadline, so the first tick
            // where that agent came back unbound would have raised one, and
            // the condition the banner would describe is the one the chip
            // already describes on a row the dashboard is showing.
            QueuedSessionDisposition::RunningButUnbound => QueuedDeliveryTarget::Waiting(format!(
                "Holding queued input for {} until its window exists; it is live with no tmux binding and the queued target {} is stale",
                pending.session_id, pending.window_id
            )),
            // No row anywhere, and the message has outlived the hold budget it
            // was given: the project record is the only surface left.
            QueuedSessionDisposition::Gone if settled => QueuedDeliveryTarget::Blocked(format!(
                "Kept queued input for {} because that agent is no longer on this project; the queued target {} is stale",
                pending.session_id, pending.window_id
            )),
            QueuedSessionDisposition::Gone => QueuedDeliveryTarget::Waiting(format!(
                "Holding queued input for {} while the topology settles; the queued target {} is stale",
                pending.session_id, pending.window_id
            )),
        },
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
    // One spelling of "this is the composer telling you it is empty".
    // `is_empty_composer_placeholder` matched the two placeholders
    // case-sensitively while `is_agent_input_composer_chrome_text` matched the
    // same two lowercased, and `current_composer_text` already filters them --
    // three readings of one fact, one of them unreachable.
    !text.is_empty() && !is_agent_input_composer_chrome_text(text)
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

    // Text on the marker line is the user's, unless it is the composer saying
    // it is empty.
    if !prompt_text.is_empty() && !is_agent_input_composer_chrome_text(prompt_text) {
        return false;
    }

    // The composer ends at its own closing rule when the agent draws one, and
    // at a blank line when it does not. What comes after is the agent's status
    // area whatever it says.
    //
    // This used to require every row below to be a chrome spelling we had
    // enumerated, and that is not knowable: the status line is a
    // user-configured `statusLine` command, so one row we have never seen --
    // "Context low (23% remaining) · Run /compact", an update notice, a
    // compaction banner -- made an EMPTY composer read as unsubmitted user
    // input. That both held queued delivery back and reported every submission
    // to that pane unverified. Claude closes its composer with a rule and
    // Codex with a blank line, which is structure rather than vocabulary.
    let under = lines[prompt_index + 1..]
        .iter()
        .map(|line| line.trim())
        .collect::<Vec<_>>();
    // A blank row is only the end of the composer when the agent has no rule
    // to close it with. Treating it as the end either way made `❯ `, a blank,
    // and then what the user had typed read as an empty composer -- and an
    // empty composer is one aimux types into.
    // Any rule below, not just one before the first blank: a draft whose first
    // row is blank puts the composer's own closing rule AFTER that blank, and
    // stopping at the blank would read `❯ `, a blank, and then what the user
    // typed as an empty composer. The cost is that a rule somewhere in a
    // blank-closing agent's status area would send this past the blank, and
    // then a status row nobody has enumerated reads as user input -- delivery
    // held back rather than typed over, and neither Claude nor Codex draws one
    // there today.
    let closes_with_a_rule = under
        .iter()
        .any(|line| is_agent_input_horizontal_rule(line));
    under
        .iter()
        .take_while(|line| {
            if closes_with_a_rule {
                !is_agent_input_horizontal_rule(line)
            } else {
                !line.is_empty()
            }
        })
        .all(|line| {
            line.is_empty()
                || is_agent_input_composer_chrome_text(line)
                || is_agent_input_composer_tail_chrome(line)
        })
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

/// The queue is its own target. See `clear_agent_input_delivery_queue_failure`.
pub(crate) const AGENT_INPUT_QUEUE_TARGET_KIND: &str = "agent-input-queue";

/// Reading the queue and writing it back are different failures with different
/// recoveries, and they MUST NOT share a key. Collapsed into one, a healthy
/// load every 500ms cleared the save failure that had just lost a user's
/// queued input -- within half a second, and before any surface drew it.
const QUEUE_LOAD_OPERATION: &str = "input.delivery.queue.load";
const QUEUE_SAVE_OPERATION: &str = "input.delivery.queue.save";
/// Re-reading the queue to merge back what arrived while the task ran. It is a
/// READ, and the write that follows it in the same call succeeds almost always
/// -- `save_delivery_state` rewrites the file the read could not parse. Under
/// the save's key this failure was cleared microseconds after it was recorded.
const QUEUE_MERGE_OPERATION: &str = "input.delivery.queue.merge";

fn record_agent_input_delivery_queue_failure(
    context: &ProjectServiceRequestContext,
    operation: &str,
    message: impl Into<String>,
) {
    let message = message.into();
    log_at(
        LogLevel::Warn,
        "Agent input delivery queue unavailable",
        "agent-input-delivery",
        Some(json!({ "operation": operation, "message": message })),
    );
    let _ = add_dashboard_operation_failure(
        context.project_state_dir(),
        OperationFailureInput {
            target_kind: AGENT_INPUT_QUEUE_TARGET_KIND.into(),
            operation: operation.into(),
            title: "Agent input delivery queue unavailable".into(),
            message,
            ..OperationFailureInput::default()
        },
    );
}

/// What the agent row needs to say "your message is waiting".
///
/// Nothing in production read the delivery queue except the task that drains
/// it, so an input queued for an agent whose window is gone was invisible
/// everywhere except a project-level failure banner -- which is the wrong
/// surface for a wait, and the only reason that banner could not be removed.
/// The count rides the session's own metadata, which every surface already
/// reads.
fn publish_queued_input_counts(
    context: &ProjectServiceRequestContext,
    pending: &[PendingAgentInputDelivery],
) {
    let mut counts: BTreeMap<&str, (i64, i64)> = BTreeMap::new();
    for entry in pending {
        let slot = counts
            .entry(entry.session_id.as_str())
            .or_insert((0, entry.created_at_ms));
        slot.0 += 1;
        slot.1 = slot.1.min(entry.created_at_ms);
    }
    let directory = context.project_state_dir();
    // Nothing to do when nothing moved, and that is the steady state: this
    // runs on every enqueue and every delivery tick, and taking a lock
    // directory and rewriting session metadata twice a second inside the tick
    // eats the budget the tick has for actually delivering. A test that
    // asserts its queue drained started failing about one run in six until
    // this was here.
    let fingerprint = counts
        .iter()
        .map(|(session_id, (count, oldest))| format!("{session_id}:{count}:{oldest}"))
        .collect::<Vec<_>>()
        .join(",");
    if published_fingerprint(&directory) == Some(fingerprint.clone()) {
        return;
    }
    // Reported, not swallowed. With the project-level banner gone for a wait,
    // a metadata write that fails silently would leave Sam with no surface at
    // all saying his message is queued.
    let lock = match acquire_state_update_lock(&metadata_state_path(&directory)) {
        Ok(lock) => lock,
        Err(error) => {
            record_agent_input_delivery_failure(
                context,
                None,
                "Queued agent input could not be published",
                format!("could not take the metadata lock: {error}"),
            );
            return;
        }
    };
    let mut state = match try_load_metadata_state(&directory) {
        Ok(state) => state,
        Err(error) => {
            record_agent_input_delivery_failure(
                context,
                None,
                "Queued agent input could not be published",
                format!("could not read session metadata: {error}"),
            );
            return;
        }
    };
    let mut changed = false;
    for (session_id, session) in state.sessions.iter_mut() {
        let Some(object) = session.as_object_mut() else {
            continue;
        };
        let wanted = counts
            .get(session_id.as_str())
            .map(|(count, oldest)| json!({ "count": count, "oldestCreatedAtMs": oldest }));
        match wanted {
            Some(value) => {
                if object.get("queuedInput") != Some(&value) {
                    object.insert("queuedInput".into(), value);
                    changed = true;
                }
            }
            None => {
                if object.remove("queuedInput").is_some() {
                    changed = true;
                }
            }
        }
    }
    // Only sessions that already have a metadata row. Minting one for a
    // session id with nothing behind it -- a deleted agent whose queue entry
    // outlived it, since `delete_agent_assets` removes the metadata row and
    // leaves the queue alone -- would re-create that row on every tick, and
    // `plugin_project_service_host` reads a metadata row as a transcript
    // source. A session with no row has no dashboard row either, so there is
    // no surface the count could have reached anyway.
    if !changed {
        return;
    }
    if let Err(error) = lock.ensure_owned_for_commit() {
        record_agent_input_delivery_failure(
            context,
            None,
            "Queued agent input could not be published",
            format!("lost the metadata lock before writing: {error}"),
        );
        return;
    }
    if let Err(error) = save_metadata_state(&directory, &state) {
        record_agent_input_delivery_failure(
            context,
            None,
            "Queued agent input could not be published",
            format!("could not write session metadata: {error}"),
        );
        return;
    }
    // Recorded only now. Recording intent before the write meant one contended
    // metadata lock -- a 2s timeout against receipts, status and hooks -- left
    // the cache claiming a state it had never written, and the chip never came
    // back for that queue.
    remember_published_fingerprint(&directory, fingerprint);
    context.project_events.publish_project_update(
        context.project_root(),
        crate::project_api_contract::invalidations::RUNTIME_SESSION.to_vec(),
        "queued agent input changed".to_owned(),
        None,
        None,
    );
}

/// Which of the three "no window" answers this is.
enum QueuedSessionDisposition {
    /// On the dashboard as offline: its row carries the queued count.
    ComingBack,
    /// On the dashboard as live, but with no window to deliver into.
    RunningButUnbound,
    /// No row on any surface -- graveyarded, stopped, or gone entirely.
    Gone,
}

fn queued_session_disposition(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> QueuedSessionDisposition {
    let Ok(topology) = read_runtime_topology(runtime_topology_path(context.project_state_dir()))
    else {
        // The caller only reaches here on `Ok(None)`, so the topology was
        // readable a moment ago; if it is not now, say the least.
        return QueuedSessionDisposition::Gone;
    };
    let status = list_topology_session_states(&topology, None)
        .into_iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        .and_then(|session| {
            session
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    match status.as_deref() {
        Some("offline") => QueuedSessionDisposition::ComingBack,
        Some(status) if LIVE_SESSION_STATUSES.contains(&status) => {
            QueuedSessionDisposition::RunningButUnbound
        }
        _ => QueuedSessionDisposition::Gone,
    }
}

fn published_fingerprints() -> &'static Mutex<BTreeMap<PathBuf, String>> {
    static PUBLISHED: OnceLock<Mutex<BTreeMap<PathBuf, String>>> = OnceLock::new();
    PUBLISHED.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn published_fingerprint(directory: &Path) -> Option<String> {
    published_fingerprints()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(directory)
        .cloned()
}

fn remember_published_fingerprint(directory: &Path, fingerprint: String) {
    published_fingerprints()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(directory.to_path_buf(), fingerprint);
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
            target_kind: if session_id.is_some() {
                "agent".into()
            } else {
                AGENT_INPUT_QUEUE_TARGET_KIND.into()
            },
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

/// What failed is the queue, not an agent, and saying so is what makes it
/// clearable: a matcher with no `targetId` matches ANY target id, so a clear
/// written against `agent` would take every live per-session delivery failure
/// with it. Nothing cleared this class before and it aged off in fifteen
/// minutes; a durable copy has to be released when the queue loads.
fn clear_agent_input_delivery_queue_failure(
    context: &ProjectServiceRequestContext,
    operation: &str,
) {
    let _ = clear_dashboard_operation_failures(
        context.project_state_dir(),
        OperationFailureMatch {
            target_kind: Some(AGENT_INPUT_QUEUE_TARGET_KIND.into()),
            operation: Some(operation.to_owned()),
            target_id: None,
            worktree_path: WorktreePathMatch::Any,
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

    /// The per-entry topology read does not hold an async worker.
    ///
    /// `run_pending_agent_input_deliveries_async` resolves a target for EVERY
    /// queued entry, and `resolve_queued_delivery_target` reaches
    /// `resolve_live_session_target`, which reads the runtime topology file.
    /// That read happened inline on the async worker, once per entry, on a
    /// pool of two.
    ///
    /// WHY THIS IS GATEABLE AT ALL, which is what kept it unproven: a progress
    /// gate cannot see a bounded park, and a latency gate is what made these
    /// checks flaky. Both true. The way out is not to watch a bounded park but
    /// to CONTROL THE RESOURCE so the park is unbounded -- the same move that
    /// proved the task-list route, where a listener that accepts and never
    /// replies turned a timeout into a permanent hold. The filesystem
    /// equivalent is a FIFO: `read_runtime_topology` calls
    /// `fs::read_to_string`, and opening a named pipe with no writer blocks
    /// forever. A read that normally takes microseconds becomes a permanent
    /// occupation of whatever thread it is on, so "did the runtime stop making
    /// progress" is answerable with no budget at all.
    ///
    /// This drives the HOP, not the whole tick, which is why it is stable. My
    /// first version drove `run_pending_agent_input_deliveries_async` to
    /// "prove the route" and it passed alone and FAILED inside the full suite:
    /// past the resolve a tick does real work on the worker -- delivery
    /// attempts, metrics, logging -- so the probe was competing with
    /// legitimate worker use and the verdict moved with machine load. The call
    /// site is covered by `the_delivery_tick_resolves_targets_off_the_worker`
    /// in tests/project_service_scheduler.rs instead, which is the division of
    /// labour #536 settled on.
    ///
    /// It lives in this module rather than beside its sibling gates because
    /// `QueuedDeliveryTarget` names `pub(super) LiveSessionTarget`, and
    /// widening the crate's public API to let a test reach a hop is the wrong
    /// trade.
    #[test]
    fn the_per_entry_topology_read_does_not_consume_an_async_worker() {
        const WORKERS: usize = crate::async_runtime::ASYNC_RUNTIME_WORKER_THREADS;
        const PHASE_TWO_ROUNDS: usize = 20;
        const PHASE_TWO_SETTLE: Duration = Duration::from_millis(10);
        let attempts = WORKERS + 2;
        let quiet_window = Duration::from_secs(30);

        let root = std::env::temp_dir().join(format!("aimux-topology-read-{}", std::process::id()));
        let state_dir = root.join("state");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&state_dir).expect("state dir");

        // The topology as a FIFO with no writer. Every open blocks forever.
        let topology = crate::runtime_topology::runtime_topology_path(&state_dir);
        let made = std::process::Command::new("mkfifo")
            .arg(&topology)
            .status()
            .expect("mkfifo runs");
        assert!(
            made.success(),
            "could not create the FIFO this gate depends on; without it the read returns instantly and the gate proves nothing"
        );

        let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            &root,
            state_dir.clone(),
        ));
        let pending = PendingAgentInputDelivery {
            id: "d1".to_owned(),
            session_id: "s1".to_owned(),
            window_id: "w1".to_owned(),
            prompt: "hello".to_owned(),
            created_at_ms: 0,
            max_deliver_at_ms: 0,
            hold_reason: String::new(),
        };

        let async_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(WORKERS)
            .enable_all()
            .build()
            .expect("a runtime with the project service's worker count");
        let entered = async_runtime.enter();

        let (polled_tx, polled) = std::sync::mpsc::channel();
        for index in 0..attempts {
            let hop_context = Arc::clone(&context);
            let hop_pending = pending.clone();
            let polled_tx = polled_tx.clone();
            async_runtime.spawn(async move {
                polled_tx.send(index).expect("the test is still listening");
                let _ =
                    resolve_queued_delivery_target_off_the_worker(&hop_context, &hop_pending, 0)
                        .await;
            });
        }
        drop(polled_tx);

        let mut reported = 0;
        while reported < attempts {
            match polled.recv_timeout(quiet_window) {
                Ok(_) => reported += 1,
                Err(_) => break,
            }
        }

        // Phase two probes REPEATEDLY, for the reason #535 established: each
        // hop reports before it awaits, so the barrier clears while the hops
        // are still short of the read, and a single probe runs on a worker
        // that is not parked yet and passes.
        let mut still_polling = true;
        for _ in 0..PHASE_TWO_ROUNDS {
            std::thread::sleep(PHASE_TWO_SETTLE);
            let (yielded_tx, yielded) = std::sync::mpsc::channel();
            async_runtime.spawn(async move {
                tokio::task::yield_now().await;
                let _ = yielded_tx.send(());
            });
            if yielded.recv_timeout(quiet_window).is_err() {
                still_polling = false;
                break;
            }
        }

        // Tear the runtime down WITHOUT waiting for its blocking tasks.
        // Dropping a multi-thread runtime waits for them, and a read parked on
        // a writerless FIFO never returns, so the test hung at teardown
        // instead of reporting -- which it did, twice, before I stopped trying
        // to drain the pipe and started declining to wait.
        drop(entered);
        async_runtime.shutdown_background();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(
            reported, attempts,
            "{reported} of {attempts} hops were polled on {WORKERS} workers and then nothing more happened for {quiet_window:?}: the per-entry topology read is holding a worker while it waits on the file"
        );
        assert!(
            still_polling,
            "every hop was polled, but a task that only yields then went {quiet_window:?} without running. The workers are occupied, which is what happens when the per-entry topology read runs inline on the worker rather than on the blocking pool"
        );
    }

    /// The delivery failure-store writes do not hold an async worker.
    ///
    /// `record_agent_input_delivery_failure` and
    /// `clear_agent_input_delivery_failure` both read-modify-write
    /// `dashboard-operation-failures.json`, and the async tick called them
    /// inline on a pool of two workers. The clear is the one that matters: the
    /// end-of-tick `retiring.difference(&reported)` loop runs it per session on
    /// the WAITING path, which is the steady state whenever a queued agent is
    /// offline, so it is a file read and write per offline session on every
    /// tick with nothing ever delivered.
    ///
    /// Same technique as the topology read: a FIFO with no writer at the store
    /// path makes `load_state` block forever, because it guards with
    /// `path.exists()` -- which is TRUE for a FIFO -- and then calls
    /// `fs::read_to_string`. Both entry points read before they write, so they
    /// park in the read and never reach `save_state`.
    ///
    /// This drives the HOPS rather than the tick, for the reason #540 settled:
    /// a gate driving the whole tick competes with the real work a tick does on
    /// a worker and its verdict moves with machine load. The specific
    /// steady-state call site is covered by
    /// `the_delivery_tick_clears_failures_off_the_worker`.
    #[test]
    fn the_delivery_failure_store_writes_do_not_consume_an_async_worker() {
        use std::os::unix::fs::FileTypeExt;

        const WORKERS: usize = crate::async_runtime::ASYNC_RUNTIME_WORKER_THREADS;
        const PHASE_TWO_ROUNDS: usize = 20;
        const PHASE_TWO_SETTLE: Duration = Duration::from_millis(10);
        let attempts = WORKERS + 2;
        let quiet_window = Duration::from_secs(30);

        let root = std::env::temp_dir().join(format!("aimux-failure-store-{}", std::process::id()));
        let state_dir = root.join("state");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&state_dir).expect("state dir");

        let store = crate::project_service::operation_failures::dashboard_operation_failures_path(
            &state_dir,
        );
        let made = std::process::Command::new("mkfifo")
            .arg(&store)
            .status()
            .expect("mkfifo runs");
        assert!(
            made.success(),
            "could not create the FIFO this gate depends on; without it the read returns instantly and the gate proves nothing"
        );

        let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            &root,
            state_dir.clone(),
        ));

        let async_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(WORKERS)
            .enable_all()
            .build()
            .expect("a runtime with the project service's worker count");
        let entered = async_runtime.enter();

        let (polled_tx, polled) = std::sync::mpsc::channel();
        for index in 0..attempts {
            let hop_context = Arc::clone(&context);
            let polled_tx = polled_tx.clone();
            async_runtime.spawn(async move {
                polled_tx.send(index).expect("the test is still listening");
                // The clear, because that is the steady-state one.
                clear_agent_input_delivery_failure_off_the_worker(&hop_context, "s1").await;
            });
        }
        drop(polled_tx);

        let mut reported = 0;
        while reported < attempts {
            match polled.recv_timeout(quiet_window) {
                Ok(_) => reported += 1,
                Err(_) => break,
            }
        }

        let mut still_polling = true;
        for _ in 0..PHASE_TWO_ROUNDS {
            std::thread::sleep(PHASE_TWO_SETTLE);
            let (yielded_tx, yielded) = std::sync::mpsc::channel();
            async_runtime.spawn(async move {
                tokio::task::yield_now().await;
                let _ = yielded_tx.send(());
            });
            if yielded.recv_timeout(quiet_window).is_err() {
                still_polling = false;
                break;
            }
        }

        // Captured BEFORE teardown, because teardown unlinks the path and a
        // stat placed with the assertions below would read a path that is
        // already gone and fail for the wrong reason.
        //
        // The check itself guards a real hazard: `save_state` goes through
        // `atomic_write_impl`, which writes a temp file and RENAMES over the
        // target. A future write-before-read path would therefore replace this
        // FIFO with an ordinary file mid-measurement, and the gate would pass
        // having controlled nothing.
        let still_a_fifo = fs::symlink_metadata(&store)
            .map(|metadata| metadata.file_type().is_fifo())
            .unwrap_or(false);

        drop(entered);
        async_runtime.shutdown_background();
        let _ = fs::remove_dir_all(&root);

        assert!(
            still_a_fifo,
            "the store path was no longer a FIFO at the end of the measurement, so something wrote over it and this gate stopped controlling the resource it depends on"
        );
        assert_eq!(
            reported, attempts,
            "{reported} of {attempts} hops were polled on {WORKERS} workers and then nothing more happened for {quiet_window:?}: a failure-store write is holding a worker while it waits on the file"
        );
        assert!(
            still_polling,
            "every hop was polled, but a task that only yields then went {quiet_window:?} without running. The workers are occupied, which is what happens when the failure-store read-modify-write runs inline on the worker rather than on the blocking pool"
        );
    }
}
