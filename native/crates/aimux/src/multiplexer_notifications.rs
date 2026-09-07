use serde_json::{Map, Value, json};

pub fn run_multiplexer_notifications_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "applyCoordinationModel" => run_apply_coordination_model(input),
        "applyCoordinationFilter" => run_apply_coordination_filter(input),
        "notificationTargetLabel+notificationTargetState" => {
            run_notification_target_label_and_state(input)
        }
        "notificationMutationInputForItem" => run_notification_mutation_inputs(input),
        _ => Value::Null,
    }
}

fn run_apply_coordination_model(input: &Value) -> Value {
    let mut host = object_field(input, "initialHost");
    let payload = input.get("payload").unwrap_or(&Value::Null);
    apply_coordination_model(&mut host, payload);
    json!({
        "threadEntries": host.remove("threadEntries").unwrap_or_else(|| json!([])),
        "coordinationModel": host.remove("coordinationModel").unwrap_or_else(|| json!({ "items": [] })),
        "notificationEntries": host.remove("notificationEntries").unwrap_or_else(|| json!([])),
        "notificationRowMeta": host.remove("notificationRowMeta").unwrap_or_else(|| json!([])),
        "coordinationWorklistAll": host.remove("coordinationWorklistAll").unwrap_or_else(|| json!([])),
        "coordinationWorklist": host.remove("coordinationWorklist").unwrap_or_else(|| json!([])),
        "coordinationLoaded": host.remove("coordinationLoaded").unwrap_or(Value::Bool(false)),
        "coordinationIndex": host.remove("coordinationIndex").unwrap_or(Value::Number((-1).into())),
        "notificationIndex": host.remove("notificationIndex").unwrap_or(Value::Number((-1).into())),
    })
}

fn run_apply_coordination_filter(input: &Value) -> Value {
    let mut host = object_field(input, "initialHost");
    apply_coordination_filter(&mut host);
    json!({
        "coordinationFilter": host.remove("coordinationFilter").unwrap_or_else(|| Value::String("all".to_owned())),
        "coordinationWorklist": host.remove("coordinationWorklist").unwrap_or_else(|| json!([])),
        "coordinationIndex": host.remove("coordinationIndex").unwrap_or(Value::Number((-1).into())),
        "notificationIndex": host.remove("notificationIndex").unwrap_or(Value::Number((-1).into())),
    })
}

fn apply_coordination_model(host: &mut Map<String, Value>, payload: &Value) {
    let model = payload
        .get("model")
        .cloned()
        .unwrap_or_else(|| json!({ "items": [] }));
    let items = array_path(payload, &["model", "items"]);

    host.insert(
        "threadEntries".to_owned(),
        payload.get("threads").cloned().unwrap_or_else(|| json!([])),
    );
    host.insert("coordinationModel".to_owned(), model);
    host.insert(
        "notificationEntries".to_owned(),
        Value::Array(
            items
                .iter()
                .flat_map(|item| array_field(item, "notifications").into_iter())
                .collect(),
        ),
    );
    host.insert(
        "notificationRowMeta".to_owned(),
        Value::Array(
            items
                .iter()
                .flat_map(|item| {
                    let meta = json!({
                        "reachability": item.get("reachability").cloned().unwrap_or(Value::Null),
                        "stale": item.get("stale").cloned().unwrap_or(Value::Bool(false)),
                        "actionable": item.get("actionable").cloned().unwrap_or(Value::Bool(false)),
                    });
                    array_field(item, "notifications")
                        .into_iter()
                        .map(move |_| meta.clone())
                })
                .collect(),
        ),
    );
    host.insert(
        "coordinationWorklistAll".to_owned(),
        Value::Array(array_path(payload, &["worklist", "items"])),
    );
    host.insert("coordinationLoaded".to_owned(), Value::Bool(true));
    apply_coordination_filter(host);
}

fn apply_coordination_filter(host: &mut Map<String, Value>) {
    let all = host
        .get("coordinationWorklistAll")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let filtered = if host.get("coordinationFilter").and_then(Value::as_str) == Some("threads") {
        all.into_iter()
            .filter(|item| item.get("kind").and_then(Value::as_str) == Some("thread"))
            .collect::<Vec<_>>()
    } else {
        all
    };
    let length = filtered.len() as i64;
    host.insert("coordinationWorklist".to_owned(), Value::Array(filtered));

    let coordination_index = host
        .get("coordinationIndex")
        .and_then(Value::as_i64)
        .filter(|index| *index < length)
        .unwrap_or_else(|| if length > 0 { (length - 1).max(0) } else { -1 });
    host.insert(
        "coordinationIndex".to_owned(),
        Value::Number(coordination_index.into()),
    );

    let notification_count = host
        .get("notificationEntries")
        .and_then(Value::as_array)
        .map(|entries| entries.len() as i64)
        .unwrap_or(0);
    let notification_index = host
        .get("notificationIndex")
        .and_then(Value::as_i64)
        .map(|index| {
            if index >= notification_count {
                (notification_count - 1).max(0)
            } else {
                index
            }
        })
        .unwrap_or_else(|| if notification_count > 0 { 0 } else { -1 });
    host.insert(
        "notificationIndex".to_owned(),
        Value::Number(notification_index.into()),
    );
}

fn run_notification_target_label_and_state(input: &Value) -> Value {
    let host = input.get("host").unwrap_or(&Value::Null);
    Value::Array(
        input
            .get("targets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|target| {
                let session_id = target.as_str();
                json!({
                    "target": target,
                    "label": notification_target_label(host, session_id),
                    "state": notification_target_state(host, session_id),
                })
            })
            .collect(),
    )
}

fn notification_target_label(host: &Value, session_id: Option<&str>) -> Value {
    let Some(session_id) = session_id else {
        return Value::Null;
    };
    if let Some(session) = find_session_target(host, session_id) {
        return Value::String(format_target_label(session, false));
    }
    if let Some(service) = find_service_target(host, session_id) {
        return Value::String(format_target_label(service, true));
    }
    Value::Null
}

fn notification_target_state(host: &Value, session_id: Option<&str>) -> &'static str {
    let Some(session_id) = session_id else {
        return "none";
    };
    if let Some(session) = find_session_target(host, session_id) {
        return match session.get("status").and_then(Value::as_str) {
            Some("offline" | "exited") => "offline",
            _ => "live",
        };
    }
    if let Some(service) = find_service_target(host, session_id) {
        return if service.get("status").and_then(Value::as_str) == Some("running") {
            "live"
        } else {
            "offline"
        };
    }
    "missing"
}

fn format_target_label(target: &Value, service: bool) -> String {
    let base = target
        .get("label")
        .and_then(Value::as_str)
        .or_else(|| target.get("command").and_then(Value::as_str))
        .unwrap_or("undefined");
    let kind = if service { " [service]" } else { "" };
    let worktree = target
        .get("worktreeName")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| format!(" · {value}"))
        .unwrap_or_default();
    format!("{base}{kind}{worktree}")
}

fn find_session_target<'a>(host: &'a Value, session_id: &str) -> Option<&'a Value> {
    ["sessions", "teammates"]
        .into_iter()
        .flat_map(|field| {
            host.get(field)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(session_id))
}

fn find_service_target<'a>(host: &'a Value, session_id: &str) -> Option<&'a Value> {
    host.get("services")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(session_id))
}

fn run_notification_mutation_inputs(input: &Value) -> Value {
    Value::Array(
        input
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(notification_mutation_input_for_item)
            .collect(),
    )
}

fn notification_mutation_input_for_item(item: &Value) -> Value {
    let Some(note) = item.get("notification") else {
        return Value::Null;
    };
    if let Some(session_id) = item
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|session_id| !session_id.is_empty())
    {
        return json!({ "sessionId": session_id });
    }
    Value::Object(Map::from_iter([(
        "ids".to_owned(),
        Value::Array(
            note.get("notifications")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|record| {
                    record
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(|id| Value::String(id.to_owned()))
                })
                .collect(),
        ),
    )]))
}

fn object_field(value: &Value, field: &str) -> Map<String, Value> {
    value
        .get(field)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn array_path(value: &Value, path: &[&str]) -> Vec<Value> {
    path.iter()
        .try_fold(value, |current, field| current.get(*field))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
