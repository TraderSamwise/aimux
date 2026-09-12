use crate::daemon::access::build_daemon_route_context;
use crate::daemon::http::PreparedDaemonResponse;
use crate::daemon::router::DaemonRouteRequestContext;
use crate::daemon::router::{DaemonRouteRuntime, route_daemon_request};
use crate::daemon::server::{DaemonHttpRequest, handle_daemon_http_request};
use crate::remote_access::{RemoteAccessDecision, RemoteActorRole, parse_remote_actor};
use std::cell::RefCell;

pub fn handle_daemon_runtime_request(
    runtime: &mut impl DaemonRouteRuntime,
    request: DaemonHttpRequest,
) -> PreparedDaemonResponse {
    let runtime = RefCell::new(runtime);
    handle_daemon_http_request(
        request,
        |method, path, body, headers| {
            let actor = parse_remote_actor(headers);
            let needs_project_binding = actor
                .as_ref()
                .is_some_and(|actor| actor.role == RemoteActorRole::Operator);
            if needs_project_binding {
                match runtime.borrow().try_list_projects_for_route() {
                    Ok(projects) => {
                        build_daemon_route_context(method, path, body, headers.clone(), &projects)
                    }
                    Err(error) => DaemonRouteRequestContext {
                        actor_present: actor.is_some(),
                        headers: headers.clone(),
                        access_decision: Some(RemoteAccessDecision::deny(500, error)),
                    },
                }
            } else {
                build_daemon_route_context(method, path, body, headers.clone(), &[])
            }
        },
        |method, path, body, context, issued_at| {
            route_daemon_request(
                &mut **runtime.borrow_mut(),
                method,
                path,
                body,
                issued_at,
                context,
            )
        },
    )
}
