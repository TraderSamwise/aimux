use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{render_core_dashboard_reload_lines, render_core_runtime_restart_lines};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, boolean_param, string_param, text_error,
    text_or_json_lines,
};
use serde_json::Value;
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
    if method == "GET" && pathname == CORE_API_ROUTES.doctor_tmux_text {
        return Some(doctor_tmux_text_route(runtime, &route_url));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.repair_text {
        return Some(repair_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.restart_text {
        return Some(restart_text_route(runtime, &route_url));
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

pub fn restart_text_route(
    runtime: &mut impl DaemonOperationsTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    let issued_at = runtime.now_iso();
    let project_root = route_url
        .search_param("project")
        .map(|project| runtime.resolve_project_root(project));
    match runtime.restart_control_plane(&issued_at, project_root.as_deref()) {
        Ok(result) => {
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

fn restart_failure_count(restart: &Value) -> Option<i64> {
    restart
        .get("summary")
        .and_then(|summary| summary.get("failures"))
        .and_then(Value::as_i64)
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
