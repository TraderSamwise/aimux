use std::cmp::Ordering;
use std::collections::BTreeSet;

use serde_json::{Value, json};

pub fn inbox_cleanup_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "buildInboxCleanupPlan" => build_inbox_cleanup_plan(&case["input"]),
        "runInboxCleanup" => run_inbox_cleanup_contract(&case["input"]),
        _ => Value::Null,
    }
}

pub fn build_inbox_cleanup_plan(input: &Value) -> Value {
    let now = string_field(input, "now").unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
    let config = input.get("config").unwrap_or(&Value::Null);
    let cleanup_enabled = config
        .get("cleanupEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let retention_days = non_negative_usize(config.get("retentionDays"), 14);
    let max_size = non_negative_usize(config.get("maxSize"), 10);
    let cutoff = subtract_days_iso(&now, retention_days).unwrap_or_else(|| now.clone());
    let notifications = input
        .get("notifications")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let protected_ids = input
        .get("protectedIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<BTreeSet<_>>()
        });

    if !cleanup_enabled {
        return json!({
            "enabled": false,
            "now": now,
            "cutoff": cutoff,
            "retentionDays": retention_days,
            "maxSize": max_size,
            "targets": [],
        });
    }

    let mut targets = Vec::new();
    let mut targeted = BTreeSet::new();
    for notification in &notifications {
        let id = match notification.get("id").and_then(Value::as_str) {
            Some(id) => id,
            None => continue,
        };
        let unread = notification
            .get("unread")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let created_at = match notification.get("createdAt").and_then(Value::as_str) {
            Some(created_at) => created_at,
            None => continue,
        };
        if !is_protected(id, unread, &protected_ids)
            && !unread
            && is_parseable_iso(created_at)
            && created_at <= cutoff.as_str()
        {
            targets.push(cleanup_target(notification, "aged"));
            targeted.insert(id.to_owned());
        }
    }

    let retained = notifications.len().saturating_sub(targets.len());
    if retained > max_size {
        let mut evictable = notifications
            .iter()
            .enumerate()
            .filter(|(_, notification)| {
                let Some(id) = notification.get("id").and_then(Value::as_str) else {
                    return false;
                };
                if targeted.contains(id) {
                    return false;
                }
                let unread = notification
                    .get("unread")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                !is_protected(id, unread, &protected_ids)
            })
            .collect::<Vec<_>>();
        evictable.sort_by(|(left_index, left), (right_index, right)| {
            let left_unread = left.get("unread").and_then(Value::as_bool).unwrap_or(false);
            let right_unread = right
                .get("unread")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            left_unread
                .cmp(&right_unread)
                .then_with(|| compare_created_at(left, right))
                .then_with(|| left_index.cmp(right_index))
        });

        for (_, notification) in evictable.into_iter().take(retained - max_size) {
            targets.push(cleanup_target(notification, "overflow"));
        }
    }

    json!({
        "enabled": true,
        "now": now,
        "cutoff": cutoff,
        "retentionDays": retention_days,
        "maxSize": max_size,
        "targets": targets,
    })
}

fn run_inbox_cleanup_contract(input: &Value) -> Value {
    let plan = input.get("plan").cloned().unwrap_or(Value::Null);
    let dry_run = input
        .get("dryRun")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let clear_results = input.get("clearResults").unwrap_or(&Value::Null);
    if let Some(miss_results) = input.get("missResults") {
        return json!({
            "ok": run_inbox_cleanup(&plan, dry_run, clear_results),
            "miss": run_inbox_cleanup(&plan, dry_run, miss_results),
        });
    }
    run_inbox_cleanup(&plan, dry_run, clear_results)
}

fn run_inbox_cleanup(plan: &Value, dry_run: bool, clear_results: &Value) -> Value {
    let mut results = Vec::new();
    if plan
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        for target in plan
            .get("targets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = target.get("id").and_then(Value::as_str).unwrap_or_default();
            let reason = target
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if dry_run {
                results.push(json!({ "id": id, "reason": reason, "status": "dry-run" }));
            } else if clear_results
                .get(id)
                .and_then(Value::as_i64)
                .unwrap_or_default()
                > 0
            {
                results.push(json!({ "id": id, "reason": reason, "status": "cleared" }));
            } else {
                results.push(json!({
                    "id": id,
                    "reason": reason,
                    "status": "failed",
                    "error": "notification not found",
                }));
            }
        }
    }
    json!({
        "dryRun": dry_run,
        "plan": plan,
        "results": results,
    })
}

fn cleanup_target(notification: &Value, reason: &str) -> Value {
    let mut target = json!({
        "id": notification.get("id").cloned().unwrap_or(Value::Null),
        "reason": reason,
        "createdAt": notification.get("createdAt").cloned().unwrap_or(Value::Null),
    });
    if let Some(session_id) = notification.get("sessionId") {
        target["sessionId"] = session_id.clone();
    }
    target
}

fn compare_created_at(left: &Value, right: &Value) -> Ordering {
    left.get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .cmp(
            right
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
}

fn is_protected(id: &str, unread: bool, protected_ids: &Option<BTreeSet<String>>) -> bool {
    protected_ids
        .as_ref()
        .map(|ids| ids.contains(id))
        .unwrap_or(unread)
}

fn non_negative_usize(value: Option<&Value>, fallback: usize) -> usize {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value as usize)
        .unwrap_or(fallback)
}

fn string_field(input: &Value, field: &str) -> Option<String> {
    input.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn subtract_days_iso(value: &str, days: usize) -> Option<String> {
    let (year, month, day) = parse_iso_date(value)?;
    let absolute = days_from_civil(year, month, day) - days as i64;
    let (year, month, day) = civil_from_days(absolute);
    Some(format!(
        "{year:04}-{month:02}-{day:02}{}",
        value.get(10..).unwrap_or("T00:00:00.000Z")
    ))
}

fn is_parseable_iso(value: &str) -> bool {
    parse_iso_date(value).is_some()
}

fn parse_iso_date(value: &str) -> Option<(i32, u32, u32)> {
    if value.len() < 10 {
        return None;
    }
    Some((
        value.get(0..4)?.parse().ok()?,
        value.get(5..7)?.parse().ok()?,
        value.get(8..10)?.parse().ok()?,
    ))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) as i64
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}
