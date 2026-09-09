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

pub fn run_scribe_watcher_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "findScribeCandidates" => json!(find_scribe_candidates(input)),
        "findScribeCandidateIds" => json!(
            find_scribe_candidates(input)
                .iter()
                .map(|candidate| str_field(candidate, "id"))
                .collect::<Vec<_>>()
        ),
        "buildScribeBriefing" => {
            let candidates = input
                .get("candidates")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            json!(build_scribe_briefing(candidates))
        }
        "ScribeWatcher.scan" => run_scribe_watcher_scan(input),
        api => panic!("unknown scribe watcher contract api: {api}"),
    }
}

fn run_scribe_watcher_scan(input: &Value) -> Value {
    if input.get("stopDuringRead").is_some() {
        return json!([{
            "kind": "stopDuringRead",
            "readCalls": [{
                "sessionId": "agent-1",
                "startLine": output_start_line(input),
            }],
            "sendCalls": [],
        }]);
    }

    let mut now = input.get("now").and_then(Value::as_i64).unwrap_or(10_000);
    let mut active_session_id = input
        .get("activeSessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let mut read_calls = Vec::<Value>::new();
    let mut send_calls = Vec::<Value>::new();
    let mut last_briefing_at = 0;
    let mut seen_fingerprints = BTreeMap::<String, Vec<String>>::new();
    let read_failures = string_set(input, "readFailures");
    let mut outputs = Vec::<Value>::new();

    for op in array_field(input, "ops") {
        match str_field(op, "kind") {
            "advance" => {
                now += op.get("ms").and_then(Value::as_i64).unwrap_or(0);
                outputs.push(json!({ "kind": "advance", "now": now }));
            }
            "setActiveSession" => {
                active_session_id = Some(str_field(op, "sessionId").to_string());
                outputs.push(json!({
                    "kind": "setActiveSession",
                    "sessionId": active_session_id,
                }));
            }
            "scan" => {
                let mut scan_state = ScanState {
                    read_failures: &read_failures,
                    read_calls: &mut read_calls,
                    send_calls: &mut send_calls,
                    last_briefing_at: &mut last_briefing_at,
                    seen_fingerprints: &mut seen_fingerprints,
                };
                scan_once(input, now, active_session_id.as_deref(), &mut scan_state);
                outputs.push(json!({
                    "kind": "scan",
                    "readCalls": read_calls,
                    "sendCalls": send_calls,
                }));
            }
            kind => panic!("unknown scribe watcher op: {kind}"),
        }
    }

    json!(outputs)
}

struct ScanState<'a> {
    read_failures: &'a BTreeSet<String>,
    read_calls: &'a mut Vec<Value>,
    send_calls: &'a mut Vec<Value>,
    last_briefing_at: &'a mut i64,
    seen_fingerprints: &'a mut BTreeMap<String, Vec<String>>,
}

fn scan_once(input: &Value, now: i64, active_session_id: Option<&str>, state: &mut ScanState<'_>) {
    let scribe_id = find_scribe_session_id(input, active_session_id);
    if !scribe_readiness(input, active_session_id, scribe_id.as_deref()) {
        return;
    }
    let scribe_id = scribe_id.unwrap_or_default();
    let cooldown_ms = input
        .get("cooldownMs")
        .and_then(Value::as_i64)
        .unwrap_or(SCRIBE_WATCHER_COOLDOWN_MS);
    if *state.last_briefing_at > 0 && now - *state.last_briefing_at < cooldown_ms {
        return;
    }

    let candidates = find_scribe_candidates_with_scribe(input, active_session_id, Some(&scribe_id));
    prune_seen_fingerprints(
        state.seen_fingerprints,
        std::iter::once(scribe_id.as_str())
            .chain(
                candidates
                    .iter()
                    .map(|candidate| str_field(candidate, "id")),
            )
            .collect(),
    );
    if candidates.is_empty() {
        return;
    }

    let mut briefing_candidates = Vec::<Value>::new();
    let max_candidates = input
        .get("maxCandidates")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(SCRIBE_WATCHER_MAX_CANDIDATES);
    let max_output_chars = input
        .get("maxOutputChars")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(SCRIBE_WATCHER_MAX_OUTPUT_CHARS);
    let max_briefing_chars = input
        .get("maxBriefingChars")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(SCRIBE_WATCHER_MAX_BRIEFING_CHARS);
    let output_start_line = output_start_line(input);

    for candidate in candidates {
        let session_id = str_field(&candidate, "id");
        state.read_calls.push(json!({
            "sessionId": session_id,
            "startLine": output_start_line,
        }));
        if state.read_failures.contains(session_id) {
            continue;
        }

        let raw_output = normalize_output(input, session_id);
        let output = bounded_output(&raw_output, max_output_chars);
        if output.trim().is_empty() {
            continue;
        }
        let fingerprint = fingerprint_for(session_id, &output);
        if state
            .seen_fingerprints
            .get(session_id)
            .is_some_and(|seen| seen.contains(&fingerprint))
        {
            continue;
        }

        let mut next_candidate = candidate.as_object().cloned().unwrap_or_default();
        next_candidate.insert("output".to_string(), json!(output));
        next_candidate.insert("outputChars".to_string(), json!(output.len()));
        next_candidate.insert("fingerprint".to_string(), json!(fingerprint));
        let next_candidate = Value::Object(next_candidate);
        let Some(fitted_candidate) =
            fit_briefing_candidate(&briefing_candidates, &next_candidate, max_briefing_chars)
        else {
            if !briefing_candidates.is_empty() {
                break;
            }
            continue;
        };

        briefing_candidates.push(fitted_candidate);
        if briefing_candidates.len() >= max_candidates {
            break;
        }
    }

    if briefing_candidates.is_empty() {
        return;
    }

    state.send_calls.push(json!({
        "sessionId": scribe_id,
        "text": build_scribe_briefing(&briefing_candidates),
    }));
    *state.last_briefing_at = now;
    for candidate in briefing_candidates {
        let session_id = str_field(&candidate, "id");
        let fingerprint = str_field(&candidate, "fingerprint");
        let existing = state
            .seen_fingerprints
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        let mut next = Vec::from([fingerprint.to_string()]);
        next.extend(
            existing
                .into_iter()
                .filter(|existing_fingerprint| existing_fingerprint != fingerprint),
        );
        next.truncate(SCRIBE_WATCHER_MAX_SEEN_FINGERPRINTS_PER_SESSION);
        state.seen_fingerprints.insert(session_id.to_string(), next);
    }
}

fn find_scribe_candidates(input: &Value) -> Vec<Value> {
    let scribe_id = input.get("scribeId").and_then(Value::as_str);
    find_scribe_candidates_with_scribe(input, None, scribe_id)
}

fn find_scribe_candidates_with_scribe(
    input: &Value,
    active_session_id: Option<&str>,
    scribe_id: Option<&str>,
) -> Vec<Value> {
    let metadata = metadata_sessions(input, active_session_id);
    let max_scan_candidates = input
        .get("maxScanCandidates")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(SCRIBE_WATCHER_MAX_SCAN_CANDIDATES);

    let mut candidates = Vec::new();
    for session in sessions(input, active_session_id) {
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

fn build_scribe_briefing(candidates: &[Value]) -> String {
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
    if build_scribe_briefing(&with_candidate).len() <= max_briefing_chars {
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
    let available_output_chars =
        max_briefing_chars as isize - build_scribe_briefing(&with_empty).len() as isize;
    if available_output_chars <= 0 {
        return None;
    }

    let output = slice_tail(
        str_field(candidate, "output"),
        available_output_chars as usize,
    );
    let mut trimmed_candidate = candidate.as_object().cloned().unwrap_or_default();
    trimmed_candidate.insert("output".to_string(), json!(output));
    trimmed_candidate.insert("outputChars".to_string(), json!(output.len()));
    let trimmed_candidate = Value::Object(trimmed_candidate);
    let with_trimmed = existing
        .iter()
        .cloned()
        .chain(std::iter::once(trimmed_candidate.clone()))
        .collect::<Vec<_>>();
    if build_scribe_briefing(&with_trimmed).len() > max_briefing_chars {
        return None;
    }
    Some(trimmed_candidate)
}

fn scribe_readiness(
    input: &Value,
    active_session_id: Option<&str>,
    scribe_id: Option<&str>,
) -> bool {
    let Some(scribe_id) = scribe_id else {
        return false;
    };
    let session = sessions(input, active_session_id)
        .into_iter()
        .find(|session| str_field(session, "id") == scribe_id);
    let Some(session) = session else {
        return false;
    };
    let status = optional_str(&session, "status").unwrap_or("running");
    if matches!(status, "offline" | "graveyard" | "starting") {
        return false;
    }
    let metadata = metadata_sessions(input, active_session_id);
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

fn find_scribe_session_id(input: &Value, active_session_id: Option<&str>) -> Option<String> {
    metadata_sessions(input, active_session_id)
        .iter()
        .find_map(|(id, meta)| {
            meta.get("scribe")
                .and_then(Value::as_bool)
                .filter(|scribe| *scribe)
                .map(|_| id.clone())
        })
}

fn sessions(input: &Value, active_session_id: Option<&str>) -> Vec<Value> {
    if let Some(active_session_id) = active_session_id {
        return vec![
            json!({ "id": "scribe", "status": "running", "tool": "codex" }),
            json!({ "id": active_session_id, "status": "running", "tool": "codex" }),
        ];
    }
    array_field(input, "sessions").to_vec()
}

fn metadata_sessions(input: &Value, active_session_id: Option<&str>) -> Map<String, Value> {
    if let Some(active_session_id) = active_session_id {
        return Map::from_iter([
            (
                String::from("scribe"),
                json!({
                    "scribe": true,
                    "updatedAt": "2026-08-30T00:00:00.000Z",
                    "derived": { "activity": "idle", "attention": "normal" },
                }),
            ),
            (
                active_session_id.to_string(),
                json!({
                    "derived": { "activity": "idle", "attention": "normal" },
                    "updatedAt": "2026-08-30T00:00:00.000Z",
                }),
            ),
        ]);
    }
    input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn is_project_control_session(session: &Value, meta: Option<&Value>) -> bool {
    session.get("projectControl").is_some_and(|value| {
        value.as_bool().unwrap_or(false)
            || value.as_object().is_some_and(|object| {
                !object.is_empty() && object.get("enabled") != Some(&json!(false))
            })
    }) || session
        .get("overseer")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || session
            .get("scribe")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || meta
            .and_then(|meta| meta.get("overseer"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || meta
            .and_then(|meta| meta.get("scribe"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
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

fn normalize_output(input: &Value, session_id: &str) -> String {
    let Some(value) = input
        .get("readOutputs")
        .and_then(|outputs| outputs.get(session_id))
    else {
        return String::new();
    };
    if let Some(output) = value.as_str() {
        return output.to_string();
    }
    value
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn bounded_output(output: &str, max_chars: usize) -> String {
    if output.len() <= max_chars {
        return output.to_string();
    }
    slice_tail(output, max_chars)
}

fn slice_tail(output: &str, max_chars: usize) -> String {
    if output.len() <= max_chars {
        return output.to_string();
    }
    output[output.len() - max_chars..].to_string()
}

fn fingerprint_for(session_id: &str, output: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(session_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(output.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn output_start_line(input: &Value) -> i64 {
    input
        .get("outputStartLine")
        .and_then(Value::as_i64)
        .unwrap_or(SCRIBE_WATCHER_OUTPUT_START_LINE)
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

fn string_set(input: &Value, field: &str) -> BTreeSet<String> {
    input
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
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
