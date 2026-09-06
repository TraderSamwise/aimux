use serde_json::Value;

use super::{
    array, coalesce_string, field, filtered_objects, js_string, nullish_chain, object, truthy,
};

pub fn render_core_thread_list_lines(payload: &Value) -> Vec<String> {
    let summaries = filtered_objects(array(payload, "summaries"));
    if summaries.is_empty() {
        return vec!["No threads found.".into()];
    };
    let mut lines = Vec::new();
    for summary in summaries {
        let thread = summary.get("thread").and_then(Value::as_object);
        let latest = summary.get("latestMessage").and_then(Value::as_object);
        let unread = thread
            .and_then(|thread| thread.get("unreadBy"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let waiting = thread
            .and_then(|thread| thread.get("waitingOn"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        lines.push(format!(
            "{}  {}  {}{}{}",
            coalesce_string(thread.and_then(|thread| thread.get("id")), "?"),
            coalesce_string(thread.and_then(|thread| thread.get("kind")), "?"),
            coalesce_string(thread.and_then(|thread| thread.get("status")), "?"),
            if unread > 0 {
                format!(" unread={unread}")
            } else {
                "".into()
            },
            if waiting.is_empty() {
                "".into()
            } else {
                format!(
                    " waiting={}",
                    waiting
                        .iter()
                        .map(|value| js_string(Some(value)))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
        ));
        lines.push(format!(
            "  {}",
            coalesce_string(thread.and_then(|thread| thread.get("title")), "")
        ));
        if let Some(message) = latest {
            lines.push(format!(
                "  latest: {} [{}] {}",
                coalesce_string(message.get("from"), "?"),
                coalesce_string(message.get("kind"), "?"),
                coalesce_string(message.get("body"), "")
            ));
        }
    }
    lines
}

pub fn render_core_thread_show_lines(payload: &Value) -> Vec<String> {
    let thread = object(payload, "thread");
    let participants = thread
        .and_then(|thread| thread.get("participants"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let waiting = thread
        .and_then(|thread| thread.get("waitingOn"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut lines = vec![
        format!(
            "{} ({})",
            coalesce_string(thread.and_then(|thread| thread.get("title")), ""),
            coalesce_string(thread.and_then(|thread| thread.get("kind")), "?")
        ),
        format!(
            "id: {}",
            coalesce_string(thread.and_then(|thread| thread.get("id")), "?")
        ),
        format!(
            "status: {}",
            coalesce_string(thread.and_then(|thread| thread.get("status")), "?")
        ),
        format!(
            "participants: {}",
            participants
                .iter()
                .map(|value| js_string(Some(value)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ];
    if truthy(thread.and_then(|thread| thread.get("owner"))) {
        lines.push(format!(
            "owner: {}",
            js_string(thread.and_then(|thread| thread.get("owner")))
        ));
    }
    if !waiting.is_empty() {
        lines.push(format!(
            "waitingOn: {}",
            waiting
                .iter()
                .map(|value| js_string(Some(value)))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    lines.push("".into());
    for message in filtered_objects(array(payload, "messages")) {
        lines.push(format!(
            "{}  {} [{}]",
            coalesce_string(message.get("ts"), "?"),
            coalesce_string(message.get("from"), "?"),
            coalesce_string(message.get("kind"), "?")
        ));
        lines.push(format!("  {}", coalesce_string(message.get("body"), "")));
    }
    lines
}

pub fn render_core_thread_open_lines(payload: &Value) -> Vec<String> {
    vec![js_string(
        field(payload, "thread").and_then(|thread| field(thread, "id")),
    )]
}

pub fn render_core_thread_send_lines(payload: &Value) -> Vec<String> {
    vec![js_string(
        field(payload, "message").and_then(|message| field(message, "id")),
    )]
}

pub fn render_core_thread_mark_seen_lines() -> Vec<String> {
    vec!["ok".into()]
}

pub fn render_core_thread_status_lines(payload: &Value) -> Vec<String> {
    vec![
        format!(
            "thread {}",
            js_string(field(payload, "thread").and_then(|thread| field(thread, "id")))
        ),
        format!(
            "status {}",
            js_string(field(payload, "thread").and_then(|thread| field(thread, "status")))
        ),
    ]
}

pub fn render_core_message_send_lines(payload: &Value) -> Vec<String> {
    let mut lines = vec![
        format!(
            "thread {}",
            js_string(field(payload, "thread").and_then(|thread| field(thread, "id")))
        ),
        format!(
            "message {}",
            js_string(field(payload, "message").and_then(|message| field(message, "id")))
        ),
    ];
    let delivered = array(payload, "deliveredTo");
    if !delivered.is_empty() {
        lines.push(format!(
            "delivered {}",
            delivered
                .iter()
                .map(|value| js_string(Some(value)))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    lines
}

pub fn render_core_handoff_send_lines(payload: &Value) -> Vec<String> {
    render_core_message_send_lines(payload)
}

pub fn render_core_handoff_mutation_lines(payload: &Value) -> Vec<String> {
    vec![
        format!(
            "thread {}",
            js_string(field(payload, "thread").and_then(|thread| field(thread, "id")))
        ),
        format!(
            "message {}",
            js_string(field(payload, "message").and_then(|message| field(message, "id")))
        ),
    ]
}

pub fn render_core_task_list_lines(payload: &Value) -> Vec<String> {
    let tasks = filtered_objects(array(payload, "tasks"));
    if tasks.is_empty() {
        return vec!["No tasks found.".into()];
    };
    let mut lines = Vec::new();
    for task in tasks {
        let target = nullish_chain(&[
            task.get("assignedTo"),
            task.get("assignee"),
            task.get("tool"),
        ])
        .map(|value| js_string(Some(value)))
        .unwrap_or_else(|| "unassigned".into());
        let thread = if truthy(task.get("threadId")) {
            format!(" thread={}", js_string(task.get("threadId")))
        } else {
            "".into()
        };
        lines.push(format!(
            "{}  {}  {}  target={target}{thread}",
            js_string(task.get("id")),
            coalesce_string(task.get("type"), "task"),
            js_string(task.get("status"))
        ));
        lines.push(format!(
            "  {}",
            coalesce_string(task.get("description"), "")
        ));
    }
    lines
}

pub fn render_core_task_show_lines(payload: &Value) -> Vec<String> {
    let task = object(payload, "task");
    let mut lines = vec![
        format!(
            "{} ({})",
            coalesce_string(task.and_then(|task| task.get("description")), ""),
            coalesce_string(task.and_then(|task| task.get("type")), "task")
        ),
        format!("id: {}", js_string(task.and_then(|task| task.get("id")))),
        format!(
            "status: {}",
            js_string(task.and_then(|task| task.get("status")))
        ),
        format!(
            "assignedBy: {}",
            js_string(task.and_then(|task| task.get("assignedBy")))
        ),
    ];
    for (key, label) in [
        ("assignedTo", "assignedTo"),
        ("assignee", "assignee"),
        ("tool", "tool"),
        ("threadId", "thread"),
        ("reviewStatus", "reviewStatus"),
        ("reviewFeedback", "reviewFeedback"),
        ("result", "result"),
        ("error", "error"),
    ] {
        if truthy(task.and_then(|task| task.get(key))) {
            lines.push(format!(
                "{label}: {}",
                js_string(task.and_then(|task| task.get(key)))
            ));
        }
    }
    lines.push("".into());
    lines.push(coalesce_string(
        task.and_then(|task| task.get("prompt")),
        "",
    ));
    lines
}

pub fn render_core_task_mutation_lines(payload: &Value) -> Vec<String> {
    let task = object(payload, "task");
    let thread = object(payload, "thread");
    let mut lines = vec![format!(
        "task {}",
        js_string(task.and_then(|task| task.get("id")))
    )];
    if truthy(thread.and_then(|thread| thread.get("id"))) {
        lines.push(format!(
            "thread {}",
            js_string(thread.and_then(|thread| thread.get("id")))
        ));
    }
    lines
}

pub fn render_core_review_request_changes_lines(payload: &Value) -> Vec<String> {
    let mut lines = render_core_task_mutation_lines(payload);
    if truthy(field(payload, "followUpTask").and_then(|task| field(task, "id"))) {
        lines.insert(
            1,
            format!(
                "follow-up {}",
                js_string(field(payload, "followUpTask").and_then(|task| field(task, "id")))
            ),
        );
    }
    lines
}
