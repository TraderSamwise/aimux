use aimux::project_api_contract::routes;
use aimux::project_service::dispatcher::{
    ProjectServiceRouteResolution, project_service_pathname, resolve_project_service_route,
    route_unimplemented_project_service_request,
};
use aimux::project_service::routes::{
    ProjectServiceHttpMethod as Method, ProjectServiceResponseKind as ResponseKind,
    ProjectServiceRouteGroup as Group,
};
use serde_json::json;

#[test]
fn resolves_known_routes_to_their_split_group() {
    let ProjectServiceRouteResolution::Route(spec) =
        resolve_project_service_route("GET", "/desktop-state?includePreview=1")
    else {
        panic!("desktop-state should resolve");
    };
    assert_eq!(spec.method, Method::Get);
    assert_eq!(spec.group, Group::Reads);
    assert_eq!(spec.response, ResponseKind::Json);

    let ProjectServiceRouteResolution::Route(spec) =
        resolve_project_service_route("post", routes::agents::SPAWN)
    else {
        panic!("agent spawn should resolve");
    };
    assert_eq!(spec.method, Method::Post);
    assert_eq!(spec.group, Group::Lifecycle);
}

#[test]
fn resolves_dynamic_routes_without_overmatching() {
    let ProjectServiceRouteResolution::Route(plan) =
        resolve_project_service_route("PUT", "/plans/codex-1")
    else {
        panic!("plan write should resolve");
    };
    assert_eq!(plan.group, Group::Plans);

    let ProjectServiceRouteResolution::Route(content) =
        resolve_project_service_route("GET", "/attachments/file-1/content")
    else {
        panic!("attachment content should resolve");
    };
    assert_eq!(content.group, Group::Io);
    assert_eq!(content.response, ResponseKind::Binary);

    assert_eq!(
        resolve_project_service_route("GET", "/attachments/file-1/extra"),
        ProjectServiceRouteResolution::NotFound {
            path: "/attachments/file-1/extra".into(),
        }
    );
}

#[test]
fn reports_method_not_allowed_for_known_paths() {
    assert_eq!(
        resolve_project_service_route("GET", routes::STATUSLINE_SEGMENT),
        ProjectServiceRouteResolution::MethodNotAllowed {
            path: routes::STATUSLINE_SEGMENT.into(),
            allowed: vec![Method::Post, Method::Delete],
        }
    );
    assert_eq!(
        resolve_project_service_route("POST", "/plans/codex-1"),
        ProjectServiceRouteResolution::MethodNotAllowed {
            path: "/plans/codex-1".into(),
            allowed: vec![Method::Get, Method::Put],
        }
    );
}

#[test]
fn unimplemented_dispatch_shape_is_stable_for_future_handlers() {
    let response = route_unimplemented_project_service_request("GET", routes::EVENTS);
    assert_eq!(response.status, 501);
    assert_eq!(
        response.body,
        json!({
            "ok": false,
            "error": "project service route not ported",
            "method": "GET",
            "path": "/events",
            "group": "events",
        })
    );

    let missing = route_unimplemented_project_service_request("GET", "/nope?x=1");
    assert_eq!(missing.status, 404);
    assert_eq!(
        missing.body,
        json!({ "ok": false, "error": "not found", "path": "/nope" })
    );
}

#[test]
fn pathname_matches_node_url_pathname_for_query_stripping() {
    assert_eq!(project_service_pathname("/state?x=1"), "/state");
    assert_eq!(project_service_pathname("/state"), "/state");
}
