use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const DEFAULT_LEASE_MS: i64 = 15_000;
const MIN_LEASE_MS: i64 = 1_000;
const MAX_LEASE_MS: i64 = 60_000;

pub fn parse_visual_client_kind(value: Option<&str>) -> &'static str {
    match value {
        Some("tui") => "tui",
        Some("web") => "web",
        Some("mobile") => "mobile",
        Some("expose") => "expose",
        Some("api") => "api",
        _ => "api",
    }
}

#[derive(Default)]
pub struct VisualClientLeaseRegistry {
    leases: BTreeMap<String, Value>,
}

impl VisualClientLeaseRegistry {
    pub fn touch(&mut self, input: &Value, now_ms: i64) -> Value {
        self.prune(now_ms);
        let kind = parse_visual_client_kind(input.get("kind").and_then(Value::as_str));
        let surface = sanitize_lease_part(input.get("surface").and_then(Value::as_str));
        let surface = if surface.is_empty() {
            "unknown".to_owned()
        } else {
            surface
        };
        let id = sanitize_lease_part(input.get("id").and_then(Value::as_str));
        let id = if id.is_empty() {
            format!("{kind}:{surface}:anonymous")
        } else {
            id
        };
        let key = format!("{kind}:{surface}:{id}");
        let current_started_at = self
            .leases
            .get(&key)
            .and_then(|lease| lease.get("startedAt"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let now_iso = iso_from_unix_millis(now_ms);
        let lease = json!({
            "id": id,
            "kind": kind,
            "surface": surface,
            "requestedPreview": input.get("requestedPreview").and_then(Value::as_bool).unwrap_or(false),
            "requestedChatPreview": input.get("requestedChatPreview").and_then(Value::as_bool).unwrap_or(false),
            "startedAt": current_started_at.unwrap_or_else(|| now_iso.clone()),
            "updatedAt": now_iso,
            "expiresAt": iso_from_unix_millis(now_ms + clamp_lease_ttl(input.get("ttlMs"))),
        });
        self.leases.insert(key, lease.clone());
        lease
    }

    pub fn snapshot(&mut self, now_ms: i64) -> Value {
        self.prune(now_ms);
        let mut active = self.leases.values().cloned().collect::<Vec<_>>();
        active.sort_by(|left, right| {
            let left_kind = left.get("kind").and_then(Value::as_str).unwrap_or_default();
            let right_kind = right
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            left_kind.cmp(right_kind).then_with(|| {
                let left_id = left.get("id").and_then(Value::as_str).unwrap_or_default();
                let right_id = right.get("id").and_then(Value::as_str).unwrap_or_default();
                left_id.cmp(right_id)
            })
        });
        let mut counts = Map::new();
        for kind in ["tui", "web", "mobile", "expose", "api"] {
            counts.insert(kind.to_owned(), Value::from(0));
        }
        let mut active_preview_clients = 0;
        for lease in &active {
            if let Some(kind) = lease.get("kind").and_then(Value::as_str) {
                counts.insert(
                    kind.to_owned(),
                    Value::from(counts.get(kind).and_then(Value::as_i64).unwrap_or(0) + 1),
                );
            }
            if lease
                .get("requestedPreview")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || lease
                    .get("requestedChatPreview")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                active_preview_clients += 1;
            }
        }
        json!({
            "active": active,
            "counts": counts,
            "activePreviewClients": active_preview_clients,
        })
    }

    pub fn has_active_preview_clients(&mut self, now_ms: i64) -> bool {
        self.prune(now_ms);
        self.leases.values().any(|lease| {
            lease
                .get("requestedPreview")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || lease
                    .get("requestedChatPreview")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
    }

    fn prune(&mut self, now_ms: i64) {
        self.leases.retain(|_, lease| {
            parse_iso_millis(
                lease
                    .get("expiresAt")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
            .is_some_and(|expires_at| expires_at > now_ms)
        });
    }
}

fn clamp_lease_ttl(value: Option<&Value>) -> i64 {
    let Some(value) = value else {
        return DEFAULT_LEASE_MS;
    };
    let raw = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(value) => parse_js_number(value),
        _ => None,
    };
    let Some(raw) = raw.filter(|value| value.is_finite()) else {
        return DEFAULT_LEASE_MS;
    };
    (raw.floor() as i64).clamp(MIN_LEASE_MS, MAX_LEASE_MS)
}

fn parse_js_number(value: &str) -> Option<f64> {
    value.trim().parse::<f64>().ok()
}

fn sanitize_lease_part(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '@' | '/' | '-') {
                ch
            } else {
                '-'
            }
        })
        .take(120)
        .collect()
}

pub fn parse_iso_millis(value: &str) -> Option<i64> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }
    let time = time.strip_suffix('Z')?;
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some() {
        return None;
    }
    let millis_len = millis.len();
    if millis_len > 3 {
        return None;
    }
    let mut millis = millis.parse::<i64>().ok()?;
    for _ in 0..(3 - millis_len) {
        millis *= 10;
    }
    Some(
        (((days_from_civil(year, month, day)? * 24 + hour) * 60 + minute) * 60 + second) * 1000
            + millis,
    )
}

fn iso_from_unix_millis(value: i64) -> String {
    let days = value.div_euclid(86_400_000);
    let mut millis_of_day = value.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hour = millis_of_day / 3_600_000;
    millis_of_day %= 3_600_000;
    let minute = millis_of_day / 60_000;
    millis_of_day %= 60_000;
    let second = millis_of_day / 1000;
    let millis = millis_of_day % 1000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + i64::from(month <= 2);
    (year, month, day)
}
