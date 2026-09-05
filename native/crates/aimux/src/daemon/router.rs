use crate::core_command_contract::CORE_API_ROUTES;
use crate::daemon::core_commands::{DaemonCoreCommandRuntime, route_core_command};
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
use crate::daemon::text::system::{DaemonSystemTextRuntime, route_system_text_request};
use crate::daemon::text::team::{DaemonTeamTextRuntime, route_team_text_request};
use crate::daemon::text::worktrees::{DaemonWorktreeTextRuntime, route_worktree_text_request};
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
    + DaemonNotificationTextRuntime
    + DaemonTeamTextRuntime
    + DaemonWorktreeTextRuntime
    + DaemonCollaborationTextRuntime
    + DaemonAuthTextRuntime
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
        + DaemonNotificationTextRuntime
        + DaemonTeamTextRuntime
        + DaemonWorktreeTextRuntime
        + DaemonCollaborationTextRuntime
        + DaemonAuthTextRuntime
{
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DaemonRouteRequestContext {
    pub actor_present: bool,
    pub headers: BTreeMap<String, String>,
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
    if let Some(response) = route_auth_text_request(runtime, method, path) {
        return response;
    }

    DaemonRouteResponse::json(404, json!({ "ok": false, "error": "not found" }))
}

fn has_origin_header(headers: &BTreeMap<String, String>) -> bool {
    headers.contains_key("origin") || headers.contains_key("Origin")
}
