use serde_json::json;

use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::project_service_manifest::get_project_service_manifest;

use super::dispatcher::{
    ProjectServiceDispatchResponse, project_service_pathname,
    route_unimplemented_project_service_request,
};
use super::router::ProjectServiceRequestContext;

pub fn route_read_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }

    if pathname == routes::HEALTH {
        let service_info = match get_project_service_manifest() {
            Ok(manifest) => serde_json::to_value(manifest).unwrap_or_else(|_| json!({})),
            Err(error) => json!({ "error": error.to_string() }),
        };
        return Some(ProjectServiceDispatchResponse {
            status: 200,
            body: json!({
                "ok": true,
                "projectStateDir": context.project_state_dir_string(),
                "pid": std::process::id(),
                "serviceInfo": service_info,
            }),
        });
    }

    if pathname == routes::STATE {
        let state = load_metadata_state(context.project_state_dir());
        return Some(ProjectServiceDispatchResponse {
            status: 200,
            body: serde_json::to_value(state)
                .unwrap_or_else(|_| json!({ "version": 1, "sessions": {} })),
        });
    }

    if pathname == routes::DIAGNOSTICS
        || pathname == routes::DIAGNOSTICS_LIFECYCLE
        || pathname == routes::DESKTOP_STATE
        || pathname == routes::COORDINATION_WORKLIST
        || pathname == routes::PROJECT_OBSERVABILITY
        || pathname == routes::TOPOLOGY
        || pathname == routes::LIBRARY
        || pathname == routes::WORKTREES
        || pathname == routes::GRAVEYARD
        || pathname == routes::notifications::LIST
        || pathname == routes::orchestration::ROUTES
        || pathname == routes::agents::LIST
        || pathname == routes::agents::TEAMMATES
        || pathname == routes::agents::HISTORY
        || pathname == routes::threads::LIST
        || pathname == routes::tasks::LIST
        || pathname == routes::team::CONFIG
        || pathname == routes::controls::SWITCHABLE_AGENTS
    {
        return Some(route_unimplemented_project_service_request(method, path));
    }

    None
}
