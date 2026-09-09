use crate::dashboard_processes::{DashboardProcess, is_dashboard_process_args};
use crate::process_inspector::{
    ProcessArgsEntry, is_pid_alive, list_process_args, list_process_parents, read_process_args,
};
use crate::tmux::TmuxRuntimeManager;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_PROCESS_EXIT_TIMEOUT_MS: u64 = 2_000;
const DEFAULT_PROCESS_KILL_GRACE_MS: u64 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleOrphanCleanupResult {
    pub attempted_process_pids: Vec<i32>,
    pub process_pids: Vec<i32>,
    pub failed_process_pids: Vec<i32>,
    pub attempted_tmux_sessions: Vec<String>,
    pub tmux_sessions: Vec<String>,
    pub failed_tmux_sessions: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleOrphanPlan {
    pub process_pids: Vec<i32>,
    pub tmux_sessions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupLifecycleOrphansOptions {
    pub process_exit_timeout_ms: u64,
    pub process_kill_grace_ms: u64,
    pub current_pid: i32,
}

impl Default for CleanupLifecycleOrphansOptions {
    fn default() -> Self {
        Self {
            process_exit_timeout_ms: DEFAULT_PROCESS_EXIT_TIMEOUT_MS,
            process_kill_grace_ms: DEFAULT_PROCESS_KILL_GRACE_MS,
            current_pid: std::process::id() as i32,
        }
    }
}

pub trait LifecycleOrphanRuntime {
    fn list_processes(&mut self) -> Vec<ProcessArgsEntry>;
    fn list_process_parents(&mut self) -> BTreeMap<i32, i32>;
    fn read_process_args(&mut self, pid: i32) -> Option<String>;
    fn is_pid_alive(&mut self, pid: i32) -> bool;
    fn kill_pid(&mut self, pid: i32, signal: &str) -> Result<(), String>;
    fn sleep_ms(&mut self, ms: u64);
    fn tmux_is_available(&mut self) -> bool;
    fn list_tmux_session_names(&mut self) -> Vec<String>;
    fn get_tmux_session_option(&mut self, session_name: &str, key: &str) -> Option<String>;
    fn kill_tmux_session(&mut self, session_name: &str) -> Result<(), String>;
    fn list_live_tmux_pane_pids(&mut self) -> BTreeSet<i32>;
}

pub struct SystemLifecycleOrphanRuntime {
    tmux: TmuxRuntimeManager,
}

impl SystemLifecycleOrphanRuntime {
    pub fn new() -> Self {
        Self {
            tmux: TmuxRuntimeManager::new(),
        }
    }
}

impl Default for SystemLifecycleOrphanRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl LifecycleOrphanRuntime for SystemLifecycleOrphanRuntime {
    fn list_processes(&mut self) -> Vec<ProcessArgsEntry> {
        list_process_args()
    }

    fn list_process_parents(&mut self) -> BTreeMap<i32, i32> {
        list_process_parents().into_iter().collect()
    }

    fn read_process_args(&mut self, pid: i32) -> Option<String> {
        read_process_args(pid)
    }

    fn is_pid_alive(&mut self, pid: i32) -> bool {
        is_pid_alive(pid)
    }

    fn kill_pid(&mut self, pid: i32, signal: &str) -> Result<(), String> {
        kill_pid(pid, signal)
    }

    fn sleep_ms(&mut self, ms: u64) {
        thread::sleep(Duration::from_millis(ms));
    }

    fn tmux_is_available(&mut self) -> bool {
        self.tmux.is_available()
    }

    fn list_tmux_session_names(&mut self) -> Vec<String> {
        self.tmux.list_session_names()
    }

    fn get_tmux_session_option(&mut self, session_name: &str, key: &str) -> Option<String> {
        self.tmux.get_session_option(session_name, key)
    }

    fn kill_tmux_session(&mut self, session_name: &str) -> Result<(), String> {
        self.tmux.kill_session(session_name)
    }

    fn list_live_tmux_pane_pids(&mut self) -> BTreeSet<i32> {
        list_live_tmux_pane_pids()
    }
}

pub fn is_lifecycle_validation_process_args(args: &str) -> bool {
    has_direct_validation_native_node_entry(args)
        || (has_aimux_native_entry(args) && has_validation_home(args))
}

pub fn is_lifecycle_validation_tmux_session(
    session_name: &str,
    runtime: &mut impl LifecycleOrphanRuntime,
) -> bool {
    if is_validation_session_name(session_name) {
        return true;
    }
    let project_root = runtime
        .get_tmux_session_option(session_name, "@aimux-project-root")
        .unwrap_or_default();
    let state_dir = runtime
        .get_tmux_session_option(session_name, "@aimux-project-state-dir")
        .unwrap_or_default();
    is_validation_option(&project_root) || is_validation_option(&state_dir)
}

pub fn plan_lifecycle_validation_orphans(
    runtime: &mut impl LifecycleOrphanRuntime,
    current_pid: i32,
) -> LifecycleOrphanPlan {
    let tmux_available = runtime.tmux_is_available();
    let tmux_sessions = if tmux_available {
        unique_strings(
            runtime
                .list_tmux_session_names()
                .into_iter()
                .filter(|session_name| is_lifecycle_validation_tmux_session(session_name, runtime)),
        )
    } else {
        Vec::new()
    };
    let processes = runtime.list_processes();
    let parents = runtime.list_process_parents();
    let live_pane_pids = if tmux_available {
        runtime.list_live_tmux_pane_pids()
    } else {
        BTreeSet::new()
    };
    let process_pids = candidate_process_pids(&processes, &parents, current_pid, &live_pane_pids);
    LifecycleOrphanPlan {
        process_pids,
        tmux_sessions,
    }
}

pub fn cleanup_lifecycle_validation_orphans(
    runtime: &mut impl LifecycleOrphanRuntime,
    options: CleanupLifecycleOrphansOptions,
) -> LifecycleOrphanCleanupResult {
    let mut result = LifecycleOrphanCleanupResult {
        attempted_process_pids: Vec::new(),
        process_pids: Vec::new(),
        failed_process_pids: Vec::new(),
        attempted_tmux_sessions: Vec::new(),
        tmux_sessions: Vec::new(),
        failed_tmux_sessions: Vec::new(),
        errors: Vec::new(),
    };

    let tmux_available = runtime.tmux_is_available();
    if tmux_available {
        for session_name in unique_strings(runtime.list_tmux_session_names()) {
            if !is_lifecycle_validation_tmux_session(&session_name, runtime) {
                continue;
            }
            result.attempted_tmux_sessions.push(session_name.clone());
            match runtime.kill_tmux_session(&session_name) {
                Ok(()) => result.tmux_sessions.push(session_name),
                Err(error) => {
                    result.failed_tmux_sessions.push(session_name.clone());
                    result.errors.push(format!("{session_name}: {error}"));
                }
            }
        }
    }

    let processes = runtime.list_processes();
    let parents = runtime.list_process_parents();
    let live_pane_pids = if tmux_available {
        runtime.list_live_tmux_pane_pids()
    } else {
        BTreeSet::new()
    };
    let candidate_pids =
        candidate_process_pids(&processes, &parents, options.current_pid, &live_pane_pids);
    let orphaned_dashboard_pids =
        orphaned_dashboard_pids(&processes, &parents, options.current_pid, &live_pane_pids);

    for pid in candidate_pids {
        let latest_args = runtime.read_process_args(pid);
        if latest_args.as_deref().is_none_or(|args| {
            !is_reapable(
                pid,
                args,
                &orphaned_dashboard_pids,
                &parents,
                options.current_pid,
                &live_pane_pids,
            )
        }) {
            continue;
        }
        result.attempted_process_pids.push(pid);
        if let Err(error) = runtime.kill_pid(pid, "SIGTERM")
            && runtime.is_pid_alive(pid)
        {
            result.failed_process_pids.push(pid);
            result.errors.push(format!("pid {pid}: {error}"));
            continue;
        }
        if wait_for_pid_exit(
            runtime,
            pid,
            Duration::from_millis(options.process_exit_timeout_ms),
        ) {
            continue;
        }
        let args_before_kill = runtime.read_process_args(pid);
        if args_before_kill.as_deref().is_none_or(|args| {
            !is_reapable(
                pid,
                args,
                &orphaned_dashboard_pids,
                &parents,
                options.current_pid,
                &live_pane_pids,
            )
        }) {
            result.failed_process_pids.push(pid);
            result
                .errors
                .push(format!("pid {pid}: command changed before SIGKILL"));
            continue;
        }
        if let Err(error) = runtime.kill_pid(pid, "SIGKILL")
            && runtime.is_pid_alive(pid)
        {
            result.failed_process_pids.push(pid);
            result.errors.push(format!("pid {pid}: {error}"));
            continue;
        }
        if wait_for_pid_exit(
            runtime,
            pid,
            Duration::from_millis(options.process_kill_grace_ms),
        ) {
            result.process_pids.push(pid);
        } else {
            result.failed_process_pids.push(pid);
            result
                .errors
                .push(format!("pid {pid}: still alive after SIGKILL"));
        }
    }

    for pid in result.attempted_process_pids.clone() {
        if !result.failed_process_pids.contains(&pid)
            && !runtime.is_pid_alive(pid)
            && !result.process_pids.contains(&pid)
        {
            result.process_pids.push(pid);
        }
    }

    result.attempted_process_pids = unique_numbers(result.attempted_process_pids);
    result.process_pids = unique_numbers(result.process_pids);
    result.failed_process_pids = unique_numbers(result.failed_process_pids);
    result.attempted_tmux_sessions = unique_strings(result.attempted_tmux_sessions);
    result.tmux_sessions = unique_strings(result.tmux_sessions);
    result.failed_tmux_sessions = unique_strings(result.failed_tmux_sessions);
    result
}

fn has_direct_validation_native_node_entry(args: &str) -> bool {
    let tokens = args.split_whitespace().collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        if *token != "node" && !token.ends_with("/node") {
            continue;
        }
        let mut candidate_index = index + 1;
        while tokens
            .get(candidate_index)
            .is_some_and(|candidate| candidate.starts_with("--"))
        {
            candidate_index += 1;
        }
        let Some(candidate) = tokens.get(candidate_index) else {
            continue;
        };
        if is_validation_native_entry(candidate) {
            return true;
        }
    }
    false
}

fn is_validation_native_entry(path: &str) -> bool {
    let Some(native_tail) = path.split("/.aimux/native/local-").nth(1) else {
        return false;
    };
    let Some((build, rest)) = native_tail.split_once('/') else {
        return false;
    };
    let Some((prefix, suffix)) = build.split_once("-lifecycle-") else {
        return false;
    };
    !prefix.is_empty()
        && prefix.chars().all(|ch| ch.is_ascii_hexdigit())
        && (suffix.starts_with("validate") || suffix.starts_with("visible"))
        && (rest.starts_with("dist/launcher-bin.js") || rest.starts_with("dist/main.js"))
}

fn has_aimux_native_entry(args: &str) -> bool {
    args.contains("/.aimux/native/")
        && (args.contains("/dist/launcher-bin.js") || args.contains("/dist/main.js"))
}

fn has_validation_home(args: &str) -> bool {
    args.contains("/tmp/aimux-home-validate") || args.contains("/tmp/aimux-home-lifecycle")
}

fn is_validation_session_name(session_name: &str) -> bool {
    let body = session_name.strip_prefix("aimux-").unwrap_or(session_name);
    let body = body.strip_prefix("aimux-").unwrap_or(body);
    body.starts_with("lifecycle-validate")
        || body.starts_with("lifecycle-visible")
        || body.starts_with("smoke-lifecycle-validate")
        || body.starts_with("smoke-lifecycle-visible")
}

fn is_validation_option(value: &str) -> bool {
    value.contains("/tmp/aimux-validate")
        || value.contains("/tmp/aimux-lifecycle")
        || value.contains("/tmp/aimux-home-validate")
        || value.contains("/tmp/aimux-home-lifecycle")
}

fn candidate_process_pids(
    processes: &[ProcessArgsEntry],
    parents: &BTreeMap<i32, i32>,
    current_pid: i32,
    live_pane_pids: &BTreeSet<i32>,
) -> Vec<i32> {
    let orphaned_dashboard_pids =
        orphaned_dashboard_pids(processes, parents, current_pid, live_pane_pids);
    unique_numbers(
        processes
            .iter()
            .filter_map(|entry| {
                if entry.pid == current_pid {
                    None
                } else if is_lifecycle_validation_process_args(&entry.args)
                    || orphaned_dashboard_pids.contains(&entry.pid)
                {
                    Some(entry.pid)
                } else {
                    None
                }
            })
            .collect(),
    )
}

fn orphaned_dashboard_pids(
    processes: &[ProcessArgsEntry],
    parents: &BTreeMap<i32, i32>,
    current_pid: i32,
    live_pane_pids: &BTreeSet<i32>,
) -> BTreeSet<i32> {
    let dashboard_processes = processes
        .iter()
        .map(|entry| DashboardProcess {
            pid: entry.pid,
            args: entry.args.clone(),
        })
        .collect::<Vec<_>>();
    crate::dashboard_processes::select_orphaned_dashboards(
        &dashboard_processes,
        parents,
        current_pid,
        live_pane_pids,
    )
    .into_iter()
    .map(|entry| entry.pid)
    .collect()
}

fn is_reapable(
    pid: i32,
    args: &str,
    orphaned_dashboard_pids: &BTreeSet<i32>,
    parents: &BTreeMap<i32, i32>,
    current_pid: i32,
    live_pane_pids: &BTreeSet<i32>,
) -> bool {
    is_lifecycle_validation_process_args(args)
        || (is_dashboard_process_args(args)
            && orphaned_dashboard_pids.contains(&pid)
            && !crate::dashboard_processes::select_orphaned_dashboards(
                &[DashboardProcess {
                    pid,
                    args: args.to_owned(),
                }],
                parents,
                current_pid,
                live_pane_pids,
            )
            .is_empty())
}

fn wait_for_pid_exit(
    runtime: &mut impl LifecycleOrphanRuntime,
    pid: i32,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !runtime.is_pid_alive(pid) {
            return true;
        }
        runtime.sleep_ms(100);
    }
    !runtime.is_pid_alive(pid)
}

fn list_live_tmux_pane_pids() -> BTreeSet<i32> {
    let Ok(output) = Command::new("tmux")
        .args(["list-panes", "-a", "-F", "#{pane_pid}"])
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .output()
    else {
        return BTreeSet::new();
    };
    if !output.status.success() {
        return BTreeSet::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0)
        .collect()
}

fn kill_pid(pid: i32, signal: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        let signal = match signal {
            "SIGTERM" => libc::SIGTERM,
            "SIGKILL" => libc::SIGKILL,
            _ => return Err(format!("unsupported signal {signal}")),
        };
        if unsafe { libc::kill(pid, signal) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }
    #[cfg(not(unix))]
    {
        let status = Command::new("kill")
            .args(["-s", signal, &pid.to_string()])
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("kill exited with {status}"))
        }
    }
}

fn unique_numbers(mut values: Vec<i32>) -> Vec<i32> {
    values.retain(|value| *value > 0);
    values.sort_unstable();
    values.dedup();
    values
}

fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut values = values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[derive(Debug, Default)]
    struct FakeLifecycleRuntime {
        processes: Vec<ProcessArgsEntry>,
        parents: BTreeMap<i32, i32>,
        alive_pids: HashSet<i32>,
        read_args: HashMap<i32, Vec<String>>,
        read_counts: HashMap<i32, usize>,
        tmux_available: bool,
        tmux_sessions: Vec<String>,
        tmux_options: HashMap<(String, String), String>,
        live_pane_pids: BTreeSet<i32>,
        killed_pids: Vec<(i32, String)>,
        killed_sessions: Vec<String>,
        kill_removes_alive: bool,
    }

    impl FakeLifecycleRuntime {
        fn with_kill_removing_alive(mut self) -> Self {
            self.kill_removes_alive = true;
            self
        }

        fn option(mut self, session_name: &str, key: &str, value: &str) -> Self {
            self.tmux_options
                .insert((session_name.to_owned(), key.to_owned()), value.to_owned());
            self
        }
    }

    impl LifecycleOrphanRuntime for FakeLifecycleRuntime {
        fn list_processes(&mut self) -> Vec<ProcessArgsEntry> {
            self.processes.clone()
        }

        fn list_process_parents(&mut self) -> BTreeMap<i32, i32> {
            self.parents.clone()
        }

        fn read_process_args(&mut self, pid: i32) -> Option<String> {
            if let Some(sequence) = self.read_args.get(&pid) {
                let counter = self.read_counts.entry(pid).or_default();
                let index = (*counter).min(sequence.len().saturating_sub(1));
                *counter += 1;
                return sequence.get(index).cloned();
            }
            self.processes
                .iter()
                .find(|entry| entry.pid == pid)
                .map(|entry| entry.args.clone())
        }

        fn is_pid_alive(&mut self, pid: i32) -> bool {
            self.alive_pids.contains(&pid)
        }

        fn kill_pid(&mut self, pid: i32, signal: &str) -> Result<(), String> {
            self.killed_pids.push((pid, signal.to_owned()));
            if self.kill_removes_alive {
                self.alive_pids.remove(&pid);
            }
            Ok(())
        }

        fn sleep_ms(&mut self, _ms: u64) {}

        fn tmux_is_available(&mut self) -> bool {
            self.tmux_available
        }

        fn list_tmux_session_names(&mut self) -> Vec<String> {
            self.tmux_sessions.clone()
        }

        fn get_tmux_session_option(&mut self, session_name: &str, key: &str) -> Option<String> {
            self.tmux_options
                .get(&(session_name.to_owned(), key.to_owned()))
                .cloned()
        }

        fn kill_tmux_session(&mut self, session_name: &str) -> Result<(), String> {
            self.killed_sessions.push(session_name.to_owned());
            Ok(())
        }

        fn list_live_tmux_pane_pids(&mut self) -> BTreeSet<i32> {
            self.live_pane_pids.clone()
        }
    }

    #[test]
    fn lifecycle_cleanup_kills_validation_artifacts_only() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![
                ProcessArgsEntry {
                    pid: 101,
                    args: "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js daemon run daemon".into(),
                },
                ProcessArgsEntry {
                    pid: 202,
                    args: "env AIMUX_HOME=/tmp/aimux-home-validate25 /Users/sam/.aimux/native/current/dist/main.js".into(),
                },
                ProcessArgsEntry {
                    pid: 303,
                    args: "/Users/sam/.aimux/native/current/dist/launcher-bin.js daemon run daemon".into(),
                },
                ProcessArgsEntry {
                    pid: 999,
                    args: "env AIMUX_HOME=/tmp/aimux-home-validate25 current test process".into(),
                },
            ],
            alive_pids: HashSet::from([101, 202]),
            tmux_available: true,
            tmux_sessions: vec![
                "aimux-tealstreet-next-abc".into(),
                "aimux-aimux-lifecycle-validate25".into(),
                "aimux-option-only".into(),
            ],
            ..Default::default()
        }
        .option(
            "aimux-option-only",
            "@aimux-project-state-dir",
            "/tmp/aimux-home-validate25/state",
        )
        .with_kill_removing_alive();

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
            },
        );

        assert_eq!(result.attempted_process_pids, vec![101, 202]);
        assert_eq!(result.process_pids, vec![101, 202]);
        assert_eq!(
            result.attempted_tmux_sessions,
            vec!["aimux-aimux-lifecycle-validate25", "aimux-option-only"]
        );
        assert_eq!(
            runtime.killed_pids,
            vec![(101, "SIGTERM".into()), (202, "SIGTERM".into())]
        );
        assert_eq!(
            runtime.killed_sessions,
            vec!["aimux-aimux-lifecycle-validate25", "aimux-option-only"]
        );
    }

    #[test]
    fn lifecycle_cleanup_never_reaps_live_dashboard_or_agent_or_idle_session() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![
                ProcessArgsEntry {
                    pid: 11,
                    args: "/Users/sam/.aimux/native/local-a/bin/aimux __dashboard-internal-native"
                        .into(),
                },
                ProcessArgsEntry {
                    pid: 12,
                    args: "codex --model gpt-5".into(),
                },
            ],
            parents: BTreeMap::from([(11, 111), (111, 120), (12, 112), (112, 120), (120, 1)]),
            alive_pids: HashSet::from([11, 12]),
            tmux_available: true,
            tmux_sessions: vec!["aimux-real-project".into()],
            live_pane_pids: BTreeSet::from([111, 112]),
            ..Default::default()
        };

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
            },
        );

        assert!(result.attempted_process_pids.is_empty());
        assert!(result.attempted_tmux_sessions.is_empty());
        assert!(runtime.killed_pids.is_empty());
        assert!(runtime.killed_sessions.is_empty());
    }

    #[test]
    fn lifecycle_cleanup_never_reaps_native_dashboard_pane_process() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![ProcessArgsEntry {
                pid: 11,
                args:
                    "/Users/sam/.aimux/native/local-current/bin/aimux __dashboard-internal-native"
                        .into(),
            }],
            parents: BTreeMap::from([(11, 111), (111, 1)]),
            alive_pids: HashSet::from([11]),
            tmux_available: true,
            live_pane_pids: BTreeSet::from([11]),
            ..Default::default()
        };

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
            },
        );

        assert!(result.attempted_process_pids.is_empty());
        assert!(runtime.killed_pids.is_empty());
    }

    #[test]
    fn lifecycle_cleanup_does_not_reap_normal_session_with_lifecycle_words_in_project_path() {
        let mut runtime = FakeLifecycleRuntime {
            tmux_available: true,
            tmux_sessions: vec!["aimux-normal-123".into()],
            ..Default::default()
        }
        .option(
            "aimux-normal-123",
            "@aimux-project-root",
            "/Users/sam/cs/lifecycle-validate-feature",
        );

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
            },
        );

        assert!(result.attempted_tmux_sessions.is_empty());
        assert!(runtime.killed_sessions.is_empty());
    }

    #[test]
    fn lifecycle_cleanup_reaps_dashboard_whose_window_is_gone() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![
                ProcessArgsEntry {
                    pid: 11,
                    args: "/Users/sam/.aimux/native/local-old/bin/aimux __dashboard-internal-native".into(),
                },
                ProcessArgsEntry {
                    pid: 12,
                    args: "/Users/sam/.aimux/native/local-current/bin/aimux __dashboard-internal-native".into(),
                },
                ProcessArgsEntry {
                    pid: 13,
                    args: "/Users/sam/.aimux/native/local-current/bin/aimux __dashboard-internal-native".into(),
                },
            ],
            parents: BTreeMap::from([
                (11, 111),
                (111, 1),
                (12, 112),
                (112, 1),
                (13, 113),
                (113, 900),
                (900, 1),
            ]),
            tmux_available: false,
            ..Default::default()
        }
        .with_kill_removing_alive();

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
            },
        );

        assert_eq!(result.attempted_process_pids, vec![11, 12]);
        assert_eq!(result.process_pids, vec![11, 12]);
        assert_eq!(
            runtime.killed_pids,
            vec![(11, "SIGTERM".into()), (12, "SIGTERM".into())]
        );
    }

    #[test]
    fn lifecycle_cleanup_rereads_before_sigkill_to_avoid_pid_reuse() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![ProcessArgsEntry {
                pid: 101,
                args: "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js daemon run daemon".into(),
            }],
            read_args: HashMap::from([(
                101,
                vec![
                    "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js daemon run daemon".into(),
                    "node /Users/sam/cs/app/server.js".into(),
                ],
            )]),
            alive_pids: HashSet::from([101]),
            ..Default::default()
        };

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
            },
        );

        assert_eq!(result.attempted_process_pids, vec![101]);
        assert_eq!(result.process_pids, Vec::<i32>::new());
        assert_eq!(result.failed_process_pids, vec![101]);
        assert_eq!(
            result.errors,
            vec!["pid 101: command changed before SIGKILL"]
        );
        assert_eq!(runtime.killed_pids, vec![(101, "SIGTERM".into())]);
    }
}
