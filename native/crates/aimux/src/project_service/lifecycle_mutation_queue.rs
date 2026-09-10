use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use crate::project_api_contract::routes;

const DEFAULT_QUEUE_LIMIT: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleTransitionInput {
    pub operation: String,
    pub target_kind: String,
    pub target_id: Option<String>,
    pub target_path: Option<String>,
    pub phase: Option<String>,
    pub error: Option<String>,
}

impl LifecycleTransitionInput {
    pub fn new(operation: impl Into<String>, target_kind: impl Into<String>) -> Self {
        Self {
            operation: operation.into(),
            target_kind: target_kind.into(),
            target_id: None,
            target_path: None,
            phase: None,
            error: None,
        }
    }

    pub fn with_target_id(mut self, target_id: Option<String>) -> Self {
        self.target_id = target_id;
        self
    }

    pub fn with_target_path(mut self, target_path: Option<String>) -> Self {
        self.target_path = target_path;
        self
    }

    fn target_key(&self) -> String {
        let target = if self.target_kind == "worktree" {
            self.target_path
                .as_deref()
                .or(self.target_id.as_deref())
                .map(str::trim)
        } else {
            self.target_id
                .as_deref()
                .or(self.target_path.as_deref())
                .map(str::trim)
        };
        match target.filter(|value| !value.is_empty()) {
            Some(target) => format!("{}:{target}", self.target_kind),
            None => format!("{}:{}:__project__", self.target_kind, self.operation),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleMutationError {
    Conflict {
        requested: LifecycleTransitionInput,
        active: LifecycleTransitionInput,
    },
    QueueFull {
        requested: LifecycleTransitionInput,
        queued_count: usize,
        limit: usize,
    },
}

impl LifecycleMutationError {
    pub fn status(&self) -> u16 {
        match self {
            Self::Conflict { .. } => 409,
            Self::QueueFull { .. } => 429,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Conflict { requested, .. } => {
                let target = requested
                    .target_id
                    .as_deref()
                    .or(requested.target_path.as_deref())
                    .unwrap_or("unknown");
                format!(
                    "lifecycle mutation already in progress for {} {target}",
                    requested.target_kind
                )
            }
            Self::QueueFull {
                queued_count,
                limit,
                ..
            } => format!(
                "lifecycle mutation queue is full ({queued_count}/{limit}); wait for current operations to settle"
            ),
        }
    }
}

#[derive(Debug, Clone)]
pub struct LifecycleMutationQueue {
    inner: Arc<QueueInner>,
}

#[derive(Debug)]
struct QueueInner {
    state: Mutex<QueueState>,
    ready: Condvar,
    queue_limit: usize,
}

#[derive(Debug, Default)]
struct QueueState {
    running: bool,
    queued_count: usize,
    active_targets: BTreeMap<String, LifecycleTransitionInput>,
    telemetry: LifecycleMutationTelemetry,
}

#[derive(Debug, Clone, Default)]
pub struct LifecycleMutationTelemetry {
    pub enqueued: u64,
    pub started: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub released: u64,
    pub rejected_conflicts: u64,
    pub rejected_queue_full: u64,
    pub max_queued_count: usize,
    pub max_queued_ms: u128,
    pub max_duration_ms: u128,
    pub last_started_at: Option<String>,
    pub last_settled_at: Option<String>,
    pub last_error: Option<String>,
}

impl Default for LifecycleMutationQueue {
    fn default() -> Self {
        Self::new(DEFAULT_QUEUE_LIMIT)
    }
}

impl LifecycleMutationQueue {
    pub fn new(queue_limit: usize) -> Self {
        Self {
            inner: Arc::new(QueueInner {
                state: Mutex::new(QueueState::default()),
                ready: Condvar::new(),
                queue_limit,
            }),
        }
    }

    pub fn enqueue<T, F>(
        &self,
        transition: Option<LifecycleTransitionInput>,
        action: F,
    ) -> Result<Result<T, String>, LifecycleMutationError>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let target_key = transition
            .as_ref()
            .map(LifecycleTransitionInput::target_key);
        let queued_at = Instant::now();
        if transition.is_some() {
            let mut state = self.inner.state.lock().expect("lifecycle queue lock");
            if let (Some(key), Some(transition)) = (target_key.as_ref(), transition.as_ref())
                && let Some(active) = state.active_targets.get(key).cloned()
            {
                state.telemetry.rejected_conflicts += 1;
                return Err(LifecycleMutationError::Conflict {
                    requested: transition.clone(),
                    active,
                });
            }
            if let Some(transition) = transition.as_ref()
                && state.queued_count >= self.inner.queue_limit
            {
                state.telemetry.rejected_queue_full += 1;
                return Err(LifecycleMutationError::QueueFull {
                    requested: transition.clone(),
                    queued_count: state.queued_count,
                    limit: self.inner.queue_limit,
                });
            }
            if let (Some(key), Some(transition)) = (target_key.as_ref(), transition.as_ref()) {
                state.active_targets.insert(key.clone(), transition.clone());
            }
            state.queued_count += 1;
            state.telemetry.enqueued += 1;
            state.telemetry.max_queued_count =
                state.telemetry.max_queued_count.max(state.queued_count);
        }

        let mut state = self.inner.state.lock().expect("lifecycle queue lock");
        while state.running {
            state = self.inner.ready.wait(state).expect("lifecycle queue wait");
        }
        state.running = true;
        if transition.is_some() {
            state.telemetry.started += 1;
            state.telemetry.max_queued_ms = state
                .telemetry
                .max_queued_ms
                .max(queued_at.elapsed().as_millis());
            state.telemetry.last_started_at = Some(now_iso());
        }
        drop(state);

        let started_at = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(action));

        let mut state = self.inner.state.lock().expect("lifecycle queue lock");
        state.running = false;
        if transition.is_some() {
            state.queued_count = state.queued_count.saturating_sub(1);
            state.telemetry.released += 1;
            state.telemetry.max_duration_ms = state
                .telemetry
                .max_duration_ms
                .max(started_at.elapsed().as_millis());
            state.telemetry.last_settled_at = Some(now_iso());
            if let Some(key) = target_key {
                state.active_targets.remove(&key);
            }
        }
        match result {
            Ok(Ok(value)) => {
                if transition.is_some() {
                    state.telemetry.succeeded += 1;
                    state.telemetry.last_error = None;
                }
                self.inner.ready.notify_one();
                Ok(Ok(value))
            }
            Ok(Err(error)) => {
                if transition.is_some() {
                    state.telemetry.failed += 1;
                    state.telemetry.last_error = Some(error.clone());
                }
                self.inner.ready.notify_one();
                Ok(Err(error))
            }
            Err(payload) => {
                if transition.is_some() {
                    state.telemetry.failed += 1;
                    state.telemetry.last_error = Some("lifecycle mutation panicked".into());
                }
                self.inner.ready.notify_one();
                std::panic::resume_unwind(payload);
            }
        }
    }

    pub fn diagnostics(&self, project_root: &str) -> Value {
        let state = self.inner.state.lock().expect("lifecycle queue lock");
        let active_targets = state
            .active_targets
            .iter()
            .map(|(key, transition)| {
                let mut target = serde_json::Map::new();
                target.insert("key".into(), Value::String(key.clone()));
                target.insert(
                    "operation".into(),
                    Value::String(transition.operation.clone()),
                );
                target.insert(
                    "targetKind".into(),
                    Value::String(transition.target_kind.clone()),
                );
                if let Some(target_id) = &transition.target_id {
                    target.insert("targetId".into(), Value::String(target_id.clone()));
                }
                if let Some(target_path) = &transition.target_path {
                    target.insert("targetPath".into(), Value::String(target_path.clone()));
                }
                Value::Object(target)
            })
            .collect::<Vec<_>>();
        json!({
            "ok": true,
            "pid": std::process::id(),
            "projectRoot": project_root,
            "queuedCount": state.queued_count,
            "queueLimit": self.inner.queue_limit,
            "activeTargets": active_targets,
            "telemetry": {
                "enqueued": state.telemetry.enqueued,
                "started": state.telemetry.started,
                "succeeded": state.telemetry.succeeded,
                "failed": state.telemetry.failed,
                "released": state.telemetry.released,
                "rejectedConflicts": state.telemetry.rejected_conflicts,
                "rejectedQueueFull": state.telemetry.rejected_queue_full,
                "maxQueuedCount": state.telemetry.max_queued_count,
                "maxQueuedMs": state.telemetry.max_queued_ms,
                "maxDurationMs": state.telemetry.max_duration_ms,
                "lastStartedAt": state.telemetry.last_started_at,
                "lastSettledAt": state.telemetry.last_settled_at,
                "lastError": state.telemetry.last_error,
            },
        })
    }
}

pub fn lifecycle_transition_for_route(
    pathname: &str,
    body: &Value,
) -> Option<LifecycleTransitionInput> {
    let session_id = trimmed_string(body.get("sessionId"));
    let service_id = trimmed_string(body.get("serviceId"));
    let worktree_path = trimmed_string(body.get("path"))
        .or_else(|| trimmed_string(body.get("worktreePath")))
        .or_else(|| trimmed_string(body.get("targetPath")))
        .or_else(|| trimmed_string(body.get("name")));
    match pathname {
        routes::agents::SPAWN => Some(LifecycleTransitionInput::new("agent.spawn", "agent")),
        routes::agents::FORK => {
            Some(LifecycleTransitionInput::new("agent.fork", "agent").with_target_id(session_id))
        }
        routes::agents::SWITCH_TOOL => Some(
            LifecycleTransitionInput::new("agent.switchTool", "agent").with_target_id(session_id),
        ),
        routes::agents::STOP | routes::agents::STOP_TEAMMATE => {
            Some(LifecycleTransitionInput::new("agent.stop", "agent").with_target_id(session_id))
        }
        routes::agents::KILL | routes::agents::KILL_TEAMMATE => {
            Some(LifecycleTransitionInput::new("agent.kill", "agent").with_target_id(session_id))
        }
        routes::agents::RENAME => {
            Some(LifecycleTransitionInput::new("agent.rename", "agent").with_target_id(session_id))
        }
        routes::agents::MIGRATE => {
            Some(LifecycleTransitionInput::new("agent.migrate", "agent").with_target_id(session_id))
        }
        routes::agents::RESUME | routes::agents::RESUME_TEAMMATE => {
            Some(LifecycleTransitionInput::new("agent.resume", "agent").with_target_id(session_id))
        }
        routes::agents::RESTORE_PREVIOUS => {
            Some(LifecycleTransitionInput::new("agent.restore", "agent"))
        }
        routes::agents::DISMISS_RESTORE_PREVIOUS => None,
        routes::agents::CREATE_TEAMMATE => Some(LifecycleTransitionInput::new(
            "agent.createTeammate",
            "agent",
        )),
        routes::agents::RESURRECT_TEAMMATE | routes::graveyard_actions::RESURRECT_AGENT => Some(
            LifecycleTransitionInput::new("agent.resurrect", "agent").with_target_id(session_id),
        ),
        routes::agents::RECORD_BACKEND_SESSION => None,
        routes::services::CREATE => {
            Some(LifecycleTransitionInput::new("service.create", "service"))
        }
        routes::services::RESUME => Some(
            LifecycleTransitionInput::new("service.resume", "service").with_target_id(service_id),
        ),
        routes::services::STOP => Some(
            LifecycleTransitionInput::new("service.stop", "service").with_target_id(service_id),
        ),
        routes::services::REMOVE => Some(
            LifecycleTransitionInput::new("service.remove", "service").with_target_id(service_id),
        ),
        routes::worktree_actions::CREATE => Some(
            LifecycleTransitionInput::new("worktree.create", "worktree")
                .with_target_path(worktree_path),
        ),
        routes::worktree_actions::CACHE_CLEANUP => Some(
            LifecycleTransitionInput::new("worktree.cacheCleanup", "worktree")
                .with_target_path(worktree_path),
        ),
        routes::worktree_actions::GRAVEYARD => Some(
            LifecycleTransitionInput::new("worktree.graveyard", "worktree")
                .with_target_path(worktree_path),
        ),
        routes::worktree_actions::REMOVE | routes::graveyard_actions::DELETE_WORKTREE => Some(
            LifecycleTransitionInput::new("worktree.remove", "worktree")
                .with_target_path(worktree_path),
        ),
        routes::graveyard_actions::RESURRECT_WORKTREE => Some(
            LifecycleTransitionInput::new("worktree.resurrect", "worktree")
                .with_target_path(worktree_path),
        ),
        routes::graveyard_actions::CLEANUP => Some(LifecycleTransitionInput::new(
            "graveyard.cleanup",
            "project",
        )),
        _ => None,
    }
}

pub fn lifecycle_ok(mut result: Value, input: &LifecycleTransitionInput) -> Value {
    let object = result.as_object_mut();
    if object.is_none() {
        result = json!({});
    }
    let object = result.as_object_mut().expect("object response");
    object.insert("ok".into(), Value::Bool(true));
    object.insert("transition".into(), build_lifecycle_transition(input));
    result
}

pub fn build_lifecycle_transition(input: &LifecycleTransitionInput) -> Value {
    let now = now_iso();
    let target_key = input
        .target_id
        .as_deref()
        .or(input.target_path.as_deref())
        .unwrap_or("unknown");
    let mut transition = serde_json::Map::new();
    transition.insert(
        "operationId".into(),
        Value::String(format!("{}:{target_key}:{}", input.operation, sequence())),
    );
    transition.insert("operation".into(), Value::String(input.operation.clone()));
    transition.insert(
        "targetKind".into(),
        Value::String(input.target_kind.clone()),
    );
    transition.insert(
        "phase".into(),
        Value::String(input.phase.clone().unwrap_or_else(|| "succeeded".into())),
    );
    transition.insert("startedAt".into(), Value::String(now.clone()));
    transition.insert("updatedAt".into(), Value::String(now));
    if let Some(target_id) = &input.target_id {
        transition.insert("targetId".into(), Value::String(target_id.clone()));
    }
    if let Some(target_path) = &input.target_path {
        transition.insert("targetPath".into(), Value::String(target_path.clone()));
    }
    if let Some(error) = &input.error {
        transition.insert("error".into(), Value::String(error.clone()));
    }
    Value::Object(transition)
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    now.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn sequence() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let mut value = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let mut output = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        output.push(match digit {
            0..=9 => b'0' + digit,
            _ => b'a' + (digit - 10),
        });
        value /= 36;
    }
    output.reverse();
    String::from_utf8(output).unwrap_or_else(|_| "0".into())
}
