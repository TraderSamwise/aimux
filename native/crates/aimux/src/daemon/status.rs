use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{
    render_core_daemon_projects_lines, render_core_daemon_status_lines,
    render_core_host_status_lines, render_core_projects_list_lines,
};
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl, text_or_json_lines};
use crate::daemon_projects::ProjectsRouteProject;
use crate::daemon_state::{AimuxDaemonInfo, DaemonState};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

pub const DAEMON_HEALTH_KIND: &str = "aimux-daemon";

pub trait DaemonStatusRuntime {
    fn current_daemon_info(&self, issued_at: &str) -> AimuxDaemonInfo;
    fn project_service_info(&self) -> Value;
    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject>;
    fn try_list_projects_for_route(&self) -> Result<Vec<ProjectsRouteProject>, String> {
        Ok(self.list_projects_for_route())
    }
    fn list_projects_with_online_agent_counts_for_route(&mut self) -> Vec<ProjectsRouteProject> {
        self.list_projects_for_route()
    }
    fn try_list_projects_with_online_agent_counts_for_route(
        &mut self,
    ) -> Result<Vec<ProjectsRouteProject>, String> {
        Ok(self.list_projects_with_online_agent_counts_for_route())
    }
    fn ensure_project_paths(&mut self, _project: &str) {}
    fn daemon_state(&self) -> DaemonState;
    fn relay_status(&self) -> Value;
    fn resolve_project_root(&self, cwd: &str) -> String;
}

/// The daemon's health body, built in exactly one place.
///
/// Two routes answer `GET /health`: this module's, reached with the runtime
/// already borrowed, and the lock-free one in `daemon/runtime.rs` that the
/// loopback listener reaches first. They had the same five fields written out
/// twice, and `DaemonHealthIdentity` was about to make that two different
/// derivations of `pid` and `port` -- which is the shape AGENTS.md calls the
/// bug even when the two currently agree.
/// The one body both `/health` handlers answer with.
///
/// `runtime_unusable` is the readiness probe's whole job done honestly. This
/// route deliberately takes no runtime lock, which is what keeps it answering
/// while unrelated work holds the mutex -- but it also means a POISONED mutex
/// leaves this route cheerfully reporting `ok: true` while every other route
/// panics on `lock().expect(..)`. A probe that says ready when the process can
/// serve nothing is worse than a slow probe, which is the thing the carve-out
/// was built to avoid.
///
/// The shape follows the scheduler's own diagnostics, which answer a poisoned
/// health lock with `ok: false` and an error rather than inventing a status.
/// The HTTP status stays 200 on purpose: nothing in this crate branches on
/// `ok` for the daemon -- `is_aimux_daemon_health` checks `kind` and `pid` --
/// so changing the status would alter a contract no in-tree consumer needs
/// altered, and a caller that only reads the status learns nothing new either
/// way. Making the field true is the part that is unambiguously right.
pub fn daemon_health_payload(
    pid: i32,
    port: u16,
    service_info: Value,
    runtime_unusable: bool,
) -> Value {
    if runtime_unusable {
        return json!({
            "ok": false,
            "kind": DAEMON_HEALTH_KIND,
            "pid": pid,
            "port": port,
            "serviceInfo": service_info,
            "error": "daemon runtime mutex is poisoned, so every route that takes it will panic",
        });
    }
    json!({
        "ok": true,
        "kind": DAEMON_HEALTH_KIND,
        "pid": pid,
        "port": port,
        "serviceInfo": service_info,
    })
}

pub fn route_status_request(
    runtime: &mut impl DaemonStatusRuntime,
    method: &str,
    path: &str,
    issued_at: &str,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET" && pathname == "/health" {
        let daemon = runtime.current_daemon_info(issued_at);
        return Some(DaemonRouteResponse::json(
            200,
            daemon_health_payload(
                daemon.pid,
                daemon.port,
                runtime.project_service_info(),
                // Reaching here means the lock was acquired, so by definition
                // it was not poisoned. Only the lock-free handler can observe
                // that state, which is why this is not a second source of
                // truth drifting from the first.
                false,
            ),
        ));
    }

    if method == "GET" && pathname == CORE_API_ROUTES.daemon_ensure_text {
        let payload = daemon_ensure_payload(runtime, issued_at);
        let daemon = &payload["daemon"];
        let line = format!(
            "aimux daemon: pid {} on http://127.0.0.1:{}",
            js_string(&daemon["pid"]),
            js_string(&daemon["port"])
        );
        return Some(text_or_json_lines(&route_url, payload, &[line]));
    }

    if method == "GET" && pathname == CORE_API_ROUTES.host_status_text {
        let Some(project) = route_url.search_param("project") else {
            return Some(DaemonRouteResponse::text(
                400,
                "project query is required\n",
            ));
        };
        runtime.ensure_project_paths(project);
        let (payload, known_project) = match host_status_payload(runtime, project, issued_at) {
            Ok(payload) => payload,
            Err(error) => {
                return Some(DaemonRouteResponse::text(500, format!("Error: {error}\n")));
            }
        };
        return Some(text_or_json_lines(
            &route_url,
            payload.clone(),
            &render_core_host_status_lines(&payload, known_project),
        ));
    }

    if method == "GET" && pathname == CORE_API_ROUTES.daemon_status_text {
        let projects = match runtime.try_list_projects_for_route() {
            Ok(projects) => projects,
            Err(error) => {
                return Some(DaemonRouteResponse::text(500, format!("Error: {error}\n")));
            }
        };
        let payload = daemon_status_payload(runtime, issued_at, &projects);
        return Some(text_or_json_lines(
            &route_url,
            payload.clone(),
            &render_core_daemon_status_lines(&payload),
        ));
    }

    if method == "GET" && pathname == CORE_API_ROUTES.daemon_projects_text {
        let projects = match runtime.try_list_projects_for_route() {
            Ok(projects) => projects_json(projects),
            Err(error) => {
                return Some(DaemonRouteResponse::text(500, format!("Error: {error}\n")));
            }
        };
        return Some(text_or_json_lines(
            &route_url,
            json!({ "projects": projects.clone() }),
            &render_core_daemon_projects_lines(&projects),
        ));
    }

    if method == "GET" && pathname == CORE_API_ROUTES.projects_list_text {
        let projects = match runtime.try_list_projects_for_route() {
            Ok(projects) => projects_json(projects),
            Err(error) => {
                return Some(DaemonRouteResponse::text(500, format!("Error: {error}\n")));
            }
        };
        return Some(text_or_json_lines(
            &route_url,
            json!({ "projects": projects.clone() }),
            &render_core_projects_list_lines(&projects),
        ));
    }

    if method == "GET" && pathname == "/projects" {
        let projects = match runtime.try_list_projects_with_online_agent_counts_for_route() {
            Ok(projects) => projects,
            Err(error) => {
                return Some(DaemonRouteResponse::json(
                    500,
                    json!({ "ok": false, "error": error }),
                ));
            }
        };
        return Some(DaemonRouteResponse::json(
            200,
            json!({ "ok": true, "projects": projects }),
        ));
    }

    if method == "GET" && pathname.starts_with("/projects/") {
        let project_id = percent_decode_lossy(&pathname["/projects/".len()..]);
        let project = runtime
            .daemon_state()
            .projects
            .get(&project_id)
            .cloned()
            .unwrap_or(Value::Null);
        return Some(DaemonRouteResponse::json(
            200,
            json!({ "ok": true, "project": project }),
        ));
    }

    None
}

pub fn daemon_ensure_payload(runtime: &impl DaemonStatusRuntime, issued_at: &str) -> Value {
    let daemon = daemon_info_json(
        runtime.current_daemon_info(issued_at),
        runtime.project_service_info(),
    );
    json!({ "daemon": daemon })
}

pub fn daemon_status_payload(
    runtime: &impl DaemonStatusRuntime,
    issued_at: &str,
    route_projects: &[ProjectsRouteProject],
) -> Value {
    let service_alive_by_id = route_projects
        .iter()
        .map(|project| (project.id.clone(), project.service_alive))
        .collect::<BTreeMap<_, _>>();
    let state = runtime.daemon_state();
    let project_service_fleet = project_service_fleet_json(route_projects, &state);
    let projects = state
        .projects
        .into_values()
        .map(|project| {
            let mut object = project.as_object().cloned().unwrap_or_default();
            let project_id = object
                .get("projectId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            object.insert(
                "serviceAlive".to_owned(),
                Value::Bool(*service_alive_by_id.get(project_id).unwrap_or(&false)),
            );
            Value::Object(object)
        })
        .collect::<Vec<_>>();
    json!({
        "daemon": daemon_info_json(runtime.current_daemon_info(issued_at), runtime.project_service_info()),
        "projects": projects,
        "projectServiceFleet": project_service_fleet,
        "relay": runtime.relay_status(),
    })
}

pub fn project_service_fleet_json(projects: &[ProjectsRouteProject], state: &DaemonState) -> Value {
    let catalog_project_ids = projects
        .iter()
        .map(|project| project.id.as_str())
        .collect::<BTreeSet<_>>();
    let live_project_service_count = projects
        .iter()
        .filter(|project| project.service_alive)
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

pub fn host_status_payload(
    runtime: &impl DaemonStatusRuntime,
    cwd: &str,
    issued_at: &str,
) -> Result<(Value, bool), String> {
    let project_root = runtime.resolve_project_root(cwd);
    let projects = runtime.try_list_projects_for_route()?;
    let project = find_project_for_root(&projects, &project_root);
    let daemon = daemon_info_json(
        runtime.current_daemon_info(issued_at),
        runtime.project_service_info(),
    );
    let payload = json!({
        "projectRoot": project_root,
        "sessionName": project.map(|project| project.dashboard_session_name.clone()),
        "daemon": daemon,
        "projectService": project.and_then(|project| project.service.clone()),
        "serviceAlive": project.map(|project| project.service_alive).unwrap_or(false),
        "metadataEndpoint": project.and_then(|project| project.service_endpoint.clone()),
        "expectedServiceManifest": daemon["serviceInfo"].clone(),
    });
    Ok((payload, project.is_some()))
}

fn daemon_info_json(info: AimuxDaemonInfo, service_info: Value) -> Value {
    json!({
        "pid": info.pid,
        "port": info.port,
        "startedAt": info.started_at,
        "updatedAt": info.updated_at,
        "serviceInfo": service_info,
    })
}

fn projects_json(projects: Vec<ProjectsRouteProject>) -> Value {
    serde_json::to_value(projects).expect("projects route payload must serialize")
}

fn find_project_for_root<'a>(
    projects: &'a [ProjectsRouteProject],
    project_root: &str,
) -> Option<&'a ProjectsRouteProject> {
    let resolved = path_resolve(project_root);
    projects
        .iter()
        .find(|project| path_resolve(&project.path) == resolved)
}

fn path_resolve(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
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

fn percent_decode_lossy(input: &str) -> String {
    let mut output = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < raw.len() => {
                let hex = std::str::from_utf8(&raw[index + 1..index + 3]);
                if let Ok(hex) = hex
                    && let Ok(value) = u8::from_str_radix(hex, 16)
                {
                    output.push(value);
                    index += 3;
                    continue;
                }
                output.push(raw[index]);
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

#[cfg(test)]
mod poisoned_runtime_tests {
    use super::*;
    use serde_json::json;

    /// The readiness probe must not report ready when every other route panics.
    ///
    /// `/health` takes no runtime lock, which is what keeps it fast and is also
    /// why it is the ONE surface still answering after a route panicked under
    /// the guard. Before this it answered `ok: true` there.
    #[test]
    fn a_poisoned_runtime_is_not_reported_as_ready() {
        let healthy = daemon_health_payload(4_242, 45_992, json!({ "buildStamp": "x" }), false);
        assert_eq!(healthy.get("ok"), Some(&Value::Bool(true)));
        assert!(
            healthy.get("error").is_none(),
            "a usable runtime must not carry an error: {healthy}"
        );

        let poisoned = daemon_health_payload(4_242, 45_992, json!({ "buildStamp": "x" }), true);
        assert_eq!(
            poisoned.get("ok"),
            Some(&Value::Bool(false)),
            "a poisoned runtime cannot serve, so the probe must say so: {poisoned}"
        );
        assert!(
            poisoned
                .get("error")
                .and_then(Value::as_str)
                .is_some_and(|error| error.contains("poisoned")),
            "the error must name the cause rather than just flipping a flag: {poisoned}"
        );

        // The identifying fields survive, because the supervisor matches on
        // `kind` and `pid` -- flipping `ok` must not make the daemon
        // unrecognisable to the thing that adopts it.
        for field in ["kind", "pid", "port", "serviceInfo"] {
            assert_eq!(
                poisoned.get(field),
                healthy.get(field),
                "{field} must be unchanged by the poison report"
            );
        }
    }
}
