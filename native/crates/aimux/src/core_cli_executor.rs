use crate::backend_session_ids::{
    build_agent_identity_error_payload, build_agent_identity_payload, render_agent_identity_lines,
    resolve_agent_identity,
};
use crate::config::init_project;
use crate::context_compactor::{
    CompactReport, CompactSessionStatus, context_dir, list_history_session_ids, llm_compact,
};
use crate::core_cli::{
    CoreCliAction, CoreCliContext, CoreCliOperation, CoreCliOutputMode, CoreCommandCall,
    CoreCommandOk, CoreCommandRequestOptions, CoreLoopActorContext,
    classify_core_cli_with_project_resolver,
};
use crate::core_command_client::request_core_command;
use crate::core_command_contract::{CORE_API_ROUTES, CORE_COMMAND_NAMES};
use crate::core_command_transport::{DaemonHttpMethod, DaemonRequestInit, request_daemon_text};
use crate::core_text::{
    core_whoami_json, render_core_daemon_projects_lines, render_core_daemon_status_lines,
    render_core_host_status_lines, render_core_login_lines, render_core_logout_lines,
    render_core_project_ensure_lines, render_core_project_kill_lines,
    render_core_project_restart_lines, render_core_project_serve_lines,
    render_core_project_stop_lines, render_core_projects_list_lines,
    render_core_remote_disable_lines, render_core_remote_enable_lines,
    render_core_remote_security_device_mutation_line, render_core_remote_security_devices_lines,
    render_core_remote_status_lines, render_core_security_unlock_lines, render_core_whoami_lines,
};
use crate::daemon::routing::DaemonRouteUrl;
use crate::daemon::text::auth::AuthFlowResult;
use crate::daemon::text::operations::RestartControlPlaneTextResult;
use crate::daemon_state::EnsureDaemonRunningOptions;
use crate::daemon_state::{
    AimuxDaemonInfo, DaemonState, StoppedDaemonInfo, get_daemon_port, load_daemon_info,
    load_daemon_state,
};
use crate::daemon_supervisor::{
    acquire_runtime_restart_permit, assert_not_stopping_newer_daemon, ensure_daemon_running,
    stop_daemon, stop_daemon_process_info,
};
use crate::debug_state::{build_debug_state_report, render_debug_state_report};
use crate::desktop_notifier::{
    DesktopNotificationPayload, build_desktop_notifier_doctor_report, notification_test_json,
    render_desktop_notifier_doctor_report, render_notification_test_failure,
    render_notification_test_success, send_desktop_notification_and_wait,
};
use crate::install_cleanup::{
    DEFAULT_INSTALL_KEEP_RECENT, DEFAULT_INSTALL_RETENTION_DAYS, PlanInstallCleanupOptions,
    RunInstallCleanupInput, is_install_cleanup_dry_run, plan_install_cleanup,
    render_install_cleanup_result, run_install_cleanup,
};
use crate::logs::{
    LogSelectionOptions, clear_log_file, parse_line_count, read_last_log_lines, selected_log_path,
};
use crate::paths::{PathResolver, is_git_project_root, project_checkout_required_message};
use crate::remote_credentials::{clear_credentials, load_credentials, set_remote_enabled};
use crate::remote_login::{LoginAction, run_login_flow};
use crate::remote_security_devices::{list_remote_security_devices, update_remote_security_device};
use crate::runtime_migration::{
    build_runtime_migration_report, import_runtime_migration,
    render_runtime_migration_import_result, render_runtime_migration_report,
    render_runtime_migration_rollback_result, rollback_runtime_migration,
};
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};
use crate::tmux::{attach_session_argv, switch_client_argv, tmux_command_from_env};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreCliExecution {
    pub code: i32,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

impl CoreCliExecution {
    fn ok(stdout: Vec<String>) -> Self {
        Self {
            code: 0,
            stdout,
            stderr: Vec::new(),
        }
    }

    fn error(message: impl Into<String>, code: i32) -> Self {
        Self {
            code,
            stdout: Vec::new(),
            stderr: vec![message.into()],
        }
    }
}

pub trait CoreCliRuntime {
    fn cwd(&self) -> String;
    fn resolve_project_root(&self, path: &str) -> String;
    fn load_daemon_info(&self) -> Option<AimuxDaemonInfo>;
    fn load_daemon_state(&self) -> DaemonState;
    fn has_remote_credentials(&self) -> bool;
    fn loop_actor_context(&self) -> CoreLoopActorContext;
    fn credentials_for_status(&self) -> Option<Value>;
    fn whoami_payload(&self) -> Value;
    fn set_remote_enabled(&self, enabled: bool) -> Result<(), String>;
    fn clear_credentials(&self) -> String;
    fn run_login_flow(&self, security_unlock: bool) -> Result<AuthFlowResult, String>;
    fn list_remote_security_devices(&self, pending: bool) -> Result<Vec<Value>, String>;
    fn update_remote_security_device(
        &self,
        device_id: &str,
        action: &str,
        approval_code: Option<&str>,
    ) -> Result<Value, String>;
    fn request_core_command(&mut self, request: &CoreCommandCall) -> Result<CoreCommandOk, String>;
    fn request_daemon_text(&mut self, path: &str, body: Option<Value>) -> Result<String, String>;
    fn selected_log_path(&self, options: &crate::core_cli_routing::CoreLogsArgs) -> PathBuf;
    fn read_log_lines(&self, path: &Path, lines: usize) -> String;
    fn clear_log(&self, path: &Path) -> Result<(), String>;
    fn init_project(&self, project_root: &str) -> Result<(), String>;
    fn is_git_project_root(&self, project_root: &str) -> bool;
    fn runtime_topology_path(&self, project_root: &str) -> PathBuf;
    fn read_text_file(&self, path: &Path) -> Result<String, String>;
    fn read_runtime_topology(&self, path: &Path) -> Result<Value, String>;
    fn open_dashboard_target(&mut self, target: &Value) -> Result<(), String>;
    fn restart_control_plane(
        &mut self,
        project_root: Option<&str>,
        force: bool,
    ) -> Result<RestartControlPlaneTextResult, String>;
    fn emit_restart_progress(&mut self, _message: &str) {}
    fn stop_daemon(&mut self, signal: &str) -> Result<Option<StoppedDaemonInfo>, String>;
    fn debug_state_report(&self, target: &str) -> Result<String, String>;
    fn runtime_migration_audit(&self, project_root: &str) -> Result<String, String>;
    fn runtime_migration_import(&self, project_root: &str) -> Result<String, String>;
    fn runtime_migration_rollback(&self, manifest: &str) -> Result<String, String>;
    fn desktop_notifier_doctor_report(&self) -> Result<Value, String>;
    fn desktop_notifier_doctor_text(&self) -> Result<String, String>;
    fn send_desktop_notification_test(
        &self,
        title: &str,
        body: &str,
        open_url: Option<&str>,
    ) -> Result<Value, String>;
}

#[derive(Debug, Default)]
pub struct RealCoreCliRuntime;

impl CoreCliRuntime for RealCoreCliRuntime {
    fn cwd(&self) -> String {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .to_string_lossy()
            .into_owned()
    }

    fn resolve_project_root(&self, path: &str) -> String {
        let mut resolver = PathResolver::from_env();
        resolver
            .resolve_repo_root(path)
            .to_string_lossy()
            .into_owned()
    }

    fn load_daemon_info(&self) -> Option<AimuxDaemonInfo> {
        let resolver = PathResolver::from_env();
        load_daemon_info(resolver.daemon_info_path())
    }

    fn load_daemon_state(&self) -> DaemonState {
        let resolver = PathResolver::from_env();
        load_daemon_state(resolver.daemon_state_path())
    }

    fn has_remote_credentials(&self) -> bool {
        let resolver = PathResolver::from_env();
        load_credentials(&resolver).is_some()
    }

    fn loop_actor_context(&self) -> CoreLoopActorContext {
        CoreLoopActorContext::from_env()
    }

    fn credentials_for_status(&self) -> Option<Value> {
        let resolver = PathResolver::from_env();
        load_credentials(&resolver).map(|credentials| {
            json!({
                "relayUrl": credentials.relay_url,
                "remoteEnabled": credentials.remote_enabled,
            })
        })
    }

    fn whoami_payload(&self) -> Value {
        let resolver = PathResolver::from_env();
        let credentials = load_credentials(&resolver).map(|credentials| {
            json!({
                "userId": credentials.user_id,
                "relayUrl": credentials.relay_url,
                "remoteEnabled": credentials.remote_enabled,
            })
        });
        json!({ "credentials": credentials })
    }

    fn set_remote_enabled(&self, enabled: bool) -> Result<(), String> {
        let resolver = PathResolver::from_env();
        set_remote_enabled(&resolver, enabled)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn clear_credentials(&self) -> String {
        let resolver = PathResolver::from_env();
        clear_credentials(&resolver).as_str().into()
    }

    fn run_login_flow(&self, security_unlock: bool) -> Result<AuthFlowResult, String> {
        let resolver = PathResolver::from_env();
        let result = run_login_flow(
            &resolver,
            if security_unlock {
                LoginAction::SecurityUnlock
            } else {
                LoginAction::Login
            },
        )?;
        Ok(AuthFlowResult {
            user_id: result.user_id,
            relay: Value::Null,
            messages: result.messages,
        })
    }

    fn list_remote_security_devices(&self, pending: bool) -> Result<Vec<Value>, String> {
        list_remote_security_devices(pending)
    }

    fn update_remote_security_device(
        &self,
        device_id: &str,
        action: &str,
        approval_code: Option<&str>,
    ) -> Result<Value, String> {
        update_remote_security_device(device_id, action, approval_code)
    }

    fn request_core_command(&mut self, request: &CoreCommandCall) -> Result<CoreCommandOk, String> {
        request_core_command(request.command, request.payload.clone(), request.options)
            .map_err(|error| error.to_string())
    }

    fn request_daemon_text(&mut self, path: &str, body: Option<Value>) -> Result<String, String> {
        ensure_daemon_running(EnsureDaemonRunningOptions::default())
            .map_err(|error| error.to_string())?;
        let method = daemon_text_route_method(path, body.as_ref());
        request_daemon_text(
            path,
            DaemonRequestInit {
                method: Some(method),
                body: body.map(|value| value.to_string()),
                ..DaemonRequestInit::default()
            },
        )
        .map_err(|error| error.to_string())
    }

    fn selected_log_path(&self, options: &crate::core_cli_routing::CoreLogsArgs) -> PathBuf {
        let mut resolver = PathResolver::from_env();
        selected_log_path(
            &mut resolver,
            &LogSelectionOptions {
                daemon: options.daemon,
                project: options.project.clone(),
            },
        )
    }

    fn read_log_lines(&self, path: &Path, lines: usize) -> String {
        read_last_log_lines(path, lines)
    }

    fn clear_log(&self, path: &Path) -> Result<(), String> {
        clear_log_file(path).map_err(|error| error.to_string())
    }

    fn init_project(&self, project_root: &str) -> Result<(), String> {
        init_project(project_root)
    }

    fn is_git_project_root(&self, project_root: &str) -> bool {
        is_git_project_root(project_root)
    }

    fn runtime_topology_path(&self, project_root: &str) -> PathBuf {
        let mut resolver = PathResolver::from_env();
        runtime_topology_path(resolver.project_state_dir_for(project_root))
    }

    fn read_text_file(&self, path: &Path) -> Result<String, String> {
        fs::read_to_string(path).map_err(|error| error.to_string())
    }

    fn read_runtime_topology(&self, path: &Path) -> Result<Value, String> {
        read_runtime_topology(path)
    }

    fn open_dashboard_target(&mut self, target: &Value) -> Result<(), String> {
        let session_name = target
            .get("sessionName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "dashboard target sessionName is required".to_owned())?;
        let window_index = target
            .get("windowIndex")
            .and_then(Value::as_i64)
            .ok_or_else(|| "dashboard target windowIndex is required".to_owned())?;
        let argv = if std::env::var_os("TMUX").is_some() {
            switch_client_argv(session_name, window_index, None)
        } else {
            attach_session_argv(session_name, Some(window_index))
        };
        match tmux_command_from_env().args(argv).status() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("tmux open dashboard exited with {status}")),
            Err(error) => Err(format!("tmux open dashboard failed: {error}")),
        }
    }

    fn restart_control_plane(
        &mut self,
        project_root: Option<&str>,
        force: bool,
    ) -> Result<RestartControlPlaneTextResult, String> {
        restart_control_plane_from_cli(project_root, force)
    }

    fn emit_restart_progress(&mut self, message: &str) {
        let mut stderr = std::io::stderr();
        let _ = writeln!(stderr, "{message}");
        let _ = stderr.flush();
    }

    fn stop_daemon(&mut self, signal: &str) -> Result<Option<StoppedDaemonInfo>, String> {
        stop_daemon(signal).map_err(|error| error.to_string())
    }

    fn debug_state_report(&self, target: &str) -> Result<String, String> {
        let report = build_debug_state_report(self.cwd(), target);
        render_debug_state_report(&report).map_err(|error| error.to_string())
    }

    fn runtime_migration_audit(&self, project_root: &str) -> Result<String, String> {
        let report = build_runtime_migration_report(project_root, None);
        render_runtime_migration_report(&report).map_err(|error| error.to_string())
    }

    fn runtime_migration_import(&self, project_root: &str) -> Result<String, String> {
        let result =
            import_runtime_migration(project_root, None).map_err(|error| error.to_string())?;
        render_runtime_migration_import_result(&result).map_err(|error| error.to_string())
    }

    fn runtime_migration_rollback(&self, manifest: &str) -> Result<String, String> {
        let manifest_path = resolve_path_from(&self.cwd(), manifest);
        let manifest =
            rollback_runtime_migration(manifest_path).map_err(|error| error.to_string())?;
        render_runtime_migration_rollback_result(&manifest).map_err(|error| error.to_string())
    }

    fn desktop_notifier_doctor_report(&self) -> Result<Value, String> {
        serde_json::to_value(build_desktop_notifier_doctor_report())
            .map_err(|error| error.to_string())
    }

    fn desktop_notifier_doctor_text(&self) -> Result<String, String> {
        Ok(render_desktop_notifier_doctor_report(
            &build_desktop_notifier_doctor_report(),
        ))
    }

    fn send_desktop_notification_test(
        &self,
        title: &str,
        body: &str,
        open_url: Option<&str>,
    ) -> Result<Value, String> {
        let attempt = send_desktop_notification_and_wait(&DesktopNotificationPayload {
            title: title.to_owned(),
            message: body.to_owned(),
            sound: true,
            deep_link_url: open_url.map(str::to_owned),
        });
        Ok(notification_test_json(&attempt))
    }
}

fn daemon_text_route_method(path: &str, body: Option<&Value>) -> DaemonHttpMethod {
    if body.is_some() {
        return DaemonHttpMethod::Post;
    }
    let pathname = path.split('?').next().unwrap_or(path);
    if POST_TEXT_ROUTES.contains(&pathname) {
        DaemonHttpMethod::Post
    } else {
        DaemonHttpMethod::Get
    }
}

const POST_TEXT_ROUTES: &[&str] = &[
    CORE_API_ROUTES.agent_input_text,
    CORE_API_ROUTES.agent_migrate_text,
    CORE_API_ROUTES.agent_rename_text,
    CORE_API_ROUTES.attachment_publish_text,
    CORE_API_ROUTES.dashboard_reload_text,
    CORE_API_ROUTES.graveyard_cleanup_text,
    CORE_API_ROUTES.graveyard_resurrect_text,
    CORE_API_ROUTES.graveyard_send_text,
    CORE_API_ROUTES.handoff_accept_text,
    CORE_API_ROUTES.handoff_complete_text,
    CORE_API_ROUTES.handoff_send_text,
    CORE_API_ROUTES.lifecycle_fork_text,
    CORE_API_ROUTES.lifecycle_kill_text,
    CORE_API_ROUTES.lifecycle_spawn_text,
    CORE_API_ROUTES.lifecycle_stop_text,
    CORE_API_ROUTES.login_start_text,
    CORE_API_ROUTES.login_text,
    CORE_API_ROUTES.login_wait_text,
    CORE_API_ROUTES.logout_text,
    CORE_API_ROUTES.logs_clear_text,
    CORE_API_ROUTES.metadata_text,
    CORE_API_ROUTES.loop_add_text,
    CORE_API_ROUTES.loop_block_text,
    CORE_API_ROUTES.loop_done_text,
    CORE_API_ROUTES.loop_remove_text,
    CORE_API_ROUTES.message_send_text,
    CORE_API_ROUTES.notification_clear_text,
    CORE_API_ROUTES.notification_read_text,
    CORE_API_ROUTES.notification_send_text,
    CORE_API_ROUTES.outline_update_text,
    CORE_API_ROUTES.overseer_clear_text,
    CORE_API_ROUTES.overseer_start_text,
    CORE_API_ROUTES.project_ensure_text,
    CORE_API_ROUTES.project_kill_text,
    CORE_API_ROUTES.project_restart_text,
    CORE_API_ROUTES.project_serve_text,
    CORE_API_ROUTES.project_stop_text,
    CORE_API_ROUTES.projects_remove_text,
    CORE_API_ROUTES.remote_disable_text,
    CORE_API_ROUTES.remote_enable_text,
    CORE_API_ROUTES.repair_exchange_text,
    CORE_API_ROUTES.repair_text,
    CORE_API_ROUTES.restart_text,
    CORE_API_ROUTES.review_approve_text,
    CORE_API_ROUTES.review_request_changes_text,
    CORE_API_ROUTES.runtime_restart_text,
    CORE_API_ROUTES.scribe_clear_text,
    CORE_API_ROUTES.scribe_start_text,
    CORE_API_ROUTES.security_unlock_start_text,
    CORE_API_ROUTES.security_unlock_text,
    CORE_API_ROUTES.security_unlock_wait_text,
    CORE_API_ROUTES.task_accept_text,
    CORE_API_ROUTES.task_assign_text,
    CORE_API_ROUTES.task_block_text,
    CORE_API_ROUTES.task_cancel_text,
    CORE_API_ROUTES.task_complete_text,
    CORE_API_ROUTES.task_reopen_text,
    CORE_API_ROUTES.team_add_text,
    CORE_API_ROUTES.team_default_text,
    CORE_API_ROUTES.team_init_text,
    CORE_API_ROUTES.team_remove_text,
    CORE_API_ROUTES.thread_mark_seen_text,
    CORE_API_ROUTES.thread_open_text,
    CORE_API_ROUTES.thread_send_text,
    CORE_API_ROUTES.thread_status_text,
    CORE_API_ROUTES.worktree_cache_cleanup_text,
    CORE_API_ROUTES.worktree_create_text,
    CORE_API_ROUTES.worktree_delete_graveyard_text,
    CORE_API_ROUTES.worktree_graveyard_text,
    CORE_API_ROUTES.worktree_remove_text,
    CORE_API_ROUTES.worktree_resurrect_text,
    crate::native_cli_dispatch::CORE_SERVICE_CREATE_TEXT_ROUTE,
];

fn restart_control_plane_from_cli(
    project_root: Option<&str>,
    force: bool,
) -> Result<RestartControlPlaneTextResult, String> {
    let _ = get_daemon_port()?;
    let resolver = PathResolver::from_env();
    crate::daemon::runtime::preflight_restart_backend_id_capture(&resolver, project_root, force)?;
    let restart_lock = acquire_runtime_restart_permit(&resolver, None)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "aimux restart lock was not acquired".to_owned())?;
    let restart_lock_owner_pid = restart_lock.owner_pid();
    let daemon_info = load_daemon_info(resolver.daemon_info_path());
    let should_stop_daemon = daemon_info.is_some();

    restart_control_plane_from_cli_with_lock_owner(
        project_root,
        force,
        Some(restart_lock_owner_pid),
        RestartControlPlaneCliDeps {
            should_stop_daemon,
            assert_not_stopping_newer_daemon: || {
                assert_not_stopping_newer_daemon().map_err(|error| error.to_string())
            },
            stop_daemon_process: || {
                let info = daemon_info
                    .as_ref()
                    .ok_or_else(|| "daemon info missing".to_owned())?;
                stop_daemon_process_info(&resolver, info, "SIGTERM")
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
            ensure_daemon_running: || {
                ensure_daemon_running(EnsureDaemonRunningOptions {
                    adopt_existing: Some(false),
                })
                .map(|_| ())
                .map_err(|error| error.to_string())
            },
            request_core_command: |command, payload, options| {
                request_core_command(command, payload, options).map_err(|error| error.to_string())
            },
        },
    )
}

#[doc(hidden)]
pub struct RestartControlPlaneCliDeps<AssertNewer, StopDaemon, EnsureDaemon, RequestRestart> {
    pub should_stop_daemon: bool,
    pub assert_not_stopping_newer_daemon: AssertNewer,
    pub stop_daemon_process: StopDaemon,
    pub ensure_daemon_running: EnsureDaemon,
    pub request_core_command: RequestRestart,
}

#[doc(hidden)]
pub fn restart_control_plane_from_cli_with<AssertNewer, StopDaemon, EnsureDaemon, RequestRestart>(
    project_root: Option<&str>,
    deps: RestartControlPlaneCliDeps<AssertNewer, StopDaemon, EnsureDaemon, RequestRestart>,
) -> Result<RestartControlPlaneTextResult, String>
where
    AssertNewer: FnMut() -> Result<(), String>,
    StopDaemon: FnMut() -> Result<(), String>,
    EnsureDaemon: FnMut() -> Result<(), String>,
    RequestRestart: FnMut(
        &'static str,
        Option<Value>,
        CoreCommandRequestOptions,
    ) -> Result<CoreCommandOk, String>,
{
    restart_control_plane_from_cli_with_lock_owner(project_root, false, None, deps)
}

#[doc(hidden)]
pub fn restart_control_plane_from_cli_with_lock_owner<
    AssertNewer,
    StopDaemon,
    EnsureDaemon,
    RequestRestart,
>(
    project_root: Option<&str>,
    force: bool,
    restart_lock_owner_pid: Option<i32>,
    deps: RestartControlPlaneCliDeps<AssertNewer, StopDaemon, EnsureDaemon, RequestRestart>,
) -> Result<RestartControlPlaneTextResult, String>
where
    AssertNewer: FnMut() -> Result<(), String>,
    StopDaemon: FnMut() -> Result<(), String>,
    EnsureDaemon: FnMut() -> Result<(), String>,
    RequestRestart: FnMut(
        &'static str,
        Option<Value>,
        CoreCommandRequestOptions,
    ) -> Result<CoreCommandOk, String>,
{
    let RestartControlPlaneCliDeps {
        should_stop_daemon,
        mut assert_not_stopping_newer_daemon,
        mut stop_daemon_process,
        mut ensure_daemon_running,
        mut request_core_command,
    } = deps;

    if should_stop_daemon {
        assert_not_stopping_newer_daemon()?;
        stop_daemon_process()?;
    }
    ensure_daemon_running()?;
    let mut payload = Map::new();
    if let Some(project_root) = project_root {
        payload.insert("projectRoot".into(), json!(project_root));
    }
    if force {
        payload.insert("force".into(), json!(true));
    }
    payload.insert("backendIdCapturePrechecked".into(), json!(true));
    if let Some(owner_pid) = restart_lock_owner_pid {
        payload.insert("restartLockOwnerPid".into(), json!(owner_pid));
    }
    let response = request_core_command(
        CORE_COMMAND_NAMES.restart,
        (!payload.is_empty()).then_some(Value::Object(payload)),
        CoreCommandRequestOptions {
            ensure_daemon: false,
            timeout_ms: None,
        },
    )?;
    let restart = response
        .result
        .get("restart")
        .cloned()
        .unwrap_or(Value::Null);
    let text = response
        .result
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| "Aimux Restart\n  failures: 0".into());
    Ok(RestartControlPlaneTextResult { restart, text })
}

pub fn run_core_cli(raw_args: &[String]) -> CoreCliExecution {
    let mut runtime = RealCoreCliRuntime;
    run_core_cli_with(raw_args, &mut runtime)
}

pub fn run_core_cli_with(
    raw_args: &[String],
    runtime: &mut impl CoreCliRuntime,
) -> CoreCliExecution {
    let current_working_dir = runtime.cwd();
    let current_project_root = runtime.resolve_project_root(&current_working_dir);
    let context = CoreCliContext {
        current_working_dir,
        current_project_root,
        daemon_running: runtime.load_daemon_info().is_some(),
        has_credentials: runtime.has_remote_credentials(),
        loop_actor: runtime.loop_actor_context(),
    };
    let mut plan = match classify_core_cli_with_project_resolver(raw_args, &context, |project| {
        runtime.resolve_project_root(project)
    }) {
        Ok(plan) => plan,
        Err(error) => return CoreCliExecution::error(error.to_string(), error.exit_code()),
    };
    if operation_requires_current_git_project(plan.operation)
        && !runtime.is_git_project_root(&context.current_project_root)
    {
        return CoreCliExecution::error(
            project_checkout_required_message(&context.current_project_root),
            1,
        );
    }
    if let Some(project_root) = materialized_project_root_requiring_checkout(&plan)
        && !runtime.is_git_project_root(&project_root)
    {
        return CoreCliExecution::error(project_checkout_required_message(project_root), 1);
    }
    scope_bare_restart_to_current_project(&mut plan, &context, runtime);
    match run_plan(plan.operation, plan.output_mode, plan.action, runtime) {
        Ok(execution) => execution,
        Err(message) => CoreCliExecution::error(format!("Error: {message}"), 1),
    }
}

fn scope_bare_restart_to_current_project(
    plan: &mut crate::core_cli::CoreCliPlan,
    context: &CoreCliContext,
    runtime: &impl CoreCliRuntime,
) {
    if plan.operation != CoreCliOperation::Restart {
        return;
    }
    let CoreCliAction::RestartControlPlane {
        project_root, all, ..
    } = &mut plan.action
    else {
        return;
    };
    if *all {
        return;
    }
    if project_root.is_some() || !runtime.is_git_project_root(&context.current_project_root) {
        return;
    }
    *project_root = Some(context.current_project_root.clone());
}

fn operation_requires_current_git_project(operation: CoreCliOperation) -> bool {
    matches!(
        operation,
        CoreCliOperation::AgentMigrate
            | CoreCliOperation::WorktreeList
            | CoreCliOperation::WorktreeCreate
            | CoreCliOperation::WorktreeCacheCleanup
            | CoreCliOperation::WorktreeRemove
            | CoreCliOperation::WorktreeGraveyard
            | CoreCliOperation::WorktreeResurrect
            | CoreCliOperation::WorktreeDeleteGraveyard
            | CoreCliOperation::GraveyardList
            | CoreCliOperation::GraveyardSend
            | CoreCliOperation::GraveyardResurrect
            | CoreCliOperation::GraveyardCleanup
    )
}

fn materialized_project_root_requiring_checkout(
    plan: &crate::core_cli::CoreCliPlan,
) -> Option<String> {
    if non_materializing_project_root_operation(plan.operation) {
        return None;
    }
    action_project_root(&plan.action)
}

fn non_materializing_project_root_operation(operation: CoreCliOperation) -> bool {
    matches!(
        operation,
        CoreCliOperation::HostStop
            | CoreCliOperation::HostKill
            | CoreCliOperation::LifecycleStop
            | CoreCliOperation::LifecycleKill
            | CoreCliOperation::ProjectsRemove
    )
}

fn action_project_root(action: &CoreCliAction) -> Option<String> {
    match action {
        CoreCliAction::Command { request, .. } => request
            .payload
            .as_ref()
            .and_then(project_root_value)
            .and_then(Value::as_str)
            .map(str::to_owned),
        CoreCliAction::TextRoute { path, body } => body
            .as_ref()
            .and_then(project_root_value)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                DaemonRouteUrl::parse(path)
                    .search_param("project")
                    .map(str::to_owned)
            }),
        _ => None,
    }
}

fn project_root_value(payload: &Value) -> Option<&Value> {
    payload
        .get("projectRoot")
        .or_else(|| payload.get("project"))
}

fn run_plan(
    operation: CoreCliOperation,
    output_mode: CoreCliOutputMode,
    action: CoreCliAction,
    runtime: &mut impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    match action {
        CoreCliAction::Command {
            request,
            open_dashboard_after,
        } => run_command_action(
            operation,
            output_mode,
            &request,
            open_dashboard_after,
            runtime,
        ),
        CoreCliAction::TextRoute { path, body } => run_text_route(&path, body, runtime),
        CoreCliAction::Logs(options) => run_logs(&options, runtime),
        CoreCliAction::InitProject => run_init_project(runtime),
        CoreCliAction::HostTopology { json, raw } => run_host_topology(json, raw, runtime),
        CoreCliAction::AgentIdentity {
            project_root,
            session_id,
        } => run_agent_identity(output_mode, &project_root, &session_id, runtime),
        CoreCliAction::Compact { project_root } => run_compact(&project_root),
        CoreCliAction::RemoteStatus { relay_request } => {
            let credentials = runtime.credentials_for_status();
            let relay = match relay_request {
                Some(request) => runtime
                    .request_core_command(&request)
                    .map(|response| response.result["relay"].clone())
                    .unwrap_or_else(|_| json!({ "status": "off" })),
                None => json!({ "status": "off" }),
            };
            let payload = json!({ "credentials": credentials, "relay": relay.clone() });
            render_json_or_lines(
                output_mode,
                json!({ "loggedIn": payload.get("credentials").is_some_and(|value| !value.is_null()), "relay": relay }),
                render_core_remote_status_lines(&payload),
            )
        }
        CoreCliAction::RemoteEnable { relay_request } => {
            let Some(request) = relay_request else {
                return Ok(CoreCliExecution::error(
                    "Not logged in. Run `aimux login` first.",
                    1,
                ));
            };
            let response = runtime.request_core_command(&request)?;
            render_json_or_lines(
                output_mode,
                json!({ "relay": response.result["relay"].clone() }),
                render_core_remote_enable_lines(&response.result["relay"]),
            )
        }
        CoreCliAction::RemoteDisable { relay_request } => {
            let daemon_disconnected = relay_request.is_some();
            if let Some(request) = relay_request {
                runtime.request_core_command(&request)?;
            } else {
                runtime.set_remote_enabled(false)?;
            }
            render_json_or_lines(
                output_mode,
                json!({ "remoteEnabled": false, "daemonDisconnected": daemon_disconnected }),
                render_core_remote_disable_lines(daemon_disconnected),
            )
        }
        CoreCliAction::Whoami => {
            let payload = runtime.whoami_payload();
            render_json_or_lines(
                output_mode,
                core_whoami_json(&payload),
                render_core_whoami_lines(&payload),
            )
        }
        CoreCliAction::Logout { relay_disable } => {
            if let Some(request) = relay_disable {
                let _ = runtime.request_core_command(&request);
            }
            let result = runtime.clear_credentials();
            render_json_or_lines(
                output_mode,
                json!({ "result": result }),
                render_core_logout_lines(&result),
            )
        }
        CoreCliAction::Login {
            security_unlock,
            relay_enable,
        } => {
            let result = runtime.run_login_flow(security_unlock)?;
            let relay = match relay_enable {
                Some(request) => runtime
                    .request_core_command(&request)
                    .map(|response| response.result["relay"].clone())
                    .unwrap_or_else(|error| {
                        json!({
                            "status": "disconnected",
                            "relayUrl": "",
                            "lastConnectedAt": Value::Null,
                            "lastError": error,
                        })
                    }),
                None => json!({ "status": "off" }),
            };
            let payload = json!({ "userId": result.user_id, "relay": relay });
            let mut lines = result.messages;
            if security_unlock {
                lines.extend(render_core_security_unlock_lines(&payload));
            } else {
                lines.extend(render_core_login_lines(&payload));
            }
            Ok(CoreCliExecution::ok(lines))
        }
        CoreCliAction::SecurityDevices { json } => {
            run_security_devices(json, false, output_mode, runtime)
        }
        CoreCliAction::SecurityDeviceApproveLive { device_id, json } => {
            run_security_device_approve_live(device_id.as_deref(), json, output_mode, runtime)
        }
        CoreCliAction::SecurityDeviceUpdate {
            device_id,
            action,
            approval_code,
            json,
        } => run_security_device_update(
            &device_id,
            action,
            approval_code.as_deref(),
            json,
            output_mode,
            runtime,
        ),
        CoreCliAction::RestartControlPlane {
            project_root,
            force,
            ..
        } => run_restart_control_plane(project_root.as_deref(), force, output_mode, runtime),
        CoreCliAction::StopDaemon { signal } => run_stop_daemon(output_mode, signal, runtime),
        CoreCliAction::DebugState { target } => {
            let text = runtime.debug_state_report(&target)?;
            Ok(CoreCliExecution::ok(vec![text]))
        }
        CoreCliAction::InstallCleanup {
            fix,
            retention_days,
            keep_recent,
        } => run_install_cleanup_action(output_mode, fix, retention_days, keep_recent),
        CoreCliAction::RuntimeMigrationAudit { project_root } => Ok(CoreCliExecution::ok(vec![
            runtime.runtime_migration_audit(&project_root)?,
        ])),
        CoreCliAction::RuntimeMigrationImport { project_root } => Ok(CoreCliExecution::ok(vec![
            runtime.runtime_migration_import(&project_root)?,
        ])),
        CoreCliAction::RuntimeMigrationRollback { manifest } => Ok(CoreCliExecution::ok(vec![
            runtime.runtime_migration_rollback(&manifest)?,
        ])),
        CoreCliAction::DoctorNotifications => run_doctor_notifications(output_mode, runtime),
        CoreCliAction::NotificationTest {
            title,
            body,
            open_url,
        } => run_notification_test(output_mode, &title, &body, open_url.as_deref(), runtime),
    }
}

fn run_security_devices(
    json_flag: bool,
    pending: bool,
    output_mode: CoreCliOutputMode,
    runtime: &impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let devices = runtime.list_remote_security_devices(pending)?;
    if json_flag || output_mode == CoreCliOutputMode::Json {
        return Ok(CoreCliExecution::ok(vec![
            serde_json::to_string_pretty(&json!({ "devices": devices }))
                .map_err(|error| error.to_string())?,
        ]));
    }
    Ok(CoreCliExecution::ok(
        render_core_remote_security_devices_lines(&devices),
    ))
}

fn run_security_device_approve_live(
    device_id: Option<&str>,
    json_flag: bool,
    output_mode: CoreCliOutputMode,
    runtime: &impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let devices = runtime.list_remote_security_devices(true)?;
    let candidates = if let Some(device_id) = device_id {
        devices
            .into_iter()
            .filter(|device| {
                [device.get("id"), device.get("deviceId")]
                    .into_iter()
                    .flatten()
                    .any(|value| value.as_str() == Some(device_id))
            })
            .collect::<Vec<_>>()
    } else {
        devices
    };
    if candidates.is_empty() {
        if json_flag || output_mode == CoreCliOutputMode::Json {
            return Ok(CoreCliExecution::ok(vec![
                serde_json::to_string_pretty(
                    &json!({ "ok": false, "devices": [], "error": "No live remote clients are waiting for approval" }),
                )
                .map_err(|error| error.to_string())?,
            ]));
        }
        let message = device_id
            .map(|device_id| {
                format!("No live remote client is waiting for approval as {device_id}.")
            })
            .unwrap_or_else(|| "No live remote clients are waiting for approval.".into());
        return Ok(CoreCliExecution::ok(vec![message]));
    }
    Err("Interactive approval requires a TTY. Run `aimux security device approve` in a terminal and type the code shown on the waiting device.".into())
}

fn run_security_device_update(
    device_id: &str,
    action: &str,
    approval_code: Option<&str>,
    json_flag: bool,
    output_mode: CoreCliOutputMode,
    runtime: &impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let device = runtime.update_remote_security_device(device_id, action, approval_code)?;
    if json_flag || output_mode == CoreCliOutputMode::Json {
        return Ok(CoreCliExecution::ok(vec![
            serde_json::to_string_pretty(&json!({ "device": device }))
                .map_err(|error| error.to_string())?,
        ]));
    }
    Ok(CoreCliExecution::ok(vec![
        render_core_remote_security_device_mutation_line(action, &device),
    ]))
}

fn resolve_path_from(cwd: &str, path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        PathBuf::from(cwd).join(path)
    }
}

fn run_doctor_notifications(
    output_mode: CoreCliOutputMode,
    runtime: &impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    match output_mode {
        CoreCliOutputMode::Json => Ok(CoreCliExecution::ok(vec![
            serde_json::to_string_pretty(&runtime.desktop_notifier_doctor_report()?)
                .map_err(|error| error.to_string())?,
        ])),
        CoreCliOutputMode::Text => Ok(CoreCliExecution::ok(vec![
            runtime.desktop_notifier_doctor_text()?,
        ])),
    }
}

fn run_notification_test(
    output_mode: CoreCliOutputMode,
    title: &str,
    body: &str,
    open_url: Option<&str>,
    runtime: &impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let payload = runtime.send_desktop_notification_test(title, body, open_url)?;
    let ok = payload.get("ok").and_then(Value::as_bool) == Some(true);
    if output_mode == CoreCliOutputMode::Json {
        return Ok(CoreCliExecution {
            code: if ok { 0 } else { 1 },
            stdout: vec![
                serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
            ],
            stderr: Vec::new(),
        });
    }
    let attempt = payload.get("attempt").cloned().unwrap_or(Value::Null);
    let text = if ok {
        render_notification_test_success_value(&attempt)
    } else {
        render_notification_test_failure_value(&attempt)
    };
    Ok(CoreCliExecution {
        code: if ok { 0 } else { 1 },
        stdout: if ok { vec![text.clone()] } else { Vec::new() },
        stderr: if ok { Vec::new() } else { vec![text] },
    })
}

fn render_notification_test_success_value(attempt: &Value) -> String {
    serde_json::from_value(attempt.clone())
        .map(|attempt| render_notification_test_success(&attempt))
        .unwrap_or_else(|_| "Sent notification via unknown.".into())
}

fn render_notification_test_failure_value(attempt: &Value) -> String {
    serde_json::from_value(attempt.clone())
        .map(|attempt| render_notification_test_failure(&attempt))
        .unwrap_or_else(|_| "Failed to send notification via unknown.".into())
}

fn run_stop_daemon(
    output_mode: CoreCliOutputMode,
    signal: &str,
    runtime: &mut impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let stopped = runtime.stop_daemon(signal)?;
    let payload = json!({ "stopped": stopped });
    render_json_or_lines(
        output_mode,
        payload,
        render_stop_daemon_lines(signal, stopped.as_ref()),
    )
}

fn render_stop_daemon_lines(signal: &str, stopped: Option<&StoppedDaemonInfo>) -> Vec<String> {
    let Some(stopped) = stopped else {
        return vec!["Aimux daemon not running".to_owned()];
    };
    let verb = if signal == "SIGKILL" {
        "Killed"
    } else {
        "Stopped"
    };
    let mut lines = vec![format!("{verb} aimux daemon pid {}", stopped.daemon.pid)];
    if !stopped.stopped_project_services.is_empty() {
        lines.push(format!(
            "{verb} {} project services",
            stopped.stopped_project_services.len()
        ));
    }
    lines
}

fn run_install_cleanup_action(
    output_mode: CoreCliOutputMode,
    fix: bool,
    retention_days: Option<String>,
    keep_recent: Option<String>,
) -> Result<CoreCliExecution, String> {
    let plan = plan_install_cleanup(PlanInstallCleanupOptions {
        retention_days: Some(parse_count(
            retention_days.as_deref(),
            DEFAULT_INSTALL_RETENTION_DAYS,
        )),
        keep_recent: Some(parse_count(
            keep_recent.as_deref(),
            DEFAULT_INSTALL_KEEP_RECENT,
        )),
        ..PlanInstallCleanupOptions::default()
    });
    let result = run_install_cleanup(
        plan,
        RunInstallCleanupInput {
            dry_run: Some(is_install_cleanup_dry_run(fix)),
            ..RunInstallCleanupInput::default()
        },
    );
    match output_mode {
        CoreCliOutputMode::Json => Ok(CoreCliExecution::ok(vec![
            serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?,
        ])),
        CoreCliOutputMode::Text => Ok(CoreCliExecution::ok(vec![render_install_cleanup_result(
            &result,
        )])),
    }
}

fn parse_count<T>(raw: Option<&str>, fallback: T) -> T
where
    T: TryFrom<u64> + Copy,
{
    raw.and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| T::try_from(value).ok())
        .unwrap_or(fallback)
}

fn run_restart_control_plane(
    project_root: Option<&str>,
    force: bool,
    output_mode: CoreCliOutputMode,
    runtime: &mut impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    if matches!(output_mode, CoreCliOutputMode::Text) {
        runtime.emit_restart_progress("Restarting Aimux control plane...");
    }
    let result = runtime.restart_control_plane(project_root, force)?;
    let failures = result
        .restart
        .get("summary")
        .and_then(|summary| summary.get("failures"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let stdout = match output_mode {
        CoreCliOutputMode::Json => {
            vec![serde_json::to_string_pretty(&result.restart).map_err(|error| error.to_string())?]
        }
        CoreCliOutputMode::Text => vec![result.text],
    };
    Ok(CoreCliExecution {
        code: if failures > 0 { 1 } else { 0 },
        stdout,
        stderr: Vec::new(),
    })
}

fn run_text_route(
    path: &str,
    body: Option<Value>,
    runtime: &mut impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let text = runtime.request_daemon_text(path, body)?;
    Ok(CoreCliExecution::ok(vec![
        text.strip_suffix('\n').unwrap_or(&text).to_owned(),
    ]))
}

fn run_init_project(runtime: &mut impl CoreCliRuntime) -> Result<CoreCliExecution, String> {
    let project_root = runtime.resolve_project_root(&runtime.cwd());
    runtime.init_project(&project_root)?;
    Ok(CoreCliExecution::ok(vec![
        "Initialized .aimux/ with config.json and .gitignore".into(),
    ]))
}

fn run_host_topology(
    json_mode: bool,
    raw: bool,
    runtime: &mut impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let project_root = runtime.resolve_project_root(&runtime.cwd());
    let path = runtime.runtime_topology_path(&project_root);
    if json_mode {
        let topology = runtime.read_runtime_topology(&path)?;
        return Ok(CoreCliExecution::ok(vec![
            serde_json::to_string_pretty(&topology).map_err(|error| error.to_string())?,
        ]));
    }
    if raw {
        let text = runtime.read_text_file(&path)?;
        return Ok(CoreCliExecution::ok(vec![
            text.strip_suffix('\n').unwrap_or(&text).to_owned(),
        ]));
    }
    Ok(CoreCliExecution::ok(vec![
        path.to_string_lossy().into_owned(),
    ]))
}

fn run_agent_identity(
    output_mode: CoreCliOutputMode,
    project_root: &str,
    session_id: &str,
    runtime: &impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let path = runtime.runtime_topology_path(project_root);
    let topology = runtime.read_runtime_topology(&path)?;
    match resolve_agent_identity(project_root, session_id, &topology) {
        Ok(identity) => {
            let payload = build_agent_identity_payload(project_root, &identity);
            render_json_or_lines(
                output_mode,
                payload.clone(),
                render_agent_identity_lines(&payload),
            )
        }
        Err(error) if output_mode == CoreCliOutputMode::Json => Ok(CoreCliExecution {
            code: 1,
            stdout: vec![
                serde_json::to_string_pretty(&build_agent_identity_error_payload(
                    project_root,
                    &error,
                ))
                .map_err(|error| error.to_string())?,
            ],
            stderr: Vec::new(),
        }),
        Err(error) => Ok(CoreCliExecution::error(
            format!("Error: {}", error.reason),
            1,
        )),
    }
}

fn run_compact(project_root: &str) -> Result<CoreCliExecution, String> {
    let session_ids = match list_history_session_ids(project_root) {
        Ok(session_ids) => session_ids,
        Err(message) => return Ok(CoreCliExecution::error(message, 1)),
    };
    let report = llm_compact(project_root, &session_ids);
    Ok(render_compact_report(
        project_root,
        session_ids.len(),
        &report,
    ))
}

fn render_compact_report(
    project_root: &str,
    requested_sessions: usize,
    report: &CompactReport,
) -> CoreCliExecution {
    let mut stdout = vec![format!(
        "Compacting history for {requested_sessions} session(s)..."
    )];
    let compacted = report.compacted_count();
    let skipped = report.skipped_count();
    let failed = report.failed_count();
    if compacted > 0 {
        stdout.push(format!(
            "Done. Summaries written for {compacted} of {requested_sessions} session(s) under {}.",
            context_dir(project_root).display()
        ));
    } else {
        stdout.push(format!(
            "No summaries written. Found {requested_sessions} history session(s), compacted 0, skipped {skipped}, failed {failed}."
        ));
    }
    if skipped > 0 {
        stdout.push(format!("Skipped {skipped} session(s):"));
        for session in &report.sessions {
            if let CompactSessionStatus::Skipped { reason } = &session.status {
                stdout.push(format!("- {}: {reason}", session.session_id));
            }
        }
    }
    if failed == 0 && compacted > 0 {
        return CoreCliExecution::ok(stdout);
    }

    let mut stderr = Vec::new();
    if failed > 0 {
        stderr.push(format!("Compaction failed for {failed} session(s):"));
        for session in &report.sessions {
            if let CompactSessionStatus::Failed { reason } = &session.status {
                stderr.push(format!("- {}: {reason}", session.session_id));
            }
        }
    } else {
        stderr.push("No compactable history turns were found.".into());
    }
    CoreCliExecution {
        code: 1,
        stdout,
        stderr,
    }
}

fn run_command_action(
    operation: CoreCliOperation,
    output_mode: CoreCliOutputMode,
    request: &CoreCommandCall,
    open_dashboard_after: bool,
    runtime: &mut impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    if operation == CoreCliOperation::DaemonStatus {
        return Ok(run_daemon_status(output_mode, request, runtime));
    }
    let response = runtime.request_core_command(request)?;
    match operation {
        CoreCliOperation::HostStatus => run_host_status(output_mode, response.result, runtime),
        CoreCliOperation::DaemonEnsure => render_json_or_lines(
            output_mode,
            json!({ "daemon": response.result["daemon"].clone() }),
            vec![format!(
                "aimux daemon: pid {} on http://127.0.0.1:{}",
                js_string(&response.result["daemon"]["pid"]),
                js_string(&response.result["daemon"]["port"])
            )],
        ),
        CoreCliOperation::DaemonProjects => render_json_or_lines(
            output_mode,
            json!({ "projects": response.result["projects"].clone() }),
            render_core_daemon_projects_lines(&response.result["projects"]),
        ),
        CoreCliOperation::DaemonProjectEnsure => render_json_or_lines(
            output_mode,
            json!({ "project": response.result["project"].clone() }),
            render_core_project_ensure_lines(
                &json!({ "project": response.result["project"].clone() }),
            ),
        ),
        CoreCliOperation::ProjectsList => render_json_or_lines(
            output_mode,
            json!({ "projects": response.result["projects"].clone() }),
            render_core_projects_list_lines(&response.result["projects"]),
        ),
        CoreCliOperation::ProjectServe => render_json_or_lines(
            output_mode,
            json!({ "project": response.result["project"].clone() }),
            render_core_project_serve_lines(
                &json!({ "project": response.result["project"].clone() }),
            ),
        ),
        CoreCliOperation::HostStop => render_json_or_lines(
            output_mode,
            json!({ "projectRoot": payload_field(request, "projectRoot"), "project": response.result["project"].clone() }),
            render_core_project_stop_lines(
                &json!({ "projectRoot": payload_field(request, "projectRoot"), "project": response.result["project"].clone() }),
            ),
        ),
        CoreCliOperation::HostKill => render_json_or_lines(
            output_mode,
            json!({ "projectRoot": payload_field(request, "projectRoot"), "project": response.result["project"].clone() }),
            render_core_project_kill_lines(
                &json!({ "projectRoot": payload_field(request, "projectRoot"), "project": response.result["project"].clone() }),
            ),
        ),
        CoreCliOperation::HostRestart => {
            let payload = json!({
                "projectRoot": payload_field(request, "projectRoot"),
                "project": response.result["project"].clone(),
                "dashboardSessionName": response.result["dashboardSessionName"].clone(),
                "dashboardTarget": response.result["dashboardTarget"].clone(),
            });
            if open_dashboard_after {
                runtime.open_dashboard_target(&payload["dashboardTarget"])?;
            }
            let execution = render_json_or_lines(
                output_mode,
                payload.clone(),
                render_core_project_restart_lines(&payload),
            )?;
            Ok(execution)
        }
        _ => render_json_or_lines(output_mode, response.result.clone(), vec![]),
    }
}

fn run_host_status(
    output_mode: CoreCliOutputMode,
    status: Value,
    runtime: &mut impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let project_root = runtime.resolve_project_root(&runtime.cwd());
    let project = find_core_project(&status["projects"], &project_root);
    let payload = json!({
        "projectRoot": project_root,
        "sessionName": project.as_ref().and_then(|project| project.get("dashboardSessionName")).cloned().unwrap_or(Value::Null),
        "daemon": status["daemon"].clone(),
        "projectService": project.as_ref().and_then(|project| project.get("service")).cloned().unwrap_or(Value::Null),
        "serviceAlive": project.as_ref().and_then(|project| project.get("serviceAlive")).and_then(Value::as_bool).unwrap_or(false),
        "metadataEndpoint": project.as_ref().and_then(|project| project.get("serviceEndpoint")).cloned().unwrap_or(Value::Null),
        "expectedServiceManifest": status["daemon"]["serviceInfo"].clone(),
    });
    render_json_or_lines(
        output_mode,
        payload.clone(),
        render_core_host_status_lines(&payload, project.is_some()),
    )
}

fn run_daemon_status(
    output_mode: CoreCliOutputMode,
    request: &CoreCommandCall,
    runtime: &mut impl CoreCliRuntime,
) -> CoreCliExecution {
    let info = runtime.load_daemon_info();
    let state = runtime.load_daemon_state();
    let payload = match runtime.request_core_command(request) {
        Ok(response) => daemon_status_payload(response.result, state, info),
        Err(_) => daemon_status_fallback_payload(info, state),
    };
    render_json_or_lines(
        output_mode,
        payload.clone(),
        render_core_daemon_status_lines(&payload),
    )
    .expect("daemon status rendering is infallible")
}

fn daemon_status_payload(
    status: Value,
    state: DaemonState,
    info: Option<AimuxDaemonInfo>,
) -> Value {
    let project_service_fleet = project_service_fleet_from_status(&status, &state);
    let service_alive_by_id = status["projects"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|project| {
            Some((
                project.get("id")?.as_str()?.to_owned(),
                project.get("serviceAlive").and_then(Value::as_bool) == Some(true),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    json!({
        "daemon": status.get("daemon").cloned().or_else(|| info.map(|info| serde_json::to_value(info).expect("daemon info JSON"))).unwrap_or(Value::Null),
        "projects": state_projects_with_liveness(state, &service_alive_by_id),
        "projectServiceFleet": project_service_fleet,
        "relay": status.get("relay").cloned().unwrap_or_else(|| json!({ "status": "off" })),
    })
}

fn payload_field(request: &CoreCommandCall, key: &str) -> Value {
    request
        .payload
        .as_ref()
        .and_then(|payload| payload.get(key))
        .cloned()
        .unwrap_or(Value::Null)
}

fn daemon_status_fallback_payload(info: Option<AimuxDaemonInfo>, state: DaemonState) -> Value {
    let project_service_fleet =
        project_service_fleet_from_status(&json!({ "projects": [] }), &state);
    json!({
        "daemon": info.map(|info| serde_json::to_value(info).expect("daemon info JSON")).unwrap_or(Value::Null),
        "projects": state_projects_with_liveness(state, &BTreeMap::new()),
        "projectServiceFleet": project_service_fleet,
        "relay": { "status": "off" },
    })
}

fn project_service_fleet_from_status(status: &Value, state: &DaemonState) -> Value {
    if let Some(fleet) = status.get("projectServiceFleet") {
        return fleet.clone();
    }
    let projects = status["projects"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let catalog_project_ids = projects
        .iter()
        .filter_map(|project| project.get("id").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    let live_project_service_count = projects
        .iter()
        .filter(|project| project.get("serviceAlive").and_then(Value::as_bool) == Some(true))
        .count();
    json!({
        "catalogProjectCount": projects.len(),
        "liveProjectServiceCount": live_project_service_count,
        "coldCatalogProjectCount": projects.len().saturating_sub(live_project_service_count),
        "daemonStateProjectCount": state.projects.len(),
        "staleDaemonStateProjectCount": state
            .projects
            .keys()
            .filter(|project_id| !catalog_project_ids.contains(project_id.as_str()))
            .count(),
    })
}

fn state_projects_with_liveness(state: DaemonState, live: &BTreeMap<String, bool>) -> Vec<Value> {
    state
        .projects
        .into_iter()
        .map(|(id, value)| {
            let mut object = match value {
                Value::Object(object) => object,
                _ => Map::new(),
            };
            object.insert(
                "serviceAlive".into(),
                Value::Bool(live.get(&id).copied().unwrap_or(false)),
            );
            Value::Object(object)
        })
        .collect()
}

fn run_logs(
    options: &crate::core_cli_routing::CoreLogsArgs,
    runtime: &mut impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let path = runtime.selected_log_path(options);
    match options.subcommand {
        crate::core_cli_routing::CoreLogsSubcommand::Path => Ok(CoreCliExecution::ok(vec![
            path.to_string_lossy().into_owned(),
        ])),
        crate::core_cli_routing::CoreLogsSubcommand::Tail => {
            let output = runtime.read_log_lines(&path, parse_line_count(options.lines.as_deref()));
            if output.is_empty() {
                Ok(CoreCliExecution::error(
                    format!("No log entries at {}", path.display()),
                    1,
                ))
            } else {
                Ok(CoreCliExecution::ok(vec![output]))
            }
        }
        crate::core_cli_routing::CoreLogsSubcommand::Clear => {
            runtime.clear_log(&path)?;
            Ok(CoreCliExecution::ok(vec![format!(
                "Cleared {}",
                path.display()
            )]))
        }
    }
}

fn render_json_or_lines(
    output_mode: CoreCliOutputMode,
    json_value: Value,
    lines: Vec<String>,
) -> Result<CoreCliExecution, String> {
    if output_mode == CoreCliOutputMode::Json {
        Ok(CoreCliExecution::ok(vec![
            serde_json::to_string_pretty(&json_value).map_err(|error| error.to_string())?,
        ]))
    } else {
        Ok(CoreCliExecution::ok(lines))
    }
}

fn find_core_project(projects: &Value, project_root: &str) -> Option<Value> {
    let resolved_root = normalize_path(project_root);
    projects.as_array()?.iter().find_map(|project| {
        let path = project.get("path").and_then(Value::as_str)?;
        (normalize_path(path) == resolved_root).then_some(project.clone())
    })
}

fn normalize_path(path: &str) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| {
            let path = Path::new(path);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            }
        })
        .to_string_lossy()
        .into_owned()
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn cli_restart_delegates_project_work_to_daemon_restart_command() {
        let calls = RefCell::new(Vec::<Value>::new());

        let result = restart_control_plane_from_cli_with_lock_owner(
            None,
            true,
            Some(12_345),
            RestartControlPlaneCliDeps {
                should_stop_daemon: true,
                assert_not_stopping_newer_daemon: || {
                    calls.borrow_mut().push(json!({ "fn": "assert-not-stale" }));
                    Ok(())
                },
                stop_daemon_process: || {
                    calls
                        .borrow_mut()
                        .push(json!({ "fn": "stop-daemon-process" }));
                    Ok(())
                },
                ensure_daemon_running: || {
                    calls
                        .borrow_mut()
                        .push(json!({ "fn": "ensure-daemon fresh" }));
                    Ok(())
                },
                request_core_command:
                    |command: &'static str,
                     payload: Option<Value>,
                     options: CoreCommandRequestOptions| {
                        calls.borrow_mut().push(json!({
                            "fn": "request",
                            "command": command,
                            "payload": payload.unwrap_or(Value::Null),
                            "ensureDaemon": options.ensure_daemon,
                            "timeoutMs": options.timeout_ms,
                        }));
                        Ok(CoreCommandOk {
                            ok: true,
                            id: "test".into(),
                            command: command.into(),
                            issued_at: "2026-01-01T00:00:00.000Z".into(),
                            result: json!({
                                "restart": { "summary": { "failures": 0 } },
                                "text": "restart text",
                            }),
                        })
                    },
            },
        )
        .expect("restart bootstrap succeeds");

        assert_eq!(result.text, "restart text");
        assert_eq!(
            calls.into_inner(),
            vec![
                json!({ "fn": "assert-not-stale" }),
                json!({ "fn": "stop-daemon-process" }),
                json!({ "fn": "ensure-daemon fresh" }),
                json!({
                    "fn": "request",
                    "command": "core.restart",
                    "payload": {
                        "force": true,
                        "backendIdCapturePrechecked": true,
                        "restartLockOwnerPid": 12345,
                    },
                    "ensureDaemon": false,
                    "timeoutMs": Value::Null,
                }),
            ]
        );
    }

    #[test]
    fn daemon_text_route_method_matches_route_handlers() {
        assert_eq!(
            daemon_text_route_method("/core/project-stop-text?project=%2Frepo&json=1", None),
            DaemonHttpMethod::Post
        );
        assert_eq!(
            daemon_text_route_method("/core/projects-remove-text?project=%2Frepo&json=1", None),
            DaemonHttpMethod::Post
        );
        assert_eq!(
            daemon_text_route_method(
                "/core/metadata-text?project=%2Frepo&arg=metadata&arg=endpoint",
                None
            ),
            DaemonHttpMethod::Post
        );
        assert_eq!(
            daemon_text_route_method("/core/projects-list-text?json=1", None),
            DaemonHttpMethod::Get
        );
        assert_eq!(
            daemon_text_route_method("/core/host-agent-read-text?sessionId=one", None),
            DaemonHttpMethod::Get
        );
        assert_eq!(
            daemon_text_route_method(
                "/core/agents/input-text",
                Some(&json!({ "sessionId": "one", "text": "hi" })),
            ),
            DaemonHttpMethod::Post
        );
    }
}
