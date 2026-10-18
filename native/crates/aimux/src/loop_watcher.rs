//! The managed-loop watcher.
//!
//! An agent in a managed loop that has stopped without waiting on a human is a
//! nudge candidate. With an overseer present the watcher wakes the overseer with
//! a briefing and lets it decide; without one it stays observe-only unless
//! `loop.autoNudgeWithoutOverseer` is set. waiting/error/interrupted states are
//! deliberately excluded — those are genuine pauses we must not steamroll.

use crate::agent_goal::GoalKind;
use crate::atomic_write::write_json_atomic;
use crate::project_service::agents::overseer_session_ids_for_state;
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
    IdleFleet,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_failed_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidate_keys: Vec<BufferedLoopCandidateKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopScanIndeterminate {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopScanRecord {
    pub at_ms: i64,
    pub raw_candidate_count: usize,
    pub planned_send_count: usize,
    pub buffered_send_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub raw_candidate_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub planned_send_kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub indeterminate: Vec<LoopScanIndeterminate>,
    pub global_pause_active: bool,
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
    // The outer watcher owns shared pauses and observable records. Each
    // recipient engine owns its delivery cadence; engines only call the
    // internal planner and never create children.
    recipient_watchers: BTreeMap<String, LoopWatcher>,
    last_delivery_recipient: Option<String>,
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
    last_idle_fleet_signature: Option<String>,
    last_idle_fleet_attempted_signature: Option<String>,
    last_idle_fleet_reported_signature: Option<String>,
    last_idle_fleet_wake_at: i64,
    unchanged_idle_fleet_ticks: u64,
    idle_fleet_condition_since_ms: Option<i64>,
    reported_loop_exits: BTreeSet<String>,
    loop_exit_attempts: BTreeMap<String, i64>,
    pending_loop_exits: BTreeMap<String, Vec<String>>,
    /// Token budgets whose "you have reached it" has already been said, keyed
    /// by session and budget so raising the budget arms it again.
    announced_token_goals: BTreeSet<String>,
    /// Announcements planned but not yet delivered, by send signature. Said
    /// and attempted are different things: recording an announcement before
    /// the send lands loses it for ever if the send fails, and this file
    /// already keeps that distinction for the briefings.
    pending_token_goal_announcements: BTreeMap<String, String>,
    scan_records: Vec<LoopScanRecord>,
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
        let metadata = input.get("metadata").unwrap_or(&Value::Null);
        let overseer_ids = overseer_session_ids_for_state(array_field(input, "sessions"), metadata);
        self.recipient_watchers
            .retain(|id, _| overseer_ids.contains(id));
        self.gc_stale_pauses(input);
        let recipients = overseer_ids
            .iter()
            .filter(|id| session_can_receive_loop_send(input, id))
            .collect::<Vec<_>>();
        if recipients.is_empty() {
            return self.plan_sends_for_recipient(input, now_ms, None);
        }
        let mut sends = self.plan_session_token_announcements(input, now_ms);
        for id in recipients {
            let watcher = self.recipient_watchers.entry(id.clone()).or_default();
            watcher.paused_loop_alerts = self.paused_loop_alerts.clone();
            sends.extend(watcher.plan_sends_for_recipient(input, now_ms, Some(id.clone())));
        }
        sends
    }

    fn plan_session_token_announcements(&mut self, input: &Value, now_ms: i64) -> Vec<LoopSend> {
        // Budget ownership follows the session and goal, never its current
        // role. Promotion/demotion can replace a recipient engine without
        // discarding a delivered or buffered budget announcement.
        let mut candidates = find_loop_candidates_excluding(input, None)
            .into_iter()
            .filter(candidate_token_goal_reached)
            .collect::<Vec<_>>();
        self.extract_paused_candidates(&mut candidates);
        let live_token_goals = live_token_goal_keys(input);
        self.announced_token_goals
            .retain(|key| live_token_goals.contains(key));
        self.pending_token_goal_announcements
            .retain(|_, key| live_token_goals.contains(key));
        let candidates = self.dwelled_candidates(
            candidates,
            now_ms,
            config_i64(input, "stoppedDwellMs", 0),
            config_i64(input, "nudgeCooldownMs", 60_000),
            config_u64(input, "unchangedReminderTicks"),
        );
        self.plan_token_goal_announcements(candidates, input)
    }

    fn plan_token_goal_announcements(
        &mut self,
        candidates: Vec<DwelledCandidate>,
        input: &Value,
    ) -> Vec<LoopSend> {
        let mut sends = Vec::new();
        for candidate in candidates {
            let id = str_field(&candidate.value, "id").to_owned();
            let Some(key) = token_goal_announcement_key(&candidate.value) else {
                continue;
            };
            if self.announced_token_goals.contains(&key)
                || !session_can_receive_loop_send(input, &id)
            {
                continue;
            }
            let signature = candidate_signature(std::slice::from_ref(&candidate.value));
            self.pending_send_keys
                .insert(signature.clone(), vec![candidate.key.clone()]);
            self.pending_token_goal_announcements
                .insert(signature.clone(), key);
            sends.push(LoopSend {
                session_id: id,
                text: build_token_goal_met_notice(&candidate.value),
                signature,
                kind: LoopSendKind::DirectNudge,
            });
        }
        sends
    }

    fn plan_sends_for_recipient(
        &mut self,
        input: &Value,
        now_ms: i64,
        overseer_id: Option<String>,
    ) -> Vec<LoopSend> {
        let mut sends = Vec::new();
        self.gc_stale_pauses(input);
        self.refresh_buffered_work(input);
        let loop_exit_summary = self.plan_loop_exit_summary(overseer_id.as_deref(), input, now_ms);
        // The fleet scan still excludes the overseer, because it also answers
        // "who is spare capacity" -- an idle overseer under a goal would read
        // as capacity forever and silence idle-fleet briefings. Its own goal
        // is added here instead, so pause extraction and the dwell window
        // cover it without the capacity callers ever seeing it.
        let mut raw_candidates = find_loop_candidates_with_overseer(input, overseer_id.as_deref());
        if let Some(id) = overseer_id.as_deref() {
            raw_candidates.extend(find_loop_candidates_only(input, id));
        }
        // Read from the stored goals, NOT from this tick's candidates. A
        // candidate only exists while the agent is idle or gone, and the
        // announcement is itself delivered as input -- so pruning against
        // candidates dropped the key the moment the agent got back to work and
        // said the same thing again at its next stop, which is exactly what
        // the notice tells it to do. A goal keeps its key while it is stored,
        // however busy its agent is.
        let live_token_goals = live_token_goal_keys(input);
        self.announced_token_goals
            .retain(|key| live_token_goals.contains(key));
        let paused_candidates = self.extract_paused_candidates(&mut raw_candidates);
        if overseer_id.is_some() {
            // All budget announcements belong to the outer watcher. Keep
            // paused goals in summaries, while recipient engines only nudge
            // their own non-met goals and report fleet work.
            raw_candidates.retain(|candidate| !candidate_token_goal_reached(candidate));
        }
        let paused_summary =
            self.plan_paused_summary(&paused_candidates, overseer_id.as_deref(), input);
        let reconciliation =
            self.plan_reconciliation(overseer_id.as_deref(), &paused_candidates, input, now_ms);
        let idle_fleet = self.plan_idle_fleet(overseer_id.as_deref(), input, now_ms);
        // ONE call, over the fleet and the overseer together: it evicts every
        // dwell key absent from the vec it is given, so two calls per scan
        // dropped each other's state and nothing could ever dwell.
        let candidates = self.dwelled_candidates(
            raw_candidates,
            now_ms,
            config_i64(input, "stoppedDwellMs", 0),
            config_i64(input, "nudgeCooldownMs", 60_000),
            config_u64(input, "unchangedReminderTicks"),
        );
        // A reached budget leaves the reminder path here: it is said once, and
        // then the goal goes quiet until Sam closes it.
        let (budget_reached, candidates): (Vec<_>, Vec<_>) = candidates
            .into_iter()
            .partition(|candidate| candidate_token_goal_reached(&candidate.value));
        sends.extend(self.plan_token_goal_announcements(budget_reached, input));
        // Split after dwelling, not before: its own goal is not news about the
        // fleet, so it is a direct nudge rather than a line in a briefing the
        // overseer is meant to act on.
        let (own_goal, candidates): (Vec<_>, Vec<_>) = match overseer_id.as_deref() {
            Some(id) => candidates
                .into_iter()
                .partition(|candidate| str_field(&candidate.value, "id") == id),
            None => (Vec::new(), candidates),
        };
        if let Some(send) = loop_exit_summary {
            sends.push(send);
        }
        let own_goal_cooldown = config_i64(input, "nudgeCooldownMs", 60_000).max(0);
        for candidate in own_goal {
            let id = str_field(&candidate.value, "id").to_owned();
            if !session_can_receive_loop_send(input, &id) {
                continue;
            }
            // The same cooldown the fleet nudges honour. Without it this
            // path's only brake was the dwell bookkeeping below, so losing
            // that bookkeeping turned the overseer's own nudge into one every
            // tick -- and nothing failed, because nothing scanned past a
            // delivered send.
            if now_ms - self.last_nudge_at.get(&id).copied().unwrap_or(0) < own_goal_cooldown {
                continue;
            }
            let signature = candidate_signature(std::slice::from_ref(&candidate.value));
            self.pending_send_keys
                .insert(signature.clone(), vec![candidate.key.clone()]);
            sends.push(LoopSend {
                session_id: id,
                text: build_canned_nudge(&candidate.value),
                signature,
                kind: LoopSendKind::DirectNudge,
            });
        }
        if candidates.is_empty() {
            if let Some(send) = paused_summary {
                sends.push(send);
            }
            if let Some(send) = reconciliation {
                sends.push(send);
            }
            if let Some(send) = idle_fleet {
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
            if let Some(send) = idle_fleet {
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
            if let Some(send) = idle_fleet {
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
        if let Some(send) = idle_fleet {
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
        if !matches!(outcome, LoopDeliveryOutcome::Buffered) {
            self.last_delivery_recipient = Some(send.session_id.clone());
        }
        if !self.owns_token_goal_announcement(send)
            && !self.owns_buffered_send(send)
            && let Some(watcher) = self.recipient_watchers.get_mut(&send.session_id)
        {
            watcher.commit_send_result(send, now_ms, outcome.clone());
            self.record_delivery(send, now_ms, outcome);
            return;
        }
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
            LoopSendKind::IdleFleet => {
                self.last_idle_fleet_wake_at = now_ms;
                self.last_idle_fleet_attempted_signature = Some(send.signature.clone());
                if matches!(outcome, LoopDeliveryOutcome::Delivered) {
                    self.last_idle_fleet_reported_signature = Some(send.signature.clone());
                }
            }
        }
        let delivered = matches!(outcome, LoopDeliveryOutcome::Delivered);
        if let Some(buffered) = self
            .buffered_sends
            .get_mut(&buffered_send_key(send))
            .filter(|buffered| buffered.session_id == send.session_id)
        {
            match &outcome {
                LoopDeliveryOutcome::Failed { .. } => buffered.last_failed_at_ms = Some(now_ms),
                LoopDeliveryOutcome::Delivered => buffered.last_failed_at_ms = None,
                LoopDeliveryOutcome::Buffered => {}
            }
        }
        if send.kind == LoopSendKind::LoopExit {
            if let Some(keys) = self.pending_loop_exits.get(&send.signature) {
                for key in keys {
                    self.loop_exit_attempts.insert(key.clone(), now_ms);
                    if delivered {
                        self.reported_loop_exits.insert(key.clone());
                    }
                }
            }
            if delivered {
                self.pending_loop_exits.remove(&send.signature);
            }
        }
        if delivered
            && let Some(key) = self
                .pending_token_goal_announcements
                .remove(&send.signature)
        {
            self.announced_token_goals.insert(key);
        }
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

    pub fn record_scan_result(
        &mut self,
        input: &Value,
        now_ms: i64,
        sends: &[LoopSend],
        indeterminate: Vec<LoopScanIndeterminate>,
    ) {
        let raw_candidates = find_loop_candidates_with_overseer(input, None);
        let mut raw_candidate_ids = raw_candidates
            .iter()
            .filter_map(|candidate| optional_str(candidate, "id").map(ToOwned::to_owned))
            .collect::<Vec<_>>();
        raw_candidate_ids.sort();
        raw_candidate_ids.dedup();
        self.scan_records.push(LoopScanRecord {
            at_ms: now_ms,
            raw_candidate_count: raw_candidates.len(),
            planned_send_count: sends.len(),
            buffered_send_count: self.buffered_send_count(),
            raw_candidate_ids,
            planned_send_kinds: sends
                .iter()
                .map(|send| loop_send_kind_name(send.kind).to_owned())
                .collect(),
            indeterminate,
            global_pause_active: self.is_global_pause_active(now_ms),
        });
        if self.scan_records.len() > 32 {
            let excess = self.scan_records.len().saturating_sub(32);
            self.scan_records.drain(0..excess);
        }
    }

    pub fn last_delivery_record(&self) -> Option<&LoopDeliveryRecord> {
        self.delivery_records.last()
    }

    pub fn last_scan_record(&self) -> Option<&LoopScanRecord> {
        self.scan_records.last()
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

    fn owns_buffered_send(&self, send: &LoopSend) -> bool {
        self.buffered_sends
            .get(&buffered_send_key(send))
            .is_some_and(|buffered| buffered.session_id == send.session_id)
    }

    fn owns_token_goal_announcement(&self, send: &LoopSend) -> bool {
        send.kind == LoopSendKind::DirectNudge
            && self
                .pending_token_goal_announcements
                .contains_key(&send.signature)
    }

    pub fn buffer_send(&mut self, send: &LoopSend, now_ms: i64) {
        if !self.owns_token_goal_announcement(send)
            && !self.owns_buffered_send(send)
            && let Some(watcher) = self.recipient_watchers.get_mut(&send.session_id)
        {
            watcher.buffer_send(send, now_ms);
            return;
        }
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
                last_failed_at_ms: None,
                candidate_keys: Vec::new(),
            });
        entry.last_seen_at_ms = now_ms;
        entry.seen_count = entry.seen_count.saturating_add(1);
        entry.session_id = send.session_id.clone();
        entry.text = send.text.clone();
        entry.signature = send.signature.clone();
        entry.kind = loop_send_kind_name(send.kind).to_owned();
        if !candidate_keys.is_empty() {
            entry.candidate_keys = candidate_keys
                .iter()
                .map(BufferedLoopCandidateKey::from_dwell_key)
                .collect();
        }
    }

    pub fn last_delivery_recipient(&self) -> Option<&str> {
        self.last_delivery_recipient.as_deref()
    }

    pub fn buffered_send_retry_due(&self, send: &LoopSend, now_ms: i64, cooldown_ms: i64) -> bool {
        if let Some(buffered) = self
            .buffered_sends
            .get(&buffered_send_key(send))
            .filter(|buffered| buffered.session_id == send.session_id)
        {
            return buffered
                .last_failed_at_ms
                .is_none_or(|failed_at| now_ms.saturating_sub(failed_at) >= cooldown_ms);
        }
        self.recipient_watchers
            .get(&send.session_id)
            .is_none_or(|watcher| watcher.buffered_send_retry_due(send, now_ms, cooldown_ms))
    }

    pub fn buffered_sends_to_deliver(&self, limit: usize) -> Vec<LoopSend> {
        self.buffered_sends
            .values()
            .take(limit)
            .filter_map(buffered_send_to_loop_send)
            .chain(
                self.recipient_watchers
                    .values()
                    .flat_map(|watcher| watcher.buffered_sends_to_deliver(limit)),
            )
            .take(limit)
            .collect()
    }

    pub fn buffered_sends_for_input(&self, input: &Value, limit: usize) -> Vec<LoopSend> {
        self.buffered_sends
            .values()
            .filter_map(buffered_send_to_loop_send)
            .filter_map(|send| self.current_buffered_work_send(&send, input))
            .chain(
                self.recipient_watchers
                    .values()
                    .flat_map(|watcher| watcher.buffered_sends_for_input(input, limit)),
            )
            .take(limit)
            .collect()
    }

    fn refresh_buffered_work(&mut self, input: &Value) {
        let updates = self
            .buffered_sends
            .iter()
            .filter_map(|(key, buffered)| {
                let send = buffered_send_to_loop_send(buffered)?;
                Some((key.clone(), self.current_buffered_work_send(&send, input)))
            })
            .collect::<Vec<_>>();
        for (key, send) in updates {
            if let Some(send) = send {
                if let Some(buffered) = self.buffered_sends.get_mut(&key) {
                    buffered.text = send.text;
                }
            } else if let Some(buffered) = self.buffered_sends.remove(&key) {
                self.pending_loop_exits.remove(&buffered.signature);
            }
        }
    }

    fn current_buffered_work_send(&self, send: &LoopSend, input: &Value) -> Option<LoopSend> {
        if matches!(
            send.kind,
            LoopSendKind::OverseerBriefing | LoopSendKind::DirectNudge
        ) && self
            .buffered_sends
            .get(&buffered_send_key(send))
            .is_some_and(|buffered| {
                buffered.candidate_keys.iter().any(|key| {
                    array_field(input, "sessions").iter().any(|session| {
                        str_field(session, "id") == key.session_id
                            && session_is_parked(input, session)
                    })
                })
            })
        {
            return None;
        }
        let overseer = Some(send.session_id.as_str());
        let mut candidates = find_loop_candidates_with_overseer(input, overseer);
        let paused = self.extract_paused_candidates(&mut candidates);
        let text = match send.kind {
            LoopSendKind::Reconciliation => match find_visible_unowned_work(input) {
                Err(error) => {
                    if send.signature != format!("work-inventory-unavailable:{error}") {
                        return None;
                    }
                    build_inventory_unavailable_briefing(&error)
                }
                Ok(work) => {
                    let available = find_idle_loop_capacity(input, overseer, &paused);
                    if work.is_empty()
                        || available.is_empty()
                        || send.signature != reconciliation_signature(&work, &available)
                    {
                        return None;
                    }
                    build_reconciliation_briefing(&work, &available)
                }
            },
            LoopSendKind::IdleFleet => {
                let work = match find_idle_fleet_waiting_work(input, overseer) {
                    Ok(work) => work,
                    // The fresh reconciliation reports the error; old work must not flush.
                    Err(_) => return None,
                };
                let available = find_idle_fleet_capacity(input, overseer);
                if work.is_empty()
                    || available.is_empty()
                    || !fleet_is_fully_idle(input, overseer)
                    || !find_idle_loop_capacity(input, overseer, &paused).is_empty()
                {
                    return None;
                }
                build_idle_fleet_briefing(&work, &available)
            }
            LoopSendKind::LoopExit => {
                let keys = self.pending_loop_exits.get(&send.signature)?;
                let candidates = find_loop_exit_candidates_with_overseer(input, overseer)
                    .into_iter()
                    .filter(|candidate| keys.contains(&loop_exit_candidate_signature(candidate)))
                    .collect::<Vec<_>>();
                if candidates.is_empty() {
                    return None;
                }
                build_loop_exit_briefing(&candidates)
            }
            LoopSendKind::PausedSummary => {
                if paused.is_empty() {
                    return None;
                }
                build_paused_summary(&paused)
            }
            _ => return Some(send.clone()),
        };
        Some(LoopSend {
            text,
            ..send.clone()
        })
    }

    pub fn remove_buffered_send(&mut self, send: &LoopSend) {
        if self.owns_buffered_send(send) {
            self.buffered_sends.remove(&buffered_send_key(send));
        }
        if let Some(watcher) = self.recipient_watchers.get_mut(&send.session_id) {
            watcher.remove_buffered_send(send);
        }
    }

    pub fn buffered_send_count(&self) -> usize {
        self.buffered_sends.len()
            + self
                .recipient_watchers
                .values()
                .map(Self::buffered_send_count)
                .sum::<usize>()
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
                "bufferedCount": self.buffered_send_count(),
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
                "bufferedCount": self.buffered_send_count()
            })),
            "pausedCount": self.paused_loop_alerts.len(),
            "bufferedCount": self.buffered_send_count(),
            "recentScans": self.scan_records
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
        // Keyed on what defines a PAUSE, not on everything about the candidate.
        //
        // `candidate_signature` includes the goal, and PR 396 decided that only
        // `since` defines a pause -- editing a paused agent's goal must not
        // un-pause it, because `since` is the deliberate re-add signal. That
        // fixed `extract_paused_candidates` and left this signature behind: a
        // goal edit still flipped it, `due_by_change` fired, and the overseer
        // got an immediate summary about a set that had not changed. The same
        // noise the pause was supposed to stop, arriving through the other door.
        let signature = paused_summary_signature(paused_candidates);
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
        let (work, unavailable) = match find_visible_unowned_work(input) {
            Ok(work) => (work, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        if unavailable.is_none() && (available.is_empty() || work.is_empty()) {
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

        let signature = match &unavailable {
            Some(error) => format!("work-inventory-unavailable:{error}"),
            None => reconciliation_signature(&work, &available),
        };
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
            text: match unavailable {
                Some(error) => build_inventory_unavailable_briefing(&error),
                None => build_reconciliation_briefing(&work, &available),
            },
            signature,
            kind: LoopSendKind::Reconciliation,
        })
    }

    fn plan_loop_exit_summary(
        &mut self,
        overseer_id: Option<&str>,
        input: &Value,
        now_ms: i64,
    ) -> Option<LoopSend> {
        let overseer_id = overseer_id.filter(|id| session_can_receive_loop_send(input, id))?;
        let candidates = find_loop_exit_candidates_with_overseer(input, Some(overseer_id));
        let cooldown_ms = config_i64(input, "nudgeCooldownMs", 60_000).max(0);
        let unreported = candidates
            .into_iter()
            .filter(|candidate| {
                let key = loop_exit_candidate_signature(candidate);
                !self.reported_loop_exits.contains(&key)
                    && self
                        .loop_exit_attempts
                        .get(&key)
                        .is_none_or(|at| now_ms.saturating_sub(*at) >= cooldown_ms)
            })
            .collect::<Vec<_>>();
        if unreported.is_empty() {
            return None;
        }
        let signature = format!("loop-exit:{}", candidate_signature(&unreported));
        self.pending_loop_exits.insert(
            signature.clone(),
            unreported
                .iter()
                .map(loop_exit_candidate_signature)
                .collect(),
        );
        Some(LoopSend {
            session_id: overseer_id.to_owned(),
            text: build_loop_exit_briefing(&unreported),
            signature,
            kind: LoopSendKind::LoopExit,
        })
    }

    fn plan_idle_fleet(
        &mut self,
        overseer_id: Option<&str>,
        input: &Value,
        now_ms: i64,
    ) -> Option<LoopSend> {
        let overseer_id = overseer_id.filter(|id| session_can_receive_loop_send(input, id))?;
        if !find_idle_loop_capacity(input, Some(overseer_id), &[]).is_empty() {
            self.clear_idle_fleet_state();
            return None;
        }
        let work = match find_idle_fleet_waiting_work(input, Some(overseer_id)) {
            Ok(work) => work,
            Err(_) => {
                self.clear_idle_fleet_state();
                return None;
            }
        };
        let idle_capacity = find_idle_fleet_capacity(input, Some(overseer_id));
        if work.is_empty() || idle_capacity.is_empty() {
            self.clear_idle_fleet_state();
            return None;
        }
        if !fleet_is_fully_idle(input, Some(overseer_id)) {
            self.clear_idle_fleet_state();
            return None;
        }

        let condition_since = *self.idle_fleet_condition_since_ms.get_or_insert(now_ms);
        let dwell_ms = config_i64(input, "idleFleetDwellMs", 30_000).max(0);
        if now_ms.saturating_sub(condition_since) < dwell_ms {
            return None;
        }

        let signature = idle_fleet_signature(&work, &idle_capacity);
        if self.last_idle_fleet_signature.as_deref() == Some(signature.as_str()) {
            self.unchanged_idle_fleet_ticks = self.unchanged_idle_fleet_ticks.saturating_add(1);
        } else {
            self.last_idle_fleet_signature = Some(signature.clone());
            self.unchanged_idle_fleet_ticks = 0;
        }

        let already_reported =
            self.last_idle_fleet_reported_signature.as_deref() == Some(signature.as_str());
        let already_attempted =
            self.last_idle_fleet_attempted_signature.as_deref() == Some(signature.as_str());
        let reminder_due = idle_fleet_reminder_due(
            input,
            self.unchanged_idle_fleet_ticks,
            now_ms.saturating_sub(self.last_idle_fleet_wake_at),
        );
        if (already_reported || already_attempted) && !reminder_due {
            return None;
        }

        Some(LoopSend {
            session_id: overseer_id.to_owned(),
            text: build_idle_fleet_briefing(&work, &idle_capacity),
            signature,
            kind: LoopSendKind::IdleFleet,
        })
    }

    fn clear_idle_fleet_state(&mut self) {
        self.last_idle_fleet_signature = None;
        self.last_idle_fleet_attempted_signature = None;
        self.last_idle_fleet_reported_signature = None;
        self.unchanged_idle_fleet_ticks = 0;
        self.idle_fleet_condition_since_ms = None;
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
) -> Result<bool, String> {
    let project_state_dir = project_state_dir.as_ref();
    let unparked = set_parked_session_alerts(project_state_dir, session_id, None)?;
    let state_path = loop_watcher_state_path(project_state_dir);
    let mut watcher = load_loop_watcher_state(&state_path)?;
    let cleared = watcher.unpause_loop_alerts(session_id);
    if cleared.is_some() {
        save_loop_watcher_state(&state_path, &watcher)?;
    }
    Ok(unparked || cleared.is_some())
}

pub fn set_parked_session_alerts(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    pause: Option<Value>,
) -> Result<bool, String> {
    update_parked_session_alerts(project_state_dir.as_ref(), session_id, pause, None)
}

fn update_parked_session_alerts(
    project_state_dir: &Path,
    session_id: &str,
    pause: Option<Value>,
    expected: Option<&Value>,
) -> Result<bool, String> {
    use crate::daemon_state::{MetadataState, metadata_state_path, save_metadata_state};
    let path = metadata_state_path(project_state_dir);
    let lock = crate::state_update_lock::acquire_state_update_lock(&path)?;
    let mut state: MetadataState = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("parse metadata state {}: {error}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => MetadataState::empty(),
        Err(error) => return Err(format!("read metadata state {}: {error}", path.display())),
    };
    if pause.is_none() && !state.sessions.contains_key(session_id) {
        return Ok(false);
    }
    let session = state
        .sessions
        .entry(session_id.to_owned())
        .or_insert(json!({}));
    let session = session.as_object_mut().ok_or_else(|| {
        format!("metadata for {session_id} must be an object to update parked alerts")
    })?;
    if expected.is_some_and(|expected| session.get("loopAlertsParked") != Some(expected)) {
        return Ok(false);
    }
    let changed = match pause {
        Some(pause) => session.insert("loopAlertsParked".into(), pause.clone()) != Some(pause),
        None => session.remove("loopAlertsParked").is_some(),
    };
    if changed {
        lock.ensure_owned_for_commit()?;
        save_metadata_state(project_state_dir, &state).map_err(|error| error.to_string())?;
    }
    Ok(changed)
}

pub fn refresh_parked_session_alerts(
    input: &mut Value,
    project_state_dir: &Path,
) -> Result<(), String> {
    let parked = input
        .pointer("/metadata/sessions")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|sessions| sessions.iter())
        .filter_map(|(id, metadata)| {
            metadata
                .get("loopAlertsParked")
                .map(|pause| (id.clone(), pause.clone()))
        })
        .collect::<Vec<_>>();
    for (id, pause) in parked {
        let session = array_field(input, "sessions")
            .iter()
            .find(|session| str_field(session, "id") == id);
        let stale = session.is_some_and(|session| {
            matches!(metadata_activity(input, &id), Some("busy" | "running"))
                || !parked_session_matches(input, session, &pause)
        });
        if stale {
            update_parked_session_alerts(project_state_dir, &id, None, Some(&pause))?;
            if let Some(metadata) = input
                .pointer_mut("/metadata/sessions")
                .and_then(|sessions| sessions.get_mut(&id))
                .and_then(Value::as_object_mut)
            {
                metadata.remove("loopAlertsParked");
            }
        }
    }
    Ok(())
}

pub fn parked_session_key(session: &Value) -> Option<String> {
    Some(
        json!([
            optional_str(session, "id")?,
            optional_str(session, "createdAt")?,
            session.pointer("/tmuxTarget/sessionName")?,
            session.pointer("/tmuxTarget/windowId")?
        ])
        .to_string(),
    )
}

pub fn parked_session_work_key(exchange: &Value, session_id: &str) -> String {
    let mut work = Vec::new();
    for task in array_field(exchange, "tasks") {
        if optional_str(task, "assignedTo") == Some(session_id)
            && matches!(
                str_field(task, "status"),
                "pending" | "assigned" | "in_progress" | "blocked"
            )
        {
            work.push(json!([
                "task",
                task.get("id"),
                task.get("status"),
                task.get("description")
            ]));
        }
    }
    for thread in array_field(exchange, "threads") {
        if !crate::project_service::runtime_exchange::thread_is_terminal(thread)
            && crate::project_service::runtime_exchange::thread_responsible_participants(thread)
                .contains(&session_id)
        {
            work.push(json!([
                "thread",
                thread.get("id"),
                thread.get("status"),
                thread.get("waitingOn")
            ]));
        }
    }
    work.sort_by_key(Value::to_string);
    Value::Array(work).to_string()
}

fn session_is_parked(input: &Value, session: &Value) -> bool {
    let id = str_field(session, "id");
    let metadata = input
        .pointer("/metadata/sessions")
        .and_then(|sessions| sessions.get(id));
    let Some(parked) = metadata.and_then(|meta| meta.get("loopAlertsParked")) else {
        return false;
    };
    matches!(metadata_activity(input, id), Some("idle" | "done"))
        && parked_session_matches(input, session, parked)
}

fn parked_session_matches(input: &Value, session: &Value, parked: &Value) -> bool {
    let id = str_field(session, "id");
    let Some(session_key) = parked_session_key(session) else {
        return false;
    };
    input
        .pointer("/metadata/sessions")
        .and_then(|sessions| sessions.get(id))
        .and_then(|meta| meta.pointer("/loop/active"))
        != Some(&Value::Bool(true))
        && optional_str(parked, "sessionKey") == Some(session_key.as_str())
        && optional_str(parked, "workKey")
            == Some(
                parked_session_work_key(input.get("runtimeExchange").unwrap_or(&Value::Null), id)
                    .as_str(),
            )
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistentLoopWatcherState {
    version: u32,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    recipient_watchers: BTreeMap<String, PersistentLoopWatcherState>,
    #[serde(default)]
    last_delivery_recipient: Option<String>,
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
    last_idle_fleet_signature: Option<String>,
    #[serde(default)]
    last_idle_fleet_attempted_signature: Option<String>,
    #[serde(default)]
    last_idle_fleet_reported_signature: Option<String>,
    #[serde(default)]
    last_idle_fleet_wake_at: i64,
    #[serde(default)]
    unchanged_idle_fleet_ticks: u64,
    #[serde(default)]
    idle_fleet_condition_since_ms: Option<i64>,
    #[serde(default)]
    reported_loop_exits: Vec<String>,
    #[serde(default)]
    loop_exit_attempts: BTreeMap<String, i64>,
    #[serde(default)]
    pending_loop_exits: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    announced_token_goals: Vec<String>,
    #[serde(default)]
    pending_token_goal_announcements: BTreeMap<String, String>,
    #[serde(default)]
    scan_records: Vec<LoopScanRecord>,
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
            recipient_watchers: watcher
                .recipient_watchers
                .iter()
                .map(|(id, recipient)| (id.clone(), Self::from_watcher(recipient)))
                .collect(),
            last_delivery_recipient: watcher.last_delivery_recipient.clone(),
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
            last_idle_fleet_signature: watcher.last_idle_fleet_signature.clone(),
            last_idle_fleet_attempted_signature: watcher
                .last_idle_fleet_attempted_signature
                .clone(),
            last_idle_fleet_reported_signature: watcher.last_idle_fleet_reported_signature.clone(),
            last_idle_fleet_wake_at: watcher.last_idle_fleet_wake_at,
            unchanged_idle_fleet_ticks: watcher.unchanged_idle_fleet_ticks,
            idle_fleet_condition_since_ms: watcher.idle_fleet_condition_since_ms,
            reported_loop_exits: watcher.reported_loop_exits.iter().cloned().collect(),
            loop_exit_attempts: watcher.loop_exit_attempts.clone(),
            pending_loop_exits: watcher.pending_loop_exits.clone(),
            announced_token_goals: watcher.announced_token_goals.iter().cloned().collect(),
            pending_token_goal_announcements: watcher.pending_token_goal_announcements.clone(),
            scan_records: watcher.scan_records.clone(),
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
            recipient_watchers: self
                .recipient_watchers
                .into_iter()
                .map(|(id, state)| state.into_watcher().map(|watcher| (id, watcher)))
                .collect::<Result<_, _>>()?,
            last_delivery_recipient: self.last_delivery_recipient,
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
            paused_loop_alerts: migrate_pause_keys(self.paused_loop_alerts),
            paused_summary_ticks: self.paused_summary_ticks,
            last_paused_summary_signature: self
                .last_paused_summary_signature
                .filter(|signature| signature.starts_with(PAUSED_SUMMARY_SIGNATURE_PREFIX)),
            global_pause: self.global_pause,
            buffered_sends: self.buffered_sends,
            global_pause_reminder_ticks: self.global_pause_reminder_ticks,
            last_reconciliation_signature: self.last_reconciliation_signature,
            last_reconciliation_attempted_signature: self.last_reconciliation_attempted_signature,
            last_reconciliation_reported_signature: self.last_reconciliation_reported_signature,
            last_reconciliation_wake_at: self.last_reconciliation_wake_at,
            unchanged_reconciliation_ticks: self.unchanged_reconciliation_ticks,
            reconciliation_condition_since_ms: self.reconciliation_condition_since_ms,
            last_idle_fleet_signature: self.last_idle_fleet_signature,
            last_idle_fleet_attempted_signature: self.last_idle_fleet_attempted_signature,
            last_idle_fleet_reported_signature: self.last_idle_fleet_reported_signature,
            last_idle_fleet_wake_at: self.last_idle_fleet_wake_at,
            unchanged_idle_fleet_ticks: self.unchanged_idle_fleet_ticks,
            idle_fleet_condition_since_ms: self.idle_fleet_condition_since_ms,
            reported_loop_exits: self.reported_loop_exits.into_iter().collect(),
            loop_exit_attempts: self.loop_exit_attempts,
            pending_loop_exits: self.pending_loop_exits,
            announced_token_goals: self.announced_token_goals.into_iter().collect(),
            pending_token_goal_announcements: self.pending_token_goal_announcements,
            scan_records: self.scan_records,
        })
    }
}

fn buffered_send_key(send: &LoopSend) -> String {
    // Recipient engines keep their own maps, so identical content for two
    // overseers remains separate without changing persisted buffer keys.
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
        LoopSendKind::IdleFleet => "idleFleet",
    }
}

fn loop_send_kind_from_name(value: &str) -> Option<LoopSendKind> {
    match value {
        "overseerBriefing" => Some(LoopSendKind::OverseerBriefing),
        "directNudge" => Some(LoopSendKind::DirectNudge),
        "pausedSummary" => Some(LoopSendKind::PausedSummary),
        "reconciliation" => Some(LoopSendKind::Reconciliation),
        "loopExit" => Some(LoopSendKind::LoopExit),
        "idleFleet" => Some(LoopSendKind::IdleFleet),
        _ => None,
    }
}

/// Bring pauses written before the key shrank forward.
///
/// `gc_stale_pauses` DELETES a pause whose key does not match, and every pause
/// already on disk is `since\ngoal\nsource`. Without this, upgrading would
/// silently drop every live pause on the first scan -- alerts returning for
/// agents somebody deliberately quieted, which is the bug this change exists to
/// fix, caused by the fix.
///
/// The old key's first line IS the `since`, so the migration is a truncation
/// and needs no version bump: a key with no newline is already the new shape.
fn migrate_pause_keys(
    pauses: BTreeMap<String, LoopAlertPause>,
) -> BTreeMap<String, LoopAlertPause> {
    pauses
        .into_iter()
        .map(|(session_id, mut pause)| {
            if let Some((since, _)) = pause.loop_key.split_once('\n') {
                pause.loop_key = since.to_owned();
            }
            (session_id, pause)
        })
        .collect()
}

/// What a pause is pinned to, so it survives everything except the one event
/// that should end it.
///
/// `since` alone, because that is the deliberate re-add: the overseer's own
/// launch brief says a `loop.since` newer than a removal you remember means the
/// agent was put back on purpose. A goal edit or a source change is not that.
///
/// It used to be `since\ngoal\nsource`, and `gc_stale_pauses` DELETES a pause
/// whose key no longer matches -- so editing a paused agent's goal did not
/// merely stop the pause applying, it erased the record. The alerts came back
/// with nothing left to say why.
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
    if since.is_empty() {
        return None;
    }
    Some(since)
}

pub fn find_loop_candidates_with_overseer(input: &Value, overseer_id: Option<&str>) -> Vec<Value> {
    let ids = overseer_session_ids_for_state(
        array_field(input, "sessions"),
        input.get("metadata").unwrap_or(&Value::Null),
    );
    find_loop_candidates_excluding(input, overseer_id)
        .into_iter()
        .filter(|candidate| !ids.iter().any(|id| id == str_field(candidate, "id")))
        .collect()
}

/// Loop candidates narrowed to one session, which is how the overseer's own
/// goal is read without putting it in the fleet scan.
pub fn find_loop_candidates_only(input: &Value, only: &str) -> Vec<Value> {
    find_loop_candidates_excluding(input, None)
        .into_iter()
        .filter(|candidate| str_field(candidate, "id") == only)
        .collect()
}

/// Loop candidates, with `excluded` left out.
///
/// The overseer used to be excluded unconditionally, which is right for "who
/// is spare capacity" and wrong for "who has an unmet goal" -- it can hold one
/// like any other agent now. `find_idle_loop_capacity` still excludes it, or a
/// goal on an idle overseer would make it look like capacity forever and
/// silence idle-fleet briefings for good.
pub fn find_loop_candidates_excluding(input: &Value, excluded: Option<&str>) -> Vec<Value> {
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
            if excluded == Some(id) || pending.contains(id) {
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
            // A reached budget is not an unmet goal, so it stops being a
            // reminder -- but it is carried as a candidate once so the agent is
            // TOLD, through the same idle, dwell and pause gate every other
            // nudge goes through. A budget that fired in silence is
            // indistinguishable from a watcher that broke. `Unmeasured` is NOT
            // met: it keeps reminding, and the text says it cannot measure.
            let token_goal_met = candidate_token_goal_met(loop_meta, meta.get("tokenSpend"));
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
            if let Some(delivery) =
                crate::project_service::input_delivery_receipt::projected_input_delivery(
                    session,
                    Some(meta),
                )
            {
                candidate.insert("inputDelivery".into(), delivery);
            }
            insert_str(&mut candidate, "id", Some(id));
            insert_str(
                &mut candidate,
                "goalKind",
                loop_meta.get("goalKind").and_then(Value::as_str),
            );
            if let Some(budget) = loop_meta.get("tokenBudget").and_then(Value::as_u64) {
                candidate.insert("tokenBudget".into(), Value::from(budget));
            }
            if let Some(spend) = meta.get("tokenSpend") {
                candidate.insert("tokenSpend".into(), spend.clone());
            }
            if token_goal_met {
                candidate.insert("tokenGoalMet".into(), Value::Bool(true));
            }
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
    let overseer_ids = overseer_session_ids_for_state(array_field(input, "sessions"), metadata);
    array_field(input, "sessions")
        .iter()
        .filter_map(|session| {
            let id = str_field(session, "id");
            if overseer_id == Some(id)
                || overseer_ids.iter().any(|overseer| overseer == id)
                || !is_known_loop_exit_session_status(session)
                || session_is_parked(input, session)
            {
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

fn metadata_activity<'a>(input: &'a Value, session_id: &str) -> Option<&'a str> {
    input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get(session_id))
        .and_then(|session| session.get("derived"))
        .and_then(|derived| derived.get("activity"))
        .and_then(Value::as_str)
}

fn is_scribe_metadata_session(metadata: &Value, session: &Value) -> bool {
    let id = str_field(session, "id");
    let meta = metadata
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get(id))
        .unwrap_or(&Value::Null);
    meta.get("scribe").and_then(Value::as_bool).unwrap_or(false)
        || meta.get("team").and_then(|team| optional_str(team, "role")) == Some("scribe")
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

fn build_inventory_unavailable_briefing(error: &str) -> String {
    format!(
        "[aimux loop check] Work inventory unavailable: {error}\nCould not determine whether work is waiting. Repair the inventory before assigning or closing work."
    )
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

fn build_idle_fleet_briefing(work: &[Value], available: &[Value]) -> String {
    let mut lines = Vec::from([String::from(
        "[aimux loop check] The agent fleet appears idle while visible work is waiting.",
    )]);
    lines.push(String::from(
        "This includes agents outside managed loops and agents that self-exited their loops; `idle` and `done` both mean no worker appears to be making progress.",
    ));
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
    lines.push(String::from("Idle available agents:"));
    lines.extend(available.iter().take(8).map(describe_idle_fleet_capacity));
    if available.len() > 8 {
        lines.push(format!("- ... and {} more", available.len() - 8));
    }
    lines.push(String::new());
    lines.push(String::from(
        "Assign queued work, close stale worklist items, or intentionally pause the fleet; silence here would otherwise look like progress.",
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

fn find_idle_fleet_capacity(input: &Value, overseer_id: Option<&str>) -> Vec<Value> {
    fleet_worker_sessions(input, overseer_id)
        .into_iter()
        .filter(|session| !session_is_parked(input, session))
        .filter_map(|session| {
            let id = str_field(session, "id");
            let activity = metadata_activity(input, id)?;
            matches!(activity, "idle" | "done").then(|| {
                json!({
                    "id": id,
                    "activity": activity,
                    "worktreePath": session.get("worktreePath").cloned().unwrap_or(Value::Null),
                    "tool": session.get("tool").cloned().unwrap_or(Value::Null)
                })
            })
        })
        .collect()
}

fn fleet_is_fully_idle(input: &Value, overseer_id: Option<&str>) -> bool {
    let workers = fleet_worker_sessions(input, overseer_id);
    !workers.is_empty()
        && workers.iter().all(|session| {
            let id = str_field(session, "id");
            matches!(metadata_activity(input, id), Some("idle" | "done"))
        })
}

fn fleet_worker_sessions<'a>(input: &'a Value, overseer_id: Option<&str>) -> Vec<&'a Value> {
    let metadata = input.get("metadata").unwrap_or(&Value::Null);
    let overseer_ids = overseer_session_ids_for_state(array_field(input, "sessions"), metadata);
    array_field(input, "sessions")
        .iter()
        .filter(|session| {
            let id = str_field(session, "id");
            !id.is_empty()
                && overseer_id != Some(id)
                && !overseer_ids.iter().any(|overseer| overseer == id)
                && !is_scribe_metadata_session(metadata, session)
                && optional_str(session, "status")
                    .map(|status| matches!(status, "starting" | "running" | "idle"))
                    .unwrap_or(true)
        })
        .collect()
}

fn find_visible_unowned_work(input: &Value) -> Result<Vec<Value>, String> {
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
    for item in coordination_worklist_needs_you(input)? {
        if let Some(item) = unowned_worklist_item(&item, &live_sessions)? {
            work.push(item);
        }
    }
    work.sort_by(|left, right| {
        str_field(left, "sortKey")
            .cmp(str_field(right, "sortKey"))
            .then_with(|| str_field(left, "id").cmp(str_field(right, "id")))
    });
    work.dedup_by(|left, right| str_field(left, "dedupeKey") == str_field(right, "dedupeKey"));
    Ok(work)
}

fn find_idle_fleet_waiting_work(
    input: &Value,
    overseer_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut work = find_visible_unowned_work(input)?;
    let idle_workers = find_idle_fleet_capacity(input, overseer_id)
        .into_iter()
        .filter_map(|worker| optional_str(&worker, "id").map(str::to_owned))
        .collect::<BTreeSet<_>>();
    let exchange = input.get("runtimeExchange").unwrap_or(&Value::Null);
    for task in array_field(exchange, "tasks") {
        if let Some(item) = idle_owned_task_item(task, &idle_workers) {
            work.push(item);
        }
    }
    for thread in array_field(exchange, "threads") {
        if let Some(item) = idle_owned_thread_item(thread, &idle_workers) {
            work.push(item);
        }
    }
    work.sort_by(|left, right| {
        str_field(left, "sortKey")
            .cmp(str_field(right, "sortKey"))
            .then_with(|| str_field(left, "id").cmp(str_field(right, "id")))
    });
    work.dedup_by(|left, right| str_field(left, "dedupeKey") == str_field(right, "dedupeKey"));
    Ok(work)
}

fn coordination_worklist_needs_you(input: &Value) -> Result<Vec<Value>, String> {
    let Some(worklist) = input.get("coordinationWorklist") else {
        return Err("coordinationWorklist missing from loop watcher input".into());
    };
    if let Some(error) = optional_str(worklist, "error") {
        return Err(error.to_owned());
    }
    if let Some(needs_you) = worklist.get("needsYou").and_then(Value::as_array) {
        return Ok(needs_you.clone());
    }
    match worklist.as_array() {
        Some(items) => Ok(items.clone()),
        None => Err("coordinationWorklist object missing needsYou".into()),
    }
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

fn idle_owned_task_item(task: &Value, idle_workers: &BTreeSet<String>) -> Option<Value> {
    let status = str_field(task, "status");
    if !matches!(status, "pending" | "assigned" | "in_progress" | "blocked") {
        return None;
    }
    let assigned_to = optional_str(task, "assignedTo")?;
    if !idle_workers.contains(assigned_to) {
        return None;
    }
    let id = optional_str(task, "id")?;
    Some(json!({
        "id": id,
        "kind": "task",
        "dedupeKey": format!("task:{id}"),
        "sortKey": format!("task:{id}"),
        "status": status,
        "ownerState": "assigned-owner-idle",
        "assignedTo": assigned_to,
        "title": optional_str(task, "description").unwrap_or("task")
    }))
}

fn idle_owned_thread_item(thread: &Value, idle_workers: &BTreeSet<String>) -> Option<Value> {
    if crate::project_service::runtime_exchange::thread_is_terminal(thread) {
        return None;
    }
    let owner = crate::project_service::runtime_exchange::thread_responsible_participants(thread)
        .into_iter()
        .find(|owner| idle_workers.contains(*owner))?;
    let id = optional_str(thread, "id")?;
    Some(json!({
        "id": id, "kind": "thread", "dedupeKey": format!("thread:{id}"),
        "sortKey": format!("thread:{id}"), "status": str_field(thread, "status"),
        "ownerState": "assigned-owner-idle", "assignedTo": owner,
        "title": optional_str(thread, "title").unwrap_or("thread")
    }))
}

fn unowned_worklist_item(
    item: &Value,
    live_sessions: &BTreeSet<String>,
) -> Result<Option<Value>, String> {
    if !item
        .get("actionable")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(None);
    }
    if optional_str(item, "sessionId").is_some() {
        return Ok(None);
    }
    // A thread's next actor is on the thread, not notification-only sessionId.
    let owner = worklist_thread_owner(item);
    let owner_state = match owner {
        None => "unassigned-worklist",
        Some(owner) if !live_sessions.contains(owner) => "worklist-owner-unreachable",
        Some(_) => return Ok(None),
    };
    let key = optional_str(item, "key").ok_or("worklist row missing key")?;
    let kind = optional_str(item, "kind").unwrap_or("worklist");
    let id = if kind == "thread" {
        item.pointer("/thread/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or("worklist thread missing thread.id")?
    } else {
        key
    };
    Ok(Some(json!({
        "id": id,
        "kind": kind,
        "dedupeKey": format!("worklist:{key}"),
        "sortKey": format!("worklist:{key}"),
        "status": optional_str(item, "bucket").unwrap_or("actionable"),
        "ownerState": owner_state,
        "assignedTo": owner,
        "title": optional_str(item, "title").unwrap_or("worklist item")
    })))
}

/// Waiting recipients hold the next action; an owner is responsible only when
/// nobody else is awaited, including after a task is handed back for review.
fn worklist_thread_owner(item: &Value) -> Option<&str> {
    let thread = item.get("thread")?.get("thread")?;
    crate::project_service::runtime_exchange::thread_responsible_participants(thread)
        .into_iter()
        .find(|owner| !owner.trim().is_empty())
}

fn reconciliation_signature(work: &[Value], available: &[Value]) -> String {
    format!(
        "reconciliation:condition:unowned-work-present:{}:idle-capacity-present:{}",
        !work.is_empty(),
        !available.is_empty()
    )
}

fn idle_fleet_signature(work: &[Value], available: &[Value]) -> String {
    format!(
        "idle-fleet:condition:work-waiting:{}:fleet-idle:{}",
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

fn idle_fleet_reminder_due(
    input: &Value,
    unchanged_ticks: u64,
    elapsed_since_last_wake_ms: i64,
) -> bool {
    let ticks = input
        .get("config")
        .and_then(|config| config.get("idleFleetReminderTicks"))
        .and_then(Value::as_u64)
        .unwrap_or(6)
        .max(1);
    let cooldown = config_i64(input, "idleFleetCooldownMs", 15 * 60 * 1000).max(0);
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

fn describe_idle_fleet_capacity(candidate: &Value) -> String {
    let activity = optional_str(candidate, "activity")
        .map(|activity| format!(" — activity: {activity}"))
        .unwrap_or_default();
    format!("- {}{}", str_field(candidate, "id"), activity)
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

    let delivery = candidate.get("inputDelivery");
    let delivery_label =
        crate::project_service::input_delivery_receipt::delivery_display_label(delivery)
            .map(|label| format!(" — {label}"))
            .unwrap_or_default();
    let notice = delivery
        .and_then(|value| optional_str(value, "notice"))
        .map(|notice| format!(" — {notice}"))
        .unwrap_or_default();
    format!(
        "- {id}{condition}{tool}{where_text}{provenance}{last_action}{goal}{delivery_label}{notice}"
    )
}

pub fn build_canned_nudge(candidate: &Value) -> String {
    let goal = optional_str(candidate, "goal")
        .map(|goal| format!(" with this goal: {goal}"))
        .unwrap_or_default();
    let mut lines = vec![format!(
        "[aimux loop] You stopped, but you're in a managed loop{goal}."
    )];
    match candidate_goal_kind(candidate) {
        GoalKind::AgentManaged => {
            lines.push(String::from(
                "Keep working toward it now. Only stop when you have genuinely finished or are blocked beyond repair:",
            ));
            lines.push(String::from(
                "- finished  → run `aimux loop done --reason \"…\"`",
            ));
            lines.push(String::from(
                "- hard-blocked → run `aimux loop block --reason \"…\"`",
            ));
            lines.push(String::from("Otherwise, continue."));
        }
        GoalKind::UserManaged => {
            lines.push(String::from(
                "This goal is USER-MANAGED: it is not yours to close, pause or block, and those commands will be refused.",
            ));
            lines.push(String::from(
                "Keep working toward it. If there is genuinely nothing left you can do, say so and what you are waiting on, then stop -- the reminder is not asking you to invent work.",
            ));
        }
        GoalKind::TokenBudget(budget) => {
            let standing = match candidate_token_spend(candidate) {
                Some(billed) => format!(" {billed} of {budget} spent so far."),
                // Said out loud rather than shown as zero: aider and shell
                // report no usage, and a fresh baseline has nothing yet.
                None => format!(
                    " Spend is not measured on this runtime, so the {budget}-token mark cannot be checked."
                ),
            };
            lines.push(format!(
                "This goal is met at {budget} tokens of spend, measured rather than declared, so it is not yours to close.{standing}"
            ));
            lines.push(String::from(
                "Keep working toward it, or say what you are waiting on if there is nothing left to do.",
            ));
        }
    }
    lines.join("\n")
}

/// The goal kind recorded on a candidate, defaulting the way stored metadata
/// does. The watcher reads the same field the routes write.
pub fn candidate_goal_kind(candidate: &Value) -> GoalKind {
    GoalKind::parse(
        optional_str(candidate, "goalKind"),
        candidate.get("tokenBudget").and_then(Value::as_u64),
    )
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
    serde_json::to_string(action).ok()
}

/// The prefix that marks a paused-summary signature as being in the current
/// format.
///
/// It is persisted, so changing what goes into the signature changes what a
/// stored one means. Without a marker, the first scan after an upgrade compares
/// an old-format signature against a new-format one, finds them different, and
/// fires `due_by_change` -- one spurious prompt to the overseer, which is
/// exactly the noise this change exists to remove, arriving at upgrade time.
/// `into_watcher` drops a stored signature that does not carry this prefix, so
/// an upgrade reads as "no previous signature" and says nothing.
///
/// This is the same trap PR 396's own review caught in the pause keys: a format
/// change is a migration whether or not it is called one.
/// The unit separator is deliberate: it is the field separator the signature
/// itself uses, so no session id can contain one. A plain `paused:v2:` prefix
/// would be forgeable by an id that happened to start `v2:`, which is
/// implausible but free to rule out.
const PAUSED_SUMMARY_SIGNATURE_PREFIX: &str = "paused:v2\u{1f}";

fn paused_summary_signature(candidates: &[Value]) -> String {
    format!(
        "{PAUSED_SUMMARY_SIGNATURE_PREFIX}{}",
        paused_pause_signature(candidates)
    )
}

/// Which agents are paused, and against which pause.
///
/// Deliberately not `candidate_signature`: that one answers "has anything about
/// these candidates changed", which is the right question for a briefing and
/// the wrong one for a paused set. A pause is identified by `loopSince` alone
/// -- see `loop_pause_key` -- so that is what this reads, and a goal edit is
/// not a change to the paused set.
fn paused_pause_signature(candidates: &[Value]) -> String {
    let mut parts = candidates
        .iter()
        .map(|candidate| {
            [
                str_field(candidate, "id"),
                str_field(candidate, "condition"),
                loop_pause_key(candidate).unwrap_or_default().as_str(),
            ]
            .join("\u{1f}")
        })
        .collect::<Vec<_>>();
    parts.sort();
    parts.join("\u{1e}")
}

fn candidate_signature(candidates: &[Value]) -> String {
    let mut ids = candidates
        .iter()
        .map(candidate_signature_part)
        .collect::<Vec<_>>();
    ids.sort();
    ids.join("\u{1e}")
}

fn candidate_signature_part(candidate: &Value) -> String {
    let loop_exit_report_id = candidate
        .get("loopLastAction")
        .and_then(|action| optional_str(action, "reportId"));
    if let Some(report_id) = loop_exit_report_id
        && !report_id.is_empty()
    {
        return [
            str_field(candidate, "id"),
            str_field(candidate, "condition"),
            "report",
            report_id,
        ]
        .join("\u{1f}");
    }
    [
        str_field(candidate, "id"),
        str_field(candidate, "condition"),
        str_field(candidate, "loopSince"),
        str_field(candidate, "loopActionAt"),
        optional_str(candidate, "goal").unwrap_or_default(),
        optional_str(candidate, "loopSource").unwrap_or_default(),
    ]
    .join("\u{1f}")
}

fn loop_exit_candidate_signature(candidate: &Value) -> String {
    format!(
        "loop-exit:{}",
        candidate_signature(std::slice::from_ref(candidate))
    )
}

/// The same rule read off a scan candidate rather than the metadata.
///
/// Two spellings of one decision is how they drifted apart in the first place,
/// so `the_two_pause_keys_agree_for_an_active_loop` pins them against each
/// other. They are not interchangeable: the metadata side also refuses an
/// inactive loop, which a candidate cannot express.
pub fn loop_pause_key_from_candidate(candidate: &Value) -> Option<String> {
    loop_pause_key(candidate)
}

fn loop_pause_key(candidate: &Value) -> Option<String> {
    let since = optional_str(candidate, "loopSince").unwrap_or_default();
    if since.is_empty() {
        return None;
    }
    Some(since.to_owned())
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

/// Billed spend recorded against a candidate, if it could be measured.
/// Every stored token goal, keyed the way an announcement is.
///
/// Keyed on the budget as well as the session so raising it is a new thing to
/// announce, and read from metadata rather than from candidates so a working
/// agent does not look like a goal that went away.
fn live_token_goal_keys(input: &Value) -> BTreeSet<String> {
    let metadata = input.get("metadata").unwrap_or(&Value::Null);
    let Some(sessions) = metadata.get("sessions").and_then(Value::as_object) else {
        return BTreeSet::new();
    };
    sessions
        .iter()
        .filter_map(|(id, meta)| {
            let loop_meta = meta.get("loop")?;
            if loop_meta.get("active").and_then(Value::as_bool) != Some(true) {
                return None;
            }
            let budget = loop_meta.get("tokenBudget").and_then(Value::as_u64)?;
            Some(format!("{id}:{budget}"))
        })
        .collect()
}

/// Whether this candidate is a budget that has been reached.
fn candidate_token_goal_reached(candidate: &Value) -> bool {
    candidate
        .get("tokenGoalMet")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// What a reached budget is remembered as. Keyed on the budget as well as the
/// session, so raising it is a new thing to announce rather than one already
/// said.
fn token_goal_announcement_key(candidate: &Value) -> Option<String> {
    let budget = candidate.get("tokenBudget").and_then(Value::as_u64)?;
    Some(format!("{}:{budget}", str_field(candidate, "id")))
}

/// What an agent is told once, when its budget is reached.
///
/// Said rather than left to silence: the reminders simply stopping is
/// indistinguishable from the watcher failing, and the agent has no other way
/// to learn the number was hit.
pub fn build_token_goal_met_notice(candidate: &Value) -> String {
    let budget = candidate
        .get("tokenBudget")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let spent = candidate_token_spend(candidate)
        .map(|billed| format!("{billed} billed tokens spent"))
        .unwrap_or_else(|| String::from("the budget was reached"));
    let goal = optional_str(candidate, "goal")
        .map(|goal| format!(" ({goal})"))
        .unwrap_or_default();
    [
        format!(
            "[aimux loop] Your {budget}-token budget has been reached{goal}: {spent}."
        ),
        String::from(
            "The reminders stop here. The goal stays open until Sam closes it, so wrap up what you are mid-way through, say where you got to, and stop.",
        ),
    ]
    .join("\n")
}

pub fn candidate_token_spend(candidate: &Value) -> Option<u64> {
    candidate
        .get("tokenSpend")
        .and_then(|spend| spend.get("billed"))
        .and_then(Value::as_u64)
}

/// Whether a loop entry's token budget has been reached.
///
/// Reads the same `token_goal_status` the routes do, so "met" means one thing
/// across the product. An unmeasured budget is not met.
fn candidate_token_goal_met(loop_meta: &Map<String, Value>, spend: Option<&Value>) -> bool {
    let kind = GoalKind::parse(
        loop_meta.get("goalKind").and_then(Value::as_str),
        loop_meta.get("tokenBudget").and_then(Value::as_u64),
    );
    let billed = spend
        .and_then(|spend| spend.get("billed"))
        .and_then(Value::as_u64);
    matches!(
        crate::agent_goal::token_goal_status(&kind, billed),
        crate::agent_goal::TokenGoalStatus::Met
    )
}
