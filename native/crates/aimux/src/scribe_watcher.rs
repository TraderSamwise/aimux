//! The scribe watcher.
//!
//! Every minute it looks for agents whose bounded output tail has changed since
//! it last said anything, and hands the scribe a briefing to fold into the
//! notes. Unchanged tails are fingerprinted and skipped, so a quiet project
//! costs one scan and no message.

use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};

const SCRIBE_WATCHER_COOLDOWN_MS: i64 = 60_000;
const SCRIBE_WATCHER_MAX_CANDIDATES: usize = 4;
const SCRIBE_WATCHER_MAX_SCAN_CANDIDATES: usize = 50;
const SCRIBE_WATCHER_OUTPUT_START_LINE: i64 = -80;
const SCRIBE_WATCHER_MAX_OUTPUT_CHARS: usize = 3_000;
const SCRIBE_WATCHER_MAX_BRIEFING_CHARS: usize = 16_000;
const SCRIBE_WATCHER_MAX_SEEN_FINGERPRINTS_PER_SESSION: usize = 5;
const SCRIBE_WATCHER_MAX_SEEN_SESSIONS: usize =
    SCRIBE_WATCHER_MAX_SCAN_CANDIDATES + SCRIBE_WATCHER_MAX_CANDIDATES + 4;

/// The briefing this scan wants delivered, and to whom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScribeBriefing {
    pub scribe_id: String,
    pub text: String,
}

/// Cross-scan state: when the scribe was last briefed, and which output tails
/// it has already been told about.
#[derive(Debug, Default)]
pub struct ScribeWatcher {
    last_briefing_at: i64,
    seen_fingerprints: BTreeMap<String, Vec<String>>,
}

impl ScribeWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Scan once and, if anything changed, brief the scribe.
    ///
    /// `read_output` returns a session's bounded tail, or None when it could not
    /// be read. `deliver` reports whether the briefing landed — and BOTH the
    /// cooldown and the fingerprints are committed only when it did, so a failed
    /// send neither burns the quiet window nor records tails as already told.
    pub fn scan(
        &mut self,
        input: &Value,
        now_ms: i64,
        read_output: &mut dyn FnMut(&str, i64) -> Option<String>,
        deliver: &mut dyn FnMut(&ScribeBriefing) -> bool,
    ) -> Option<ScribeBriefing> {
        let scribe_id = find_scribe_session_id(input)?;
        if !scribe_readiness(input, Some(&scribe_id)) {
            return None;
        }

        let cooldown = number_or(input, "cooldownMs", SCRIBE_WATCHER_COOLDOWN_MS);
        if self.last_briefing_at > 0 && now_ms - self.last_briefing_at < cooldown {
            return None;
        }

        let candidates = find_scribe_candidates_with_scribe(input, Some(&scribe_id));
        let mut active = BTreeSet::new();
        active.insert(scribe_id.as_str());
        for candidate in &candidates {
            active.insert(str_field(candidate, "id"));
        }
        prune_seen_fingerprints(&mut self.seen_fingerprints, active);
        if candidates.is_empty() {
            return None;
        }

        let start_line = number_or(input, "outputStartLine", SCRIBE_WATCHER_OUTPUT_START_LINE);
        let max_output_chars = number_or(
            input,
            "maxOutputChars",
            SCRIBE_WATCHER_MAX_OUTPUT_CHARS as i64,
        ) as usize;
        let max_briefing_chars = number_or(
            input,
            "maxBriefingChars",
            SCRIBE_WATCHER_MAX_BRIEFING_CHARS as i64,
        ) as usize;
        let max_candidates =
            number_or(input, "maxCandidates", SCRIBE_WATCHER_MAX_CANDIDATES as i64) as usize;

        let mut briefing_candidates = Vec::<Value>::new();
        for candidate in candidates {
            let session_id = str_field(&candidate, "id").to_owned();
            let Some(raw_output) = read_output(&session_id, start_line) else {
                continue;
            };
            let output = bounded_output(&raw_output, max_output_chars);
            if output.trim().is_empty() {
                continue;
            }
            let fingerprint = fingerprint_for(&session_id, &output);
            if self
                .seen_fingerprints
                .get(&session_id)
                .is_some_and(|seen| seen.contains(&fingerprint))
            {
                continue;
            }

            let mut next = candidate.as_object().cloned().unwrap_or_default();
            next.insert("output".to_owned(), json!(output));
            next.insert("outputChars".to_owned(), json!(output_char_count(&output)));
            next.insert("fingerprint".to_owned(), json!(fingerprint));
            let next = Value::Object(next);
            let Some(fitted) =
                fit_briefing_candidate(&briefing_candidates, &next, max_briefing_chars)
            else {
                if !briefing_candidates.is_empty() {
                    break;
                }
                continue;
            };
            briefing_candidates.push(fitted);
            if briefing_candidates.len() >= max_candidates {
                break;
            }
        }

        if briefing_candidates.is_empty() {
            return None;
        }

        let briefing = ScribeBriefing {
            scribe_id,
            text: build_scribe_briefing(&briefing_candidates),
        };
        if !deliver(&briefing) {
            return Some(briefing);
        }
        self.last_briefing_at = now_ms;
        for candidate in briefing_candidates {
            let session_id = str_field(&candidate, "id").to_owned();
            let fingerprint = str_field(&candidate, "fingerprint").to_owned();
            let existing = self
                .seen_fingerprints
                .get(&session_id)
                .cloned()
                .unwrap_or_default();
            let mut next = Vec::from([fingerprint.clone()]);
            next.extend(existing.into_iter().filter(|seen| seen != &fingerprint));
            next.truncate(SCRIBE_WATCHER_MAX_SEEN_FINGERPRINTS_PER_SESSION);
            self.seen_fingerprints.insert(session_id, next);
        }
        Some(briefing)
    }
}

fn number_or(input: &Value, field: &str, fallback: i64) -> i64 {
    input.get(field).and_then(Value::as_i64).unwrap_or(fallback)
}

pub fn find_scribe_candidates_with_scribe(input: &Value, scribe_id: Option<&str>) -> Vec<Value> {
    let metadata = input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let max_scan_candidates = input
        .get("maxScanCandidates")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(SCRIBE_WATCHER_MAX_SCAN_CANDIDATES);

    let mut candidates = Vec::new();
    for session in array_field(input, "sessions").to_vec() {
        let id = str_field(&session, "id");
        if scribe_id == Some(id) {
            continue;
        }
        let meta = metadata.get(id);
        if is_project_control_session(&session, meta) {
            continue;
        }
        let status = optional_str(&session, "status").unwrap_or("running");
        if status != "running" && status != "idle" {
            continue;
        }
        let activity = meta
            .and_then(|meta| meta.get("derived"))
            .and_then(|derived| derived.get("activity"))
            .and_then(Value::as_str);
        if activity != Some("idle") && activity != Some("done") {
            continue;
        }
        let attention = meta
            .and_then(|meta| meta.get("derived"))
            .and_then(|derived| derived.get("attention"))
            .and_then(Value::as_str)
            .unwrap_or("normal");
        if attention != "normal" {
            continue;
        }

        let mut candidate = Map::new();
        insert_str(&mut candidate, "id", Some(id));
        insert_str(&mut candidate, "status", Some(status));
        insert_str(&mut candidate, "activity", activity);
        insert_str(&mut candidate, "attention", Some(attention));
        insert_value(
            &mut candidate,
            "worktreePath",
            session.get("worktreePath").or_else(|| {
                meta.and_then(|meta| meta.get("context"))
                    .and_then(|context| context.get("worktreePath"))
            }),
        );
        insert_value(&mut candidate, "tool", session.get("tool"));
        candidates.push(Value::Object(candidate));
        if candidates.len() >= max_scan_candidates {
            break;
        }
    }

    candidates
}

pub fn build_scribe_briefing(candidates: &[Value]) -> String {
    let mut lines = Vec::from([
        String::from(
            "[aimux scribe check] Review these changed bounded agent tails and update the scribe notes only for meaningful distinct work.",
        ),
        String::from(
            "Use `aimux outline list --json` first when needed. Use stable topic keys and update existing entries instead of duplicating them.",
        ),
        String::from(
            "Ignore heartbeats, prompts, progress chatter, repeated status, and anything that is not real work.",
        ),
        String::new(),
    ]);
    lines.extend(candidates.iter().map(describe_candidate));
    lines.join("\n")
}

fn describe_candidate(candidate: &Value) -> String {
    let parts = [
        Some(format!("id={}", str_field(candidate, "id"))),
        optional_str(candidate, "tool").map(|value| format!("tool={value}")),
        optional_str(candidate, "status").map(|value| format!("status={value}")),
        optional_str(candidate, "activity").map(|value| format!("activity={value}")),
        optional_str(candidate, "attention").map(|value| format!("attention={value}")),
        optional_str(candidate, "worktreePath").map(|value| format!("worktree={value}")),
        Some(format!("chars={}", number_field(candidate, "outputChars"))),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    [
        format!("## {}", parts.join(" ")),
        String::new(),
        String::from("```text"),
        str_field(candidate, "output")
            .trim_end_matches(char::is_whitespace)
            .to_string(),
        String::from("```"),
    ]
    .join("\n")
}

/// Fit one candidate into the briefing budget, trimming its tail if needed.
///
/// Every measure here is CHARACTERS. Mixing byte lengths with a character-based
/// trim silently drops candidates on a box-drawing pane, where the trimmed tail
/// is about three times its character count in bytes and so fails the re-check.
fn fit_briefing_candidate(
    existing: &[Value],
    candidate: &Value,
    max_briefing_chars: usize,
) -> Option<Value> {
    let with_candidate = existing
        .iter()
        .cloned()
        .chain(std::iter::once(candidate.clone()))
        .collect::<Vec<_>>();
    if output_char_count(&build_scribe_briefing(&with_candidate)) <= max_briefing_chars {
        return Some(candidate.clone());
    }

    let mut empty_candidate = candidate.as_object().cloned().unwrap_or_default();
    empty_candidate.insert("output".to_string(), json!(""));
    empty_candidate.insert("outputChars".to_string(), json!(0));
    let empty_candidate = Value::Object(empty_candidate);
    let with_empty = existing
        .iter()
        .cloned()
        .chain(std::iter::once(empty_candidate))
        .collect::<Vec<_>>();
    let available_output_chars = max_briefing_chars as isize
        - output_char_count(&build_scribe_briefing(&with_empty)) as isize;
    if available_output_chars <= 0 {
        return None;
    }

    let output = slice_tail(
        str_field(candidate, "output"),
        available_output_chars as usize,
    );
    let mut trimmed_candidate = candidate.as_object().cloned().unwrap_or_default();
    trimmed_candidate.insert("output".to_string(), json!(output));
    trimmed_candidate.insert("outputChars".to_string(), json!(output_char_count(&output)));
    let trimmed_candidate = Value::Object(trimmed_candidate);
    let with_trimmed = existing
        .iter()
        .cloned()
        .chain(std::iter::once(trimmed_candidate.clone()))
        .collect::<Vec<_>>();
    if output_char_count(&build_scribe_briefing(&with_trimmed)) > max_briefing_chars {
        return None;
    }
    Some(trimmed_candidate)
}

pub fn scribe_readiness(input: &Value, scribe_id: Option<&str>) -> bool {
    let Some(scribe_id) = scribe_id else {
        return false;
    };
    let session = array_field(input, "sessions")
        .to_vec()
        .into_iter()
        .find(|session| str_field(session, "id") == scribe_id);
    let Some(session) = session else {
        return false;
    };
    let status = optional_str(&session, "status").unwrap_or("running");
    if matches!(status, "offline" | "graveyard" | "starting") {
        return false;
    }
    let metadata = input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let meta = metadata.get(scribe_id);
    let activity = meta
        .and_then(|meta| meta.get("derived"))
        .and_then(|derived| derived.get("activity"))
        .and_then(Value::as_str);
    if activity.is_some_and(|activity| activity != "idle" && activity != "done") {
        return false;
    }
    let attention = meta
        .and_then(|meta| meta.get("derived"))
        .and_then(|derived| derived.get("attention"))
        .and_then(Value::as_str)
        .unwrap_or("normal");
    attention == "normal"
}

pub fn find_scribe_session_id(input: &Value) -> Option<String> {
    input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .iter()
        .find_map(|(id, meta)| {
            meta.get("scribe")
                .and_then(Value::as_bool)
                .filter(|scribe| *scribe)
                .map(|_| id.clone())
        })
}

/// Node merged the metadata flags over the topology session before asking
/// `isProjectControlSession`; this rebuilds that probe and defers the decision
/// to the project's own predicate rather than growing another copy of it.
///
/// The `projectControl`-as-object form is kept from the recovered corpus: some
/// sessions carry `{ enabled: bool }` there rather than a bare boolean.
fn is_project_control_session(session: &Value, meta: Option<&Value>) -> bool {
    if session.get("projectControl").is_some_and(|value| {
        value.as_object().is_some_and(|object| {
            !object.is_empty() && object.get("enabled") != Some(&json!(false))
        })
    }) {
        return true;
    }
    let mut probe = session.as_object().cloned().unwrap_or_default();
    for flag in ["overseer", "scribe", "projectControl"] {
        if let Some(value) = meta.and_then(|meta| meta.get(flag)) {
            probe.insert(flag.to_owned(), value.clone());
        }
    }
    if let Some(team) = meta.and_then(|meta| meta.get("team")) {
        probe.entry("team".to_owned()).or_insert(team.clone());
    }
    crate::team_contract::is_project_control_session(Some(&Value::Object(probe)))
}

fn prune_seen_fingerprints(
    seen: &mut BTreeMap<String, Vec<String>>,
    active_session_ids: BTreeSet<&str>,
) {
    seen.retain(|session_id, _| active_session_ids.contains(session_id.as_str()));
    if seen.len() <= SCRIBE_WATCHER_MAX_SEEN_SESSIONS {
        return;
    }
    let overflow = seen.len() - SCRIBE_WATCHER_MAX_SEEN_SESSIONS;
    let stale = seen.keys().take(overflow).cloned().collect::<Vec<_>>();
    for session_id in stale {
        seen.remove(&session_id);
    }
}

pub fn bounded_output(output: &str, max_chars: usize) -> String {
    slice_tail(output, max_chars)
}

pub fn output_char_count(output: &str) -> usize {
    output.chars().count()
}

/// Keep the last `max_chars` CHARACTERS of a pane tail.
///
/// The measure is characters, not bytes: agent panes are full of box drawing
/// and emoji, and slicing those by byte offset lands mid-character and panics.
fn slice_tail(output: &str, max_chars: usize) -> String {
    let total = output.chars().count();
    if total <= max_chars {
        return output.to_string();
    }
    output.chars().skip(total - max_chars).collect()
}

pub fn fingerprint_for(session_id: &str, output: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(session_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(output.as_bytes());
    format!("{:x}", hasher.finalize())
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

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}
