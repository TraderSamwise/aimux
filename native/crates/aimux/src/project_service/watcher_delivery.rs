//! Sending text to an agent from a scheduled task.
//!
//! One send is roughly a tmux spawn per line, and tmux has no timeout of its
//! own, so a wedged server would block the single scheduler thread forever and
//! silence every other task. Every watcher therefore delivers off the rail with
//! a bounded wait; a timeout reads as a failed send, which leaves the caller's
//! cooldown unconsumed so the next scan tries again.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::project_api_contract::routes;

use super::agent_output::{
    BoundedAgentOutputCaptureRuntime, route_agent_output_request_with_runtime,
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
    let cancelled = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + DELIVERY_TIMEOUT;
    let worker_cancelled = Arc::clone(&cancelled);
    thread::spawn(move || {
        let mut runtime = BoundedAgentOutputCaptureRuntime::new(deadline, worker_cancelled);
        let delivered = route_agent_output_request_with_runtime(
            &context,
            "POST",
            routes::agents::INPUT,
            Some(&body),
            &mut runtime,
        )
        .is_some_and(|response| response.status == 200);
        let _ = tx.send(delivered);
    });
    match rx.recv_timeout(DELIVERY_TIMEOUT) {
        Ok(delivered) => delivered,
        Err(_) => {
            cancelled.store(true, Ordering::SeqCst);
            false
        }
    }
}

/// How long a single pane read may take before the rail gives up on it.
///
/// Shorter than a delivery: capturing a pane is one fast tmux call, and a scan
/// may do a dozen of them.
pub const READ_TIMEOUT: Duration = Duration::from_secs(3);

/// Read an agent's bounded output tail, off the rail.
///
/// Same reasoning as delivery, and one more: the output cache holds its mutex
/// across the capture, so a wedged pane read on the rail would stall every
/// HTTP and SSE output read in the service, not just the watchers.
pub fn read_agent_output_tail(
    context: Arc<ProjectServiceRequestContext>,
    session_id: &str,
    start_line: i64,
) -> Option<String> {
    let session_id = session_id.to_owned();
    let (tx, rx) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + READ_TIMEOUT;
    let worker_cancelled = Arc::clone(&cancelled);
    thread::spawn(move || {
        let mut runtime = BoundedAgentOutputCaptureRuntime::new(deadline, worker_cancelled);
        let read = super::agent_output::read_agent_output_payload(
            &context,
            &session_id,
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
        });
        let _ = tx.send(read);
    });
    match rx.recv_timeout(READ_TIMEOUT) {
        Ok(read) => read,
        Err(_) => {
            cancelled.store(true, Ordering::SeqCst);
            None
        }
    }
}

/// A wall-clock allowance for one task's turn on the rail.
///
/// The rail is a single thread shared by every watcher and both plugin ticks,
/// so a task that spends two minutes waiting on tmux does not just delay
/// itself — it silences the 2s transcript tick for that whole window. Each
/// watcher checks its budget between units of work and gives up the rest of
/// the scan rather than holding the thread.
pub struct RailBudget {
    started: std::time::Instant,
    allowance: Duration,
}

impl RailBudget {
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
