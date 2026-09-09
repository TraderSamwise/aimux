use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::config::load_config_for_project;
use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};

use super::agent_output::{AgentOutputCaptureRuntime, SystemAgentOutputCaptureRuntime};
use super::agents::{resolve_direct_teammates, topology_desktop_session_list};
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{runtime_exchange_path, update_runtime_exchange};
use super::team::load_team_config;

mod indexes;
pub(crate) use indexes::derive_runtime_exchange_indexes;

static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn route_coordination_mutation_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemAgentOutputCaptureRuntime;
    route_coordination_mutation_request_with_runtime(context, method, path, body, &mut runtime)
}

pub fn route_coordination_mutation_request_with_runtime(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
    _runtime: &mut impl AgentOutputCaptureRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let pathname = project_service_pathname(path);
    let body = body.unwrap_or(&Value::Null);
    let project_state_dir = context.project_state_dir();
    let response = match pathname {
        routes::threads::OPEN => route_threads_open(&project_state_dir, body),
        routes::threads::SEND => route_threads_send(&project_state_dir, body),
        routes::threads::MARK_SEEN => route_threads_mark_seen(&project_state_dir, body),
        routes::threads::STATUS => route_threads_status(&project_state_dir, body),
        routes::handoff::SEND => route_handoff_send(&project_state_dir, body),
        routes::handoff::ACCEPT => route_handoff_accept(&project_state_dir, body),
        routes::handoff::COMPLETE => route_handoff_complete(&project_state_dir, body),
        routes::tasks::ASSIGN => route_task_assign(&project_state_dir, body),
        routes::agents::CREATE_TEAMMATE_TASK => route_create_teammate_task(context, body),
        routes::agents::RAW_TEAMMATE_SEND => route_raw_teammate_send_removed(),
        routes::tasks::ACCEPT => route_task_accept(&project_state_dir, body),
        routes::tasks::BLOCK => route_task_block(&project_state_dir, body),
        routes::tasks::CANCEL => route_task_cancel(&project_state_dir, body),
        routes::tasks::COMPLETE => {
            route_task_complete(&project_state_dir, context.project_root(), body)
        }
        routes::tasks::REOPEN => route_task_reopen(&project_state_dir, body),
        routes::reviews::APPROVE => route_review_approve(&project_state_dir, body),
        routes::reviews::REQUEST_CHANGES => route_review_request_changes(&project_state_dir, body),
        _ => return None,
    };
    Some(response)
}

fn route_threads_open(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    let from = string_field_with_default(body, "from", "user");
    let mut participants = vec![Some(from.clone())];
    participants.extend(
        string_array_field(body, "participants")
            .into_iter()
            .map(Some),
    );
    let input = ThreadInput {
        title: string_field(body, "title"),
        kind: string_field_with_default(body, "kind", "conversation"),
        created_by: from,
        participants: unique(participants),
        worktree_path: trimmed_string(body.get("worktreePath")),
        status: Some("open".into()),
        ..ThreadInput::default()
    };
    mutate(project_state_dir, |exchange| {
        let (exchange, thread) = create_thread(exchange, input);
        Ok((exchange, json!({ "ok": true, "thread": thread })))
    })
}

fn route_threads_send(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    let from = string_field_with_default(body, "from", "user");
    let recipients = route_recipients(body);
    let kind = trimmed_string(body.get("kind"));
    let message_body = string_field(body, "body");
    let thread_id = trimmed_string(body.get("threadId"));
    let title = trimmed_string(body.get("title"));
    let worktree_path = trimmed_string(body.get("worktreePath"));
    mutate(project_state_dir, |exchange| {
        let result = if let Some(thread_id) = thread_id {
            send_thread_message(
                exchange,
                SendThreadMessageInput {
                    thread_id,
                    from,
                    to: Some(recipients),
                    kind,
                    body: message_body,
                    metadata: None,
                },
            )?
        } else {
            send_direct_message(
                exchange,
                SendDirectMessageInput {
                    from,
                    to: recipients,
                    kind,
                    body: message_body,
                    title,
                    worktree_path,
                    tags: Vec::new(),
                },
            )?
        };
        let body = mutation_result(&result, true);
        Ok((result.exchange, body))
    })
}

fn route_threads_mark_seen(
    project_state_dir: &Path,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let thread_id = string_field(body, "threadId");
    let session_id = trimmed_string(body.get("session"))
        .or_else(|| trimmed_string(body.get("sessionId")))
        .unwrap_or_default();
    if session_id.is_empty() {
        return json_response(400, json!({ "ok": false, "error": "session is required" }));
    }
    mutate(project_state_dir, |exchange| {
        if find_by_id(&exchange, "threads", &thread_id).is_none() {
            return Ok((
                exchange,
                json!({ "ok": false, "error": "thread not found" }),
            ));
        }
        let (exchange, thread) = update_thread(exchange, &thread_id, |mut thread| {
            let unread = thread
                .get("unreadBy")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|value| value.as_str() != Some(session_id.as_str()))
                .collect::<Vec<_>>();
            object_insert_mut(&mut thread, "unreadBy", Value::Array(unread));
            thread
        })
        .expect("checked thread exists");
        Ok((exchange, json!({ "ok": true, "thread": thread })))
    })
    .map_status(404)
}

fn route_threads_status(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    let thread_id = string_field(body, "threadId");
    let status = string_field(body, "status");
    let owner = trimmed_string(body.get("owner"));
    let waiting_on = optional_string_array_field(body, "waitingOn");
    mutate(project_state_dir, |exchange| {
        if find_by_id(&exchange, "threads", &thread_id).is_none() {
            return Ok((
                exchange,
                json!({ "ok": false, "error": "thread not found" }),
            ));
        }
        let (exchange, thread) = update_thread(exchange, &thread_id, |mut thread| {
            object_insert_mut(&mut thread, "status", Value::String(status));
            if let Some(owner) = owner {
                object_insert_mut(&mut thread, "owner", Value::String(owner));
            }
            if let Some(waiting_on) = waiting_on {
                object_insert_mut(&mut thread, "waitingOn", json!(waiting_on));
            } else if matches!(
                thread.get("status").and_then(Value::as_str),
                Some("done" | "abandoned")
            ) {
                object_insert_mut(&mut thread, "waitingOn", Value::Array(Vec::new()));
            }
            thread
        })
        .expect("checked thread exists");
        Ok((exchange, json!({ "ok": true, "thread": thread })))
    })
    .map_status(404)
}

fn route_handoff_send(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    let from = string_field_with_default(body, "from", "user");
    let recipients = route_recipients(body);
    let message_body = string_field(body, "body");
    let title = trimmed_string(body.get("title"));
    let worktree_path = trimmed_string(body.get("worktreePath"));
    mutate(project_state_dir, |exchange| {
        if recipients.is_empty() {
            return Err("handoff requires at least one recipient".into());
        }
        let thread_input = ThreadInput {
            title: title
                .unwrap_or_else(|| format!("Handoff: {from} \u{2192} {}", recipients.join(", "))),
            kind: "handoff".into(),
            created_by: from.clone(),
            participants: unique(
                std::iter::once(Some(from.clone()))
                    .chain(recipients.iter().cloned().map(Some))
                    .collect(),
            ),
            worktree_path,
            tags: vec!["handoff".into()],
            owner: Some(from.clone()),
            waiting_on: Some(recipients.clone()),
            status: Some("waiting".into()),
            ..ThreadInput::default()
        };
        let (exchange, thread) = create_thread(exchange, thread_input);
        let result = send_thread_message(
            exchange,
            SendThreadMessageInput {
                thread_id: string_field(&thread, "id"),
                from,
                to: Some(recipients),
                kind: Some("handoff".into()),
                body: message_body,
                metadata: None,
            },
        )?;
        let body = mutation_result(&result, true);
        Ok((result.exchange, body))
    })
}

fn route_handoff_accept(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    handoff_lifecycle(
        project_state_dir,
        body,
        "Accepted handoff.",
        "accepted",
        |mut thread, actor, _recipients| {
            object_insert_mut(&mut thread, "owner", Value::String(actor));
            object_insert_mut(&mut thread, "waitingOn", Value::Array(Vec::new()));
            object_insert_mut(&mut thread, "status", Value::String("open".into()));
            thread
        },
    )
}

fn route_handoff_complete(
    project_state_dir: &Path,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    handoff_lifecycle(
        project_state_dir,
        body,
        "Completed handoff.",
        "completed",
        |mut thread, actor, recipients| {
            object_insert_mut(&mut thread, "owner", Value::String(actor));
            object_insert_mut(&mut thread, "waitingOn", json!(recipients));
            object_insert_mut(
                &mut thread,
                "status",
                Value::String(if recipients.is_empty() {
                    "done".into()
                } else {
                    "waiting".into()
                }),
            );
            thread
        },
    )
}

fn route_task_assign(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    let from = string_field_with_default(body, "from", "user");
    let to = optional_string_or_first(body.get("to"));
    let assignee = trimmed_string(body.get("assignee"));
    let tool = trimmed_string(body.get("tool"));
    let description = string_field(body, "description");
    let prompt = trimmed_string(body.get("prompt")).unwrap_or_else(|| description.clone());
    let task_type = string_field_with_default(body, "type", "task");
    let diff = body.get("diff").cloned();
    let worktree_path = trimmed_string(body.get("worktreePath"));
    let assigner = trimmed_string(body.get("assigner"));
    let review_of = trimmed_string(body.get("reviewOf"));
    let iteration = positive_integer(body.get("iteration")).unwrap_or(1);
    mutate(project_state_dir, |exchange| {
        if to.is_none() && assignee.is_none() && tool.is_none() {
            return Err("task assignment requires --to, --assignee, or --tool".into());
        }
        let now = now_iso();
        let task_id = random_id("task");
        let mut task = Map::new();
        task.insert("id".into(), Value::String(task_id.clone()));
        task.insert("status".into(), Value::String("pending".into()));
        task.insert("assignedBy".into(), Value::String(from.clone()));
        insert_optional_string(&mut task, "assignedTo", to.clone());
        insert_optional_string(&mut task, "assignee", assignee);
        insert_optional_string(&mut task, "tool", tool);
        task.insert("description".into(), Value::String(description.clone()));
        task.insert("prompt".into(), Value::String(prompt));
        task.insert("createdAt".into(), Value::String(now.clone()));
        task.insert("updatedAt".into(), Value::String(now.clone()));
        task.insert("type".into(), Value::String(task_type.clone()));
        if let Some(diff) = diff {
            task.insert("diff".into(), diff);
        }
        if task_type == "review" {
            insert_optional_string(&mut task, "assigner", assigner);
            task.insert("reviewStatus".into(), Value::String("pending".into()));
            insert_optional_string(&mut task, "reviewOf", review_of);
            task.insert("iteration".into(), Value::from(iteration));
        }
        let mut task = Value::Object(task);
        let mut thread;
        let message;
        let mut exchange = exchange;
        if let Some(to) = to.clone() {
            let title = format!(
                "{}: {description}",
                if task_type == "review" {
                    "Review"
                } else {
                    "Task"
                }
            );
            let participants = unique(vec![Some(from.clone()), Some(to.clone())]);
            let (next_exchange, opened) = open_task_thread(
                exchange,
                &task_id,
                ThreadInput {
                    title,
                    kind: if task_type == "review" {
                        "review".into()
                    } else {
                        "task".into()
                    },
                    created_by: from.clone(),
                    participants,
                    worktree_path,
                    ..ThreadInput::default()
                },
            );
            exchange = next_exchange;
            let thread_id = string_field(&opened, "id");
            object_insert_mut(&mut task, "threadId", Value::String(thread_id.clone()));
            let (next_exchange, updated) = update_thread(exchange, &thread_id, |mut current| {
                object_insert_mut(&mut current, "status", Value::String("waiting".into()));
                object_insert_mut(&mut current, "owner", Value::String(to.clone()));
                object_insert_mut(&mut current, "waitingOn", json!([to.clone()]));
                current
            })
            .expect("opened task thread");
            exchange = next_exchange;
            thread = updated;
            let result = append_message(
                exchange,
                AppendMessageInput {
                    thread_id: thread_id.clone(),
                    from: from.clone(),
                    to: Some(vec![to]),
                    kind: "request".into(),
                    body: string_field(&task, "prompt"),
                    task_id: Some(task_id.clone()),
                    metadata: Some(json!({ "taskId": task_id, "taskAction": "assigned" })),
                },
            )?;
            exchange = result.exchange;
            message = result.message;
            thread = find_by_id(&exchange, "threads", &thread_id).unwrap_or(thread);
        } else {
            let title = format!(
                "{}: {description}",
                if task_type == "review" {
                    "Review"
                } else {
                    "Task"
                }
            );
            let (next_exchange, opened) = create_thread(
                exchange,
                ThreadInput {
                    title,
                    kind: if task_type == "review" {
                        "review".into()
                    } else {
                        "task".into()
                    },
                    created_by: from.clone(),
                    participants: vec![from.clone()],
                    task_id: Some(task_id.clone()),
                    worktree_path,
                    owner: Some(from),
                    waiting_on: Some(Vec::new()),
                    status: Some("open".into()),
                    ..ThreadInput::default()
                },
            );
            exchange = next_exchange;
            object_insert_mut(
                &mut task,
                "threadId",
                Value::String(string_field(&opened, "id")),
            );
            thread = opened;
            message = Value::Null;
        }
        exchange = upsert_item(exchange, "tasks", task.clone());
        exchange = derive_runtime_exchange_indexes(exchange);
        Ok((
            exchange,
            json!({ "ok": true, "task": task, "thread": thread, "message": message, "deliveredTo": [] }),
        ))
    })
}

fn route_raw_teammate_send_removed() -> ProjectServiceDispatchResponse {
    json_response(
        410,
        json!({
            "ok": false,
            "error": format!(
                "raw teammate send has been removed; create durable teammate work with {}",
                routes::agents::CREATE_TEAMMATE_TASK
            ),
        }),
    )
}

fn route_create_teammate_task(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let project_state_dir = context.project_state_dir();
    let parent_session_id = trimmed_string(body.get("parentSessionId")).unwrap_or_default();
    let teammate_session_id = trimmed_string(body.get("teammateSessionId")).unwrap_or_default();
    if teammate_session_id.is_empty() {
        return json_response(
            400,
            json!({ "ok": false, "error": "teammateSessionId is required" }),
        );
    }
    let prompt = teammate_task_prompt(body);
    if prompt.is_empty() {
        return json_response(
            400,
            json!({ "ok": false, "error": "teammate task requires body or prompt" }),
        );
    }
    let (parent, teammate) = match resolve_teammate_task_target(
        context,
        &project_state_dir,
        &parent_session_id,
        &teammate_session_id,
    ) {
        Ok(target) => target,
        Err(response) => return *response,
    };
    let worktree_path = trimmed_string(body.get("worktreePath"))
        .or_else(|| trimmed_string(teammate.get("worktreePath")))
        .or_else(|| trimmed_string(parent.get("worktreePath")));
    let assign_body = json!({
        "from": string_field(&parent, "id"),
        "to": teammate_session_id,
        "description": teammate_task_description(body, &prompt),
        "prompt": prompt,
        "worktreePath": worktree_path,
    });
    let mut response = route_task_assign(&project_state_dir, &assign_body);
    object_insert_mut(
        &mut response.body,
        "parentSessionId",
        Value::String(string_field(&parent, "id")),
    );
    object_insert_mut(
        &mut response.body,
        "teammateSessionId",
        Value::String(teammate_session_id),
    );
    response
}

fn resolve_teammate_task_target(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
    parent_session_id: &str,
    teammate_session_id: &str,
) -> Result<(Value, Value), Box<ProjectServiceDispatchResponse>> {
    let config = load_config_for_project(context.project_root());
    let tools = config
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let metadata_state = load_metadata_state(project_state_dir);
    let topology = read_runtime_topology(runtime_topology_path(project_state_dir))
        .map_err(|error| Box::new(json_response(500, json!({ "ok": false, "error": error }))))?;
    let sessions = topology_desktop_session_list(&topology, &metadata_state.sessions, &tools);
    let resolved = resolve_direct_teammates(&sessions, parent_session_id).map_err(|error| {
        Box::new(json_response(
            error.status,
            json!({ "ok": false, "error": error.error }),
        ))
    })?;
    let teammate = resolved
        .teammates
        .into_iter()
        .find(|session| string_field(session, "id") == teammate_session_id)
        .ok_or_else(|| {
            Box::new(json_response(
                404,
                json!({
                    "ok": false,
                    "error": format!(
                        "teammate \"{teammate_session_id}\" is not attached to parent \"{parent_session_id}\""
                    ),
                }),
            ))
        })?;
    Ok((resolved.parent, teammate))
}

fn teammate_task_prompt(body: &Value) -> String {
    trimmed_string(body.get("prompt"))
        .or_else(|| trimmed_string(body.get("body")))
        .unwrap_or_default()
}

fn teammate_task_description(body: &Value, prompt: &str) -> String {
    trimmed_string(body.get("title"))
        .or_else(|| trimmed_string(body.get("description")))
        .or_else(|| first_non_empty_line(prompt).map(|line| line.chars().take(120).collect()))
        .unwrap_or_else(|| "Teammate task".into())
}

fn first_non_empty_line(value: &str) -> Option<String> {
    value.lines().find_map(trimmed_owned)
}

fn route_task_accept(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    task_lifecycle(
        project_state_dir,
        body,
        |mut task, actor, _body| {
            object_insert_mut(&mut task, "status", Value::String("in_progress".into()));
            if !actor.is_empty() {
                object_insert_mut(&mut task, "assignedTo", Value::String(actor));
            }
            task
        },
        TaskThreadUpdate {
            default_body: "Accepted task and started work.",
            action: "accepted",
            kind: "decision",
            after_task: None,
            transform: |mut thread, actor, _task| {
                object_insert_mut(&mut thread, "owner", Value::String(actor));
                object_insert_mut(&mut thread, "waitingOn", Value::Array(Vec::new()));
                object_insert_mut(&mut thread, "status", Value::String("open".into()));
                thread
            },
        },
    )
}

fn route_task_block(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    task_lifecycle(
        project_state_dir,
        body,
        |mut task, actor, body| {
            object_insert_mut(&mut task, "status", Value::String("blocked".into()));
            if !actor.is_empty() {
                object_insert_mut(&mut task, "assignedTo", Value::String(actor));
            }
            let error = body
                .filter(|body| !body.is_empty())
                .unwrap_or_else(|| string_field_with_default(&task, "error", "Task is blocked."));
            object_insert_mut(&mut task, "error", Value::String(error));
            task
        },
        TaskThreadUpdate {
            default_body: "Task is blocked.",
            action: "blocked",
            kind: "reply",
            after_task: None,
            transform: |mut thread, actor, task| {
                object_insert_mut(&mut thread, "owner", Value::String(actor));
                object_insert_mut(
                    &mut thread,
                    "waitingOn",
                    json!([string_field(task, "assignedBy")]),
                );
                object_insert_mut(&mut thread, "status", Value::String("blocked".into()));
                thread
            },
        },
    )
}

fn route_task_complete(
    project_state_dir: &Path,
    project_root: &Path,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let team_config = load_team_config(project_root);
    task_lifecycle(
        project_state_dir,
        body,
        |mut task, actor, body| {
            object_insert_mut(&mut task, "status", Value::String("done".into()));
            if !actor.is_empty() {
                object_insert_mut(&mut task, "assignedTo", Value::String(actor));
            }
            if let Some(body) = body.filter(|body| !body.is_empty()) {
                object_insert_mut(&mut task, "result", Value::String(body));
            }
            object_insert_mut(&mut task, "notifiedAt", Value::String(now_iso()));
            task
        },
        TaskThreadUpdate {
            default_body: "Completed task.",
            action: "completed",
            kind: "status",
            after_task: Some(Box::new(move |task| {
                create_review_task_for_completed_task(task, &team_config)
            })),
            transform: |mut thread, actor, task| {
                object_insert_mut(&mut thread, "owner", Value::String(actor));
                object_insert_mut(
                    &mut thread,
                    "waitingOn",
                    json!([string_field(task, "assignedBy")]),
                );
                object_insert_mut(&mut thread, "status", Value::String("waiting".into()));
                thread
            },
        },
    )
}

fn route_task_cancel(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    task_lifecycle(
        project_state_dir,
        body,
        |mut task, actor, body| {
            object_insert_mut(&mut task, "status", Value::String("canceled".into()));
            if !actor.is_empty() {
                object_insert_mut(&mut task, "canceledBy", Value::String(actor));
            }
            if let Some(body) = body.filter(|body| !body.is_empty()) {
                object_insert_mut(&mut task, "cancellationReason", Value::String(body));
            }
            object_insert_mut(&mut task, "notifiedAt", Value::String(now_iso()));
            task
        },
        TaskThreadUpdate {
            default_body: "Canceled task.",
            action: "canceled",
            kind: "status",
            after_task: None,
            transform: |mut thread, actor, _task| {
                object_insert_mut(&mut thread, "owner", Value::String(actor));
                object_insert_mut(&mut thread, "waitingOn", Value::Array(Vec::new()));
                object_insert_mut(&mut thread, "status", Value::String("abandoned".into()));
                thread
            },
        },
    )
}

fn route_review_approve(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    review_lifecycle(
        project_state_dir,
        body,
        "Approved review.",
        "completed",
        "decision",
        |mut task, actor, body| {
            if string_field(&task, "type") != "review" {
                return Err(format!(
                    "task {} is not a review",
                    string_field(&task, "id")
                ));
            }
            object_insert_mut(&mut task, "status", Value::String("done".into()));
            if !actor.is_empty() {
                object_insert_mut(&mut task, "assignedTo", Value::String(actor));
            }
            object_insert_mut(&mut task, "reviewStatus", Value::String("approved".into()));
            if let Some(body) = body.filter(|body| !body.is_empty()) {
                object_insert_mut(&mut task, "reviewFeedback", Value::String(body));
            }
            object_insert_mut(&mut task, "notifiedAt", Value::String(now_iso()));
            Ok((task, None))
        },
        |mut thread, actor, task| {
            object_insert_mut(&mut thread, "owner", Value::String(actor));
            object_insert_mut(
                &mut thread,
                "waitingOn",
                json!([string_field(task, "assignedBy")]),
            );
            object_insert_mut(&mut thread, "status", Value::String("waiting".into()));
            thread
        },
    )
}

fn route_review_request_changes(
    project_state_dir: &Path,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    review_lifecycle(
        project_state_dir,
        body,
        "Changes requested.",
        "blocked",
        "reply",
        |mut task, actor, body| {
            if string_field(&task, "type") != "review" {
                return Err(format!(
                    "task {} is not a review",
                    string_field(&task, "id")
                ));
            }
            object_insert_mut(&mut task, "status", Value::String("done".into()));
            if !actor.is_empty() {
                object_insert_mut(&mut task, "assignedTo", Value::String(actor));
            }
            object_insert_mut(
                &mut task,
                "reviewStatus",
                Value::String("changes_requested".into()),
            );
            object_insert_mut(
                &mut task,
                "reviewFeedback",
                Value::String(body.unwrap_or_else(|| "Changes requested.".into())),
            );
            object_insert_mut(&mut task, "notifiedAt", Value::String(now_iso()));
            let follow_up = create_rework_task_from_review(&task);
            Ok((task, follow_up))
        },
        |mut thread, actor, task| {
            object_insert_mut(&mut thread, "owner", Value::String(actor));
            object_insert_mut(
                &mut thread,
                "waitingOn",
                json!([string_field(task, "assignedBy")]),
            );
            object_insert_mut(&mut thread, "status", Value::String("blocked".into()));
            thread
        },
    )
}

fn route_task_reopen(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    let task_id = string_field(body, "taskId");
    let from = string_field_with_default(body, "from", "user");
    let input_body = trimmed_string(body.get("body"));
    mutate(project_state_dir, |exchange| {
        let task = find_by_id(&exchange, "tasks", &task_id)
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        let now = now_iso();
        let root_task_id =
            trimmed_string(task.get("reviewOf")).unwrap_or_else(|| string_field(&task, "id"));
        let iteration = positive_integer(task.get("iteration")).unwrap_or(1) + 1;
        let description = if string_field(&task, "type") == "review" {
            format!(
                "Revision {iteration}: {}",
                strip_prefix(&string_field(&task, "description"), "Review: ")
            )
        } else {
            format!(
                "Reopen: {}",
                strip_revision_prefix(&string_field(&task, "description"))
            )
        };
        let prompt = input_body
            .or_else(|| trimmed_string(task.get("reviewFeedback")))
            .or_else(|| trimmed_string(task.get("result")))
            .or_else(|| trimmed_string(task.get("error")))
            .unwrap_or_else(|| {
                format!(
                    "Reopened from {}. Continue the workflow from the latest context.",
                    string_field(&task, "id")
                )
            });
        let mut reopened = Map::new();
        reopened.insert(
            "id".into(),
            Value::String(format!("reopen-{root_task_id}-{}", base36_sequence())),
        );
        reopened.insert("status".into(), Value::String("pending".into()));
        reopened.insert("assignedBy".into(), Value::String(from));
        reopened.insert("description".into(), Value::String(description));
        reopened.insert("prompt".into(), Value::String(prompt));
        reopened.insert("createdAt".into(), Value::String(now.clone()));
        reopened.insert("updatedAt".into(), Value::String(now));
        insert_optional_string(
            &mut reopened,
            "assignee",
            if string_field(&task, "type") == "review" {
                trimmed_string(task.get("assigner")).or_else(|| Some("coder".into()))
            } else {
                trimmed_string(task.get("assignee"))
            },
        );
        insert_optional_string(
            &mut reopened,
            "assigner",
            if string_field(&task, "type") == "review" {
                trimmed_string(task.get("assignee"))
            } else {
                trimmed_string(task.get("assigner"))
            },
        );
        insert_optional_string(&mut reopened, "tool", trimmed_string(task.get("tool")));
        reopened.insert("type".into(), Value::String("task".into()));
        reopened.insert("iteration".into(), Value::from(iteration));
        reopened.insert("reviewOf".into(), Value::String(root_task_id));
        let reopened = Value::Object(reopened);
        let exchange =
            derive_runtime_exchange_indexes(upsert_item(exchange, "tasks", reopened.clone()));
        Ok((exchange, json!({ "ok": true, "task": reopened })))
    })
}

fn handoff_lifecycle(
    project_state_dir: &Path,
    body: &Value,
    default_body: &'static str,
    action: &'static str,
    transform: fn(Value, String, Vec<String>) -> Value,
) -> ProjectServiceDispatchResponse {
    let thread_id = string_field(body, "threadId");
    let from = string_field_with_default(body, "from", "user");
    let message_body = trimmed_string(body.get("body")).unwrap_or_else(|| default_body.into());
    mutate(project_state_dir, |exchange| {
        let thread = find_by_id(&exchange, "threads", &thread_id)
            .ok_or_else(|| format!("thread not found: {thread_id}"))?;
        if string_field(&thread, "kind") != "handoff" {
            return Err(format!("thread {thread_id} is not a handoff"));
        }
        let recipients = unique(vec![if string_field(&thread, "createdBy") == from {
            None
        } else {
            Some(string_field(&thread, "createdBy"))
        }]);
        let result = append_message(
            exchange,
            AppendMessageInput {
                thread_id: thread_id.clone(),
                from: from.clone(),
                to: Some(recipients.clone()),
                kind: "decision".into(),
                body: message_body,
                task_id: None,
                metadata: Some(json!({ "handoffAction": action })),
            },
        )?;
        let (exchange, updated) = update_thread(result.exchange, &thread_id, |thread| {
            let mut thread = transform(thread, from.clone(), recipients.clone());
            let participants = unique(
                string_array_from_value(thread.get("participants"))
                    .into_iter()
                    .chain(std::iter::once(from.clone()))
                    .chain(recipients.clone())
                    .map(Some)
                    .collect(),
            );
            object_insert_mut(&mut thread, "participants", json!(participants));
            thread
        })
        .ok_or_else(|| format!("thread disappeared after update: {thread_id}"))?;
        Ok((
            exchange,
            json!({ "ok": true, "thread": updated, "message": result.message, "deliveredTo": [] }),
        ))
    })
}

struct TaskThreadUpdate {
    default_body: &'static str,
    action: &'static str,
    kind: &'static str,
    after_task: Option<Box<TaskAfterUpdate>>,
    transform: ThreadTransform,
}

type TaskUpdater = fn(Value, String, Option<String>) -> Value;
type ReviewUpdater = fn(Value, String, Option<String>) -> Result<(Value, Option<Value>), String>;
type ThreadTransform = fn(Value, String, &Value) -> Value;
type TaskAfterUpdate = dyn Fn(&Value) -> Option<Value>;

fn task_lifecycle(
    project_state_dir: &Path,
    body: &Value,
    update_task: TaskUpdater,
    thread_update: TaskThreadUpdate,
) -> ProjectServiceDispatchResponse {
    let task_id = string_field(body, "taskId");
    let from = string_field_with_default(body, "from", "user");
    let input_body = trimmed_string(body.get("body"));
    mutate(project_state_dir, |exchange| {
        let task = find_by_id(&exchange, "tasks", &task_id)
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        let mut task = update_task(task, from.clone(), input_body.clone());
        let body = input_body
            .clone()
            .filter(|body| !body.is_empty())
            .or_else(|| {
                if thread_update.action == "blocked" {
                    trimmed_string(task.get("error"))
                } else if thread_update.action == "completed" {
                    trimmed_string(task.get("result"))
                } else {
                    None
                }
            })
            .unwrap_or_else(|| thread_update.default_body.into());
        let (exchange, thread, message) = update_task_thread(
            exchange,
            &task,
            &from,
            body,
            thread_update.action,
            thread_update.kind,
            thread_update.transform,
        )?;
        object_insert_mut(&mut task, "updatedAt", Value::String(now_iso()));
        let mut exchange = upsert_item(exchange, "tasks", task.clone());
        if let Some(after_task) = thread_update.after_task
            && let Some(extra_task) = after_task(&task)
        {
            exchange = upsert_item(exchange, "tasks", extra_task);
        }
        let exchange = derive_runtime_exchange_indexes(exchange);
        Ok((
            exchange,
            json!({ "ok": true, "task": task, "thread": thread, "message": message, "deliveredTo": [] }),
        ))
    })
}

fn review_lifecycle(
    project_state_dir: &Path,
    body: &Value,
    default_body: &'static str,
    action: &'static str,
    kind: &'static str,
    update_task: ReviewUpdater,
    transform: ThreadTransform,
) -> ProjectServiceDispatchResponse {
    let task_id = string_field(body, "taskId");
    let from = string_field_with_default(body, "from", "user");
    let input_body = trimmed_string(body.get("body"));
    mutate(project_state_dir, |exchange| {
        let task = find_by_id(&exchange, "tasks", &task_id)
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        let (mut task, follow_up) = update_task(task, from.clone(), input_body.clone())?;
        let body = input_body
            .clone()
            .filter(|body| !body.is_empty())
            .or_else(|| {
                if action == "blocked" {
                    trimmed_string(task.get("reviewFeedback"))
                } else {
                    None
                }
            })
            .unwrap_or_else(|| default_body.into());
        let (exchange, thread, message) =
            update_task_thread(exchange, &task, &from, body, action, kind, transform)?;
        object_insert_mut(&mut task, "updatedAt", Value::String(now_iso()));
        let mut exchange = upsert_item(exchange, "tasks", task.clone());
        if let Some(follow_up) = follow_up.clone() {
            exchange = upsert_item(exchange, "tasks", follow_up);
        }
        exchange = derive_runtime_exchange_indexes(exchange);
        let mut response = json!({
            "ok": true,
            "task": task,
            "thread": thread,
            "message": message,
            "deliveredTo": []
        });
        if let Some(follow_up) = follow_up {
            object_insert_mut(&mut response, "followUpTask", follow_up);
        }
        Ok((exchange, response))
    })
}

fn update_task_thread(
    exchange: Value,
    task: &Value,
    from: &str,
    body: String,
    action: &str,
    kind: &str,
    transform: ThreadTransform,
) -> Result<(Value, Value, Value), String> {
    let Some(thread_id) = trimmed_string(task.get("threadId")) else {
        return Ok((exchange, Value::Null, Value::Null));
    };
    let Some(thread) = find_by_id(&exchange, "threads", &thread_id) else {
        return Ok((exchange, Value::Null, Value::Null));
    };
    let recipients = unique(vec![if string_field(&thread, "createdBy") == from {
        None
    } else {
        Some(string_field(&thread, "createdBy"))
    }]);
    let result = append_message(
        exchange,
        AppendMessageInput {
            thread_id: thread_id.clone(),
            from: from.to_owned(),
            to: Some(recipients.clone()),
            kind: kind.into(),
            body,
            task_id: None,
            metadata: Some(json!({ "taskId": string_field(task, "id"), "taskAction": action })),
        },
    )?;
    let fallback_exchange = result.exchange.clone();
    let (exchange, thread) = update_thread(result.exchange, &thread_id, |mut current| {
        let participants = unique(
            string_array_from_value(current.get("participants"))
                .into_iter()
                .map(Some)
                .chain(std::iter::once(Some(from.to_owned())))
                .chain(recipients.iter().cloned().map(Some))
                .collect(),
        );
        object_insert_mut(&mut current, "participants", json!(participants));
        transform(current, from.to_owned(), task)
    })
    .unwrap_or((fallback_exchange, thread));
    Ok((exchange, thread, result.message))
}

struct MutationResult {
    exchange: Value,
    thread: Value,
    message: Value,
    thread_created: bool,
}

fn send_direct_message(
    exchange: Value,
    input: SendDirectMessageInput,
) -> Result<MutationResult, String> {
    let from = if input.from.trim().is_empty() {
        "user".to_owned()
    } else {
        input.from
    };
    let recipients = unique(input.to.into_iter().map(Some).collect());
    if recipients.is_empty() {
        return Err("direct message requires at least one recipient".into());
    }
    let participants = unique(
        std::iter::once(Some(from.clone()))
            .chain(recipients.iter().cloned().map(Some))
            .collect(),
    );
    let (exchange, thread, thread_created) =
        if let Some(thread) = find_direct_conversation_thread(&exchange, &participants) {
            (exchange, thread, false)
        } else {
            let (exchange, thread) = create_thread(
                exchange,
                ThreadInput {
                    title: input.title.unwrap_or_else(|| {
                        format!("Conversation: {from} \u{2192} {}", recipients.join(", "))
                    }),
                    kind: "conversation".into(),
                    created_by: from.clone(),
                    participants,
                    worktree_path: input.worktree_path,
                    tags: input.tags,
                    owner: Some(from.clone()),
                    waiting_on: Some(recipients.clone()),
                    status: Some(if recipients.is_empty() {
                        "open".into()
                    } else {
                        "waiting".into()
                    }),
                    ..ThreadInput::default()
                },
            );
            (exchange, thread, true)
        };
    let result = send_thread_message(
        exchange,
        SendThreadMessageInput {
            thread_id: string_field(&thread, "id"),
            from,
            to: Some(recipients),
            kind: Some(input.kind.unwrap_or_else(|| "request".into())),
            body: input.body,
            metadata: None,
        },
    )?;
    Ok(MutationResult {
        thread_created,
        ..result
    })
}

fn send_thread_message(
    exchange: Value,
    input: SendThreadMessageInput,
) -> Result<MutationResult, String> {
    let thread = find_by_id(&exchange, "threads", &input.thread_id)
        .ok_or_else(|| format!("thread not found: {}", input.thread_id))?;
    let recipients = resolve_recipients(&thread, &input.from, input.to.clone());
    let kind = input.kind.unwrap_or_else(|| "note".into());
    let appended = append_message(
        exchange,
        AppendMessageInput {
            thread_id: input.thread_id.clone(),
            from: input.from.clone(),
            to: Some(recipients.clone()),
            kind: kind.clone(),
            body: input.body,
            task_id: None,
            metadata: input.metadata,
        },
    )?;
    let (exchange, updated) = update_thread(appended.exchange, &input.thread_id, |current| {
        update_thread_for_message(current, &input.from, &recipients, &kind)
    })
    .ok_or_else(|| format!("thread disappeared after update: {}", input.thread_id))?;
    let exchange =
        reactivate_completed_task_if_waiting_on_assignee(exchange, &updated, &appended.message);
    Ok(MutationResult {
        exchange,
        thread: updated,
        message: appended.message,
        thread_created: false,
    })
}

struct SendThreadMessageInput {
    thread_id: String,
    from: String,
    to: Option<Vec<String>>,
    kind: Option<String>,
    body: String,
    metadata: Option<Value>,
}

struct SendDirectMessageInput {
    from: String,
    to: Vec<String>,
    kind: Option<String>,
    body: String,
    title: Option<String>,
    worktree_path: Option<String>,
    tags: Vec<String>,
}

struct AppendMessageInput {
    thread_id: String,
    from: String,
    to: Option<Vec<String>>,
    kind: String,
    body: String,
    task_id: Option<String>,
    metadata: Option<Value>,
}

struct AppendMessageResult {
    exchange: Value,
    message: Value,
}

fn append_message(
    exchange: Value,
    input: AppendMessageInput,
) -> Result<AppendMessageResult, String> {
    let now = now_iso();
    let message_id = random_id("msg");
    let mut message = Map::new();
    message.insert("id".into(), Value::String(message_id.clone()));
    message.insert("threadId".into(), Value::String(input.thread_id.clone()));
    message.insert("ts".into(), Value::String(now.clone()));
    message.insert("from".into(), Value::String(input.from.clone()));
    if let Some(to) = input.to {
        message.insert("to".into(), json!(to));
    }
    message.insert("kind".into(), Value::String(input.kind));
    message.insert("body".into(), Value::String(input.body));
    insert_optional_string(&mut message, "taskId", input.task_id);
    if let Some(metadata) = input.metadata {
        message.insert("metadata".into(), metadata);
    }
    let message = Value::Object(message);
    let mut found = false;
    let exchange = map_array(exchange, "threads", |thread| {
        if string_field(&thread, "id") != input.thread_id {
            return thread;
        }
        found = true;
        thread_updated_for_message(thread, &message, &now)
    });
    if !found {
        return Err(format!("thread not found: {}", input.thread_id));
    }
    let exchange = upsert_item(exchange, "messages", message.clone());
    Ok(AppendMessageResult { exchange, message })
}

#[derive(Default)]
struct ThreadInput {
    title: String,
    kind: String,
    created_by: String,
    participants: Vec<String>,
    owner: Option<String>,
    waiting_on: Option<Vec<String>>,
    worktree_path: Option<String>,
    task_id: Option<String>,
    tags: Vec<String>,
    status: Option<String>,
}

fn create_thread(exchange: Value, input: ThreadInput) -> (Value, Value) {
    let now = now_iso();
    let mut thread = Map::new();
    thread.insert("id".into(), Value::String(random_id("thread")));
    thread.insert("title".into(), Value::String(input.title));
    thread.insert("kind".into(), Value::String(input.kind));
    thread.insert("createdAt".into(), Value::String(now.clone()));
    thread.insert("updatedAt".into(), Value::String(now.clone()));
    thread.insert("createdBy".into(), Value::String(input.created_by));
    thread.insert(
        "participants".into(),
        json!(unique(input.participants.into_iter().map(Some).collect())),
    );
    thread.insert(
        "status".into(),
        Value::String(input.status.unwrap_or_else(|| "open".into())),
    );
    insert_optional_string(&mut thread, "owner", input.owner);
    if let Some(waiting_on) = input.waiting_on {
        thread.insert("waitingOn".into(), json!(waiting_on));
    }
    insert_optional_string(&mut thread, "worktreePath", input.worktree_path);
    insert_optional_string(&mut thread, "taskId", input.task_id);
    if !input.tags.is_empty() {
        thread.insert("tags".into(), json!(input.tags));
    }
    let thread = Value::Object(thread);
    let exchange =
        derive_runtime_exchange_indexes(upsert_item(exchange, "threads", thread.clone()));
    (exchange, thread)
}

fn open_task_thread(exchange: Value, task_id: &str, input: ThreadInput) -> (Value, Value) {
    if let Some(existing) = array_field(&exchange, "threads")
        .into_iter()
        .find(|thread| string_field(thread, "taskId") == task_id)
    {
        return (exchange, existing);
    }
    let mut input = input;
    input.task_id = Some(task_id.into());
    create_thread(exchange, input)
}

fn update_thread(
    exchange: Value,
    thread_id: &str,
    updater: impl FnOnce(Value) -> Value,
) -> Option<(Value, Value)> {
    let now = now_iso();
    let mut updated = None;
    let mut updater = Some(updater);
    let mut exchange = map_array(exchange, "threads", |thread| {
        if string_field(&thread, "id") != thread_id {
            return thread;
        }
        let mut next = updater.take().expect("single matching thread")(thread.clone());
        object_insert_mut(&mut next, "id", Value::String(string_field(&thread, "id")));
        object_insert_mut(
            &mut next,
            "createdAt",
            thread.get("createdAt").cloned().unwrap_or(Value::Null),
        );
        object_insert_mut(&mut next, "updatedAt", Value::String(now.clone()));
        updated = Some(next.clone());
        next
    });
    let updated = updated?;
    object_insert_mut(&mut exchange, "generatedAt", Value::String(now));
    Some((derive_runtime_exchange_indexes(exchange), updated))
}

fn thread_updated_for_message(mut thread: Value, message: &Value, updated_at: &str) -> Value {
    object_insert_mut(&mut thread, "updatedAt", Value::String(updated_at.into()));
    object_insert_mut(
        &mut thread,
        "lastMessageId",
        Value::String(string_field(message, "id")),
    );
    let from = string_field(message, "from");
    let unread_by = unique(
        string_array_from_value(thread.get("participants"))
            .into_iter()
            .filter(|id| id != &from)
            .map(Some)
            .collect(),
    );
    object_insert_mut(&mut thread, "unreadBy", json!(unread_by));
    thread
}

fn update_thread_for_message(
    mut thread: Value,
    from: &str,
    recipients: &[String],
    kind: &str,
) -> Value {
    let participants = unique(
        string_array_from_value(thread.get("participants"))
            .into_iter()
            .map(Some)
            .chain(std::iter::once(Some(from.to_owned())))
            .chain(recipients.iter().cloned().map(Some))
            .collect(),
    );
    object_insert_mut(&mut thread, "participants", json!(participants));
    if matches!(
        kind,
        "request" | "handoff" | "reply" | "decision" | "status"
    ) {
        object_insert_mut(
            &mut thread,
            "status",
            Value::String(if recipients.is_empty() {
                "open".into()
            } else {
                "waiting".into()
            }),
        );
        object_insert_mut(&mut thread, "owner", Value::String(from.to_owned()));
        object_insert_mut(&mut thread, "waitingOn", json!(recipients));
    } else if thread.get("owner").is_none() {
        object_insert_mut(&mut thread, "owner", Value::String(from.to_owned()));
    }
    thread
}

fn find_direct_conversation_thread(exchange: &Value, participants: &[String]) -> Option<Value> {
    let mut sorted = participants.to_vec();
    sorted.sort();
    array_field(exchange, "threads").into_iter().find(|thread| {
        if string_field(thread, "kind") != "conversation"
            || thread.get("taskId").is_some()
            || string_field(thread, "status") == "abandoned"
        {
            return false;
        }
        let mut current = unique(
            string_array_from_value(thread.get("participants"))
                .into_iter()
                .map(Some)
                .collect(),
        );
        current.sort();
        current == sorted
    })
}

fn resolve_recipients(thread: &Value, from: &str, to: Option<Vec<String>>) -> Vec<String> {
    let explicit = unique(to.unwrap_or_default().into_iter().map(Some).collect());
    if !explicit.is_empty() {
        return explicit;
    }
    unique(
        string_array_from_value(thread.get("participants"))
            .into_iter()
            .filter(|participant| participant != from && participant != "user")
            .map(Some)
            .collect(),
    )
}

fn mutation_result(result: &MutationResult, delivered: bool) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    body.insert("thread".into(), result.thread.clone());
    body.insert("message".into(), result.message.clone());
    body.insert("threadCreated".into(), Value::Bool(result.thread_created));
    if delivered {
        body.insert("deliveredTo".into(), Value::Array(Vec::new()));
    }
    Value::Object(body)
}

fn create_rework_task_from_review(review_task: &Value) -> Option<Value> {
    if string_field(review_task, "reviewStatus") != "changes_requested" {
        return None;
    }
    let iteration = positive_integer(review_task.get("iteration")).unwrap_or(1) + 1;
    if iteration > 5 {
        return None;
    }
    let now = now_iso();
    let review_of = string_field_with_default(review_task, "reviewOf", "unknown");
    let mut task = json!({
        "id": format!("revision-{review_of}-{}", base36_sequence()),
        "status": "pending",
        "assignedBy": trimmed_string(review_task.get("assignedTo")).unwrap_or_else(|| string_field(review_task, "assignedBy")),
        "description": format!("Revision {iteration}: {}", strip_prefix(&string_field(review_task, "description"), "Review: ")),
        "prompt": format!(
            "Changes requested by reviewer:\n\n{}\n\nOriginal task: {}",
            trimmed_string(review_task.get("reviewFeedback"))
                .or_else(|| trimmed_string(review_task.get("result")))
                .unwrap_or_else(|| "(no feedback)".into()),
            string_field(review_task, "description")
        ),
        "createdAt": now,
        "updatedAt": now,
        "assignee": trimmed_string(review_task.get("assigner")).unwrap_or_else(|| "coder".into()),
        "type": "task",
        "iteration": iteration,
    });
    if let Some(assigner) = review_task.get("assignee").cloned() {
        object_insert_mut(&mut task, "assigner", assigner);
    }
    if let Some(review_of) = review_task.get("reviewOf").cloned() {
        object_insert_mut(&mut task, "reviewOf", review_of);
    }
    Some(task)
}

fn create_review_task_for_completed_task(task: &Value, team_config: &Value) -> Option<Value> {
    if string_field(task, "type") == "review" {
        return None;
    }
    let assigner_role = trimmed_string(task.get("assigner"))?;
    let reviewer_role = team_config
        .get("roles")
        .and_then(|roles| roles.get(&assigner_role))
        .and_then(|role| role.get("reviewedBy"))
        .and_then(Value::as_str)
        .and_then(trimmed_owned)?;
    let now = now_iso();
    Some(json!({
        "id": format!("review-{}-{}", string_field(task, "id"), base36_sequence()),
        "status": "pending",
        "assignedBy": trimmed_string(task.get("assignedTo")).unwrap_or_else(|| string_field(task, "assignedBy")),
        "description": format!("Review: {}", string_field(task, "description")),
        "prompt": format!(
            "Review the changes from task \"{}\".\n\nResult: {}",
            string_field(task, "description"),
            trimmed_string(task.get("result")).unwrap_or_else(|| "(no result)".into())
        ),
        "createdAt": now,
        "updatedAt": now,
        "assignee": reviewer_role,
        "assigner": task.get("assignee").cloned().unwrap_or(Value::Null),
        "type": "review",
        "reviewStatus": "pending",
        "diff": task.get("diff").cloned().unwrap_or(Value::Null),
        "iteration": 1,
        "reviewOf": string_field(task, "id"),
    }))
}

fn reactivate_completed_task_if_waiting_on_assignee(
    exchange: Value,
    thread: &Value,
    message: &Value,
) -> Value {
    let Some(task_id) = trimmed_string(thread.get("taskId")) else {
        return exchange;
    };
    if !matches!(string_field(thread, "kind").as_str(), "task" | "review")
        || string_field(thread, "status") != "waiting"
    {
        return exchange;
    }
    let Some(task) = find_by_id(&exchange, "tasks", &task_id) else {
        return exchange;
    };
    let Some(assigned_to) = trimmed_string(task.get("assignedTo")) else {
        return exchange;
    };
    if !matches!(string_field(&task, "status").as_str(), "done" | "failed")
        || !string_array_from_value(thread.get("waitingOn")).contains(&assigned_to)
        || string_field(message, "from") == assigned_to
    {
        return exchange;
    }
    let message_body = trimmed_string(message.get("body"));
    let from =
        trimmed_string(message.get("from")).unwrap_or_else(|| string_field(&task, "assignedBy"));
    let mut changed = false;
    let mut exchange = map_array(exchange, "tasks", |mut current| {
        if string_field(&current, "id") != task_id {
            return current;
        }
        object_insert_mut(&mut current, "status", Value::String("pending".into()));
        object_insert_mut(&mut current, "assignedBy", Value::String(from.clone()));
        if let Some(message_body) = message_body.clone() {
            object_insert_mut(&mut current, "error", Value::String(message_body));
        }
        object_insert_mut(&mut current, "notifiedAt", Value::Null);
        object_insert_mut(&mut current, "updatedAt", Value::String(now_iso()));
        changed = true;
        current
    });
    if changed {
        object_insert_mut(&mut exchange, "generatedAt", Value::String(now_iso()));
        derive_runtime_exchange_indexes(exchange)
    } else {
        exchange
    }
}

trait ResponseStatusMap {
    fn map_status(self, status: u16) -> Self;
}

impl ResponseStatusMap for ProjectServiceDispatchResponse {
    fn map_status(mut self, status: u16) -> Self {
        if self.body.get("ok") == Some(&Value::Bool(false)) {
            self.status = status;
        }
        self
    }
}

fn mutate(
    project_state_dir: &Path,
    mutator: impl FnOnce(Value) -> Result<(Value, Value), String>,
) -> ProjectServiceDispatchResponse {
    let mut response = Value::Null;
    let result =
        update_runtime_exchange(
            runtime_exchange_path(project_state_dir),
            |exchange| match mutator(exchange.clone()) {
                Ok((next, body)) => {
                    response = body;
                    next
                }
                Err(error) => {
                    response = json!({ "ok": false, "error": error });
                    exchange
                }
            },
        );
    match result {
        Ok(_) if response.get("ok") == Some(&Value::Bool(false)) => json_response(400, response),
        Ok(_) => json_response(200, response),
        Err(error) => json_response(500, json!({ "ok": false, "error": error })),
    }
}

fn route_recipients(body: &Value) -> Vec<String> {
    let explicit = string_array_field(body, "to");
    if !explicit.is_empty() {
        return unique(explicit.into_iter().map(Some).collect());
    }
    unique(vec![
        trimmed_string(body.get("assignee")),
        trimmed_string(body.get("tool")),
    ])
}

fn optional_string_or_first(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => trimmed_owned(value),
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str().and_then(trimmed_owned))
            .next(),
        _ => None,
    }
}

fn optional_string_array_field(value: &Value, field: &str) -> Option<Vec<String>> {
    value
        .get(field)
        .map(|value| string_array_from_value(Some(value)))
}

fn string_array_field(value: &Value, field: &str) -> Vec<String> {
    string_array_from_value(value.get(field))
}

fn string_array_from_value(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().and_then(trimmed_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn upsert_item(mut exchange: Value, key: &str, item: Value) -> Value {
    let id = string_field(&item, "id");
    let mut items = array_field(&exchange, key);
    items.retain(|existing| string_field(existing, "id") != id);
    items.push(item);
    object_insert_mut(&mut exchange, key, Value::Array(items));
    object_insert_mut(&mut exchange, "generatedAt", Value::String(now_iso()));
    exchange
}

fn map_array(mut exchange: Value, key: &str, mapper: impl FnMut(Value) -> Value) -> Value {
    let items = array_field(&exchange, key)
        .into_iter()
        .map(mapper)
        .collect();
    object_insert_mut(&mut exchange, key, Value::Array(items));
    exchange
}

fn find_by_id(exchange: &Value, key: &str, id: &str) -> Option<Value> {
    array_field(exchange, key)
        .into_iter()
        .find(|item| string_field(item, "id") == id)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn unique(values: Vec<Option<String>>) -> Vec<String> {
    let mut result = Vec::new();
    for value in values.into_iter().flatten() {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !result.iter().any(|item| item == trimmed) {
            result.push(trimmed.to_owned());
        }
    }
    result
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value
        && !value.trim().is_empty()
    {
        map.insert(key.into(), Value::String(value));
    }
}

fn object_insert_mut(value: &mut Value, key: &str, inserted: Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    if let Some(map) = value.as_object_mut() {
        if inserted.is_null() {
            map.remove(key);
        } else {
            map.insert(key.into(), inserted);
        }
    }
}

fn object_value(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn string_field(value: &Value, field: &str) -> String {
    string_field_with_default(value, field, "")
}

fn string_field_with_default(value: &Value, field: &str, default_value: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or(default_value)
        .to_owned()
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(trimmed_owned)
}

fn trimmed_owned(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn positive_integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).filter(|value| *value > 0)
}

fn strip_prefix<'a>(value: &'a str, prefix: &str) -> &'a str {
    value.strip_prefix(prefix).unwrap_or(value)
}

fn strip_revision_prefix(value: &str) -> String {
    let Some(rest) = value.strip_prefix("Revision ") else {
        return value.to_owned();
    };
    let Some((number, remainder)) = rest.split_once(": ") else {
        return value.to_owned();
    };
    if number.chars().all(|char| char.is_ascii_digit()) {
        remainder.to_owned()
    } else {
        value.to_owned()
    }
}

fn random_id(prefix: &str) -> String {
    format!("{prefix}-{}", base36_sequence())
}

fn base36_sequence() -> String {
    let value = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u128)
        ^ (u128::from(std::process::id()) << 32)
        ^ u128::from(ID_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    base36(value)
}

fn base36(mut value: u128) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(match digit {
            0..=9 => (b'0' + digit) as char,
            _ => (b'a' + digit - 10) as char,
        });
        value /= 36;
    }
    digits.into_iter().rev().collect()
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
