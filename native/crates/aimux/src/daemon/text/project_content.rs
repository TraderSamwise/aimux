use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::render_core_work_outline_entries_lines;
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, required_param, string_param, text_or_json_lines,
};
use crate::daemon::text::params::{
    ProjectServiceJsonResult, required_project_service_array, required_project_service_object,
    required_project_service_string,
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
}

pub fn route_project_content_text_request(
    runtime: &mut impl DaemonProjectContentTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

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

fn outline_list_text_route(
    runtime: &mut impl DaemonProjectContentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let mut route_path = project_routes::work_outline::LIST.to_owned();
    push_project_query(
        &mut route_path,
        "entryId",
        trimmed_string(route_url, body, "entryId"),
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
        "q",
        trimmed_string(route_url, body, "search"),
    );
    push_project_query(
        &mut route_path,
        "limit",
        trimmed_string(route_url, body, "limit"),
    );
    let (json, project_root) =
        match unwrap_project_result(runtime.get_project_service_json(&project, &route_path)) {
            Ok(result) => result,
            Err(response) => return response,
        };
    if route_url.has_search_param("entryId") || body.and_then(|body| body.get("entryId")).is_some()
    {
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
    let mut request = Map::new();
    request.insert("path".into(), Value::String(path));
    request.insert("sessionId".into(), Value::String(session_id));
    insert_string_if_some(
        &mut request,
        "filename",
        trimmed_string(route_url, body, "filename"),
    );
    insert_string_if_some(
        &mut request,
        "mimeType",
        trimmed_string(route_url, body, "mimeType"),
    );
    let (json, _) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        project_routes::ATTACHMENTS_PUBLISH,
        Value::Object(request),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let reference_text =
        match required_project_service_string(&json, "attachment publish", "referenceText") {
            Ok(reference_text) => reference_text,
            Err(response) => return response,
        };
    text_or_json_lines(route_url, json, &[reference_text])
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

fn unwrap_project_result(
    result: ProjectServiceJsonResult,
) -> Result<(Value, String), DaemonRouteResponse> {
    match result {
        ProjectServiceJsonResult::Ok { project_root, json } => Ok((json, project_root)),
        ProjectServiceJsonResult::Err { response } => Err(response),
    }
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
