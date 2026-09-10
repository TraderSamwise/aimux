use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::paths::PathResolver;
use crate::tmux::{
    AIMUX_TMUX_RUNTIME_CONTRACT_VERSION, TMUX_DASHBOARD_OWNER_OPTION, TMUX_RUNTIME_CONTRACT_OPTION,
    TMUX_RUNTIME_OWNER_OPTION, is_dashboard_window_name, is_tmux_client_session_for_host,
    project_session,
};

#[derive(Debug, Clone)]
pub struct RuntimeCoherenceTmuxWindow {
    pub id: String,
    pub index: i64,
    pub name: String,
    pub active: bool,
}

#[derive(Debug, Clone)]
pub struct RuntimeCoherenceTmux {
    pub available: bool,
    pub version: Option<String>,
    pub session_names: Vec<String>,
    pub session_options: BTreeMap<String, BTreeMap<String, Option<String>>>,
    pub windows: BTreeMap<String, Vec<RuntimeCoherenceTmuxWindow>>,
    pub window_options: BTreeMap<String, BTreeMap<String, Option<String>>>,
    pub window_alive: BTreeMap<String, bool>,
    pub pane_start_commands: BTreeMap<String, Option<String>>,
}

impl Default for RuntimeCoherenceTmux {
    fn default() -> Self {
        Self {
            available: true,
            version: Some("tmux 3.5a".into()),
            session_names: Vec::new(),
            session_options: BTreeMap::new(),
            windows: BTreeMap::new(),
            window_options: BTreeMap::new(),
            window_alive: BTreeMap::new(),
            pane_start_commands: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeCoherenceHealth {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Clone)]
pub enum RuntimeCoherenceHealthProbe {
    Ok(RuntimeCoherenceHealth),
    Err(String),
}

#[derive(Debug, Clone)]
pub struct RuntimeCoherenceInput {
    pub generated_at: String,
    pub cli_version: String,
    pub build_profile: String,
    pub cli_launch: Value,
    pub expected_project_service: Value,
    pub expected_runtime_owner: String,
    pub daemon_info: Option<Value>,
    pub daemon_projects: BTreeMap<String, Value>,
    pub endpoints: BTreeMap<String, Option<Value>>,
    pub health: BTreeMap<String, Vec<RuntimeCoherenceHealthProbe>>,
    pub tmux: RuntimeCoherenceTmux,
    pub dashboard_build_stamps: BTreeMap<String, String>,
    pub process_args: BTreeMap<i64, Option<String>>,
    pub process_list: Vec<Value>,
}

pub fn build_runtime_coherence_report(input: RuntimeCoherenceInput) -> Value {
    let mut resolver = PathResolver::from_env();
    build_runtime_coherence_report_with_resolver(input, &mut resolver)
}

pub fn build_runtime_coherence_report_with_resolver(
    input: RuntimeCoherenceInput,
    resolver: &mut PathResolver,
) -> Value {
    let session_names = if input.tmux.available {
        input.tmux.session_names.clone()
    } else {
        Vec::new()
    };
    let known_projects = collect_known_projects(&input, &session_names);
    let mut projects = Vec::new();

    for project_root in known_projects {
        let expected_dashboard_build_stamp = input
            .dashboard_build_stamps
            .get(&project_root.project_root)
            .cloned()
            .unwrap_or_else(|| "dashboard-new".into());
        let endpoint = input
            .endpoints
            .get(&project_root.project_root)
            .cloned()
            .flatten();
        let expected_state_dir = resolver
            .project_state_dir_for(&project_root.project_root)
            .to_string_lossy()
            .into_owned();
        let mut service = read_project_service_health(
            endpoint,
            &input.expected_project_service,
            &input.health,
            &expected_state_dir,
        );
        let daemon_state =
            find_project_daemon_state(&input.daemon_projects, &project_root.project_root);
        service["daemonState"] = daemon_state.clone().unwrap_or(Value::Null);
        let pid = service.get("pid").and_then(Value::as_i64);
        service["process"] = build_process_report(
            pid,
            pid.and_then(|pid| input.process_args.get(&pid).cloned().flatten()),
            &input.cli_launch,
            None,
        )
        .unwrap_or(Value::Null);
        if service["endpoint"].is_null() && daemon_state.is_some() {
            service["status"] = json!("unreachable");
            service["pid"] = daemon_state
                .as_ref()
                .and_then(|state| state.get("pid"))
                .cloned()
                .unwrap_or(Value::Null);
            service["error"] = json!("daemon state exists but project service endpoint is missing");
        }

        let dashboards = list_dashboard_reports(
            &input,
            &session_names,
            &project_root.project_root,
            &expected_dashboard_build_stamp,
        );
        let runtime = read_project_runtime_report(&input.tmux, &project_root.project_root);
        let status = project_status(&runtime, &service, &dashboards);
        projects.push(json!({
            "projectRoot": project_root.project_root,
            "sources": project_root.sources,
            "expectedDashboardBuildStamp": expected_dashboard_build_stamp,
            "runtime": runtime,
            "service": service,
            "dashboards": dashboards,
            "status": status,
        }));
    }

    let ok = projects
        .iter()
        .filter(|project| project.get("status").and_then(Value::as_str) == Some("ok"))
        .count();
    let stopped = projects
        .iter()
        .filter(|project| project.get("status").and_then(Value::as_str) == Some("stopped"))
        .count();
    let inactive = projects
        .iter()
        .filter(|project| project.get("status").and_then(Value::as_str) == Some("inactive"))
        .count();
    let needs_attention = projects
        .iter()
        .filter(|project| project.get("status").and_then(Value::as_str) == Some("needs-attention"))
        .count();
    let runtime_rebuild_required = projects
        .iter()
        .filter(|project| {
            project
                .get("runtime")
                .and_then(|runtime| runtime.get("rebuildRequired"))
                .and_then(Value::as_bool)
                == Some(true)
        })
        .count();
    let daemon_process = input.daemon_info.as_ref().and_then(|info| {
        let pid = info.get("pid").and_then(Value::as_i64);
        build_process_report(
            pid,
            pid.and_then(|pid| input.process_args.get(&pid).cloned().flatten()),
            &input.cli_launch,
            None,
        )
    });
    json!({
        "generatedAt": input.generated_at,
        "cliVersion": input.cli_version,
        "buildProfile": input.build_profile,
        "cliLaunch": input.cli_launch,
        "expected": {
            "projectService": input.expected_project_service,
            "runtimeOwner": input.expected_runtime_owner,
            "runtimeContract": AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
        },
        "daemon": {
            "running": input.daemon_info.is_some(),
            "info": input.daemon_info.unwrap_or(Value::Null),
            "process": daemon_process.unwrap_or(Value::Null),
            "projectCount": input.daemon_projects.len(),
        },
        "tmux": {
            "available": input.tmux.available,
            "version": if input.tmux.available { input.tmux.version } else { None },
            "sessionCount": session_names.len(),
        },
        "projects": projects,
        "staleHookProcesses": list_stale_hook_processes(&input.process_list, &input.cli_launch),
        "summary": {
            "projects": projects.len(),
            "ok": ok,
            "stopped": stopped,
            "inactive": inactive,
            "needsAttention": needs_attention,
            "needsRestart": needs_attention,
            "runtimeRebuildRequired": runtime_rebuild_required,
        },
    })
}

pub fn render_runtime_coherence_report(report: &Value) -> String {
    let empty = Vec::new();
    let mut lines = vec![
        "Aimux Versions".to_owned(),
        format!(
            "  cli version: {}",
            string_at(report, &["cliVersion"]).unwrap_or_default()
        ),
        format!(
            "  build profile: {}",
            string_at(report, &["buildProfile"]).unwrap_or_default()
        ),
        cli_launcher_line(&report["cliLaunch"]),
        format!(
            "  cli current entry: {}",
            string_at(report, &["cliLaunch", "currentEntryPath"]).unwrap_or_default()
        ),
        format!(
            "  cli stable shim: {}",
            string_at(report, &["cliLaunch", "stableShimPath"]).unwrap_or_default()
        ),
        format!(
            "  expected project service: {}",
            format_manifest(report.pointer("/expected/projectService"))
        ),
        format!(
            "  expected runtime owner: {}",
            string_at(report, &["expected", "runtimeOwner"]).unwrap_or_default()
        ),
        format!(
            "  expected tmux runtime contract: {}",
            string_at(report, &["expected", "runtimeContract"]).unwrap_or_default()
        ),
        daemon_line(&report["daemon"]),
    ];
    lines.extend(render_process(
        "daemon process",
        report.pointer("/daemon/process"),
    ));
    lines.push(format!(
        "  daemon projects: {}",
        report
            .pointer("/daemon/projectCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    ));
    lines.push(format!(
        "  tmux: {}",
        if report.pointer("/tmux/available").and_then(Value::as_bool) == Some(true) {
            string_at(report, &["tmux", "version"]).unwrap_or_else(|| "available".into())
        } else {
            "unavailable".into()
        }
    ));
    lines.push(format!(
        "  tmux sessions: {}",
        report
            .pointer("/tmux/sessionCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    ));
    lines.push(format!(
        "  projects: {} ({} ok, {} stopped, {} inactive, {} need attention, {} need runtime rebuild)",
        report
            .pointer("/summary/projects")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        report
            .pointer("/summary/ok")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        report
            .pointer("/summary/stopped")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        report
            .pointer("/summary/inactive")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        report
            .pointer("/summary/needsAttention")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        report
            .pointer("/summary/runtimeRebuildRequired")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    ));

    for project in report["projects"].as_array().unwrap_or(&empty) {
        lines.push(String::new());
        lines.push(format!(
            "Project {}: {}",
            render_project_status(project["status"].as_str()),
            project["projectRoot"].as_str().unwrap_or_default()
        ));
        lines.push(format!(
            "  sources: {}",
            project["sources"]
                .as_array()
                .map(|sources| sources
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "(none)".into())
        ));
        lines.push(format!(
            "  runtime: contract={} expected={} rebuild={}",
            nullable_string(project.pointer("/runtime/contract")),
            project
                .pointer("/runtime/expectedContract")
                .and_then(Value::as_str)
                .unwrap_or(""),
            yes_no(
                project
                    .pointer("/runtime/rebuildRequired")
                    .and_then(Value::as_bool)
                    == Some(true)
            )
        ));
        for client in project
            .pointer("/runtime/clientSessions")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
        {
            if client.get("rebuildRequired").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            lines.push(format!(
                "    client: {} contract={} expected={} rebuild=yes",
                client["sessionName"].as_str().unwrap_or_default(),
                nullable_string(client.get("contract")),
                project
                    .pointer("/runtime/expectedContract")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ));
        }
        lines.push(format!(
            "  service: {} endpoint={} pid={}",
            project
                .pointer("/service/status")
                .and_then(Value::as_str)
                .unwrap_or(""),
            format_endpoint(project.pointer("/service/endpoint")),
            nullable_number(project.pointer("/service/pid"))
        ));
        lines.extend(render_supervisor_state(
            project.pointer("/service/daemonState"),
        ));
        lines.extend(render_process(
            "process",
            project.pointer("/service/process"),
        ));
        lines.push(format!(
            "    running: {}",
            format_manifest(project.pointer("/service/serviceInfo"))
        ));
        lines.push(format!(
            "    expected: {}",
            format_manifest(report.pointer("/expected/projectService"))
        ));
        if let Some(error) = project.pointer("/service/error").and_then(Value::as_str) {
            lines.push(format!("    error: {error}"));
        }
        let dashboards = project["dashboards"].as_array().unwrap_or(&empty);
        if dashboards.is_empty() {
            lines.push("  dashboards: none".into());
            continue;
        }
        lines.push("  dashboards:".into());
        for dashboard in dashboards {
            lines.push(format!(
                "    {} {}:{} {} alive={}",
                dashboard["status"].as_str().unwrap_or(""),
                dashboard["sessionName"].as_str().unwrap_or(""),
                dashboard["windowId"].as_str().unwrap_or(""),
                dashboard["windowName"].as_str().unwrap_or(""),
                yes_no(dashboard["alive"].as_bool() == Some(true))
            ));
            if !dashboard["process"].is_null() {
                lines.extend(
                    render_process("process", dashboard.get("process"))
                        .into_iter()
                        .map(|line| format!("  {line}")),
                );
            }
            lines.push(format!(
                "      build: {} expected={}",
                nullable_string(dashboard.get("buildStamp")),
                project["expectedDashboardBuildStamp"]
                    .as_str()
                    .unwrap_or("")
            ));
            lines.push(format!(
                "      owner: {} runtimeOwner={}",
                nullable_string(dashboard.get("owner")),
                nullable_string(dashboard.get("runtimeOwner"))
            ));
        }
    }

    let stale = report["staleHookProcesses"].as_array().unwrap_or(&empty);
    if !stale.is_empty() {
        lines.push(String::new());
        lines.push(format!("Stale hook processes: {}", stale.len()));
        for process in stale.iter().take(10) {
            lines.extend(
                render_process("hook process", Some(process))
                    .into_iter()
                    .map(|line| line.replacen("    ", "  ", 1)),
            );
        }
    }
    lines.join("\n")
}

#[derive(Debug)]
struct KnownProject {
    project_root: String,
    sources: Vec<String>,
}

fn collect_known_projects(
    input: &RuntimeCoherenceInput,
    session_names: &[String],
) -> Vec<KnownProject> {
    let mut projects: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for entry in input.daemon_projects.values() {
        add_known_project(
            &mut projects,
            entry.get("projectRoot").and_then(Value::as_str),
            "daemon-state",
        );
    }
    if input.tmux.available {
        for session_name in session_names {
            if !is_managed_session_name(session_name) {
                continue;
            }
            let runtime_owner =
                session_option(&input.tmux, session_name, TMUX_RUNTIME_OWNER_OPTION);
            if runtime_owner
                .as_deref()
                .is_some_and(|owner| owner != input.expected_runtime_owner)
            {
                continue;
            }
            add_known_project(
                &mut projects,
                session_option(&input.tmux, session_name, "@aimux-project-root").as_deref(),
                "tmux",
            );
        }
    }
    projects
        .into_iter()
        .map(|(project_root, sources)| KnownProject {
            project_root,
            sources: sources.into_iter().collect(),
        })
        .collect()
}

fn add_known_project(
    projects: &mut BTreeMap<String, BTreeSet<String>>,
    root: Option<&str>,
    source: &str,
) {
    let Some(root) = root.map(str::trim).filter(|root| !root.is_empty()) else {
        return;
    };
    projects
        .entry(root.into())
        .or_default()
        .insert(source.into());
}

fn read_project_service_health(
    endpoint: Option<Value>,
    expected: &Value,
    health: &BTreeMap<String, Vec<RuntimeCoherenceHealthProbe>>,
    expected_state_dir: &str,
) -> Value {
    let Some(endpoint) = endpoint else {
        return json!({
            "status": "missing",
            "daemonState": null,
            "endpoint": null,
            "pid": null,
            "process": null,
            "serviceInfo": null,
            "error": null,
        });
    };
    let mut latest_error = Value::Null;
    let key = format!(
        "{}:{}",
        endpoint["host"].as_str().unwrap_or(""),
        endpoint["port"].as_u64().unwrap_or(0)
    );
    let probes = health.get(&key).cloned().unwrap_or_default();
    for probe in probes.into_iter().take(2) {
        match probe {
            RuntimeCoherenceHealthProbe::Err(error) => latest_error = Value::String(error),
            RuntimeCoherenceHealthProbe::Ok(response) => {
                if response.status < 200
                    || response.status >= 300
                    || response.body.get("ok").and_then(Value::as_bool) == Some(false)
                {
                    latest_error = Value::String(
                        response
                            .body
                            .get("error")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                format!("health request failed: {}", response.status)
                            }),
                    );
                    continue;
                }
                let service_info = response
                    .body
                    .get("serviceInfo")
                    .filter(|value| value.is_object())
                    .cloned()
                    .unwrap_or(Value::Null);
                let actual_state_dir = response.body.get("projectStateDir").and_then(Value::as_str);
                if actual_state_dir != Some(expected_state_dir) {
                    return json!({
                        "status": "mismatch",
                        "daemonState": null,
                        "endpoint": endpoint,
                        "pid": response.body.get("pid").and_then(Value::as_i64).unwrap_or_else(|| endpoint["pid"].as_i64().unwrap_or(0)),
                        "process": null,
                        "serviceInfo": service_info,
                        "error": format!(
                            "projectStateDir mismatch: expected {} actual {}",
                            expected_state_dir,
                            actual_state_dir.unwrap_or("unknown")
                        ),
                    });
                }
                return json!({
                    "status": if manifests_match(expected, &service_info) { "ok" } else { "mismatch" },
                    "daemonState": null,
                    "endpoint": endpoint,
                    "pid": response.body.get("pid").and_then(Value::as_i64).unwrap_or_else(|| endpoint["pid"].as_i64().unwrap_or(0)),
                    "process": null,
                    "serviceInfo": service_info,
                    "error": null,
                });
            }
        }
    }
    json!({
        "status": "unreachable",
        "daemonState": null,
        "endpoint": endpoint,
        "pid": endpoint["pid"].clone(),
        "process": null,
        "serviceInfo": null,
        "error": latest_error,
    })
}

fn list_dashboard_reports(
    input: &RuntimeCoherenceInput,
    session_names: &[String],
    project_root: &str,
    expected_dashboard_build_stamp: &str,
) -> Vec<Value> {
    if !input.tmux.available {
        return Vec::new();
    }
    let host_session = project_session_name(&input.tmux, project_root);
    let mut dashboards = Vec::new();
    let mut seen = BTreeSet::new();
    for session_name in session_names.iter().filter(|session_name| {
        *session_name == &host_session
            || is_tmux_client_session_for_host(session_name, &host_session)
            || session_option(&input.tmux, session_name, "@aimux-project-root").as_deref()
                == Some(project_root)
    }) {
        let runtime_owner = session_option(&input.tmux, session_name, TMUX_RUNTIME_OWNER_OPTION);
        let client_session = is_tmux_client_session_for_host(session_name, &host_session);
        for window in input
            .tmux
            .windows
            .get(session_name)
            .cloned()
            .unwrap_or_default()
        {
            if !is_dashboard_window_name(&window.name) || seen.contains(&window.id) {
                continue;
            }
            seen.insert(window.id.clone());
            let build_stamp = window_option(&input.tmux, &window.id, TMUX_DASHBOARD_BUILD_OPTION);
            let owner = window_option(&input.tmux, &window.id, TMUX_DASHBOARD_OWNER_OPTION);
            let pane_start_command = input
                .tmux
                .pane_start_commands
                .get(&window.id)
                .cloned()
                .flatten();
            if client_session
                && build_stamp.is_none()
                && owner.is_none()
                && pane_start_command
                    .as_deref()
                    .is_some_and(|command| command.contains("tail -f /dev/null"))
            {
                continue;
            }
            let process = build_process_report(None, pane_start_command, &input.cli_launch, None);
            let alive = input
                .tmux
                .window_alive
                .get(&window.id)
                .copied()
                .unwrap_or(true);
            let status = if alive
                && build_stamp.as_deref() == Some(expected_dashboard_build_stamp)
                && owner.as_deref() == Some(input.expected_runtime_owner.as_str())
                && runtime_owner.as_deref() == Some(input.expected_runtime_owner.as_str())
            {
                "ok"
            } else {
                "mismatch"
            };
            dashboards.push(json!({
                "sessionName": session_name,
                "windowId": window.id,
                "windowIndex": window.index,
                "windowName": window.name,
                "alive": alive,
                "buildStamp": build_stamp,
                "owner": owner,
                "runtimeOwner": runtime_owner,
                "process": process.unwrap_or(Value::Null),
                "status": status,
            }));
        }
    }
    dashboards.sort_by(|a, b| {
        let left = format!(
            "{}:{:08}",
            a["sessionName"].as_str().unwrap_or(""),
            a["windowIndex"].as_i64().unwrap_or(0)
        );
        let right = format!(
            "{}:{:08}",
            b["sessionName"].as_str().unwrap_or(""),
            b["windowIndex"].as_i64().unwrap_or(0)
        );
        left.cmp(&right)
    });
    dashboards
}

const TMUX_DASHBOARD_BUILD_OPTION: &str = "@aimux-dashboard-build";

fn read_project_runtime_report(tmux: &RuntimeCoherenceTmux, project_root: &str) -> Value {
    let session_name = project_session_name(tmux, project_root);
    if !tmux.available {
        return json!({
            "sessionName": null,
            "contract": null,
            "expectedContract": AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
            "rebuildRequired": false,
        });
    }
    if !tmux.session_names.contains(&session_name) {
        return json!({
            "sessionName": session_name,
            "contract": null,
            "expectedContract": AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
            "rebuildRequired": false,
            "clientSessions": [],
        });
    }
    let contract = session_option(tmux, &session_name, TMUX_RUNTIME_CONTRACT_OPTION);
    let client_sessions = tmux
        .session_names
        .iter()
        .filter(|name| is_tmux_client_session_for_host(name, &session_name))
        .map(|name| {
            let contract = session_option(tmux, name, TMUX_RUNTIME_CONTRACT_OPTION);
            json!({
                "sessionName": name,
                "contract": contract,
                "rebuildRequired": contract.as_deref() != Some(AIMUX_TMUX_RUNTIME_CONTRACT_VERSION),
            })
        })
        .collect::<Vec<_>>();
    let rebuild_required = contract.as_deref() != Some(AIMUX_TMUX_RUNTIME_CONTRACT_VERSION)
        || client_sessions
            .iter()
            .any(|client| client["rebuildRequired"].as_bool() == Some(true));
    json!({
        "sessionName": session_name,
        "contract": contract,
        "expectedContract": AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
        "rebuildRequired": rebuild_required,
        "clientSessions": client_sessions,
    })
}

fn build_process_report(
    pid: Option<i64>,
    args: Option<String>,
    cli_launch: &Value,
    error: Option<String>,
) -> Option<Value> {
    if args.is_none() && error.is_none() && pid.is_none() {
        return None;
    }
    let path_hints = native_path_hints(args.as_deref(), cli_launch);
    Some(json!({
        "pid": pid,
        "argsPreview": preview(args.as_deref()),
        "pathHints": path_hints,
        "staleNativePath": has_stale_native_path(&path_hints, cli_launch),
        "error": error,
    }))
}

fn list_stale_hook_processes(processes: &[Value], cli_launch: &Value) -> Vec<Value> {
    let mut reports = Vec::new();
    for entry in processes {
        let args = entry["args"].as_str().unwrap_or_default();
        if !args.contains("claude-hook") && !args.contains("codex-hook") {
            continue;
        }
        let Some(mut report) =
            build_process_report(entry["pid"].as_i64(), Some(args.into()), cli_launch, None)
        else {
            continue;
        };
        if report["staleNativePath"].as_bool() != Some(true) {
            continue;
        }
        if let Value::Object(map) = &mut report {
            map.insert(
                "projectRoot".into(),
                extract_hook_project_root(args).unwrap_or(Value::Null),
            );
        }
        reports.push(report);
    }
    reports
}

fn manifests_match(expected: &Value, actual: &Value) -> bool {
    if !actual.is_object() {
        return false;
    }
    if actual.get("apiVersion").and_then(Value::as_f64)
        != expected.get("apiVersion").and_then(Value::as_f64)
    {
        return false;
    }
    if js_string(actual.get("buildStamp")) != js_string(expected.get("buildStamp")) {
        return false;
    }
    let Some(expected_capabilities) = expected.get("capabilities").and_then(Value::as_object)
    else {
        return true;
    };
    expected_capabilities.iter().all(|(key, value)| {
        actual
            .get("capabilities")
            .and_then(Value::as_object)
            .and_then(|capabilities| capabilities.get(key))
            .and_then(Value::as_bool)
            == value.as_bool()
    })
}

fn project_status(runtime: &Value, service: &Value, dashboards: &[Value]) -> &'static str {
    if service_deliberately_stopped(service) {
        return "stopped";
    }
    if service_inactive(service, dashboards) && runtime["rebuildRequired"].as_bool() != Some(true) {
        return "inactive";
    }
    if runtime["rebuildRequired"].as_bool() == Some(true)
        || service["status"].as_str() != Some("ok")
    {
        return "needs-attention";
    }
    if dashboards
        .iter()
        .any(|dashboard| dashboard["status"].as_str() != Some("ok"))
    {
        "needs-attention"
    } else {
        "ok"
    }
}

fn service_deliberately_stopped(service: &Value) -> bool {
    service
        .pointer("/daemonState/status")
        .and_then(Value::as_str)
        == Some("stopped")
        && service.get("endpoint").is_some_and(Value::is_null)
        && service
            .pointer("/daemonState/lastExit/expected")
            .and_then(Value::as_bool)
            != Some(false)
        && matches!(
            service.get("status").and_then(Value::as_str),
            Some("missing" | "unreachable")
        )
}

fn service_inactive(service: &Value, dashboards: &[Value]) -> bool {
    service["daemonState"].is_null()
        && service["endpoint"].is_null()
        && service["status"].as_str() == Some("missing")
        && dashboards.is_empty()
}

fn render_project_status(status: Option<&str>) -> &'static str {
    match status {
        Some("ok") => "ok",
        Some("stopped") => "stopped",
        Some("inactive") => "inactive",
        Some("needs-attention") => "needs-attention",
        _ => "needs-attention",
    }
}

fn find_project_daemon_state(
    projects: &BTreeMap<String, Value>,
    project_root: &str,
) -> Option<Value> {
    projects
        .values()
        .find(|entry| entry.get("projectRoot").and_then(Value::as_str) == Some(project_root))
        .cloned()
}

fn session_option(tmux: &RuntimeCoherenceTmux, session_name: &str, key: &str) -> Option<String> {
    tmux.session_options
        .get(session_name)
        .and_then(|options| options.get(key))
        .cloned()
        .flatten()
}

fn window_option(tmux: &RuntimeCoherenceTmux, window_id: &str, key: &str) -> Option<String> {
    tmux.window_options
        .get(window_id)
        .and_then(|options| options.get(key))
        .cloned()
        .flatten()
}

fn project_session_name(tmux: &RuntimeCoherenceTmux, project_root: &str) -> String {
    let computed = project_session(Path::new(project_root), "aimux").session_name;
    if tmux.session_names.contains(&computed) {
        return computed;
    }
    tmux.session_names
        .iter()
        .find(|session_name| {
            session_option(tmux, session_name, "@aimux-project-root").as_deref()
                == Some(project_root)
        })
        .cloned()
        .unwrap_or(computed)
}

fn is_managed_session_name(session_name: &str) -> bool {
    session_name.starts_with("aimux-")
}

fn preview(value: Option<&str>) -> Value {
    let Some(trimmed) = value
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return Value::Null;
    };
    if trimmed.len() > 260 {
        Value::String(format!("{}…", &trimmed[..259]))
    } else {
        Value::String(trimmed)
    }
}

fn native_path_hints(args: Option<&str>, cli_launch: &Value) -> Vec<String> {
    let Some(args) = args else {
        return Vec::new();
    };
    let mut hints = Vec::new();
    collect_native_hints(args, ".aimux/native/", &mut hints);
    if let Some(parent) = native_install_parent(cli_launch)
        && !parent.contains(".aimux/native/")
    {
        collect_parent_hints(args, &parent, &mut hints);
    }
    let mut seen = BTreeSet::new();
    hints.retain(|hint| seen.insert(hint.clone()));
    hints.truncate(8);
    hints
}

fn collect_native_hints(args: &str, marker: &str, hints: &mut Vec<String>) {
    let mut search_from = 0;
    while let Some(index) = args[search_from..].find(marker) {
        let marker_start = search_from + index;
        let start = args[..marker_start]
            .rfind(char::is_whitespace)
            .map(|index| index + 1)
            .unwrap_or(0);
        let end = args[marker_start..]
            .find([' ', '\'', '"'])
            .map(|index| marker_start + index)
            .unwrap_or(args.len());
        hints.push(args[start..end].to_owned());
        search_from = end;
    }
}

fn collect_parent_hints(args: &str, parent: &str, hints: &mut Vec<String>) {
    let mut search_from = 0;
    while let Some(index) = args[search_from..].find(parent) {
        let start = search_from + index;
        let end = args[start..]
            .find([' ', '\'', '"'])
            .map(|index| start + index)
            .unwrap_or(args.len());
        hints.push(args[start..end].to_owned());
        search_from = end;
    }
}

fn native_install_parent(cli_launch: &Value) -> Option<String> {
    let current_root = current_native_install_root(cli_launch)?;
    let trimmed = current_root.trim_end_matches('/');
    let last_slash = trimmed.rfind('/')?;
    Some(format!("{}/", &trimmed[..last_slash]))
}

fn current_native_install_root(cli_launch: &Value) -> Option<String> {
    let current_entry_path = cli_launch["currentEntryPath"].as_str()?;
    let marker = ".aimux/native/";
    if let Some(index) = current_entry_path.find(marker) {
        let prefix_end = index + marker.len();
        let version_end = current_entry_path[prefix_end..].find('/')? + prefix_end;
        return Some(format!("{}/", &current_entry_path[..version_end]));
    }
    if cli_launch["source"].as_str() != Some("stable-shim") {
        return None;
    }
    for suffix in ["/dist/launcher-bin.js", "/dist/main.js", "/bin/aimux"] {
        if let Some(root) = current_entry_path.strip_suffix(suffix) {
            return Some(format!("{root}/"));
        }
    }
    None
}

fn has_stale_native_path(path_hints: &[String], cli_launch: &Value) -> bool {
    let current_entry_path = cli_launch["currentEntryPath"].as_str().unwrap_or_default();
    let current_root = current_native_install_root(cli_launch);
    path_hints.iter().any(|path| {
        if path.contains(current_entry_path) {
            return false;
        }
        if current_root
            .as_ref()
            .is_some_and(|root| path.contains(root))
        {
            return false;
        }
        true
    })
}

fn extract_hook_project_root(args: &str) -> Option<Value> {
    let marker = "--project";
    let index = args.find(marker)?;
    let rest = args[index + marker.len()..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim_start();
    let project = if let Some(rest) = rest.strip_prefix('"') {
        rest.split('"').next().unwrap_or_default()
    } else if let Some(rest) = rest.strip_prefix('\'') {
        rest.split('\'').next().unwrap_or_default()
    } else {
        rest.split_whitespace().next().unwrap_or_default()
    };
    (!project.trim().is_empty()).then(|| Value::String(project.trim().into()))
}

fn cli_launcher_line(cli_launch: &Value) -> String {
    let args = cli_launch["args"]
        .as_array()
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    format!(
        "  cli launcher: {} {} {}",
        cli_launch["source"].as_str().unwrap_or_default(),
        cli_launch["command"].as_str().unwrap_or_default(),
        args
    )
    .trim()
    .to_owned()
}

fn daemon_line(daemon: &Value) -> String {
    if daemon["running"].as_bool() == Some(true) {
        format!(
            "  daemon: running pid={}",
            daemon
                .pointer("/info/pid")
                .and_then(Value::as_i64)
                .unwrap_or(0)
        )
    } else {
        "  daemon: not running".into()
    }
}

fn render_process(label: &str, process: Option<&Value>) -> Vec<String> {
    let Some(process) = process.filter(|value| !value.is_null()) else {
        return vec![format!("    {label}: (unknown)")];
    };
    let stale = if process["staleNativePath"].as_bool() == Some(true) {
        " stale-native-path=yes"
    } else {
        ""
    };
    let mut lines = vec![format!(
        "    {label}: pid={}{}",
        nullable_number(process.get("pid")),
        stale
    )];
    if let Some(args) = process.get("argsPreview").and_then(Value::as_str) {
        lines.push(format!("      args: {args}"));
    }
    if let Some(paths) = process.get("pathHints").and_then(Value::as_array)
        && !paths.is_empty()
    {
        lines.push(format!(
            "      native paths: {}",
            paths
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(error) = process.get("error").and_then(Value::as_str) {
        lines.push(format!("      error: {error}"));
    }
    lines
}

fn render_supervisor_state(state: Option<&Value>) -> Vec<String> {
    let Some(state) = state.filter(|value| !value.is_null()) else {
        return Vec::new();
    };
    let mut lines = vec![format!(
        "    supervisor: status={} restarts={} pid={}",
        state
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
        state
            .get("restartCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        state.get("pid").and_then(Value::as_i64).unwrap_or(0)
    )];
    if let Some(last_restart_at) = state.get("lastRestartAt").and_then(Value::as_str) {
        lines.push(format!("      last restart: {last_restart_at}"));
    }
    if let Some(last_exit) = state.get("lastExit").filter(|value| !value.is_null()) {
        lines.push(format!(
            "      last exit: {} code={} signal={} at={}",
            if last_exit["expected"].as_bool() == Some(true) {
                "expected"
            } else {
                "unexpected"
            },
            nullable_exit_value(last_exit.get("code")),
            nullable_exit_value(last_exit.get("signal")),
            last_exit["at"].as_str().unwrap_or("")
        ));
    }
    lines
}

fn format_manifest(manifest: Option<&Value>) -> String {
    let Some(manifest) = manifest.filter(|value| !value.is_null()) else {
        return "(unknown)".into();
    };
    format!(
        "api={} build={}",
        manifest
            .get("apiVersion")
            .and_then(Value::as_i64)
            .map_or("?".into(), |value| value.to_string()),
        manifest
            .get("buildStamp")
            .and_then(Value::as_str)
            .unwrap_or("?")
    )
}

fn format_endpoint(endpoint: Option<&Value>) -> String {
    let Some(endpoint) = endpoint.filter(|value| !value.is_null()) else {
        return "(none)".into();
    };
    format!(
        "{}:{}",
        endpoint["host"].as_str().unwrap_or(""),
        endpoint["port"].as_u64().unwrap_or(0)
    )
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_owned)
}

fn nullable_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("(missing)")
        .to_owned()
}

fn nullable_number(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(number)) => number.to_string(),
        _ => "(unknown)".into(),
    }
}

fn nullable_exit_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(number)) => number.to_string(),
        _ => "(none)".into(),
    }
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::Null) | None => String::new(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| js_string(Some(value)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}
