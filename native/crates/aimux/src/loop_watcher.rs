//! The managed-loop watcher.
//!
//! An agent in a managed loop that has stopped without waiting on a human is a
//! nudge candidate. With an overseer present the watcher wakes the overseer with
//! a briefing and lets it decide; without one it stays observe-only unless
//! `loop.autoNudgeWithoutOverseer` is set. waiting/error/interrupted states are
//! deliberately excluded — those are genuine pauses we must not steamroll.

use crate::atomic_write::write_json_atomic;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// One nudge the watcher wants delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopSend {
    pub session_id: String,
    pub text: String,
    pub signature: String,
    pub kind: LoopSendKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopSendKind {
    OverseerBriefing,
    DirectNudge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopDeliveryOutcome {
    Delivered,
    Failed { error: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopDeliveryRecord {
    pub at_ms: i64,
    pub session_id: String,
    pub signature: String,
    pub kind: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Cross-scan state: who was nudged when, and when the overseer was last woken.
#[derive(Debug, Default)]
pub struct LoopWatcher {
    last_nudge_at: BTreeMap<String, i64>,
    last_overseer_wake_at: i64,
    stopped_since: BTreeMap<LoopDwellKey, LoopStoppedState>,
    pending_send_keys: BTreeMap<String, Vec<LoopDwellKey>>,
    delivery_records: Vec<LoopDeliveryRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct LoopDwellKey {
    session_id: String,
    loop_since: String,
    goal: String,
    loop_source: String,
}

#[derive(Debug, Clone)]
struct LoopStoppedState {
    first_seen_ms: i64,
    last_attempted_ms: Option<i64>,
    last_reported_ms: Option<i64>,
    unchanged_candidate_ticks: u64,
    last_instruction_signature: Option<String>,
}

impl LoopStoppedState {
    fn new(now_ms: i64, instruction_signature: Option<String>) -> Self {
        Self {
            first_seen_ms: now_ms,
            last_attempted_ms: None,
            last_reported_ms: None,
            unchanged_candidate_ticks: 0,
            last_instruction_signature: instruction_signature,
        }
    }

    fn reset_after_instruction(&mut self, now_ms: i64, instruction_signature: Option<String>) {
        self.first_seen_ms = now_ms;
        self.last_attempted_ms = None;
        self.last_reported_ms = None;
        self.unchanged_candidate_ticks = 0;
        self.last_instruction_signature = instruction_signature;
    }
}

struct DwelledCandidate {
    key: LoopDwellKey,
    value: Value,
}

impl LoopWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Scan once and deliver.
    ///
    /// `input` carries `sessions`, `metadata`, `config` and `pendingInteractions`.
    /// `deliver` reports whether the send landed. Failed sends are recorded as
    /// attempts so the same unchanged alert does not look brand new on the next
    /// tick.
    pub fn scan(
        &mut self,
        input: &Value,
        now_ms: i64,
        deliver: &mut dyn FnMut(&LoopSend) -> bool,
    ) -> Vec<LoopSend> {
        let sends = self.plan_sends(input, now_ms);
        for send in &sends {
            let outcome = if deliver(send) {
                LoopDeliveryOutcome::Delivered
            } else {
                LoopDeliveryOutcome::Failed {
                    error: "delivery callback returned false".to_owned(),
                }
            };
            self.commit_send_result(send, now_ms, outcome);
        }
        sends
    }

    pub fn plan_sends(&mut self, input: &Value, now_ms: i64) -> Vec<LoopSend> {
        let mut sends = Vec::new();
        let metadata = input.get("metadata").unwrap_or(&Value::Null);
        let overseer_id = find_overseer_session_id(metadata);
        let raw_candidates = find_loop_candidates_with_overseer(input, overseer_id.as_deref());
        let candidates = self.dwelled_candidates(
            raw_candidates,
            now_ms,
            config_i64(input, "stoppedDwellMs", 0),
            config_i64(input, "nudgeCooldownMs", 60_000),
            config_u64(input, "unchangedReminderTicks"),
        );
        if candidates.is_empty() {
            return sends;
        }

        let cooldown = config_i64(input, "nudgeCooldownMs", 60_000);
        let overseer_running = overseer_id
            .as_deref()
            .is_some_and(|id| session_exists(input, id));

        if let Some(overseer_id) = overseer_id.filter(|_| overseer_running) {
            let values = candidates
                .iter()
                .map(|candidate| candidate.value.clone())
                .collect::<Vec<_>>();
            let candidate_sig = candidate_signature(&values);
            let send = LoopSend {
                session_id: overseer_id,
                text: build_overseer_briefing(
                    &values,
                    config_string(input, "overseerBriefingTemplate"),
                ),
                signature: candidate_sig.clone(),
                kind: LoopSendKind::OverseerBriefing,
            };
            self.pending_send_keys.insert(
                candidate_sig,
                candidates
                    .into_iter()
                    .map(|candidate| candidate.key)
                    .collect::<Vec<_>>(),
            );
            sends.push(send);
            return sends;
        }

        if !input
            .get("config")
            .and_then(|config| config.get("autoNudgeWithoutOverseer"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return sends;
        }

        for candidate in candidates {
            let id = str_field(&candidate.value, "id").to_owned();
            if now_ms - self.last_nudge_at.get(&id).copied().unwrap_or(0) < cooldown {
                continue;
            }
            let signature = candidate_signature(std::slice::from_ref(&candidate.value));
            let send = LoopSend {
                session_id: id.clone(),
                text: build_canned_nudge(&candidate.value),
                signature: signature.clone(),
                kind: LoopSendKind::DirectNudge,
            };
            self.pending_send_keys
                .insert(signature, vec![candidate.key]);
            sends.push(send);
        }
        sends
    }

    pub fn commit_send_result(
        &mut self,
        send: &LoopSend,
        now_ms: i64,
        outcome: LoopDeliveryOutcome,
    ) {
        match send.kind {
            LoopSendKind::OverseerBriefing => {
                self.last_overseer_wake_at = now_ms;
            }
            LoopSendKind::DirectNudge => {
                self.last_nudge_at.insert(send.session_id.clone(), now_ms);
            }
        }
        let delivered = matches!(outcome, LoopDeliveryOutcome::Delivered);
        if let Some(keys) = self.pending_send_keys.remove(&send.signature) {
            for key in keys {
                if let Some(state) = self.stopped_since.get_mut(&key) {
                    state.last_attempted_ms = Some(now_ms);
                    if delivered {
                        state.last_reported_ms = Some(now_ms);
                    }
                    state.unchanged_candidate_ticks = 0;
                }
            }
        }
        self.record_delivery(send, now_ms, outcome);
    }

    pub fn last_delivery_record(&self) -> Option<&LoopDeliveryRecord> {
        self.delivery_records.last()
    }

    fn record_delivery(&mut self, send: &LoopSend, now_ms: i64, outcome: LoopDeliveryOutcome) {
        let (outcome, error) = match outcome {
            LoopDeliveryOutcome::Delivered => ("delivered".to_owned(), None),
            LoopDeliveryOutcome::Failed { error } => ("failed".to_owned(), Some(error)),
        };
        self.delivery_records.push(LoopDeliveryRecord {
            at_ms: now_ms,
            session_id: send.session_id.clone(),
            signature: send.signature.clone(),
            kind: match send.kind {
                LoopSendKind::OverseerBriefing => "overseerBriefing",
                LoopSendKind::DirectNudge => "directNudge",
            }
            .to_owned(),
            outcome,
            error,
        });
        if self.delivery_records.len() > 32 {
            let excess = self.delivery_records.len().saturating_sub(32);
            self.delivery_records.drain(0..excess);
        }
    }

    fn dwelled_candidates(
        &mut self,
        candidates: Vec<Value>,
        now_ms: i64,
        dwell_ms: i64,
        cooldown_ms: i64,
        reminder_ticks: Option<u64>,
    ) -> Vec<DwelledCandidate> {
        let dwell_ms = dwell_ms.max(0);
        let cooldown_ms = cooldown_ms.max(0);
        let keyed_candidates = candidates
            .into_iter()
            .filter_map(|candidate| dwell_key(&candidate).map(|key| (key, candidate)))
            .collect::<Vec<_>>();
        let current_keys = keyed_candidates
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<BTreeSet<_>>();
        self.stopped_since
            .retain(|key, _| current_keys.contains(key));
        keyed_candidates
            .into_iter()
            .filter_map(|(key, candidate)| {
                let instruction_signature = instruction_cadence_signature(&candidate);
                let state = self.stopped_since.entry(key.clone()).or_insert_with(|| {
                    LoopStoppedState::new(now_ms, instruction_signature.clone())
                });
                if state.last_instruction_signature != instruction_signature
                    && instruction_signature.is_some()
                {
                    state.reset_after_instruction(now_ms, instruction_signature);
                } else {
                    state.last_instruction_signature = instruction_signature;
                    if state.last_attempted_ms.is_some() {
                        state.unchanged_candidate_ticks =
                            state.unchanged_candidate_ticks.saturating_add(1);
                    }
                }
                if now_ms.saturating_sub(state.first_seen_ms) < dwell_ms {
                    return None;
                }
                stopped_candidate_due(state, now_ms, cooldown_ms, reminder_ticks).then_some(
                    DwelledCandidate {
                        key,
                        value: candidate,
                    },
                )
            })
            .collect()
    }
}

pub fn loop_watcher_state_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("loop-watcher-state.json")
}

pub fn load_loop_watcher_state(path: impl AsRef<Path>) -> Result<LoopWatcher, String> {
    let path = path.as_ref();
    match fs::read_to_string(path) {
        Ok(raw) => {
            let state: PersistentLoopWatcherState = serde_json::from_str(&raw)
                .map_err(|error| format!("read loop watcher state {}: {error}", path.display()))?;
            state.into_watcher()
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LoopWatcher::new()),
        Err(error) => Err(format!(
            "read loop watcher state {}: {error}",
            path.display()
        )),
    }
}

pub fn save_loop_watcher_state(
    path: impl AsRef<Path>,
    watcher: &LoopWatcher,
) -> Result<(), String> {
    let state = PersistentLoopWatcherState::from_watcher(watcher);
    write_json_atomic(path.as_ref(), &state).map_err(|error| {
        format!(
            "write loop watcher state {}: {error}",
            path.as_ref().display()
        )
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistentLoopWatcherState {
    version: u32,
    last_nudge_at: BTreeMap<String, i64>,
    last_overseer_wake_at: i64,
    stopped_since: Vec<PersistentStoppedSince>,
    #[serde(default)]
    last_candidate_signature: Option<String>,
    #[serde(default)]
    last_overseer_reported_signature: Option<String>,
    #[serde(default)]
    last_overseer_attempted_signature: Option<String>,
    #[serde(default)]
    unchanged_candidate_ticks: u64,
    #[serde(default)]
    delivery_records: Vec<LoopDeliveryRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistentStoppedSince {
    session_id: String,
    loop_since: String,
    goal: String,
    loop_source: String,
    first_seen_ms: i64,
    #[serde(default)]
    last_attempted_ms: Option<i64>,
    #[serde(default)]
    last_reported_ms: Option<i64>,
    #[serde(default)]
    unchanged_candidate_ticks: u64,
    #[serde(default)]
    last_instruction_signature: Option<String>,
}

impl PersistentLoopWatcherState {
    fn from_watcher(watcher: &LoopWatcher) -> Self {
        Self {
            version: 1,
            last_nudge_at: watcher.last_nudge_at.clone(),
            last_overseer_wake_at: watcher.last_overseer_wake_at,
            stopped_since: watcher
                .stopped_since
                .iter()
                .map(|(key, state)| PersistentStoppedSince {
                    session_id: key.session_id.clone(),
                    loop_since: key.loop_since.clone(),
                    goal: key.goal.clone(),
                    loop_source: key.loop_source.clone(),
                    first_seen_ms: state.first_seen_ms,
                    last_attempted_ms: state.last_attempted_ms,
                    last_reported_ms: state.last_reported_ms,
                    unchanged_candidate_ticks: state.unchanged_candidate_ticks,
                    last_instruction_signature: state.last_instruction_signature.clone(),
                })
                .collect(),
            last_candidate_signature: None,
            last_overseer_reported_signature: None,
            last_overseer_attempted_signature: None,
            unchanged_candidate_ticks: 0,
            delivery_records: watcher.delivery_records.clone(),
        }
    }

    fn into_watcher(self) -> Result<LoopWatcher, String> {
        if self.version != 1 {
            return Err(format!(
                "unsupported loop watcher state version {}",
                self.version
            ));
        }
        let legacy_attempted_ms = self
            .last_overseer_attempted_signature
            .as_ref()
            .map(|_| self.last_overseer_wake_at)
            .filter(|at_ms| *at_ms > 0);
        let legacy_reported_ms = self
            .last_overseer_reported_signature
            .as_ref()
            .map(|_| self.last_overseer_wake_at)
            .filter(|at_ms| *at_ms > 0);
        Ok(LoopWatcher {
            last_nudge_at: self.last_nudge_at,
            last_overseer_wake_at: self.last_overseer_wake_at,
            stopped_since: self
                .stopped_since
                .into_iter()
                .map(|record| {
                    (
                        LoopDwellKey {
                            session_id: record.session_id,
                            loop_since: record.loop_since,
                            goal: record.goal,
                            loop_source: record.loop_source,
                        },
                        LoopStoppedState {
                            first_seen_ms: record.first_seen_ms,
                            last_attempted_ms: record.last_attempted_ms.or(legacy_attempted_ms),
                            last_reported_ms: record.last_reported_ms.or(legacy_reported_ms),
                            unchanged_candidate_ticks: record
                                .unchanged_candidate_ticks
                                .max(self.unchanged_candidate_ticks),
                            last_instruction_signature: record.last_instruction_signature,
                        },
                    )
                })
                .collect(),
            pending_send_keys: BTreeMap::new(),
            delivery_records: self.delivery_records,
        })
    }
}

pub fn find_loop_candidates_with_overseer(input: &Value, overseer_id: Option<&str>) -> Vec<Value> {
    let metadata = input.get("metadata").unwrap_or(&Value::Null);
    let metadata_sessions = match metadata.get("sessions").and_then(Value::as_object) {
        Some(sessions) => sessions,
        None => empty_object(),
    };
    let pending = input
        .get("pendingInteractions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();

    array_field(input, "sessions")
        .iter()
        .filter_map(|session| {
            let id = str_field(session, "id");
            if overseer_id == Some(id) || pending.contains(id) {
                return None;
            }
            let meta = metadata_sessions.get(id)?;
            let loop_meta = meta.get("loop").and_then(Value::as_object)?;
            if !loop_meta
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return None;
            }
            let activity = meta
                .get("derived")
                .and_then(|derived| derived.get("activity"))
                .and_then(Value::as_str);
            if activity != Some("idle") && activity != Some("done") {
                return None;
            }
            let attention = meta
                .get("derived")
                .and_then(|derived| derived.get("attention"))
                .and_then(Value::as_str)
                .unwrap_or("normal");
            if attention != "normal" {
                return None;
            }

            let mut candidate = Map::new();
            insert_str(&mut candidate, "id", Some(id));
            insert_value(&mut candidate, "goal", loop_meta.get("goal"));
            insert_value(&mut candidate, "worktreePath", session.get("worktreePath"));
            insert_value(&mut candidate, "tool", session.get("tool"));
            insert_value(&mut candidate, "loopSince", loop_meta.get("since"));
            insert_value(&mut candidate, "loopSource", loop_meta.get("source"));
            insert_value(&mut candidate, "loopUpdatedBy", loop_meta.get("updatedBy"));
            insert_value(
                &mut candidate,
                "loopUpdatedBySessionId",
                loop_meta.get("updatedBySessionId"),
            );
            insert_value(
                &mut candidate,
                "loopUpdatedByRole",
                loop_meta.get("updatedByRole"),
            );
            insert_value(&mut candidate, "loopLastAction", meta.get("loopLastAction"));
            Some(Value::Object(candidate))
        })
        .collect()
}

pub fn build_overseer_briefing(candidates: &[Value], template: Option<&str>) -> String {
    if let Some(template) = template
        .map(str::trim)
        .filter(|template| !template.is_empty())
    {
        return render_overseer_briefing_template(template, candidates);
    }

    let mut lines = Vec::from([String::from(
        "[aimux loop check] These agents are in a managed loop but appear to have stopped:",
    )]);
    lines.extend(candidates.iter().map(describe_candidate));
    lines.extend([
        String::new(),
        String::from(
            "Current loop membership is authoritative. If a listed agent was previously removed, the shown loop-since/source is newer state; do not remove it merely because you remember an older removal.",
        ),
        String::from(
            "For each: read its recent output with `aimux host agent-read <id>`, then decide whether it stopped prematurely.",
        ),
        String::from(
            "If it should keep going, send a specific next instruction with `aimux input <id> \"…\"`.",
        ),
        String::from(
            "If it genuinely finished its goal or is blocked beyond repair, run `aimux loop remove <id>` and report back.",
        ),
    ]);
    lines.join("\n")
}

fn render_overseer_briefing_template(template: &str, candidates: &[Value]) -> String {
    replace_template_token(
        &replace_template_token(template, "count", &candidates.len().to_string()),
        "candidates",
        &candidates
            .iter()
            .map(describe_candidate)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn replace_template_token(template: &str, token: &str, replacement: &str) -> String {
    let chars = template.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars.get(index) == Some(&'{')
            && chars.get(index + 1) == Some(&'{')
            && let Some(close_offset) = chars[index + 2..]
                .windows(2)
                .position(|window| window == ['}', '}'])
        {
            let close = index + 2 + close_offset;
            let name = chars[index + 2..close]
                .iter()
                .collect::<String>()
                .trim()
                .to_string();
            if name == token {
                output.push_str(replacement);
                index = close + 2;
                continue;
            }
        }
        output.push(chars[index]);
        index += 1;
    }
    output
}

pub fn describe_candidate(candidate: &Value) -> String {
    let id = str_field(candidate, "id");
    let tool = optional_str(candidate, "tool")
        .map(|tool| format!(" ({tool})"))
        .unwrap_or_default();
    let where_text = optional_str(candidate, "worktreePath")
        .map(|path| format!(" @ {path}"))
        .unwrap_or_default();
    let goal = optional_str(candidate, "goal")
        .map(|goal| format!(" — goal: {goal}"))
        .unwrap_or_default();
    let actor = [
        optional_str(candidate, "loopSource"),
        optional_str(candidate, "loopUpdatedBySessionId")
            .or_else(|| optional_str(candidate, "loopUpdatedBy")),
        optional_str(candidate, "loopUpdatedByRole"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("/");
    let provenance = if actor.is_empty() {
        format!(" — loop since {}", str_field(candidate, "loopSince"))
    } else {
        format!(
            " — loop since {} by {actor}",
            str_field(candidate, "loopSince")
        )
    };
    let last_action = candidate
        .get("loopLastAction")
        .filter(|action| str_field(action, "action") != "add")
        .map(|action| {
            format!(
                " — last loop action: {} at {}",
                str_field(action, "action"),
                str_field(action, "at")
            )
        })
        .unwrap_or_default();

    format!("- {id}{tool}{where_text}{provenance}{last_action}{goal}")
}

pub fn build_canned_nudge(candidate: &Value) -> String {
    let goal = optional_str(candidate, "goal")
        .map(|goal| format!(" with this goal: {goal}"))
        .unwrap_or_default();
    [
        format!("[aimux loop] You stopped, but you're in a managed loop{goal}."),
        String::from(
            "Keep working toward it now. Only stop when you have genuinely finished or are blocked beyond repair:",
        ),
        String::from("- finished  → run `aimux loop done --reason \"…\"`"),
        String::from("- hard-blocked → run `aimux loop block --reason \"…\"`"),
        String::from("Otherwise, continue."),
    ]
    .join("\n")
}

pub fn find_overseer_session_id(metadata: &Value) -> Option<String> {
    metadata
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|sessions| {
            sessions.iter().find_map(|(id, meta)| {
                meta.get("overseer")
                    .and_then(Value::as_bool)
                    .filter(|overseer| *overseer)
                    .map(|_| id.clone())
            })
        })
}

fn session_exists(input: &Value, id: &str) -> bool {
    array_field(input, "sessions")
        .iter()
        .any(|session| str_field(session, "id") == id)
}

fn stopped_candidate_due(
    state: &LoopStoppedState,
    now_ms: i64,
    cooldown_ms: i64,
    reminder_ticks: Option<u64>,
) -> bool {
    let Some(last_attempted_ms) = state.last_attempted_ms else {
        return true;
    };
    if now_ms.saturating_sub(last_attempted_ms) < cooldown_ms {
        return false;
    }
    if let Some(ticks) = reminder_ticks {
        let ticks = ticks.max(1);
        return state.unchanged_candidate_ticks > 0
            && state.unchanged_candidate_ticks.is_multiple_of(ticks);
    }
    true
}

fn instruction_cadence_signature(candidate: &Value) -> Option<String> {
    let action = candidate.get("loopLastAction")?;
    if str_field(action, "action") == "add" {
        return None;
    }
    serde_json::to_string(action).ok()
}

fn candidate_signature(candidates: &[Value]) -> String {
    let mut ids = candidates
        .iter()
        .map(|candidate| {
            [
                str_field(candidate, "id"),
                str_field(candidate, "loopSince"),
                optional_str(candidate, "goal").unwrap_or_default(),
                optional_str(candidate, "loopSource").unwrap_or_default(),
            ]
            .join("\u{1f}")
        })
        .collect::<Vec<_>>();
    ids.sort();
    ids.join("\u{1e}")
}

fn dwell_key(candidate: &Value) -> Option<LoopDwellKey> {
    optional_str(candidate, "id").map(|session_id| LoopDwellKey {
        session_id: session_id.to_owned(),
        loop_since: str_field(candidate, "loopSince").to_owned(),
        goal: optional_str(candidate, "goal")
            .unwrap_or_default()
            .to_owned(),
        loop_source: optional_str(candidate, "loopSource")
            .unwrap_or_default()
            .to_owned(),
    })
}

fn config_i64(input: &Value, field: &str, fallback: i64) -> i64 {
    input
        .get("config")
        .and_then(|config| config.get(field))
        .and_then(Value::as_i64)
        .unwrap_or(fallback)
}

fn config_u64(input: &Value, field: &str) -> Option<u64> {
    input
        .get("config")
        .and_then(|config| config.get(field))
        .and_then(Value::as_u64)
}

fn config_string<'a>(input: &'a Value, field: &str) -> Option<&'a str> {
    input
        .get("config")
        .and_then(|config| config.get(field))
        .and_then(Value::as_str)
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        map.insert(key.to_string(), value.clone());
    }
}

fn insert_str(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(key.to_string(), json!(value));
    }
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn optional_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn empty_object() -> &'static Map<String, Value> {
    static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
    &EMPTY
}
