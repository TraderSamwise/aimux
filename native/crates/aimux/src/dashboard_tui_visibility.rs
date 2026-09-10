use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::tmux::tmux_command_from_env;

pub const DASHBOARD_TUI_VISIBILITY_CACHE_MS: i64 = 250;
pub const DASHBOARD_VISIBLE_VISIBILITY_RECHECK_MS: i64 = 1_000;
pub const DASHBOARD_HIDDEN_VISIBILITY_RECHECK_MS: i64 = 10_000;
pub const DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS: i64 = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TuiVisibilityReason {
    NotTmux,
    Visible,
    Hidden,
    Detached,
    QueryFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiVisibilitySnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub attached: bool,
    pub active_window: bool,
    pub visible: bool,
    pub reason: TuiVisibilityReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneRow {
    pub pane_id: String,
    pub pane_pid: i64,
    pub attached_raw: String,
    pub active_window_raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardTuiVisibilityState {
    pub started_in_dashboard: bool,
    pub dashboard_tui_visibility: Option<TuiVisibilitySnapshot>,
    pub dashboard_tui_visibility_checked_at: i64,
    pub dashboard_hidden_visibility_recheck_at: i64,
    pub dashboard_hidden_visibility_skip_ticks: i64,
    pub dashboard_tui_visibility_wake_pending: bool,
}

impl Default for DashboardTuiVisibilityState {
    fn default() -> Self {
        Self {
            started_in_dashboard: true,
            dashboard_tui_visibility: None,
            dashboard_tui_visibility_checked_at: 0,
            dashboard_hidden_visibility_recheck_at: 0,
            dashboard_hidden_visibility_skip_ticks: 0,
            dashboard_tui_visibility_wake_pending: false,
        }
    }
}

pub fn parse_tmux_visibility(raw: Option<&str>, pane_id: Option<&str>) -> TuiVisibilitySnapshot {
    let text = raw.unwrap_or("").trim();
    let mut parts = text.split('\t');
    let attached_raw = parts.next().unwrap_or_default();
    let active_window_raw = parts.next().unwrap_or_default();
    let Ok(attached_count) = attached_raw.parse::<i64>() else {
        return visible_fallback(pane_id, TuiVisibilityReason::QueryFailed);
    };
    if active_window_raw != "0" && active_window_raw != "1" {
        return visible_fallback(pane_id, TuiVisibilityReason::QueryFailed);
    }
    let attached = attached_count > 0;
    let active_window = active_window_raw == "1";
    TuiVisibilitySnapshot {
        pane_id: pane_id.map(str::to_owned),
        attached,
        active_window,
        visible: attached && active_window,
        reason: if attached && active_window {
            TuiVisibilityReason::Visible
        } else if attached {
            TuiVisibilityReason::Hidden
        } else {
            TuiVisibilityReason::Detached
        },
    }
}

pub fn visible_fallback(
    pane_id: Option<&str>,
    reason: TuiVisibilityReason,
) -> TuiVisibilitySnapshot {
    TuiVisibilitySnapshot {
        pane_id: pane_id.map(str::to_owned),
        attached: true,
        active_window: true,
        visible: true,
        reason,
    }
}

pub fn parse_tmux_pane_rows(raw: Option<&str>) -> Vec<TmuxPaneRow> {
    raw.unwrap_or("")
        .split('\n')
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.split('\t');
            let pane_id = parts.next().unwrap_or_default();
            let pane_pid = parts.next().unwrap_or_default().parse::<i64>().ok()?;
            let attached_raw = parts.next().unwrap_or_default();
            let active_window_raw = parts.next().unwrap_or_default();
            if pane_id.is_empty() || attached_raw.is_empty() || active_window_raw.is_empty() {
                return None;
            }
            Some(TmuxPaneRow {
                pane_id: pane_id.to_owned(),
                pane_pid,
                attached_raw: attached_raw.to_owned(),
                active_window_raw: active_window_raw.to_owned(),
            })
        })
        .collect()
}

pub fn parse_process_parents(raw: Option<&str>) -> BTreeMap<i64, i64> {
    let mut parents = BTreeMap::new();
    for (pid, ppid) in parse_process_parent_rows(raw) {
        parents.insert(pid, ppid);
    }
    parents
}

pub fn parse_process_parent_rows(raw: Option<&str>) -> Vec<(i64, i64)> {
    let mut parents = Vec::new();
    for line in raw.unwrap_or("").split('\n') {
        let mut parts = line.split_whitespace();
        let Some(pid) = parts.next().and_then(|part| part.parse::<i64>().ok()) else {
            continue;
        };
        let Some(ppid) = parts.next().and_then(|part| part.parse::<i64>().ok()) else {
            continue;
        };
        parents.push((pid, ppid));
    }
    parents
}

pub fn find_tmux_pane_for_process(
    panes: &[TmuxPaneRow],
    parents: &BTreeMap<i64, i64>,
    pid: i64,
) -> Option<TmuxPaneRow> {
    let pane_pids = panes
        .iter()
        .map(|pane| pane.pane_pid)
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut current = pid;
    while current > 0 && !seen.contains(&current) {
        if pane_pids.contains(&current) {
            return panes.iter().find(|pane| pane.pane_pid == current).cloned();
        }
        seen.insert(current);
        let Some(parent) = parents.get(&current).copied() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    None
}

pub fn read_tmux_tui_visibility_from_values(
    env_pane_id: Option<&str>,
    direct_raw: Option<&str>,
    direct_throws: bool,
    panes_raw: Option<&str>,
    parents_raw: Option<&str>,
    pid: i64,
) -> TuiVisibilitySnapshot {
    let pane_id = env_pane_id.map(str::trim).filter(|value| !value.is_empty());
    let Some(pane_id) = pane_id else {
        return visible_fallback(None, TuiVisibilityReason::NotTmux);
    };

    let direct_snapshot = if direct_throws {
        None
    } else {
        Some(parse_tmux_visibility(direct_raw, Some(pane_id)))
    };

    let process_resolution =
        read_tmux_tui_visibility_from_process(panes_raw, parents_raw, pid, Some(pane_id));
    if let Some((snapshot, true)) = process_resolution {
        return snapshot;
    }
    if let Some(snapshot) = direct_snapshot
        .as_ref()
        .filter(|snapshot| snapshot.reason != TuiVisibilityReason::QueryFailed)
    {
        return snapshot.clone();
    }
    if let Some((snapshot, _)) = process_resolution {
        return snapshot;
    }
    visible_fallback(Some(pane_id), TuiVisibilityReason::QueryFailed)
}

pub fn read_tmux_tui_visibility() -> TuiVisibilitySnapshot {
    let pane_id = std::env::var("TMUX_PANE")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let Some(pane_id) = pane_id else {
        return visible_fallback(None, TuiVisibilityReason::NotTmux);
    };

    let direct_snapshot = tmux_output(&[
        "display-message",
        "-p",
        "-t",
        &pane_id,
        "#{session_attached}\t#{window_active}",
    ])
    .ok()
    .map(|raw| parse_tmux_visibility(Some(&raw), Some(&pane_id)));

    if let Some(snapshot) = direct_snapshot.as_ref().filter(|snapshot| snapshot.visible) {
        return snapshot.clone();
    }

    let process_resolution = tmux_output(&[
        "list-panes",
        "-a",
        "-F",
        "#{pane_id}\t#{pane_pid}\t#{session_attached}\t#{window_active}",
    ])
    .ok()
    .and_then(|panes_raw| {
        let parents = crate::process_inspector::list_process_parents()
            .into_iter()
            .map(|(pid, ppid)| (i64::from(pid), i64::from(ppid)))
            .collect::<BTreeMap<_, _>>();
        read_tmux_tui_visibility_from_process_rows(
            &parse_tmux_pane_rows(Some(&panes_raw)),
            &parents,
            i64::from(std::process::id()),
            Some(&pane_id),
        )
    });

    if let Some((snapshot, true)) = process_resolution {
        return snapshot;
    }
    if let Some(snapshot) = direct_snapshot
        .as_ref()
        .filter(|snapshot| snapshot.reason != TuiVisibilityReason::QueryFailed)
    {
        return snapshot.clone();
    }
    if let Some((snapshot, _)) = process_resolution {
        return snapshot;
    }
    visible_fallback(Some(&pane_id), TuiVisibilityReason::QueryFailed)
}

pub fn read_dashboard_tui_visibility_for_state(
    state: &mut DashboardTuiVisibilityState,
    force: bool,
    now: i64,
    read_visibility: impl FnOnce() -> TuiVisibilitySnapshot,
) -> TuiVisibilitySnapshot {
    if !state.started_in_dashboard {
        return visible_fallback(None, TuiVisibilityReason::NotTmux);
    }
    if !force
        && let Some(cached) = &state.dashboard_tui_visibility
        && now - state.dashboard_tui_visibility_checked_at < DASHBOARD_TUI_VISIBILITY_CACHE_MS
    {
        return cached.clone();
    }
    let previous_visible = state
        .dashboard_tui_visibility
        .as_ref()
        .map(|snapshot| snapshot.visible)
        .unwrap_or(true);
    let snapshot = read_visibility();
    state.dashboard_tui_visibility = Some(snapshot.clone());
    state.dashboard_tui_visibility_checked_at = now;
    if !previous_visible && snapshot.visible {
        state.dashboard_tui_visibility_wake_pending = true;
    }
    snapshot
}

pub fn read_dashboard_tui_visibility_for_loop(
    state: &mut DashboardTuiVisibilityState,
    now: i64,
    read_visibility: impl FnOnce() -> TuiVisibilitySnapshot,
) -> TuiVisibilitySnapshot {
    if !state.started_in_dashboard {
        return visible_fallback(None, TuiVisibilityReason::NotTmux);
    }
    if let Some(cached) = &state.dashboard_tui_visibility {
        if cached.visible {
            if now - state.dashboard_tui_visibility_checked_at
                < DASHBOARD_VISIBLE_VISIBILITY_RECHECK_MS
            {
                return cached.clone();
            }
        } else if should_skip_hidden_visibility_check(state, now) {
            if state.dashboard_hidden_visibility_skip_ticks > 0 {
                state.dashboard_hidden_visibility_skip_ticks -= 1;
            }
            return cached.clone();
        }
    }

    let snapshot = read_dashboard_tui_visibility_for_state(state, true, now, read_visibility);
    if snapshot.visible {
        state.dashboard_hidden_visibility_recheck_at = 0;
        state.dashboard_hidden_visibility_skip_ticks = 0;
    } else {
        state.dashboard_hidden_visibility_recheck_at = now + DASHBOARD_HIDDEN_VISIBILITY_RECHECK_MS;
        state.dashboard_hidden_visibility_skip_ticks = DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS;
    }
    snapshot
}

fn should_skip_hidden_visibility_check(state: &DashboardTuiVisibilityState, now: i64) -> bool {
    if state.dashboard_hidden_visibility_recheck_at > now {
        return true;
    }
    state.dashboard_hidden_visibility_recheck_at == 0
        && state.dashboard_hidden_visibility_skip_ticks > 0
}

pub fn mark_dashboard_tui_visible(
    state: &mut DashboardTuiVisibilityState,
    now: i64,
    pane_id: Option<&str>,
) {
    let previous_visible = state
        .dashboard_tui_visibility
        .as_ref()
        .map(|snapshot| snapshot.visible)
        .unwrap_or(true);
    let pane_id = pane_id
        .map(str::to_owned)
        .or_else(|| state.dashboard_tui_visibility.as_ref()?.pane_id.clone());
    state.dashboard_tui_visibility = Some(TuiVisibilitySnapshot {
        pane_id,
        attached: true,
        active_window: true,
        visible: true,
        reason: TuiVisibilityReason::Visible,
    });
    state.dashboard_tui_visibility_checked_at = now;
    state.dashboard_hidden_visibility_recheck_at = 0;
    state.dashboard_hidden_visibility_skip_ticks = 0;
    if !previous_visible {
        state.dashboard_tui_visibility_wake_pending = true;
    }
}

pub fn consume_dashboard_tui_visibility_wake(state: &mut DashboardTuiVisibilityState) -> bool {
    let pending = state.dashboard_tui_visibility_wake_pending;
    state.dashboard_tui_visibility_wake_pending = false;
    pending
}

fn read_tmux_tui_visibility_from_process(
    panes_raw: Option<&str>,
    parents_raw: Option<&str>,
    pid: i64,
    stale_pane_id: Option<&str>,
) -> Option<(TuiVisibilitySnapshot, bool)> {
    let panes = parse_tmux_pane_rows(panes_raw);
    if panes.is_empty() {
        return None;
    }
    let parents = parse_process_parents(parents_raw);
    read_tmux_tui_visibility_from_process_rows(&panes, &parents, pid, stale_pane_id)
}

fn read_tmux_tui_visibility_from_process_rows(
    panes: &[TmuxPaneRow],
    parents: &BTreeMap<i64, i64>,
    pid: i64,
    stale_pane_id: Option<&str>,
) -> Option<(TuiVisibilitySnapshot, bool)> {
    if let Some(pane) = find_tmux_pane_for_process(panes, parents, pid) {
        return Some((
            parse_tmux_visibility(
                Some(&format!(
                    "{}\t{}",
                    pane.attached_raw, pane.active_window_raw
                )),
                Some(&pane.pane_id),
            ),
            true,
        ));
    }
    if let Some(stale_pane_id) = stale_pane_id
        && panes.iter().any(|row| row.pane_id == stale_pane_id)
    {
        return Some((
            visible_fallback(Some(stale_pane_id), TuiVisibilityReason::QueryFailed),
            false,
        ));
    }
    Some((
        TuiVisibilitySnapshot {
            pane_id: stale_pane_id.map(str::to_owned),
            attached: false,
            active_window: false,
            visible: false,
            reason: TuiVisibilityReason::Detached,
        },
        false,
    ))
}

fn tmux_output(args: &[&str]) -> Result<String, ()> {
    let mut command = tmux_command_from_env();
    command.args(args);
    let output =
        command_output_with_timeout(&mut command, Duration::from_millis(500)).map_err(|_| ())?;
    if !output.status.success() {
        return Err(());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let kill_deadline = Instant::now() + Duration::from_millis(100);
            while Instant::now() < kill_deadline {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out waiting for tmux output",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}
