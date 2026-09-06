use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

pub fn runtime_exchange_import_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "buildRuntimeExchangeFromLegacySnapshot" => {
            build_runtime_exchange_from_legacy_snapshot(&case["input"])
        }
        "importRuntimeExchangeFromLegacyFiles" if case["input"].get("files").is_some() => {
            let exchange = build_runtime_exchange_from_legacy_snapshot(&snapshot_from_files(&case["input"]));
            json!({
                "threadIds": ids(&exchange["threads"]),
                "messageIds": ids(&exchange["messages"]),
                "taskIds": ids(&exchange["tasks"]),
                "waitIds": ids(&exchange["waits"]),
                "planRefIds": ids(&exchange["planRefs"]),
                "continuityKinds": sorted_strings(&exchange["continuityRefs"], "kind"),
                "attachmentRefIds": ids(&exchange["attachmentRefs"]),
            })
        }
        "importRuntimeExchangeFromLegacyFiles" => {
            json!({ "continuityRefs": [], "recordingsDirExists": false })
        }
        _ => Value::Null,
    }
}

pub fn build_runtime_exchange_from_legacy_snapshot(input: &Value) -> Value {
    let now = string_field(input, "now").unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
    let threads = array_field(input, "threads");
    let tasks = array_field(input, "tasks");
    json!({
        "version": 1,
        "generatedAt": now,
        "threads": threads.iter().map(to_exchange_thread).collect::<Vec<_>>(),
        "messages": array_field(input, "messages").iter().map(to_exchange_message).collect::<Vec<_>>(),
        "tasks": tasks.iter().map(to_exchange_task).collect::<Vec<_>>(),
        "handoffs": threads.iter().filter_map(build_handoff).collect::<Vec<_>>(),
        "reviews": tasks.iter().filter_map(build_review).collect::<Vec<_>>(),
        "waits": threads.iter().filter_map(build_thread_wait).collect::<Vec<_>>(),
        "inbox": threads.iter().flat_map(build_inbox_entries).collect::<Vec<_>>(),
        "planRefs": string_array_field(input, "planPaths").iter().map(|path| plan_ref_from_path(path, &now)).collect::<Vec<_>>(),
        "continuityRefs": continuity_paths(input).iter().map(|path| continuity_ref_from_path(path, &now)).collect::<Vec<_>>(),
        "attachmentRefs": array_field(input, "attachments").iter().map(attachment_ref_from_record).collect::<Vec<_>>(),
    })
}

fn snapshot_from_files(input: &Value) -> Value {
    let files = &input["files"];
    json!({
        "now": input["now"],
        "threads": [files["thread"].clone()],
        "messages": [files["message"].clone()],
        "tasks": [files["task"].clone()],
        "planPaths": [files["planPath"].clone()],
        "historyPaths": [files["historyPath"].clone()],
        "contextPaths": [files["contextPath"].clone()],
        "recordingPaths": [],
        "statusPaths": [files["statusPath"].clone()],
        "attachments": [files["attachment"].clone()],
    })
}

fn to_exchange_thread(thread: &Value) -> Value {
    copy_fields(
        thread,
        &[
            "id",
            "title",
            "kind",
            "status",
            "createdAt",
            "updatedAt",
            "createdBy",
            "participants",
            "owner",
            "waitingOn",
            "worktreePath",
            "taskId",
            "relatedPlanIds",
            "lastMessageId",
            "unreadBy",
            "tags",
        ],
    )
}

fn to_exchange_message(message: &Value) -> Value {
    copy_fields(
        message,
        &[
            "id",
            "threadId",
            "ts",
            "from",
            "to",
            "kind",
            "body",
            "taskId",
            "planId",
            "metadata",
            "deliveredTo",
            "deliveredAt",
        ],
    )
}

fn to_exchange_task(task: &Value) -> Value {
    let mut output = copy_fields(
        task,
        &[
            "id",
            "status",
            "assignedBy",
            "assignedTo",
            "assignee",
            "assigner",
            "threadId",
            "tool",
            "description",
            "prompt",
            "result",
            "error",
            "createdAt",
            "updatedAt",
            "notifiedAt",
            "type",
            "reviewFeedback",
            "diff",
            "iteration",
            "reviewOf",
        ],
    );
    if let Some(status) = normalize_review_status(task.get("reviewStatus")) {
        output["reviewStatus"] = Value::String(status);
    }
    output
}

fn build_handoff(thread: &Value) -> Option<Value> {
    if string_field(thread, "kind").as_deref() != Some("handoff") {
        return None;
    }
    let recipients = if !string_array_field(thread, "waitingOn").is_empty() {
        unique(string_array_field(thread, "waitingOn"))
    } else {
        let created_by = string_field(thread, "createdBy").unwrap_or_default();
        unique(
            string_array_field(thread, "participants")
                .into_iter()
                .filter(|id| id != &created_by)
                .collect(),
        )
    };
    if recipients.is_empty() {
        return None;
    }
    let status = match string_field(thread, "status").as_deref() {
        Some("done") => "completed",
        Some("abandoned") => "cancelled",
        _ => "waiting",
    };
    let mut output = json!({
        "id": format!("handoff:{}", string_field(thread, "id").unwrap_or_default()),
        "threadId": thread["id"],
        "status": status,
        "from": thread["createdBy"],
        "to": recipients,
        "createdAt": thread["createdAt"],
        "updatedAt": thread["updatedAt"],
    });
    if string_field(thread, "status").as_deref() == Some("open") {
        insert_optional(&mut output, "acceptedBy", string_field(thread, "owner"));
    }
    if string_field(thread, "status").as_deref() == Some("done") {
        insert_optional(&mut output, "completedBy", string_field(thread, "owner"));
    }
    Some(output)
}

fn build_review(task: &Value) -> Option<Value> {
    if string_field(task, "type").as_deref() != Some("review") {
        return None;
    }
    Some(json!({
        "id": format!("review:{}", string_field(task, "id").unwrap_or_default()),
        "taskId": task["id"],
        "reviewOf": task["reviewOf"],
        "reviewer": task.get("assignedTo").or_else(|| task.get("assignee")).cloned().unwrap_or(Value::Null),
        "status": normalize_review_status(task.get("reviewStatus")).unwrap_or_else(|| "pending".into()),
        "feedback": task.get("reviewFeedback").or_else(|| task.get("result")).cloned().unwrap_or(Value::Null),
        "createdAt": task["createdAt"],
        "updatedAt": task["updatedAt"],
    }))
}

fn build_thread_wait(thread: &Value) -> Option<Value> {
    let waiting_on = unique(string_array_field(thread, "waitingOn"));
    if waiting_on.is_empty() {
        return None;
    }
    let done = matches!(string_field(thread, "status").as_deref(), Some("done" | "abandoned"));
    let mut wait = json!({
        "id": format!("wait:thread:{}", string_field(thread, "id").unwrap_or_default()),
        "status": if done { "satisfied" } else { "waiting" },
        "subjectKind": "thread",
        "subjectId": thread["id"],
        "waitingOn": waiting_on,
        "owner": thread["owner"],
        "createdAt": thread["createdAt"],
        "updatedAt": thread["updatedAt"],
    });
    if done {
        wait["resolvedAt"] = thread["updatedAt"].clone();
    }
    Some(wait)
}

fn build_inbox_entries(thread: &Value) -> Vec<Value> {
    let waiting_on = string_array_field(thread, "waitingOn");
    let unread_by = string_array_field(thread, "unreadBy");
    unique(
        unread_by
            .iter()
            .chain(waiting_on.iter())
            .cloned()
            .collect::<Vec<_>>(),
    )
        .into_iter()
        .map(|participant| {
            let waiting = waiting_on.contains(&participant);
            let unread = unread_by.contains(&participant);
            json!({
                "id": format!("inbox:{participant}:thread:{}", string_field(thread, "id").unwrap_or_default()),
                "participantId": participant,
                "subjectKind": "thread",
                "subjectId": thread["id"],
                "state": if string_field(thread, "status").as_deref() == Some("blocked") {
                    "blocked"
                } else if waiting {
                    "waiting"
                } else {
                    "unread"
                },
                "urgency": (if waiting { 10 } else { 0 }) + (if unread { 3 } else { 0 }),
                "updatedAt": thread["updatedAt"],
            })
        })
        .collect()
}

fn plan_ref_from_path(path: &str, now: &str) -> Value {
    let session_id = basename(path).trim_end_matches(".md").to_owned();
    json!({
        "id": format!("plan:{session_id}"),
        "path": path,
        "ownerSessionId": session_id,
        "title": session_id,
        "createdAt": now,
        "updatedAt": now,
    })
}

fn continuity_ref_from_path(path: &str, now: &str) -> Value {
    let kind = continuity_kind_for_path(path);
    let file = basename(path);
    let session_id = file
        .trim_end_matches(".jsonl")
        .trim_end_matches(".md")
        .trim_end_matches(".txt")
        .to_owned();
    json!({
        "id": format!("{kind}:{session_id}:{file}"),
        "kind": kind,
        "path": path,
        "sessionId": session_id,
        "createdAt": now,
        "updatedAt": now,
    })
}

fn attachment_ref_from_record(record: &Value) -> Value {
    json!({
        "id": record["id"],
        "path": record["contentPath"],
        "contentUrl": format!("/attachments/{}/content", string_field(record, "id").unwrap_or_default()),
        "mediaType": record["mimeType"],
        "createdAt": record["createdAt"],
        "updatedAt": record["createdAt"],
    })
}

fn normalize_review_status(value: Option<&Value>) -> Option<String> {
    let normalized = value?.as_str()?.trim().to_ascii_lowercase().replace('-', "_");
    match normalized.as_str() {
        "approved" | "approve" => Some("approved".into()),
        "changes_requested" | "request_changes" => Some("changes_requested".into()),
        "pending" => Some("pending".into()),
        _ => None,
    }
}

fn continuity_kind_for_path(path: &str) -> &'static str {
    let normalized = path.replace('\\', "/");
    if normalized.contains("/recordings/") {
        "recording"
    } else if normalized.contains("/status/") {
        "status"
    } else if normalized.contains("/history/") {
        "history"
    } else {
        "context"
    }
}

fn continuity_paths(input: &Value) -> Vec<String> {
    ["historyPaths", "contextPaths", "recordingPaths", "statusPaths"]
        .into_iter()
        .flat_map(|key| string_array_field(input, key))
        .collect()
}

fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| string_field(item, "id"))
        .collect()
}

fn sorted_strings(value: &Value, key: &str) -> Vec<String> {
    let mut values = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| string_field(item, key))
        .collect::<Vec<_>>();
    values.sort();
    values
}

fn copy_fields(value: &Value, fields: &[&str]) -> Value {
    let mut output = Map::new();
    for field in fields {
        if let Some(value) = value.get(*field) {
            output.insert((*field).into(), value.clone());
        }
    }
    Value::Object(output)
}

fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut unique = Vec::new();
    for value in values {
        let value = value.trim().to_owned();
        if value.is_empty() || !seen.insert(value.clone()) {
            continue;
        }
        unique.push(value);
    }
    unique
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn insert_optional(value: &mut Value, key: &str, nested: Option<String>) {
    if let Some(nested) = nested {
        value[key] = Value::String(nested);
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_owned()
}
