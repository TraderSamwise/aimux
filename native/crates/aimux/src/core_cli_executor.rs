use crate::core_cli::{
    CoreCliAction, CoreCliContext, CoreCliOperation, CoreCliOutputMode, CoreCommandCall,
    CoreCommandOk, classify_core_cli_with_project_resolver,
};
use crate::core_command_client::request_core_command;
use crate::core_command_transport::{DaemonRequestInit, request_daemon_text};
use crate::core_text::{
    core_whoami_json, render_core_daemon_projects_lines, render_core_daemon_status_lines,
    render_core_host_status_lines, render_core_login_lines, render_core_logout_lines,
    render_core_project_ensure_lines, render_core_project_kill_lines,
    render_core_project_restart_lines, render_core_project_serve_lines,
    render_core_project_stop_lines, render_core_projects_list_lines,
    render_core_remote_disable_lines, render_core_remote_enable_lines,
    render_core_remote_status_lines, render_core_security_unlock_lines, render_core_whoami_lines,
};
use crate::daemon_state::EnsureDaemonRunningOptions;
use crate::daemon_state::{AimuxDaemonInfo, DaemonState, load_daemon_info, load_daemon_state};
use crate::daemon_supervisor::ensure_daemon_running;
use crate::logs::{
    LogSelectionOptions, clear_log_file, parse_line_count, read_last_log_lines, selected_log_path,
};
use crate::paths::PathResolver;
use crate::tmux::{attach_session_argv, switch_client_argv};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    fn request_core_command(&mut self, request: &CoreCommandCall) -> Result<CoreCommandOk, String>;
    fn request_daemon_text(&mut self, path: &str) -> Result<String, String>;
    fn selected_log_path(&self, options: &crate::core_cli_routing::CoreLogsArgs) -> PathBuf;
    fn read_log_lines(&self, path: &Path, lines: usize) -> String;
    fn clear_log(&self, path: &Path) -> Result<(), String>;
    fn open_dashboard_target(&mut self, target: &Value) -> Result<(), String>;
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

    fn request_core_command(&mut self, request: &CoreCommandCall) -> Result<CoreCommandOk, String> {
        request_core_command(request.command, request.payload.clone(), request.options)
            .map_err(|error| error.to_string())
    }

    fn request_daemon_text(&mut self, path: &str) -> Result<String, String> {
        ensure_daemon_running(EnsureDaemonRunningOptions::default())
            .map_err(|error| error.to_string())?;
        request_daemon_text(path, DaemonRequestInit::default()).map_err(|error| error.to_string())
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
        match Command::new("tmux").args(argv).status() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("tmux open dashboard exited with {status}")),
            Err(error) => Err(format!("tmux open dashboard failed: {error}")),
        }
    }
}

pub fn run_core_cli(raw_args: &[String]) -> CoreCliExecution {
    let mut runtime = RealCoreCliRuntime;
    run_core_cli_with(raw_args, &mut runtime)
}

pub fn run_core_cli_with(
    raw_args: &[String],
    runtime: &mut impl CoreCliRuntime,
) -> CoreCliExecution {
    let current_project_root = runtime.resolve_project_root(&runtime.cwd());
    let context = CoreCliContext {
        current_project_root,
        daemon_running: runtime.load_daemon_info().is_some(),
        has_credentials: false,
    };
    let plan = match classify_core_cli_with_project_resolver(raw_args, &context, |project| {
        runtime.resolve_project_root(project)
    }) {
        Ok(plan) => plan,
        Err(error) => return CoreCliExecution::error(error.to_string(), error.exit_code()),
    };
    match run_plan(plan.operation, plan.output_mode, plan.action, runtime) {
        Ok(execution) => execution,
        Err(message) => CoreCliExecution::error(format!("Error: {message}"), 1),
    }
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
        CoreCliAction::TextRoute { path } => run_text_route(&path, runtime),
        CoreCliAction::Logs(options) => run_logs(&options, runtime),
        CoreCliAction::RemoteStatus { relay_request } => {
            let relay = match relay_request {
                Some(request) => runtime
                    .request_core_command(&request)
                    .map(|response| response.result["relay"].clone())
                    .unwrap_or_else(|_| json!({ "status": "off" })),
                None => json!({ "status": "off" }),
            };
            let payload = json!({ "loggedIn": false, "relay": relay.clone() });
            render_json_or_lines(
                output_mode,
                payload.clone(),
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
            }
            render_json_or_lines(
                output_mode,
                json!({ "remoteEnabled": false, "daemonDisconnected": daemon_disconnected }),
                render_core_remote_disable_lines(daemon_disconnected),
            )
        }
        CoreCliAction::Whoami => {
            let payload = json!({ "credentials": null });
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
            render_json_or_lines(
                output_mode,
                json!({ "result": "none" }),
                render_core_logout_lines("none"),
            )
        }
        CoreCliAction::Login {
            security_unlock, ..
        } => {
            let message = "remote access is unavailable in the local build";
            if security_unlock {
                let _ = render_core_security_unlock_lines(
                    &json!({ "userId": "", "relay": { "status": "disconnected", "lastError": message } }),
                );
            } else {
                let _ = render_core_login_lines(
                    &json!({ "userId": "", "relay": { "status": "disconnected", "lastError": message } }),
                );
            }
            Err(message.into())
        }
        CoreCliAction::RestartControlPlane { .. } => {
            Err("control-plane restart is not yet ported to native CLI".into())
        }
    }
}

fn run_text_route(
    path: &str,
    runtime: &mut impl CoreCliRuntime,
) -> Result<CoreCliExecution, String> {
    let text = runtime.request_daemon_text(path)?;
    Ok(CoreCliExecution::ok(vec![
        text.strip_suffix('\n').unwrap_or(&text).to_owned(),
    ]))
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
    json!({
        "daemon": info.map(|info| serde_json::to_value(info).expect("daemon info JSON")).unwrap_or(Value::Null),
        "projects": state_projects_with_liveness(state, &BTreeMap::new()),
        "relay": { "status": "off" },
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
