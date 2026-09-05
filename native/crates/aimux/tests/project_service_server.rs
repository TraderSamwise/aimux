use aimux::project_api_contract::routes;
use aimux::project_service::dispatcher::ProjectServiceDispatchResponse;
use aimux::project_service::server::{
    ProjectServiceHttpRequest, handle_project_service_http_request,
};
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn handles_cors_before_routing() {
    let response = handle_project_service_http_request(
        request(
            "GET",
            routes::HEALTH,
            [("origin", "https://evil.example")],
            [],
        ),
        |_method, _path, _body| panic!("blocked CORS should not route"),
    );
    assert_eq!(response.status, 403);
    assert_eq!(
        response.body,
        br#"{"ok":false,"error":"origin not allowed"}"#.to_vec()
    );
}

#[test]
fn options_short_circuits_with_project_service_cors_headers() {
    let response = handle_project_service_http_request(
        request(
            "OPTIONS",
            routes::HEALTH,
            [("origin", "http://localhost:4545")],
            [],
        ),
        |_method, _path, _body| panic!("OPTIONS should not route"),
    );
    assert_eq!(response.status, 204);
    assert!(response.body.is_empty());
    assert!(!response.headers.contains_key("content-type"));
    assert_eq!(
        response.headers.get("Access-Control-Allow-Origin"),
        Some(&"http://localhost:4545".to_owned())
    );
    assert_eq!(
        response.headers.get("Access-Control-Allow-Methods"),
        Some(&"GET, POST, PUT, OPTIONS".to_owned())
    );
}

#[test]
fn parses_write_body_before_dispatch() {
    let response = handle_project_service_http_request(
        request(
            "POST",
            routes::runtime::SET_STATUS,
            [],
            [br#"{"session":"codex-1","text":"idle"}"#.as_slice()],
        ),
        |method, path, body| {
            assert_eq!(method, "POST");
            assert_eq!(path, routes::runtime::SET_STATUS);
            assert_eq!(body, Some(&json!({ "session": "codex-1", "text": "idle" })));
            ProjectServiceDispatchResponse {
                status: 200,
                body: json!({ "ok": true }),
            }
        },
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, br#"{"ok":true}"#.to_vec());
    assert_eq!(
        response.headers.get("Access-Control-Allow-Origin"),
        Some(&"*".to_owned())
    );
}

#[test]
fn does_not_parse_get_body() {
    let response = handle_project_service_http_request(
        request("GET", routes::HEALTH, [], [b"not json".as_slice()]),
        |_method, _path, body| {
            assert!(body.is_none());
            ProjectServiceDispatchResponse {
                status: 200,
                body: json!({ "ok": true }),
            }
        },
    );
    assert_eq!(response.status, 200);
}

#[test]
fn rejects_invalid_and_oversized_write_bodies_like_project_service_http() {
    let invalid = handle_project_service_http_request(
        request(
            "POST",
            routes::runtime::SET_STATUS,
            [],
            [b"not json".as_slice()],
        ),
        |_method, _path, _body| panic!("invalid body should not route"),
    );
    assert_eq!(invalid.status, 400);
    assert_eq!(
        invalid.body,
        br#"{"ok":false,"error":"body is not JSON"}"#.to_vec()
    );

    let oversized = handle_project_service_http_request(
        ProjectServiceHttpRequest {
            method: "POST".into(),
            path: routes::runtime::SET_STATUS.into(),
            headers: BTreeMap::new(),
            body_chunks: vec![vec![b'x'; 1024 * 1024 + 1]],
        },
        |_method, _path, _body| panic!("oversized body should not route"),
    );
    assert_eq!(oversized.status, 413);
    assert_eq!(
        oversized.body,
        br#"{"ok":false,"error":"body exceeds 1048576 bytes"}"#.to_vec()
    );
}

fn request<const N: usize, const M: usize>(
    method: &str,
    path: &str,
    headers: [(&str, &str); N],
    chunks: [&[u8]; M],
) -> ProjectServiceHttpRequest {
    ProjectServiceHttpRequest {
        method: method.into(),
        path: path.into(),
        headers: headers
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
        body_chunks: chunks.into_iter().map(|chunk| chunk.to_vec()).collect(),
    }
}
