use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest,
    execute_loopback_binary_request, execute_loopback_json_request,
};
use crate::daemon::core_commands::DaemonCoreCommandRuntime;
use crate::daemon::http::DaemonResponseBody;
use crate::daemon::jobs::{DaemonJobRouteRuntime, route_jobs_json_request};
use crate::daemon::remote_control::route_remote_json_request;
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl};
use crate::daemon::status::DaemonStatusRuntime;
use crate::machine_identity::is_valid_machine_id;
use crate::project_api_contract::routes as project_routes;
use crate::project_service::lifecycle_mutation_queue::queued_lifecycle_timeout_ms;
use crate::proxy_project_binding::{
    PEER_AGENT_INPUT_ROUTE, is_binary_project_route, parse_proxy_target,
    resolve_service_target_for_project_root,
};
use crate::request_actor::{RemoteActorRole, parse_remote_actor};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const PROXY_TIMEOUT_MS: u64 = 10_000;

/// The proxy hop is the whole budget a relay-mode client gets, whatever it
/// asked for: the daemon abandons the request and answers 504 regardless. So a
/// queued lifecycle mutation needs its own budget here too, or a phone could
/// never wait out a spawn no matter what the app allowed.
fn proxy_timeout_ms(sub_path: &str) -> u64 {
    queued_lifecycle_timeout_ms(sub_path).unwrap_or(PROXY_TIMEOUT_MS)
}
pub const PROXY_MAX_BINARY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExposeFocusRequest {
    pub window_id: String,
    pub project_root: Option<String>,
    pub current_client_session: Option<String>,
    pub client_tty: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProxyJsonResponse {
    pub status: u16,
    pub json: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyBinaryResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectEventStreamTarget {
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

pub trait DaemonJsonRouteRuntime: DaemonCoreCommandRuntime {
    fn push_notification(&mut self, payload: &Value) -> Value;
    fn loop_diagnostics(&self) -> Value;
    fn expose_items(&mut self, path: &str) -> Result<Value, String>;
    fn expose_focus(&mut self, request: ExposeFocusRequest) -> Result<Value, String>;
    fn proxy_json_request(
        &mut self,
        target_url: &str,
        method: &str,
        headers: &BTreeMap<String, String>,
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> Result<ProxyJsonResponse, String>;
    fn proxy_binary_request(
        &mut self,
        target_url: &str,
        method: &str,
        headers: &BTreeMap<String, String>,
        timeout_ms: u64,
        max_bytes: usize,
    ) -> Result<ProxyBinaryResponse, String>;
}

pub fn route_json_daemon_request(
    runtime: &mut (impl DaemonJsonRouteRuntime + DaemonJobRouteRuntime),
    method: &str,
    path: &str,
    body: Option<&Value>,
    headers: &BTreeMap<String, String>,
    actor_present: bool,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if let Some(response) = route_remote_json_request(runtime, method, pathname) {
        return Some(response);
    }

    if let Some(response) = route_jobs_json_request(runtime, method, path, body, actor_present) {
        return Some(response);
    }

    if method == "POST" && pathname == "/internal/push" {
        if actor_present {
            return Some(DaemonRouteResponse::json(
                403,
                json!({ "ok": false, "error": "internal route is loopback-only" }),
            ));
        }
        let payload = body.cloned().unwrap_or(Value::Null);
        if !js_truthy(payload.get("title")) {
            return Some(DaemonRouteResponse::json(
                400,
                json!({ "ok": false, "error": "title is required" }),
            ));
        }
        if let Some(reason) =
            crate::notification_delivery_guard::external_notification_refusal_reason_for_payload(
                &payload,
            )
        {
            return Some(DaemonRouteResponse::json(
                200,
                json!({ "ok": true, "suppressed": true, "reason": reason }),
            ));
        }
        return Some(DaemonRouteResponse::json(
            200,
            runtime.push_notification(&payload),
        ));
    }

    if method == "GET" && pathname == "/diagnostics/loop" {
        if actor_present {
            return Some(DaemonRouteResponse::json(
                403,
                json!({ "ok": false, "error": "diagnostics routes are loopback-only" }),
            ));
        }
        return Some(DaemonRouteResponse::json(200, runtime.loop_diagnostics()));
    }

    if method == "GET" && pathname == CORE_API_ROUTES.expose_items {
        if actor_present {
            return Some(DaemonRouteResponse::json(
                403,
                json!({ "ok": false, "error": "expose routes are loopback-only" }),
            ));
        }
        return Some(match runtime.expose_items(path) {
            Ok(payload) => DaemonRouteResponse::json(200, payload),
            Err(error) => DaemonRouteResponse::json(500, json!({ "ok": false, "error": error })),
        });
    }

    if method == "POST" && pathname == CORE_API_ROUTES.expose_focus {
        if actor_present {
            return Some(DaemonRouteResponse::json(
                403,
                json!({ "ok": false, "error": "expose routes are loopback-only" }),
            ));
        }
        let request = match expose_focus_request(body) {
            Ok(request) => request,
            Err(response) => return Some(response),
        };
        return Some(match runtime.expose_focus(request) {
            Ok(payload) => DaemonRouteResponse::json(200, payload),
            Err(error) => DaemonRouteResponse::json(500, json!({ "ok": false, "error": error })),
        });
    }

    if method == "POST" && pathname == "/projects/ensure" {
        let Some(project_root) = body
            .and_then(|body| body.get("projectRoot"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return Some(DaemonRouteResponse::json(
                400,
                json!({ "ok": false, "error": "projectRoot is required" }),
            ));
        };
        return Some(match runtime.ensure_project(project_root) {
            Ok(project) => {
                DaemonRouteResponse::json(200, json!({ "ok": true, "project": project }))
            }
            Err(error) => DaemonRouteResponse::json(500, json!({ "ok": false, "error": error })),
        });
    }

    if method == "POST" && pathname == "/projects/stop" {
        let Some(project_root) = body
            .and_then(|body| body.get("projectRoot"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return Some(DaemonRouteResponse::json(
                400,
                json!({ "ok": false, "error": "projectRoot is required" }),
            ));
        };
        return Some(match runtime.stop_project(project_root, false) {
            Ok(project) => {
                DaemonRouteResponse::json(200, json!({ "ok": true, "project": project }))
            }
            Err(error) => DaemonRouteResponse::json(500, json!({ "ok": false, "error": error })),
        });
    }

    if method == "POST" && pathname == PEER_AGENT_INPUT_ROUTE {
        return Some(route_peer_agent_input(runtime, body, headers));
    }

    let proxy = parse_proxy_target(pathname)?;
    if !proxy_host_allowed(&proxy.host) {
        return Some(DaemonRouteResponse::json(
            403,
            json!({ "ok": false, "error": "proxy host not allowed" }),
        ));
    }
    let target_url = format!(
        "http://{}:{}{}{}",
        proxy.host,
        proxy.port,
        proxy.sub_path,
        route_url.search()
    );
    if method == "GET" && is_binary_project_route(&proxy.sub_path) {
        return Some(route_binary_proxy(runtime, &target_url, method, headers));
    }
    Some(
        match runtime.proxy_json_request(
            &target_url,
            method,
            headers,
            body,
            proxy_timeout_ms(&proxy.sub_path),
        ) {
            Ok(response) => DaemonRouteResponse::json(response.status, response.json),
            Err(error) => proxy_error_response(error),
        },
    )
}

/// A peer machine's input, named by project and delivered by this machine.
///
/// The access decision has already established that the caller is a stamped
/// peer and that `project` names a project this daemon is serving; this builds
/// the hop to its own project service.
///
/// THE HEADERS ARE BUILT FRESH, never forwarded. The incoming map is not safe
/// to pass on: the relay strips a client's `x-aimux-*` before stamping its
/// own, but nothing strips them from a request that arrived on loopback, so
/// forwarding the map wholesale would let a local caller hand the project
/// service any stamp it liked. Only two values cross, and both come from
/// `parse_remote_actor` rather than from the map or the body -- so a request
/// with no actor forwards no stamp at all, and reaches the project service as
/// the local caller it is.
///
/// The BODY is rebuilt for the same reason. `attachmentIds`, `force` and
/// `sharedChatActor` are refused by the allowlist, and rebuilding means a
/// field nobody has thought about yet cannot ride along behind them.
fn route_peer_agent_input(
    runtime: &mut (impl DaemonJsonRouteRuntime + DaemonStatusRuntime),
    body: Option<&Value>,
    headers: &BTreeMap<String, String>,
) -> DaemonRouteResponse {
    let body = body.unwrap_or(&Value::Null);
    let Some(project) = body
        .get("project")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|project| !project.is_empty())
    else {
        return DaemonRouteResponse::json(
            400,
            json!({ "ok": false, "error": "project is required" }),
        );
    };
    let Some(session_id) = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|session_id| !session_id.is_empty())
    else {
        return DaemonRouteResponse::json(
            400,
            json!({ "ok": false, "error": "sessionId is required" }),
        );
    };
    // Asked again here rather than carried from the access decision, because
    // that decision holds the project ROOT and this needs the address -- and a
    // listing that fails is not a listing that is empty.
    let projects = match runtime.try_list_projects_for_route() {
        Ok(projects) => projects,
        Err(error) => {
            return DaemonRouteResponse::json(
                500,
                json!({ "ok": false, "error": format!("could not list this machine's projects: {error}") }),
            );
        }
    };
    let Some(target) = resolve_service_target_for_project_root(&projects, project) else {
        return DaemonRouteResponse::json(
            503,
            json!({
                "ok": false,
                "error": format!("this machine is not serving a project at {project}")
            }),
        );
    };
    if !proxy_host_allowed(&target.host) {
        return DaemonRouteResponse::json(
            403,
            json!({ "ok": false, "error": "proxy host not allowed" }),
        );
    }
    let mut forwarded = BTreeMap::from([
        ("accept".to_owned(), "application/json".to_owned()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    if let Some(actor) =
        parse_remote_actor(headers).filter(|actor| actor.role == RemoteActorRole::Peer)
        && let Some(machine) = actor
            .peer_machine_id
            .as_deref()
            .map(str::trim)
            .filter(|machine| is_valid_machine_id(machine))
    {
        forwarded.insert("x-aimux-actor-role".to_owned(), "peer".to_owned());
        forwarded.insert("x-aimux-peer-machine-id".to_owned(), machine.to_owned());
    }
    let mut onward = json!({ "sessionId": session_id, "text": body.get("text").and_then(Value::as_str).unwrap_or_default() });
    for field in ["from", "task"] {
        if let Some(value) = body
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            onward[field] = Value::String(value.to_owned());
        }
    }
    let target_url = format!(
        "http://{}:{}{}",
        target.host,
        target.port,
        project_routes::agents::INPUT
    );
    match runtime.proxy_json_request(
        &target_url,
        "POST",
        &forwarded,
        Some(&onward),
        proxy_timeout_ms(project_routes::agents::INPUT),
    ) {
        Ok(response) => DaemonRouteResponse::json(response.status, response.json),
        Err(error) => proxy_error_response(error),
    }
}

pub fn route_stateless_proxy_daemon_request(
    method: &str,
    path: &str,
    body: Option<&Value>,
    headers: &BTreeMap<String, String>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();
    let proxy = parse_proxy_target(pathname)?;
    if !proxy_host_allowed(&proxy.host) {
        return Some(DaemonRouteResponse::json(
            403,
            json!({ "ok": false, "error": "proxy host not allowed" }),
        ));
    }
    let target_url = format!(
        "http://{}:{}{}{}",
        proxy.host,
        proxy.port,
        proxy.sub_path,
        route_url.search()
    );
    if method == "GET" && is_binary_project_route(&proxy.sub_path) {
        return Some(route_binary_proxy_response(execute_proxy_binary_request(
            &target_url,
            method,
            headers,
            PROXY_TIMEOUT_MS,
            PROXY_MAX_BINARY_BYTES,
        )));
    }
    Some(
        match execute_proxy_json_request(
            &target_url,
            method,
            headers,
            body,
            proxy_timeout_ms(&proxy.sub_path),
        ) {
            Ok(response) => DaemonRouteResponse::json(response.status, response.json),
            Err(error) => proxy_error_response(error),
        },
    )
}

pub fn resolve_project_event_stream(
    path: &str,
    headers: &BTreeMap<String, String>,
) -> Result<ProjectEventStreamTarget, DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let Some(proxy) = parse_proxy_target(route_url.pathname()) else {
        return Err(DaemonRouteResponse::json(
            404,
            json!({ "ok": false, "error": "project event stream not found" }),
        ));
    };
    if !proxy_host_allowed(&proxy.host) {
        return Err(DaemonRouteResponse::json(
            403,
            json!({ "ok": false, "error": "proxy host not allowed" }),
        ));
    }
    if !is_project_stream_sub_path(&proxy.sub_path) {
        return Err(DaemonRouteResponse::json(
            403,
            json!({ "ok": false, "error": "route is not a project event stream" }),
        ));
    }
    Ok(ProjectEventStreamTarget {
        url: format!(
            "http://{}:{}{}{}",
            proxy.host,
            proxy.port,
            proxy.sub_path,
            route_url.search()
        ),
        headers: headers.clone(),
    })
}

pub fn is_project_stream_sub_path(sub_path: &str) -> bool {
    matches!(
        sub_path,
        project_routes::EVENTS
            | project_routes::agents::OUTPUT_STREAM
            | project_routes::agents::INTERACTION_STREAM
    )
}

fn route_binary_proxy(
    runtime: &mut impl DaemonJsonRouteRuntime,
    target_url: &str,
    method: &str,
    headers: &BTreeMap<String, String>,
) -> DaemonRouteResponse {
    route_binary_proxy_response(runtime.proxy_binary_request(
        target_url,
        method,
        headers,
        PROXY_TIMEOUT_MS,
        PROXY_MAX_BINARY_BYTES,
    ))
}

fn route_binary_proxy_response(
    response: Result<ProxyBinaryResponse, String>,
) -> DaemonRouteResponse {
    match response {
        Ok(response) => {
            let upstream_type = response.content_type.unwrap_or_default();
            if !upstream_type.starts_with("image/") {
                let text = String::from_utf8_lossy(&response.body).trim().to_owned();
                if text.is_empty() {
                    return DaemonRouteResponse::json(response.status, Value::Null);
                }
                return match serde_json::from_str::<Value>(&text) {
                    Ok(json) if !text.is_empty() => {
                        DaemonRouteResponse::json(response.status, json)
                    }
                    Ok(_) => DaemonRouteResponse::json(response.status, Value::Null),
                    Err(_) => DaemonRouteResponse::json(
                        502,
                        json!({ "ok": false, "error": "upstream returned an unreadable response" }),
                    ),
                };
            }
            DaemonRouteResponse {
                status: response.status,
                body: DaemonResponseBody::Bytes(response.body),
                content_type: Some(upstream_type),
            }
        }
        Err(error) => proxy_error_response(error),
    }
}

pub fn execute_proxy_json_request(
    target_url: &str,
    method: &str,
    headers: &BTreeMap<String, String>,
    body: Option<&Value>,
    timeout_ms: u64,
) -> Result<ProxyJsonResponse, String> {
    let daemon_method = if method.eq_ignore_ascii_case("POST") {
        DaemonHttpMethod::Post
    } else {
        DaemonHttpMethod::Get
    };
    let request = DaemonJsonRequest {
        url: target_url.to_owned(),
        method: daemon_method,
        headers: headers.clone(),
        body: body.map(Value::to_string),
        timeout_ms: Some(timeout_ms),
    };
    execute_loopback_json_request(&request)
        .map(|response| ProxyJsonResponse {
            status: response.status,
            json: response.json,
        })
        .map_err(proxy_transport_error_text)
}

pub fn execute_proxy_binary_request(
    target_url: &str,
    method: &str,
    headers: &BTreeMap<String, String>,
    timeout_ms: u64,
    max_bytes: usize,
) -> Result<ProxyBinaryResponse, String> {
    let daemon_method = if method.eq_ignore_ascii_case("POST") {
        DaemonHttpMethod::Post
    } else {
        DaemonHttpMethod::Get
    };
    let request = DaemonJsonRequest {
        url: target_url.to_owned(),
        method: daemon_method,
        headers: headers.clone(),
        body: None,
        timeout_ms: Some(timeout_ms),
    };
    execute_loopback_binary_request(&request, max_bytes)
        .map(|response| ProxyBinaryResponse {
            status: response.status,
            body: response.body,
            content_type: response.content_type,
        })
        .map_err(proxy_transport_error_text)
}

fn proxy_transport_error_text(error: CoreCommandTransportError) -> String {
    match error {
        CoreCommandTransportError::DaemonRequest { message, .. } => message,
        other => other.to_string(),
    }
}

fn expose_focus_request(body: Option<&Value>) -> Result<ExposeFocusRequest, DaemonRouteResponse> {
    let payload = body.unwrap_or(&Value::Null);
    string_or_missing(payload, "windowId")?;
    string_or_missing(payload, "projectRoot")?;
    string_or_missing(payload, "currentClientSession")?;
    string_or_missing(payload, "clientTty")?;

    let window_id = payload
        .get("windowId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    if window_id.is_empty() {
        return Err(DaemonRouteResponse::json(
            400,
            json!({ "ok": false, "error": "windowId is required" }),
        ));
    }
    Ok(ExposeFocusRequest {
        window_id,
        project_root: trimmed_optional(payload, "projectRoot"),
        current_client_session: trimmed_optional(payload, "currentClientSession"),
        client_tty: trimmed_optional(payload, "clientTty"),
    })
}

fn string_or_missing(payload: &Value, key: &str) -> Result<(), DaemonRouteResponse> {
    if payload.get(key).is_some_and(Value::is_string) || payload.get(key).is_none() {
        return Ok(());
    }
    Err(DaemonRouteResponse::json(
        400,
        json!({ "ok": false, "error": format!("{key} must be a string") }),
    ))
}

fn trimmed_optional(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn proxy_host_allowed(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost")
}

fn proxy_error_response(error: String) -> DaemonRouteResponse {
    let status = if is_timeout_error_text(&error) {
        504
    } else {
        502
    };
    DaemonRouteResponse::json(status, json!({ "ok": false, "error": error }))
}

fn is_timeout_error_text(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("timed out") || value.contains("timeout")
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}
