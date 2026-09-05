use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::router::DaemonRouteRequestContext;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::server::{DaemonHttpRequest, handle_daemon_http_request};
use aimux::remote_access::RemoteAccessDecision;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::BTreeMap;

fn request(method: &str, path: &str) -> DaemonHttpRequest {
    DaemonHttpRequest {
        method: method.into(),
        path: path.into(),
        headers: BTreeMap::new(),
        body_chunks: Vec::new(),
        actor_present: false,
        access_decision: None,
        stopping: false,
        issued_at: "issued".into(),
    }
}

#[test]
fn stopping_short_circuits_before_cors_like_daemon_start_handler() {
    let mut req = request("GET", "/health");
    req.stopping = true;
    req.headers.insert("origin".into(), "https://evil.example".into());

    let response = handle_daemon_http_request(req, |_, _, _, _, _| unreachable!("route skipped"));

    assert_eq!(response.status, 503);
    assert_eq!(response.body, br#"{"ok":false,"error":"aimux daemon is stopping"}"#);
    assert!(!response.headers.contains_key("Access-Control-Allow-Origin"));
}

#[test]
fn cors_and_options_are_handled_before_route_dispatch() {
    let mut blocked = request("GET", "/health");
    blocked.headers.insert("origin".into(), "https://evil.example".into());
    let response = handle_daemon_http_request(blocked, |_, _, _, _, _| unreachable!("route skipped"));
    assert_eq!(response.status, 403);
    assert_eq!(response.body, br#"{"ok":false,"error":"origin not allowed"}"#);

    let mut preflight = request("OPTIONS", "/projects");
    preflight.headers.insert("origin".into(), "http://localhost:8081".into());
    preflight
        .headers
        .insert("access-control-request-private-network".into(), "true".into());
    let response = handle_daemon_http_request(preflight, |_, _, _, _, _| unreachable!("route skipped"));
    assert_eq!(response.status, 204);
    assert_eq!(response.body, b"");
    assert_eq!(
        response.headers.get("Access-Control-Allow-Origin").map(String::as_str),
        Some("http://localhost:8081")
    );
    assert_eq!(
        response.headers.get("Access-Control-Allow-Private-Network").map(String::as_str),
        Some("true")
    );
}

#[test]
fn post_body_is_parsed_like_daemon_handle_except_restart_text() {
    let seen = RefCell::new(Vec::new());
    let mut req = request("POST", "/projects/ensure?x=1");
    req.headers.insert("content-type".into(), "application/json".into());
    req.body_chunks.push(br#"{"projectRoot":"/repo"}"#.to_vec());

    let response = handle_daemon_http_request(req, |method, path, body, _context, issued_at| {
        seen.borrow_mut().push(json!({
            "method": method,
            "path": path,
            "body": body.cloned().unwrap_or(Value::Null),
            "issuedAt": issued_at,
        }));
        DaemonRouteResponse::json(200, json!({ "ok": true }))
    });
    assert_eq!(response.status, 200);
    assert_eq!(seen.borrow()[0]["body"], json!({ "projectRoot": "/repo" }));

    let seen_restart = RefCell::new(Value::Bool(false));
    let mut restart = request("POST", CORE_API_ROUTES.restart_text);
    restart.body_chunks.push(br#"{"ignored":true}"#.to_vec());
    handle_daemon_http_request(restart, |_, _, body, _, _| {
        *seen_restart.borrow_mut() = body.cloned().unwrap_or(Value::Null);
        DaemonRouteResponse::text(200, "ok\n")
    });
    assert_eq!(*seen_restart.borrow(), Value::Null);
}

#[test]
fn form_body_parse_and_json_parse_errors_match_handle_contract() {
    let mut form = request("POST", "/internal/push");
    form.headers
        .insert("content-type".into(), "application/x-www-form-urlencoded; charset=utf-8".into());
    form.body_chunks.push(b"title=Hello+Sam&encoded=a%2Fb".to_vec());
    let response = handle_daemon_http_request(form, |_, _, body, _, _| {
        DaemonRouteResponse::json(200, body.cloned().unwrap())
    });
    assert_eq!(response.body, br#"{"title":"Hello Sam","encoded":"a/b"}"#);

    let mut bad = request("POST", "/internal/push");
    bad.body_chunks.push(b"{".to_vec());
    let response = handle_daemon_http_request(bad, |_, _, _, _, _| unreachable!("route skipped"));
    assert_eq!(response.status, 500);
    assert!(String::from_utf8(response.body).unwrap().contains("EOF"));
}

#[test]
fn route_context_carries_headers_actor_and_access_decision() {
    let seen = RefCell::new(None);
    let mut req = request("GET", "/health");
    req.actor_present = true;
    req.access_decision = Some(RemoteAccessDecision::deny(403, "nope"));
    req.headers.insert("x-aimux-actor-role".into(), "guest".into());

    handle_daemon_http_request(req, |_, _, _, context: &DaemonRouteRequestContext, _| {
        *seen.borrow_mut() = Some((
            context.actor_present,
            context.headers.get("x-aimux-actor-role").cloned(),
            context.access_decision.clone(),
        ));
        DaemonRouteResponse::json(200, json!({ "ok": true }))
    });

    let (actor_present, role, decision) = seen.borrow().clone().unwrap();
    assert!(actor_present);
    assert_eq!(role.as_deref(), Some("guest"));
    assert_eq!(decision.unwrap().error.as_deref(), Some("nope"));
}

#[test]
fn prepared_response_preserves_text_and_binary_route_bodies() {
    let text = handle_daemon_http_request(request("GET", "/text"), |_, _, _, _, _| {
        DaemonRouteResponse::text(200, "hello\n")
    });
    assert_eq!(text.body, b"hello\n");
    assert_eq!(
        text.headers.get("content-type").map(String::as_str),
        Some("text/plain; charset=utf-8")
    );

    let binary = handle_daemon_http_request(request("GET", "/image"), |_, _, _, _, _| {
        DaemonRouteResponse {
            status: 200,
            body: DaemonResponseBody::Bytes(vec![0, 1, 2]),
            content_type: Some("image/png".into()),
        }
    });
    assert_eq!(binary.body, vec![0, 1, 2]);
    assert_eq!(
        binary.headers.get("content-type").map(String::as_str),
        Some("image/png")
    );
}
