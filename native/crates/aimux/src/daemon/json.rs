use crate::core_command_contract::CORE_API_ROUTES;
use crate::daemon::core_commands::DaemonCoreCommandRuntime;
use crate::daemon::http::DaemonResponseBody;
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl};
use crate::project_api_contract::routes as project_routes;
use crate::proxy_project_binding::{is_binary_project_route, parse_proxy_target};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const PROXY_TIMEOUT_MS: u64 = 10_000;
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
    runtime: &mut impl DaemonJsonRouteRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
    headers: &BTreeMap<String, String>,
    actor_present: bool,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET" && pathname == "/relay/status" {
        return Some(DaemonRouteResponse::json(
            200,
            json!({ "ok": true, "relay": runtime.relay_status() }),
        ));
    }

    if method == "POST" && pathname == "/relay/enable" {
        if !runtime.has_remote_credentials() {
            return Some(DaemonRouteResponse::json(
                401,
                json!({ "ok": false, "error": "Not logged in. Run `aimux login` first." }),
            ));
        }
        let relay = runtime.enable_relay_for_user_request();
        if relay.get("status").and_then(Value::as_str) == Some("auth_failed") {
            return Some(DaemonRouteResponse::json(
                401,
                json!({ "ok": false, "error": runtime.relay_auth_failed_message(&relay), "relay": relay }),
            ));
        }
        return Some(DaemonRouteResponse::json(
            200,
            json!({ "ok": true, "relay": relay }),
        ));
    }

    if method == "POST" && pathname == "/relay/disable" {
        return Some(DaemonRouteResponse::json(
            200,
            json!({ "ok": true, "relay": runtime.disable_relay() }),
        ));
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
        match runtime.proxy_json_request(&target_url, method, headers, body, PROXY_TIMEOUT_MS) {
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
    match runtime.proxy_binary_request(
        target_url,
        method,
        headers,
        PROXY_TIMEOUT_MS,
        PROXY_MAX_BINARY_BYTES,
    ) {
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
