use serde_json::{Value, json};
use std::collections::BTreeMap;

use super::dispatcher::ProjectServiceDispatchResponse;
use super::http::{
    MAX_BODY_BYTES, PreparedProjectServiceResponse, ProjectServiceBodyError,
    prepare_project_service_bytes_response, prepare_project_service_empty_response,
    prepare_project_service_json_response, prepare_project_service_sse_response,
    project_service_cors_headers, read_json_body_limited, reject_project_service_cors_response,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectServiceHttpRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body_chunks: Vec<Vec<u8>>,
}

pub fn handle_project_service_http_request<Route>(
    request: ProjectServiceHttpRequest,
    route: Route,
) -> PreparedProjectServiceResponse
where
    Route: FnOnce(&str, &str, Option<&Value>) -> ProjectServiceDispatchResponse,
{
    let cors = match project_service_cors_headers(&request.headers) {
        Some(headers) => headers,
        None => return reject_project_service_cors_response(),
    };

    if request.method.eq_ignore_ascii_case("OPTIONS") {
        return prepare_project_service_empty_response(204, cors);
    }

    let body = if method_reads_json_body(&request.method) {
        match read_json_body_limited(
            request.body_chunks.iter().map(Vec::as_slice),
            MAX_BODY_BYTES,
        ) {
            Ok(value) => Some(value),
            Err(ProjectServiceBodyError::TooLarge(error)) => {
                return prepare_project_service_json_response(
                    413,
                    json!({ "ok": false, "error": error.to_string() }),
                    cors,
                );
            }
            Err(_) => {
                return prepare_project_service_json_response(
                    400,
                    json!({ "ok": false, "error": "body is not JSON" }),
                    cors,
                );
            }
        }
    } else {
        None
    };

    prepare_dispatch_response(route(&request.method, &request.path, body.as_ref()), cors)
}

pub(super) fn prepare_dispatch_response(
    response: ProjectServiceDispatchResponse,
    cors: BTreeMap<String, String>,
) -> PreparedProjectServiceResponse {
    if let Some(bytes) = response.bytes {
        if response.content_type.as_deref() == Some("text/event-stream") {
            return prepare_project_service_sse_response(
                response.status,
                bytes,
                response.stream,
                cors,
            );
        }
        return prepare_project_service_bytes_response(
            response.status,
            bytes,
            response
                .content_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
            cors,
        );
    }
    prepare_project_service_json_response(response.status, response.body, cors)
}

pub(super) fn method_reads_json_body(method: &str) -> bool {
    matches!(
        method.to_ascii_uppercase().as_str(),
        "POST" | "PUT" | "DELETE"
    )
}
