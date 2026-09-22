use std::collections::{BTreeMap, BTreeSet};

const DASHBOARD_ENTRYPOINTS: &[&str] =
    &["--tmux-dashboard-internal", "__dashboard-internal-native"];
const NATIVE_BUILD_MARKER: &str = "/.aimux/native/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardProcess {
    pub pid: i32,
    pub args: String,
}

pub fn dashboard_build_of(args: &str) -> Option<String> {
    let start = args.find(NATIVE_BUILD_MARKER)? + NATIVE_BUILD_MARKER.len();
    let rest = &args[start..];
    let end = rest
        .find(|character: char| character == '/' || character.is_whitespace())
        .unwrap_or(rest.len());
    let build = rest[..end].trim();
    (!build.is_empty()).then(|| build.to_owned())
}

/// The project a dashboard process was launched for.
///
/// Read from its own argv rather than from any registry, so two dashboards for
/// one project are visible even when the daemon's view of that project is the
/// thing that is wrong.
pub fn dashboard_project_root_of(args: &str) -> Option<String> {
    let mut parts = args.split_whitespace();
    while let Some(part) = parts.next() {
        if part == "--project-root" {
            return parts
                .next()
                .map(|root| root.trim_matches('\'').trim_matches('"').to_owned())
                .filter(|root| !root.is_empty());
        }
        if let Some(root) = part.strip_prefix("--project-root=") {
            let root = root.trim_matches('\'').trim_matches('"');
            if !root.is_empty() {
                return Some(root.to_owned());
            }
        }
    }
    None
}

/// The tmux session a dashboard process is running in, found by walking up
/// from the process to the pane that hosts it.
///
/// A project legitimately has one dashboard per attached client session as well
/// as the one in its own session, so "two dashboards for this project root" is
/// not by itself a leak. The session is what separates the two cases, and the
/// dashboard's own argv does not carry it.
pub fn tmux_session_for_process(
    pid: i32,
    parents: &BTreeMap<i32, i32>,
    session_by_pane_pid: &BTreeMap<i32, String>,
) -> Option<String> {
    let mut current = pid;
    for _ in 0..8 {
        if let Some(session) = session_by_pane_pid.get(&current) {
            return Some(session.clone());
        }
        match parents.get(&current) {
            Some(parent) if *parent > 0 && *parent != current => current = *parent,
            _ => break,
        }
    }
    None
}

pub fn is_dashboard_process_args(args: &str) -> bool {
    DASHBOARD_ENTRYPOINTS
        .iter()
        .any(|entrypoint| args.contains(entrypoint))
}

pub fn select_stale_dashboards(
    processes: &[DashboardProcess],
    current_build: &str,
    current_pid: i32,
) -> Vec<DashboardProcess> {
    if current_build.trim().is_empty() {
        return Vec::new();
    }
    processes
        .iter()
        .filter(|entry| entry.pid != current_pid)
        .filter(|entry| is_dashboard_process_args(&entry.args))
        .filter(|entry| dashboard_build_of(&entry.args).is_some_and(|build| build != current_build))
        .cloned()
        .collect()
}

pub fn select_orphaned_dashboards(
    processes: &[DashboardProcess],
    parents: &BTreeMap<i32, i32>,
    current_pid: i32,
    live_pane_pids: &BTreeSet<i32>,
) -> Vec<DashboardProcess> {
    processes
        .iter()
        .filter(|entry| entry.pid != current_pid)
        .filter(|entry| is_dashboard_process_args(&entry.args))
        .filter(|entry| is_orphaned_dashboard(entry.pid, parents, live_pane_pids))
        .cloned()
        .collect()
}

fn is_orphaned_dashboard(
    pid: i32,
    parents: &BTreeMap<i32, i32>,
    live_pane_pids: &BTreeSet<i32>,
) -> bool {
    if live_pane_pids.contains(&pid) {
        return false;
    }
    let Some(shell) = parents.get(&pid).copied() else {
        return false;
    };
    if has_live_pane_ancestor(pid, parents, live_pane_pids) {
        return false;
    }
    if parents.get(&shell).copied() == Some(1) {
        return true;
    }
    !live_pane_pids.is_empty()
}

fn has_live_pane_ancestor(
    pid: i32,
    parents: &BTreeMap<i32, i32>,
    live_pane_pids: &BTreeSet<i32>,
) -> bool {
    let mut seen = BTreeSet::new();
    let mut current = Some(pid);
    while let Some(pid) = current {
        if pid <= 1 || !seen.insert(pid) {
            return false;
        }
        if live_pane_pids.contains(&pid) {
            return true;
        }
        current = parents.get(&pid).copied();
    }
    false
}
