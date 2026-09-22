//! The runtime-coherence checks.
//!
//! Each case is one way the durable record and the live machine disagreed on
//! Sam's laptop after a reboot, plus the case where the check cannot be
//! evaluated at all — which must never read as healthy.

use aimux::daemon::coherence_doctor::{
    CheckOutcome, CoherenceDoctorRuntime, CoherenceReport, build_coherence_report,
    render_coherence_report,
};
use aimux::dashboard_processes::DashboardProcess;
use aimux::project_service::window_reconciliation::{BindingRepair, OwnedWindow};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Default)]
struct FakeRuntime {
    topology: Option<Result<Value, String>>,
    owned_windows: Option<Result<Vec<OwnedWindow>, String>>,
    snapshot_ids: Option<Result<BTreeSet<String>, String>>,
    dashboards: Option<Result<Vec<DashboardProcess>, String>>,
    dashboard_sessions: Option<Result<BTreeMap<i32, String>, String>>,
    registered_roots: Vec<String>,
    unreachable_roots: BTreeSet<String>,
    written_repairs: Vec<BindingRepair>,
    marked_offline: Vec<String>,
    snapshot_rebuilds: usize,
    write_error: Option<String>,
}

impl CoherenceDoctorRuntime for FakeRuntime {
    fn topology(&mut self, _project_root: &Path) -> Result<Value, String> {
        self.topology
            .clone()
            .unwrap_or_else(|| Ok(json!({ "sessions": [], "bindings": [] })))
    }

    fn owned_windows(&mut self, _project_root: &Path) -> Result<Vec<OwnedWindow>, String> {
        self.owned_windows.clone().unwrap_or_else(|| Ok(Vec::new()))
    }

    fn restore_snapshot_session_ids(
        &mut self,
        _project_root: &Path,
    ) -> Result<BTreeSet<String>, String> {
        self.snapshot_ids
            .clone()
            .unwrap_or_else(|| Ok(BTreeSet::new()))
    }

    fn dashboard_processes(&mut self) -> Result<Vec<DashboardProcess>, String> {
        self.dashboards.clone().unwrap_or_else(|| Ok(Vec::new()))
    }

    fn dashboard_tmux_sessions(
        &mut self,
        _dashboards: &[DashboardProcess],
    ) -> Result<BTreeMap<i32, String>, String> {
        self.dashboard_sessions
            .clone()
            .unwrap_or_else(|| Ok(BTreeMap::new()))
    }

    fn registered_project_roots(&mut self) -> Result<Vec<String>, String> {
        Ok(self.registered_roots.clone())
    }

    fn project_root_is_reachable(&mut self, project_root: &str) -> bool {
        !self.unreachable_roots.contains(project_root)
    }

    fn write_repaired_topology(
        &mut self,
        _project_root: &Path,
        repairs: &[BindingRepair],
    ) -> Result<(), String> {
        if let Some(error) = &self.write_error {
            return Err(error.clone());
        }
        self.written_repairs = repairs.to_vec();
        Ok(())
    }

    fn mark_sessions_offline(
        &mut self,
        _project_root: &Path,
        session_ids: &[String],
    ) -> Result<(), String> {
        if let Some(error) = &self.write_error {
            return Err(error.clone());
        }
        self.marked_offline = session_ids.to_vec();
        Ok(())
    }

    fn rebuild_restore_snapshot(&mut self, _project_root: &Path) -> Result<(), String> {
        if let Some(error) = &self.write_error {
            return Err(error.clone());
        }
        self.snapshot_rebuilds += 1;
        Ok(())
    }
}

fn report(runtime: &mut FakeRuntime, repair: bool) -> CoherenceReport {
    build_coherence_report(runtime, &PathBuf::from("/repo"), repair)
}

fn check<'a>(
    report: &'a CoherenceReport,
    name: &str,
) -> &'a aimux::daemon::coherence_doctor::CoherenceCheck {
    report
        .checks
        .iter()
        .find(|check| check.name == name)
        .unwrap_or_else(|| panic!("check {name} is reported"))
}

fn topology_with_stale_binding() -> Value {
    json!({
        "nodes": [{ "id": "node-codex" }],
        "sessions": [{ "id": "codex-abc", "nodeId": "node-codex", "status": "running" }],
        "bindings": [{
            "nodeId": "node-codex",
            "tmuxSession": "aimux-repo",
            "tmuxWindowId": "@1018",
            "tmuxWindowIndex": 4,
            "tmuxWindowName": "codex"
        }],
    })
}

#[test]
fn a_healthy_project_reports_every_check_clean() {
    let mut runtime = FakeRuntime::default();

    let report = report(&mut runtime, false);

    assert_eq!(report.finding_count(), 0);
    assert_eq!(report.unavailable_count(), 0);
    assert!(report.checks.len() >= 5, "every check is reported");
}

#[test]
fn a_binding_whose_window_this_project_does_not_own_is_reported_with_its_fix() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(topology_with_stale_binding())),
        owned_windows: Some(Ok(Vec::new())),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, false);
    let stale = check(&report, "stale-window-bindings");

    assert_eq!(stale.findings().len(), 1);
    assert_eq!(stale.findings()[0].subject, "codex-abc");
    assert!(stale.findings()[0].detail.contains("@1018"));
    assert!(
        stale.repaired.is_empty(),
        "a report without --repair changes nothing"
    );
    assert!(
        runtime.written_repairs.is_empty(),
        "a report without --repair writes nothing"
    );
}

#[test]
fn repair_applies_the_binding_fixes_and_says_what_it_changed() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(topology_with_stale_binding())),
        owned_windows: Some(Ok(Vec::new())),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, true);

    assert_eq!(
        check(&report, "stale-window-bindings").repaired,
        ["codex-abc"]
    );
    assert_eq!(runtime.written_repairs.len(), 1);
}

/// A repair that failed must not read as a repair that worked.
#[test]
fn a_failed_repair_is_reported_as_unavailable_not_as_repaired() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(topology_with_stale_binding())),
        owned_windows: Some(Ok(Vec::new())),
        write_error: Some("topology lock held".to_owned()),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, true);
    let stale = check(&report, "stale-window-bindings");

    assert!(matches!(stale.outcome, CheckOutcome::Unavailable(_)));
    assert!(stale.repaired.is_empty());
    assert_eq!(report.unavailable_count(), 1);
}

/// The overseer's shape: a session that reads running with nothing bound to it.
/// Pressing Enter on it can only fail.
#[test]
fn a_running_session_with_no_binding_is_reported() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(json!({
            "nodes": [{ "id": "node-overseer" }],
            "sessions": [{ "id": "claude-gqaapg", "nodeId": "node-overseer", "status": "running" }],
            "bindings": [],
        }))),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, false);
    let check = check(&report, "sessions-without-windows");

    assert_eq!(check.findings().len(), 1);
    assert_eq!(check.findings()[0].subject, "claude-gqaapg");
}

/// An offline session has no window by definition and is not a finding.
#[test]
fn an_offline_session_with_no_binding_is_not_a_finding() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(json!({
            "nodes": [{ "id": "node-codex" }],
            "sessions": [{ "id": "codex-abc", "nodeId": "node-codex", "status": "offline" }],
            "bindings": [],
        }))),
        ..FakeRuntime::default()
    };

    assert!(
        check(&report(&mut runtime, false), "sessions-without-windows")
            .findings()
            .is_empty()
    );
}

fn online_topology() -> Value {
    json!({
        "nodes": [{ "id": "n1" }, { "id": "n2" }],
        "sessions": [
            { "id": "codex-one", "nodeId": "n1", "status": "running" },
            { "id": "codex-two", "nodeId": "n2", "status": "running" },
        ],
        "bindings": [
            { "nodeId": "n1", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1" },
            { "nodeId": "n2", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2" },
        ],
    })
}

fn owned(window_id: &str) -> OwnedWindow {
    OwnedWindow {
        session_id: None,
        tmux_session: "aimux-repo".to_owned(),
        window_id: window_id.to_owned(),
        window_index: 0,
        window_name: "codex".to_owned(),
    }
}

/// An agent running in a window this project owns must be in the snapshot the
/// snapshot claims to be: a record of who is online.
#[test]
fn an_online_agent_missing_from_the_snapshot_is_reported() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(online_topology())),
        owned_windows: Some(Ok(vec![owned("@1"), owned("@2")])),
        snapshot_ids: Some(Ok(BTreeSet::from(["codex-one".to_owned()]))),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, false);
    let check = check(&report, "restore-snapshot");

    assert_eq!(check.findings().len(), 1);
    assert_eq!(check.findings()[0].subject, "codex-two");
}

/// The false positive this check used to produce: on tealstreet-next it flagged
/// 24 sessions, some offline since August, none of which the snapshot ever
/// held. An agent that is not online is absent from the snapshot by design —
/// a deliberate stop prunes it — so it is not drift.
#[test]
fn offline_sessions_absent_from_the_snapshot_are_not_findings() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(json!({
            "nodes": [{ "id": "n1" }, { "id": "n2" }, { "id": "n3" }],
            "sessions": [
                { "id": "codex-live", "nodeId": "n1", "status": "running" },
                { "id": "claude-stopped-in-august", "nodeId": "n2", "status": "offline" },
                { "id": "claude-also-stopped", "nodeId": "n3", "status": "offline" },
            ],
            "bindings": [
                { "nodeId": "n1", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1" },
            ],
        }))),
        owned_windows: Some(Ok(vec![owned("@1")])),
        snapshot_ids: Some(Ok(BTreeSet::from(["codex-live".to_owned()]))),
        ..FakeRuntime::default()
    };

    assert!(
        check(&report(&mut runtime, false), "restore-snapshot")
            .findings()
            .is_empty(),
        "an agent nobody is running is not missing from a record of who is running"
    );
}

/// A session claiming to run in a window this project does NOT own is not
/// online, so its absence from the snapshot is not drift either.
#[test]
fn a_session_bound_to_a_foreign_window_is_not_treated_as_online() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(online_topology())),
        owned_windows: Some(Ok(vec![owned("@1")])),
        snapshot_ids: Some(Ok(BTreeSet::from(["codex-one".to_owned()]))),
        ..FakeRuntime::default()
    };

    assert!(
        check(&report(&mut runtime, false), "restore-snapshot")
            .findings()
            .is_empty(),
        "codex-two's window @2 is not owned here, so it is not online"
    );
}

/// No snapshot at all is what a clean shutdown leaves behind, not a defect.
#[test]
fn no_snapshot_is_not_a_snapshot_finding() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(online_topology())),
        owned_windows: Some(Ok(vec![owned("@1"), owned("@2")])),
        snapshot_ids: Some(Ok(BTreeSet::new())),
        ..FakeRuntime::default()
    };

    assert!(
        check(&report(&mut runtime, false), "restore-snapshot")
            .findings()
            .is_empty()
    );
}

#[test]
fn two_dashboards_for_one_project_are_reported_and_one_each_is_not() {
    let mut runtime = FakeRuntime {
        dashboards: Some(Ok(vec![
            DashboardProcess {
                pid: 72612,
                args: "aimux __dashboard-internal-native --project-root /Users/sam/cs/aimux".into(),
            },
            DashboardProcess {
                pid: 3729,
                args: "aimux __dashboard-internal-native --project-root /Users/sam/cs/aimux".into(),
            },
            DashboardProcess {
                pid: 73547,
                args: "aimux __dashboard-internal-native --project-root /Users/sam/cs/thegrand"
                    .into(),
            },
        ])),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, false);
    let check = check(&report, "duplicate-dashboards");

    assert_eq!(check.findings().len(), 1, "only the doubled project");
    assert_eq!(check.findings()[0].subject, "/Users/sam/cs/aimux");
    assert!(check.findings()[0].detail.contains("72612"));
    assert!(check.findings()[0].detail.contains("3729"));
}

#[test]
fn a_registered_root_that_is_gone_is_reported_with_the_command_that_forgets_it() {
    let gone = "/private/tmp/aimux-role-badges-codex-8s9so6-1789311589";
    let mut runtime = FakeRuntime {
        registered_roots: vec!["/Users/sam/cs/aimux".to_owned(), gone.to_owned()],
        unreachable_roots: BTreeSet::from([gone.to_owned()]),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, false);
    let check = check(&report, "unreachable-projects");

    assert_eq!(check.findings().len(), 1);
    assert_eq!(check.findings()[0].subject, gone);
    assert_eq!(
        check.findings()[0].repair,
        format!("aimux projects remove {gone}")
    );
}

/// The whole point of the separate Unavailable outcome: a check that could not
/// run must not be counted as a check that passed.
#[test]
fn a_check_that_cannot_be_evaluated_is_never_reported_as_clean() {
    let mut runtime = FakeRuntime {
        topology: Some(Err("topology unreadable".to_owned())),
        dashboards: Some(Err("process table unavailable".to_owned())),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, false);

    for name in [
        "stale-window-bindings",
        "sessions-without-windows",
        "restore-snapshot",
        "duplicate-dashboards",
    ] {
        let check = check(&report, name);
        assert!(
            matches!(check.outcome, CheckOutcome::Unavailable(_)),
            "{name} must report why it could not run, not that it passed"
        );
    }
    assert_eq!(report.unavailable_count(), 4);
    assert_eq!(report.finding_count(), 0);
}

/// A tmux inventory that failed must not make every binding look stale.
#[test]
fn a_failed_tmux_inventory_does_not_condemn_every_binding() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(topology_with_stale_binding())),
        owned_windows: Some(Err("tmux server not running".to_owned())),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, true);
    let check = check(&report, "stale-window-bindings");

    assert!(matches!(check.outcome, CheckOutcome::Unavailable(_)));
    assert!(
        runtime.written_repairs.is_empty(),
        "a repair must never run on an inventory that could not be taken"
    );
}

#[test]
fn the_rendered_report_names_each_finding_and_its_fix() {
    let gone = "/tmp/gone-checkout";
    let mut runtime = FakeRuntime {
        topology: Some(Ok(topology_with_stale_binding())),
        owned_windows: Some(Ok(Vec::new())),
        registered_roots: vec![gone.to_owned()],
        unreachable_roots: BTreeSet::from([gone.to_owned()]),
        ..FakeRuntime::default()
    };

    let text = render_coherence_report(&report(&mut runtime, false));

    assert!(text.contains("stale-window-bindings: found"), "{text}");
    assert!(text.contains("codex-abc"), "{text}");
    assert!(
        text.contains("aimux projects remove /tmp/gone-checkout"),
        "{text}"
    );
    assert!(text.contains("duplicate-dashboards: ok"), "{text}");
}

/// The durable status is what makes the dashboard offer a session that cannot
/// be entered, so the repair has to write it, not just report it.
#[test]
fn repair_marks_a_windowless_running_session_offline() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(json!({
            "nodes": [{ "id": "node-overseer" }],
            "sessions": [{ "id": "claude-gqaapg", "nodeId": "node-overseer", "status": "running" }],
            "bindings": [],
        }))),
        owned_windows: Some(Ok(Vec::new())),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, true);

    assert_eq!(
        check(&report, "sessions-without-windows").repaired,
        ["claude-gqaapg"]
    );
    assert_eq!(runtime.marked_offline, ["claude-gqaapg"]);
}

/// The repair writes a durable status, so it must not run on an inventory tmux
/// could not answer — otherwise a tmux hiccup marks every agent offline.
#[test]
fn repair_does_not_mark_sessions_offline_when_the_tmux_inventory_failed() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(json!({
            "nodes": [{ "id": "node-overseer" }],
            "sessions": [{ "id": "claude-gqaapg", "nodeId": "node-overseer", "status": "running" }],
            "bindings": [],
        }))),
        owned_windows: Some(Err("tmux server not running".to_owned())),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, true);

    assert!(matches!(
        check(&report, "sessions-without-windows").outcome,
        CheckOutcome::Unavailable(_)
    ));
    assert!(
        runtime.marked_offline.is_empty(),
        "a status write must never ride on a query that failed"
    );
}

/// A report run must change nothing at all.
#[test]
fn a_report_without_repair_writes_no_status() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(json!({
            "nodes": [{ "id": "node-overseer" }],
            "sessions": [{ "id": "claude-gqaapg", "nodeId": "node-overseer", "status": "running" }],
            "bindings": [],
        }))),
        owned_windows: Some(Ok(Vec::new())),
        ..FakeRuntime::default()
    };

    report(&mut runtime, false);

    assert!(runtime.marked_offline.is_empty());
}

/// Preventing the shrink does not bring back what the old producer already
/// threw away, so the doctor has to be able to re-record it.
#[test]
fn repair_rebuilds_a_snapshot_that_is_missing_restorable_sessions() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(online_topology())),
        owned_windows: Some(Ok(vec![owned("@1"), owned("@2")])),
        snapshot_ids: Some(Ok(BTreeSet::from(["codex-one".to_owned()]))),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, true);

    assert_eq!(check(&report, "restore-snapshot").repaired, ["codex-two"]);
    assert_eq!(runtime.snapshot_rebuilds, 1);
}

#[test]
fn a_report_without_repair_never_rewrites_the_snapshot() {
    let mut runtime = FakeRuntime {
        topology: Some(Ok(online_topology())),
        owned_windows: Some(Ok(vec![owned("@1"), owned("@2")])),
        snapshot_ids: Some(Ok(BTreeSet::from(["codex-other".to_owned()]))),
        ..FakeRuntime::default()
    };

    report(&mut runtime, false);

    assert_eq!(runtime.snapshot_rebuilds, 0);
}

/// A project legitimately runs one dashboard in its own tmux session and one in
/// each attached client session. Grouping by project root alone reported that
/// as a leak; the tmux session is what separates the two cases.
#[test]
fn a_client_session_dashboard_is_not_a_duplicate() {
    let mut runtime = FakeRuntime {
        dashboards: Some(Ok(vec![
            DashboardProcess {
                pid: 100,
                args: "aimux __dashboard-internal-native --project-root /Users/sam/cs/aimux".into(),
            },
            DashboardProcess {
                pid: 200,
                args: "aimux __dashboard-internal-native --project-root /Users/sam/cs/aimux".into(),
            },
        ])),
        dashboard_sessions: Some(Ok(BTreeMap::from([
            (100, "aimux-aimux-4bf69b728633".to_owned()),
            (200, "aimux-aimux-4bf69b728633-client-c536d2bb".to_owned()),
        ]))),
        ..FakeRuntime::default()
    };

    assert!(
        check(&report(&mut runtime, false), "duplicate-dashboards")
            .findings()
            .is_empty(),
        "one per attached client is the rule, not a leak"
    );
}

/// Two in the same session is the leak.
#[test]
fn two_dashboards_in_one_tmux_session_are_a_duplicate() {
    let mut runtime = FakeRuntime {
        dashboards: Some(Ok(vec![
            DashboardProcess {
                pid: 72612,
                args: "aimux __dashboard-internal-native --project-root /Users/sam/cs/aimux".into(),
            },
            DashboardProcess {
                pid: 3729,
                args: "aimux __dashboard-internal-native --project-root /Users/sam/cs/aimux".into(),
            },
        ])),
        dashboard_sessions: Some(Ok(BTreeMap::from([
            (72612, "aimux-aimux-4bf69b728633".to_owned()),
            (3729, "aimux-aimux-4bf69b728633".to_owned()),
        ]))),
        ..FakeRuntime::default()
    };

    let report = report(&mut runtime, false);
    let check = check(&report, "duplicate-dashboards");

    assert_eq!(check.findings().len(), 1);
    assert!(
        check.findings()[0]
            .detail
            .contains("in tmux session aimux-aimux-4bf69b728633"),
        "the finding names where the duplicate is: {}",
        check.findings()[0].detail
    );
}

/// A session lookup that failed must not silently regroup every dashboard.
#[test]
fn a_failed_session_lookup_is_unavailable_not_clean() {
    let mut runtime = FakeRuntime {
        dashboards: Some(Ok(vec![DashboardProcess {
            pid: 1,
            args: "aimux __dashboard-internal-native --project-root /repo".into(),
        }])),
        dashboard_sessions: Some(Err("tmux list-panes failed".to_owned())),
        ..FakeRuntime::default()
    };

    assert!(matches!(
        check(&report(&mut runtime, false), "duplicate-dashboards").outcome,
        CheckOutcome::Unavailable(_)
    ));
}
