use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::auth::{
    AuthAction, AuthFlowError, AuthFlowResult, AuthFlowStart, AuthTextError, DaemonAuthTextRuntime,
    route_auth_text_request,
};
use serde_json::{Value, json};

#[derive(Debug)]
struct FakeAuthRuntime {
    credentials: bool,
    relay: Value,
    clear_result: String,
    fail_run: bool,
    calls: Vec<String>,
}

impl Default for FakeAuthRuntime {
    fn default() -> Self {
        Self {
            credentials: true,
            relay: json!({ "status": "connected", "relayUrl": "wss://relay" }),
            clear_result: "cleared".into(),
            fail_run: false,
            calls: Vec::new(),
        }
    }
}

impl DaemonAuthTextRuntime for FakeAuthRuntime {
    fn remote_status_text_payload(&self) -> Value {
        json!({
            "credentials": self.credentials.then(|| json!({
                "userId": "user-1",
                "relayUrl": "wss://relay",
                "remoteEnabled": true
            })),
            "relay": self.relay
        })
    }

    fn whoami_text_payload(&self) -> Value {
        json!({
            "credentials": self.credentials.then(|| json!({
                "userId": "user-1",
                "relayUrl": "wss://relay",
                "remoteEnabled": true
            }))
        })
    }

    fn require_remote_credentials(&self) -> Result<(), AuthTextError> {
        if self.credentials {
            Ok(())
        } else {
            Err(AuthTextError {
                status: 401,
                error: "Not logged in. Run `aimux login` first.".into(),
            })
        }
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        self.calls.push("enable".into());
        self.relay.clone()
    }

    fn relay_auth_failed_message(&self, relay: &Value) -> String {
        relay
            .get("lastError")
            .and_then(Value::as_str)
            .unwrap_or("Relay rejected credentials -- run `aimux login` again")
            .into()
    }

    fn disable_relay(&mut self) {
        self.calls.push("disable".into());
    }

    fn clear_credentials(&mut self) -> String {
        self.calls.push("clear".into());
        self.clear_result.clone()
    }

    fn run_auth_flow(&mut self, action: AuthAction) -> Result<AuthFlowResult, AuthFlowError> {
        self.calls.push(format!("run:{action:?}"));
        if self.fail_run {
            return Err(AuthFlowError {
                error: "denied".into(),
                messages: vec!["Open browser".into()],
            });
        }
        Ok(AuthFlowResult {
            user_id: match action {
                AuthAction::Login => "user-1",
                AuthAction::SecurityUnlock => "user-2",
            }
            .into(),
            relay: self.relay.clone(),
            messages: vec!["Open browser".into()],
        })
    }

    fn start_auth_flow(&mut self, action: AuthAction) -> AuthFlowStart {
        self.calls.push(format!("start:{action:?}"));
        AuthFlowStart {
            id: "auth-1".into(),
            messages: vec!["Open browser".into(), "Paste code".into()],
        }
    }

    fn wait_auth_flow(
        &mut self,
        id: &str,
        action: AuthAction,
    ) -> Result<AuthFlowResult, AuthTextError> {
        self.calls.push(format!("wait:{id}:{action:?}"));
        if id == "missing" {
            return Err(AuthTextError {
                status: 404,
                error: "auth session not found".into(),
            });
        }
        Ok(AuthFlowResult {
            user_id: "user-1".into(),
            relay: self.relay.clone(),
            messages: Vec::new(),
        })
    }
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

fn json_text(response: DaemonRouteResponse) -> Value {
    serde_json::from_str(&text_body(response)).expect("json text")
}

#[test]
fn remote_status_and_whoami_match_text_and_json_contracts() {
    let mut runtime = FakeAuthRuntime::default();
    let status = route_auth_text_request(&mut runtime, "GET", CORE_API_ROUTES.remote_status_text)
        .expect("remote status");
    assert_eq!(
        text_body(status),
        "Remote access: enabled\nRelay: wss://relay\nConnection: connected\n"
    );

    let status_json = route_auth_text_request(
        &mut runtime,
        "GET",
        &format!("{}?json=1", CORE_API_ROUTES.remote_status_text),
    )
    .expect("remote status");
    assert_eq!(
        json_text(status_json),
        json!({ "loggedIn": true, "relay": runtime.relay })
    );

    let whoami =
        route_auth_text_request(&mut runtime, "GET", CORE_API_ROUTES.whoami_text).expect("whoami");
    assert_eq!(
        text_body(whoami),
        "Logged in as user-1\nRelay: wss://relay\nRemote access: enabled\n"
    );

    let whoami_json = route_auth_text_request(
        &mut runtime,
        "GET",
        &format!("{}?json=1", CORE_API_ROUTES.whoami_text),
    )
    .expect("whoami");
    assert_eq!(
        json_text(whoami_json),
        json!({ "loggedIn": true, "userId": "user-1", "relayUrl": "wss://relay", "remoteEnabled": true })
    );
}

#[test]
fn remote_enable_disable_and_logout_preserve_status_contracts() {
    let mut runtime = FakeAuthRuntime::default();
    let enabled = route_auth_text_request(&mut runtime, "POST", CORE_API_ROUTES.remote_enable_text)
        .expect("remote enable");
    assert_eq!(
        text_body(enabled),
        "✓ Remote access enabled (connection: connected)\n"
    );
    assert_eq!(runtime.calls, ["enable"]);

    let disabled =
        route_auth_text_request(&mut runtime, "POST", CORE_API_ROUTES.remote_disable_text)
            .expect("remote disable");
    assert_eq!(
        text_body(disabled),
        "✓ Remote access disabled. Daemon disconnected from relay.\n"
    );

    let logout =
        route_auth_text_request(&mut runtime, "POST", CORE_API_ROUTES.logout_text).expect("logout");
    assert_eq!(logout.status, 200);
    assert_eq!(text_body(logout), "✓ Logged out. Remote access disabled.\n");
    assert_eq!(runtime.calls, ["enable", "disable", "disable", "clear"]);

    let missing_credentials = route_auth_text_request(
        &mut FakeAuthRuntime {
            credentials: false,
            ..FakeAuthRuntime::default()
        },
        "POST",
        CORE_API_ROUTES.remote_enable_text,
    )
    .expect("remote enable");
    assert_eq!(missing_credentials.status, 401);
    assert_eq!(
        text_body(missing_credentials),
        "Not logged in. Run `aimux login` first.\n"
    );

    let auth_failed = route_auth_text_request(
        &mut FakeAuthRuntime {
            relay: json!({ "status": "auth_failed", "lastError": "bad token" }),
            ..FakeAuthRuntime::default()
        },
        "POST",
        CORE_API_ROUTES.remote_enable_text,
    )
    .expect("remote enable");
    assert_eq!(auth_failed.status, 401);
    assert_eq!(text_body(auth_failed), "bad token\n");
}

#[test]
fn login_and_security_unlock_flow_routes_match_text_contracts() {
    let mut runtime = FakeAuthRuntime::default();

    let started = route_auth_text_request(&mut runtime, "POST", CORE_API_ROUTES.login_start_text)
        .expect("login start");
    assert_eq!(
        text_body(started),
        "auth-session: auth-1\nOpen browser\nPaste code\n"
    );

    let waited = route_auth_text_request(
        &mut runtime,
        "POST",
        &format!("{}?id=auth-1", CORE_API_ROUTES.login_wait_text),
    )
    .expect("login wait");
    assert_eq!(
        text_body(waited),
        "\n✓ Logged in as user-1\nRemote access is enabled (connection: connected).\n"
    );

    let login =
        route_auth_text_request(&mut runtime, "POST", CORE_API_ROUTES.login_text).expect("login");
    assert_eq!(
        text_body(login),
        "Open browser\n\n✓ Logged in as user-1\nRemote access is enabled (connection: connected).\n"
    );

    let security =
        route_auth_text_request(&mut runtime, "POST", CORE_API_ROUTES.security_unlock_text)
            .expect("security unlock");
    assert_eq!(
        text_body(security),
        "Open browser\n\n✓ Security unlocked for user-2\nRemote access is enabled (connection: connected).\n"
    );

    assert_eq!(
        runtime.calls,
        [
            "start:Login",
            "wait:auth-1:Login",
            "run:Login",
            "run:SecurityUnlock"
        ]
    );
}

#[test]
fn auth_failures_and_unrelated_routes_match_daemon_split() {
    let missing_id = route_auth_text_request(
        &mut FakeAuthRuntime::default(),
        "POST",
        CORE_API_ROUTES.login_wait_text,
    )
    .expect("login wait");
    assert_eq!(missing_id.status, 400);
    assert_eq!(text_body(missing_id), "auth session id is required\n");

    let missing_flow = route_auth_text_request(
        &mut FakeAuthRuntime::default(),
        "POST",
        &format!("{}?id=missing", CORE_API_ROUTES.login_wait_text),
    )
    .expect("login wait");
    assert_eq!(missing_flow.status, 404);
    assert_eq!(text_body(missing_flow), "auth session not found\n");

    let failed_run = route_auth_text_request(
        &mut FakeAuthRuntime {
            fail_run: true,
            ..FakeAuthRuntime::default()
        },
        "POST",
        CORE_API_ROUTES.security_unlock_text,
    )
    .expect("security unlock");
    assert_eq!(failed_run.status, 500);
    assert_eq!(
        text_body(failed_run),
        "Open browser\nSecurity unlock failed: denied\n"
    );

    assert!(
        route_auth_text_request(
            &mut FakeAuthRuntime::default(),
            "GET",
            CORE_API_ROUTES.team_show_text,
        )
        .is_none()
    );
}
