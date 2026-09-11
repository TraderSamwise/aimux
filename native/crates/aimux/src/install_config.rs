use crate::atomic_write::quarantine_corrupt_file;
use crate::install_cleanup::{DEFAULT_INSTALL_KEEP_RECENT, DEFAULT_INSTALL_RETENTION_DAYS};
use serde_json::{Number, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const MIN_INSTALL_CLEANUP_INTERVAL_MS: i64 = 3_600_000;
pub const MIN_INSTALL_RETENTION_DAYS: i64 = 1;

pub fn normalize_installs_config(raw: &Value) -> Value {
    let value = raw.as_object();
    json!({
        "cleanupEnabled": value
            .and_then(|value| value.get("cleanupEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "retentionDays": bounded_int(
            value.and_then(|value| value.get("retentionDays")),
            DEFAULT_INSTALL_RETENTION_DAYS as i64,
            MIN_INSTALL_RETENTION_DAYS,
            3_650,
        ),
        "keepRecent": bounded_int(
            value.and_then(|value| value.get("keepRecent")),
            DEFAULT_INSTALL_KEEP_RECENT as i64,
            0,
            10_000,
        ),
        "cleanupIntervalMs": bounded_int(
            value.and_then(|value| value.get("cleanupIntervalMs")),
            86_400_000,
            MIN_INSTALL_CLEANUP_INTERVAL_MS,
            30 * 86_400_000,
        )
    })
}

pub fn is_primary_install_lane_with_home(
    env: &BTreeMap<String, String>,
    home: impl AsRef<Path>,
) -> bool {
    let Some(configured) = env.get("AIMUX_HOME").map(|value| value.trim()) else {
        return true;
    };
    if configured.is_empty() {
        return true;
    }
    let home = home.as_ref();
    let expanded = if configured == "~" {
        home.to_path_buf()
    } else if let Some(rest) = configured.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(configured)
    };
    expanded == home.join(".aimux")
}

pub fn load_installs_config_from_path(path: impl AsRef<Path>) -> Value {
    let path = path.as_ref();
    if !path.exists() {
        return normalize_installs_config(&Value::Null);
    }
    match std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        Some(parsed) => normalize_installs_config(parsed.get("installs").unwrap_or(&Value::Null)),
        None => {
            quarantine_corrupt_file(path);
            normalize_installs_config(&Value::Null)
        }
    }
}

fn bounded_int(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> Value {
    let Some(value) = value else {
        return Value::Number(Number::from(fallback));
    };
    let Some(number) = value.as_f64().filter(|value| value.is_finite()) else {
        return Value::Number(Number::from(fallback));
    };
    let rounded = number.trunc();
    if rounded < min as f64 || rounded > max as f64 {
        return Value::Number(Number::from(fallback));
    }
    if rounded <= i64::MAX as f64 && rounded >= i64::MIN as f64 {
        Value::Number(Number::from(rounded as i64))
    } else {
        Number::from_f64(rounded)
            .map(Value::Number)
            .unwrap_or_else(|| Value::Number(Number::from(fallback)))
    }
}
