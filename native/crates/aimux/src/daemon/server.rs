use crate::core_command_contract::CORE_API_ROUTES;
use crate::daemon::http::{
    DaemonResponseBody, PreparedDaemonResponse, cors_headers, prepare_daemon_response,
    read_json_body, reject_cors_response,
};
use crate::daemon::router::DaemonRouteRequestContext;
use crate::daemon::routing::DaemonRouteResponse;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonHttpRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body_chunks: Vec<Vec<u8>>,
    pub stopping: bool,
    pub issued_at: String,
}

pub fn handle_daemon_http_request<BuildContext, Route>(
    request: DaemonHttpRequest,
    build_context: BuildContext,
    route: Route,
) -> PreparedDaemonResponse
where
    BuildContext:
        FnOnce(&str, &str, Option<&Value>, &BTreeMap<String, String>) -> DaemonRouteRequestContext,
    Route:
        FnOnce(&str, &str, Option<&Value>, &DaemonRouteRequestContext, &str) -> DaemonRouteResponse,
{
    if request.stopping {
        return prepare_daemon_response(
            503,
            DaemonResponseBody::Json(json!({ "ok": false, "error": "aimux daemon is stopping" })),
            None,
        );
    }

    let cors = match cors_headers(&request.headers) {
        Some(headers) => headers,
        None => return reject_cors_response(),
    };
    if request.method == "OPTIONS" {
        return with_extra_headers(
            prepare_daemon_response(
                204,
                DaemonResponseBody::Text(String::new()),
                Some("text/plain"),
            ),
            cors,
        );
    }

    let body =
        if request.method == "POST" && pathname(&request.path) != CORE_API_ROUTES.restart_text {
            match read_json_body(
                request.headers.get("content-type").map(String::as_str),
                request.body_chunks.iter().map(Vec::as_slice),
            ) {
                Ok(body) => Some(body),
                Err(error) => {
                    return with_extra_headers(
                        prepare_daemon_response(
                            500,
                            DaemonResponseBody::Json(
                                json!({ "ok": false, "error": error.to_string() }),
                            ),
                            None,
                        ),
                        cors,
                    );
                }
            }
        } else {
            None
        };

    let context = build_context(
        &request.method,
        &request.path,
        body.as_ref(),
        &request.headers,
    );
    let response = route(
        &request.method,
        &request.path,
        body.as_ref(),
        &context,
        &request.issued_at,
    );
    with_extra_headers(
        prepare_daemon_response(
            response.status,
            response.body,
            response.content_type.as_deref(),
        ),
        cors,
    )
}

fn with_extra_headers(
    mut response: PreparedDaemonResponse,
    headers: BTreeMap<String, String>,
) -> PreparedDaemonResponse {
    response.headers.extend(headers);
    response
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map(|(path, _)| path).unwrap_or(path)
}
