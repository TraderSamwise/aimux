//! The managed-loop watcher.
//!
//! An agent in a managed loop that has stopped without waiting on a human is a
//! nudge candidate. With an overseer present the watcher wakes the overseer with
//! a briefing and lets it decide; without one it stays observe-only unless
//! `loop.autoNudgeWithoutOverseer` is set. waiting/error/interrupted states are
//! deliberately excluded — those are genuine pauses we must not steamroll.

use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// One nudge the watcher wants delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopSend {
    pub session_id: String,
    pub text: String,
}

/// Cross-scan state: who was nudged when, and when the overseer was last woken.
#[derive(Debug, Default)]
pub struct LoopWatcher {
    last_nudge_at: BTreeMap<String, i64>,
    last_overseer_wake_at: i64,
    stopped_since: BTreeMap<String, i64>,
    last_candidate_signature: Option<String>,
    last_overseer_reported_signature: Option<String>,
    unchanged_candidate_ticks: u64,
}

impl LoopWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Scan once and deliver.
    ///
    /// `input` carries `sessions`, `metadata`, `config` and `pendingInteractions`.
    /// `deliver` reports whether the send landed: a cooldown only starts once a
    /// message actually arrives, so a failed send must not silence the overseer
    /// for a whole window.
    pub fn scan(
        &mut self,
        input: &Value,
        now_ms: i64,
        deliver: &mut dyn FnMut(&LoopSend) -> bool,
    ) -> Vec<LoopSend> {
        let mut sends = Vec::new();
        let metadata = input.get("metadata").unwrap_or(&Value::Null);
        let overseer_id = find_overseer_session_id(metadata);
        let raw_candidates = find_loop_candidates_with_overseer(input, overseer_id.as_deref());
        let candidates = self.dwelled_candidates(
            raw_candidates,
            now_ms,
            config_i64(input, "stoppedDwellMs", 0),
        );
        if candidates.is_empty() {
            self.last_candidate_signature = None;
            self.last_overseer_reported_signature = None;
            self.unchanged_candidate_ticks = 0;
            return sends;
        }
        let candidate_signature = candidate_signature(&candidates);
        if self.last_candidate_signature.as_deref() == Some(candidate_signature.as_str()) {
            self.unchanged_candidate_ticks = self.unchanged_candidate_ticks.saturating_add(1);
        } else {
            self.last_candidate_signature = Some(candidate_signature.clone());
            self.unchanged_candidate_ticks = 0;
        }

        let cooldown = config_i64(input, "nudgeCooldownMs", 60_000);
        let overseer_running = overseer_id
            .as_deref()
            .is_some_and(|id| session_exists(input, id));

        if let Some(overseer_id) = overseer_id.filter(|_| overseer_running) {
            let already_reported = self.last_overseer_reported_signature.as_deref()
                == Some(candidate_signature.as_str());
            let reminder_due = overseer_reminder_due(
                input,
                self.unchanged_candidate_ticks,
                now_ms.saturating_sub(self.last_overseer_wake_at),
                cooldown,
            );
            if already_reported && !reminder_due {
                return sends;
            }
            let send = LoopSend {
                session_id: overseer_id,
                text: build_overseer_briefing(
                    &candidates,
                    config_string(input, "overseerBriefingTemplate"),
                ),
            };
            if deliver(&send) {
                self.last_overseer_wake_at = now_ms;
                self.last_overseer_reported_signature = Some(candidate_signature);
            }
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
            let id = str_field(&candidate, "id").to_owned();
            if now_ms - self.last_nudge_at.get(&id).copied().unwrap_or(0) < cooldown {
                continue;
            }
            let send = LoopSend {
                session_id: id.clone(),
                text: build_canned_nudge(&candidate),
            };
            if deliver(&send) {
                self.last_nudge_at.insert(id, now_ms);
            }
            sends.push(send);
        }
        sends
    }

    fn dwelled_candidates(
        &mut self,
        candidates: Vec<Value>,
        now_ms: i64,
        dwell_ms: i64,
    ) -> Vec<Value> {
        let dwell_ms = dwell_ms.max(0);
        let current_ids = candidates
            .iter()
            .filter_map(|candidate| optional_str(candidate, "id").map(str::to_owned))
            .collect::<BTreeSet<_>>();
        self.stopped_since
            .retain(|id, _| current_ids.contains(id.as_str()));
        candidates
            .into_iter()
            .filter(|candidate| {
                let id = str_field(candidate, "id");
                let first_seen = self.stopped_since.entry(id.to_owned()).or_insert(now_ms);
                now_ms.saturating_sub(*first_seen) >= dwell_ms
            })
            .collect()
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
            && unchanged_ticks % ticks == 0
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
