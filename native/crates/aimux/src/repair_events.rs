use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::paths::PathResolver;

pub fn repair_events_contract(case: &Value, home: impl AsRef<Path>) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "recordRepairEvent" => {
            let event = &case["input"]["event"];
            let path = record_repair_event(event, home).expect("record repair event");
            let line = fs::read_to_string(&path)
                .expect("read repair log")
                .lines()
                .next()
                .and_then(|line| serde_json::from_str::<Value>(line).ok())
                .unwrap_or(Value::Null);
            json!({ "exists": path.exists(), "line": line })
        }
        _ => Value::Null,
    }
}

pub fn record_repair_event(event: &Value, home: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    let project_root = event
        .get("projectRoot")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut resolver = PathResolver::new("/", home.as_ref(), None);
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
