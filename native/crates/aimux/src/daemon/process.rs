use crate::daemon::access::build_daemon_route_context;
use crate::daemon::http::PreparedDaemonResponse;
use crate::daemon::router::{DaemonRouteRuntime, route_daemon_request};
use crate::daemon::server::{DaemonHttpRequest, handle_daemon_http_request};
use std::cell::RefCell;

pub fn handle_daemon_runtime_request(
    runtime: &mut impl DaemonRouteRuntime,
    request: DaemonHttpRequest,
) -> PreparedDaemonResponse {
    let runtime = RefCell::new(runtime);
    handle_daemon_http_request(
        request,
        |method, path, body, headers| {
            let projects = runtime.borrow().list_projects_for_route();
            build_daemon_route_context(method, path, body, headers.clone(), &projects)
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
