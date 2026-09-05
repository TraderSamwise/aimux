use serde_json::{Map, Value, json};
use std::path::Path;

use crate::config::load_config_for_project;
use crate::runtime_topology::{
    list_topology_session_states, list_topology_worktree_graveyard, read_runtime_topology,
    runtime_topology_path,
};

const DEFAULT_RETENTION_DAYS: f64 = 14.0;
const MS_PER_DAY: f64 = 86_400_000.0;

pub fn build_graveyard_cleanup_plan(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
) -> Result<Value, String> {
    let config = cleanup_config(load_config_for_project(project_root.as_ref()).get("graveyard"));
    let now_ms = now_epoch_millis() as f64;
    let cutoff_ms = now_ms - config.retention_days * MS_PER_DAY;
    let topology = read_runtime_topology(runtime_topology_path(project_state_dir))?;
    if !config.cleanup_enabled {
        return Ok(json!({
            "enabled": false,
            "now": iso_from_epoch_millis(now_ms),
            "cutoff": iso_from_epoch_millis(cutoff_ms),
            "retentionDays": config.retention_days,
            "agents": [],
            "worktrees": [],
        }));
    }
    let agents = list_topology_session_states(&topology, Some(&["graveyard"]))
        .into_iter()
        .filter_map(|session| expired_agent_target(&session, cutoff_ms, config.retention_days))
        .collect::<Vec<_>>();
    let worktrees = list_topology_worktree_graveyard(&topology, false)
        .into_iter()
        .filter_map(|worktree| expired_worktree_target(&worktree, cutoff_ms, config.retention_days))
        .collect::<Vec<_>>();
    Ok(json!({
        "enabled": true,
        "now": iso_from_epoch_millis(now_ms),
        "cutoff": iso_from_epoch_millis(cutoff_ms),
        "retentionDays": config.retention_days,
        "agents": agents,
        "worktrees": worktrees,
    }))
}

#[derive(Debug, Clone, Copy)]
struct CleanupConfig {
    cleanup_enabled: bool,
    retention_days: f64,
}

fn cleanup_config(config: Option<&Value>) -> CleanupConfig {
    let retention_days = config
        .and_then(|config| config.get("retentionDays"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(DEFAULT_RETENTION_DAYS);
    CleanupConfig {
        cleanup_enabled: config
            .and_then(|config| config.get("cleanupEnabled"))
            .and_then(Value::as_bool)
            != Some(false),
        retention_days,
    }
}

fn expired_agent_target(session: &Value, cutoff_ms: f64, retention_days: f64) -> Option<Value> {
    let graveyarded_at =
        string_field(session, "graveyardedAt").or_else(|| string_field(session, "updatedAt"))?;
    let graveyarded_at_ms = parse_iso_millis(graveyarded_at)?;
    if graveyarded_at_ms > cutoff_ms {
        return None;
    }
    let mut target = Map::new();
    target.insert("kind".into(), Value::String("agent".into()));
    target.insert(
        "sessionId".into(),
        Value::String(string_field(session, "id")?.to_owned()),
    );
    target.insert(
        "graveyardedAt".into(),
        Value::String(graveyarded_at.to_owned()),
    );
    target.insert(
        "expiresAt".into(),
        Value::String(iso_from_epoch_millis(
            graveyarded_at_ms + retention_days * MS_PER_DAY,
        )),
    );
    if let Some(worktree_path) = string_field(session, "worktreePath") {
        target.insert(
            "worktreePath".into(),
            Value::String(worktree_path.to_owned()),
        );
    }
    Some(Value::Object(target))
}

fn expired_worktree_target(worktree: &Value, cutoff_ms: f64, retention_days: f64) -> Option<Value> {
    let graveyarded_at = string_field(worktree, "graveyardedAt")?;
    let graveyarded_at_ms = parse_iso_millis(graveyarded_at)?;
    if graveyarded_at_ms > cutoff_ms {
        return None;
    }
    let mut target = Map::new();
    target.insert("kind".into(), Value::String("worktree".into()));
    target.insert(
        "path".into(),
        Value::String(string_field(worktree, "path")?.to_owned()),
    );
    if let Some(name) = string_field(worktree, "name") {
        target.insert("name".into(), Value::String(name.to_owned()));
    }
    target.insert(
        "graveyardedAt".into(),
        Value::String(graveyarded_at.to_owned()),
    );
    target.insert(
        "expiresAt".into(),
        Value::String(iso_from_epoch_millis(
            graveyarded_at_ms + retention_days * MS_PER_DAY,
        )),
    );
    Some(Value::Object(target))
}

fn string_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn now_epoch_millis() -> i128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i128)
        .unwrap_or(0)
}

fn parse_iso_millis(value: &str) -> Option<f64> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }
    let time = time.strip_suffix('Z').unwrap_or(time);
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    let mut clock_parts = clock.split(':');
    let hour = clock_parts.next()?.parse::<i64>().ok()?;
    let minute = clock_parts.next()?.parse::<i64>().ok()?;
    let second = clock_parts.next()?.parse::<i64>().ok()?;
    if clock_parts.next().is_some() {
        return None;
    }
    let millis = fraction
        .chars()
        .take(3)
        .collect::<String>()
        .parse::<i64>()
        .unwrap_or(0);
    Some(
        (days_from_civil(year, month, day) * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1000
            + millis) as f64,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn iso_from_epoch_millis(ms: f64) -> String {
    let millis = ms.max(0.0).floor() as i128;
    let seconds = (millis / 1000) as i64;
    let sub_millis = (millis % 1000) as u16;
    let Ok(datetime) = time::OffsetDateTime::from_unix_timestamp(seconds) else {
        return "1970-01-01T00:00:00.000Z".to_owned();
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        datetime.year(),
        u8::from(datetime.month()),
        datetime.day(),
        datetime.hour(),
        datetime.minute(),
        datetime.second(),
        sub_millis
    )
}
