//! Sending text to an agent from a scheduled task.
//!
//! One send is roughly a tmux spawn per line, so watcher turns use a bounded
//! runtime and run inside the Tokio scheduler's per-task timeout. A held
//! delivery is a successful handoff to the queued input task, not a failed send;
//! the watcher is not responsible for owning a human-input dwell window.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::project_api_contract::routes;

use super::agent_input_delivery::{
    AgentInputDeliveryDecision, decide_agent_input_delivery, enqueue_agent_input_delivery,
    record_agent_input_delivery_probe_failure,
};
use super::agent_output::{
    AgentOutputResponseMode, BoundedAgentOutputCaptureRuntime, deliver_prompt_to_tmux_async,
    read_agent_output_payload_async, resolve_live_window_id,
    route_agent_output_request_with_runtime,
};
use super::prompt_context::{compose_with_prompt_context, get_prompt_context_text};
use super::router::ProjectServiceRequestContext;

/// How long a single delivery may take before the tick loop gives up on it.
pub const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherDeliveryResult {
    Delivered,
    Queued,
    Failed,
}

impl WatcherDeliveryResult {
    pub fn consumes_cooldown(self) -> bool {
        matches!(self, Self::Delivered | Self::Queued)
    }
}

pub fn deliver_agent_input(
    context: Arc<ProjectServiceRequestContext>,
    session_id: &str,
    text: &str,
) -> bool {
    let cancelled = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + DELIVERY_TIMEOUT;
    let mut runtime = BoundedAgentOutputCaptureRuntime::new(deadline, cancelled);
    deliver_agent_input_with_runtime(&context, session_id, text, &mut runtime).consumes_cooldown()
}

pub async fn deliver_agent_input_async(
    context: Arc<ProjectServiceRequestContext>,
    session_id: &str,
    text: &str,
) -> bool {
    deliver_agent_input_direct_async(&context, session_id, text)
        .await
        .consumes_cooldown()
}

pub fn deliver_agent_input_with_runtime(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    text: &str,
    runtime: &mut impl super::agent_output::AgentOutputCaptureRuntime,
) -> WatcherDeliveryResult {
    let body = json!({ "sessionId": session_id, "text": text });
    let Some(response) = route_agent_output_request_with_runtime(
        context,
        "POST",
        routes::agents::INPUT,
        Some(&body),
        runtime,
    ) else {
        return WatcherDeliveryResult::Failed;
    };
    if response.status != 200 {
        return WatcherDeliveryResult::Failed;
    }
    match response
        .body
        .get("delivery")
        .and_then(|delivery| delivery.get("state"))
        .and_then(Value::as_str)
    {
        Some("held") => WatcherDeliveryResult::Queued,
        _ => WatcherDeliveryResult::Delivered,
    }
}

async fn deliver_agent_input_direct_async(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    text: &str,
) -> WatcherDeliveryResult {
    let Some(window_id) = resolve_live_window_id(context, session_id) else {
        return WatcherDeliveryResult::Failed;
    };
    let project_state_dir = context.project_state_dir();
    let prompt_context = get_prompt_context_text(&project_state_dir, session_id);
    let contextualized_text = compose_with_prompt_context(text, prompt_context.as_deref());
    let prompt = crate::agent_prompt_delivery::normalize_submitted_prompt(&contextualized_text);
    let now_ms = super::scheduler::scheduler_now_ms();
    let activity =
        super::agent_output::tmux_agent_input_window_activity_async(&window_id, DELIVERY_TIMEOUT)
            .await;
    let decision = decide_agent_input_delivery(false, activity, now_ms, now_ms);
    if let AgentInputDeliveryDecision::Hold {
        reason,
        quiet_for_ms: _,
        retry_after_ms: _,
    } = decision
    {
        if enqueue_agent_input_delivery(context, session_id, &window_id, &prompt, &reason, now_ms)
            .is_err()
        {
            return WatcherDeliveryResult::Failed;
        }
        if reason.starts_with("tmux client activity probe failed") {
            record_agent_input_delivery_probe_failure(context, session_id, &reason);
        }
        context
            .scheduler
            .force_task_next_tick(super::agent_input_delivery::AGENT_INPUT_DELIVERY_TASK_NAME);
        return WatcherDeliveryResult::Queued;
    }
    match deliver_prompt_to_tmux_async(&window_id, &prompt, DELIVERY_TIMEOUT).await {
        Ok(()) => WatcherDeliveryResult::Delivered,
        Err(_) => WatcherDeliveryResult::Failed,
    }
}

/// How long a single pane read may take before the tick loop gives up on it.
///
/// Shorter than a delivery: capturing a pane is one fast tmux call, and a scan
/// may do a dozen of them.
pub const READ_TIMEOUT: Duration = Duration::from_secs(3);

/// Read an agent's bounded output tail.
///
/// Same reasoning as delivery, and one more: the output cache holds its mutex
/// across the capture, so a wedged pane read must be bounded before it reaches
/// every HTTP and SSE output reader in the service.
pub fn read_agent_output_tail(
    context: Arc<ProjectServiceRequestContext>,
    session_id: &str,
    start_line: i64,
) -> Option<String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + READ_TIMEOUT;
    let mut runtime = BoundedAgentOutputCaptureRuntime::new(deadline, cancelled);
    super::agent_output::read_agent_output_payload(
        &context,
        session_id,
        Some(start_line),
        super::agent_output::AgentOutputResponseMode::Full,
        &mut runtime,
    )
    .ok()
    .and_then(|read| {
        read.payload
            .get("output")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
    })
}

pub async fn read_agent_output_tail_async(
    context: Arc<ProjectServiceRequestContext>,
    session_id: &str,
    start_line: i64,
) -> Option<String> {
    read_agent_output_payload_async(
        &context,
        session_id,
        Some(start_line),
        AgentOutputResponseMode::Full,
        READ_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|read| {
        read.payload
            .get("output")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
    })
}

/// A wall-clock allowance for one task's turn on the tick loop.
///
/// Each watcher checks its budget between units of work and gives up the rest
/// of the scan rather than overrunning its own scheduler turn.
pub struct TickLoopBudget {
    started: std::time::Instant,
    allowance: Duration,
}

impl TickLoopBudget {
    pub fn new(allowance: Duration) -> Self {
        Self {
            started: std::time::Instant::now(),
            allowance,
        }
    }

    pub fn spent(&self) -> bool {
        self.started.elapsed() >= self.allowance
    }

    pub fn remaining(&self) -> Duration {
        self.allowance.saturating_sub(self.started.elapsed())
    }
}
