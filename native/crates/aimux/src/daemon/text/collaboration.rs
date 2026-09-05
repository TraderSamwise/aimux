use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{
    render_core_handoff_mutation_lines, render_core_handoff_send_lines,
    render_core_message_send_lines, render_core_review_request_changes_lines,
    render_core_task_list_lines, render_core_task_mutation_lines, render_core_task_show_lines,
    render_core_thread_list_lines, render_core_thread_mark_seen_lines,
    render_core_thread_open_lines, render_core_thread_send_lines, render_core_thread_show_lines,
    render_core_thread_status_lines,
};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, csv_param, required_param, string_param, text_error,
    text_or_json_lines,
};
use crate::daemon::text::params::{
    ProjectServiceJsonResult, required_project_service_array, required_project_service_object,
};
use crate::daemon::text::worktrees::CLI_PROJECT_MUTATION_TIMEOUT_MS;
use crate::project_api_contract::routes as project_routes;
use serde_json::{Map, Value, json};

pub trait DaemonCollaborationTextRuntime {
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

pub fn route_collaboration_text_request(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET"
        && (pathname == CORE_API_ROUTES.threads_list_text
            || pathname == CORE_API_ROUTES.thread_list_text)
    {
        return Some(thread_list_text_route(runtime, &route_url, body));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.thread_show_text {
        return Some(thread_show_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.thread_open_text {
        return Some(thread_open_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.thread_send_text {
        return Some(thread_send_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.thread_mark_seen_text {
        return Some(thread_mark_seen_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.thread_status_text {
        return Some(thread_status_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.message_send_text {
        return Some(message_send_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.handoff_send_text {
        return Some(handoff_send_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.handoff_accept_text {
        return Some(handoff_mutation_text_route(
            runtime,
            &route_url,
            body,
            handoff_accept_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.handoff_complete_text {
        return Some(handoff_mutation_text_route(
            runtime,
            &route_url,
            body,
            handoff_complete_input(),
        ));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.task_list_text {
        return Some(task_list_text_route(runtime, &route_url, body));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.task_show_text {
        return Some(task_show_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.task_assign_text {
        return Some(task_assign_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.task_accept_text {
        return Some(task_mutation_text_route(
            runtime,
            &route_url,
            body,
            task_accept_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.task_block_text {
        return Some(task_mutation_text_route(
            runtime,
            &route_url,
            body,
            task_block_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.task_complete_text {
        return Some(task_mutation_text_route(
            runtime,
            &route_url,
            body,
            task_complete_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.task_reopen_text {
        return Some(task_mutation_text_route(
            runtime,
            &route_url,
            body,
            task_reopen_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.review_approve_text {
        return Some(task_mutation_text_route(
            runtime,
            &route_url,
            body,
            review_approve_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.review_request_changes_text {
        return Some(review_request_changes_text_route(runtime, &route_url, body));
    }

    None
}

pub fn thread_list_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let session = trimmed_param(route_url, body, "session");
    let route_path = session
        .map(|session| {
            format!(
                "{}?session={}",
                project_routes::threads::LIST,
                url_encode(&session)
            )
        })
        .unwrap_or_else(|| project_routes::threads::LIST.to_owned());
    let (json, _) =
        match unwrap_project_result(runtime.get_project_service_json(&project, &route_path)) {
            Ok(result) => result,
            Err(response) => return response,
        };
    if !json.is_array() {
        return text_error(
            502,
            "Error: project service returned invalid thread list response",
        );
    }
    let payload = json!({ "summaries": json.clone() });
    text_or_json_lines(route_url, json, &render_core_thread_list_lines(&payload))
}

pub fn thread_show_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let thread_id = match required_param(route_url, body, "threadId") {
        Ok(thread_id) => thread_id,
        Err(response) => return response,
    };
    let route_path = format!(
        "{}/{}",
        project_routes::threads::LIST,
        url_encode(&thread_id)
    );
    let (json, _) =
        match unwrap_project_result(runtime.get_project_service_json(&project, &route_path)) {
            Ok(result) => result,
            Err(response) if response.status == 404 => {
                return text_error(404, format!("aimux: thread not found: {thread_id}"));
            }
            Err(response) => return response,
        };
    let thread = match required_project_service_object(&json, "thread show", "thread") {
        Ok(thread) => thread,
        Err(response) => return response,
    };
    if !thread.get("id").is_some_and(Value::is_string) {
        return text_error(
            502,
            "Error: project service returned invalid thread show response: thread.id is required",
        );
    }
    let messages = match required_project_service_array(&json, "thread show", "messages") {
        Ok(messages) => messages,
        Err(response) => return response,
    };
    let payload = json!({ "thread": thread, "messages": messages });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_thread_show_lines(&payload),
    )
}

pub fn thread_open_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
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
    let from = match required_param(route_url, body, "from") {
        Ok(from) => from,
        Err(response) => return response,
    };
    let Some(participants) =
        csv_param(route_url, body, "participants").filter(|items| !items.is_empty())
    else {
        return text_error(400, "participants is required");
    };
    let kind = optional_string(route_url, body, "kind").unwrap_or_else(|| "conversation".into());
    let result = runtime.post_project_service_json(
        &project,
        project_routes::threads::OPEN,
        json!({ "title": title, "from": from, "participants": participants, "kind": kind }),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let thread = match required_project_service_object(&json, "thread open", "thread") {
        Ok(thread) => thread,
        Err(response) => return response,
    };
    if !thread.get("id").is_some_and(Value::is_string) {
        return text_error(
            502,
            "Error: project service returned invalid thread open response: thread.id is required",
        );
    }
    let payload = json!({ "thread": thread });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_thread_open_lines(&payload),
    )
}

pub fn thread_send_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let thread_id = match required_param(route_url, body, "threadId") {
        Ok(thread_id) => thread_id,
        Err(response) => return response,
    };
    let message_body = match required_param(route_url, body, "body") {
        Ok(body) => body,
        Err(response) => return response,
    };
    let from = match required_param(route_url, body, "from") {
        Ok(from) => from,
        Err(response) => return response,
    };
    let to = csv_param(route_url, body, "to");
    let kind = optional_string(route_url, body, "kind").unwrap_or_else(|| "note".into());
    let mut payload = Map::new();
    payload.insert("threadId".into(), Value::String(thread_id));
    payload.insert("from".into(), Value::String(from));
    insert_array_if_some(&mut payload, "to", to);
    payload.insert("kind".into(), Value::String(kind));
    payload.insert("body".into(), Value::String(message_body));
    let result = runtime.post_project_service_json(
        &project,
        project_routes::threads::SEND,
        Value::Object(payload),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let message = match required_project_service_object(&json, "thread send", "message") {
        Ok(message) => message,
        Err(response) => return response,
    };
    if !message.get("id").is_some_and(Value::is_string) {
        return text_error(
            502,
            "Error: project service returned invalid thread send response: message.id is required",
        );
    }
    let payload = json!({ "message": message });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_thread_send_lines(&payload),
    )
}

pub fn thread_mark_seen_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let thread_id = match required_param(route_url, body, "threadId") {
        Ok(thread_id) => thread_id,
        Err(response) => return response,
    };
    let session = match required_param(route_url, body, "session") {
        Ok(session) => session,
        Err(response) => return response,
    };
    let result = runtime.post_project_service_json(
        &project,
        project_routes::threads::MARK_SEEN,
        json!({ "threadId": thread_id, "session": session }),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    text_or_json_lines(route_url, json, &render_core_thread_mark_seen_lines())
}

pub fn thread_status_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let thread_id = match required_param(route_url, body, "threadId") {
        Ok(thread_id) => thread_id,
        Err(response) => return response,
    };
    let status = match required_param(route_url, body, "status") {
        Ok(status) => status,
        Err(response) => return response,
    };
    let mut payload = Map::new();
    payload.insert("threadId".into(), Value::String(thread_id));
    payload.insert("status".into(), Value::String(status));
    insert_string_if_some(
        &mut payload,
        "owner",
        optional_string(route_url, body, "owner"),
    );
    insert_array_if_some(
        &mut payload,
        "waitingOn",
        csv_param(route_url, body, "waitingOn"),
    );
    let result = runtime.post_project_service_json(
        &project,
        project_routes::threads::STATUS,
        Value::Object(payload),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let thread = match required_project_service_object(&json, "thread status", "thread") {
        Ok(thread) => thread,
        Err(response) => return response,
    };
    if !thread.get("id").is_some_and(Value::is_string)
        || !thread.get("status").is_some_and(Value::is_string)
    {
        return text_error(
            502,
            "Error: project service returned invalid thread status response: thread.id and thread.status are required",
        );
    }
    let payload = json!({ "thread": thread });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_thread_status_lines(&payload),
    )
}

pub fn message_send_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let message_body = match required_param(route_url, body, "body") {
        Ok(body) => body,
        Err(response) => return response,
    };
    let to = csv_param(route_url, body, "to");
    let assignee = optional_string(route_url, body, "assignee");
    let tool = optional_string(route_url, body, "tool");
    let thread_id = optional_string(route_url, body, "thread");
    if to.as_ref().is_none_or(Vec::is_empty)
        && thread_id.is_none()
        && assignee.is_none()
        && tool.is_none()
    {
        return text_error(
            400,
            "aimux: message send requires --to, --assignee, or --tool",
        );
    }
    let mut payload = Map::new();
    insert_string_if_some(&mut payload, "threadId", thread_id);
    payload.insert(
        "from".into(),
        Value::String(optional_string(route_url, body, "from").unwrap_or_else(|| "user".into())),
    );
    insert_array_if_some(&mut payload, "to", to);
    insert_string_if_some(&mut payload, "assignee", assignee);
    insert_string_if_some(&mut payload, "tool", tool);
    insert_string_if_some(
        &mut payload,
        "worktreePath",
        optional_string(route_url, body, "worktree"),
    );
    payload.insert(
        "kind".into(),
        Value::String(optional_string(route_url, body, "kind").unwrap_or_else(|| "request".into())),
    );
    payload.insert("body".into(), Value::String(message_body));
    insert_string_if_some(
        &mut payload,
        "title",
        optional_string(route_url, body, "title"),
    );
    let result = runtime.post_project_service_json(
        &project,
        project_routes::threads::SEND,
        Value::Object(payload),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    message_send_response(
        route_url,
        json,
        "message send",
        render_core_message_send_lines,
    )
}

pub fn handoff_send_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let message_body = match required_param(route_url, body, "body") {
        Ok(body) => body,
        Err(response) => return response,
    };
    let to = csv_param(route_url, body, "to");
    let assignee = optional_string(route_url, body, "assignee");
    let tool = optional_string(route_url, body, "tool");
    if to.as_ref().is_none_or(Vec::is_empty) && assignee.is_none() && tool.is_none() {
        return text_error(
            400,
            "aimux: handoff send requires --to, --assignee, or --tool",
        );
    }
    let mut payload = Map::new();
    payload.insert(
        "from".into(),
        Value::String(optional_string(route_url, body, "from").unwrap_or_else(|| "user".into())),
    );
    insert_array_if_some(&mut payload, "to", to);
    insert_string_if_some(&mut payload, "assignee", assignee);
    insert_string_if_some(&mut payload, "tool", tool);
    payload.insert("body".into(), Value::String(message_body));
    insert_string_if_some(
        &mut payload,
        "title",
        optional_string(route_url, body, "title"),
    );
    insert_string_if_some(
        &mut payload,
        "worktreePath",
        optional_string(route_url, body, "worktree"),
    );
    let result = runtime.post_project_service_json(
        &project,
        project_routes::handoff::SEND,
        Value::Object(payload),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    message_send_response(
        route_url,
        json,
        "handoff send",
        render_core_handoff_send_lines,
    )
}

pub fn handoff_mutation_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    input: HandoffMutationInput,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let thread_id = match required_param(route_url, body, "threadId") {
        Ok(thread_id) => thread_id,
        Err(response) => return response,
    };
    let mut payload = Map::new();
    payload.insert("threadId".into(), Value::String(thread_id));
    payload.insert(
        "from".into(),
        Value::String(optional_string(route_url, body, "from").unwrap_or_else(|| "user".into())),
    );
    insert_string_if_some(
        &mut payload,
        "body",
        optional_string(route_url, body, "body"),
    );
    let result = runtime.post_project_service_json(
        &project,
        input.route_path,
        Value::Object(payload),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    handoff_mutation_response(route_url, json, input.action)
}

pub fn task_list_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let mut query = Vec::new();
    if let Some(session) = trimmed_param(route_url, body, "session") {
        query.push(format!("session={}", url_encode(&session)));
    }
    if let Some(status) = trimmed_param(route_url, body, "status") {
        query.push(format!("status={}", url_encode(&status)));
    }
    let route_path = if query.is_empty() {
        project_routes::tasks::LIST.to_owned()
    } else {
        format!("{}?{}", project_routes::tasks::LIST, query.join("&"))
    };
    let (json, _) =
        match unwrap_project_result(runtime.get_project_service_json(&project, &route_path)) {
            Ok(result) => result,
            Err(response) => return response,
        };
    let tasks = match required_project_service_array(&json, "task list", "tasks") {
        Ok(tasks) => tasks,
        Err(response) => return response,
    };
    let payload = json!({ "tasks": tasks });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_task_list_lines(&payload),
    )
}

pub fn task_show_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let task_id = match required_param(route_url, body, "taskId") {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let route_path = format!("{}/{}", project_routes::tasks::LIST, url_encode(&task_id));
    let (json, _) =
        match unwrap_project_result(runtime.get_project_service_json(&project, &route_path)) {
            Ok(result) => result,
            Err(response) if response.status == 404 => {
                return text_error(404, format!("aimux: task not found: {task_id}"));
            }
            Err(response) => return response,
        };
    let task = match required_project_service_object(&json, "task show", "task") {
        Ok(task) => task,
        Err(response) => return response,
    };
    if !task.get("id").is_some_and(Value::is_string) {
        return text_error(
            502,
            "Error: project service returned invalid task show response: task.id is required",
        );
    }
    let messages = match required_project_service_array(&json, "task show", "messages") {
        Ok(messages) => messages,
        Err(response) => return response,
    };
    let payload = json!({ "task": task, "thread": json.get("thread").cloned().unwrap_or(Value::Null), "messages": messages });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_task_show_lines(&payload),
    )
}

pub fn task_assign_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let description = match required_param(route_url, body, "description") {
        Ok(description) => description,
        Err(response) => return response,
    };
    let mut payload = Map::new();
    payload.insert(
        "from".into(),
        Value::String(optional_string(route_url, body, "from").unwrap_or_else(|| "user".into())),
    );
    insert_string_if_some(&mut payload, "to", optional_string(route_url, body, "to"));
    insert_string_if_some(
        &mut payload,
        "assignee",
        optional_string(route_url, body, "assignee"),
    );
    insert_string_if_some(
        &mut payload,
        "tool",
        optional_string(route_url, body, "tool"),
    );
    payload.insert("description".into(), Value::String(description));
    insert_string_if_some(
        &mut payload,
        "prompt",
        optional_string(route_url, body, "prompt"),
    );
    payload.insert(
        "type".into(),
        Value::String(optional_string(route_url, body, "type").unwrap_or_else(|| "task".into())),
    );
    insert_string_if_some(
        &mut payload,
        "diff",
        optional_string(route_url, body, "diff"),
    );
    insert_string_if_some(
        &mut payload,
        "worktreePath",
        optional_string(route_url, body, "worktree"),
    );
    let result = runtime.post_project_service_json(
        &project,
        project_routes::tasks::ASSIGN,
        Value::Object(payload),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    task_mutation_response(
        route_url,
        json,
        "task assign",
        render_core_task_mutation_lines,
    )
}

pub fn task_mutation_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    input: TaskMutationInput,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let task_id = match required_param(route_url, body, "taskId") {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let body_text = optional_string(route_url, body, "body").or_else(|| {
        (input.action == "task complete")
            .then(|| optional_string(route_url, body, "result"))
            .flatten()
    });
    let mut payload = Map::new();
    payload.insert("taskId".into(), Value::String(task_id));
    payload.insert(
        "from".into(),
        Value::String(optional_string(route_url, body, "from").unwrap_or_else(|| "user".into())),
    );
    insert_string_if_some(&mut payload, "body", body_text);
    let result = runtime.post_project_service_json(
        &project,
        input.route_path,
        Value::Object(payload),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    task_mutation_response(
        route_url,
        json,
        input.action,
        render_core_task_mutation_lines,
    )
}

pub fn review_request_changes_text_route(
    runtime: &mut impl DaemonCollaborationTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let task_id = match required_param(route_url, body, "taskId") {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let mut payload = Map::new();
    payload.insert("taskId".into(), Value::String(task_id));
    payload.insert(
        "from".into(),
        Value::String(optional_string(route_url, body, "from").unwrap_or_else(|| "user".into())),
    );
    insert_string_if_some(
        &mut payload,
        "body",
        optional_string(route_url, body, "body"),
    );
    let result = runtime.post_project_service_json(
        &project,
        project_routes::reviews::REQUEST_CHANGES,
        Value::Object(payload),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    task_mutation_response(
        route_url,
        json,
        "review request changes",
        render_core_review_request_changes_lines,
    )
}

#[derive(Debug, Clone, Copy)]
pub struct HandoffMutationInput {
    action: &'static str,
    route_path: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct TaskMutationInput {
    action: &'static str,
    route_path: &'static str,
}

fn handoff_accept_input() -> HandoffMutationInput {
    HandoffMutationInput {
        action: "handoff accept",
        route_path: project_routes::handoff::ACCEPT,
    }
}

fn handoff_complete_input() -> HandoffMutationInput {
    HandoffMutationInput {
        action: "handoff complete",
        route_path: project_routes::handoff::COMPLETE,
    }
}

fn task_accept_input() -> TaskMutationInput {
    TaskMutationInput {
        action: "task accept",
        route_path: project_routes::tasks::ACCEPT,
    }
}

fn task_block_input() -> TaskMutationInput {
    TaskMutationInput {
        action: "task block",
        route_path: project_routes::tasks::BLOCK,
    }
}

fn task_complete_input() -> TaskMutationInput {
    TaskMutationInput {
        action: "task complete",
        route_path: project_routes::tasks::COMPLETE,
    }
}

fn task_reopen_input() -> TaskMutationInput {
    TaskMutationInput {
        action: "task reopen",
        route_path: project_routes::tasks::REOPEN,
    }
}

fn review_approve_input() -> TaskMutationInput {
    TaskMutationInput {
        action: "review approve",
        route_path: project_routes::reviews::APPROVE,
    }
}

fn message_send_response(
    route_url: &DaemonRouteUrl,
    json: Value,
    action: &str,
    render: fn(&Value) -> Vec<String>,
) -> DaemonRouteResponse {
    let thread = match required_project_service_object(&json, action, "thread") {
        Ok(thread) => thread,
        Err(response) => return response,
    };
    let message = match required_project_service_object(&json, action, "message") {
        Ok(message) => message,
        Err(response) => return response,
    };
    if action == "message send" {
        if !thread.get("id").is_some_and(Value::is_string) {
            return text_error(
                502,
                "Error: project service returned invalid message send response: thread.id is required",
            );
        }
        if !message.get("id").is_some_and(Value::is_string) {
            return text_error(
                502,
                "Error: project service returned invalid message send response: message.id is required",
            );
        }
    } else if !thread.get("id").is_some_and(Value::is_string)
        || !message.get("id").is_some_and(Value::is_string)
    {
        return text_error(
            502,
            format!(
                "Error: project service returned invalid {action} response: thread.id and message.id are required"
            ),
        );
    }
    let payload = json!({
        "thread": thread,
        "message": message,
        "deliveredTo": json.get("deliveredTo").cloned().unwrap_or(Value::Null),
    });
    let json_body = if action == "message send" {
        payload.clone()
    } else {
        json
    };
    text_or_json_lines(route_url, json_body, &render(&payload))
}

fn handoff_mutation_response(
    route_url: &DaemonRouteUrl,
    json: Value,
    action: &str,
) -> DaemonRouteResponse {
    let thread = match required_project_service_object(&json, action, "thread") {
        Ok(thread) => thread,
        Err(response) => return response,
    };
    let message = match required_project_service_object(&json, action, "message") {
        Ok(message) => message,
        Err(response) => return response,
    };
    if !thread.get("id").is_some_and(Value::is_string)
        || !message.get("id").is_some_and(Value::is_string)
    {
        return text_error(
            502,
            format!(
                "Error: project service returned invalid {action} response: thread.id and message.id are required"
            ),
        );
    }
    let payload = json!({ "thread": thread, "message": message });
    text_or_json_lines(
        route_url,
        json,
        &render_core_handoff_mutation_lines(&payload),
    )
}

fn task_mutation_response(
    route_url: &DaemonRouteUrl,
    json: Value,
    action: &str,
    render: fn(&Value) -> Vec<String>,
) -> DaemonRouteResponse {
    let task = match required_project_service_object(&json, action, "task") {
        Ok(task) => task,
        Err(response) => return response,
    };
    if !task.get("id").is_some_and(Value::is_string) {
        return text_error(
            502,
            format!(
                "Error: project service returned invalid {action} response: task.id is required"
            ),
        );
    }
    let mut payload = Map::new();
    payload.insert("task".into(), task);
    if let Some(thread) = json.get("thread").filter(|value| value.is_object()) {
        payload.insert("thread".into(), thread.clone());
    }
    if let Some(follow_up_task) = json.get("followUpTask").filter(|value| value.is_object()) {
        payload.insert("followUpTask".into(), follow_up_task.clone());
    }
    text_or_json_lines(route_url, json, &render(&Value::Object(payload)))
}

fn unwrap_project_result(
    result: ProjectServiceJsonResult,
) -> Result<(Value, String), DaemonRouteResponse> {
    match result {
        ProjectServiceJsonResult::Ok { project_root, json } => Ok((json, project_root)),
        ProjectServiceJsonResult::Err { response } => Err(response),
    }
}

fn optional_string(route_url: &DaemonRouteUrl, body: Option<&Value>, name: &str) -> Option<String> {
    string_param(route_url, body, name).filter(|value| !value.is_empty())
}

fn trimmed_param(route_url: &DaemonRouteUrl, body: Option<&Value>, name: &str) -> Option<String> {
    string_param(route_url, body, name)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn insert_string_if_some(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn insert_array_if_some(map: &mut Map<String, Value>, key: &str, value: Option<Vec<String>>) {
    if let Some(value) = value {
        map.insert(key.into(), json!(value));
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
