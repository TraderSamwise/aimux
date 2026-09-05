use aimux::daemon::disk_doctor::build_disk_doctor_report;
use aimux::daemon::routing::text_error;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use serde_json::{Value, json};

fn cleanup_result(bytes: u64, targets: usize, skipped_active: usize) -> Value {
    json!({
        "ok": true,
        "result": {
            "dryRun": true,
            "reclaimedBytes": 0,
            "plan": {
                "reclaimableBytes": bytes,
                "targets": (0..targets).map(|index| json!({ "path": format!("/cache/{index}") })).collect::<Vec<_>>(),
                "skipped": (0..skipped_active).map(|index| json!({
                    "worktreePath": format!("/active/{index}"),
                    "reason": "active-runtime"
                })).collect::<Vec<_>>()
            },
            "results": []
        }
    })
}

#[test]
fn default_report_aggregates_inactive_caches_and_leaves_active_unmeasured() {
    let mut calls = Vec::new();
    let (report, text) = build_disk_doctor_report(
        vec!["/small".into(), "/large".into()],
        false,
        vec!["/stale".into()],
        "2026-09-06T00:00:00.000Z".into(),
        |project_root, include_active| {
            calls.push((project_root.to_owned(), include_active));
            let response = if project_root == "/large" {
                cleanup_result(2048, 2, 1)
            } else {
                cleanup_result(512, 1, 0)
            };
            ProjectServiceJsonResult::ok(project_root, response)
        },
    )
    .expect("disk report");

    assert_eq!(
        calls,
        vec![("/small".into(), false), ("/large".into(), false)]
    );
    assert_eq!(report["generatedAt"], "2026-09-06T00:00:00.000Z");
    assert_eq!(report["skippedStaleProjectRoots"], json!(["/stale"]));
    assert_eq!(report["totals"]["inactiveReclaimableBytes"], 2560);
    assert_eq!(report["totals"]["inactiveTargetCount"], 3);
    assert_eq!(report["totals"]["protectedActiveUnmeasuredProjects"], 1);
    assert_eq!(report["totals"]["skippedActiveWorktrees"], 1);
    assert_eq!(report["totals"]["failures"], 0);
    assert!(text.starts_with(
        "Aimux Disk\n  inactive generated caches: 2.5KB (3 item(s))\n  protected active caches: not measured (1 active worktree(s)); pass --include-active to measure"
    ));
    assert!(text.contains("  skipped stale projects: 1"));
    assert!(text.find("  /large").unwrap() < text.find("  /small").unwrap());
}

#[test]
fn include_active_report_measures_only_the_protected_delta() {
    let mut calls = Vec::new();
    let (report, text) = build_disk_doctor_report(
        vec!["/repo".into()],
        true,
        Vec::new(),
        "now".into(),
        |project_root, include_active| {
            calls.push(include_active);
            ProjectServiceJsonResult::ok(
                project_root,
                if include_active {
                    cleanup_result(3072, 2, 0)
                } else {
                    cleanup_result(1024, 1, 1)
                },
            )
        },
    )
    .expect("disk report");

    assert_eq!(calls, vec![false, true]);
    assert_eq!(report["projects"][0]["inactiveReclaimableBytes"], 1024);
    assert_eq!(report["projects"][0]["protectedActiveBytes"], 2048);
    assert_eq!(report["projects"][0]["protectedActiveTargetCount"], 1);
    assert_eq!(report["projects"][0]["protectedActiveMeasured"], true);
    assert_eq!(report["totals"]["protectedActiveMeasuredProjects"], 1);
    assert!(text.contains("protected active caches: 2.0KB (1 item(s), 1 active worktree(s))"));
}

#[test]
fn project_failures_are_reported_without_failing_the_route() {
    let (report, text) = build_disk_doctor_report(
        vec!["/failed".into(), "/empty".into()],
        false,
        Vec::new(),
        "now".into(),
        |project_root, _| {
            if project_root == "/failed" {
                ProjectServiceJsonResult::error(text_error(
                    503,
                    "Error: project service unavailable",
                ))
            } else {
                ProjectServiceJsonResult::ok(project_root, cleanup_result(0, 0, 0))
            }
        },
    )
    .expect("disk report");

    assert_eq!(report["totals"]["failures"], 1);
    assert_eq!(
        report["projects"][0]["error"],
        "Error: project service unavailable"
    );
    assert!(
        !report["projects"][1]
            .as_object()
            .unwrap()
            .contains_key("error")
    );
    assert!(text.contains("  /failed\n    inactive: 0B (0 item(s))"));
    assert!(text.contains("    error: Error: project service unavailable"));
    assert!(!text.contains("  /empty"));
    assert!(!text.contains("no generated worktree caches found"));
}

#[test]
fn failed_active_measurement_discards_the_inactive_measurement() {
    let (report, _) = build_disk_doctor_report(
        vec!["/repo".into()],
        true,
        Vec::new(),
        "now".into(),
        |project_root, include_active| {
            if include_active {
                ProjectServiceJsonResult::error(text_error(502, "Error: measurement failed"))
            } else {
                ProjectServiceJsonResult::ok(project_root, cleanup_result(1024, 1, 1))
            }
        },
    )
    .expect("disk report");

    assert_eq!(report["projects"][0]["inactiveReclaimableBytes"], 0);
    assert_eq!(report["projects"][0]["inactiveTargetCount"], 0);
    assert_eq!(report["projects"][0]["protectedActiveBytes"], 0);
    assert_eq!(report["projects"][0]["protectedActiveMeasured"], true);
    assert_eq!(report["projects"][0]["skippedActiveWorktrees"], 0);
    assert_eq!(report["totals"]["failures"], 1);
}

#[test]
fn empty_report_matches_the_typescript_text() {
    let (_, text) = build_disk_doctor_report(
        Vec::new(),
        false,
        Vec::new(),
        "now".into(),
        |_, _| unreachable!(),
    )
    .expect("disk report");

    assert_eq!(
        text,
        "Aimux Disk\n  inactive generated caches: 0B (0 item(s))\n  protected active caches: 0B (0 item(s), 0 active worktree(s))\n  failures: 0\n  no generated worktree caches found"
    );
}
