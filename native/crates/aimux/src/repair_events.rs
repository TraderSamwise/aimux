use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use serde_json::{Value, json};

use crate::paths::PathResolver;

pub const ACTION_CONTROL_PLANE_RESTART: &str = "control-plane-restart";
pub const ACTION_PROJECT_SERVICE_ENSURE: &str = "project-service-ensure";
pub const ACTION_TMUX_RUNTIME_REPAIR: &str = "tmux-runtime-repair";
pub const ACTION_DASHBOARD_RELOAD: &str = "dashboard-reload";
pub const ACTION_VALIDATION_ORPHAN_CLEANUP: &str = "validation-orphan-cleanup";

pub const STATUS_STARTED: &str = "started";
pub const STATUS_REPAIRED: &str = "repaired";
pub const STATUS_SKIPPED: &str = "skipped";
pub const STATUS_FAILED: &str = "failed";

pub fn record_repair_event_for_project(
    resolver: &PathResolver,
    project_root: &str,
    action: &str,
    reason: &str,
    status: &str,
    details: Option<Value>,
) {
    let mut resolver = resolver.clone();
    let event = repair_event(project_root, action, reason, status, details);
    let _ = record_repair_event_to_resolver(&event, &mut resolver);
}

pub fn record_repair_event_from_env(
    project_root: &str,
    action: &str,
    reason: &str,
    status: &str,
    details: Option<Value>,
) {
    let mut resolver = PathResolver::from_env();
    let event = repair_event(project_root, action, reason, status, details);
    let _ = record_repair_event_to_resolver(&event, &mut resolver);
}

fn record_repair_event_to_resolver(
    event: &Value,
    resolver: &mut PathResolver,
) -> std::io::Result<PathBuf> {
    let project_root = event
        .get("projectRoot")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let path = resolver.project_repair_log_path_for(project_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(event).unwrap_or_else(|_| "{}".into())
    )?;
    Ok(path)
}

fn repair_event(
    project_root: &str,
    action: &str,
    reason: &str,
    status: &str,
    details: Option<Value>,
) -> Value {
    let mut event = serde_json::Map::new();
    event.insert("ts".into(), json!(now_iso()));
    event.insert("projectRoot".into(), json!(project_root));
    event.insert("action".into(), json!(action));
    event.insert("reason".into(), json!(reason));
    event.insert("status".into(), json!(status));
    if let Some(details) = details {
        event.insert("details".into(), details);
    }
    Value::Object(event)
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repair_event_helper_appends_project_log_without_panicking_on_details() {
        let home = std::env::temp_dir().join(format!(
            "aimux-repair-events-helper-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&home).expect("create temp home");
        let resolver = PathResolver::new("/", &home, None);

        record_repair_event_for_project(
            &resolver,
            "/tmp/aimux-repair-helper-project",
            ACTION_CONTROL_PLANE_RESTART,
            "dashboard-runtime-guard-repair",
            STATUS_STARTED,
            Some(json!({ "projectCount": 1 })),
        );

        let mut resolver = PathResolver::new("/", &home, None);
        let path = resolver.project_repair_log_path_for("/tmp/aimux-repair-helper-project");
        let line = fs::read_to_string(&path)
            .expect("repair log exists")
            .lines()
            .next()
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            .expect("repair event json");
        assert_eq!(line["projectRoot"], "/tmp/aimux-repair-helper-project");
        assert_eq!(line["action"], ACTION_CONTROL_PLANE_RESTART);
        assert_eq!(line["reason"], "dashboard-runtime-guard-repair");
        assert_eq!(line["status"], STATUS_STARTED);
        assert_eq!(line["details"], json!({ "projectCount": 1 }));
        assert!(line["ts"].as_str().is_some_and(|ts| ts.ends_with('Z')));

        let _ = fs::remove_dir_all(&home);
    }
}
