use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::{quarantine_corrupt_file, write_json_atomic};
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::parse_bounded_limit;
use super::router::ProjectServiceRequestContext;

pub const WORK_OUTLINE_MAX_ENTRIES: usize = 500;
pub const WORK_OUTLINE_DEFAULT_LIMIT: usize = 80;
pub const WORK_OUTLINE_MAX_LIMIT: usize = 200;
pub const WORK_OUTLINE_TITLE_MAX_CHARS: usize = 160;
pub const WORK_OUTLINE_SUMMARY_MAX_CHARS: usize = 1200;
pub const WORK_OUTLINE_TOPIC_KEY_MAX_CHARS: usize = 180;
pub const WORK_OUTLINE_MAX_SESSION_IDS: usize = 32;
pub const WORK_OUTLINE_SESSION_ID_MAX_CHARS: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkOutlineStatus {
    Active,
    Done,
    Superseded,
    Stale,
}

impl WorkOutlineStatus {
    fn parse(value: Option<&Value>) -> Self {
        match value.and_then(Value::as_str) {
            Some("done") => Self::Done,
            Some("superseded") => Self::Superseded,
            Some("stale") => Self::Stale,
            _ => Self::Active,
        }
    }

    fn parse_query(value: Option<&str>) -> Option<Self> {
        match value {
            Some("active") => Some(Self::Active),
            Some("done") => Some(Self::Done),
            Some("superseded") => Some(Self::Superseded),
            Some("stale") => Some(Self::Stale),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkOutlineSource {
    Agent,
    Scribe,
    System,
    Human,
}

impl WorkOutlineSource {
    fn parse(value: Option<&Value>) -> Self {
        match value.and_then(Value::as_str) {
            Some("scribe") => Self::Scribe,
            Some("system") => Self::System,
            Some("human") => Self::Human,
            _ => Self::Agent,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkOutlineEvidenceRange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkOutlineEntry {
    pub entry_id: String,
    pub topic_key: String,
    pub title: String,
    pub summary: String,
    pub status: WorkOutlineStatus,
    pub source: WorkOutlineSource,
    pub session_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<WorkOutlineEvidenceRange>,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkOutlineState {
    pub version: u8,
    pub entries: Vec<WorkOutlineEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkOutlineQuery {
    pub q: Option<String>,
    pub session_id: Option<String>,
    pub worktree_path: Option<String>,
    pub status: Option<WorkOutlineStatus>,
    pub limit: Option<usize>,
}

pub fn route_work_outline_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if method.eq_ignore_ascii_case("GET") && pathname == routes::work_outline::LIST {
        return Some(route_list(context, path));
    }
    if method.eq_ignore_ascii_case("POST") && pathname == routes::work_outline::UPDATE {
        return Some(route_update(context, body.unwrap_or(&Value::Null)));
    }
    None
}

pub fn work_outline_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("work-outline.json")
}

pub fn read_work_outline_state(project_state_dir: impl AsRef<Path>) -> WorkOutlineState {
    let path = work_outline_path(project_state_dir);
    if !path.exists() {
        return empty_state();
    }
    let Ok(contents) = fs::read_to_string(&path) else {
        quarantine_corrupt_file(path);
        return empty_state();
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        quarantine_corrupt_file(path);
        return empty_state();
    };
    normalize_state(&value)
}

pub fn write_work_outline_state(
    project_state_dir: impl AsRef<Path>,
    state: &WorkOutlineState,
) -> std::io::Result<()> {
    let state = WorkOutlineState {
        version: 1,
        entries: bound_entries(state.entries.clone()),
    };
    write_json_atomic(work_outline_path(project_state_dir), &state)
}

pub fn update_work_outline_entry(
    project_state_dir: impl AsRef<Path>,
    input: &Value,
    now: Option<&str>,
) -> Result<WorkOutlineEntry, String> {
    let now = now.map(str::to_owned).unwrap_or_else(now_iso);
    let topic_key = normalize_topic_key(input);
    let title = normalize_optional_text(input.get("title"), WORK_OUTLINE_TITLE_MAX_CHARS);
    let summary = normalize_optional_text(input.get("summary"), WORK_OUTLINE_SUMMARY_MAX_CHARS);
    if topic_key.is_empty() {
        return Err("topicKey or title is required".into());
    }
    let Some(title) = title else {
        return Err("title is required".into());
    };
    let Some(summary) = summary else {
        return Err("summary is required".into());
    };

    let project_state_dir = project_state_dir.as_ref();
    let mut state = read_work_outline_state(project_state_dir);
    let worktree_path = normalize_optional_text(input.get("worktreePath"), 1000);
    let evidence = normalize_evidence(input.get("evidence"));
    let requested_entry_id = normalize_optional_text(input.get("entryId"), 80);
    let existing_index = state.entries.iter().position(|entry| {
        if let Some(requested) = &requested_entry_id {
            entry.entry_id == *requested
        } else {
            entry_identity(&entry.topic_key, entry.worktree_path.as_deref())
                == entry_identity(&topic_key, worktree_path.as_deref())
        }
    });
    let existing = existing_index.and_then(|index| state.entries.get(index).cloned());
    let mut session_input = Map::new();
    session_input.insert(
        "sessionIds".into(),
        Value::Array(
            existing
                .as_ref()
                .map(|entry| {
                    entry
                        .session_ids
                        .iter()
                        .map(|id| Value::String(id.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        ),
    );
    for id in normalize_session_ids(input) {
        session_input.entry("sessionIds").and_modify(|value| {
            if let Value::Array(ids) = value {
                ids.push(Value::String(id));
            }
        });
    }
    let session_ids = normalize_session_ids(&Value::Object(session_input));
    let entry = WorkOutlineEntry {
        entry_id: existing
            .as_ref()
            .map(|entry| entry.entry_id.clone())
            .or(requested_entry_id)
            .unwrap_or_else(|| generated_entry_id(&topic_key, worktree_path.as_deref())),
        topic_key,
        title,
        summary,
        status: WorkOutlineStatus::parse(input.get("status")),
        source: WorkOutlineSource::parse(input.get("source")),
        session_ids,
        worktree_path,
        evidence: evidence.or_else(|| existing.as_ref().and_then(|entry| entry.evidence.clone())),
        created_at: existing
            .as_ref()
            .map(|entry| entry.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now.clone(),
        last_seen_at: now,
    };
    if let Some(index) = existing_index {
        state.entries[index] = entry.clone();
    } else {
        state.entries.push(entry.clone());
    }
    write_work_outline_state(project_state_dir, &state).map_err(|error| error.to_string())?;
    Ok(entry)
}

pub fn list_work_outline_entries(
    project_state_dir: impl AsRef<Path>,
    query: WorkOutlineQuery,
) -> Vec<WorkOutlineEntry> {
    let needle = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(str::to_lowercase);
    let limit = query
        .limit
        .unwrap_or(WORK_OUTLINE_DEFAULT_LIMIT)
        .clamp(1, WORK_OUTLINE_MAX_LIMIT);
    read_work_outline_state(project_state_dir)
        .entries
        .into_iter()
        .filter(|entry| {
            if let Some(status) = query.status
                && entry.status != status
            {
                return false;
            }
            if let Some(session_id) = query.session_id.as_deref()
                && !entry.session_ids.iter().any(|id| id == session_id)
            {
                return false;
            }
            if let Some(worktree_path) = query.worktree_path.as_deref()
                && entry.worktree_path.as_deref() != Some(worktree_path)
            {
                return false;
            }
            let Some(needle) = needle.as_deref() else {
                return true;
            };
            let mut values = vec![
                entry.topic_key.as_str(),
                entry.title.as_str(),
                entry.summary.as_str(),
            ];
            if let Some(worktree_path) = entry.worktree_path.as_deref() {
                values.push(worktree_path);
            }
            values.extend(entry.session_ids.iter().map(String::as_str));
            values
                .into_iter()
                .any(|value| value.to_lowercase().contains(needle))
        })
        .take(limit)
        .collect()
}

pub fn get_work_outline_entry(
    project_state_dir: impl AsRef<Path>,
    entry_id: &str,
) -> Option<WorkOutlineEntry> {
    read_work_outline_state(project_state_dir)
        .entries
        .into_iter()
        .find(|entry| entry.entry_id == entry_id)
}

fn route_list(
    context: &ProjectServiceRequestContext,
    path: &str,
) -> ProjectServiceDispatchResponse {
    let query_params = query_params(path);
    let parsed_limit = parse_bounded_limit(
        query_params.get("limit").map(String::as_str),
        "limit",
        WORK_OUTLINE_DEFAULT_LIMIT as i64,
        WORK_OUTLINE_MAX_LIMIT as i64,
    );
    let limit = match parsed_limit {
        Ok(limit) => limit as usize,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    if let Some(entry_id) = query_params
        .get("entryId")
        .map(String::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return json_response(
            200,
            json!({ "ok": true, "entry": get_work_outline_entry(context.project_state_dir(), entry_id) }),
        );
    }
    let entries = list_work_outline_entries(
        context.project_state_dir(),
        WorkOutlineQuery {
            q: trimmed_query(&query_params, "q"),
            session_id: trimmed_query(&query_params, "sessionId"),
            worktree_path: trimmed_query(&query_params, "worktreePath"),
            status: WorkOutlineStatus::parse_query(
                trimmed_query(&query_params, "status").as_deref(),
            ),
            limit: Some(limit),
        },
    );
    json_response(200, json!({ "ok": true, "entries": entries }))
}

fn route_update(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    match update_work_outline_entry(context.project_state_dir(), body, None) {
        Ok(entry) => json_response(200, json!({ "ok": true, "entry": entry })),
        Err(error) => json_response(400, json!({ "ok": false, "error": error })),
    }
}

fn empty_state() -> WorkOutlineState {
    WorkOutlineState {
        version: 1,
        entries: Vec::new(),
    }
}

fn normalize_state(value: &Value) -> WorkOutlineState {
    let Some(entries) = value.get("entries").and_then(Value::as_array) else {
        return empty_state();
    };
    let entries = entries
        .iter()
        .filter_map(normalize_entry)
        .collect::<Vec<_>>();
    WorkOutlineState {
        version: 1,
        entries: bound_entries(entries),
    }
}

fn normalize_entry(value: &Value) -> Option<WorkOutlineEntry> {
    let topic_key =
        normalize_optional_text(value.get("topicKey"), WORK_OUTLINE_TOPIC_KEY_MAX_CHARS)?;
    let title = normalize_optional_text(value.get("title"), WORK_OUTLINE_TITLE_MAX_CHARS)?;
    let summary = normalize_optional_text(value.get("summary"), WORK_OUTLINE_SUMMARY_MAX_CHARS)?;
    let worktree_path = normalize_optional_text(value.get("worktreePath"), 1000);
    let evidence = normalize_evidence(value.get("evidence"));
    let created_at = normalize_optional_text(value.get("createdAt"), 40).unwrap_or_else(epoch_iso);
    let updated_at =
        normalize_optional_text(value.get("updatedAt"), 40).unwrap_or_else(|| created_at.clone());
    let last_seen_at =
        normalize_optional_text(value.get("lastSeenAt"), 40).unwrap_or_else(|| updated_at.clone());
    let topic_key = topic_key.to_lowercase();
    Some(WorkOutlineEntry {
        entry_id: normalize_optional_text(value.get("entryId"), 80)
            .unwrap_or_else(|| generated_entry_id(&topic_key, worktree_path.as_deref())),
        topic_key,
        title,
        summary,
        status: WorkOutlineStatus::parse(value.get("status")),
        source: WorkOutlineSource::parse(value.get("source")),
        session_ids: normalize_session_ids(value),
        worktree_path,
        evidence,
        created_at,
        updated_at,
        last_seen_at,
    })
}

fn bound_entries(entries: Vec<WorkOutlineEntry>) -> Vec<WorkOutlineEntry> {
    let mut entries = entries;
    entries.sort_by(|left, right| {
        parse_sort_millis(&right.updated_at)
            .cmp(&parse_sort_millis(&left.updated_at))
            .then_with(|| left.entry_id.cmp(&right.entry_id))
    });
    entries.truncate(WORK_OUTLINE_MAX_ENTRIES);
    entries
}

fn normalize_topic_key(input: &Value) -> String {
    if let Some(topic_key) =
        normalize_optional_text(input.get("topicKey"), WORK_OUTLINE_TOPIC_KEY_MAX_CHARS)
    {
        return topic_key.to_lowercase();
    }
    normalize_optional_text(input.get("title"), WORK_OUTLINE_TOPIC_KEY_MAX_CHARS)
        .unwrap_or_default()
        .to_lowercase()
}

fn normalize_optional_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let value = value?.as_str()?;
    let normalized = truncate_text(value, max_chars);
    (!normalized.is_empty()).then_some(normalized)
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= max_chars {
        return trimmed;
    }
    let mut truncated = trimmed
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    while truncated.ends_with(char::is_whitespace) {
        truncated.pop();
    }
    truncated.push_str("...");
    truncated
}

fn normalize_session_ids(input: &Value) -> Vec<String> {
    let mut ids = BTreeSet::new();
    if let Some(session_id) = input.get("sessionId").and_then(Value::as_str)
        && !session_id.trim().is_empty()
    {
        ids.insert(truncate_text(session_id, WORK_OUTLINE_SESSION_ID_MAX_CHARS));
    }
    if let Some(session_ids) = input.get("sessionIds").and_then(Value::as_array) {
        for id in session_ids {
            let Some(id) = id.as_str() else {
                continue;
            };
            if id.trim().is_empty() {
                continue;
            }
            ids.insert(truncate_text(id, WORK_OUTLINE_SESSION_ID_MAX_CHARS));
        }
    }
    ids.into_iter().take(WORK_OUTLINE_MAX_SESSION_IDS).collect()
}

fn normalize_evidence(value: Option<&Value>) -> Option<WorkOutlineEvidenceRange> {
    let value = value?.as_object()?;
    let source = normalize_optional_text(value.get("source"), 120);
    let captured_at = normalize_optional_text(value.get("capturedAt"), 40);
    let start_line = normalize_line(value.get("startLine"));
    let end_line = normalize_line(value.get("endLine"));
    if source.is_none() && captured_at.is_none() && start_line.is_none() && end_line.is_none() {
        return None;
    }
    Some(WorkOutlineEvidenceRange {
        source,
        start_line,
        end_line,
        captured_at,
    })
}

fn normalize_line(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn entry_identity(topic_key: &str, worktree_path: Option<&str>) -> String {
    format!("{topic_key}\0{}", worktree_path.unwrap_or(""))
}

fn generated_entry_id(topic_key: &str, worktree_path: Option<&str>) -> String {
    let mut hasher = Sha1::new();
    hasher.update(entry_identity(topic_key, worktree_path).as_bytes());
    let digest = hasher.finalize();
    format!("outline-{}", hex_prefix(&digest, 12))
}

fn hex_prefix(bytes: &[u8], chars: usize) -> String {
    let mut out = String::with_capacity(chars);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
        if out.len() >= chars {
            out.truncate(chars);
            return out;
        }
    }
    out
}

fn trimmed_query(params: &BTreeMap<String, String>, key: &str) -> Option<String> {
    params
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn query_params(path: &str) -> BTreeMap<String, String> {
    let Some((_, query)) = path.split_once('?') else {
        return BTreeMap::new();
    };
    let mut params = BTreeMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode_form(key);
        if key.is_empty() {
            continue;
        }
        params.insert(key, percent_decode_form(value));
    }
    params
}

fn percent_decode_form(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'+' => {
                bytes.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < raw.len() => {
                let hex = std::str::from_utf8(&raw[index + 1..index + 3]).unwrap_or("");
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    bytes.push(value);
                    index += 3;
                } else {
                    bytes.push(raw[index]);
                    index += 1;
                }
            }
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn parse_sort_millis(value: &str) -> i128 {
    parse_iso_millis(value).unwrap_or(0) as i128
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = time.strip_suffix('Z')?;
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 || millis.len() > 3 {
        return None;
    }
    let mut millis = millis.parse::<u128>().ok()?;
    for _ in 0..(3 - value
        .split_once('.')
        .map_or(0, |(_, rest)| rest.trim_end_matches('Z').len()))
    {
        millis *= 10;
    }
    let days = days_from_civil(year, month, day)?;
    Some(
        (((days as u128 * 24 + hour as u128) * 60 + minute as u128) * 60 + second as u128) * 1000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    (days >= 0).then_some(days)
}

fn now_iso() -> String {
    format_offset_date_time(time::OffsetDateTime::now_utc())
}

fn epoch_iso() -> String {
    "1970-01-01T00:00:00.000Z".into()
}

fn format_offset_date_time(now: time::OffsetDateTime) -> String {
    let millis = now.millisecond();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        millis
    )
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
