use crate::async_runtime::{scoped_task_name, spawn_blocking_named};
use crate::atomic_write::write_json_atomic;
use crate::daemon::scheduler::{DaemonPeriodicTask, DaemonSchedulerContext, PeriodicTaskFuture};
use crate::paths::PathResolver;
use crate::process_inspector::{
    ProcessArgsEntry, is_aimux_daemon_process_args, try_list_process_args,
};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DAEMON_PROCESS_HEALTH_TASK_NAME: &str = "daemon-process-health";
pub const DAEMON_PROCESS_HEALTH_INTERVAL_MS: i64 = 60 * 1_000;
pub const DAEMON_PROCESS_HEALTH_FILE: &str = "process-health.json";

pub struct DaemonProcessHealthTask;

impl DaemonPeriodicTask for DaemonProcessHealthTask {
    fn name(&self) -> &str {
        DAEMON_PROCESS_HEALTH_TASK_NAME
    }

    fn interval_ms(&self) -> i64 {
        DAEMON_PROCESS_HEALTH_INTERVAL_MS
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(10)
    }

    fn run_immediately(&self) -> bool {
        true
    }

    fn run<'a>(&'a mut self, context: &'a DaemonSchedulerContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            // `try_list_process_args` spawns `ps` through the sync subprocess
            // seam, which panics when it runs on an async worker thread.
            let processes = spawn_blocking_named(
                scoped_task_name(DAEMON_PROCESS_HEALTH_TASK_NAME, "process-args", "daemon"),
                try_list_process_args,
            )
            .await
            .map_err(|error| format!("process inventory task did not finish: {error}"))?;
            write_daemon_process_health_snapshot(
                &context.resolver,
                context.info.pid,
                processes,
                now_iso(),
            )
        })
    }
}

pub fn daemon_process_health_path(resolver: &PathResolver) -> PathBuf {
    resolver.daemon_dir().join(DAEMON_PROCESS_HEALTH_FILE)
}

pub fn write_daemon_process_health_snapshot(
    resolver: &PathResolver,
    expected_daemon_pid: i32,
    processes: Result<Vec<ProcessArgsEntry>, String>,
    generated_at: String,
) -> Result<(), String> {
    let snapshot =
        daemon_process_health_snapshot(processes, Some(expected_daemon_pid), generated_at);
    write_json_atomic(daemon_process_health_path(resolver), &snapshot)
        .map_err(|error| format!("failed to write daemon process health snapshot: {error}"))
}

pub fn daemon_process_health_snapshot(
    processes: Result<Vec<ProcessArgsEntry>, String>,
    expected_daemon_pid: Option<i32>,
    generated_at: String,
) -> Value {
    match processes {
        Ok(processes) => json!({
            "version": 1,
            "generatedAt": generated_at,
            "daemonProcessInventory": daemon_process_inventory_report(&processes, expected_daemon_pid),
        }),
        Err(error) => json!({
            "version": 1,
            "generatedAt": generated_at,
            "processInventoryError": error,
        }),
    }
}

pub fn daemon_process_inventory_report(
    processes: &[ProcessArgsEntry],
    expected_daemon_pid: Option<i32>,
) -> Value {
    let daemon_processes = processes
        .iter()
        .filter(|entry| is_aimux_daemon_process_args(&entry.args))
        .collect::<Vec<_>>();
    let unexpected = daemon_processes
        .iter()
        .filter(|entry| Some(entry.pid) != expected_daemon_pid)
        .map(|entry| {
            json!({
                "pid": entry.pid,
                "argsPreview": process_args_preview(&entry.args),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "total": daemon_processes.len(),
        "expectedPid": expected_daemon_pid,
        "unexpectedCount": unexpected.len(),
        "unexpected": unexpected,
    })
}

pub fn render_daemon_process_inventory_for_doctor(report: &Value) -> String {
    let Some(inventory) = report.get("daemonProcessInventory") else {
        return String::new();
    };
    let total = inventory.get("total").and_then(Value::as_u64).unwrap_or(0);
    let unexpected_count = inventory
        .get("unexpectedCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut lines = vec![format!(
        "  daemon processes: {total} ({unexpected_count} unexpected)"
    )];
    if let Some(error) = report.get("processInventoryError").and_then(Value::as_str) {
        lines.push(format!("  daemon process inventory error: {error}"));
    }
    for process in inventory
        .get("unexpected")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(10)
    {
        let pid = process.get("pid").and_then(Value::as_i64).unwrap_or(0);
        let args = process
            .get("argsPreview")
            .and_then(Value::as_str)
            .unwrap_or("");
        lines.push(format!("  unexpected daemon pid {pid}: {args}"));
    }
    format!("\n{}", lines.join("\n"))
}

pub fn read_daemon_process_control_plane_warning(resolver: &PathResolver) -> Option<Value> {
    let path = daemon_process_health_path(resolver);
    let snapshot = read_snapshot(&path)?;
    control_plane_warning_for_snapshot(&snapshot)
}

pub fn control_plane_warning_for_snapshot(snapshot: &Value) -> Option<Value> {
    let generated_at = snapshot
        .get("generatedAt")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if let Some(error) = snapshot
        .get("processInventoryError")
        .and_then(Value::as_str)
    {
        return Some(json!({
            "id": "daemon-process-inventory-error",
            "kind": "daemon-process-inventory",
            "title": "Could not inspect Aimux daemon processes",
            "message": format!("Aimux could not check for unexpected daemon processes: {error}"),
            "createdAt": generated_at,
        }));
    }
    let inventory = snapshot.get("daemonProcessInventory")?;
    let unexpected_count = inventory
        .get("unexpectedCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if unexpected_count == 0 {
        return None;
    }
    let total = inventory.get("total").and_then(Value::as_u64).unwrap_or(0);
    Some(json!({
        "id": "unexpected-daemon-processes",
        "kind": "unexpected-daemon-processes",
        "title": "Unexpected Aimux daemon processes detected",
        "message": format!(
            "Aimux found {unexpected_count} unexpected daemon process(es) out of {total}. Work is not blocked; run `aimux doctor versions` for PIDs and details."
        ),
        "createdAt": generated_at,
    }))
}

fn read_snapshot(path: &Path) -> Option<Value> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn process_args_preview(args: &str) -> String {
    const MAX_PREVIEW: usize = 220;
    if args.len() <= MAX_PREVIEW {
        return args.to_owned();
    }
    format!("{}...", args.chars().take(MAX_PREVIEW).collect::<String>())
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warning_reports_unexpected_daemons_and_clears_when_clean() {
        let dirty = daemon_process_health_snapshot(
            Ok(vec![
                ProcessArgsEntry {
                    pid: 101,
                    args: "/Users/sam/.aimux/native/current/bin/aimux daemon run".into(),
                },
                ProcessArgsEntry {
                    pid: 202,
                    args: "/tmp/aimux-cargo-target-codex/debug/aimux daemon run".into(),
                },
            ]),
            Some(101),
            "2026-09-21T00:00:00Z".into(),
        );
        let warning = control_plane_warning_for_snapshot(&dirty).expect("warning");
        assert_eq!(warning["id"], "unexpected-daemon-processes");
        assert_eq!(
            warning["title"],
            "Unexpected Aimux daemon processes detected"
        );
        assert!(
            warning["message"]
                .as_str()
                .unwrap()
                .contains("1 unexpected daemon process")
        );

        let clean = daemon_process_health_snapshot(
            Ok(vec![ProcessArgsEntry {
                pid: 101,
                args: "/Users/sam/.aimux/native/current/bin/aimux daemon run".into(),
            }]),
            Some(101),
            "2026-09-21T00:00:00Z".into(),
        );
        assert!(control_plane_warning_for_snapshot(&clean).is_none());
    }
}
