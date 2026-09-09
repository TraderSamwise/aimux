//! Sending text to an agent from a scheduled task.
//!
//! One send is roughly a tmux spawn per line, and tmux has no timeout of its
//! own, so a wedged server would block the single scheduler thread forever and
//! silence every other task. Every watcher therefore delivers off the rail with
//! a bounded wait; a timeout reads as a failed send, which leaves the caller's
//! cooldown unconsumed so the next scan tries again.

use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::json;

use crate::project_api_contract::routes;

use super::agent_output::{
    SystemAgentOutputCaptureRuntime, route_agent_output_request_with_runtime,
};
use super::router::ProjectServiceRequestContext;

/// How long a single delivery may take before the rail gives up on it.
pub const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

pub fn deliver_agent_input(
    context: Arc<ProjectServiceRequestContext>,
    session_id: &str,
    text: &str,
) -> bool {
    let body = json!({ "sessionId": session_id, "text": text });
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let delivered = route_agent_output_request_with_runtime(
            &context,
            "POST",
            routes::agents::INPUT,
            Some(&body),
            &mut SystemAgentOutputCaptureRuntime,
        )
        .is_some_and(|response| response.status == 200);
        let _ = tx.send(delivered);
    });
    rx.recv_timeout(DELIVERY_TIMEOUT).unwrap_or(false)
}
