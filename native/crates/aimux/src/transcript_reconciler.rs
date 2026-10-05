//! Keeps an agent's derived `activity` in sync with the deterministic turn-state
//! recorded in its transcript.
//!
//! The event-driven state machine (Claude/Codex hooks) can strand
//! `activity:"running"` whenever the clearing `stop` event is dropped — compact,
//! interrupt, daemon down, resume. When the transcript shows the turn is
//! genuinely complete AND the file has gone quiescent (unchanged since the prior
//! tick, because a working agent is still appending), the session is settled so
//! it reads "ready" instead of "working".
//!
//! All I/O is behind [`TranscriptReconcilerDeps`]; this module is pure.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::{Map, Value};

pub use crate::transcript_turn_state::TranscriptProbe;

/// Node's `intervalMs ?? 4000`.
pub const DEFAULT_INTERVAL_MS: i64 = 4_000;

/// Ticks to skip re-scanning the Codex session tree after a path lookup miss, so
/// a not-yet-written transcript doesn't trigger a recursive walk every tick.
const CODEX_MISS_BACKOFF_TICKS: u64 = 8;

pub trait TranscriptReconcilerDeps {
    /// Whether a live interaction request still backs a `needs_response`.
    fn has_pending_interaction(&mut self, session_id: &str) -> bool;
    /// Settle a stuck working agent to idle (label becomes "ready").
    fn settle_activity(&mut self, session_id: &str) -> bool;
    /// Put a session's attention back to `normal`. Used for a stranded
    /// `needs_response` (Part B) and for a project-control session's stranded
    /// `needs_input` (Part C); the name is the one the frozen reconciler
    /// contract emits, so it stays.
    fn clear_stale_response(&mut self, session_id: &str) -> bool;
    fn probe(&mut self, tool_config_key: &str, path: &str) -> Option<TranscriptProbe>;
    fn find_codex_path(&mut self, backend_session_id: &str) -> Option<String>;
}

#[derive(Clone, Debug)]
pub struct SessionView {
    pub id: String,
    pub tool_config_key: String,
    pub backend_session_id: Option<String>,
    pub worktree_path: Option<String>,
    /// The control-flag keys as the topology reports them, so Part C can decide
    /// whether this is an overseer or a scribe.
    ///
    /// The topology's own answer is not the whole answer: metadata can DEMOTE a
    /// session the topology still describes by role, and
    /// `session_with_stored_control_flags` is how every other caller resolves
    /// that -- `scribe_watcher.rs:391` and `project_service/agents.rs:790` both
    /// do. Deciding from the topology alone would read a demoted coder as
    /// control and clear its real prompt, so the merge happens in `scan`, which
    /// has the metadata in hand.
    ///
    /// Narrowed to the five keys that merge reads rather than holding the whole
    /// session, because one of these is built for every live session on every
    /// four-second tick.
    pub control_flags: Value,
}

impl SessionView {
    pub fn from_value(value: &Value) -> Option<Self> {
        let id = value.get("id").and_then(Value::as_str)?.to_owned();
        if id.is_empty() {
            return None;
        }
        Some(Self {
            id,
            tool_config_key: value
                .get("toolConfigKey")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            backend_session_id: non_empty(value.get("backendSessionId")),
            // Node coalesced this with `??`, so an empty string is a present
            // value that wins the fallback and is then rejected as a cwd.
            worktree_path: value
                .get("worktreePath")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            control_flags: control_flag_keys(value),
        })
    }
}

/// What a stranded `needs_input` still needs written, and the probe its dwell
/// is counted against.
#[derive(Debug, Default)]
struct InputClearProgress {
    probe: Option<TranscriptProbe>,
    settled: bool,
    cleared: bool,
    attempts: u32,
}

/// How many ticks Part C retries a write the service keeps rejecting.
///
/// Without a bound a permanently failing clear POSTs every four seconds for the
/// life of the process. Giving up is also the only outcome that gets SAID: a
/// silent retry loop is invisible until it is a load average.
///
/// Giving up half-way leaves `activity: idle` with `attention: needs_input`,
/// which is a shape no other part produces -- and it is worth saying that no
/// consumer reads it worse than the state it replaced. `scribe_readiness` still
/// refuses it, on the attention rather than the activity. And
/// `session_semantics` words it identically: `runtime_lifecycle` returns `idle`
/// instead of `running`, but `user_state` ranks attention above both, so the
/// label is `needs_input` either way. The give-up degrades to exactly the
/// pre-fix state, which is the right failure mode for a repair.
const INPUT_CLEAR_ATTEMPTS: u32 = 5;

#[derive(Default)]
pub struct TranscriptReconciler {
    /// Sessions seen "complete" once, with the transcript stat at that moment, so
    /// we only settle after confirming the file stayed quiescent across a tick.
    pending: HashMap<String, TranscriptProbe>,
    /// Resolved Codex paths keyed by session id but tagged with the
    /// backendSessionId they were resolved for, so a backend-id rewrite on a live
    /// session re-resolves instead of serving a stale path.
    codex_path_cache: HashMap<String, (String, String)>,
    codex_miss: HashMap<String, (String, u64)>,
    /// Sessions seen needing a `needs_response` clear once, awaiting a second tick
    /// so a fast daemon restart can't clear a still-re-registering interaction.
    pending_clear: HashSet<String>,
    /// Part C's own "seen complete once", and which of its two writes still
    /// need making.
    ///
    /// Separate from `pending` rather than sharing it, because a dwell is not a
    /// fact about the file -- it is how long THIS part has been watching.
    /// Sharing one map let a control session bank quiescence while stranded at
    /// `needs_input` and then, on the tick its attention went back to normal
    /// with the agent working again, hand that banked tick to Part A, which
    /// settled the activity immediately: a scribe briefed and relabelled
    /// `ready` in the same breath, with no dwell of Part A's own.
    pending_input: HashMap<String, InputClearProgress>,
    /// Sessions Part C has given up on. Dropping `pending_input` alone did not
    /// stop the retrying: the session is still stranded on the next tick, so
    /// the whole dwell-and-write cycle started again -- thirty-three attempts
    /// over forty ticks rather than five. Giving up has to be remembered.
    ///
    /// Forgotten when the session stops being stranded, so a scribe that is
    /// prompted and later strands again gets a fresh five, and when it leaves
    /// the live set.
    input_clear_abandoned: HashSet<String>,
    tick: u64,
}

impl TranscriptReconciler {
    pub fn new() -> Self {
        Self::default()
    }

    /// One reconciliation pass over the live sessions.
    pub fn scan(
        &mut self,
        sessions: &[SessionView],
        metadata: &Value,
        deps: &mut dyn TranscriptReconcilerDeps,
    ) {
        self.tick += 1;
        let mut live = HashSet::new();

        for session in sessions {
            live.insert(session.id.clone());
            let Some(derived) = session_field(metadata, &session.id, "derived") else {
                continue;
            };
            let activity = derived.get("activity").and_then(Value::as_str);
            let attention = derived.get("attention").and_then(Value::as_str);

            // Part B — clear a needs_response stranded by a lost in-memory
            // interaction registry (e.g. after a daemon restart) once it is still
            // unbacked on a second tick.
            if attention == Some("needs_response") && !deps.has_pending_interaction(&session.id) {
                if self.pending_clear.contains(&session.id) {
                    if deps.clear_stale_response(&session.id) {
                        self.pending_clear.remove(&session.id);
                    }
                } else {
                    self.pending_clear.insert(session.id.clone());
                }
            } else {
                self.pending_clear.remove(&session.id);
            }

            // Part A — settle a stuck "working" agent against transcript ground truth.
            let stuck_working =
                matches!(activity, Some("running" | "waiting")) && attention == Some("normal");

            // Part C — clear a `needs_input` that nothing will ever answer.
            //
            // The event state machine strands `needs_input` the same way it
            // strands `running`: the clearing event is dropped on a compact, an
            // interrupt, a daemon restart or a resume. On a coder that is
            // survivable, because a person reads the prompt and replies, which
            // clears it. On an overseer or a scribe nobody reads the prompt --
            // and the one thing that would talk to a scribe refuses to while it
            // is waiting, because `scribe_readiness` requires activity
            // idle-or-done AND attention normal. So a stranded `needs_input`
            // there is not a stale label, it is a permanent deadlock: observed
            // 2026-10-05 on tealstreet-next, where the scribe had finished its
            // turn at 11:40 PM and had not been briefed in fifteen hours.
            //
            // Gated on the same transcript evidence as Part A, which is what
            // keeps it from discarding a real question: an agent genuinely
            // mid-request has a turn that is not complete. An agent that asked
            // and then ended its turn does read as complete here, and clearing
            // that is still right for a control session -- the alternative is
            // waiting forever for a reader who does not exist. The briefing it
            // then receives arrives as a prompt, which is also the event that
            // clears attention, so a scribe that truly needs something will ask
            // again rather than be silenced.
            let stranded_input = attention == Some("needs_input")
                && crate::team_contract::is_project_control_session(Some(
                    &crate::team_contract::session_with_stored_control_flags(
                        &session.control_flags,
                        session_field_any(metadata, &session.id),
                    ),
                ));

            // Forgotten the moment it is not stranded, on every path and not
            // just the one that bails out early -- a session that is working
            // again has stopped being this problem, so a later strand is a new
            // one and gets its own attempts. Putting this only in the bail-out
            // branch meant a prompted scribe kept its give-up forever, which
            // trades one permanent deadlock for another.
            if !stranded_input {
                self.input_clear_abandoned.remove(&session.id);
            } else if self.input_clear_abandoned.contains(&session.id) {
                continue;
            }

            if !stuck_working && !stranded_input {
                self.pending.remove(&session.id);
                self.pending_input.remove(&session.id);
                continue;
            }

            let Some(path) = self.resolve_transcript_path(session, metadata, deps) else {
                self.pending.remove(&session.id);
                self.pending_input.remove(&session.id);
                continue;
            };
            let Some(result) = deps.probe(&session.tool_config_key, &path) else {
                self.pending.remove(&session.id);
                self.pending_input.remove(&session.id);
                continue;
            };
            if result.turn != "complete" {
                self.pending.remove(&session.id);
                self.pending_input.remove(&session.id);
                continue;
            }

            // Quiescence means the probe is byte-for-byte what the previous
            // tick saw, because a working agent is still appending. Each part
            // compares against its OWN memory: the file fact is shared, the
            // dwell is not.
            if stuck_working {
                // Part C's state is dropped rather than carried, so a control
                // session that has stopped being stranded does not leave a
                // half-finished clear alive behind Part A's back.
                self.pending_input.remove(&session.id);
                if self.pending.get(&session.id) != Some(&result) {
                    self.pending.insert(session.id.clone(), result);
                    continue;
                }
                // Complete and quiescent across a full tick — the turn is over.
                if deps.settle_activity(&session.id) {
                    self.pending.remove(&session.id);
                }
                continue;
            }

            // One tick of quiescence, not two, and what makes that safe is
            // what "complete" means rather than how long we waited: a turn
            // between two tool calls reads `in_progress`, because the last
            // assistant entry's stop_reason is `tool_use`. That is pinned in
            // the frozen `transcript/turn-state.json` ("claude in_progress when
            // last assistant entry is tool_use") and at the task level by
            // `a_mid_turn_transcript_is_never_settled`. So a complete transcript
            // is a finished turn, and a second tick would only wait longer for
            // the same answer.
            //
            // Likewise the other way: a stranded session is not
            // `stuck_working`, so Part A's probe is dropped rather than left
            // where Part A could inherit it later as a tick already served.
            //
            // The consequence, stated because it is a choice: a session that
            // alternates between the two every tick never completes either
            // dwell, so neither part acts. That is the right way round -- both
            // parts are claims that nothing has moved, and a session flipping
            // states every four seconds is moving.
            self.pending.remove(&session.id);
            let progress = self.pending_input.entry(session.id.clone()).or_default();
            if progress.probe.as_ref() != Some(&result) {
                *progress = InputClearProgress {
                    probe: Some(result),
                    ..InputClearProgress::default()
                };
                continue;
            }

            // BOTH fields, not just the attention. `scribe_readiness` requires
            // activity idle-or-done AND attention normal, and a scribe stranded
            // this way has `activity: "waiting"`, so clearing the attention
            // alone leaves it still unready.
            //
            // There is no extra assumption in doing both: complete-and-quiescent
            // is exactly the evidence Part A settles an activity on, so the same
            // conclusion is applied to both fields here. Each half is remembered
            // so a write that landed is not re-POSTed every tick because the
            // other one failed.
            progress.attempts += 1;
            if !progress.settled {
                progress.settled = deps.settle_activity(&session.id);
            }
            if !progress.cleared {
                progress.cleared = deps.clear_stale_response(&session.id);
            }
            if progress.settled && progress.cleared {
                self.pending_input.remove(&session.id);
            } else if progress.attempts >= INPUT_CLEAR_ATTEMPTS {
                let abandoned = session.id.clone();
                crate::debug_logging::log_lifecycle_always(
                    "gave up clearing a stranded control-session attention",
                    "transcript-reconciler",
                    Some(serde_json::json!({
                        "session": session.id,
                        "attempts": progress.attempts,
                        "settledActivity": progress.settled,
                        "clearedAttention": progress.cleared,
                    })),
                );
                self.pending_input.remove(&session.id);
                self.input_clear_abandoned.insert(abandoned);
            }
        }

        self.pending.retain(|id, _| live.contains(id));
        self.codex_path_cache.retain(|id, _| live.contains(id));
        self.codex_miss.retain(|id, _| live.contains(id));
        self.pending_clear.retain(|id| live.contains(id));
        self.pending_input.retain(|id, _| live.contains(id));
        self.input_clear_abandoned.retain(|id| live.contains(id));
    }

    fn resolve_transcript_path(
        &mut self,
        session: &SessionView,
        metadata: &Value,
        deps: &mut dyn TranscriptReconcilerDeps,
    ) -> Option<String> {
        let context = session_field(metadata, &session.id, "context");
        // Claude stores transcripts as `<backendSessionId>.jsonl`, so a stem
        // match lets us keep the cheap stored path. Codex uses
        // `rollout-<ts>-<backendSessionId>.jsonl`; that intentionally misses this
        // check and falls through to the backend-id-indexed Codex resolver/cache
        // below. A successful lookup is cached, and misses back off, which is a
        // better cost than trusting stale context after a rebind.
        if let Some(stored) = context
            .and_then(|context| non_empty(context.get("transcriptPath")))
            .filter(|path| {
                stored_transcript_path_matches_backend(path, session.backend_session_id.as_deref())
            })
        {
            return Some(stored);
        }
        let cwd = match &session.worktree_path {
            Some(worktree_path) => Some(worktree_path.clone()),
            None => context.and_then(|context| {
                context
                    .get("worktreePath")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            }),
        };
        let backend_session_id = session.backend_session_id.as_ref()?;

        if session.tool_config_key == "codex" {
            if let Some((_, cached)) = self
                .codex_path_cache
                .get(&session.id)
                .filter(|(cached_backend_id, _)| cached_backend_id == backend_session_id)
            {
                return Some(cached.clone());
            }
            if self
                .codex_miss
                .get(&session.id)
                .is_some_and(|(miss_backend_id, until)| {
                    miss_backend_id == backend_session_id && self.tick < *until
                })
            {
                return None;
            }
            let found = deps.find_codex_path(backend_session_id);
            match &found {
                Some(path) => {
                    self.codex_path_cache.insert(
                        session.id.clone(),
                        (backend_session_id.clone(), path.clone()),
                    );
                    self.codex_miss.remove(&session.id);
                }
                None => {
                    self.codex_path_cache.remove(&session.id);
                    self.codex_miss.insert(
                        session.id.clone(),
                        (
                            backend_session_id.clone(),
                            self.tick + CODEX_MISS_BACKOFF_TICKS,
                        ),
                    );
                }
            }
            return found;
        }

        let cwd = cwd.filter(|cwd| !cwd.is_empty())?;
        Some(
            crate::backend_session_ids::claude_transcript_path(&cwd, backend_session_id, None)
                .to_string_lossy()
                .into_owned(),
        )
    }
}

/// Just the keys `session_with_stored_control_flags` and
/// `is_project_control_session` read: the three flags, the lane that travels
/// with them, and BOTH places a legacy role can live. `id` comes along so a
/// failure names the session it was about.
///
/// `team` is in that list because `legacy_role` reads `role` or `team.role`,
/// and `agent_topology` deliberately keeps `team: {"role": "scribe"}` on a
/// session that carries no explicit flag -- its own test
/// `topology_session_team_keeps_legacy_scribe_role_without_flags` pins that.
/// Leaving it out made the merged probe carry no role marker at all for
/// exactly that shape, so Part C never fired and the deadlock this change
/// exists to end stayed in place for a legacy scribe. Adding keys here is
/// cheap; forgetting one is silent.
fn control_flag_keys(session: &Value) -> Value {
    let mut probe = Map::new();
    for key in [
        "id",
        "overseer",
        "scribe",
        "projectControl",
        "lane",
        "role",
        "team",
    ] {
        if let Some(value) = session.get(key) {
            probe.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(probe)
}

/// A session's whole metadata record, for the control-flag merge. `session_field`
/// reaches one object inside it; this is the record itself.
fn session_field_any<'a>(metadata: &'a Value, session_id: &str) -> Option<&'a Value> {
    metadata
        .get("sessions")
        .and_then(|sessions| sessions.get(session_id))
        .filter(|value| value.is_object())
}

fn session_field<'a>(metadata: &'a Value, session_id: &str, field: &str) -> Option<&'a Value> {
    metadata
        .get("sessions")
        .and_then(|sessions| sessions.get(session_id))
        .and_then(|session| session.get(field))
        .filter(|value| value.is_object())
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn stored_transcript_path_matches_backend(path: &str, backend_session_id: Option<&str>) -> bool {
    let Some(backend_session_id) = backend_session_id else {
        return false;
    };
    Path::new(path).file_stem().and_then(|stem| stem.to_str()) == Some(backend_session_id)
}
