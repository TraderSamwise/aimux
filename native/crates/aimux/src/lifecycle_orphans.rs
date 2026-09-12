use crate::dashboard_processes::{DashboardProcess, is_dashboard_process_args};
use crate::debug_logging::{LogLevel, log_at};
use crate::process_inspector::{
    ProcessArgsEntry, is_aimux_project_service_process_args, is_pid_alive, list_process_args,
    list_process_parents, process_env_value, read_process_args, read_process_args_with_env,
};
use crate::tmux::{
    TMUX_RUNTIME_OWNER_OPTION, TmuxRuntimeManager, TmuxTarget, TmuxWindowInfo,
    is_dashboard_window_name, tmux_command_from_env,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
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
    pub attempted_tmux_windows: Vec<String>,
    pub tmux_windows: Vec<String>,
    pub failed_tmux_windows: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleOrphanPlan {
    pub process_pids: Vec<i32>,
    pub tmux_sessions: Vec<String>,
    pub tmux_windows: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectServiceOrphanScope {
    pub aimux_home: String,
    pub runtime_owner: String,
    pub recognized_project_roots: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupLifecycleOrphansOptions {
    pub process_exit_timeout_ms: u64,
    pub process_kill_grace_ms: u64,
    pub current_pid: i32,
    pub project_service_scope: Option<ProjectServiceOrphanScope>,
}

impl Default for CleanupLifecycleOrphansOptions {
    fn default() -> Self {
        Self {
            process_exit_timeout_ms: DEFAULT_PROCESS_EXIT_TIMEOUT_MS,
            process_kill_grace_ms: DEFAULT_PROCESS_KILL_GRACE_MS,
            current_pid: std::process::id() as i32,
            project_service_scope: None,
        }
    }
}

pub trait LifecycleOrphanRuntime {
    fn list_processes(&mut self) -> Vec<ProcessArgsEntry>;
    fn list_process_parents(&mut self) -> BTreeMap<i32, i32>;
    fn read_process_args(&mut self, pid: i32) -> Option<String>;
    fn read_process_args_with_env(&mut self, pid: i32) -> Option<String> {
        self.read_process_args(pid)
    }
    fn is_pid_alive(&mut self, pid: i32) -> bool;
    fn kill_pid(&mut self, pid: i32, signal: &str) -> Result<(), String>;
    fn sleep_ms(&mut self, ms: u64);
    fn tmux_is_available(&mut self) -> bool;
    fn list_tmux_session_names(&mut self) -> Vec<String>;
    fn get_tmux_session_option(&mut self, session_name: &str, key: &str) -> Option<String>;
    fn list_tmux_windows(&mut self, session_name: &str) -> Vec<TmuxWindowInfo>;
    fn kill_tmux_window(&mut self, target: &TmuxTarget) -> Result<(), String>;
    fn kill_tmux_session(&mut self, session_name: &str) -> Result<(), String>;
    fn list_live_tmux_pane_pids(&mut self) -> Result<BTreeSet<i32>, String>;
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

    fn read_process_args_with_env(&mut self, pid: i32) -> Option<String> {
        read_process_args_with_env(pid).or_else(|| read_process_args(pid))
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
        self.tmux.list_session_names().unwrap_or_default()
    }

    fn get_tmux_session_option(&mut self, session_name: &str, key: &str) -> Option<String> {
        self.tmux.get_session_option(session_name, key)
    }

    fn list_tmux_windows(&mut self, session_name: &str) -> Vec<TmuxWindowInfo> {
        self.tmux.list_windows(session_name).unwrap_or_default()
    }

    fn kill_tmux_window(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.tmux.kill_window(target)
    }

    fn kill_tmux_session(&mut self, session_name: &str) -> Result<(), String> {
        self.tmux.kill_session(session_name)
    }

    fn list_live_tmux_pane_pids(&mut self) -> Result<BTreeSet<i32>, String> {
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
    plan_lifecycle_validation_orphans_with_scope(runtime, current_pid, None)
}

pub fn plan_lifecycle_validation_orphans_with_scope(
    runtime: &mut impl LifecycleOrphanRuntime,
    current_pid: i32,
    project_service_scope: Option<&ProjectServiceOrphanScope>,
) -> LifecycleOrphanPlan {
    let tmux_available = runtime.tmux_is_available();
    let live_pane_pids = match live_tmux_pane_pids_for_cleanup(runtime, tmux_available) {
        Ok(live_pane_pids) => live_pane_pids,
        Err(error) => {
            return LifecycleOrphanPlan {
                process_pids: Vec::new(),
                tmux_sessions: Vec::new(),
                tmux_windows: Vec::new(),
                errors: vec![error],
            };
        }
    };
    let (tmux_sessions, tmux_windows) =
        if tmux_available {
            let tmux_sessions =
                unique_strings(runtime.list_tmux_session_names().into_iter().filter(
                    |session_name| is_lifecycle_validation_tmux_session(session_name, runtime),
                ));
            let tmux_windows = project_service_scope
                .map(|scope| unrecognized_same_owner_dashboard_windows(runtime, scope))
                .unwrap_or_default();
            (tmux_sessions, tmux_windows)
        } else {
            (Vec::new(), Vec::new())
        };
    let processes = runtime.list_processes();
    let parents = runtime.list_process_parents();
    let process_pids = candidate_process_pids(
        runtime,
        &processes,
        &parents,
        current_pid,
        &live_pane_pids,
        project_service_scope,
    );
    LifecycleOrphanPlan {
        process_pids,
        tmux_sessions,
        tmux_windows,
        errors: Vec::new(),
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
        attempted_tmux_windows: Vec::new(),
        tmux_windows: Vec::new(),
        failed_tmux_windows: Vec::new(),
        errors: Vec::new(),
    };

    let tmux_available = runtime.tmux_is_available();
    let live_pane_pids = match live_tmux_pane_pids_for_cleanup(runtime, tmux_available) {
        Ok(live_pane_pids) => live_pane_pids,
        Err(error) => {
            result.errors.push(error);
            return result;
        }
    };
    if tmux_available {
        let mut killed_sessions = BTreeSet::new();
        for session_name in unique_strings(runtime.list_tmux_session_names()) {
            if !is_lifecycle_validation_tmux_session(&session_name, runtime) {
                continue;
            }
            result.attempted_tmux_sessions.push(session_name.clone());
            match runtime.kill_tmux_session(&session_name) {
                Ok(()) => {
                    killed_sessions.insert(session_name.clone());
                    result.tmux_sessions.push(session_name);
                }
                Err(error) => {
                    result.failed_tmux_sessions.push(session_name.clone());
                    result.errors.push(format!("{session_name}: {error}"));
                }
            }
        }
        if let Some(scope) = options.project_service_scope.as_ref() {
            let mut seen_windows = BTreeSet::new();
            for orphan in unrecognized_same_owner_dashboard_window_targets(runtime, scope) {
                if killed_sessions.contains(&orphan.target.session_name)
                    || !seen_windows.insert(orphan.target.window_id.clone())
                {
                    continue;
                }
                result.attempted_tmux_windows.push(orphan.label.clone());
                match runtime.kill_tmux_window(&orphan.target) {
                    Ok(()) => result.tmux_windows.push(orphan.label),
                    Err(error) => {
                        result.failed_tmux_windows.push(orphan.label.clone());
                        result.errors.push(format!("{}: {error}", orphan.label));
                    }
                }
            }
        }
    }

    let processes = runtime.list_processes();
    let parents = runtime.list_process_parents();
    let candidate_pids = candidate_process_pids(
        runtime,
        &processes,
        &parents,
        options.current_pid,
        &live_pane_pids,
        options.project_service_scope.as_ref(),
    );
    let orphaned_dashboard_pids =
        orphaned_dashboard_pids(&processes, &parents, options.current_pid, &live_pane_pids);

    for pid in candidate_pids {
        let latest_args = runtime.read_process_args_with_env(pid);
        if latest_args.as_deref().is_none_or(|args| {
            !is_reapable(
                pid,
                args,
                &orphaned_dashboard_pids,
                &parents,
                options.current_pid,
                &live_pane_pids,
                options.project_service_scope.as_ref(),
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
        let args_before_kill = runtime.read_process_args_with_env(pid);
        if args_before_kill.as_deref().is_none_or(|args| {
            !is_reapable(
                pid,
                args,
                &orphaned_dashboard_pids,
                &parents,
                options.current_pid,
                &live_pane_pids,
                options.project_service_scope.as_ref(),
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
    result.attempted_tmux_windows = unique_strings(result.attempted_tmux_windows);
    result.tmux_windows = unique_strings(result.tmux_windows);
    result.failed_tmux_windows = unique_strings(result.failed_tmux_windows);
    result
}

fn live_tmux_pane_pids_for_cleanup(
    runtime: &mut impl LifecycleOrphanRuntime,
    tmux_available: bool,
) -> Result<BTreeSet<i32>, String> {
    if !tmux_available {
        return Ok(BTreeSet::new());
    }
    runtime.list_live_tmux_pane_pids().map_err(|error| {
        format!("skipped lifecycle orphan cleanup: tmux live pane inventory failed: {error}")
    })
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct OrphanDashboardWindow {
    target: TmuxTarget,
    label: String,
}

fn unrecognized_same_owner_dashboard_windows(
    runtime: &mut impl LifecycleOrphanRuntime,
    scope: &ProjectServiceOrphanScope,
) -> Vec<String> {
    unrecognized_same_owner_dashboard_window_targets(runtime, scope)
        .into_iter()
        .map(|window| window.label)
        .collect()
}

fn unrecognized_same_owner_dashboard_window_targets(
    runtime: &mut impl LifecycleOrphanRuntime,
    scope: &ProjectServiceOrphanScope,
) -> Vec<OrphanDashboardWindow> {
    let mut windows = Vec::new();
    let mut seen = BTreeSet::new();
    for session_name in unique_strings(runtime.list_tmux_session_names()) {
        let Some(project_root) =
            runtime.get_tmux_session_option(&session_name, "@aimux-project-root")
        else {
            continue;
        };
        if !is_unrecognized_project_root(&project_root, &scope.recognized_project_roots) {
            continue;
        }
        if runtime
            .get_tmux_session_option(&session_name, TMUX_RUNTIME_OWNER_OPTION)
            .as_deref()
            != Some(scope.runtime_owner.as_str())
        {
            continue;
        }
        for window in runtime.list_tmux_windows(&session_name) {
            if !is_dashboard_window_name(&window.name) || !seen.insert(window.id.clone()) {
                continue;
            }
            let label = format!("{}:{}", session_name, window.id);
            windows.push(OrphanDashboardWindow {
                target: TmuxTarget {
                    session_name: session_name.clone(),
                    window_id: window.id,
                    window_index: window.index,
                    window_name: window.name,
                    pane_dead: window.pane_dead,
                },
                label,
            });
        }
    }
    windows
}

fn is_unrecognized_project_root(root: &str, recognized_roots: &BTreeSet<String>) -> bool {
    let root = normalize_path(root);
    !recognized_roots
        .iter()
        .any(|recognized| normalize_path(recognized) == root)
}

fn candidate_process_pids(
    runtime: &mut impl LifecycleOrphanRuntime,
    processes: &[ProcessArgsEntry],
    parents: &BTreeMap<i32, i32>,
    current_pid: i32,
    live_pane_pids: &BTreeSet<i32>,
    project_service_scope: Option<&ProjectServiceOrphanScope>,
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
                    || project_service_scope.is_some_and(|scope| {
                        let args_with_env = runtime
                            .read_process_args_with_env(entry.pid)
                            .unwrap_or_else(|| entry.args.clone());
                        let reapable =
                            is_unrecognized_same_home_project_service(&args_with_env, scope);
                        if reapable {
                            log_project_service_orphan_candidate(entry.pid, &args_with_env);
                        }
                        reapable
                    })
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
    project_service_scope: Option<&ProjectServiceOrphanScope>,
) -> bool {
    is_lifecycle_validation_process_args(args)
        || project_service_scope
            .is_some_and(|scope| is_unrecognized_same_home_project_service(args, scope))
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

fn is_unrecognized_same_home_project_service(
    args: &str,
    scope: &ProjectServiceOrphanScope,
) -> bool {
    if !is_aimux_project_service_process_args(args, None, &Default::default()) {
        return false;
    }
    if !project_service_process_belongs_to_home(args, scope) {
        return false;
    };
    let Some(project_root) = project_service_project_root(args) else {
        return false;
    };
    let project_root = normalize_path(&project_root);
    !scope
        .recognized_project_roots
        .iter()
        .any(|root| normalize_path(root) == project_root)
}

fn log_project_service_orphan_candidate(pid: i32, args: &str) {
    log_at(
        LogLevel::Debug,
        "project service orphan cleanup candidate",
        "lifecycle",
        Some(serde_json::json!({
            "pid": pid,
            "projectRoot": project_service_project_root(args),
            "reason": "same aimux home project service not recognized by daemon state",
        })),
    );
}

fn project_service_process_belongs_to_home(args: &str, scope: &ProjectServiceOrphanScope) -> bool {
    if let Some(process_home) = process_env_value(args, "AIMUX_HOME") {
        return normalize_path(&process_home) == normalize_path(&scope.aimux_home);
    }
    let Some(executable) = project_service_executable(args) else {
        return false;
    };
    path_is_under(
        &normalize_path_buf(&executable),
        &normalize_path_buf(
            &Path::new(&scope.aimux_home)
                .join("native")
                .to_string_lossy(),
        ),
    )
}

fn project_service_executable(args: &str) -> Option<String> {
    let tokens = args.split_whitespace().collect::<Vec<_>>();
    let marker = tokens
        .iter()
        .position(|token| *token == "__project-service-internal")?;
    tokens[..marker]
        .iter()
        .rev()
        .map(|token| trim_shell_quotes(token))
        .find(|token| Path::new(token).file_name().and_then(|name| name.to_str()) == Some("aimux"))
        .map(str::to_owned)
}

fn project_service_project_root(args: &str) -> Option<String> {
    let mut tokens = args.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == "--project-root" {
            let mut value = Vec::new();
            for candidate in tokens.by_ref() {
                if candidate.starts_with("--") || looks_like_env_assignment(candidate) {
                    break;
                }
                value.push(candidate);
            }
            return Some(trim_shell_quotes(&value.join(" ")).to_owned())
                .filter(|value| !value.is_empty());
        }
    }
    None
}

fn looks_like_env_assignment(token: &str) -> bool {
    let Some((key, _)) = token.split_once('=') else {
        return false;
    };
    !key.is_empty()
        && key
            .chars()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
}

fn trim_shell_quotes(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn normalize_path(path: &str) -> String {
    normalize_path_buf(path).to_string_lossy().into_owned()
}

fn normalize_path_buf(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| lexical_absolute_path(Path::new(path)))
}

fn lexical_absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn path_is_under(path: &Path, parent: &Path) -> bool {
    path == parent || path.starts_with(parent)
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

fn list_live_tmux_pane_pids() -> Result<BTreeSet<i32>, String> {
    let output = tmux_command_from_env()
        .args(["list-panes", "-a", "-F", "#{pane_pid}"])
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .output()
        .map_err(|error| format!("failed to run tmux list-panes: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let detail = if stderr.is_empty() {
            output.status.to_string()
        } else {
            format!("{}: {stderr}", output.status)
        };
        return Err(format!("tmux list-panes failed: {detail}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0)
        .collect())
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
        let status = crate::async_subprocess::AsyncCommand::new("kill")
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
        read_args_with_env: HashMap<i32, Vec<String>>,
        read_counts: HashMap<i32, usize>,
        read_with_env_counts: HashMap<i32, usize>,
        tmux_available: bool,
        tmux_sessions: Vec<String>,
        tmux_options: HashMap<(String, String), String>,
        tmux_windows: HashMap<String, Vec<TmuxWindowInfo>>,
        live_pane_pids: BTreeSet<i32>,
        live_pane_pids_error: Option<String>,
        killed_pids: Vec<(i32, String)>,
        killed_sessions: Vec<String>,
        killed_windows: Vec<String>,
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

        fn dashboard_window(mut self, session_name: &str, window_id: &str) -> Self {
            self.tmux_windows
                .entry(session_name.to_owned())
                .or_default()
                .push(TmuxWindowInfo {
                    id: window_id.to_owned(),
                    index: 0,
                    name: "dashboard".to_owned(),
                    active: true,
                    activity: None,
                    pane_dead: None,
                });
            self
        }

        fn read_sequence(
            sequences: &HashMap<i32, Vec<String>>,
            counts: &mut HashMap<i32, usize>,
            pid: i32,
        ) -> Option<String> {
            let sequence = sequences.get(&pid)?;
            let counter = counts.entry(pid).or_default();
            let index = (*counter).min(sequence.len().saturating_sub(1));
            *counter += 1;
            sequence.get(index).cloned()
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
            if let Some(args) = Self::read_sequence(&self.read_args, &mut self.read_counts, pid) {
                return Some(args);
            }
            self.processes
                .iter()
                .find(|entry| entry.pid == pid)
                .map(|entry| entry.args.clone())
        }

        fn read_process_args_with_env(&mut self, pid: i32) -> Option<String> {
            if let Some(args) = Self::read_sequence(
                &self.read_args_with_env,
                &mut self.read_with_env_counts,
                pid,
            ) {
                return Some(args);
            }
            self.read_process_args(pid)
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

        fn list_tmux_windows(&mut self, session_name: &str) -> Vec<TmuxWindowInfo> {
            self.tmux_windows
                .get(session_name)
                .cloned()
                .unwrap_or_default()
        }

        fn kill_tmux_window(&mut self, target: &TmuxTarget) -> Result<(), String> {
            self.killed_windows
                .push(format!("{}:{}", target.session_name, target.window_id));
            Ok(())
        }

        fn kill_tmux_session(&mut self, session_name: &str) -> Result<(), String> {
            self.killed_sessions.push(session_name.to_owned());
            Ok(())
        }

        fn list_live_tmux_pane_pids(&mut self) -> Result<BTreeSet<i32>, String> {
            if let Some(error) = self.live_pane_pids_error.clone() {
                return Err(error);
            }
            Ok(self.live_pane_pids.clone())
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
                project_service_scope: None,
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
                project_service_scope: None,
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
                project_service_scope: None,
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
                project_service_scope: None,
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
                project_service_scope: None,
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
    fn lifecycle_cleanup_skips_all_reaping_when_live_pane_inventory_fails() {
        let mut cleanup_runtime = FakeLifecycleRuntime {
            processes: vec![
                ProcessArgsEntry {
                    pid: 11,
                    args: "/Users/sam/.aimux/native/local-old/bin/aimux __dashboard-internal-native"
                        .into(),
                },
                ProcessArgsEntry {
                    pid: 404,
                    args: "/Users/sam/.aimux/native/local-current/native/darwin-arm64/aimux __project-service-internal --project-id sam-home --project-root /Users/sam".into(),
                },
            ],
            parents: BTreeMap::from([(11, 111), (111, 1)]),
            read_args_with_env: HashMap::from([(
                404,
                vec!["/Users/sam/.aimux/native/local-current/native/darwin-arm64/aimux __project-service-internal --project-id sam-home --project-root /Users/sam AIMUX_HOME=/Users/sam/.aimux".into()],
            )]),
            alive_pids: HashSet::from([11, 404]),
            tmux_available: true,
            tmux_sessions: vec![
                "aimux-aimux-lifecycle-validate25".into(),
                "aimux-sam-5e9c1a8e1d4e".into(),
            ],
            live_pane_pids_error: Some("tmux list-panes exited 1".into()),
            ..Default::default()
        }
        .option(
            "aimux-sam-5e9c1a8e1d4e",
            "@aimux-project-root",
            "/Users/sam",
        )
        .option(
            "aimux-sam-5e9c1a8e1d4e",
            TMUX_RUNTIME_OWNER_OPTION,
            "owner-new",
        )
        .dashboard_window("aimux-sam-5e9c1a8e1d4e", "@1190")
        .with_kill_removing_alive();
        let scope = ProjectServiceOrphanScope {
            aimux_home: "/Users/sam/.aimux".into(),
            runtime_owner: "owner-new".into(),
            recognized_project_roots: BTreeSet::from(["/Users/sam/cs/aimux".into()]),
        };

        let result = cleanup_lifecycle_validation_orphans(
            &mut cleanup_runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
                project_service_scope: Some(scope.clone()),
            },
        );

        assert!(result.attempted_process_pids.is_empty());
        assert!(result.attempted_tmux_sessions.is_empty());
        assert!(result.attempted_tmux_windows.is_empty());
        assert!(cleanup_runtime.killed_pids.is_empty());
        assert!(cleanup_runtime.killed_sessions.is_empty());
        assert!(cleanup_runtime.killed_windows.is_empty());
        assert_eq!(
            result.errors,
            vec![
                "skipped lifecycle orphan cleanup: tmux live pane inventory failed: tmux list-panes exited 1"
            ]
        );

        let mut plan_runtime = FakeLifecycleRuntime {
            tmux_available: true,
            tmux_sessions: vec!["aimux-aimux-lifecycle-validate25".into()],
            live_pane_pids_error: Some("tmux list-panes exited 1".into()),
            ..Default::default()
        }
        .option(
            "aimux-aimux-lifecycle-validate25",
            "@aimux-project-state-dir",
            "/tmp/aimux-home-validate25/state",
        );

        let plan =
            plan_lifecycle_validation_orphans_with_scope(&mut plan_runtime, 999, Some(&scope));

        assert!(plan.process_pids.is_empty());
        assert!(plan.tmux_sessions.is_empty());
        assert!(plan.tmux_windows.is_empty());
        assert_eq!(
            plan.errors,
            vec![
                "skipped lifecycle orphan cleanup: tmux live pane inventory failed: tmux list-panes exited 1"
            ]
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
                project_service_scope: None,
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

    #[test]
    fn lifecycle_cleanup_reaps_same_home_unrecognized_project_service() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![ProcessArgsEntry {
                pid: 404,
                args: "/Users/sam/.aimux/native/local-47a40168/native/darwin-arm64/aimux __project-service-internal --project-id sam-5e9c1a8e1d4e --project-root /Users/sam".into(),
            }],
            read_args_with_env: HashMap::from([(
                404,
                vec!["/Users/sam/.aimux/native/local-47a40168/native/darwin-arm64/aimux __project-service-internal --project-id sam-5e9c1a8e1d4e --project-root /Users/sam AIMUX_HOME=/Users/sam/.aimux".into()],
            )]),
            alive_pids: HashSet::from([404]),
            ..Default::default()
        }
        .with_kill_removing_alive();

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
                project_service_scope: Some(ProjectServiceOrphanScope {
                    aimux_home: "/Users/sam/.aimux".into(),
                    runtime_owner: "owner-new".into(),
                    recognized_project_roots: BTreeSet::from(["/Users/sam/cs/aimux".into()]),
                }),
            },
        );

        assert_eq!(result.attempted_process_pids, vec![404]);
        assert_eq!(result.process_pids, vec![404]);
        assert_eq!(runtime.killed_pids, vec![(404, "SIGTERM".into())]);
    }

    #[test]
    fn lifecycle_cleanup_reaps_current_home_native_service_when_env_read_is_unavailable() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![ProcessArgsEntry {
                pid: 404,
                args: "/Users/sam/.aimux/native/local-47a40168/native/darwin-arm64/aimux __project-service-internal --project-id sam-5e9c1a8e1d4e --project-root /Users/sam".into(),
            }],
            read_args_with_env: HashMap::from([(404, Vec::new())]),
            alive_pids: HashSet::from([404]),
            ..Default::default()
        }
        .with_kill_removing_alive();

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
                project_service_scope: Some(ProjectServiceOrphanScope {
                    aimux_home: "/Users/sam/.aimux".into(),
                    runtime_owner: "owner-new".into(),
                    recognized_project_roots: BTreeSet::from(["/Users/sam/cs/aimux".into()]),
                }),
            },
        );

        assert_eq!(result.attempted_process_pids, vec![404]);
        assert_eq!(result.process_pids, vec![404]);
        assert_eq!(runtime.killed_pids, vec![(404, "SIGTERM".into())]);
    }

    #[test]
    fn lifecycle_cleanup_does_not_reap_foreign_home_project_service() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![ProcessArgsEntry {
                pid: 404,
                args: "AIMUX_HOME=/tmp/aimux-home-isolated /Users/sam/.aimux/native/local-47a40168/native/darwin-arm64/aimux __project-service-internal --project-id sam-5e9c1a8e1d4e --project-root /Users/sam".into(),
            }],
            alive_pids: HashSet::from([404]),
            ..Default::default()
        }
        .with_kill_removing_alive();

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
                project_service_scope: Some(ProjectServiceOrphanScope {
                    aimux_home: "/Users/sam/.aimux".into(),
                    runtime_owner: "owner-new".into(),
                    recognized_project_roots: BTreeSet::new(),
                }),
            },
        );

        assert!(result.attempted_process_pids.is_empty());
        assert!(runtime.killed_pids.is_empty());
    }

    #[test]
    fn lifecycle_cleanup_does_not_reap_recognized_project_service() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![ProcessArgsEntry {
                pid: 404,
                args: "AIMUX_HOME=/Users/sam/.aimux /Users/sam/.aimux/native/local-current/native/darwin-arm64/aimux __project-service-internal --project-id aimux-123 --project-root /Users/sam/cs/aimux".into(),
            }],
            alive_pids: HashSet::from([404]),
            ..Default::default()
        }
        .with_kill_removing_alive();

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
                project_service_scope: Some(ProjectServiceOrphanScope {
                    aimux_home: "/Users/sam/.aimux".into(),
                    runtime_owner: "owner-new".into(),
                    recognized_project_roots: BTreeSet::from(["/Users/sam/cs/aimux".into()]),
                }),
            },
        );

        assert!(result.attempted_process_pids.is_empty());
        assert!(runtime.killed_pids.is_empty());
    }

    #[test]
    fn lifecycle_cleanup_does_not_reap_recognized_project_service_with_spaced_root() {
        let mut runtime = FakeLifecycleRuntime {
            processes: vec![ProcessArgsEntry {
                pid: 404,
                args: "/Users/sam/.aimux/native/local-current/native/darwin-arm64/aimux __project-service-internal --project-id spaced-123 --project-root /Users/sam/cs/Spaced Project AIMUX_HOME=/Users/sam/.aimux PATH=/bin".into(),
            }],
            alive_pids: HashSet::from([404]),
            ..Default::default()
        }
        .with_kill_removing_alive();

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
                project_service_scope: Some(ProjectServiceOrphanScope {
                    aimux_home: "/Users/sam/.aimux".into(),
                    runtime_owner: "owner-new".into(),
                    recognized_project_roots: BTreeSet::from([
                        "/Users/sam/cs/Spaced Project".into()
                    ]),
                }),
            },
        );

        assert!(result.attempted_process_pids.is_empty());
        assert!(runtime.killed_pids.is_empty());
    }

    #[test]
    fn lifecycle_cleanup_reaps_same_owner_dashboard_window_for_unrecognized_project_root() {
        let mut runtime = FakeLifecycleRuntime {
            tmux_available: true,
            tmux_sessions: vec!["aimux-sam-5e9c1a8e1d4e".into()],
            ..Default::default()
        }
        .option(
            "aimux-sam-5e9c1a8e1d4e",
            "@aimux-project-root",
            "/Users/sam",
        )
        .option(
            "aimux-sam-5e9c1a8e1d4e",
            TMUX_RUNTIME_OWNER_OPTION,
            "owner-new",
        )
        .dashboard_window("aimux-sam-5e9c1a8e1d4e", "@1190");

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
                project_service_scope: Some(ProjectServiceOrphanScope {
                    aimux_home: "/Users/sam/.aimux".into(),
                    runtime_owner: "owner-new".into(),
                    recognized_project_roots: BTreeSet::from(["/Users/sam/cs/aimux".into()]),
                }),
            },
        );

        assert_eq!(
            result.attempted_tmux_windows,
            vec!["aimux-sam-5e9c1a8e1d4e:@1190"]
        );
        assert_eq!(result.tmux_windows, vec!["aimux-sam-5e9c1a8e1d4e:@1190"]);
        assert_eq!(runtime.killed_windows, vec!["aimux-sam-5e9c1a8e1d4e:@1190"]);
        assert!(runtime.killed_sessions.is_empty());
    }

    #[test]
    fn lifecycle_cleanup_does_not_reap_foreign_owner_dashboard_window() {
        let mut runtime = FakeLifecycleRuntime {
            tmux_available: true,
            tmux_sessions: vec!["aimux-sam-5e9c1a8e1d4e".into()],
            ..Default::default()
        }
        .option(
            "aimux-sam-5e9c1a8e1d4e",
            "@aimux-project-root",
            "/Users/sam",
        )
        .option(
            "aimux-sam-5e9c1a8e1d4e",
            TMUX_RUNTIME_OWNER_OPTION,
            "owner-foreign",
        )
        .dashboard_window("aimux-sam-5e9c1a8e1d4e", "@1190");

        let result = cleanup_lifecycle_validation_orphans(
            &mut runtime,
            CleanupLifecycleOrphansOptions {
                current_pid: 999,
                process_exit_timeout_ms: 0,
                process_kill_grace_ms: 0,
                project_service_scope: Some(ProjectServiceOrphanScope {
                    aimux_home: "/Users/sam/.aimux".into(),
                    runtime_owner: "owner-new".into(),
                    recognized_project_roots: BTreeSet::from(["/Users/sam/cs/aimux".into()]),
                }),
            },
        );

        assert!(result.attempted_tmux_windows.is_empty());
        assert!(result.tmux_windows.is_empty());
        assert!(runtime.killed_windows.is_empty());
    }
}
