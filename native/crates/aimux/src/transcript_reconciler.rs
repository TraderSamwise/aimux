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

use serde_json::Value;

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
    fn settle_activity(&mut self, session_id: &str);
    /// Clear a stranded `needs_response` attention back to normal.
    fn clear_stale_response(&mut self, session_id: &str);
    fn probe(&mut self, tool_config_key: &str, path: &str) -> Option<TranscriptProbe>;
    fn find_codex_path(&mut self, backend_session_id: &str) -> Option<String>;
}

#[derive(Clone, Debug)]
pub struct SessionView {
    pub id: String,
    pub tool_config_key: String,
    pub backend_session_id: Option<String>,
    pub worktree_path: Option<String>,
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
        })
    }
}

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
                    deps.clear_stale_response(&session.id);
                    self.pending_clear.remove(&session.id);
                } else {
                    self.pending_clear.insert(session.id.clone());
                }
            } else {
                self.pending_clear.remove(&session.id);
            }

            // Part A — settle a stuck "working" agent against transcript ground truth.
            let stuck_working =
                matches!(activity, Some("running" | "waiting")) && attention == Some("normal");
            if !stuck_working {
                self.pending.remove(&session.id);
                continue;
            }

            let Some(path) = self.resolve_transcript_path(session, metadata, deps) else {
                self.pending.remove(&session.id);
                continue;
            };
            let Some(result) = deps.probe(&session.tool_config_key, &path) else {
                self.pending.remove(&session.id);
                continue;
            };
            if result.turn != "complete" {
                self.pending.remove(&session.id);
                continue;
            }

            if self.pending.get(&session.id) == Some(&result) {
                // Complete and quiescent across a full tick — the turn is over.
                deps.settle_activity(&session.id);
                self.pending.remove(&session.id);
            } else {
                self.pending.insert(session.id.clone(), result);
            }
        }

        self.pending.retain(|id, _| live.contains(id));
        self.codex_path_cache.retain(|id, _| live.contains(id));
        self.codex_miss.retain(|id, _| live.contains(id));
        self.pending_clear.retain(|id| live.contains(id));
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
