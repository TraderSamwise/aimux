use crate::core_command_contract::CORE_API_ROUTES;
use crate::daemon::core_commands::{DaemonCoreCommandRuntime, route_core_command};
use crate::daemon::json::{DaemonJsonRouteRuntime, route_json_daemon_request};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, local_auth_routes, local_cli_text_routes,
};
use crate::daemon::status::{DaemonStatusRuntime, route_status_request};
use crate::daemon::text::agents::{DaemonAgentTextRuntime, route_agent_text_request};
use crate::daemon::text::auth::{DaemonAuthTextRuntime, route_auth_text_request};
use crate::daemon::text::collaboration::{
    DaemonCollaborationTextRuntime, route_collaboration_text_request,
};
use crate::daemon::text::host_agent::{DaemonHostAgentTextRuntime, route_host_agent_text_request};
use crate::daemon::text::metadata::{DaemonMetadataTextRuntime, route_metadata_text_request};
use crate::daemon::text::notifications::{
    DaemonNotificationTextRuntime, route_notification_text_request,
};
use crate::daemon::text::operations::{DaemonOperationsTextRuntime, route_operations_text_request};
use crate::daemon::text::overseer::{DaemonOverseerTextRuntime, route_overseer_text_request};
use crate::daemon::text::project_content::{
    DaemonProjectContentTextRuntime, route_project_content_text_request,
};
use crate::daemon::text::scribe::{DaemonScribeTextRuntime, route_scribe_text_request};
use crate::daemon::text::system::{DaemonSystemTextRuntime, route_system_text_request};
use crate::daemon::text::team::{DaemonTeamTextRuntime, route_team_text_request};
use crate::daemon::text::worktrees::{DaemonWorktreeTextRuntime, route_worktree_text_request};
use crate::remote_access::RemoteAccessDecision;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub trait DaemonRouteRuntime:
    DaemonStatusRuntime
    + DaemonCoreCommandRuntime
    + DaemonOperationsTextRuntime
    + DaemonHostAgentTextRuntime
    + DaemonSystemTextRuntime
    + DaemonMetadataTextRuntime
    + DaemonAgentTextRuntime
    + DaemonOverseerTextRuntime
    + DaemonScribeTextRuntime
    + DaemonNotificationTextRuntime
    + DaemonTeamTextRuntime
    + DaemonWorktreeTextRuntime
    + DaemonCollaborationTextRuntime
    + DaemonProjectContentTextRuntime
    + DaemonAuthTextRuntime
    + DaemonJsonRouteRuntime
{
}

impl<T> DaemonRouteRuntime for T where
    T: DaemonStatusRuntime
        + DaemonCoreCommandRuntime
        + DaemonOperationsTextRuntime
        + DaemonHostAgentTextRuntime
        + DaemonSystemTextRuntime
        + DaemonMetadataTextRuntime
        + DaemonAgentTextRuntime
        + DaemonOverseerTextRuntime
        + DaemonScribeTextRuntime
        + DaemonNotificationTextRuntime
        + DaemonTeamTextRuntime
        + DaemonWorktreeTextRuntime
        + DaemonCollaborationTextRuntime
        + DaemonProjectContentTextRuntime
        + DaemonAuthTextRuntime
        + DaemonJsonRouteRuntime
{
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DaemonRouteRequestContext {
    pub actor_present: bool,
    pub headers: BTreeMap<String, String>,
    pub access_decision: Option<RemoteAccessDecision>,
}

pub fn route_daemon_request(
    runtime: &mut impl DaemonRouteRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
    issued_at: &str,
    context: &DaemonRouteRequestContext,
) -> DaemonRouteResponse {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if let Some(access) = &context.access_decision
        && !access.ok
    {
        return DaemonRouteResponse::json(
            access.status.unwrap_or(403),
            json!({ "ok": false, "error": access.error.as_deref().unwrap_or("remote access denied") }),
        );
    }
    if method != "GET"
        && let Some(reason) = crate::runtime_safety_guard::request_refusal_reason(&context.headers)
    {
        return DaemonRouteResponse::json(
            403,
            json!({ "ok": false, "error": format!("refusing daemon side effects from {reason}") }),
        );
    }
    if method != "GET"
        && !allows_project_cleanup_side_effect(pathname, body)
        && let Some(reason) =
            crate::runtime_safety_guard::request_project_refusal_reason(&route_url, body)
    {
        return DaemonRouteResponse::json(
            403,
            json!({ "ok": false, "error": format!("refusing to materialize {reason}") }),
        );
    }
    if method != "GET"
        && !allows_project_cleanup_side_effect(pathname, body)
        && route_can_materialize_project(pathname, body)
        && let Some(reason) =
            crate::runtime_safety_guard::request_missing_project_refusal_reason(&route_url, body)
    {
        return DaemonRouteResponse::json(
            403,
            json!({ "ok": false, "error": format!("refusing to materialize {reason}") }),
        );
    }

    if method == "POST" && local_auth_routes().contains(&pathname) && context.actor_present {
        return DaemonRouteResponse::text(403, "auth routes are loopback-only\n");
    }
    if local_cli_text_routes().contains(&pathname) && context.actor_present {
        return DaemonRouteResponse::text(403, "core text routes are loopback-only\n");
    }
    if local_cli_text_routes().contains(&pathname) && has_origin_header(&context.headers) {
        return DaemonRouteResponse::text(403, "core text routes are cli-only\n");
    }

    if let Some(response) = route_status_request(runtime, method, path, issued_at) {
        return response;
    }
    if method == "POST" && pathname == CORE_API_ROUTES.commands {
        return route_core_command(runtime, body, issued_at);
    }
    if let Some(response) = route_host_agent_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_system_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_metadata_text_request(runtime, method, path) {
        return response;
    }
    if let Some(response) = route_operations_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_agent_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_overseer_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_scribe_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_notification_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_team_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_worktree_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_collaboration_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_project_content_text_request(runtime, method, path, body) {
        return response;
    }
    if let Some(response) = route_auth_text_request(runtime, method, path) {
        return response;
    }
    if let Some(response) = route_json_daemon_request(
        runtime,
        method,
        path,
        body,
        &context.headers,
        context.actor_present,
    ) {
        return response;
    }

    DaemonRouteResponse::json(404, json!({ "ok": false, "error": "not found" }))
}

fn has_origin_header(headers: &BTreeMap<String, String>) -> bool {
    headers.contains_key("origin") || headers.contains_key("Origin")
}

fn allows_project_cleanup_side_effect(pathname: &str, body: Option<&Value>) -> bool {
    if pathname == CORE_API_ROUTES.project_stop_text
        || pathname == CORE_API_ROUTES.project_kill_text
        || pathname == CORE_API_ROUTES.projects_remove_text
    {
        return true;
    }
    pathname == CORE_API_ROUTES.commands
        && body
            .and_then(|body| body.get("command"))
            .and_then(Value::as_str)
            .is_some_and(|command| {
                command == crate::core_command_contract::CORE_COMMAND_NAMES.project_stop
                    || command == crate::core_command_contract::CORE_COMMAND_NAMES.project_kill
            })
}

fn route_can_materialize_project(pathname: &str, body: Option<&Value>) -> bool {
    if pathname == "/projects/ensure"
        || pathname == CORE_API_ROUTES.project_ensure_text
        || pathname == CORE_API_ROUTES.project_serve_text
        || pathname == CORE_API_ROUTES.project_restart_text
    {
        return true;
    }
    pathname == CORE_API_ROUTES.commands
        && body
            .and_then(|body| body.get("command"))
            .and_then(Value::as_str)
            .is_some_and(|command| {
                command == crate::core_command_contract::CORE_COMMAND_NAMES.project_ensure
                    || command == crate::core_command_contract::CORE_COMMAND_NAMES.project_restart
            })
}
