use serde_json::{Map, Value, json};

use crate::project_api_contract::routes;
use crate::project_service_manifest::get_project_service_manifest;

use super::desktop_state::desktop_state_for_context;
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::notifications::{NotificationQuery, try_list_notification_snapshot};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{runtime_exchange_path, try_read_runtime_exchange};

const DEFAULT_PROJECT_LIST_LIMIT: usize = 200;
const DEFAULT_STORY_LIMIT: usize = 30;

pub fn route_project_observability_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET")
        || project_service_pathname(path) != routes::PROJECT_OBSERVABILITY
    {
        return None;
    }
    let state = match desktop_state_for_context(context) {
        Ok(state) => state,
        Err(error) => return Some(json_response(500, json!({ "ok": false, "error": error }))),
    };
    let notification_snapshot = match try_list_notification_snapshot(
        context.project_state_dir(),
        NotificationQuery {
            limit: Some(DEFAULT_PROJECT_LIST_LIMIT),
            ..NotificationQuery::default()
        },
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => return Some(json_response(500, json!({ "ok": false, "error": error }))),
    };
    let exchange =
        match try_read_runtime_exchange(runtime_exchange_path(context.project_state_dir())) {
            Ok(exchange) => exchange,
            Err(error) => return Some(json_response(500, json!({ "ok": false, "error": error }))),
        };
    let mut sessions = array_field(&state, "sessions").to_vec();
    sessions.extend_from_slice(array_field(&state, "teammates"));
    let service_info = get_project_service_manifest()
        .ok()
        .and_then(|manifest| serde_json::to_value(manifest).ok())
        .unwrap_or_else(|| json!({}));
    Some(json_response(
        200,
        json!({
            "ok": true,
            "serviceInfo": service_info,
            "project": build_project_observability(ProjectObservabilityInput {
                sessions,
                services: array_field(&state, "services").to_vec(),
                worktrees: array_field(&state, "worktrees").to_vec(),
                tasks: array_field(&exchange, "tasks").to_vec(),
                notifications: notification_snapshot.notifications,
                notification_unread_count: Some(notification_snapshot.unread_count),
                story_limit: None,
            }),
        }),
    ))
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectObservabilityInput {
    pub sessions: Vec<Value>,
    pub services: Vec<Value>,
    pub worktrees: Vec<Value>,
    pub tasks: Vec<Value>,
    pub notifications: Vec<Value>,
    pub notification_unread_count: Option<usize>,
    pub story_limit: Option<usize>,
}

pub fn build_project_observability(input: ProjectObservabilityInput) -> Value {
    let summary = json!({
        "agentsRunning": input.sessions.iter().filter(|session| is_running_agent(string_field(session, "status"))).count(),
        "agentsWaiting": input.sessions.iter().filter(|session| string_field(session, "status") == Some("waiting")).count(),
        "agentsOffline": input.sessions.iter().filter(|session| matches!(string_field(session, "status"), Some("offline" | "exited"))).count(),
        "services": input.services.len(),
        "worktrees": input.worktrees.len(),
        "openTasks": input.tasks.iter().filter(|task| is_open_task(string_field(task, "status"))).count(),
        "doneTasks": input.tasks.iter().filter(|task| string_field(task, "status") == Some("done")).count(),
        "unreadNotifications": input.notification_unread_count.unwrap_or_else(|| {
            input.notifications.iter().filter(|notification| bool_field(notification, "unread")).count()
        }),
    });
    let progress = json!({
        "pending": count_tasks_by_status(&input.tasks, "pending"),
        "assigned": count_tasks_by_status(&input.tasks, "assigned"),
        "in_progress": count_tasks_by_status(&input.tasks, "in_progress"),
        "blocked": count_tasks_by_status(&input.tasks, "blocked"),
        "canceled": count_tasks_by_status(&input.tasks, "canceled"),
        "done": count_tasks_by_status(&input.tasks, "done"),
        "failed": count_tasks_by_status(&input.tasks, "failed"),
        "total": input.tasks.len(),
    });
    let mut story = input
        .tasks
        .iter()
        .map(task_story_item)
        .chain(input.notifications.iter().map(notification_story_item))
        .collect::<Vec<_>>();
    story.sort_by(|left, right| {
        string_field(right, "createdAt")
            .unwrap_or("")
            .cmp(string_field(left, "createdAt").unwrap_or(""))
    });
    story.truncate(input.story_limit.unwrap_or(DEFAULT_STORY_LIMIT));
    json!({
        "summary": summary,
        "progress": progress,
        "story": story,
    })
}

fn task_story_item(task: &Value) -> Value {
    let mut item = Map::new();
    item.insert(
        "id".into(),
        Value::String(format!("task:{}", string_field(task, "id").unwrap_or(""))),
    );
    item.insert(
        "kind".into(),
        Value::String(
            if string_field(task, "type") == Some("review") {
                "review"
            } else {
                "task"
            }
            .into(),
        ),
    );
    item.insert(
        "title".into(),
        Value::String(
            string_field(task, "description")
                .filter(|value| !value.is_empty())
                .or_else(|| string_field(task, "prompt").filter(|value| !value.is_empty()))
                .or_else(|| string_field(task, "id"))
                .unwrap_or("")
                .to_owned(),
        ),
    );
    let mut meta = string_field(task, "status").unwrap_or("").to_owned();
    if let Some(assigned_to) = string_field(task, "assignedTo")
        && !assigned_to.is_empty()
    {
        meta.push_str(" \u{00b7} ");
        meta.push_str(assigned_to);
    }
    item.insert("meta".into(), Value::String(meta));
    insert_optional_string(
        &mut item,
        "body",
        string_field(task, "result")
            .filter(|value| !value.is_empty())
            .or_else(|| string_field(task, "error").filter(|value| !value.is_empty()))
            .or_else(|| string_field(task, "prompt")),
    );
    item.insert(
        "createdAt".into(),
        Value::String(
            string_field(task, "updatedAt")
                .or_else(|| string_field(task, "createdAt"))
                .unwrap_or("")
                .to_owned(),
        ),
    );
    insert_optional_string(&mut item, "status", string_field(task, "status"));
    Value::Object(item)
}

fn notification_story_item(notification: &Value) -> Value {
    let mut item = Map::new();
    item.insert(
        "id".into(),
        Value::String(format!(
            "notif:{}",
            string_field(notification, "id").unwrap_or("")
        )),
    );
    item.insert("kind".into(), Value::String("notification".into()));
    item.insert(
        "title".into(),
        Value::String(string_field(notification, "title").unwrap_or("").to_owned()),
    );
    let mut meta = string_field(notification, "kind")
        .unwrap_or("note")
        .to_owned();
    if let Some(session_id) = string_field(notification, "sessionId")
        && !session_id.is_empty()
    {
        meta.push_str(" \u{00b7} ");
        meta.push_str(session_id);
    }
    item.insert("meta".into(), Value::String(meta));
    insert_optional_string(&mut item, "body", string_field(notification, "body"));
    item.insert(
        "createdAt".into(),
        Value::String(
            string_field(notification, "createdAt")
                .unwrap_or("")
                .to_owned(),
        ),
    );
    item.insert(
        "status".into(),
        Value::String(
            if bool_field(notification, "unread") {
                "unread"
            } else {
                "read"
            }
            .into(),
        ),
    );
    Value::Object(item)
}

fn is_open_task(status: Option<&str>) -> bool {
    !matches!(
        status,
        Some("done" | "failed" | "canceled" | "cancelled" | "abandoned")
    )
}

fn is_running_agent(status: Option<&str>) -> bool {
    matches!(status, Some("running" | "idle" | "ready"))
}

fn count_tasks_by_status(tasks: &[Value], status: &str) -> usize {
    tasks
        .iter()
        .filter(|task| string_field(task, "status") == Some(status))
        .count()
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value.to_owned()));
    }
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
