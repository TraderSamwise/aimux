use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{
    render_core_notification_clear_lines, render_core_notification_read_lines,
    render_core_notification_send_lines, render_core_notifications_list_lines,
};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, boolean_param, notification_mutation_payload,
    required_param, string_param, text_or_json_lines,
};
use crate::daemon::text::params::{ProjectServiceJsonResult, required_project_service_array};
use crate::daemon::text::worktrees::CLI_PROJECT_MUTATION_TIMEOUT_MS;
use crate::project_api_contract::routes as project_routes;
use serde_json::{Map, Value, json};

pub trait DaemonNotificationTextRuntime {
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

pub fn route_notification_text_request(
    runtime: &mut impl DaemonNotificationTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET" && pathname == CORE_API_ROUTES.notification_list_text {
        return Some(notification_list_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.notification_send_text {
        return Some(notification_send_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.notification_read_text {
        return Some(notification_mutation_text_route(
            runtime,
            &route_url,
            body,
            NotificationMutationInput {
                route_path: project_routes::notifications::READ,
                response_field: "updated",
                render: render_core_notification_read_lines,
            },
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.notification_clear_text {
        return Some(notification_mutation_text_route(
            runtime,
            &route_url,
            body,
            NotificationMutationInput {
                route_path: project_routes::notifications::CLEAR,
                response_field: "cleared",
                render: render_core_notification_clear_lines,
            },
        ));
    }

    None
}

pub fn notification_list_text_route(
    runtime: &mut impl DaemonNotificationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let mut query = Vec::new();
    if boolean_param(route_url, body, "unread", false) {
        query.push("unread=1".to_owned());
    }
    if let Some(session_id) = trimmed_string(route_url, body, "sessionId") {
        query.push(format!("sessionId={}", url_encode(&session_id)));
    }
    let route_path = if query.is_empty() {
        project_routes::notifications::LIST.to_owned()
    } else {
        format!(
            "{}?{}",
            project_routes::notifications::LIST,
            query.join("&")
        )
    };
    let (json, _) =
        match unwrap_project_result(runtime.get_project_service_json(&project, &route_path)) {
            Ok(result) => result,
            Err(response) => return response,
        };
    let notifications =
        match required_project_service_array(&json, "notifications list", "notifications") {
            Ok(notifications) => notifications,
            Err(response) => return response,
        };
    let unread_count = json
        .get("unreadCount")
        .filter(|value| value.is_number())
        .cloned()
        .unwrap_or_else(|| json!(0));
    let payload = json!({ "notifications": notifications, "unreadCount": unread_count });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_notifications_list_lines(&payload),
    )
}

pub fn notification_send_text_route(
    runtime: &mut impl DaemonNotificationTextRuntime,
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
    let title_trimmed = title.trim().to_owned();
    let message = trimmed_string(route_url, body, "body").unwrap_or_else(|| title_trimmed.clone());
    let mut request = Map::new();
    request.insert("title".into(), Value::String(title_trimmed.clone()));
    insert_string_if_some(
        &mut request,
        "subtitle",
        trimmed_string(route_url, body, "subtitle"),
    );
    request.insert("message".into(), Value::String(message));
    insert_string_if_some(
        &mut request,
        "sessionId",
        trimmed_string(route_url, body, "sessionId"),
    );
    request.insert(
        "kind".into(),
        Value::String(
            trimmed_string(route_url, body, "kind").unwrap_or_else(|| "notification".into()),
        ),
    );
    request.insert("force".into(), Value::Bool(true));
    let result = runtime.post_project_service_json(
        &project,
        project_routes::runtime::NOTIFY,
        Value::Object(request),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    if let Err(response) = unwrap_project_result(result) {
        return response;
    }
    let payload = json!({ "title": title_trimmed });
    text_or_json_lines(
        route_url,
        json!({ "ok": true }),
        &render_core_notification_send_lines(&payload),
    )
}

pub fn notification_mutation_text_route(
    runtime: &mut impl DaemonNotificationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    input: NotificationMutationInput,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let request = match notification_mutation_payload(route_url, body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let (json, _) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        input.route_path,
        request,
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let value = json
        .get(input.response_field)
        .filter(|value| value.is_number())
        .cloned()
        .unwrap_or_else(|| json!(0));
    let payload = json!({ "ok": true, input.response_field: value });
    text_or_json_lines(route_url, payload.clone(), &(input.render)(&payload))
}

#[derive(Debug, Clone, Copy)]
pub struct NotificationMutationInput {
    route_path: &'static str,
    response_field: &'static str,
    render: fn(&Value) -> Vec<String>,
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
