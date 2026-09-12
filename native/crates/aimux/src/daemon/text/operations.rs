use crate::async_runtime::{doctor_tasks_report, render_doctor_tasks_report};
use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{render_core_dashboard_reload_lines, render_core_runtime_restart_lines};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, boolean_param, string_param, text_error,
    text_or_json_lines,
};
use crate::daemon::text::params::ProjectServiceJsonResult;
use crate::daemon_supervisor::acquire_runtime_restart_permit;
use crate::paths::PathResolver;
use crate::project_api_contract::routes as project_routes;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardOpenRequest {
    pub current_client_session: Option<String>,
    pub client_tty: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RestartControlPlaneTextResult {
    pub restart: Value,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RestartBackendIdGuardNotice {
    pub at_risk_sessions: Vec<Value>,
    pub tmux_error: Option<String>,
}

pub fn attach_restart_guard_notices(
    restart: &mut Value,
    notices: &[RestartBackendIdGuardNotice],
) -> bool {
    let mut at_risk_sessions = Vec::new();
    let mut tmux_errors = Vec::new();
    for notice in notices {
        at_risk_sessions.extend(notice.at_risk_sessions.iter().cloned());
        if let Some(error) = notice.tmux_error.as_deref() {
            tmux_errors.push(Value::String(error.to_owned()));
        }
    }
    if at_risk_sessions.is_empty() && tmux_errors.is_empty() {
        return false;
    }
    let Some(restart) = restart.as_object_mut() else {
        return false;
    };
    restart.insert(
        "restartGuard".to_owned(),
        json!({
            "force": {
                "status": "bypassed",
                "atRiskSessions": at_risk_sessions,
                "tmuxErrors": tmux_errors,
            }
        }),
    );
    true
}

pub fn empty_restart_project_result(project_root: &str) -> Value {
    json!({
        "projectRoot": project_root,
        "runtimeRebuildRequired": false,
        "runtime": { "status": "skipped" },
        "service": { "status": "skipped" },
        "dashboard": { "status": "skipped" },
    })
}

pub fn render_runtime_restart_result(result: &Value) -> String {
    let daemon = result.get("daemon").unwrap_or(&Value::Null);
    let retained = daemon
        .get("retained")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let current_pid = daemon
        .get("current")
        .and_then(|value| value.get("pid"))
        .map(js_string)
        .unwrap_or_else(|| "null".into());
    let previous_pid = daemon
        .get("previous")
        .and_then(|value| value.get("pid"))
        .map(js_string);
    let daemon_status = if retained {
        format!("retained pid={current_pid}")
    } else if let Some(previous_pid) = previous_pid {
        format!("restarted pid={previous_pid} -> pid={current_pid}")
    } else {
        format!("started -> pid={current_pid}")
    };
    let summary = result.get("summary").unwrap_or(&Value::Null);
    let mut lines = vec![
        "Aimux Restart".to_owned(),
        format!("  daemon: {daemon_status}"),
        format!("  projects: {}", summary_number(summary, "projects")),
        format!(
            "  services ensured: {}",
            summary_number(summary, "servicesEnsured")
        ),
        format!(
            "  runtime repaired: {}",
            summary_number(summary, "runtimeRepairs")
        ),
        format!(
            "  dashboards reloaded: {}",
            summary_number(summary, "dashboardsReloaded")
        ),
        format!(
            "  validation orphans: {} processes, {} tmux sessions, {} tmux windows",
            summary_number(summary, "orphanProcessesCleaned"),
            summary_number(summary, "orphanTmuxSessionsCleaned"),
            summary_number(summary, "orphanTmuxWindowsCleaned")
        ),
        format!("  failures: {}", summary_number(summary, "failures")),
    ];

    if let Some(force) = result
        .get("restartGuard")
        .and_then(|guard| guard.get("force"))
    {
        let at_risk = force
            .get("atRiskSessions")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let tmux_errors = force
            .get("tmuxErrors")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if !at_risk.is_empty() || !tmux_errors.is_empty() {
            lines.push(String::new());
            lines.push("Restart forced before backendSessionId capture:".into());
            for session in at_risk {
                lines.push(format!(
                    "  - {} ({}, {}) in {}",
                    session
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    session
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    session
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    session
                        .get("projectRoot")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                ));
            }
            for error in tmux_errors {
                lines.push(format!(
                    "  - tmux live-window inventory failed: {}",
                    error.as_str().unwrap_or("unknown")
                ));
            }
        }
    }

    if summary
        .get("runtimeRebuildRequired")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        > 0
    {
        lines.push(String::new());
        lines.push("Runtime repaired:".into());
        for project in result
            .get("projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|project| {
                project
                    .get("runtimeRebuildRequired")
                    .and_then(Value::as_bool)
                    == Some(true)
            })
        {
            lines.push(format!(
                "  {}",
                project
                    .get("projectRoot")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ));
        }
    }

    for project in result
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let runtime = project.get("runtime").unwrap_or(&Value::Null);
        let service = project.get("service").unwrap_or(&Value::Null);
        let dashboard = project.get("dashboard").unwrap_or(&Value::Null);
        lines.push(String::new());
        lines.push(format!(
            "Project: {}",
            project
                .get("projectRoot")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ));
        lines.push(format!("  runtime: {}", step_status(runtime)));
        lines.push(format!("  service: {}", step_status(service)));
        lines.push(format!("  dashboard: {}", dashboard_status(dashboard)));
    }

    lines.join("\n")
}

pub trait DaemonOperationsTextRuntime {
    fn now_iso(&self) -> String;
    fn resolve_project_root(&self, value: &str) -> String;
    fn list_project_paths_for_route(&self) -> Vec<String>;
    fn is_git_project_root(&self, project_root: &str) -> bool;
    fn doctor_versions_report(&mut self) -> Result<(Value, String), String>;
    fn doctor_disk_report(
        &mut self,
        project_roots: Vec<String>,
        include_active_measurement: bool,
        skipped_stale_project_roots: Vec<String>,
        generated_at: String,
    ) -> Result<(Value, String), String>;
    fn doctor_tmux_report(
        &mut self,
        project_root: &str,
        session_name: Option<&str>,
        window_id: Option<&str>,
    ) -> Result<(Value, String), String>;
    fn repair_tmux_runtime(
        &mut self,
        project_root: &str,
        open: bool,
    ) -> Result<(Value, String), String>;
    fn get_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult;
    fn post_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult;
    fn prepare_restart_control_plane(
        &mut self,
        project_root: Option<&str>,
        force: bool,
        wait_for_capture: bool,
    ) -> Result<Option<RestartBackendIdGuardNotice>, String> {
        let _ = (project_root, force, wait_for_capture);
        Ok(None)
    }
    fn restart_control_plane(
        &mut self,
        issued_at: &str,
        project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String>;
    fn dashboard_reload(
        &mut self,
        project_root: &str,
        open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String>;
    fn runtime_restart(
        &mut self,
        project_root: &str,
        open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String>;
}

pub fn route_operations_text_request(
    runtime: &mut impl DaemonOperationsTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET" && pathname == CORE_API_ROUTES.doctor_versions_text {
        return Some(doctor_versions_text_route(runtime, &route_url));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.doctor_disk_text {
        return Some(doctor_disk_text_route(runtime, &route_url));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.doctor_exchange_text {
        return Some(doctor_exchange_text_route(runtime, &route_url, body));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.doctor_lifecycle_text {
        return Some(doctor_lifecycle_text_route(runtime, &route_url, body));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.doctor_tasks_text {
        return Some(doctor_tasks_text_route(&route_url));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.doctor_tmux_text {
        return Some(doctor_tmux_text_route(runtime, &route_url));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.repair_text {
        return Some(repair_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.repair_exchange_text {
        return Some(repair_exchange_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.restart_text {
        return Some(restart_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.dashboard_reload_text {
        return Some(dashboard_reload_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.runtime_restart_text {
        return Some(runtime_restart_text_route(runtime, &route_url, body));
    }

    None
}

pub fn doctor_versions_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    match runtime.doctor_versions_report() {
        Ok((report, text)) => {
            text_or_json_lines(route_url, report, &split_rendered_report_lines(&text))
        }
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn doctor_disk_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    let include_active_measurement = route_url.search_param("includeActive") == Some("1");
    let (project_roots, skipped_stale_project_roots) =
        if let Some(project) = route_url.search_param("project") {
            (
                vec![runtime.resolve_project_root(&path_resolve(project))],
                Vec::new(),
            )
        } else {
            let mut roots = Vec::new();
            let mut skipped = Vec::new();
            for project_root in runtime.list_project_paths_for_route() {
                let resolved = path_resolve(&project_root);
                if runtime.is_git_project_root(&resolved) {
                    roots.push(resolved);
                } else {
                    skipped.push(resolved);
                }
            }
            (roots, skipped)
        };
    match runtime.doctor_disk_report(
        project_roots,
        include_active_measurement,
        skipped_stale_project_roots,
        runtime.now_iso(),
    ) {
        Ok((report, text)) => {
            text_or_json_lines(route_url, report, &split_rendered_report_lines(&text))
        }
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn doctor_tmux_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    let Some(project_param) = route_url.search_param("projectRoot") else {
        return text_error(400, "projectRoot query is required");
    };
    let project_root = runtime.resolve_project_root(&path_resolve(project_param));
    match runtime.doctor_tmux_report(
        &project_root,
        route_url.search_param("session"),
        route_url.search_param("windowId"),
    ) {
        Ok((report, text)) => {
            text_or_json_lines(route_url, report, &split_rendered_report_lines(&text))
        }
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn doctor_tasks_text_route(route_url: &DaemonRouteUrl) -> DaemonRouteResponse {
    let report = doctor_tasks_report();
    let text = render_doctor_tasks_report(&report);
    text_or_json_lines(
        route_url,
        json!(report),
        &split_rendered_report_lines(&text),
    )
}

pub fn doctor_exchange_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project_root = route_project_root_or_cwd(runtime, route_url, body);
    match runtime.get_project_service_json(&project_root, project_routes::DIAGNOSTICS) {
        ProjectServiceJsonResult::Ok { json, .. } => {
            let json_payload = json
                .get("runtimeExchange")
                .cloned()
                .unwrap_or_else(|| json.clone());
            let mut diagnostics = json;
            if let Value::Object(object) = &mut diagnostics {
                object.insert("projectRoot".into(), Value::String(project_root));
            }
            text_or_json_lines(
                route_url,
                json_payload,
                &render_exchange_diagnostics_lines(&diagnostics),
            )
        }
        ProjectServiceJsonResult::Err { response } => response,
    }
}

pub fn doctor_lifecycle_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project_root = route_project_root_or_cwd(runtime, route_url, body);
    match runtime.get_project_service_json(&project_root, project_routes::DIAGNOSTICS_LIFECYCLE) {
        ProjectServiceJsonResult::Ok { json, .. } => text_or_json_lines(
            route_url,
            json.clone(),
            &render_lifecycle_diagnostics_lines(&json),
        ),
        ProjectServiceJsonResult::Err { response } => response,
    }
}

pub fn repair_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let Some(project_param) = string_param(route_url, body, "projectRoot") else {
        return text_error(400, "projectRoot query is required");
    };
    if project_param.trim().is_empty() {
        return text_error(400, "projectRoot query is required");
    }
    let project_root = runtime.resolve_project_root(&path_resolve(&project_param));
    let open = boolean_param(route_url, body, "open", false);
    match runtime.repair_tmux_runtime(&project_root, open) {
        Ok((report, text)) => {
            text_or_json_lines(route_url, report, &split_rendered_report_lines(&text))
        }
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn repair_exchange_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project_root = match explicit_project_root_text_param(runtime, route_url, body) {
        Ok(project_root) => project_root,
        Err(response) => return response,
    };
    match runtime.post_project_service_json(
        &project_root,
        project_routes::runtime::COMPACT_EXCHANGE,
        json!({}),
    ) {
        ProjectServiceJsonResult::Ok { json, .. } => text_or_json_lines(
            route_url,
            json.clone(),
            &render_repair_exchange_lines(&project_root, &json),
        ),
        ProjectServiceJsonResult::Err { response } => response,
    }
}

pub fn restart_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let issued_at = runtime.now_iso();
    let project_root = route_url
        .search_param("project")
        .map(str::to_owned)
        .or_else(|| string_param(route_url, body, "projectRoot"))
        .or_else(|| string_param(route_url, body, "project"))
        .map(|project| runtime.resolve_project_root(&project));
    let force = bool_param(route_url, body, "force");
    let mut restart_guard_notices = Vec::new();
    if !bool_param(route_url, body, "backendIdCapturePrechecked")
        && let Some(notice) =
            match runtime.prepare_restart_control_plane(project_root.as_deref(), force, true) {
                Ok(notice) => notice,
                Err(error) => return DaemonRouteResponse::text(500, format!("{error}\n")),
            }
    {
        restart_guard_notices.push(notice);
    }
    let resolver = PathResolver::from_env();
    let _restart_lock =
        match acquire_runtime_restart_permit(&resolver, restart_lock_owner_pid(body)) {
            Ok(permit) => permit,
            Err(error) => return DaemonRouteResponse::text(500, format!("{error}\n")),
        };
    match runtime.prepare_restart_control_plane(project_root.as_deref(), force, false) {
        Ok(Some(notice)) => restart_guard_notices.push(notice),
        Ok(None) => {}
        Err(error) => return DaemonRouteResponse::text(500, format!("{error}\n")),
    }
    match runtime.restart_control_plane(&issued_at, project_root.as_deref()) {
        Ok(mut result) => {
            if attach_restart_guard_notices(&mut result.restart, &restart_guard_notices) {
                result.text = render_runtime_restart_result(&result.restart);
            }
            let mut response = text_or_json_lines(
                route_url,
                result.restart.clone(),
                &split_rendered_report_lines(&result.text),
            );
            response.status = restart_failure_count(&result.restart)
                .map(|failures| if failures > 0 { 500 } else { 200 })
                .unwrap_or(200);
            response
        }
        Err(error) => DaemonRouteResponse::text(500, format!("{error}\n")),
    }
}

fn restart_lock_owner_pid(body: Option<&Value>) -> Option<i32> {
    body.and_then(|body| body.get("restartLockOwnerPid"))
        .and_then(Value::as_i64)
        .and_then(|pid| i32::try_from(pid).ok())
        .filter(|pid| *pid > 0)
}

fn bool_param(route_url: &DaemonRouteUrl, body: Option<&Value>, key: &str) -> bool {
    route_url
        .search_param(key)
        .map(parse_bool_like)
        .or_else(|| body.and_then(|body| body.get(key)).map(value_bool_like))
        .unwrap_or(false)
}

fn value_bool_like(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::String(value) => parse_bool_like(value),
        Value::Number(value) => value.as_i64().is_some_and(|value| value != 0),
        _ => false,
    }
}

fn parse_bool_like(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn dashboard_reload_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project_root = match explicit_project_root_text_param(runtime, route_url, body) {
        Ok(project_root) => project_root,
        Err(response) => return response,
    };
    let open = dashboard_open_request(route_url, body);
    match runtime.dashboard_reload(&project_root, open) {
        Ok(payload) => text_or_json_lines(
            route_url,
            payload.clone(),
            &render_core_dashboard_reload_lines(&payload),
        ),
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn runtime_restart_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project_root = match explicit_project_root_text_param(runtime, route_url, body) {
        Ok(project_root) => project_root,
        Err(response) => return response,
    };
    let open = dashboard_open_request(route_url, body);
    match runtime.runtime_restart(&project_root, open) {
        Ok(payload) => text_or_json_lines(
            route_url,
            payload.clone(),
            &render_core_runtime_restart_lines(&payload),
        ),
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn explicit_project_root_text_param(
    runtime: &impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Result<String, DaemonRouteResponse> {
    let project_root = string_param(route_url, body, "projectRoot")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            string_param(route_url, body, "project")
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        });
    let Some(project_root) = project_root else {
        return Err(text_error(400, "projectRoot query is required"));
    };
    Ok(runtime.resolve_project_root(&project_root))
}

fn dashboard_open_request(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Option<DashboardOpenRequest> {
    boolean_param(route_url, body, "open", false).then(|| DashboardOpenRequest {
        current_client_session: trimmed_param(route_url, body, "currentClientSession"),
        client_tty: trimmed_param(route_url, body, "clientTty"),
    })
}

fn trimmed_param(route_url: &DaemonRouteUrl, body: Option<&Value>, name: &str) -> Option<String> {
    string_param(route_url, body, name)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn split_rendered_report_lines(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_owned).collect()
}

fn render_repair_exchange_lines(project_root: &str, result: &Value) -> Vec<String> {
    let compact = result.get("result").unwrap_or(&Value::Null);
    let mut lines = vec![
        format!("Project: {project_root}"),
        format!("Path: {}", display_string(compact, "path", "unknown")),
        format!(
            "Bytes: {} -> {}",
            display_i64(compact, "bytesBefore", 0),
            display_i64(compact, "bytesAfter", 0)
        ),
        format!(
            "Removed records: {}",
            compact
                .get("removed")
                .and_then(|removed| removed.get("totalRecords"))
                .and_then(Value::as_i64)
                .unwrap_or(0)
        ),
        format!(
            "Removed text bytes: {}",
            compact
                .get("byteCounts")
                .and_then(|byte_counts| byte_counts.get("removed"))
                .and_then(|removed| removed.get("totalStoredTextBytes"))
                .and_then(Value::as_i64)
                .unwrap_or(0)
        ),
    ];
    let mut diagnostics = result.clone();
    if let Value::Object(object) = &mut diagnostics {
        object.insert("projectRoot".into(), Value::String(project_root.into()));
    }
    lines.extend(render_exchange_diagnostics_lines(&diagnostics));
    lines
}

fn render_lifecycle_diagnostics_lines(diagnostics: &Value) -> Vec<String> {
    let telemetry = diagnostics.get("telemetry").unwrap_or(&Value::Null);
    let mut lines = vec![
        format!(
            "Project: {}",
            diagnostics
                .get("projectRoot")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ),
        format!(
            "Queue: {}/{}",
            display_jsonish(diagnostics.get("queuedCount").unwrap_or(&Value::Null), "?"),
            display_jsonish(diagnostics.get("queueLimit").unwrap_or(&Value::Null), "?")
        ),
        format!(
            "Lifecycle: enqueued={} started={} succeeded={} failed={} released={}",
            display_i64(telemetry, "enqueued", 0),
            display_i64(telemetry, "started", 0),
            display_i64(telemetry, "succeeded", 0),
            display_i64(telemetry, "failed", 0),
            display_i64(telemetry, "released", 0)
        ),
        format!(
            "Max: queued={} wait={}ms duration={}ms",
            display_i64(telemetry, "maxQueuedCount", 0),
            display_i64(telemetry, "maxQueuedMs", 0),
            display_i64(telemetry, "maxDurationMs", 0)
        ),
        format!(
            "Rejected: conflicts={} queueFull={}",
            display_i64(telemetry, "rejectedConflicts", 0),
            display_i64(telemetry, "rejectedQueueFull", 0)
        ),
    ];
    if let Some(last_error) = telemetry.get("lastError").and_then(Value::as_str) {
        lines.push(format!("Last error: {last_error}"));
    }
    let active_targets = diagnostics
        .get("activeTargets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !active_targets.is_empty() {
        lines.push("Active targets:".into());
        for target in active_targets {
            let target_value = target
                .get("key")
                .or_else(|| target.get("targetId"))
                .or_else(|| target.get("targetPath"))
                .map(|value| display_jsonish(value, "?"))
                .unwrap_or_else(|| "?".into());
            lines.push(format!(
                "  {} {}",
                display_string(&target, "operation", "?"),
                target_value
            ));
        }
    }
    lines
}

fn render_exchange_diagnostics_lines(diagnostics: &Value) -> Vec<String> {
    let exchange = diagnostics.get("runtimeExchange").unwrap_or(diagnostics);
    let counts = exchange.get("counts").unwrap_or(&Value::Null);
    let byte_counts = exchange.get("byteCounts").unwrap_or(&Value::Null);
    let compactable_byte_counts = exchange
        .get("compactableByteCounts")
        .unwrap_or(&Value::Null);
    let message_delivery = exchange.get("messageDelivery").unwrap_or(&Value::Null);
    let retained_counts = exchange.get("retainedCounts").unwrap_or(&Value::Null);
    let retained_byte_counts = exchange.get("retainedByteCounts").unwrap_or(&Value::Null);
    let retained_message_delivery = exchange
        .get("retainedMessageDelivery")
        .unwrap_or(&Value::Null);
    let telemetry = exchange.get("telemetry").unwrap_or(&Value::Null);
    let mut lines = vec![
        format!(
            "Project: {}",
            diagnostics
                .get("projectRoot")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ),
        format!("Path: {}", display_string(exchange, "path", "unknown")),
        format!("Bytes: {}", display_i64(exchange, "bytes", 0)),
        format!(
            "Records: total={} threads={} messages={} tasks={} inbox={}",
            display_i64(counts, "totalRecords", 0),
            display_i64(counts, "threads", 0),
            display_i64(counts, "messages", 0),
            display_i64(counts, "tasks", 0),
            display_i64(counts, "inbox", 0)
        ),
        format!(
            "Text bytes: stored={} original={} messages={} tasks={} compactedMessages={} compactedTasks={}",
            display_i64(byte_counts, "totalStoredTextBytes", 0),
            display_i64(byte_counts, "totalOriginalTextBytes", 0),
            display_i64(byte_counts, "messageBodyBytes", 0),
            display_i64(byte_counts, "taskPromptBytes", 0)
                + display_i64(byte_counts, "taskResultBytes", 0)
                + display_i64(byte_counts, "taskErrorBytes", 0),
            display_i64(byte_counts, "compactedMessageBodies", 0),
            display_i64(byte_counts, "compactedTasks", 0)
        ),
        format!(
            "Compactable text bytes: {}",
            display_i64(compactable_byte_counts, "totalStoredTextBytes", 0)
        ),
        format!(
            "Retained records after compaction: total={} threads={} messages={} tasks={}",
            display_i64(retained_counts, "totalRecords", 0),
            display_i64(retained_counts, "threads", 0),
            display_i64(retained_counts, "messages", 0),
            display_i64(retained_counts, "tasks", 0)
        ),
        format!(
            "Retained text bytes after compaction: {}",
            display_i64(retained_byte_counts, "totalStoredTextBytes", 0)
        ),
        format!(
            "Message delivery bytes: pending={} delivered={} noRecipient={}",
            display_i64(message_delivery, "pendingMessageBodyBytes", 0),
            display_i64(message_delivery, "deliveredMessageBodyBytes", 0),
            display_i64(message_delivery, "noRecipientMessageBodyBytes", 0)
        ),
        format!(
            "Retained message delivery bytes: pending={} delivered={} noRecipient={}",
            display_i64(retained_message_delivery, "pendingMessageBodyBytes", 0),
            display_i64(retained_message_delivery, "deliveredMessageBodyBytes", 0),
            display_i64(retained_message_delivery, "noRecipientMessageBodyBytes", 0)
        ),
    ];
    for thread in exchange
        .get("largestRetainedThreads")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(5)
    {
        lines.push(format!(
            "Large retained thread: {} {}/{} messages={} bytes={} pendingBytes={} title={}",
            display_string(thread, "id", ""),
            display_string(thread, "kind", ""),
            display_string(thread, "status", ""),
            display_i64(thread, "messageCount", 0),
            display_i64(thread, "messageBodyBytes", 0),
            display_i64(thread, "pendingMessageBodyBytes", 0),
            display_string(thread, "title", "")
        ));
    }
    lines.push(format!(
        "Store: reads={} parses={} compactions={} compactedRecords={}",
        display_i64(telemetry, "reads", 0),
        display_i64(telemetry, "parses", 0),
        display_i64(telemetry, "compactions", 0),
        display_i64(telemetry, "compactedRecords", 0)
    ));
    lines.push(format!(
        "Cache: hits={} misses={} slowReads={} suppressedSlowReadLogs={}",
        display_i64(telemetry, "readCacheHits", 0),
        display_i64(telemetry, "readCacheMisses", 0),
        display_i64(telemetry, "slowReads", 0),
        display_i64(telemetry, "slowReadSuppressed", 0)
    ));
    lines.push(format!(
        "Writes: total={} noops={}",
        display_i64(telemetry, "writes", 0),
        display_i64(telemetry, "writeNoops", 0)
    ));
    lines
}

fn display_string(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

fn display_i64(value: &Value, key: &str, fallback: i64) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(fallback)
}

fn display_jsonish(value: &Value, fallback: &str) -> String {
    match value {
        Value::Null => fallback.to_owned(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        _ => fallback.to_owned(),
    }
}

fn route_project_root_or_cwd(
    runtime: &impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> String {
    let project_root = string_param(route_url, body, "projectRoot")
        .or_else(|| string_param(route_url, body, "project"))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path_resolve("."));
    runtime.resolve_project_root(&project_root)
}

fn restart_failure_count(restart: &Value) -> Option<i64> {
    restart
        .get("summary")
        .and_then(|summary| summary.get("failures"))
        .and_then(Value::as_i64)
}

fn summary_number(summary: &Value, key: &str) -> i64 {
    summary.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn step_status(value: &Value) -> String {
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("skipped");
    let Some(error) = value.get("error").and_then(Value::as_str) else {
        return status.to_owned();
    };
    format!("{status} ({error})")
}

fn dashboard_status(value: &Value) -> String {
    let status = step_status(value);
    let session_name = value.get("sessionName").and_then(Value::as_str);
    let window_id = value
        .get("target")
        .and_then(|target| target.get("windowId"))
        .and_then(Value::as_str);
    match (session_name, window_id) {
        (Some(session_name), Some(window_id)) => format!("{status} {session_name}:{window_id}"),
        _ => status,
    }
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

fn path_resolve(value: &str) -> String {
    let path = PathBuf::from(value);
    let resolved = if path.is_absolute() {
        normalize_path(path)
    } else {
        normalize_path(
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path),
        )
    };
    resolved.to_string_lossy().into_owned()
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut output = PathBuf::new();
    for component in Path::new(&path).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                output.pop();
            }
            _ => output.push(component.as_os_str()),
        }
    }
    output
}
