use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::write_text_atomic_fast;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

const LAST_USED_VERSION: u8 = 1;
const MAX_RECENT_IDS: usize = 64;

pub fn route_usage_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if !method.eq_ignore_ascii_case("POST") || pathname != routes::runtime::USAGE_MARK {
        return None;
    }
    let body = body.unwrap_or(&Value::Null);
    let item_id = trimmed_string(body.get("itemId")).unwrap_or_default();
    if item_id.is_empty() {
        return Some(ProjectServiceDispatchResponse {
            status: 400,
            body: json!({ "ok": false, "error": "itemId is required" }),
        });
    }
    let state = mark_last_used(
        context.project_state_dir(),
        MarkLastUsedOptions {
            item_id: item_id.clone(),
            client_session: trimmed_string(body.get("clientSession")),
            used_at: trimmed_string(body.get("usedAt")),
        },
    );
    Some(ProjectServiceDispatchResponse {
        status: 200,
        body: json!({
            "ok": true,
            "itemId": item_id,
            "lastUsedAt": state.get("items").and_then(|items| items.get(&item_id)).and_then(|item| item.get("lastUsedAt")).cloned().unwrap_or(Value::Null),
        }),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkLastUsedOptions {
    pub item_id: String,
    pub client_session: Option<String>,
    pub used_at: Option<String>,
}

pub fn last_used_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("last-used.json")
}

pub fn load_last_used_state(project_state_dir: impl AsRef<Path>) -> Value {
    let path = last_used_path(project_state_dir);
    if !path.exists() {
        return empty_state();
    }
    let Ok(contents) = fs::read_to_string(path) else {
        return empty_state();
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return empty_state();
    };
    normalize_last_used_state(&value)
}

pub fn mark_last_used(project_state_dir: impl AsRef<Path>, options: MarkLastUsedOptions) -> Value {
    let item_id = options.item_id.trim();
    if item_id.is_empty() {
        return load_last_used_state(project_state_dir);
    }
    let requested_used_at = options
        .used_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let used_at = requested_used_at
        .filter(|value| parse_recency_timestamp(value).is_some())
        .map(str::to_owned)
        .unwrap_or_else(now_iso);
    let mut state = object_state(load_last_used_state(&project_state_dir));

    let existing_used_at = state
        .get("items")
        .and_then(|items| items.get(item_id))
        .and_then(|item| item.get("lastUsedAt"))
        .and_then(Value::as_str);
    if existing_used_at.is_none_or(|existing| recency_ms(&used_at) >= recency_ms(existing)) {
        items_mut(&mut state).insert(item_id.to_owned(), json!({ "lastUsedAt": used_at }));
    }
    let item_snapshot = state
        .get("items")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let project_recent_ids = sort_recent_ids(
        push_recent_id(string_array(state.get("projectRecentIds")), item_id),
        &item_snapshot,
    );
    state.insert(
        "projectRecentIds".into(),
        Value::Array(
            project_recent_ids
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );

    if let Some(client_session) = options
        .client_session
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let existing = state
            .get("clients")
            .and_then(|clients| clients.get(client_session))
            .cloned()
            .unwrap_or_else(|| {
                json!({
                    "recentIds": [],
                    "items": {},
                    "updatedAt": used_at,
                })
            });
        let existing_object = existing.as_object().cloned().unwrap_or_default();
        let mut client_items = existing_object
            .get("items")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let existing_client_used_at = client_items
            .get(item_id)
            .and_then(|item| item.get("lastUsedAt"))
            .and_then(Value::as_str);
        if existing_client_used_at
            .is_none_or(|existing| recency_ms(&used_at) >= recency_ms(existing))
        {
            client_items.insert(item_id.to_owned(), json!({ "lastUsedAt": used_at }));
        }
        let existing_updated_at = existing_object
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("");
        let updated_at = if recency_ms(&used_at) >= recency_ms(existing_updated_at) {
            used_at.clone()
        } else {
            existing_updated_at.to_owned()
        };
        let recent_ids = sort_recent_ids(
            push_recent_id(string_array(existing_object.get("recentIds")), item_id),
            &client_items,
        );
        clients_mut(&mut state).insert(
            client_session.to_owned(),
            json!({
                "recentIds": recent_ids,
                "items": pick_recent_items(&recent_ids, &client_items),
                "updatedAt": updated_at,
            }),
        );
    }

    let existing_updated_at = state.get("updatedAt").and_then(Value::as_str);
    if existing_updated_at.is_none_or(|existing| recency_ms(&used_at) >= recency_ms(existing)) {
        state.insert("updatedAt".into(), Value::String(used_at));
    }
    let state_value = Value::Object(state);
    persist_last_used_state(project_state_dir, &state_value);
    state_value
}

fn persist_last_used_state(project_state_dir: impl AsRef<Path>, state: &Value) {
    let mut text = serde_json::to_string_pretty(state).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    let _ = write_text_atomic_fast(last_used_path(project_state_dir), text);
}

fn normalize_last_used_state(state: &Value) -> Value {
    let items = normalize_items(state.get("items"));
    let mut clients = Map::new();
    if let Some(raw_clients) = state.get("clients").and_then(Value::as_object) {
        for (client_session, value) in raw_clients {
            let recent_ids = string_array(value.get("recentIds"))
                .into_iter()
                .take(MAX_RECENT_IDS)
                .collect::<Vec<_>>();
            let updated_at = value
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            clients.insert(
                client_session.clone(),
                json!({
                    "recentIds": recent_ids,
                    "items": normalize_client_items(&recent_ids, value.get("items"), &items, &updated_at),
                    "updatedAt": updated_at,
                }),
            );
        }
    }
    let mut normalized = Map::new();
    normalized.insert("version".into(), Value::from(LAST_USED_VERSION));
    normalized.insert("items".into(), Value::Object(items));
    normalized.insert("clients".into(), Value::Object(clients));
    normalized.insert(
        "projectRecentIds".into(),
        Value::Array(
            string_array(state.get("projectRecentIds"))
                .into_iter()
                .take(MAX_RECENT_IDS)
                .map(Value::String)
                .collect(),
        ),
    );
    if let Some(updated_at) = state.get("updatedAt").and_then(Value::as_str) {
        normalized.insert("updatedAt".into(), Value::String(updated_at.to_owned()));
    }
    Value::Object(normalized)
}

fn normalize_items(items: Option<&Value>) -> Map<String, Value> {
    let mut normalized = Map::new();
    let Some(items) = items.and_then(Value::as_object) else {
        return normalized;
    };
    for (item_id, value) in items {
        if let Some(last_used_at) = value.get("lastUsedAt").and_then(Value::as_str) {
            normalized.insert(item_id.clone(), json!({ "lastUsedAt": last_used_at }));
        }
    }
    normalized
}

fn normalize_client_items(
    recent_ids: &[String],
    items: Option<&Value>,
    project_items: &Map<String, Value>,
    updated_at: &str,
) -> Value {
    let normalized_items = normalize_items(items);
    if !normalized_items.is_empty() {
        return Value::Object(pick_recent_items(recent_ids, &normalized_items));
    }
    let base_ms = recency_ms(updated_at).max(
        recent_ids
            .iter()
            .map(|id| {
                project_items
                    .get(id)
                    .and_then(|item| item.get("lastUsedAt"))
                    .and_then(Value::as_str)
                    .map(recency_ms)
                    .unwrap_or_default()
            })
            .max()
            .unwrap_or_default(),
    );
    let mut seeded = Map::new();
    for (index, id) in recent_ids.iter().enumerate() {
        let last_used_at = if base_ms > 0 {
            iso_from_millis(base_ms.saturating_sub(index as u128))
        } else {
            project_items
                .get(id)
                .and_then(|item| item.get("lastUsedAt"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        seeded.insert(id.clone(), json!({ "lastUsedAt": last_used_at }));
    }
    Value::Object(seeded)
}

fn push_recent_id(ids: Vec<String>, item_id: &str) -> Vec<String> {
    let mut next = vec![item_id.to_owned()];
    next.extend(ids.into_iter().filter(|entry| entry != item_id));
    next.truncate(MAX_RECENT_IDS);
    next
}

fn sort_recent_ids(ids: Vec<String>, items: &Map<String, Value>) -> Vec<String> {
    let original = ids.clone();
    let mut sorted = ids;
    sorted.sort_by(|left, right| {
        let diff = recency_ms(item_last_used_at(items, right))
            .cmp(&recency_ms(item_last_used_at(items, left)));
        if diff != std::cmp::Ordering::Equal {
            return diff;
        }
        original
            .iter()
            .position(|id| id == left)
            .unwrap_or(usize::MAX)
            .cmp(
                &original
                    .iter()
                    .position(|id| id == right)
                    .unwrap_or(usize::MAX),
            )
    });
    sorted.truncate(MAX_RECENT_IDS);
    sorted
}

fn pick_recent_items(ids: &[String], items: &Map<String, Value>) -> Map<String, Value> {
    let mut picked = Map::new();
    for id in ids {
        if let Some(item) = items.get(id) {
            picked.insert(id.clone(), item.clone());
        }
    }
    picked
}

fn item_last_used_at<'a>(items: &'a Map<String, Value>, id: &str) -> &'a str {
    items
        .get(id)
        .and_then(|item| item.get("lastUsedAt"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn object_state(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_else(|| {
        empty_state()
            .as_object()
            .cloned()
            .expect("empty state object")
    })
}

fn empty_state() -> Value {
    json!({
        "version": LAST_USED_VERSION,
        "items": {},
        "clients": {},
        "projectRecentIds": [],
    })
}

fn items_mut(state: &mut Map<String, Value>) -> &mut Map<String, Value> {
    state
        .get_mut("items")
        .and_then(Value::as_object_mut)
        .expect("last-used items object")
}

fn clients_mut(state: &mut Map<String, Value>) -> &mut Map<String, Value> {
    state
        .get_mut("clients")
        .and_then(Value::as_object_mut)
        .expect("last-used clients object")
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    value
                        .as_str()
                        .filter(|text| !text.is_empty())
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn recency_ms(value: &str) -> u128 {
    parse_recency_timestamp(value).unwrap_or_default()
}

fn parse_recency_timestamp(value: &str) -> Option<u128> {
    parse_iso_millis(value)
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

fn iso_from_millis(ms: u128) -> String {
    let seconds = (ms / 1000) as i64;
    let millis = (ms % 1000) as u16;
    let datetime = time::OffsetDateTime::from_unix_timestamp(seconds)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        datetime.year(),
        u8::from(datetime.month()),
        datetime.day(),
        datetime.hour(),
        datetime.minute(),
        datetime.second(),
        millis
    )
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
