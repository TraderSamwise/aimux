use crate::daemon::json::{
    ProjectEventStreamTarget, resolve_project_event_stream as resolve_project_event_stream_target,
};
use crate::daemon::router::DaemonRouteRequestContext;
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl};
use crate::daemon_projects::ProjectsRouteProject;
use crate::proxy_project_binding::{parse_proxy_target, resolve_project_root_for_service_target};
use crate::remote_access::{
    RemoteAccessContext, RemoteAccessDecision, RemoteActor, RemoteActorRole,
    assert_operator_stream_allowed, assert_remote_access_allowed, parse_remote_actor,
};
use serde_json::Value;
use std::collections::BTreeMap;

pub fn build_daemon_route_context(
    method: &str,
    path: &str,
    body: Option<&Value>,
    headers: BTreeMap<String, String>,
    projects: &[ProjectsRouteProject],
) -> DaemonRouteRequestContext {
    let actor = parse_remote_actor(&headers);
    build_daemon_route_context_for_actor(method, path, body, headers, actor.as_ref(), projects)
}

pub fn build_hosted_daemon_route_context(
    method: &str,
    path: &str,
    body: Option<&Value>,
    actor: &RemoteActor,
    projects: &[ProjectsRouteProject],
) -> DaemonRouteRequestContext {
    build_daemon_route_context_for_actor(method, path, body, BTreeMap::new(), Some(actor), projects)
}

pub fn build_daemon_route_context_for_actor(
    method: &str,
    path: &str,
    body: Option<&Value>,
    headers: BTreeMap<String, String>,
    actor: Option<&RemoteActor>,
    projects: &[ProjectsRouteProject],
) -> DaemonRouteRequestContext {
    let route_url = DaemonRouteUrl::parse(path);
    let project_root = actor
        .filter(|actor| actor.role == RemoteActorRole::Operator)
        .and_then(|_| {
            resolve_project_root_for_service_target(
                projects,
                parse_proxy_target(route_url.pathname()).as_ref(),
            )
        });
    let access_decision = assert_remote_access_allowed(
        actor,
        method,
        route_url.pathname(),
        &route_url,
        RemoteAccessContext {
            body,
            project_root: project_root.as_deref(),
        },
    );

    DaemonRouteRequestContext {
        actor_present: actor.is_some(),
        headers,
        access_decision: Some(access_decision),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedOperatorStreamTarget {
    pub url: String,
    pub project_root: String,
}

pub fn resolve_hosted_operator_stream(
    actor: &RemoteActor,
    method: &str,
    path: &str,
    projects: &[ProjectsRouteProject],
) -> Result<HostedOperatorStreamTarget, RemoteAccessDecision> {
    let route_url = DaemonRouteUrl::parse(path);
    let target = parse_proxy_target(route_url.pathname());
    let project_root = resolve_project_root_for_service_target(projects, target.as_ref());
    let access_decision = assert_operator_stream_allowed(
        Some(actor),
        method,
        route_url.pathname(),
        &route_url,
        RemoteAccessContext {
            body: None,
            project_root: project_root.as_deref(),
        },
    );
    if !access_decision.ok {
        return Err(access_decision);
    }
    let Some(target) = target else {
        return Err(RemoteAccessDecision::deny(404, "not found"));
    };
    Ok(HostedOperatorStreamTarget {
        url: format!(
            "http://{}:{}{}{}",
            target.host,
            target.port,
            target.sub_path,
            route_url.search()
        ),
        project_root: project_root.expect("access gate requires project binding"),
    })
}

pub fn resolve_authorized_project_event_stream(
    path: &str,
    headers: &BTreeMap<String, String>,
) -> Result<ProjectEventStreamTarget, DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let actor = parse_remote_actor(headers);
    let access_decision = assert_remote_access_allowed(
        actor.as_ref(),
        "GET",
        route_url.pathname(),
        &route_url,
        RemoteAccessContext {
            body: None,
            project_root: None,
        },
    );
    if !access_decision.ok {
        return Err(DaemonRouteResponse::json(
            access_decision.status.unwrap_or(403),
            serde_json::json!({
                "ok": false,
                "error": access_decision.error.as_deref().unwrap_or("remote access denied")
            }),
        ));
    }
    resolve_project_event_stream_target(path, headers)
}
