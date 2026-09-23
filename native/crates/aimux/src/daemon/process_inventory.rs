use crate::async_runtime::{scoped_task_name, spawn_blocking_named};
use crate::atomic_write::write_json_atomic;
use crate::daemon::scheduler::{DaemonPeriodicTask, DaemonSchedulerContext, PeriodicTaskFuture};
use crate::paths::PathResolver;
use crate::process_inspector::{
    ProcessArgsEntry, is_aimux_daemon_process_args, try_list_process_args,
    try_read_process_aimux_home,
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
            // Every `ps` in here goes through the sync subprocess seam, which
            // panics on an async worker thread -- the per-daemon AIMUX_HOME
            // reads included, so the whole snapshot is built off the runtime.
            let resolver = context.resolver.clone();
            let expected_pid = context.info.pid;
            spawn_blocking_named(
                scoped_task_name(DAEMON_PROCESS_HEALTH_TASK_NAME, "process-args", "daemon"),
                move || {
                    write_daemon_process_health_snapshot(
                        &resolver,
                        expected_pid,
                        try_list_process_args(),
                        now_iso(),
                    )
                },
            )
            .await
            .map_err(|error| format!("process inventory task did not finish: {error}"))?
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
    let snapshot = daemon_process_health_snapshot(
        processes,
        Some(expected_daemon_pid),
        Some(&resolver.global_aimux_dir().to_string_lossy()),
        generated_at,
    );
    write_json_atomic(daemon_process_health_path(resolver), &snapshot)
        .map_err(|error| format!("failed to write daemon process health snapshot: {error}"))
}

pub fn daemon_process_health_snapshot(
    processes: Result<Vec<ProcessArgsEntry>, String>,
    expected_daemon_pid: Option<i32>,
    expected_aimux_home: Option<&str>,
    generated_at: String,
) -> Value {
    match processes {
        Ok(processes) => json!({
            "version": 1,
            "generatedAt": generated_at,
            "daemonProcessInventory": daemon_process_inventory_report(&processes, expected_daemon_pid, expected_aimux_home),
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
    expected_aimux_home: Option<&str>,
) -> Value {
    daemon_process_inventory_report_with_home_reader(
        processes,
        expected_daemon_pid,
        expected_aimux_home,
        try_read_process_aimux_home,
    )
}

/// A daemon is this control plane's business only when it shares this home.
///
/// Keyed on the executable name alone, every aimux daemon on the machine was
/// counted, so a developer running aimux normally saw "unexpected daemon
/// processes" reported inside every isolated test home at once -- a warning
/// about someone else's installation, in a home that owns no daemon at all.
///
/// A home that cannot be read is neither ours nor foreign. Dropping it would
/// hide a real leak and counting it would bring the noise back, so it is
/// reported separately and says why.
pub fn daemon_process_inventory_report_with_home_reader(
    processes: &[ProcessArgsEntry],
    expected_daemon_pid: Option<i32>,
    expected_aimux_home: Option<&str>,
    read_home: impl Fn(i32) -> Result<Option<String>, String>,
) -> Value {
    let daemon_processes = processes
        .iter()
        .filter(|entry| is_aimux_daemon_process_args(&entry.args))
        .collect::<Vec<_>>();
    let mut unexpected = Vec::new();
    let mut undetermined = Vec::new();
    let mut foreign = 0usize;
    for entry in daemon_processes
        .iter()
        .filter(|entry| Some(entry.pid) != expected_daemon_pid)
    {
        let Some(expected_home) = expected_aimux_home else {
            // No home to compare against: keep the old, broader answer rather
            // than silently reporting nothing.
            unexpected.push(json!({
                "pid": entry.pid,
                "argsPreview": process_args_preview(&entry.args),
            }));
            continue;
        };
        match read_home(entry.pid) {
            Ok(Some(home)) if home == expected_home => unexpected.push(json!({
                "pid": entry.pid,
                "aimuxHome": home,
                "argsPreview": process_args_preview(&entry.args),
            })),
            Ok(Some(_)) | Ok(None) => foreign += 1,
            Err(error) => undetermined.push(json!({
                "pid": entry.pid,
                "error": error,
                "argsPreview": process_args_preview(&entry.args),
            })),
        }
    }
    json!({
        "total": daemon_processes.len(),
        "expectedPid": expected_daemon_pid,
        "expectedAimuxHome": expected_aimux_home,
        "otherHomeCount": foreign,
        "unexpectedCount": unexpected.len(),
        "unexpected": unexpected,
        "undeterminedCount": undetermined.len(),
        "undetermined": undetermined,
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
    let total = inventory.get("total").and_then(Value::as_u64).unwrap_or(0);
    if unexpected_count == 0 {
        // Not knowing is a third answer. Reporting nothing here would say the
        // machine is clean on the strength of a question we failed to ask.
        let undetermined_count = inventory
            .get("undeterminedCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if undetermined_count == 0 {
            return None;
        }
        return Some(json!({
            "id": "undetermined-daemon-processes",
            "kind": "daemon-process-inventory",
            "title": "Could not tell which Aimux daemons are this installation's",
            "message": format!(
                "Aimux could not read the environment of {undetermined_count} of {total} daemon process(es), so it cannot say whether they belong to this AIMUX_HOME. Run `aimux doctor versions` for PIDs and details."
            ),
            "createdAt": generated_at,
        }));
    }
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
            None,
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
            None,
            "2026-09-21T00:00:00Z".into(),
        );
        assert!(control_plane_warning_for_snapshot(&clean).is_none());
    }

    /// The bug this keys on identity to stop: running aimux normally put a real
    /// daemon in every `ps`, so every isolated test home on the machine reported
    /// it as an unexpected process of its own.
    #[test]
    fn a_daemon_under_another_home_is_not_this_control_planes_business() {
        let processes = vec![
            ProcessArgsEntry {
                pid: 101,
                args: "/opt/aimux/bin/aimux daemon run".into(),
            },
            ProcessArgsEntry {
                pid: 202,
                args: "/opt/aimux/bin/aimux daemon run".into(),
            },
        ];
        let report = daemon_process_inventory_report_with_home_reader(
            &processes,
            Some(101),
            Some("/home/sam/.aimux"),
            |pid| match pid {
                202 => Ok(Some("/tmp/aimux-test-home".into())),
                _ => Ok(None),
            },
        );

        assert_eq!(report["total"], 2);
        assert_eq!(report["unexpectedCount"], 0);
        assert_eq!(report["otherHomeCount"], 1);
        assert!(
            control_plane_warning_for_snapshot(&json!({
                "generatedAt": "2026-09-23T00:00:00Z",
                "daemonProcessInventory": report,
            }))
            .is_none()
        );
    }

    #[test]
    fn a_second_daemon_under_this_home_is_still_reported() {
        let processes = vec![
            ProcessArgsEntry {
                pid: 101,
                args: "/opt/aimux/bin/aimux daemon run".into(),
            },
            ProcessArgsEntry {
                pid: 202,
                args: "/opt/aimux/bin/aimux daemon run".into(),
            },
        ];
        let report = daemon_process_inventory_report_with_home_reader(
            &processes,
            Some(101),
            Some("/home/sam/.aimux"),
            |_| Ok(Some("/home/sam/.aimux".into())),
        );

        assert_eq!(report["unexpectedCount"], 1);
        assert_eq!(report["unexpected"][0]["pid"], 202);
    }

    /// A home we could not read is neither ours nor foreign. Counting it brings
    /// the noise back; dropping it hides a leak. It gets its own line.
    #[test]
    fn a_home_that_cannot_be_read_is_reported_as_undetermined_not_as_clean() {
        let processes = vec![
            ProcessArgsEntry {
                pid: 101,
                args: "/opt/aimux/bin/aimux daemon run".into(),
            },
            ProcessArgsEntry {
                pid: 202,
                args: "/opt/aimux/bin/aimux daemon run".into(),
            },
        ];
        let report = daemon_process_inventory_report_with_home_reader(
            &processes,
            Some(101),
            Some("/home/sam/.aimux"),
            |_| Err("ps environment inventory failed".into()),
        );

        assert_eq!(report["unexpectedCount"], 0);
        assert_eq!(report["undeterminedCount"], 1);
        let warning = control_plane_warning_for_snapshot(&json!({
            "generatedAt": "2026-09-23T00:00:00Z",
            "daemonProcessInventory": report,
        }))
        .expect("an unreadable environment is reported, not swallowed");
        assert_eq!(warning["id"], "undetermined-daemon-processes");
    }
}
