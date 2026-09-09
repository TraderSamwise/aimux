use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::{
    DaemonResponseBody, HeaderValue, cors_headers, is_allowed_cors_origin, prepare_daemon_response,
    read_json_body, reject_cors_response, request_headers,
};
use aimux::daemon::routing::{
    DaemonRouteUrl, boolean_param, csv_param, integer_param, local_auth_routes,
    local_cli_text_routes, notification_mutation_payload, required_param, text_or_json_lines,
};
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn daemon_http_helpers_match_current_body_and_header_behavior() {
    assert_eq!(
        read_json_body(None, [br#"{"ok":true}"#.as_slice()]).expect("json body"),
        json!({ "ok": true })
    );
    assert_eq!(
        read_json_body(
            Some("application/x-www-form-urlencoded; charset=utf-8"),
            ["name=sam+one&empty=&encoded=a%2Fb".as_bytes()],
        )
        .expect("form body"),
        json!({ "name": "sam one", "empty": "", "encoded": "a/b" })
    );
    assert_eq!(
        read_json_body(None, [b"   ".as_slice()]).expect("empty body"),
        json!({})
    );

    let headers = request_headers([
        ("Origin", HeaderValue::Single("http://localhost:8081")),
        ("X-Many", HeaderValue::Many(&["a", "b"])),
    ]);
    assert_eq!(
        headers.get("origin"),
        Some(&"http://localhost:8081".to_owned())
    );
    assert!(!headers.contains_key("x-many"));
}

#[test]
fn daemon_cors_matches_loopback_allowlist_without_wildcard_default() {
    assert!(is_allowed_cors_origin("http://localhost:8081"));
    assert!(is_allowed_cors_origin("http://localhost:4545"));
    assert!(is_allowed_cors_origin("http://127.0.0.1:4545"));
    assert!(is_allowed_cors_origin("http://LOCALHOST:4545"));
    assert!(!is_allowed_cors_origin("https://localhost:4545"));
    assert!(!is_allowed_cors_origin("https://evil.example"));
    assert!(!is_allowed_cors_origin("http://localhost:123@evil.example"));
    assert!(!is_allowed_cors_origin("http://localhost:abc"));

    let empty = BTreeMap::new();
    let no_origin = cors_headers(&empty).expect("no origin is allowed");
    assert!(!no_origin.contains_key("Access-Control-Allow-Origin"));

    let allowed = cors_headers(&BTreeMap::from([
        ("origin".to_owned(), "http://localhost:4545".to_owned()),
        (
            "access-control-request-private-network".to_owned(),
            "true".to_owned(),
        ),
    ]))
    .expect("local origin is allowed");
    assert_eq!(
        allowed.get("Access-Control-Allow-Origin"),
        Some(&"http://localhost:4545".to_owned())
    );
    assert_eq!(
        allowed.get("Access-Control-Allow-Private-Network"),
        Some(&"true".to_owned())
    );

    assert!(
        cors_headers(&BTreeMap::from([(
            "origin".to_owned(),
            "https://evil.example".to_owned()
        )]))
        .is_none()
    );
    assert_eq!(
        reject_cors_response().body,
        br#"{"ok":false,"error":"origin not allowed"}"#.to_vec()
    );
}

#[test]
fn daemon_send_keeps_binary_bodies_unmodified() {
    let image = prepare_daemon_response(
        200,
        DaemonResponseBody::Bytes(vec![0, 1, 2, 3]),
        Some("image/png"),
    );
    assert_eq!(image.status, 200);
    assert_eq!(image.body, vec![0, 1, 2, 3]);
    assert_eq!(image.headers.get("content-length"), Some(&"4".to_owned()));
    assert_eq!(
        image.headers.get("content-type"),
        Some(&"image/png".to_owned())
    );

    let text = prepare_daemon_response(
        200,
        DaemonResponseBody::Text("hello".into()),
        Some("text/plain; charset=utf-8"),
    );
    assert_eq!(text.body, b"hello");
    assert_eq!(text.headers.get("content-length"), Some(&"5".to_owned()));
}

#[test]
fn daemon_route_url_and_param_helpers_match_typescript_rules() {
    let route = DaemonRouteUrl::parse("/route?project=%2Frepo&json=1&ids=a,b&ids=c");
    assert_eq!(route.pathname(), "/route");
    assert_eq!(required_param(&route, None, "project").unwrap(), "/repo");
    assert!(boolean_param(&route, None, "open", true));
    assert!(!boolean_param(
        &DaemonRouteUrl::parse("/route?open=false"),
        None,
        "open",
        true
    ));
    assert_eq!(
        integer_param(
            &DaemonRouteUrl::parse("/route?startLine=-120"),
            None,
            "startLine",
            0,
            Some("start-line")
        )
        .unwrap(),
        -120
    );
    assert_eq!(csv_param(&route, None, "ids").unwrap(), ["a", "b"]);

    let payload = notification_mutation_payload(
        &route,
        Some(&json!({ "id": " one ", "sessionId": " two " })),
    )
    .unwrap();
    assert_eq!(
        payload,
        json!({ "id": "one", "ids": ["a", "b", "c"], "sessionId": "two" })
    );
}

#[test]
fn text_routes_and_auth_routes_are_grouped_for_daemon_split() {
    assert!(local_auth_routes().contains(&CORE_API_ROUTES.login_text));
    assert!(local_auth_routes().contains(&CORE_API_ROUTES.security_unlock_text));
    assert!(local_cli_text_routes().contains(&CORE_API_ROUTES.task_assign_text));
    assert!(local_cli_text_routes().contains(&CORE_API_ROUTES.host_agent_stream_text));
    assert!(local_cli_text_routes().contains(&CORE_API_ROUTES.worktree_resurrect_text));
}

#[test]
fn text_or_json_lines_preserves_trailing_newline_contract() {
    let text = text_or_json_lines(
        &DaemonRouteUrl::parse("/route"),
        json!({ "ok": true }),
        &["one".to_owned(), "two".to_owned()],
    );
    assert_eq!(text.status, 200);
    assert_eq!(
        text.content_type.as_deref(),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(text.body, DaemonResponseBody::Text("one\ntwo\n".into()));

    let json_response = text_or_json_lines(
        &DaemonRouteUrl::parse("/route?json=1"),
        json!({ "ok": true }),
        &[],
    );
    assert_eq!(
        json_response.body,
        DaemonResponseBody::Text("{\n  \"ok\": true\n}\n".into())
    );
}
