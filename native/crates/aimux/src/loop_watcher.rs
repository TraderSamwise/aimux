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
}

/// Cross-scan state: who was nudged when, and when the overseer was last woken.
#[derive(Debug, Default)]
pub struct LoopWatcher {
    last_nudge_at: BTreeMap<String, i64>,
    last_overseer_wake_at: i64,
    stopped_since: BTreeMap<LoopDwellKey, i64>,
    last_candidate_signature: Option<String>,
    last_overseer_reported_signature: Option<String>,
    last_overseer_attempted_signature: Option<String>,
    unchanged_candidate_ticks: u64,
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
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct LoopDwellKey {
    session_id: String,
    loop_since: String,
    goal: String,
    loop_source: String,
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
        );
        if candidates.is_empty() {
            self.last_candidate_signature = None;
            self.last_overseer_reported_signature = None;
            self.last_overseer_attempted_signature = None;
            self.unchanged_candidate_ticks = 0;
            if let Some(send) = paused_summary {
                sends.push(send);
            }
            if let Some(send) = reconciliation {
                sends.push(send);
            }
            return sends;
        }
        let candidate_sig = candidate_signature(&candidates);
        if self.last_candidate_signature.as_deref() == Some(candidate_sig.as_str()) {
            self.unchanged_candidate_ticks = self.unchanged_candidate_ticks.saturating_add(1);
        } else {
            self.last_candidate_signature = Some(candidate_sig.clone());
            self.unchanged_candidate_ticks = 0;
        }

        let cooldown = config_i64(input, "nudgeCooldownMs", 60_000);
        let overseer_running = overseer_id
            .as_deref()
            .is_some_and(|id| session_exists(input, id));

        if let Some(overseer_id) = overseer_id.filter(|_| overseer_running) {
            let already_reported =
                self.last_overseer_reported_signature.as_deref() == Some(candidate_sig.as_str());
            let already_attempted =
                self.last_overseer_attempted_signature.as_deref() == Some(candidate_sig.as_str());
            let reminder_due = overseer_reminder_due(
                input,
                self.unchanged_candidate_ticks,
                now_ms.saturating_sub(self.last_overseer_wake_at),
                cooldown,
            );
            if (already_reported || already_attempted) && !reminder_due {
                if let Some(send) = paused_summary {
                    sends.push(send);
                }
                return sends;
            }
            let send = LoopSend {
                session_id: overseer_id,
                text: build_overseer_briefing(
                    &candidates,
                    config_string(input, "overseerBriefingTemplate"),
                ),
                signature: candidate_sig,
                kind: LoopSendKind::OverseerBriefing,
            };
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
            let id = str_field(&candidate, "id").to_owned();
            if now_ms - self.last_nudge_at.get(&id).copied().unwrap_or(0) < cooldown {
                continue;
            }
            let send = LoopSend {
                session_id: id.clone(),
                text: build_canned_nudge(&candidate),
                signature: candidate_signature(&[candidate]),
                kind: LoopSendKind::DirectNudge,
            };
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
            LoopSendKind::OverseerBriefing => {
                self.last_overseer_wake_at = now_ms;
                self.last_overseer_attempted_signature = Some(send.signature.clone());
                if matches!(outcome, LoopDeliveryOutcome::Delivered) {
                    self.last_overseer_reported_signature = Some(send.signature.clone());
                }
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
            });
        entry.last_seen_at_ms = now_ms;
        entry.seen_count = entry.seen_count.saturating_add(1);
        entry.session_id = send.session_id.clone();
        entry.text = send.text.clone();
        entry.signature = send.signature.clone();
        entry.kind = loop_send_kind_name(send.kind).to_owned();
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
    ) -> Vec<Value> {
        let dwell_ms = dwell_ms.max(0);
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
                let first_seen = self.stopped_since.entry(key).or_insert(now_ms);
                (now_ms.saturating_sub(*first_seen) >= dwell_ms).then_some(candidate)
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
        let overseer_id = overseer_id.filter(|id| session_exists(input, id))?;
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
        let overseer_id = overseer_id.filter(|id| session_exists(input, id))?;
        let available = find_idle_loop_capacity(input, Some(overseer_id), paused_candidates);
        let work = find_visible_unowned_work(input);
        if available.is_empty() || work.is_empty() {
            self.last_reconciliation_signature = None;
            self.last_reconciliation_attempted_signature = None;
            self.last_reconciliation_reported_signature = None;
            self.unchanged_reconciliation_ticks = 0;
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
    last_candidate_signature: Option<String>,
    last_overseer_reported_signature: Option<String>,
    last_overseer_attempted_signature: Option<String>,
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
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistentStoppedSince {
    session_id: String,
    loop_since: String,
    goal: String,
    loop_source: String,
    first_seen_ms: i64,
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
                .map(|(key, first_seen_ms)| PersistentStoppedSince {
                    session_id: key.session_id.clone(),
                    loop_since: key.loop_since.clone(),
                    goal: key.goal.clone(),
                    loop_source: key.loop_source.clone(),
                    first_seen_ms: *first_seen_ms,
                })
                .collect(),
            last_candidate_signature: watcher.last_candidate_signature.clone(),
            last_overseer_reported_signature: watcher.last_overseer_reported_signature.clone(),
            last_overseer_attempted_signature: watcher.last_overseer_attempted_signature.clone(),
            unchanged_candidate_ticks: watcher.unchanged_candidate_ticks,
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
        }
    }

    fn into_watcher(self) -> Result<LoopWatcher, String> {
        if self.version != 1 {
            return Err(format!(
                "unsupported loop watcher state version {}",
                self.version
            ));
        }
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
                        record.first_seen_ms,
                    )
                })
                .collect(),
            last_candidate_signature: self.last_candidate_signature,
            last_overseer_reported_signature: self.last_overseer_reported_signature,
            last_overseer_attempted_signature: self.last_overseer_attempted_signature,
            unchanged_candidate_ticks: self.unchanged_candidate_ticks,
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

fn loop_send_kind_name(kind: LoopSendKind) -> &'static str {
    match kind {
        LoopSendKind::OverseerBriefing => "overseerBriefing",
        LoopSendKind::DirectNudge => "directNudge",
        LoopSendKind::PausedSummary => "pausedSummary",
        LoopSendKind::Reconciliation => "reconciliation",
    }
}

fn loop_send_kind_from_name(value: &str) -> Option<LoopSendKind> {
    match value {
        "overseerBriefing" => Some(LoopSendKind::OverseerBriefing),
        "directNudge" => Some(LoopSendKind::DirectNudge),
        "pausedSummary" => Some(LoopSendKind::PausedSummary),
        "reconciliation" => Some(LoopSendKind::Reconciliation),
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
    for item in array_field(input, "coordinationWorklist") {
        if let Some(item) = unowned_worklist_item(item) {
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
    let mut work_keys = work
        .iter()
        .map(|item| {
            [
                str_field(item, "dedupeKey"),
                str_field(item, "status"),
                str_field(item, "ownerState"),
                optional_str(item, "assignedTo").unwrap_or_default(),
            ]
            .join("\u{1f}")
        })
        .collect::<Vec<_>>();
    work_keys.sort();
    let mut capacity_keys = available
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
    capacity_keys.sort();
    format!(
        "reconciliation:{}\u{1e}{}",
        work_keys.join("\u{1e}"),
        capacity_keys.join("\u{1e}")
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

fn overseer_reminder_due(
    input: &Value,
    unchanged_ticks: u64,
    elapsed_since_last_wake_ms: i64,
    cooldown_ms: i64,
) -> bool {
    if let Some(ticks) = input
        .get("config")
        .and_then(|config| config.get("unchangedReminderTicks"))
        .and_then(Value::as_u64)
    {
        let ticks = ticks.max(1);
        return unchanged_ticks > 0
            && unchanged_ticks.is_multiple_of(ticks)
            && elapsed_since_last_wake_ms >= cooldown_ms;
    }
    elapsed_since_last_wake_ms >= cooldown_ms
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
        loop_since: str_field(candidate, "loopSince").to_owned(),
        goal: optional_str(candidate, "goal")
            .unwrap_or_default()
            .to_owned(),
        loop_source: optional_str(candidate, "loopSource")
            .unwrap_or_default()
            .to_owned(),
    })
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
