use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{
    core_whoami_json, render_core_login_lines, render_core_logout_lines,
    render_core_remote_disable_lines, render_core_remote_enable_lines,
    render_core_remote_status_lines, render_core_security_unlock_lines, render_core_whoami_lines,
};
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl, text_or_json_lines};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthAction {
    Login,
    SecurityUnlock,
}

impl AuthAction {
    fn failure_prefix(self) -> &'static str {
        match self {
            Self::Login => "Login failed",
            Self::SecurityUnlock => "Security unlock failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuthFlowResult {
    pub user_id: String,
    pub relay: Value,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthFlowStart {
    pub id: String,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthTextError {
    pub status: u16,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthFlowError {
    pub error: String,
    pub messages: Vec<String>,
}

pub trait DaemonAuthTextRuntime {
    fn remote_status_text_payload(&self) -> Value;
    fn whoami_text_payload(&self) -> Value;
    fn require_remote_credentials(&self) -> Result<(), AuthTextError>;
    fn enable_relay_for_user_request(&mut self) -> Value;
    fn relay_auth_failed_message(&self, relay: &Value) -> String;
    fn disable_relay(&mut self);
    fn clear_credentials(&mut self) -> String;
    fn run_auth_flow(&mut self, action: AuthAction) -> Result<AuthFlowResult, AuthFlowError>;
    fn start_auth_flow(&mut self, action: AuthAction) -> AuthFlowStart;
    fn wait_auth_flow(
        &mut self,
        id: &str,
        action: AuthAction,
    ) -> Result<AuthFlowResult, AuthTextError>;
}

pub fn route_auth_text_request(
    runtime: &mut impl DaemonAuthTextRuntime,
    method: &str,
    path: &str,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET" && pathname == CORE_API_ROUTES.remote_status_text {
        return Some(remote_status_text_route(runtime, &route_url));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.whoami_text {
        return Some(whoami_text_route(runtime, &route_url));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.remote_enable_text {
        return Some(remote_enable_text_route(runtime, &route_url));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.remote_disable_text {
        return Some(remote_disable_text_route(runtime, &route_url));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.login_start_text {
        return Some(start_auth_text_route(runtime, AuthAction::Login));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.login_wait_text {
        return Some(wait_auth_text_route(runtime, &route_url, AuthAction::Login));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.login_text {
        return Some(run_auth_text_route(runtime, AuthAction::Login));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.logout_text {
        return Some(logout_text_route(runtime));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.security_unlock_start_text {
        return Some(start_auth_text_route(runtime, AuthAction::SecurityUnlock));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.security_unlock_wait_text {
        return Some(wait_auth_text_route(
            runtime,
            &route_url,
            AuthAction::SecurityUnlock,
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.security_unlock_text {
        return Some(run_auth_text_route(runtime, AuthAction::SecurityUnlock));
    }

    None
}

pub fn remote_status_text_route(
    runtime: &impl DaemonAuthTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    let payload = runtime.remote_status_text_payload();
    let json_body = json!({
        "loggedIn": payload.get("credentials").is_some_and(|value| !value.is_null()),
        "relay": payload.get("relay").cloned().unwrap_or(Value::Null),
    });
    text_or_json_lines(
        route_url,
        json_body,
        &render_core_remote_status_lines(&payload),
    )
}

pub fn whoami_text_route(
    runtime: &impl DaemonAuthTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    let payload = runtime.whoami_text_payload();
    text_or_json_lines(
        route_url,
        core_whoami_json(&payload),
        &render_core_whoami_lines(&payload),
    )
}

pub fn remote_enable_text_route(
    runtime: &mut impl DaemonAuthTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    if let Err(error) = runtime.require_remote_credentials() {
        return DaemonRouteResponse::text(error.status, format!("{}\n", error.error));
    }
    let relay = runtime.enable_relay_for_user_request();
    if relay.get("status").and_then(Value::as_str) == Some("auth_failed") {
        return DaemonRouteResponse::text(
            401,
            format!("{}\n", runtime.relay_auth_failed_message(&relay)),
        );
    }
    text_or_json_lines(
        route_url,
        json!({ "relay": relay.clone() }),
        &render_core_remote_enable_lines(&relay),
    )
}

pub fn remote_disable_text_route(
    runtime: &mut impl DaemonAuthTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    runtime.disable_relay();
    text_or_json_lines(
        route_url,
        json!({ "relay": { "status": "off" } }),
        &render_core_remote_disable_lines(true),
    )
}

pub fn logout_text_route(runtime: &mut impl DaemonAuthTextRuntime) -> DaemonRouteResponse {
    runtime.disable_relay();
    let result = runtime.clear_credentials();
    DaemonRouteResponse::text(
        if result == "failed" { 500 } else { 200 },
        format!("{}\n", render_core_logout_lines(&result).join("\n")),
    )
}

pub fn run_auth_text_route(
    runtime: &mut impl DaemonAuthTextRuntime,
    action: AuthAction,
) -> DaemonRouteResponse {
    match runtime.run_auth_flow(action) {
        Ok(result) => {
            let payload = json!({ "userId": result.user_id, "relay": result.relay });
            let mut lines = result.messages;
            lines.extend(render_auth_success_lines(action, &payload));
            DaemonRouteResponse::text(200, format!("{}\n", lines.join("\n")))
        }
        Err(error) => {
            let mut lines = error.messages;
            lines.push(format!("{}: {}", action.failure_prefix(), error.error));
            DaemonRouteResponse::text(500, format!("{}\n", lines.join("\n")))
        }
    }
}

pub fn start_auth_text_route(
    runtime: &mut impl DaemonAuthTextRuntime,
    action: AuthAction,
) -> DaemonRouteResponse {
    let start = runtime.start_auth_flow(action);
    DaemonRouteResponse::text(
        200,
        format!(
            "auth-session: {}\n{}\n",
            start.id,
            start.messages.join("\n")
        ),
    )
}

pub fn wait_auth_text_route(
    runtime: &mut impl DaemonAuthTextRuntime,
    route_url: &DaemonRouteUrl,
    action: AuthAction,
) -> DaemonRouteResponse {
    let Some(id) = route_url.search_param("id") else {
        return DaemonRouteResponse::text(400, "auth session id is required\n");
    };
    match runtime.wait_auth_flow(id, action) {
        Ok(result) => {
            let payload = json!({ "userId": result.user_id, "relay": result.relay });
            DaemonRouteResponse::text(
                200,
                format!(
                    "{}\n",
                    render_auth_success_lines(action, &payload).join("\n")
                ),
            )
        }
        Err(error) => DaemonRouteResponse::text(error.status, format!("{}\n", error.error)),
    }
}

fn render_auth_success_lines(action: AuthAction, payload: &Value) -> Vec<String> {
    match action {
        AuthAction::Login => render_core_login_lines(payload),
        AuthAction::SecurityUnlock => render_core_security_unlock_lines(payload),
    }
}
