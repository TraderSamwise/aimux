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
    PausedSummary,
    Reconciliation,
    LoopExit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopDeliveryOutcome {
    Delivered,
    Buffered,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopAlertPause {
    pub paused_at_ms: i64,
    pub loop_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_by_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_by_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopGlobalPause {
    pub paused_at_ms: i64,
    pub expires_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_by_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_by_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferedLoopSend {
    pub first_buffered_at_ms: i64,
    pub last_seen_at_ms: i64,
    pub seen_count: u64,
    pub session_id: String,
    pub text: String,
    pub signature: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidate_keys: Vec<BufferedLoopCandidateKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferedLoopCandidateKey {
    pub session_id: String,
    #[serde(default = "default_stopped_condition")]
    pub condition: String,
    pub loop_since: String,
    pub goal: String,
    pub loop_source: String,
}

/// Cross-scan state: who was nudged when, and when the overseer was last woken.
#[derive(Debug, Default)]
pub struct LoopWatcher {
    last_nudge_at: BTreeMap<String, i64>,
    last_overseer_wake_at: i64,
    stopped_since: BTreeMap<LoopDwellKey, LoopStoppedState>,
    pending_send_keys: BTreeMap<String, Vec<LoopDwellKey>>,
    delivery_records: Vec<LoopDeliveryRecord>,
    paused_loop_alerts: BTreeMap<String, LoopAlertPause>,
    paused_summary_ticks: u64,
    last_paused_summary_signature: Option<String>,
    global_pause: Option<LoopGlobalPause>,
    buffered_sends: BTreeMap<String, BufferedLoopSend>,
    global_pause_reminder_ticks: u64,
    last_reconciliation_signature: Option<String>,
    last_reconciliation_attempted_signature: Option<String>,
    last_reconciliation_reported_signature: Option<String>,
    last_reconciliation_wake_at: i64,
    unchanged_reconciliation_ticks: u64,
    reconciliation_condition_since_ms: Option<i64>,
    reported_loop_exits: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct LoopDwellKey {
    session_id: String,
    condition: LoopCandidateCondition,
    loop_since: String,
    goal: String,
    loop_source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum LoopCandidateCondition {
    Stopped,
    Dead,
    Completed,
    Blocked,
}

impl LoopCandidateCondition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Dead => "dead",
            Self::Completed => "completed",
            Self::Blocked => "blocked",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "dead" => Self::Dead,
            "completed" => Self::Completed,
            "blocked" => Self::Blocked,
            _ => Self::Stopped,
        }
    }
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
        self.gc_stale_pauses(input);
        let loop_exit_summary = self.plan_loop_exit_summary(overseer_id.as_deref(), input);
        let mut raw_candidates = find_loop_candidates_with_overseer(input, overseer_id.as_deref());
        let paused_candidates = self.extract_paused_candidates(&mut raw_candidates);
        let paused_summary =
            self.plan_paused_summary(&paused_candidates, overseer_id.as_deref(), input);
        let reconciliation =
            self.plan_reconciliation(overseer_id.as_deref(), &paused_candidates, input, now_ms);
        let candidates = self.dwelled_candidates(
            raw_candidates,
            now_ms,
            config_i64(input, "stoppedDwellMs", 0),
            config_i64(input, "nudgeCooldownMs", 60_000),
            config_u64(input, "unchangedReminderTicks"),
        );
        if let Some(send) = loop_exit_summary {
            sends.push(send);
        }
        if candidates.is_empty() {
            if let Some(send) = paused_summary {
                sends.push(send);
            }
            if let Some(send) = reconciliation {
                sends.push(send);
            }
            return sends;
        }

        let cooldown = config_i64(input, "nudgeCooldownMs", 60_000);
        let overseer_running = overseer_id
            .as_deref()
            .is_some_and(|id| session_can_receive_loop_send(input, id));

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
            if let Some(send) = paused_summary {
                sends.push(send);
            }
            if let Some(send) = reconciliation {
                sends.push(send);
            }
            return sends;
        }

        if !input
            .get("config")
            .and_then(|config| config.get("autoNudgeWithoutOverseer"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            if let Some(send) = reconciliation {
                sends.push(send);
            }
            return sends;
        }

        for candidate in candidates {
            if candidate_condition(&candidate.value) != LoopCandidateCondition::Stopped {
                continue;
            }
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
        if let Some(send) = paused_summary {
            sends.push(send);
        }
        if let Some(send) = reconciliation {
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
            LoopSendKind::OverseerBriefing | LoopSendKind::LoopExit => {
                self.last_overseer_wake_at = now_ms;
            }
            LoopSendKind::DirectNudge => {
                self.last_nudge_at.insert(send.session_id.clone(), now_ms);
            }
            LoopSendKind::PausedSummary => {}
            LoopSendKind::Reconciliation => {
                self.last_reconciliation_wake_at = now_ms;
                self.last_reconciliation_attempted_signature = Some(send.signature.clone());
                if matches!(outcome, LoopDeliveryOutcome::Delivered) {
                    self.last_reconciliation_reported_signature = Some(send.signature.clone());
                }
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
        } else if let Some(keys) =
            self.buffered_sends
                .get(&buffered_send_key(send))
                .map(|buffered| {
                    buffered
                        .candidate_keys
                        .iter()
                        .map(BufferedLoopCandidateKey::to_dwell_key)
                        .collect::<Vec<_>>()
                })
        {
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

    pub fn pause_loop_alerts(
        &mut self,
        session_id: &str,
        loop_key: String,
        paused_at_ms: i64,
        provenance: LoopAlertPauseProvenance,
    ) -> LoopAlertPause {
        let pause = LoopAlertPause {
            paused_at_ms,
            loop_key,
            paused_by: provenance.paused_by,
            paused_by_session_id: provenance.paused_by_session_id,
            paused_by_role: provenance.paused_by_role,
            reason: provenance.reason,
        };
        self.paused_loop_alerts
            .insert(session_id.to_owned(), pause.clone());
        pause
    }

    pub fn unpause_loop_alerts(&mut self, session_id: &str) -> Option<LoopAlertPause> {
        self.paused_loop_alerts.remove(session_id)
    }

    pub fn paused_loop_alert(&self, session_id: &str) -> Option<&LoopAlertPause> {
        self.paused_loop_alerts.get(session_id)
    }

    pub fn set_global_pause(
        &mut self,
        now_ms: i64,
        expires_at_ms: i64,
        provenance: LoopAlertPauseProvenance,
    ) -> LoopGlobalPause {
        let pause = LoopGlobalPause {
            paused_at_ms: now_ms,
            expires_at_ms: expires_at_ms.max(now_ms.saturating_add(1)),
            paused_by: provenance.paused_by,
            paused_by_session_id: provenance.paused_by_session_id,
            paused_by_role: provenance.paused_by_role,
            reason: provenance.reason,
        };
        self.global_pause = Some(pause.clone());
        self.global_pause_reminder_ticks = 0;
        pause
    }

    pub fn clear_global_pause(&mut self) -> Option<LoopGlobalPause> {
        self.global_pause_reminder_ticks = 0;
        self.global_pause.take()
    }

    pub fn expire_global_pause(&mut self, now_ms: i64) -> Option<LoopGlobalPause> {
        if self
            .global_pause
            .as_ref()
            .is_some_and(|pause| pause.expires_at_ms <= now_ms)
        {
            return self.clear_global_pause();
        }
        None
    }

    pub fn is_global_pause_active(&self, now_ms: i64) -> bool {
        self.global_pause
            .as_ref()
            .is_some_and(|pause| pause.expires_at_ms > now_ms)
    }

    pub fn buffer_send(&mut self, send: &LoopSend, now_ms: i64) {
        let key = buffered_send_key(send);
        let candidate_keys = self
            .pending_send_keys
            .remove(&send.signature)
            .unwrap_or_default();
        for key in &candidate_keys {
            if let Some(state) = self.stopped_since.get_mut(key) {
                state.last_attempted_ms = Some(now_ms);
                state.unchanged_candidate_ticks = 0;
            }
        }
        let entry = self
            .buffered_sends
            .entry(key)
            .or_insert_with(|| BufferedLoopSend {
                first_buffered_at_ms: now_ms,
                last_seen_at_ms: now_ms,
                seen_count: 0,
                session_id: send.session_id.clone(),
                text: send.text.clone(),
                signature: send.signature.clone(),
                kind: loop_send_kind_name(send.kind).to_owned(),
                candidate_keys: Vec::new(),
            });
        entry.last_seen_at_ms = now_ms;
        entry.seen_count = entry.seen_count.saturating_add(1);
        entry.session_id = send.session_id.clone();
        entry.text = send.text.clone();
        entry.signature = send.signature.clone();
        entry.kind = loop_send_kind_name(send.kind).to_owned();
        entry.candidate_keys = candidate_keys
            .iter()
            .map(BufferedLoopCandidateKey::from_dwell_key)
            .collect();
    }

    pub fn buffered_sends_to_deliver(&self, limit: usize) -> Vec<LoopSend> {
        self.buffered_sends
            .values()
            .take(limit)
            .filter_map(buffered_send_to_loop_send)
            .collect()
    }

    pub fn remove_buffered_send(&mut self, send: &LoopSend) {
        self.buffered_sends.remove(&buffered_send_key(send));
    }

    pub fn buffered_send_count(&self) -> usize {
        self.buffered_sends.len()
    }

    pub fn note_global_pause_tick(&mut self) {
        if self.global_pause.is_some() {
            self.global_pause_reminder_ticks = self.global_pause_reminder_ticks.saturating_add(1);
        }
    }

    pub fn loop_alert_state(&self, now_ms: i64) -> Value {
        let global_pause = self.global_pause.as_ref().map(|pause| {
            json!({
                "enabled": pause.expires_at_ms > now_ms,
                "pausedAtMs": pause.paused_at_ms,
                "expiresAtMs": pause.expires_at_ms,
                "remainingMs": pause.expires_at_ms.saturating_sub(now_ms),
                "bufferedCount": self.buffered_sends.len(),
                "pausedBy": pause.paused_by,
                "pausedBySessionId": pause.paused_by_session_id,
                "pausedByRole": pause.paused_by_role,
                "reason": pause.reason,
                "reminderTicks": self.global_pause_reminder_ticks
            })
        });
        json!({
            "ok": true,
            "globalPause": global_pause.unwrap_or_else(|| json!({
                "enabled": false,
                "bufferedCount": self.buffered_sends.len()
            })),
            "pausedCount": self.paused_loop_alerts.len(),
            "bufferedCount": self.buffered_sends.len()
        })
    }

    fn record_delivery(&mut self, send: &LoopSend, now_ms: i64, outcome: LoopDeliveryOutcome) {
        let (outcome, error) = match outcome {
            LoopDeliveryOutcome::Delivered => ("delivered".to_owned(), None),
            LoopDeliveryOutcome::Buffered => ("buffered".to_owned(), None),
            LoopDeliveryOutcome::Failed { error } => ("failed".to_owned(), Some(error)),
        };
        self.delivery_records.push(LoopDeliveryRecord {
            at_ms: now_ms,
            session_id: send.session_id.clone(),
            signature: send.signature.clone(),
            kind: loop_send_kind_name(send.kind).to_owned(),
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

    fn extract_paused_candidates(&self, candidates: &mut Vec<Value>) -> Vec<Value> {
        let mut paused = Vec::new();
        candidates.retain(|candidate| {
            let id = str_field(candidate, "id");
            let is_paused = loop_pause_key(candidate)
                .as_deref()
                .and_then(|key| {
                    self.paused_loop_alerts
                        .get(id)
                        .map(|pause| pause.loop_key == key)
                })
                .unwrap_or(false);
            if is_paused {
                paused.push(candidate.clone());
                false
            } else {
                true
            }
        });
        paused
    }

    fn gc_stale_pauses(&mut self, input: &Value) {
        if self.paused_loop_alerts.is_empty() {
            return;
        }
        let current = active_loop_pause_keys(input);
        self.paused_loop_alerts
            .retain(|session_id, pause| current.get(session_id) == Some(&pause.loop_key));
    }

    fn plan_paused_summary(
        &mut self,
        paused_candidates: &[Value],
        overseer_id: Option<&str>,
        input: &Value,
    ) -> Option<LoopSend> {
        if paused_candidates.is_empty() {
            self.paused_summary_ticks = 0;
            self.last_paused_summary_signature = None;
            return None;
        }
        let overseer_id = overseer_id.filter(|id| session_can_receive_loop_send(input, id))?;
        self.paused_summary_ticks = self.paused_summary_ticks.saturating_add(1);
        let signature = format!("paused:{}", candidate_signature(paused_candidates));
        let due_by_cadence = self.paused_summary_ticks >= PAUSED_SUMMARY_TICK_CADENCE;
        let due_by_change = self.last_paused_summary_signature.as_deref() != Some(&signature)
            && self.last_paused_summary_signature.is_some();
        if !due_by_cadence && !due_by_change {
            return None;
        }
        self.paused_summary_ticks = 0;
        self.last_paused_summary_signature = Some(signature.clone());
        Some(LoopSend {
            session_id: overseer_id.to_owned(),
            text: build_paused_summary(paused_candidates),
            signature,
            kind: LoopSendKind::PausedSummary,
        })
    }

    fn plan_reconciliation(
        &mut self,
        overseer_id: Option<&str>,
        paused_candidates: &[Value],
        input: &Value,
        now_ms: i64,
    ) -> Option<LoopSend> {
        let overseer_id = overseer_id.filter(|id| session_can_receive_loop_send(input, id))?;
        let available = find_idle_loop_capacity(input, Some(overseer_id), paused_candidates);
        let work = find_visible_unowned_work(input);
        if available.is_empty() || work.is_empty() {
            self.last_reconciliation_signature = None;
            self.last_reconciliation_attempted_signature = None;
            self.last_reconciliation_reported_signature = None;
            self.unchanged_reconciliation_ticks = 0;
            self.reconciliation_condition_since_ms = None;
            return None;
        }

        let condition_since = *self.reconciliation_condition_since_ms.get_or_insert(now_ms);
        let dwell_ms = config_i64(input, "reconciliationDwellMs", 30_000).max(0);
        if now_ms.saturating_sub(condition_since) < dwell_ms {
            return None;
        }

        let signature = reconciliation_signature(&work, &available);
        if self.last_reconciliation_signature.as_deref() == Some(signature.as_str()) {
            self.unchanged_reconciliation_ticks =
                self.unchanged_reconciliation_ticks.saturating_add(1);
        } else {
            self.last_reconciliation_signature = Some(signature.clone());
            self.unchanged_reconciliation_ticks = 0;
        }

        let already_reported =
            self.last_reconciliation_reported_signature.as_deref() == Some(signature.as_str());
        let already_attempted =
            self.last_reconciliation_attempted_signature.as_deref() == Some(signature.as_str());
        let reminder_due = reconciliation_reminder_due(
            input,
            self.unchanged_reconciliation_ticks,
            now_ms.saturating_sub(self.last_reconciliation_wake_at),
        );
        if (already_reported || already_attempted) && !reminder_due {
            return None;
        }

        Some(LoopSend {
            session_id: overseer_id.to_owned(),
            text: build_reconciliation_briefing(&work, &available),
            signature,
            kind: LoopSendKind::Reconciliation,
        })
    }

    fn plan_loop_exit_summary(
        &mut self,
        overseer_id: Option<&str>,
        input: &Value,
    ) -> Option<LoopSend> {
        let overseer_id = overseer_id.filter(|id| session_can_receive_loop_send(input, id))?;
        let candidates = find_loop_exit_candidates_with_overseer(input, Some(overseer_id));
        let unreported = candidates
            .into_iter()
            .filter(|candidate| {
                self.reported_loop_exits
                    .insert(loop_exit_candidate_signature(candidate))
            })
            .collect::<Vec<_>>();
        if unreported.is_empty() {
            return None;
        }
        let signature = format!("loop-exit:{}", candidate_signature(&unreported));
        Some(LoopSend {
            session_id: overseer_id.to_owned(),
            text: build_loop_exit_briefing(&unreported),
            signature,
            kind: LoopSendKind::LoopExit,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoopAlertPauseProvenance {
    pub paused_by: Option<String>,
    pub paused_by_session_id: Option<String>,
    pub paused_by_role: Option<String>,
    pub reason: Option<String>,
}

const PAUSED_SUMMARY_TICK_CADENCE: u64 = 10;

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

pub fn loop_alert_state_summary(project_state_dir: impl AsRef<Path>, now_ms: i64) -> Value {
    let path = loop_watcher_state_path(project_state_dir);
    match load_loop_watcher_state(&path) {
        Ok(watcher) => watcher.loop_alert_state(now_ms),
        Err(error) => json!({
            "ok": false,
            "error": error,
            "globalPause": { "enabled": false, "bufferedCount": 0 },
            "pausedCount": 0,
            "bufferedCount": 0
        }),
    }
}

pub fn clear_loop_alert_pause_for_work(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
) -> Result<Option<LoopAlertPause>, String> {
    let state_path = loop_watcher_state_path(project_state_dir);
    let mut watcher = load_loop_watcher_state(&state_path)?;
    let cleared = watcher.unpause_loop_alerts(session_id);
    if cleared.is_some() {
        save_loop_watcher_state(&state_path, &watcher)?;
    }
    Ok(cleared)
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
    #[serde(default)]
    paused_loop_alerts: BTreeMap<String, LoopAlertPause>,
    #[serde(default)]
    paused_summary_ticks: u64,
    #[serde(default)]
    last_paused_summary_signature: Option<String>,
    #[serde(default)]
    global_pause: Option<LoopGlobalPause>,
    #[serde(default)]
    buffered_sends: BTreeMap<String, BufferedLoopSend>,
    #[serde(default)]
    global_pause_reminder_ticks: u64,
    #[serde(default)]
    last_reconciliation_signature: Option<String>,
    #[serde(default)]
    last_reconciliation_attempted_signature: Option<String>,
    #[serde(default)]
    last_reconciliation_reported_signature: Option<String>,
    #[serde(default)]
    last_reconciliation_wake_at: i64,
    #[serde(default)]
    unchanged_reconciliation_ticks: u64,
    #[serde(default)]
    reconciliation_condition_since_ms: Option<i64>,
    #[serde(default)]
    reported_loop_exits: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistentStoppedSince {
    session_id: String,
    #[serde(default = "default_stopped_condition")]
    condition: String,
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
                    condition: key.condition.as_str().to_owned(),
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
            paused_loop_alerts: watcher.paused_loop_alerts.clone(),
            paused_summary_ticks: watcher.paused_summary_ticks,
            last_paused_summary_signature: watcher.last_paused_summary_signature.clone(),
            global_pause: watcher.global_pause.clone(),
            buffered_sends: watcher.buffered_sends.clone(),
            global_pause_reminder_ticks: watcher.global_pause_reminder_ticks,
            last_reconciliation_signature: watcher.last_reconciliation_signature.clone(),
            last_reconciliation_attempted_signature: watcher
                .last_reconciliation_attempted_signature
                .clone(),
            last_reconciliation_reported_signature: watcher
                .last_reconciliation_reported_signature
                .clone(),
            last_reconciliation_wake_at: watcher.last_reconciliation_wake_at,
            unchanged_reconciliation_ticks: watcher.unchanged_reconciliation_ticks,
            reconciliation_condition_since_ms: watcher.reconciliation_condition_since_ms,
            reported_loop_exits: watcher.reported_loop_exits.iter().cloned().collect(),
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
                            condition: LoopCandidateCondition::from_str(&record.condition),
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
            paused_loop_alerts: self.paused_loop_alerts,
            paused_summary_ticks: self.paused_summary_ticks,
            last_paused_summary_signature: self.last_paused_summary_signature,
            global_pause: self.global_pause,
            buffered_sends: self.buffered_sends,
            global_pause_reminder_ticks: self.global_pause_reminder_ticks,
            last_reconciliation_signature: self.last_reconciliation_signature,
            last_reconciliation_attempted_signature: self.last_reconciliation_attempted_signature,
            last_reconciliation_reported_signature: self.last_reconciliation_reported_signature,
            last_reconciliation_wake_at: self.last_reconciliation_wake_at,
            unchanged_reconciliation_ticks: self.unchanged_reconciliation_ticks,
            reconciliation_condition_since_ms: self.reconciliation_condition_since_ms,
            reported_loop_exits: self.reported_loop_exits.into_iter().collect(),
        })
    }
}

fn buffered_send_key(send: &LoopSend) -> String {
    format!("{}:{}", loop_send_kind_name(send.kind), send.signature)
}

fn buffered_send_to_loop_send(buffered: &BufferedLoopSend) -> Option<LoopSend> {
    Some(LoopSend {
        session_id: buffered.session_id.clone(),
        text: buffered.text.clone(),
        signature: buffered.signature.clone(),
        kind: loop_send_kind_from_name(&buffered.kind)?,
    })
}

impl BufferedLoopCandidateKey {
    fn from_dwell_key(key: &LoopDwellKey) -> Self {
        Self {
            session_id: key.session_id.clone(),
            condition: key.condition.as_str().to_owned(),
            loop_since: key.loop_since.clone(),
            goal: key.goal.clone(),
            loop_source: key.loop_source.clone(),
        }
    }

    fn to_dwell_key(&self) -> LoopDwellKey {
        LoopDwellKey {
            session_id: self.session_id.clone(),
            condition: LoopCandidateCondition::from_str(&self.condition),
            loop_since: self.loop_since.clone(),
            goal: self.goal.clone(),
            loop_source: self.loop_source.clone(),
        }
    }
}

fn default_stopped_condition() -> String {
    LoopCandidateCondition::Stopped.as_str().to_owned()
}

fn loop_send_kind_name(kind: LoopSendKind) -> &'static str {
    match kind {
        LoopSendKind::OverseerBriefing => "overseerBriefing",
        LoopSendKind::DirectNudge => "directNudge",
        LoopSendKind::PausedSummary => "pausedSummary",
        LoopSendKind::Reconciliation => "reconciliation",
        LoopSendKind::LoopExit => "loopExit",
    }
}

fn loop_send_kind_from_name(value: &str) -> Option<LoopSendKind> {
    match value {
        "overseerBriefing" => Some(LoopSendKind::OverseerBriefing),
        "directNudge" => Some(LoopSendKind::DirectNudge),
        "pausedSummary" => Some(LoopSendKind::PausedSummary),
        "reconciliation" => Some(LoopSendKind::Reconciliation),
        "loopExit" => Some(LoopSendKind::LoopExit),
        _ => None,
    }
}

pub fn loop_pause_key_from_loop_metadata(loop_meta: &Value) -> Option<String> {
    let loop_meta = loop_meta.as_object()?;
    if !loop_meta
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let since = optional_str_value(loop_meta.get("since"));
    let goal = optional_str_value(loop_meta.get("goal"));
    let source = optional_str_value(loop_meta.get("source"));
    Some(format!("{since}\n{goal}\n{source}"))
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
            let condition = loop_candidate_condition(session, activity)?;
            if condition == LoopCandidateCondition::Stopped {
                let attention = meta
                    .get("derived")
                    .and_then(|derived| derived.get("attention"))
                    .and_then(Value::as_str)
                    .unwrap_or("normal");
                if attention != "normal" {
                    return None;
                }
            }

            let mut candidate = Map::new();
            insert_str(&mut candidate, "id", Some(id));
            if condition == LoopCandidateCondition::Dead {
                insert_str(&mut candidate, "condition", Some(condition.as_str()));
                insert_value(&mut candidate, "status", session.get("status"));
                insert_str(&mut candidate, "activity", activity);
            }
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

pub fn find_loop_exit_candidates_with_overseer(
    input: &Value,
    overseer_id: Option<&str>,
) -> Vec<Value> {
    let metadata = input.get("metadata").unwrap_or(&Value::Null);
    let metadata_sessions = match metadata.get("sessions").and_then(Value::as_object) {
        Some(sessions) => sessions,
        None => empty_object(),
    };
    array_field(input, "sessions")
        .iter()
        .filter_map(|session| {
            let id = str_field(session, "id");
            if overseer_id == Some(id) || !is_known_loop_exit_session_status(session) {
                return None;
            }
            let meta = metadata_sessions.get(id)?;
            if meta
                .get("loop")
                .and_then(Value::as_object)
                .and_then(|loop_meta| loop_meta.get("active"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return None;
            }
            let action = meta.get("loopLastAction")?;
            let action_name = str_field(action, "action");
            let condition = loop_exit_action_condition(action_name)?;
            if optional_str(action, "source") != Some("agent") {
                return None;
            }

            let mut candidate = Map::new();
            insert_str(&mut candidate, "id", Some(id));
            insert_str(&mut candidate, "condition", Some(condition.as_str()));
            insert_value(&mut candidate, "status", session.get("status"));
            insert_value(&mut candidate, "goal", action.get("goal"));
            insert_value(&mut candidate, "worktreePath", session.get("worktreePath"));
            insert_value(&mut candidate, "tool", session.get("tool"));
            insert_value(&mut candidate, "loopSource", action.get("source"));
            insert_value(&mut candidate, "loopUpdatedBy", action.get("updatedBy"));
            insert_value(
                &mut candidate,
                "loopUpdatedBySessionId",
                action.get("updatedBySessionId"),
            );
            insert_value(
                &mut candidate,
                "loopUpdatedByRole",
                action.get("updatedByRole"),
            );
            insert_value(&mut candidate, "loopActionAt", action.get("at"));
            insert_value(&mut candidate, "loopLastAction", Some(action));
            Some(Value::Object(candidate))
        })
        .collect()
}

fn is_known_loop_exit_session_status(session: &Value) -> bool {
    optional_str(session, "status")
        .map(|status| matches!(status, "starting" | "running" | "idle" | "offline"))
        .unwrap_or(false)
}

fn loop_exit_action_condition(action: &str) -> Option<LoopCandidateCondition> {
    match action {
        "done" => Some(LoopCandidateCondition::Completed),
        "block" => Some(LoopCandidateCondition::Blocked),
        _ => None,
    }
}

fn loop_candidate_condition(
    session: &Value,
    activity: Option<&str>,
) -> Option<LoopCandidateCondition> {
    match optional_str(session, "status") {
        Some("offline") => Some(LoopCandidateCondition::Dead),
        Some("starting" | "running" | "idle") | None => {
            matches!(activity, Some("idle" | "done")).then_some(LoopCandidateCondition::Stopped)
        }
        Some(_) => None,
    }
}

fn active_loop_pause_keys(input: &Value) -> BTreeMap<String, String> {
    let metadata = input.get("metadata").unwrap_or(&Value::Null);
    let metadata_sessions = match metadata.get("sessions").and_then(Value::as_object) {
        Some(sessions) => sessions,
        None => empty_object(),
    };
    array_field(input, "sessions")
        .iter()
        .filter_map(|session| {
            let id = str_field(session, "id");
            let loop_meta = metadata_sessions.get(id)?.get("loop")?;
            loop_pause_key_from_loop_metadata(loop_meta).map(|key| (id.to_owned(), key))
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

    let has_dead_candidate = candidates
        .iter()
        .any(|candidate| candidate_condition(candidate) == LoopCandidateCondition::Dead);
    let mut lines = Vec::from([String::from(if has_dead_candidate {
        "[aimux loop check] These agents are in a managed loop but appear to have stopped or died:"
    } else {
        "[aimux loop check] These agents are in a managed loop but appear to have stopped:"
    })]);
    lines.extend(candidates.iter().map(describe_candidate));
    lines.push(String::new());
    lines.push(String::from(
        "Current loop membership is authoritative. If a listed agent was previously removed, the shown loop-since/source is newer state; do not remove it merely because you remember an older removal.",
    ));
    if has_dead_candidate {
        lines.extend([
            String::from(
                "For each stopped agent: read recent output with `aimux host agent-read <id>`, then decide whether it needs a next instruction.",
            ),
            String::from(
                "For each dead/offline agent: restart it if the loop should continue, or remove it from the loop if the work is no longer recoverable.",
            ),
        ]);
    } else {
        lines.push(String::from(
            "For each: read its recent output with `aimux host agent-read <id>`, then decide whether it stopped prematurely.",
        ));
    }
    lines.extend([
        String::from(
            "If it should keep going, send a specific next instruction with `aimux input <id> \"…\"`.",
        ),
        String::from(
            "If it genuinely finished its goal or is blocked beyond repair, run `aimux loop remove <id>` and report back.",
        ),
    ]);
    lines.join("\n")
}

fn build_loop_exit_briefing(candidates: &[Value]) -> String {
    let mut lines = Vec::from([String::from(
        "[aimux loop check] These agents self-reported a loop exit and left the managed loop:",
    )]);
    lines.extend(candidates.iter().map(describe_candidate));
    lines.push(String::new());
    lines.push(String::from(
        "This is based on `loopLastAction` from `aimux loop done` or `aimux loop block`, not inferred from missing loop membership.",
    ));
    lines.push(String::from(
        "For each completed agent: acknowledge the result, inspect what landed if needed, and reassign or remove the freed loop capacity.",
    ));
    lines.push(String::from(
        "For each blocked agent: read its reason/output, decide whether to unblock it or reassign the goal, and keep the loop list intentional.",
    ));
    lines.join("\n")
}

fn build_paused_summary(candidates: &[Value]) -> String {
    let mut lines = Vec::from([String::from(
        "[aimux loop check] These agents have loop alerts paused; remove them from the loop if you are fully done:",
    )]);
    lines.extend(candidates.iter().map(describe_candidate));
    lines.join("\n")
}

fn build_reconciliation_briefing(work: &[Value], available: &[Value]) -> String {
    let mut lines = Vec::from([String::from(
        "[aimux loop check] Runtime-exchange/worklist work visible to the project service is waiting while loop capacity is idle.",
    )]);
    lines.push(String::from(
        "This does not include external queue files such as Sam's gqaapg queue unless they are imported into runtime exchange.",
    ));
    lines.push(String::new());
    lines.push(String::from("Visible unowned work:"));
    lines.extend(work.iter().take(8).map(describe_reconciliation_work));
    if work.len() > 8 {
        lines.push(format!("- ... and {} more", work.len() - 8));
    }
    lines.push(String::new());
    lines.push(String::from("Available watched loop capacity:"));
    lines.extend(
        available
            .iter()
            .take(8)
            .map(describe_reconciliation_capacity),
    );
    if available.len() > 8 {
        lines.push(format!("- ... and {} more", available.len() - 8));
    }
    lines.push(String::new());
    lines.push(String::from(
        "Assign or pause agents intentionally. If these runtime-exchange/worklist items are no longer real, close or update them so the worklist matches the work.",
    ));
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

fn find_idle_loop_capacity(
    input: &Value,
    overseer_id: Option<&str>,
    paused_candidates: &[Value],
) -> Vec<Value> {
    let paused_ids = paused_candidates
        .iter()
        .map(|candidate| str_field(candidate, "id").to_owned())
        .collect::<BTreeSet<_>>();
    find_loop_candidates_with_overseer(input, overseer_id)
        .into_iter()
        .filter(|candidate| !paused_ids.contains(str_field(candidate, "id")))
        .filter(|candidate| candidate_condition(candidate) == LoopCandidateCondition::Stopped)
        .collect()
}

fn find_visible_unowned_work(input: &Value) -> Vec<Value> {
    let live_sessions = array_field(input, "sessions")
        .iter()
        .filter_map(|session| optional_str(session, "id").map(str::to_owned))
        .collect::<BTreeSet<_>>();
    let mut work = Vec::new();
    let exchange = input.get("runtimeExchange").unwrap_or(&Value::Null);
    for task in array_field(exchange, "tasks") {
        if let Some(item) = unowned_task_item(task, &live_sessions) {
            work.push(item);
        }
    }
    for item in coordination_worklist_needs_you(input) {
        if let Some(item) = unowned_worklist_item(&item) {
            work.push(item);
        }
    }
    work.sort_by(|left, right| {
        str_field(left, "sortKey")
            .cmp(str_field(right, "sortKey"))
            .then_with(|| str_field(left, "id").cmp(str_field(right, "id")))
    });
    work.dedup_by(|left, right| str_field(left, "dedupeKey") == str_field(right, "dedupeKey"));
    work
}

fn coordination_worklist_needs_you(input: &Value) -> Vec<Value> {
    let Some(worklist) = input.get("coordinationWorklist") else {
        return vec![coordination_worklist_contract_break(
            "coordinationWorklist missing from loop watcher input",
        )];
    };
    if let Some(needs_you) = worklist.get("needsYou").and_then(Value::as_array) {
        return needs_you.clone();
    }
    match worklist.as_array() {
        Some(items) => items.clone(),
        None => {
            let reason = optional_str(worklist, "error")
                .unwrap_or("coordinationWorklist object missing needsYou");
            vec![coordination_worklist_contract_break(reason)]
        }
    }
}

fn coordination_worklist_contract_break(reason: &str) -> Value {
    json!({
        "key": "coordination-worklist-contract",
        "kind": "worklist-contract",
        "bucket": "error",
        "title": reason,
        "actionable": true
    })
}

fn unowned_task_item(task: &Value, live_sessions: &BTreeSet<String>) -> Option<Value> {
    if str_field(task, "status") != "pending" {
        return None;
    }
    let assigned_to = optional_str(task, "assignedTo");
    let owner_state = match assigned_to {
        None => "unassigned",
        Some(owner) if !live_sessions.contains(owner) => "assigned-owner-unreachable",
        Some(_) => return None,
    };
    let id = optional_str(task, "id")?;
    Some(json!({
        "id": id,
        "kind": "task",
        "dedupeKey": format!("task:{id}"),
        "sortKey": format!("task:{id}"),
        "status": str_field(task, "status"),
        "ownerState": owner_state,
        "assignedTo": assigned_to,
        "title": optional_str(task, "description").unwrap_or("task")
    }))
}

fn unowned_worklist_item(item: &Value) -> Option<Value> {
    if !item
        .get("actionable")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    if optional_str(item, "sessionId").is_some() {
        return None;
    }
    let key = optional_str(item, "key")?;
    let kind = optional_str(item, "kind").unwrap_or("worklist");
    Some(json!({
        "id": key,
        "kind": kind,
        "dedupeKey": format!("worklist:{key}"),
        "sortKey": format!("worklist:{key}"),
        "status": optional_str(item, "bucket").unwrap_or("actionable"),
        "ownerState": "unassigned-worklist",
        "title": optional_str(item, "title").unwrap_or("worklist item")
    }))
}

fn reconciliation_signature(work: &[Value], available: &[Value]) -> String {
    format!(
        "reconciliation:condition:unowned-work-present:{}:idle-capacity-present:{}",
        !work.is_empty(),
        !available.is_empty()
    )
}

fn reconciliation_reminder_due(
    input: &Value,
    unchanged_ticks: u64,
    elapsed_since_last_wake_ms: i64,
) -> bool {
    let ticks = input
        .get("config")
        .and_then(|config| config.get("reconciliationReminderTicks"))
        .and_then(Value::as_u64)
        .unwrap_or(6)
        .max(1);
    let cooldown = config_i64(input, "reconciliationCooldownMs", 15 * 60 * 1000).max(0);
    unchanged_ticks > 0
        && unchanged_ticks.is_multiple_of(ticks)
        && elapsed_since_last_wake_ms >= cooldown
}

fn describe_reconciliation_work(item: &Value) -> String {
    let title = optional_str(item, "title").unwrap_or("");
    let title = if title.is_empty() {
        String::new()
    } else {
        format!(" — {title}")
    };
    format!(
        "- {} {} ({}){}",
        str_field(item, "kind"),
        str_field(item, "id"),
        str_field(item, "ownerState"),
        title
    )
}

fn describe_reconciliation_capacity(candidate: &Value) -> String {
    let goal = optional_str(candidate, "goal")
        .map(|goal| format!(" — goal: {goal}"))
        .unwrap_or_default();
    format!("- {}{}", str_field(candidate, "id"), goal)
}

pub fn describe_candidate(candidate: &Value) -> String {
    let id = str_field(candidate, "id");
    let condition = match candidate_condition(candidate) {
        LoopCandidateCondition::Dead => " [dead/offline]",
        LoopCandidateCondition::Completed => " [completed/self-reported]",
        LoopCandidateCondition::Blocked => " [blocked/self-reported]",
        LoopCandidateCondition::Stopped => "",
    };
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
        optional_str(candidate, "loopActionAt")
            .map(|at| format!(" — loop action at {at}"))
            .unwrap_or_else(|| format!(" — loop since {}", str_field(candidate, "loopSince")))
    } else {
        optional_str(candidate, "loopActionAt")
            .map(|at| format!(" — loop action at {at} by {actor}"))
            .unwrap_or_else(|| {
                format!(
                    " — loop since {} by {actor}",
                    str_field(candidate, "loopSince")
                )
            })
    };
    let last_action = candidate
        .get("loopLastAction")
        .filter(|action| str_field(action, "action") != "add")
        .map(|action| {
            format!(
                " — self-reported {} at {}",
                str_field(action, "action"),
                str_field(action, "at")
            )
        })
        .unwrap_or_default();

    format!("- {id}{condition}{tool}{where_text}{provenance}{last_action}{goal}")
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

fn session_can_receive_loop_send(input: &Value, id: &str) -> bool {
    array_field(input, "sessions").iter().any(|session| {
        str_field(session, "id") == id
            && optional_str(session, "status")
                .map(|status| matches!(status, "starting" | "running" | "idle"))
                .unwrap_or(true)
    })
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
                str_field(candidate, "condition"),
                str_field(candidate, "loopSince"),
                str_field(candidate, "loopActionAt"),
                optional_str(candidate, "goal").unwrap_or_default(),
                optional_str(candidate, "loopSource").unwrap_or_default(),
            ]
            .join("\u{1f}")
        })
        .collect::<Vec<_>>();
    ids.sort();
    ids.join("\u{1e}")
}

fn loop_exit_candidate_signature(candidate: &Value) -> String {
    format!(
        "loop-exit:{}",
        candidate_signature(std::slice::from_ref(candidate))
    )
}

fn loop_pause_key(candidate: &Value) -> Option<String> {
    let since = optional_str(candidate, "loopSince").unwrap_or_default();
    if since.is_empty() {
        return None;
    }
    let goal = optional_str(candidate, "goal").unwrap_or_default();
    let source = optional_str(candidate, "loopSource").unwrap_or_default();
    Some(format!("{since}\n{goal}\n{source}"))
}

fn dwell_key(candidate: &Value) -> Option<LoopDwellKey> {
    optional_str(candidate, "id").map(|session_id| LoopDwellKey {
        session_id: session_id.to_owned(),
        condition: candidate_condition(candidate),
        loop_since: str_field(candidate, "loopSince").to_owned(),
        goal: optional_str(candidate, "goal")
            .unwrap_or_default()
            .to_owned(),
        loop_source: optional_str(candidate, "loopSource")
            .unwrap_or_default()
            .to_owned(),
    })
}

fn candidate_condition(candidate: &Value) -> LoopCandidateCondition {
    LoopCandidateCondition::from_str(str_field(candidate, "condition"))
}

fn optional_str_value(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_owned()
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
