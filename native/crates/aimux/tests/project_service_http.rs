use aimux::project_service::http::{
    BodyTooLarge, HeaderValue, ProjectServiceBodyError, is_allowed_cors_origin,
    parse_bounded_limit, parse_integer_value, parse_optional_integer, parse_positive_integer_value,
    prepare_project_service_bytes_response, prepare_project_service_json_response,
    project_service_cors_headers, project_service_request_headers, read_json_body_limited,
    reject_project_service_cors_response,
};
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn reads_json_with_streaming_byte_limit() {
    assert_eq!(
        read_json_body_limited([br#"{"ok":true}"#.as_slice()], 32).expect("json body"),
        json!({ "ok": true })
    );
    assert_eq!(
        read_json_body_limited([b"   ".as_slice()], 32).expect("empty body"),
        json!({})
    );
    assert_eq!(
        read_json_body_limited([b"abcdef".as_slice()], 3).expect_err("body too large"),
        ProjectServiceBodyError::TooLarge(BodyTooLarge { limit: 3 })
    );
}

#[test]
fn normalizes_request_headers_like_node_helper() {
    let headers = project_service_request_headers([
        ("One", HeaderValue::Single("1")),
        ("Many", HeaderValue::Many(&["a", "b"])),
        ("Empty", HeaderValue::Many(&[])),
    ]);
    assert_eq!(headers.get("one"), Some(&"1".to_owned()));
    assert_eq!(headers.get("many"), Some(&"a, b".to_owned()));
    assert!(!headers.contains_key("empty"));
}

#[test]
fn cors_matches_project_service_helper_contract() {
    assert!(is_allowed_cors_origin("http://localhost:8081"));
    assert!(is_allowed_cors_origin("http://localhost:4545"));
    assert!(is_allowed_cors_origin("http://127.0.0.1:4545"));
    assert!(is_allowed_cors_origin("http://LOCALHOST:4545"));
    assert!(!is_allowed_cors_origin("https://aimux.app"));
    assert!(!is_allowed_cors_origin("https://evil.example"));
    assert!(!is_allowed_cors_origin("http://localhost:123@evil.example"));
    assert!(!is_allowed_cors_origin("http://localhost:abc"));

    let no_origin = project_service_cors_headers(&BTreeMap::new()).expect("no origin is allowed");
    assert_eq!(
        no_origin.get("Access-Control-Allow-Origin"),
        Some(&"*".to_owned())
    );
    assert_eq!(
        no_origin.get("Access-Control-Allow-Methods"),
        Some(&"GET, POST, PUT, OPTIONS".to_owned())
    );

    let allowed = project_service_cors_headers(&BTreeMap::from([
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
    assert_eq!(allowed.get("Vary"), Some(&"Origin".to_owned()));
    assert_eq!(
        allowed.get("Access-Control-Allow-Private-Network"),
        Some(&"true".to_owned())
    );

    assert!(
        project_service_cors_headers(&BTreeMap::from([(
            "origin".to_owned(),
            "https://evil.example".to_owned()
        )]))
        .is_none()
    );
    assert_eq!(
        reject_project_service_cors_response().body,
        br#"{"ok":false,"error":"origin not allowed"}"#.to_vec()
    );
}

#[test]
fn prepared_responses_match_project_service_send_helpers() {
    let mut cors = BTreeMap::new();
    cors.insert(
        "Access-Control-Allow-Origin".to_owned(),
        "http://localhost:3000".to_owned(),
    );
    let json_response = prepare_project_service_json_response(201, json!({ "ok": true }), cors);
    assert_eq!(json_response.status, 201);
    assert_eq!(json_response.body, br#"{"ok":true}"#.to_vec());
    assert_eq!(
        json_response.headers.get("Access-Control-Allow-Origin"),
        Some(&"http://localhost:3000".to_owned())
    );

    let bytes =
        prepare_project_service_bytes_response(200, vec![0, 1, 2], "image/png", BTreeMap::new());
    assert_eq!(bytes.body, vec![0, 1, 2]);
    assert_eq!(bytes.headers.get("content-length"), Some(&"3".to_owned()));
    assert_eq!(
        bytes.headers.get("content-type"),
        Some(&"image/png".to_owned())
    );
    assert_eq!(
        bytes.headers.get("cache-control"),
        Some(&"private, max-age=31536000, immutable".to_owned())
    );
    assert_eq!(
        bytes.headers.get("x-content-type-options"),
        Some(&"nosniff".to_owned())
    );
    assert_eq!(
        bytes.headers.get("access-control-allow-origin"),
        Some(&"*".to_owned())
    );
}

#[test]
fn parses_integer_inputs_consistently() {
    assert_eq!(parse_optional_integer(None, "startLine"), Ok(None));
    assert_eq!(
        parse_optional_integer(Some(" 5 "), "startLine"),
        Ok(Some(5))
    );
    assert_eq!(
        parse_integer_value(&json!("bad"), "rows"),
        Err("rows must be an integer".into())
    );
    assert_eq!(
        parse_integer_value(&json!(9_007_199_254_740_992_i64), "rows"),
        Err("rows must be an integer".into())
    );
    assert_eq!(
        parse_positive_integer_value(&json!(0), "rows"),
        Err("rows must be an integer >= 1".into())
    );
    assert_eq!(parse_bounded_limit(Some("999"), "limit", 10, 100), Ok(100));
}
