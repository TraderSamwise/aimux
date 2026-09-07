use serde_json::{Map, Value, json};
use std::collections::VecDeque;

const RETRY_DELAYS_MS: [i64; 4] = [250, 1_000, 3_000, 10_000];
const NOTIFICATION_CONTEXT_TIMEOUT_MS: i64 = 3_000;

pub fn run_tui_runtime_mutations_contract_case(input: &Value) -> Value {
    let mut harness = MutationHarness::from_input(input);
    for op in input["ops"].as_array().into_iter().flatten() {
        harness.run_op(op);
    }
    json!({
        "calls": {
            "mutations": harness.mutation_calls,
            "debug": harness.debug_calls,
        },
        "queue": harness.serialize_queue(),
        "timers": harness.timer_state(),
    })
}

#[derive(Debug, Clone)]
struct Queue {
    id: usize,
    context: Option<Value>,
    seen: Vec<String>,
    timer_id: Option<usize>,
    in_flight: bool,
    attempt: usize,
    disposed: bool,
}

#[derive(Debug, Clone)]
struct Timer {
    id: usize,
    at: i64,
}

#[derive(Debug, Clone)]
enum Response {
    Resolve,
    Reject,
    Pending(String),
}

#[derive(Debug, Clone)]
enum PendingResume {
    Context {
        queue_id: usize,
        seen: Vec<String>,
        failed_seen: Vec<String>,
        failed: bool,
    },
    Seen {
        queue_id: usize,
        session: String,
        remaining: Vec<String>,
        failed_seen: Vec<String>,
        failed: bool,
    },
}

#[derive(Debug, Clone)]
enum MutationResult {
    Resolved,
    Rejected,
    Pending(String, PendingResume),
}

#[derive(Debug, Default)]
struct MutationHarness {
    queue: Option<Queue>,
    next_queue_id: usize,
    now: i64,
    next_timer_id: usize,
    timers: Vec<Timer>,
    responses: VecDeque<Response>,
    pending: Vec<(String, PendingResume)>,
    mutation_calls: Vec<Value>,
    debug_calls: Vec<Value>,
}

impl MutationHarness {
    fn from_input(input: &Value) -> Self {
        let responses = input["responses"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|response| match response["type"].as_str() {
                Some("reject") => Response::Reject,
                Some("pending") => {
                    Response::Pending(response["label"].as_str().unwrap_or_default().to_owned())
                }
                _ => Response::Resolve,
            })
            .collect();
        Self {
            responses,
            next_queue_id: 1,
            next_timer_id: 1,
            ..Self::default()
        }
    }

    fn run_op(&mut self, op: &Value) {
        match op["op"].as_str().unwrap_or_default() {
            "context" => {
                self.queue_notification_context(op.get("patch").cloned().unwrap_or(Value::Null));
            }
            "seen" => {
                self.queue_session_seen(op["sessionId"].as_str().unwrap_or_default());
            }
            "clear" => self.clear_queue(),
            "runPending" => self.run_only_pending_timers(),
            "advance" => self.advance_timers_by(op["ms"].as_i64().unwrap_or_default()),
            "runAll" => self.run_all_timers(),
            "resolve" => self.resolve_pending(op["label"].as_str().unwrap_or_default(), false),
            "reject" => self.resolve_pending(op["label"].as_str().unwrap_or_default(), true),
            other => panic!("unknown TUI runtime mutation op: {other}"),
        }
    }

    fn queue_notification_context(&mut self, patch: Value) {
        let queue = self.get_queue();
        queue.context = Some(merge_context(queue.context.take(), patch));
        self.schedule_flush(0, true);
    }

    fn queue_session_seen(&mut self, session_id: &str) {
        let queue = self.get_queue();
        if !queue.seen.iter().any(|session| session == session_id) {
            queue.seen.push(session_id.to_owned());
        }
        self.schedule_flush(0, false);
    }

    fn clear_queue(&mut self) {
        let Some(mut queue) = self.queue.take() else {
            return;
        };
        queue.disposed = true;
        if let Some(timer_id) = queue.timer_id {
            self.timers.retain(|timer| timer.id != timer_id);
        }
        queue.context = None;
        queue.seen.clear();
    }

    fn schedule_flush(&mut self, delay_ms: i64, preempt: bool) {
        let Some(queue) = self.queue.as_mut() else {
            return;
        };
        if queue.disposed {
            return;
        }
        if preempt
            && !queue.in_flight
            && let Some(timer_id) = queue.timer_id.take()
        {
            self.timers.retain(|timer| timer.id != timer_id);
        }
        if queue.in_flight || queue.timer_id.is_some() {
            return;
        }
        let timer_id = self.next_timer_id;
        self.next_timer_id += 1;
        queue.timer_id = Some(timer_id);
        self.timers.push(Timer {
            id: timer_id,
            at: self.now + delay_ms,
        });
    }

    fn run_only_pending_timers(&mut self) {
        let mut pending = self.timers.clone();
        pending.sort_by_key(|timer| (timer.at, timer.id));
        for timer in pending {
            if !self.timers.iter().any(|item| item.id == timer.id) {
                continue;
            }
            self.timers.retain(|item| item.id != timer.id);
            self.now = self.now.max(timer.at);
            if let Some(queue) = self.queue.as_mut()
                && queue.timer_id == Some(timer.id)
            {
                queue.timer_id = None;
            }
            self.flush_queue();
        }
    }

    fn advance_timers_by(&mut self, ms: i64) {
        let target = self.now + ms;
        loop {
            let due = self
                .timers
                .iter()
                .filter(|timer| timer.at <= target)
                .min_by_key(|timer| (timer.at, timer.id))
                .cloned();
            let Some(timer) = due else {
                break;
            };
            self.timers.retain(|item| item.id != timer.id);
            self.now = timer.at;
            if let Some(queue) = self.queue.as_mut()
                && queue.timer_id == Some(timer.id)
            {
                queue.timer_id = None;
            }
            self.flush_queue();
        }
        self.now = target;
    }

    fn run_all_timers(&mut self) {
        while !self.timers.is_empty() {
            self.run_only_pending_timers();
        }
    }

    fn flush_queue(&mut self) {
        let Some(queue) = self.queue.as_mut() else {
            return;
        };
        if queue.in_flight || queue.context.is_none() && queue.seen.is_empty() {
            return;
        }
        queue.in_flight = true;
        let queue_id = queue.id;
        let context = queue.context.take();
        let seen = std::mem::take(&mut queue.seen);
        if let Some(context) = context {
            let body = notification_context_body(context);
            match self.call_mutation(
                "/notification-context",
                body,
                json!({ "timeoutMs": NOTIFICATION_CONTEXT_TIMEOUT_MS, "recoverOnFailure": false }),
                PendingResume::Context {
                    queue_id,
                    seen: seen.clone(),
                    failed_seen: Vec::new(),
                    failed: false,
                },
            ) {
                MutationResult::Pending(label, resume) => self.pending.push((label, resume)),
                MutationResult::Resolved | MutationResult::Rejected => {
                    self.process_seen(queue_id, seen, Vec::new(), false);
                }
            }
        } else {
            self.process_seen(queue_id, seen, Vec::new(), false);
        }
    }

    fn process_seen(
        &mut self,
        queue_id: usize,
        seen: Vec<String>,
        mut failed_seen: Vec<String>,
        mut failed: bool,
    ) {
        let mut remaining = seen;
        while !remaining.is_empty() {
            if !self.is_live_queue(queue_id) {
                return;
            }
            let session = remaining.remove(0);
            let resume = PendingResume::Seen {
                queue_id,
                session: session.clone(),
                remaining: remaining.clone(),
                failed_seen: failed_seen.clone(),
                failed,
            };
            match self.call_mutation(
                "/mark-seen",
                json!({ "session": session }),
                Value::Null,
                resume,
            ) {
                MutationResult::Resolved => {}
                MutationResult::Rejected => {
                    failed_seen.push(session);
                    failed = true;
                }
                MutationResult::Pending(label, resume) => {
                    self.pending.push((label, resume));
                    return;
                }
            }
        }
        self.finish_flush(queue_id, failed_seen, failed);
    }

    fn finish_flush(&mut self, queue_id: usize, failed_seen: Vec<String>, failed: bool) {
        if !self.is_live_queue(queue_id) {
            return;
        }
        if let Some(queue) = self.queue.as_mut() {
            queue.in_flight = false;
        }
        if !self.is_live_queue(queue_id) {
            return;
        }
        if !failed {
            let should_reschedule = if let Some(queue) = self.queue.as_mut() {
                queue.attempt = 0;
                queue.context.is_some() || !queue.seen.is_empty()
            } else {
                false
            };
            if should_reschedule {
                self.schedule_flush(0, false);
            }
            return;
        }
        if let Some(queue) = self.queue.as_mut() {
            for session in failed_seen {
                if !queue.seen.iter().any(|seen| seen == &session) {
                    queue.seen.push(session);
                }
            }
            queue.attempt += 1;
            self.debug_calls.push(json!({
                "message": format!(
                    "TUI runtime mutation retry scheduled after failed attempt {}",
                    queue.attempt
                ),
                "scope": "dashboard",
            }));
            let delay = retry_delay(queue.attempt - 1);
            self.schedule_flush(delay, false);
        }
    }

    fn resolve_pending(&mut self, label: &str, rejected: bool) {
        let Some(index) = self
            .pending
            .iter()
            .position(|(pending_label, _)| pending_label == label)
        else {
            panic!("unknown pending mutation {label}");
        };
        let (_, resume) = self.pending.remove(index);
        match resume {
            PendingResume::Context {
                queue_id,
                seen,
                failed_seen,
                failed,
            } => self.process_seen(queue_id, seen, failed_seen, failed),
            PendingResume::Seen {
                queue_id,
                session,
                remaining,
                mut failed_seen,
                mut failed,
            } => {
                if rejected {
                    failed_seen.push(session);
                    failed = true;
                }
                self.process_seen(queue_id, remaining, failed_seen, failed);
            }
        }
    }

    fn call_mutation(
        &mut self,
        path: &str,
        body: Value,
        options: Value,
        pending_resume: PendingResume,
    ) -> MutationResult {
        self.mutation_calls.push(json!({
            "path": path,
            "body": body,
            "options": options,
        }));
        match self.responses.pop_front().unwrap_or(Response::Resolve) {
            Response::Resolve => MutationResult::Resolved,
            Response::Reject => MutationResult::Rejected,
            Response::Pending(label) => MutationResult::Pending(label, pending_resume),
        }
    }

    fn serialize_queue(&self) -> Value {
        let Some(queue) = &self.queue else {
            return Value::Null;
        };
        json!({
            "context": queue.context.clone().unwrap_or(Value::Null),
            "seen": queue.seen,
            "hasTimer": queue.timer_id.is_some(),
            "inFlight": queue.in_flight,
            "attempt": queue.attempt,
            "disposed": queue.disposed,
        })
    }

    fn timer_state(&self) -> Value {
        let pending = self
            .timers
            .iter()
            .map(|timer| json!({ "id": timer.id, "at": timer.at }))
            .collect::<Vec<_>>();
        json!({ "now": self.now, "pending": pending })
    }

    fn get_queue(&mut self) -> &mut Queue {
        if self.queue.is_none() {
            let queue = Queue {
                id: self.next_queue_id,
                context: None,
                seen: Vec::new(),
                timer_id: None,
                in_flight: false,
                attempt: 0,
                disposed: false,
            };
            self.next_queue_id += 1;
            self.queue = Some(queue);
        }
        self.queue.as_mut().expect("queue initialized")
    }

    fn is_live_queue(&self, queue_id: usize) -> bool {
        self.queue
            .as_ref()
            .is_some_and(|queue| queue.id == queue_id && !queue.disposed)
    }
}

fn notification_context_body(context: Value) -> Value {
    let mut body = Map::new();
    body.insert("source".into(), Value::String("tui".to_owned()));
    body.insert("focused".into(), Value::Bool(true));
    if let Some(context) = context.as_object() {
        for (key, value) in context {
            body.insert(key.clone(), value.clone());
        }
    }
    Value::Object(body)
}

fn merge_context(base: Option<Value>, patch: Value) -> Value {
    let mut merged = base
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

fn retry_delay(attempt: usize) -> i64 {
    RETRY_DELAYS_MS[attempt.min(RETRY_DELAYS_MS.len() - 1)]
}
