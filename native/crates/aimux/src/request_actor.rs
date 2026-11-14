use crate::daemon::routing::DaemonRouteUrl;
use crate::machine_identity::RESERVED_UNIDENTIFIED_MACHINE_ID;
use crate::project_api_contract::routes as project_routes;
use crate::proxy_project_binding::parse_proxy_target;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const RELAY_FORWARDED_HEADER: &str = "x-aimux-relay-forwarded";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteActorRole {
    Owner,
    Guest,
    Operator,
    /// Another of this account's own machines, asking through the relay.
    ///
    /// Deliberately not Owner. The owner's own app is stamped `owner` and the
    /// daemon loops those straight back into its whole API, so a peer given
    /// that stamp would be every machine holding every other machine's
    /// keyboard. A peer gets its own allowlist, as narrow as the work it is
    /// for.
    Peer,
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
    /// The role the caller actually declared, verbatim. `None` means none was
    /// sent, and a value the match below does not recognize is kept as-is: both
    /// become Guest, and a refusal has to be able to say which happened rather
    /// than reporting a downgrade as a shared guest.
    pub declared_role: Option<String>,
    pub user_id: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub share_id: Option<String>,
    pub share_session_id: Option<String>,
    /// Which machine a peer request came from, stamped by the relay from the
    /// socket it arrived on. Never read from the frame: the point of it is
    /// that the caller cannot choose it.
    pub peer_machine_id: Option<String>,
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
            declared_role: None,
            user_id: None,
            display_name: None,
            email: None,
            share_id: None,
            share_session_id: None,
            peer_machine_id: None,
            principal: None,
        });
    };
    let role = match role_text {
        "owner" => RemoteActorRole::Owner,
        "guest" => RemoteActorRole::Guest,
        "peer" => RemoteActorRole::Peer,
        _ => RemoteActorRole::Guest,
    };
    Some(RemoteActor {
        role,
        declared_role: Some(role_text.to_owned()),
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
        peer_machine_id: header_value(headers, "x-aimux-peer-machine-id").map(str::to_owned),
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
        RemoteActorRole::Peer => assert_peer_allowed(actor, pathname),
    }
}

/// What another of this account's machines may ask this one to do.
///
/// Nothing, today. The transport exists and the role exists; no route is open
/// to it yet, and that is deliberate rather than unfinished.
///
/// The first draft of this opened `/tasks/assign` and `/tasks/accept`, which
/// read as the narrowest thing that could carry a handoff. It is not narrow.
/// A task's `description` is interpolated verbatim into the reconciliation
/// briefing the loop types into an overseer's pane, so posting a task is
/// writing into the agent that spawns other agents -- one hop later and with
/// nobody's name on it. `from` comes from the body too, so a peer could sign
/// the work as the person.
///
/// None of that says the route cannot exist. It says it has to arrive with
/// the caller that needs it, carrying the stamped origin machine as the
/// assigner rather than trusting the body -- which is phase 9's work. Until
/// then an allowlist that grants what nobody asked for is exactly the
/// widening this phase was warned about, so it grants nothing, and the
/// refusal names the route that was tried.
fn assert_peer_allowed(actor: &RemoteActor, pathname: &str) -> RemoteAccessDecision {
    let Some(origin) = actor
        .peer_machine_id
        .as_deref()
        .map(str::trim)
        .filter(|machine| !machine.is_empty() && *machine != RESERVED_UNIDENTIFIED_MACHINE_ID)
    else {
        // The relay stamps this beside the role, from the socket the frame
        // arrived on. A peer role without one did not come from where it
        // claims -- and `unidentified` is the name every daemon with no
        // persisted identity shares, which makes it a label, not an identity.
        return RemoteAccessDecision::deny(
            403,
            "peer request did not say which machine it came from",
        );
    };
    let route = parse_proxy_target(pathname)
        .map(|proxy| proxy.sub_path)
        .unwrap_or_else(|| pathname.to_owned());
    RemoteAccessDecision::deny(
        403,
        format!("no route is open to peer machine {origin} yet: {route}"),
    )
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
        // An actor with no share context is not a shared guest -- it is a caller
        // the relay never identified, and saying "shared guest" sent a whole
        // debugging session after the sharing code.
        return match actor.declared_role.as_deref() {
            None => RemoteAccessDecision::deny(
                403,
                "relay request carried no actor role, so the caller could not be identified",
            ),
            Some("guest") => {
                RemoteAccessDecision::deny(403, "shared guests cannot access daemon routes")
            }
            Some(role) => RemoteAccessDecision::deny(
                403,
                format!("relay request declared an unrecognized actor role: {role}"),
            ),
        };
    };
    let sub_path = proxy.sub_path;
    if method_name == "GET"
        && (shared_guest_read_route(&sub_path) || attachment_content_route(&sub_path))
    {
        return assert_shared_guest_session(actor, "GET", route_url, context);
    }
    if method_name == "GET"
        && let Some(plan_session) = plan_route_session(&sub_path)
    {
        return assert_shared_guest_named_session(actor, plan_session);
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

/// The same check for a route that names its session in the path rather than
/// in the query or the body.
fn assert_shared_guest_named_session(actor: &RemoteActor, session: &str) -> RemoteAccessDecision {
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
    if session.trim() != share_session_id {
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

/// Sharing is full trust over the session that was shared.
///
/// A guest is an owner of that one session: they read it, write to it, stop
/// it, resume it and kill it. What they are not is an administrator of the
/// share itself -- inviting and revoking stay with the owner, and neither has
/// a route here. Every route below is still checked against the guest's own
/// share session afterwards, so widening this list widens what a guest may do
/// to THEIR session and nothing else.
fn shared_guest_read_route(sub_path: &str) -> bool {
    matches!(
        sub_path,
        project_routes::agents::OUTPUT
            // Without the stream the transcript arrives only as fast as the
            // guest re-asks, and the composer's ten-second confirmation
            // deadline is written against a stream that pushes.
            | project_routes::agents::OUTPUT_STREAM
            | project_routes::agents::HISTORY
            | project_routes::live_pane::OUTPUT
            | project_routes::EVENTS
    )
}

fn shared_guest_write_route(sub_path: &str) -> bool {
    matches!(
        sub_path,
        project_routes::live_pane::INPUT
            // Answering the agent's own question. Withholding this leaves a
            // guest watching a chooser it is trusted to type `2` into but not
            // trusted to press, which is not a narrower share -- it is the
            // same authority through a worse route.
            | project_routes::live_pane::SELECT
            | project_routes::ATTACHMENTS
            // Both spellings of interrupt: the GUI sends the live-pane one and
            // the gate is about the capability, not about which client asked.
            | project_routes::live_pane::INTERRUPT
            | project_routes::agents::INTERRUPT
            | project_routes::agents::STOP
            | project_routes::agents::RESUME
            | project_routes::agents::KILL
            | project_routes::agents::FORK
    )
}

/// `/plans/<sessionId>` carries its session in the path, where the query and
/// body check that scopes every other guest route cannot see it. Returned so
/// the caller compares it to the share rather than trusting the match.
fn plan_route_session(sub_path: &str) -> Option<&str> {
    let rest = sub_path
        .strip_prefix(project_routes::PLANS)?
        .strip_prefix('/')?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest)
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
    // The same trim the route that refuses this applies. Its deny set was a
    // strict subset, so nothing diverged yet -- but two gates answering "is
    // there any text here" with two definitions is how the last four of
    // these started.
    body.and_then(|body| body.get("text"))
        .and_then(Value::as_str)
        .map(crate::project_service::agent_input::shared_chat_trim)
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
        || header_value(headers, RELAY_FORWARDED_HEADER).is_some()
}

#[derive(Debug, Deserialize)]
struct HeaderJsonActor {
    role: Option<String>,
    user_id: Option<String>,
    display_name: Option<String>,
    email: Option<String>,
}

fn actor_from_json(value: &str) -> Option<HeaderJsonActor> {
    let parsed: Value = serde_json::from_str(value).ok()?;
    let record = parsed.as_object()?;
    let role = string_field(record, "role").filter(|role| matches!(*role, "owner" | "guest"));
    Some(HeaderJsonActor {
        role: role.map(str::to_owned),
        user_id: string_field(record, "userId").map(str::to_owned),
        display_name: string_field(record, "displayName").map(str::to_owned),
        email: string_field(record, "email").map(str::to_owned),
    })
}

fn string_field<'a>(record: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    record.get(key).and_then(Value::as_str)
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
