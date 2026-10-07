use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest, DaemonRequestInit,
    execute_loopback_json_request, request_daemon_json,
};
use crate::daemon_state::load_metadata_endpoint;
use crate::dashboard_actions::DashboardActionRequest;
use crate::dashboard_model::DesktopStateSnapshot;
use crate::paths::PathResolver;
use crate::project_api_contract::routes;
use crate::project_service::lifecycle_mutation_queue::QUEUED_LIFECYCLE_TIMEOUT_MS;
use crate::project_service::routes::{
    ProjectServiceHttpMethod, ProjectServiceRouteGroup, project_service_specs_for,
};
use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectServiceEndpoint {
    pub host: String,
    pub port: u16,
}

pub fn resolve_project_service_endpoint(project_root: &Path) -> Result<ProjectServiceEndpoint> {
    if let Some(endpoint) = resolve_project_service_endpoint_from_disk(project_root) {
        return Ok(endpoint);
    }
    let projects = request_daemon_json(
        "/projects",
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Get),
            timeout_ms: Some(2_000),
            ..DaemonRequestInit::default()
        },
    )
    .context("request daemon projects")?;
    find_project_service_endpoint(&projects, project_root)
}

pub fn find_project_service_endpoint(
    projects: &Value,
    project_root: &Path,
) -> Result<ProjectServiceEndpoint> {
    let root_text = project_root.to_string_lossy();
    let project = projects
        .get("projects")
        .and_then(Value::as_array)
        .and_then(|projects| {
            projects.iter().find(|project| {
                string_field(project, "projectRoot")
                    .or_else(|| string_field(project, "path"))
                    .as_deref()
                    == Some(root_text.as_ref())
            })
        })
        .ok_or_else(|| anyhow!("project service is unavailable for {}", root_text))?;
    let endpoint = project
        .get("serviceEndpoint")
        .ok_or_else(|| anyhow!("project service endpoint is unavailable for {}", root_text))?;
    let host = string_field(endpoint, "host")
        .filter(|host| host == "127.0.0.1" || host == "localhost")
        .ok_or_else(|| anyhow!("project service endpoint must be loopback"))?;
    let port = endpoint
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or_else(|| anyhow!("project service endpoint port is invalid"))?;
    Ok(ProjectServiceEndpoint { host, port })
}

fn resolve_project_service_endpoint_from_disk(
    project_root: &Path,
) -> Option<ProjectServiceEndpoint> {
    let mut resolver = PathResolver::from_env();
    let endpoint = load_metadata_endpoint(resolver.project_state_dir_for(project_root))?;
    let candidate = ProjectServiceEndpoint {
        host: endpoint.host,
        port: endpoint.port,
    };
    project_service_health_ok(&candidate).then_some(candidate)
}

fn project_service_health_ok(endpoint: &ProjectServiceEndpoint) -> bool {
    let Ok(request) =
        build_project_service_json_request(endpoint, DaemonHttpMethod::Get, "/health", None)
    else {
        return false;
    };
    let Ok(response) = execute_loopback_json_request(&request).map_err(map_transport_error) else {
        return false;
    };
    (200..300).contains(&response.status)
        && response.json.get("ok").and_then(Value::as_bool) != Some(false)
}

pub fn fetch_desktop_state(endpoint: &ProjectServiceEndpoint) -> Result<DesktopStateSnapshot> {
    let response = execute_loopback_json_request(&build_project_service_json_request(
        endpoint,
        DaemonHttpMethod::Get,
        routes::DESKTOP_STATE,
        None,
    )?)
    .map_err(map_transport_error)?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(anyhow!("desktop-state request failed: {}", response.status));
    }
    serde_json::from_value(response.json).context("parse desktop-state response")
}

pub fn execute_dashboard_action(
    endpoint: &ProjectServiceEndpoint,
    action: &DashboardActionRequest,
) -> Result<Value> {
    let method = match action.method {
        "POST" => DaemonHttpMethod::Post,
        "GET" => DaemonHttpMethod::Get,
        other => return Err(anyhow!("unsupported dashboard action method: {other}")),
    };
    let mut request = build_project_service_json_request(
        endpoint,
        method,
        action.path,
        Some(action.body.clone()),
    )?;
    request.timeout_ms = Some(dashboard_action_timeout_ms(action.path));
    let response = execute_loopback_json_request(&request)
        .map_err(|error| map_action_transport_error(action.path, error))?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(anyhow!(
            "{}",
            dashboard_response_error("dashboard action failed", response.status, &response.json)
        ));
    }
    Ok(response.json)
}

fn dashboard_response_error(prefix: &str, status: u16, body: &Value) -> String {
    body.get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(|message| format!("{prefix}: {message}"))
        .unwrap_or_else(|| format!("{prefix}: {status}"))
}

pub fn refresh_dashboard_statusline(
    endpoint: &ProjectServiceEndpoint,
    client_session: &str,
) -> Result<Value> {
    let response = execute_loopback_json_request(&build_project_service_json_request(
        endpoint,
        DaemonHttpMethod::Post,
        routes::STATUSLINE_REFRESH,
        Some(json!({
            "sessionId": client_session,
            "force": true,
        })),
    )?)
    .map_err(map_transport_error)?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(anyhow!("statusline refresh failed: {}", response.status));
    }
    Ok(response.json)
}

pub fn fetch_dashboard_resource(endpoint: &ProjectServiceEndpoint, path: &str) -> Result<Value> {
    let response = execute_loopback_json_request(&build_project_service_json_request(
        endpoint,
        DaemonHttpMethod::Get,
        path,
        None,
    )?)
    .map_err(map_transport_error)?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(anyhow!(
            "dashboard resource request failed: {}",
            response.status
        ));
    }
    Ok(response.json)
}

pub fn build_project_service_json_request(
    endpoint: &ProjectServiceEndpoint,
    method: DaemonHttpMethod,
    path: &str,
    body: Option<Value>,
) -> Result<DaemonJsonRequest> {
    let body = body.map(|body| serde_json::to_string(&body)).transpose()?;
    let mut headers = BTreeMap::from([("accept".to_owned(), "application/json".to_owned())]);
    if let Some(body) = body.as_ref() {
        headers.insert("content-type".to_owned(), "application/json".to_owned());
        headers.insert("content-length".to_owned(), body.len().to_string());
    }
    Ok(DaemonJsonRequest {
        url: format!("http://{}:{}{}", endpoint.host, endpoint.port, path),
        method,
        headers,
        body,
        timeout_ms: Some(2_000),
    })
}

fn map_transport_error(error: CoreCommandTransportError) -> anyhow::Error {
    anyhow!(error.to_string())
}

/// The same error, with the two things the banner left the reader to guess.
///
/// `request timed out after 2000ms` named no route and claimed nothing about
/// the work, while a queued mutation that loses its listener keeps running --
/// the project service finishes it and records that the reply was never
/// delivered. So a user who read the banner as "that did not happen" and
/// pressed the key again got a second agent, because spawn mints its own
/// session id and is not idempotent.
fn map_action_transport_error(path: &str, error: CoreCommandTransportError) -> anyhow::Error {
    let CoreCommandTransportError::Timeout { timeout_ms } = &error else {
        return map_transport_error(error);
    };
    if is_queued_lifecycle_mutation(path) {
        anyhow!(
            "{path} timed out after {timeout_ms}ms waiting for the lifecycle \
             queue; the project service may still be finishing it, so check \
             before retrying"
        )
    } else {
        anyhow!("{path} timed out after {timeout_ms}ms")
    }
}

/// How long the dashboard waits for an action, which has to be at least as
/// long as the project service is prepared to make it wait.
///
/// Every lifecycle mutation queues behind ONE permit, and the queue waits up
/// to `WAIT_FOR_TURN_TIMEOUT` for its turn -- a budget picked because "the CLI
/// gives a project mutation 120s, so past that no caller is still listening".
/// The dashboard was not one of those callers: three routes had been raised by
/// hand after each one was caught lying, and everything else kept the 2s
/// default. So pressing a key on a project where any mutation was already
/// running reported a failure for work that was merely waiting its turn --
/// a brand-new checkout being the easy way to see it, because its row is
/// written before the git work starts and the create holds the permit for the
/// whole of it.
///
/// Asked of the route table rather than listed again here, so a lifecycle
/// route added later cannot inherit a budget shorter than its own queue.
fn dashboard_action_timeout_ms(path: &str) -> u64 {
    match path {
        // Longer than a queued mutation's wait, not shorter: these do real
        // filesystem work once they have the permit.
        routes::worktree_actions::CREATE
        | routes::worktree_actions::CACHE_CLEANUP
        | routes::worktree_actions::REMOVE
        | routes::worktree_actions::GRAVEYARD => 180_000,
        // One request that launches the whole offered fleet in turn. 35 agents
        // took 12.4s on sam-strix, so the default budget expired a sixth of the
        // way in and a working restore reported itself as a transport timeout.
        routes::agents::RESTORE_PREVIOUS => 180_000,
        _ if is_queued_lifecycle_mutation(path) => QUEUED_LIFECYCLE_TIMEOUT_MS,
        _ => 2_000,
    }
}

/// Whether this route queues behind the project service's lifecycle permit.
fn is_queued_lifecycle_mutation(path: &str) -> bool {
    project_service_specs_for(ProjectServiceHttpMethod::Post, path)
        .iter()
        .any(|spec| spec.group == ProjectServiceRouteGroup::Lifecycle)
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dashboard_response_error_includes_project_service_reason() {
        assert_eq!(
            dashboard_response_error(
                "dashboard action failed",
                500,
                &json!({ "ok": false, "error": "tmux failed to create window" })
            ),
            "dashboard action failed: tmux failed to create window"
        );
    }

    /// Every route that queues behind the lifecycle permit, asked of the route
    /// table rather than listed here.
    ///
    /// The queue waits up to 150s for its turn and the CLI allows 120s, so a
    /// client that gives up sooner reports "your request failed" for work that
    /// is merely waiting. Three routes had been raised by hand, each after it
    /// was caught lying; the rest kept 2s, which is every stop, resume, kill,
    /// interrupt, rename, migrate, switch-tool and teammate action.
    #[test]
    fn no_lifecycle_action_gives_up_before_its_own_queue_does() {
        let lifecycle = crate::project_service::routes::project_service_route_specs()
            .into_iter()
            .filter(|spec| spec.group == ProjectServiceRouteGroup::Lifecycle)
            .filter(|spec| spec.method == ProjectServiceHttpMethod::Post)
            .collect::<Vec<_>>();
        assert!(
            lifecycle.len() > 10,
            "the lifecycle group should be the whole mutation surface, got {}",
            lifecycle.len()
        );
        for spec in &lifecycle {
            // Exact paths only: a prefix route has no single path the client
            // sends, and every lifecycle route today is exact.
            let Some(path) = spec.pattern.exact_path() else {
                continue;
            };
            let budget = dashboard_action_timeout_ms(path);
            assert!(
                budget >= QUEUED_LIFECYCLE_TIMEOUT_MS,
                "{path} gives up after {budget}ms while its queue waits \
                 {QUEUED_LIFECYCLE_TIMEOUT_MS}ms for a turn"
            );
        }
    }

    /// A timeout that abandons work has to say so.
    ///
    /// The banner read `request timed out after 2000ms`: no route, and no hint
    /// that the mutation was still running. Spawn is not idempotent, so a user
    /// who read that as "it did not happen" and pressed the key again got a
    /// second agent.
    #[test]
    fn an_abandoned_mutation_says_it_may_still_be_running() {
        let message = map_action_transport_error(
            routes::agents::SPAWN,
            CoreCommandTransportError::Timeout { timeout_ms: 2_000 },
        )
        .to_string();
        assert!(
            message.contains(routes::agents::SPAWN),
            "names no route: {message}"
        );
        assert!(
            message.contains("may still be finishing"),
            "does not say the work outlives the request: {message}"
        );
        assert!(
            message.contains("before retrying"),
            "does not warn that a retry is not free: {message}"
        );

        // A read carries no such promise, so it must not make one.
        let read = map_action_transport_error(
            "/desktop-state",
            CoreCommandTransportError::Timeout { timeout_ms: 2_000 },
        )
        .to_string();
        assert!(read.contains("/desktop-state"), "names no route: {read}");
        assert!(
            !read.contains("may still be finishing"),
            "a read does not keep running after the client leaves: {read}"
        );
    }

    /// And a read is still answered promptly, so the budget did not simply
    /// become "wait forever for everything".
    #[test]
    fn a_read_keeps_the_short_budget() {
        assert_eq!(dashboard_action_timeout_ms("/does/not/queue"), 2_000);
        assert!(!is_queued_lifecycle_mutation("/does/not/queue"));
        assert!(is_queued_lifecycle_mutation(routes::agents::RESUME));
    }

    // 35 agents took 12.4s on sam-strix. On the default budget the dashboard
    // gave up a sixth of the way in and reported a working restore as a
    // transport timeout, with every row still showing offline.
    #[test]
    fn restoring_a_fleet_is_not_given_a_single_actions_budget() {
        let restore = dashboard_action_timeout_ms(routes::agents::RESTORE_PREVIOUS);
        assert!(
            restore >= 60_000,
            "restore launches every offered agent in one request; got {restore}ms"
        );
        // `KILL` used to assert 2s here, as "a single-agent action keeps the
        // short budget". Being one agent's action is not the question: it
        // queues behind the same permit as the fleet restore, so 2s reported
        // a failure whenever anything else held it.
        assert!(
            dashboard_action_timeout_ms(routes::agents::KILL) >= QUEUED_LIFECYCLE_TIMEOUT_MS,
            "one agent's action still waits in the same queue"
        );
        assert_eq!(
            dashboard_action_timeout_ms("/desktop-state"),
            2_000,
            "a read that queues behind nothing keeps the short budget"
        );
    }

    #[test]
    fn dashboard_response_error_falls_back_to_status_without_reason() {
        assert_eq!(
            dashboard_response_error("dashboard action failed", 503, &json!({ "ok": false })),
            "dashboard action failed: 503"
        );
    }
}
