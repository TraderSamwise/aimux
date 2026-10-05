use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::async_runtime::block_on_named;
use crate::debug_logging::{LogLevel, log_at};
use crate::project_api_contract::routes;

const DEFAULT_QUEUE_LIMIT: usize = 32;

/// How long a mutation will wait for its turn before calling the one ahead of
/// it stuck.
///
/// The CLI gives a project mutation 120s (`CLI_PROJECT_MUTATION_TIMEOUT_MS`),
/// and a worktree create doing a cold fetch is the longest legitimate holder
/// there is, so past that nobody is still waiting for an answer and the holder
/// is not coming back. Waiting silently forever is the alternative, and that
/// is how the queue died: one stuck mutation and every later one hung with
/// nothing said.
///
/// This bounds the WAIT, never the work. A holder that legitimately runs
/// longer than this keeps running and still finishes; only a caller queued
/// behind it is told so. That is what makes the number safe to pick without
/// knowing every operation's worst case.
const WAIT_FOR_TURN_TIMEOUT: Duration = Duration::from_millis(150_000);

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

    /// What this mutation holds for its duration, or `None` when it holds
    /// nothing nameable.
    ///
    /// A spawn, a service create, a teammate create, a restore and a graveyard
    /// sweep say what they will make, not what already exists. There is nothing
    /// for them to contend over, and they used to share one fabricated
    /// `<kind>:<operation>:__project__` key — so picking claude and then codex
    /// refused codex with "lifecycle mutation already in progress for agent
    /// unknown", naming a target that was never involved.
    ///
    /// The key stayed only because `begin` waited on a `Condvar` and the async
    /// lifecycle routes awaited inside a connection task on a two-worker
    /// runtime: a second and third spawn reaching that wait parked both workers
    /// and left the holder's future unpollable. That wait is a semaphore now,
    /// so an unnamed mutation can queue behind the one in front of it the way
    /// it always should have.
    fn target_key(&self) -> Option<String> {
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
        target
            .filter(|value| !value.is_empty())
            .map(|target| format!("{}:{target}", self.target_kind))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleMutationError {
    Conflict {
        requested: Box<LifecycleTransitionInput>,
        active: Box<LifecycleTransitionInput>,
    },
    QueueFull {
        requested: Box<LifecycleTransitionInput>,
        queued_count: usize,
        limit: usize,
    },
    /// The mutation ahead of this one never finished. Named rather than
    /// numbered, because the caller cannot act on "timed out" and can act on
    /// which operation is stuck.
    HolderStuck {
        requested: Box<LifecycleTransitionInput>,
        holder: String,
        waited_ms: u128,
    },
}

impl LifecycleMutationError {
    pub fn status(&self) -> u16 {
        match self {
            Self::Conflict { .. } => 409,
            Self::QueueFull { .. } | Self::HolderStuck { .. } => 429,
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
            Self::HolderStuck {
                holder, waited_ms, ..
            } => format!(
                "lifecycle mutation queue is stuck behind {holder}; waited {waited_ms}ms without it finishing"
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
    /// One permit, so mutations run one at a time. The Node original this was
    /// ported from serialized on a promise chain, where a waiter yields the
    /// event loop; the port turned that into a `Condvar`, which on a two-worker
    /// runtime parks a worker instead. A semaphore is the chain's real
    /// equivalent: same serial order, and waiting costs no thread.
    permits: Arc<Semaphore>,
    queue_limit: usize,
    wait_for_turn: Duration,
}

#[derive(Debug, Default)]
struct QueueState {
    queued_count: usize,
    active_targets: BTreeMap<String, LifecycleTransitionInput>,
    /// What owns the queue right now, and since when. Kept out of
    /// `diagnostics` on purpose: that JSON is pinned field for field against
    /// the Node contract. This exists so a refusal can name the operation it
    /// waited on rather than say only that it gave up.
    holder: Option<QueueHolder>,
    telemetry: LifecycleMutationTelemetry,
}

#[derive(Debug, Clone)]
struct QueueHolder {
    transition: Option<LifecycleTransitionInput>,
    since: Instant,
}

impl QueueHolder {
    fn describe(&self) -> String {
        let held_ms = self.since.elapsed().as_millis();
        match &self.transition {
            Some(transition) => {
                let target = transition
                    .target_id
                    .as_deref()
                    .or(transition.target_path.as_deref())
                    .unwrap_or("an unnamed target");
                format!(
                    "{} on {target}, running for {held_ms}ms",
                    transition.operation
                )
            }
            None => format!("an untracked mutation, running for {held_ms}ms"),
        }
    }
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
        Self::with_wait_for_turn(queue_limit, WAIT_FOR_TURN_TIMEOUT)
    }

    /// The same queue with a shorter patience, so a test can reach the refusal
    /// without sitting through the real bound.
    pub fn with_wait_for_turn(queue_limit: usize, wait_for_turn: Duration) -> Self {
        Self {
            inner: Arc::new(QueueInner {
                state: Mutex::new(QueueState::default()),
                permits: Arc::new(Semaphore::new(1)),
                queue_limit,
                wait_for_turn,
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
        let mut permit = self.begin(transition)?;

        let started_at = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(action));

        match result {
            Ok(Ok(value)) => {
                permit.succeed(started_at);
                Ok(Ok(value))
            }
            Ok(Err(error)) => {
                permit.fail(started_at, error.clone());
                Ok(Err(error))
            }
            Err(payload) => {
                permit.fail(started_at, "lifecycle mutation panicked".into());
                std::panic::resume_unwind(payload);
            }
        }
    }

    /// Take the queue from a thread that may block: a plain thread, or the
    /// blocking pool the sync router runs on.
    ///
    /// From an async worker this panics, naming the caller, which is
    /// deliberate: the wait used to be a `Condvar` and parking two workers
    /// wedged the whole project service with no error and no timeout. A panic
    /// that says which route did it is the outcome `block_on_named` already
    /// gives every other blocking seam in this crate; async callers want
    /// [`Self::begin_async`].
    pub fn begin(
        &self,
        transition: Option<LifecycleTransitionInput>,
    ) -> Result<LifecycleMutationPermit, LifecycleMutationError> {
        // aimux-async-seam: permanent - sync router and CLI callers take the queue from a blocking thread
        block_on_named("lifecycle-queue:begin", self.begin_async(transition))
    }

    /// Take the queue without occupying the thread while waiting.
    pub async fn begin_async(
        &self,
        transition: Option<LifecycleTransitionInput>,
    ) -> Result<LifecycleMutationPermit, LifecycleMutationError> {
        let queued_at = Instant::now();
        let reservation = self.reserve(transition.as_ref())?;
        let acquired = tokio::time::timeout(
            self.inner.wait_for_turn,
            Arc::clone(&self.inner.permits).acquire_owned(),
        )
        .await;
        let permit = match acquired {
            Ok(permit) => permit.expect("lifecycle queue semaphore is never closed"),
            // The reservation drops on the way out, so the target this gave up
            // on is free for the next attempt.
            Err(_) => return Err(self.holder_stuck(transition, queued_at)),
        };
        let (target_key, tracked) = reservation.commit();
        {
            let mut state = self.inner.state.lock().expect("lifecycle queue lock");
            state.holder = Some(QueueHolder {
                transition: transition.clone(),
                since: Instant::now(),
            });
            if tracked {
                state.telemetry.started += 1;
                state.telemetry.max_queued_ms = state
                    .telemetry
                    .max_queued_ms
                    .max(queued_at.elapsed().as_millis());
                state.telemetry.last_started_at = Some(now_iso());
            }
        }
        Ok(LifecycleMutationPermit {
            inner: Arc::clone(&self.inner),
            permit: Some(permit),
            target_key,
            tracked,
            finished: false,
        })
    }

    /// Refuse a wait that outlasted any client still listening, naming what it
    /// was waiting on. A wait that just expires tells nobody anything.
    fn holder_stuck(
        &self,
        transition: Option<LifecycleTransitionInput>,
        queued_at: Instant,
    ) -> LifecycleMutationError {
        let holder = self
            .inner
            .state
            .lock()
            .expect("lifecycle queue lock")
            .holder
            .as_ref()
            .map(QueueHolder::describe)
            .unwrap_or_else(|| "a mutation that left no record".to_owned());
        let requested = transition
            .unwrap_or_else(|| LifecycleTransitionInput::new("lifecycle.unknown", "project"));
        let waited_ms = queued_at.elapsed().as_millis();
        log_at(
            LogLevel::Error,
            "lifecycle mutation gave up waiting for the queue",
            "project-service",
            Some(json!({
                "operation": requested.operation,
                "targetKind": requested.target_kind,
                "targetId": requested.target_id,
                "targetPath": requested.target_path,
                "holder": holder,
                "waitedMs": waited_ms,
            })),
        );
        LifecycleMutationError::HolderStuck {
            requested: Box::new(requested),
            holder,
            waited_ms,
        }
    }

    /// Claim the target and the queue slot, which happens before the wait and
    /// is what a second mutation of the same target is refused against.
    fn reserve(
        &self,
        transition: Option<&LifecycleTransitionInput>,
    ) -> Result<QueueReservation, LifecycleMutationError> {
        let Some(transition) = transition else {
            return Ok(QueueReservation {
                inner: Arc::clone(&self.inner),
                target_key: None,
                tracked: false,
                committed: false,
            });
        };
        let target_key = transition.target_key();
        let mut state = self.inner.state.lock().expect("lifecycle queue lock");
        if let Some(key) = target_key.as_ref()
            && let Some(active) = state.active_targets.get(key).cloned()
        {
            state.telemetry.rejected_conflicts += 1;
            return Err(LifecycleMutationError::Conflict {
                requested: Box::new(transition.clone()),
                active: Box::new(active),
            });
        }
        if state.queued_count >= self.inner.queue_limit {
            state.telemetry.rejected_queue_full += 1;
            return Err(LifecycleMutationError::QueueFull {
                requested: Box::new(transition.clone()),
                queued_count: state.queued_count,
                limit: self.inner.queue_limit,
            });
        }
        if let Some(key) = target_key.as_ref() {
            state.active_targets.insert(key.clone(), transition.clone());
        }
        state.queued_count += 1;
        state.telemetry.enqueued += 1;
        state.telemetry.max_queued_count = state.telemetry.max_queued_count.max(state.queued_count);
        Ok(QueueReservation {
            inner: Arc::clone(&self.inner),
            target_key,
            tracked: true,
            committed: false,
        })
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

/// The bookkeeping a mutation holds before it owns the queue, and gives back
/// if it never gets there.
///
/// `begin_async` awaits between claiming the target and owning the queue, and
/// the async lifecycle route races its future against the client's socket
/// (`route_async_lifecycle_with_disconnect_and_route`), so a caller that hangs
/// up while waiting drops that future mid-await. Rolling back by hand would
/// miss exactly that case and leave the target claimed for the life of the
/// process — every later mutation of it refused with a 409, and the queue
/// depth creeping toward its limit until everything 429s.
struct QueueReservation {
    inner: Arc<QueueInner>,
    target_key: Option<String>,
    tracked: bool,
    committed: bool,
}

impl QueueReservation {
    fn commit(mut self) -> (Option<String>, bool) {
        self.committed = true;
        (self.target_key.clone(), self.tracked)
    }
}

impl Drop for QueueReservation {
    fn drop(&mut self) {
        if self.committed || !self.tracked {
            return;
        }
        // Tolerate a poisoned lock rather than panic: this runs during
        // unwinding, and a panic in a drop aborts the process. Giving the claim
        // back matters more than the lock's history.
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.queued_count = state.queued_count.saturating_sub(1);
        if let Some(key) = self.target_key.take() {
            state.active_targets.remove(&key);
        }
    }
}

pub struct LifecycleMutationPermit {
    inner: Arc<QueueInner>,
    /// Taken on release rather than dropped with the struct: the async route
    /// settles its permit and then awaits a statusline refresh, and the next
    /// mutation must not wait for that.
    permit: Option<OwnedSemaphorePermit>,
    target_key: Option<String>,
    tracked: bool,
    finished: bool,
}

impl LifecycleMutationPermit {
    pub fn succeed(&mut self, started_at: Instant) {
        self.release(started_at, None);
    }

    pub fn fail(&mut self, started_at: Instant, error: String) {
        self.release(started_at, Some(error));
    }

    fn release(&mut self, started_at: Instant, error: Option<String>) {
        if self.finished {
            return;
        }
        self.finished = true;
        release_lifecycle_mutation(
            &self.inner,
            self.tracked,
            self.target_key.take(),
            started_at,
            error,
        );
        drop(self.permit.take());
    }
}

impl Drop for LifecycleMutationPermit {
    fn drop(&mut self) {
        if !self.finished {
            release_lifecycle_mutation(
                &self.inner,
                self.tracked,
                self.target_key.take(),
                Instant::now(),
                Some("lifecycle mutation cancelled before completion".into()),
            );
        }
        drop(self.permit.take());
    }
}

fn release_lifecycle_mutation(
    inner: &QueueInner,
    tracked: bool,
    target_key: Option<String>,
    started_at: Instant,
    error: Option<String>,
) {
    // Reached from `Drop for LifecycleMutationPermit` too, so the same rule
    // applies: releasing the queue must not be the thing that aborts.
    let mut state = inner
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    state.holder = None;
    if tracked {
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
        if let Some(error) = error {
            state.telemetry.failed += 1;
            state.telemetry.last_error = Some(error);
        } else {
            state.telemetry.succeeded += 1;
            state.telemetry.last_error = None;
        }
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
        routes::agents::SPAWN => {
            Some(LifecycleTransitionInput::new("agent.spawn", "agent").with_target_id(session_id))
        }
        // The agent being forked is the one a fork contends for, and
        // `sourceSessionId` is what every fork dispatcher sends. Reading
        // `sessionId` here left the target empty, so a fork and a stop of the
        // same agent did not contend. The response transition still names the
        // new session: this one names what is held while the fork runs.
        routes::agents::FORK => Some(
            LifecycleTransitionInput::new("agent.fork", "agent")
                .with_target_id(trimmed_string(body.get("sourceSessionId"))),
        ),
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
        routes::graveyard_actions::REAP_DEAD_AGENTS => Some(
            LifecycleTransitionInput::new("graveyard.agent.reapDead", "agent")
                .with_target_id(session_id),
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
