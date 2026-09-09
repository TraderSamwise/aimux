use serde_json::Value;

use crate::project_api_contract::routes;
use crate::runtime_topology::read_runtime_topology;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

mod agent_launch_helpers;
mod agent_launch_routes;
mod agent_management;
mod agent_session_launch;
mod agent_topology;
mod default_scribe;
mod ids;
mod json_helpers;
mod response_helpers;
mod restore_offer;
mod runtime_adapter;
mod services;
mod session_state;
mod teammates;
mod topology_helpers;
mod worktrees;

use agent_launch_helpers::*;
use agent_launch_routes::*;
use agent_management::*;
use agent_session_launch::*;
pub use default_scribe::ensure_default_scribe_agent;
pub(crate) use default_scribe::is_scribe_session;
use ids::*;
use json_helpers::*;
use response_helpers::*;
use restore_offer::*;
pub use runtime_adapter::{ProjectLifecycleRuntime, SystemProjectLifecycleRuntime};
use services::*;
use session_state::*;
use teammates::*;
use topology_helpers::*;
use worktrees::*;

const LIVE_STATUSES: &[&str] = &["starting", "running", "idle"];

pub fn route_lifecycle_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemProjectLifecycleRuntime;
    route_lifecycle_request_with_runtime(context, method, path, body, &mut runtime)
}

pub fn route_lifecycle_request_with_runtime(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let pathname = project_service_pathname(path);
    let body = body.unwrap_or(&Value::Null);
    match pathname {
        routes::agents::SPAWN => Some(route_agent_spawn(context, body, runtime)),
        routes::agents::FORK => Some(route_agent_fork(context, body, runtime)),
        routes::agents::SWITCH_TOOL => Some(route_agent_switch_tool(context, body, runtime)),
        routes::agents::STOP => Some(route_agent_stop(context, body, runtime)),
        routes::agents::KILL => Some(route_agent_kill(context, body, runtime)),
        routes::agents::RENAME => Some(route_agent_rename(context, body, runtime)),
        routes::agents::MIGRATE => Some(route_agent_migrate(context, body, runtime)),
        routes::agents::RESUME => Some(route_agent_resume(context, body, runtime)),
        routes::agents::RESTORE_PREVIOUS => Some(route_agent_restore_previous(context, runtime)),
        routes::agents::DISMISS_RESTORE_PREVIOUS => {
            Some(route_agent_dismiss_restore_previous(context))
        }
        routes::agents::CREATE_TEAMMATE => {
            Some(route_agent_create_teammate(context, body, runtime))
        }
        routes::agents::STOP_TEAMMATE => Some(route_agent_stop_teammate(context, body, runtime)),
        routes::agents::RESUME_TEAMMATE => {
            Some(route_agent_resume_teammate(context, body, runtime))
        }
        routes::agents::KILL_TEAMMATE => Some(route_agent_kill_teammate(context, body, runtime)),
        routes::agents::RESURRECT_TEAMMATE => Some(route_agent_resurrect_teammate(context, body)),
        routes::agents::RECORD_BACKEND_SESSION => Some(route_record_backend_session(context, body)),
        routes::services::CREATE => Some(route_service_create(context, body, runtime)),
        routes::services::RESUME => Some(route_service_resume(context, body, runtime)),
        routes::services::STOP => Some(route_service_stop(context, body, runtime)),
        routes::services::REMOVE => Some(route_service_remove(context, body, runtime)),
        routes::graveyard_actions::RESURRECT_AGENT => {
            Some(route_graveyard_agent_resurrect(context, body))
        }
        routes::worktree_actions::CREATE => Some(route_worktree_create(context, body, runtime)),
        routes::worktree_actions::CACHE_CLEANUP => {
            Some(route_worktree_cache_cleanup(context, body, runtime))
        }
        routes::worktree_actions::GRAVEYARD => {
            Some(route_worktree_graveyard(context, body, runtime))
        }
        routes::worktree_actions::REMOVE => Some(route_worktree_remove(context, body, runtime)),
        routes::graveyard_actions::RESURRECT_WORKTREE => {
            Some(route_graveyard_worktree_resurrect(context, body))
        }
        routes::graveyard_actions::DELETE_WORKTREE => {
            Some(route_graveyard_worktree_delete(context, body))
        }
        routes::graveyard_actions::CLEANUP => Some(route_graveyard_cleanup(context, body)),
        _ => None,
    }
}
