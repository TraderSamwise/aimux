use crate::daemon::routing::DaemonRouteUrl;
use crate::project_api_contract::routes as project_routes;
use crate::proxy_project_binding::parse_proxy_target;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteActorRole {
    Owner,
    Guest,
    Operator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOperatorGrant {
    pub project_root: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOperatorPrincipal {
    pub id: String,
    pub label: String,
    pub role: String,
    pub grants: Vec<RemoteOperatorGrant>,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteActor {
    pub role: RemoteActorRole,
    pub user_id: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub share_id: Option<String>,
    pub share_session_id: Option<String>,
    pub principal: Option<RemoteOperatorPrincipal>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RemoteAccessContext<'a> {
    pub body: Option<&'a Value>,
    pub project_root: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteAccessDecision {
    pub ok: bool,
    pub status: Option<u16>,
    pub error: Option<String>,
}

impl RemoteAccessDecision {
    pub fn allow() -> Self {
        Self {
            ok: true,
            status: None,
            error: None,
        }
    }

    pub fn deny(status: u16, error: impl Into<String>) -> Self {
        Self {
            ok: false,
            status: Some(status),
            error: Some(error.into()),
        }
    }
}

pub fn parse_remote_actor(headers: &BTreeMap<String, String>) -> Option<RemoteActor> {
    let actor_json = header_value(headers, "x-aimux-actor");
    let json_actor = actor_json.and_then(actor_from_json);
    let role_text = header_value(headers, "x-aimux-actor-role")
        .or_else(|| json_actor.as_ref().and_then(|actor| actor.role.as_deref()));
    let Some(role_text) = role_text else {
        return has_relay_actor_headers(headers).then_some(RemoteActor {
            role: RemoteActorRole::Guest,
            user_id: None,
            display_name: None,
            email: None,
            share_id: None,
            share_session_id: None,
            principal: None,
        });
    };
    let role = match role_text {
        "owner" => RemoteActorRole::Owner,
        "guest" => RemoteActorRole::Guest,
        _ => RemoteActorRole::Guest,
    };
    Some(RemoteActor {
        role,
        user_id: header_value(headers, "x-aimux-actor-user-id")
            .map(str::to_owned)
            .or_else(|| json_actor.as_ref().and_then(|actor| actor.user_id.clone())),
        display_name: header_value(headers, "x-aimux-actor-display-name")
            .map(str::to_owned)
            .or_else(|| {
                json_actor
                    .as_ref()
                    .and_then(|actor| actor.display_name.clone())
            }),
        email: header_value(headers, "x-aimux-actor-email")
            .map(str::to_owned)
            .or_else(|| json_actor.as_ref().and_then(|actor| actor.email.clone())),
        share_id: header_value(headers, "x-aimux-share-id").map(str::to_owned),
        share_session_id: header_value(headers, "x-aimux-share-session-id").map(str::to_owned),
        principal: None,
    })
}

pub fn assert_remote_access_allowed(
    actor: Option<&RemoteActor>,
    method: &str,
    pathname: &str,
    route_url: &DaemonRouteUrl,
    context: RemoteAccessContext<'_>,
) -> RemoteAccessDecision {
    let Some(actor) = actor else {
        return RemoteAccessDecision::allow();
    };
    match actor.role {
        RemoteActorRole::Owner => RemoteAccessDecision::allow(),
        RemoteActorRole::Operator => {
            assert_operator_allowed(actor, method, pathname, route_url, context)
        }
        RemoteActorRole::Guest => assert_guest_allowed(actor, method, pathname, route_url, context),
    }
}

pub fn assert_operator_stream_allowed(
    actor: Option<&RemoteActor>,
    method: &str,
    pathname: &str,
    route_url: &DaemonRouteUrl,
    context: RemoteAccessContext<'_>,
) -> RemoteAccessDecision {
    let Some(actor) = actor else {
        return RemoteAccessDecision::deny(403, "streaming requires an operator");
    };
    if actor.role != RemoteActorRole::Operator {
        return RemoteAccessDecision::deny(403, "streaming requires an operator");
    }
    if !method.eq_ignore_ascii_case("GET") {
        return RemoteAccessDecision::deny(403, "streams are GET only");
    }

    let (principal, sub_path) = match operator_sub_path(actor, pathname) {
        Ok(value) => value,
        Err(decision) => return decision,
    };
    if sub_path != project_routes::agents::OUTPUT_STREAM {
        return RemoteAccessDecision::deny(403, "route is not available to operators");
    }
    assert_granted_session(principal, "GET", route_url, context)
}

fn assert_operator_allowed(
    actor: &RemoteActor,
    method: &str,
    pathname: &str,
    route_url: &DaemonRouteUrl,
    context: RemoteAccessContext<'_>,
) -> RemoteAccessDecision {
    let (principal, sub_path) = match operator_sub_path(actor, pathname) {
        Ok(value) => value,
        Err(decision) => return decision,
    };
    let allowed_method = operator_allowed_method(&sub_path);
    let Some(allowed_method) = allowed_method else {
        return RemoteAccessDecision::deny(403, "route is not available to operators");
    };
    if !method.eq_ignore_ascii_case(allowed_method) {
        return RemoteAccessDecision::deny(403, "method not allowed for this route");
    }
    assert_granted_session(principal, allowed_method, route_url, context)
}

fn assert_guest_allowed(
    actor: &RemoteActor,
    method: &str,
    pathname: &str,
    route_url: &DaemonRouteUrl,
    context: RemoteAccessContext<'_>,
) -> RemoteAccessDecision {
    let method_name = method.to_ascii_uppercase();
    if method_name == "GET" && pathname == "/health" {
        return RemoteAccessDecision::allow();
    }
    let Some(proxy) = parse_proxy_target(pathname) else {
        return RemoteAccessDecision::deny(403, "shared guests cannot access daemon routes");
    };
    let sub_path = proxy.sub_path;
    if method_name == "GET"
        && (shared_guest_read_route(&sub_path) || attachment_content_route(&sub_path))
    {
        return assert_shared_guest_session(actor, "GET", route_url, context);
    }
    if method_name == "POST" && shared_guest_write_route(&sub_path) {
        let session = assert_shared_guest_session(actor, "POST", route_url, context);
        if !session.ok {
            return session;
        }
        if sub_path == project_routes::live_pane::INPUT
            && !body_text(context.body)
            && !body_has_attachments(context.body)
        {
            return RemoteAccessDecision::deny(
                403,
                "shared guest input requires text or attachments",
            );
        }
        return RemoteAccessDecision::allow();
    }
    if method_name != "GET" {
        return RemoteAccessDecision::deny(
            403,
            "shared guests can only write to their shared session",
        );
    }
    RemoteAccessDecision::deny(
        403,
        "shared guests can only read shared session output and attachments",
    )
}

fn operator_sub_path<'a>(
    actor: &'a RemoteActor,
    pathname: &str,
) -> Result<(&'a RemoteOperatorPrincipal, String), RemoteAccessDecision> {
    let Some(principal) = actor.principal.as_ref() else {
        return Err(RemoteAccessDecision::deny(
            403,
            "operator actor is missing its principal",
        ));
    };
    let Some(proxy) = parse_proxy_target(pathname) else {
        return Err(RemoteAccessDecision::deny(
            403,
            "operators cannot access daemon routes",
        ));
    };
    Ok((principal, proxy.sub_path))
}

fn assert_granted_session(
    principal: &RemoteOperatorPrincipal,
    method: &str,
    route_url: &DaemonRouteUrl,
    context: RemoteAccessContext<'_>,
) -> RemoteAccessDecision {
    let Some(project_root) = context.project_root.filter(|value| !value.is_empty()) else {
        return RemoteAccessDecision::deny(403, "operator request could not be bound to a project");
    };
    let session = match authorized_session_id(method, route_url, context.body, "operator route") {
        Ok(session) => session,
        Err(error) => return RemoteAccessDecision::deny(403, error),
    };
    if !principal_has_grant(
        principal,
        &RemoteOperatorGrant {
            project_root: project_root.to_owned(),
            session_id: session,
        },
    ) {
        return RemoteAccessDecision::deny(403, "operator is not granted this session");
    }
    RemoteAccessDecision::allow()
}

fn assert_shared_guest_session(
    actor: &RemoteActor,
    method: &str,
    route_url: &DaemonRouteUrl,
    context: RemoteAccessContext<'_>,
) -> RemoteAccessDecision {
    let Some(share_session_id) = actor
        .share_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return RemoteAccessDecision::deny(
            403,
            "shared guest route requires an authorized share session",
        );
    };
    let session =
        match authorized_session_id(method, route_url, context.body, "shared session route") {
            Ok(session) => session,
            Err(error) => return RemoteAccessDecision::deny(403, error),
        };
    if session != share_session_id {
        return RemoteAccessDecision::deny(403, "shared guest cannot access another session");
    }
    RemoteAccessDecision::allow()
}

fn authorized_session_id(
    method: &str,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    label: &str,
) -> Result<String, String> {
    let from_body = body_session_id(body);
    let from_query = route_url
        .search_param("sessionId")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let method = method.to_ascii_uppercase();
    let authoritative = if method == "POST" {
        &from_body
    } else {
        &from_query
    };
    let other = if method == "POST" {
        &from_query
    } else {
        &from_body
    };
    let Some(authoritative) = authoritative.as_ref() else {
        return Err(format!("{label} requires a session id"));
    };
    if let Some(other) = other
        && other != authoritative
    {
        return Err("conflicting session ids in request body and query".into());
    }
    Ok(authoritative.clone())
}

fn principal_has_grant(principal: &RemoteOperatorPrincipal, grant: &RemoteOperatorGrant) -> bool {
    if principal.revoked_at.is_some() {
        return false;
    }
    let Some(project_root) = normalize_absolute_path(&grant.project_root) else {
        return false;
    };
    let session_id = grant.session_id.trim();
    if session_id.is_empty() {
        return false;
    }
    principal.grants.iter().any(|entry| {
        entry.project_root == project_root.to_string_lossy() && entry.session_id == session_id
    })
}

fn operator_allowed_method(sub_path: &str) -> Option<&'static str> {
    match sub_path {
        project_routes::agents::OUTPUT => Some("GET"),
        project_routes::agents::INPUT => Some("POST"),
        project_routes::agents::PROMPT_CONTEXT => Some("POST"),
        project_routes::agents::INTERRUPT => Some("POST"),
        project_routes::ATTACHMENTS => Some("POST"),
        path if attachment_content_route(path) => Some("GET"),
        _ => None,
    }
}

fn shared_guest_read_route(sub_path: &str) -> bool {
    matches!(
        sub_path,
        project_routes::agents::OUTPUT
            | project_routes::agents::HISTORY
            | project_routes::live_pane::OUTPUT
            | project_routes::EVENTS
    )
}

fn shared_guest_write_route(sub_path: &str) -> bool {
    matches!(
        sub_path,
        project_routes::live_pane::INPUT | project_routes::ATTACHMENTS
    )
}

fn attachment_content_route(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/attachments/") else {
        return false;
    };
    let Some(id) = rest.strip_suffix("/content") else {
        return false;
    };
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn body_session_id(body: Option<&Value>) -> Option<String> {
    body?
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn body_text(body: Option<&Value>) -> bool {
    body.and_then(|body| body.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn body_has_attachments(body: Option<&Value>) -> bool {
    body.and_then(|body| body.get("attachmentIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| {
            ids.iter().any(|id| match id {
                Value::String(value) => !value.trim().is_empty(),
                Value::Null => false,
                _ => true,
            })
        })
}

fn header_value<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, value)| key.eq_ignore_ascii_case(name) && !value.trim().is_empty())
        .map(|(_, value)| value.trim())
}

fn has_relay_actor_headers(headers: &BTreeMap<String, String>) -> bool {
    headers
        .keys()
        .any(|key| key.to_ascii_lowercase().starts_with("x-aimux-"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeaderJsonActor {
    role: Option<String>,
    user_id: Option<String>,
    display_name: Option<String>,
    email: Option<String>,
}

fn actor_from_json(value: &str) -> Option<HeaderJsonActor> {
    let mut actor: HeaderJsonActor = serde_json::from_str(value).ok()?;
    if !matches!(actor.role.as_deref(), Some("owner" | "guest")) {
        actor.role = None;
    }
    Some(actor)
}

fn normalize_absolute_path(path: &str) -> Option<PathBuf> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return None;
    }
    Some(path_clean(path))
}

fn path_clean(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                output.push(component)
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                output.pop();
            }
            std::path::Component::Normal(part) => output.push(part),
        }
    }
    output
}
