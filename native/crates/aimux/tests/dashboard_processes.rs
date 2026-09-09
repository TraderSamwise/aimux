use aimux::dashboard_processes::{
    DashboardProcess, dashboard_build_of, is_dashboard_process_args, select_orphaned_dashboards,
    select_stale_dashboards,
};
use std::collections::{BTreeMap, BTreeSet};

#[test]
fn reads_dashboard_build_from_node_or_native_install_path() {
    assert_eq!(
        dashboard_build_of(&dashboard(1, "local-490049e4").args).as_deref(),
        Some("local-490049e4")
    );
    assert_eq!(
        dashboard_build_of(&native_dashboard(1, "local-490049e4").args).as_deref(),
        Some("local-490049e4")
    );
    assert_eq!(
        dashboard_build_of("node /usr/local/bin/aimux --tmux-dashboard-internal"),
        None
    );
}

#[test]
fn matches_node_and_native_dashboard_entrypoints_only() {
    assert!(is_dashboard_process_args(&dashboard(1, "local-a").args));
    assert!(is_dashboard_process_args(
        &native_dashboard(1, "local-a").args
    ));
    assert!(!is_dashboard_process_args("launcher-bin.js daemon run"));
}

#[test]
fn stale_selection_ignores_current_build_and_unknown_builds() {
    let stale = select_stale_dashboards(
        &[
            dashboard(1, "local-old"),
            native_dashboard(2, "local-older"),
            dashboard(3, "local-current"),
            DashboardProcess {
                pid: 4,
                args: "node /usr/local/bin/aimux --tmux-dashboard-internal".into(),
            },
        ],
        "local-current",
        99,
    );

    assert_eq!(
        stale.iter().map(|entry| entry.pid).collect::<Vec<_>>(),
        [1, 2]
    );
    assert!(select_stale_dashboards(&[dashboard(1, "local-old")], "", 99).is_empty());
    assert!(select_stale_dashboards(&[dashboard(99, "local-old")], "local-current", 99).is_empty());
}

#[test]
fn orphan_selection_matches_reparented_and_live_pane_rules() {
    let reparented = BTreeMap::from([(1, 0), (10, 110), (110, 1)]);
    assert_eq!(
        select_orphaned_dashboards(
            &[native_dashboard(10, "local-a")],
            &reparented,
            999,
            &BTreeSet::new()
        )
        .iter()
        .map(|entry| entry.pid)
        .collect::<Vec<_>>(),
        [10]
    );

    let with_live_pane = BTreeMap::from([(10, 110), (110, 120), (120, 900), (900, 1)]);
    assert!(
        select_orphaned_dashboards(
            &[dashboard(10, "local-a")],
            &with_live_pane,
            999,
            &BTreeSet::from([120])
        )
        .is_empty()
    );
}

#[test]
fn orphan_selection_uses_live_pane_set_when_available() {
    let parents = BTreeMap::from([(10, 110), (110, 900), (20, 120), (120, 900), (900, 1)]);
    let orphans = select_orphaned_dashboards(
        &[dashboard(10, "local-a"), dashboard(20, "local-a")],
        &parents,
        999,
        &BTreeSet::from([120]),
    );

    assert_eq!(
        orphans.iter().map(|entry| entry.pid).collect::<Vec<_>>(),
        [10]
    );
}

fn dashboard(pid: i32, build: &str) -> DashboardProcess {
    DashboardProcess {
        pid,
        args: format!(
            "/Users/sam/.volta/bin/node /Users/sam/.aimux/native/{build}/dist/launcher-bin.js --tmux-dashboard-internal"
        ),
    }
}

fn native_dashboard(pid: i32, build: &str) -> DashboardProcess {
    DashboardProcess {
        pid,
        args: format!("/Users/sam/.aimux/native/{build}/bin/aimux __dashboard-internal-native"),
    }
}
