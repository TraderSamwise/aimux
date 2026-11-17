use crate::attachment_hosting::{
    AttachmentHostingResult, PublishedAttachmentHostInput, filename_for_published_attachment,
    mime_type_for_published_attachment,
};
use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::render_core_work_outline_entries_lines;
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, required_param, string_param, text_error,
    text_or_json_lines,
};
use crate::daemon::text::params::{
    ProjectServiceJsonResult, required_project_service_array, required_project_service_object,
    required_project_service_string, unwrap_project_result,
};
use crate::daemon::text::worktrees::CLI_PROJECT_MUTATION_TIMEOUT_MS;
use crate::project_api_contract::routes as project_routes;
use serde_json::{Map, Value, json};

pub trait DaemonProjectContentTextRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult;
    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult;
    fn host_published_attachment(
        &mut self,
        _input: &PublishedAttachmentHostInput<'_>,
    ) -> AttachmentHostingResult {
        AttachmentHostingResult::Skipped
    }
}

pub fn route_project_content_text_request(
    runtime: &mut impl DaemonProjectContentTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET" && pathname == CORE_API_ROUTES.usage_text {
        return Some(usage_text_route(runtime, &route_url, body));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.outline_list_text {
        return Some(outline_list_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.outline_update_text {
        return Some(outline_update_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.attachment_publish_text {
        return Some(attachment_publish_text_route(runtime, &route_url, body));
    }

    None
}

/// Phase one of `aimux usage`: everything decidable without the project
/// service, so the carve-out can resolve under the lock and release it before
/// the upstream hop.
///
/// This is the query-bearing resolve shape -- the `refresh` flag becomes part
/// of the upstream route path, not a separate field -- which is why
/// `CoreReadTarget::route_path` is an owned `String` rather than a `&'static
/// str`.
pub fn resolve_usage_request(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Result<crate::daemon::runtime::CoreReadTarget, DaemonRouteResponse> {
    let project = required_param(route_url, body, "project")?;
    let mut route_path = project_routes::USAGE.to_owned();
    if route_url.search_param("refresh") == Some("1") {
        route_path.push_str("?refresh=1");
    }
    Ok(crate::daemon::runtime::CoreReadTarget {
        project,
        route_path,
    })
}

/// Phase three of `aimux usage`, from a raw project-service result.
pub fn render_usage_result(
    route_url: &DaemonRouteUrl,
    result: ProjectServiceJsonResult,
) -> DaemonRouteResponse {
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    if json.get("ok").and_then(Value::as_bool) == Some(false) {
        let mut response = if route_url.search_param("json") == Some("1") {
            text_or_json_lines(route_url, json, &[])
        } else {
            text_error(
                502,
                json.get("error")
                    .and_then(Value::as_str)
                    .filter(|error| !error.trim().is_empty())
                    .unwrap_or("Error: project service usage collection failed"),
            )
        };
        response.status = 502;
        return response;
    }
    let values = match required_project_service_array(&json, "usage", "displayLines") {
        Ok(values) => values,
        Err(response) => return response,
    };
    let lines = values.iter().map(Value::as_str).collect::<Option<Vec<_>>>();
    let Some(lines) =
        lines.filter(|lines| !lines.is_empty() && lines.iter().any(|line| !line.trim().is_empty()))
    else {
        return text_error(
            502,
            "Error: project service returned invalid usage response: displayLines must contain text",
        );
    };
    let lines = lines.into_iter().map(str::to_owned).collect::<Vec<_>>();
    text_or_json_lines(route_url, json, &lines)
}

fn usage_text_route(
    runtime: &mut impl DaemonProjectContentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let crate::daemon::runtime::CoreReadTarget {
        project,
        route_path,
    } = match resolve_usage_request(route_url, body) {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    let result = runtime.get_project_service_json(&project, &route_path);
    // The locked path calls the SAME render the carve-out calls, so there is
    // one copy of these semantics rather than two that parity cannot tell
    // apart.
    render_usage_result(route_url, result)
}

/// Phase one of `aimux outline list`: everything decidable without the
/// project service, so the carve-out can resolve under the lock and release it
/// before the upstream hop.
pub fn resolve_outline_list_request(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Result<crate::daemon::runtime::CoreReadTarget, DaemonRouteResponse> {
    let project = required_param(route_url, body, "project")?;
    let mut route_path = project_routes::work_outline::LIST.to_owned();
    push_project_query(
        &mut route_path,
        "q",
        trimmed_string(route_url, body, "search"),
    );
    push_project_query(
        &mut route_path,
        "sessionId",
        trimmed_string(route_url, body, "session"),
    );
    push_project_query(
        &mut route_path,
        "worktreePath",
        trimmed_string(route_url, body, "worktree"),
    );
    push_project_query(
        &mut route_path,
        "status",
        trimmed_string(route_url, body, "status"),
    );
    push_project_query(
        &mut route_path,
        "limit",
        trimmed_string(route_url, body, "limit"),
    );
    push_project_query(
        &mut route_path,
        "entryId",
        trimmed_string(route_url, body, "entryId"),
    );
    Ok(crate::daemon::runtime::CoreReadTarget {
        project,
        route_path,
    })
}

fn outline_list_text_route(
    runtime: &mut impl DaemonProjectContentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let crate::daemon::runtime::CoreReadTarget {
        project,
        route_path,
    } = match resolve_outline_list_request(route_url, body) {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    let result = runtime.get_project_service_json(&project, &route_path);
    // The locked path calls the SAME render the carve-out calls.
    render_outline_list_result(route_url, result)
}

/// Phase three of `aimux outline list`, from a raw project-service result.
///
/// A single-entry request renders a different payload from a list request.
///
/// The `entryId` check reads the QUERY only, and the body half of the original
/// condition is gone rather than carried over: `daemon/server.rs` parses a
/// JSON body only for POST, and this route is GET-dispatched on both paths, so
/// `body.and_then(|b| b.get("entryId"))` could never be `Some` here. Keeping
/// it would have meant threading `Option<&Value>` through the shared render
/// signature and ten other routes to carry a value that is always `None` --
/// which I did first, and undid.
pub fn render_outline_list_result(
    route_url: &DaemonRouteUrl,
    result: ProjectServiceJsonResult,
) -> DaemonRouteResponse {
    let (json, project_root) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    if route_url.has_search_param("entryId") {
        let entry = json.get("entry").cloned().unwrap_or(Value::Null);
        let entries = if entry.is_null() {
            Vec::new()
        } else {
            vec![entry.clone()]
        };
        let payload = json!({ "ok": true, "projectRoot": project_root, "entry": entry });
        return text_or_json_lines(
            route_url,
            payload,
            &render_core_work_outline_entries_lines(&entries),
        );
    }
    let entries = match required_project_service_array(&json, "outline list", "entries") {
        Ok(entries) => entries,
        Err(response) => return response,
    };
    let payload = json!({ "ok": true, "projectRoot": project_root, "entries": entries });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_work_outline_entries_lines(
            payload["entries"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default(),
        ),
    )
}

fn outline_update_text_route(
    runtime: &mut impl DaemonProjectContentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let title = match required_param(route_url, body, "title") {
        Ok(title) => title,
        Err(response) => return response,
    };
    let summary = match required_param(route_url, body, "summary") {
        Ok(summary) => summary,
        Err(response) => return response,
    };
    let mut request = Map::new();
    request.insert("title".into(), Value::String(title));
    request.insert("summary".into(), Value::String(summary));
    insert_string_if_some(
        &mut request,
        "topicKey",
        trimmed_string(route_url, body, "topicKey"),
    );
    insert_string_if_some(
        &mut request,
        "sessionId",
        trimmed_string(route_url, body, "sessionId"),
    );
    insert_string_if_some(
        &mut request,
        "worktreePath",
        trimmed_string(route_url, body, "worktreePath"),
    );
    insert_string_if_some(
        &mut request,
        "status",
        trimmed_string(route_url, body, "status"),
    );
    insert_string_if_some(
        &mut request,
        "source",
        trimmed_string(route_url, body, "source"),
    );
    let (json, project_root) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        project_routes::work_outline::UPDATE,
        Value::Object(request),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let entry = match required_project_service_object(&json, "outline update", "entry") {
        Ok(entry) => entry,
        Err(response) => return response,
    };
    let payload = json!({ "ok": true, "projectRoot": project_root, "entry": entry });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_work_outline_entries_lines(&[payload["entry"].clone()]),
    )
}

fn attachment_publish_text_route(
    runtime: &mut impl DaemonProjectContentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let path = match required_param(route_url, body, "path") {
        Ok(path) => path,
        Err(response) => return response,
    };
    let session_id = match required_param(route_url, body, "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let source_path = std::path::Path::new(&path);
    let filename = trimmed_string(route_url, body, "filename")
        .unwrap_or_else(|| filename_for_published_attachment(source_path));
    let mime_type = trimmed_string(route_url, body, "mimeType")
        .unwrap_or_else(|| mime_type_for_published_attachment(source_path).to_owned());
    let hosting = runtime.host_published_attachment(&PublishedAttachmentHostInput {
        source_path,
        filename: &filename,
        mime_type: &mime_type,
        session_id: &session_id,
    });
    let mut request = Map::new();
    request.insert("path".into(), Value::String(path));
    request.insert("sessionId".into(), Value::String(session_id));
    insert_string_if_some(&mut request, "filename", Some(filename));
    insert_string_if_some(&mut request, "mimeType", Some(mime_type));
    if let AttachmentHostingResult::Hosted(hosted) = &hosting {
        request.insert("hostedAttachment".into(), hosted.to_publish_json());
    }
    let (json, _) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        project_routes::ATTACHMENTS_PUBLISH,
        Value::Object(request),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let mut json = json;
    if let AttachmentHostingResult::LocalOnly { warning } = &hosting
        && let Some(object) = json.as_object_mut()
    {
        object.insert(
            "hosting".to_owned(),
            json!({
                "status": "localOnly",
                "warning": warning,
            }),
        );
    }
    let reference_text =
        match required_project_service_string(&json, "attachment publish", "referenceText") {
            Ok(reference_text) => reference_text,
            Err(response) => return response,
        };
    let mut lines = vec![reference_text];
    if let AttachmentHostingResult::LocalOnly { warning } = hosting {
        lines.push(format!(
            "aimux: warning: attachment published local-only: {warning}"
        ));
    }
    text_or_json_lines(route_url, json, &lines)
}

fn push_project_query(path: &mut String, name: &str, value: Option<String>) {
    let Some(value) = value else {
        return;
    };
    if path.contains('?') {
        path.push('&');
    } else {
        path.push('?');
    }
    path.push_str(name);
    path.push('=');
    path.push_str(&url_encode(&value));
}

fn trimmed_string(route_url: &DaemonRouteUrl, body: Option<&Value>, name: &str) -> Option<String> {
    string_param(route_url, body, name)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn insert_string_if_some(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn url_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}
