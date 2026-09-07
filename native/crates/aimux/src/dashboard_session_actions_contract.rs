use serde_json::{Value, json};

pub fn run_dashboard_session_actions_contract_case(input: &Value) -> Value {
    let mut calls = Vec::new();
    let result = match string_field(input, "api") {
        "resumeOfflineSessionWithFeedback" => {
            resume_offline_session_with_feedback(input, &mut calls)
        }
        "stopSessionToOfflineWithFeedback" => {
            stop_session_to_offline_with_feedback(input, &mut calls)
        }
        "graveyardSessionWithFeedback" => graveyard_session_with_feedback(input, &mut calls),
        api => panic!("unknown dashboard session-actions api: {api}"),
    };
    json!({
        "result": result,
        "runtime": runtime_output(input),
        "calls": calls,
    })
}

fn resume_offline_session_with_feedback(input: &Value, calls: &mut Vec<Value>) -> Value {
    let session = value_field(input, "session");
    let session_id = string_field(session, "id");
    let label = string_field_opt(session, "label")
        .unwrap_or_else(|| string_field(session, "command").to_owned());

    if input
        .get("pendingActions")
        .and_then(|values| values.get(session_id))
        .and_then(Value::as_str)
        == Some("starting")
    {
        return Value::String("pending".to_owned());
    }

    calls.push(json!(["setPendingAction", session_id, "starting"]));
    calls.push(json!(["setFooterFlash", format!("Restoring {label}"), 3]));
    calls.push(json!(["renderDashboard"]));
    calls.push(json!(["resumeOfflineSession", session]));

    if input.get("resumeRejects").is_some() {
        calls.push(json!(["setPendingAction", session_id, null]));
        calls.push(json!(["refreshLocalDashboardModel"]));
        calls.push(json!([
            "setFooterFlash",
            format!("Failed to restore {label}"),
            4
        ]));
        calls.push(json!(["renderDashboard"]));
        return Value::String("failed".to_owned());
    }

    let started = wait_for_session_start(input, session_id, calls);
    calls.push(json!(["setPendingAction", session_id, null]));
    calls.push(json!(["refreshLocalDashboardModel"]));
    calls.push(json!([
        "setFooterFlash",
        if started {
            format!("Restored {label}")
        } else {
            format!("Failed to restore {label}")
        },
        3
    ]));
    calls.push(json!(["renderDashboard"]));
    Value::String(if started { "settled" } else { "failed" }.to_owned())
}

fn wait_for_session_start(input: &Value, session_id: &str, calls: &mut Vec<Value>) -> bool {
    if input.get("startedRuntime").and_then(Value::as_bool) == Some(true) {
        calls.push(json!(["getRuntimeById", session_id]));
        calls.push(json!(["isSessionRuntimeLive", session_id]));
        return input.get("runtimeLive").and_then(Value::as_bool) == Some(true);
    }

    if input.get("fastClock").and_then(Value::as_bool) == Some(true) {
        for _ in 0..7 {
            calls.push(json!(["getRuntimeById", session_id]));
        }
    }
    false
}

fn stop_session_to_offline_with_feedback(input: &Value, calls: &mut Vec<Value>) -> Value {
    let runtime = value_field(input, "runtime");
    let session_id = string_field(runtime, "id");
    let label =
        label_for(input, session_id).unwrap_or_else(|| string_field(runtime, "command").to_owned());

    calls.push(json!(["setPendingAction", session_id, "stopping"]));
    calls.push(json!(["stopSessionToOffline", session_id]));
    if input.get("stopRejects").is_some() {
        calls.push(json!(["setPendingAction", session_id, null]));
        calls.push(json!([
            "showDashboardError",
            format!("Failed to stop \"{label}\""),
            []
        ]));
        return Value::Null;
    }
    if input
        .get("graveyardAfterStop")
        .and_then(|values| values.get(session_id))
        .and_then(Value::as_bool)
        != Some(true)
    {
        calls.push(json!(["setPendingAction", session_id, null]));
    }
    calls.push(json!(["refreshLocalDashboardModel"]));
    calls.push(json!(["setFooterFlash", format!("Stopped {label}"), 3]));
    calls.push(json!(["renderDashboard"]));
    Value::Null
}

fn graveyard_session_with_feedback(input: &Value, calls: &mut Vec<Value>) -> Value {
    if input.get("session").is_none() {
        return Value::Null;
    }
    let session = value_field(input, "session");
    let session_id = string_field(input, "sessionId");
    let label = label_for(input, session_id)
        .or_else(|| string_field_opt(session, "label"))
        .unwrap_or_else(|| string_field(session, "command").to_owned());
    calls.push(json!(["setPendingAction", session_id, "graveyarding"]));
    calls.push(json!(["sendAgentToGraveyard", session_id]));
    if input.get("graveyardRejects").is_some() {
        calls.push(json!(["setPendingAction", session_id, null]));
        calls.push(json!([
            "showDashboardError",
            format!("Failed to graveyard \"{label}\""),
            []
        ]));
        return Value::Null;
    }
    calls.push(json!(["setPendingAction", session_id, null]));
    calls.push(json!(["refreshLocalDashboardModel"]));
    calls.push(json!([
        "adjustAfterRemove",
        input
            .get("hasWorktrees")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    ]));
    calls.push(json!([
        "setFooterFlash",
        format!("Sent {label} to graveyard"),
        3
    ]));
    calls.push(json!(["renderDashboard"]));
    Value::Null
}

fn runtime_output(input: &Value) -> Value {
    input
        .get("runtime")
        .map(|runtime| {
            json!({
                "id": string_field(runtime, "id"),
                "command": string_field(runtime, "command"),
                "exited": input.get("stopTriggersExit").and_then(Value::as_bool) == Some(true),
            })
        })
        .unwrap_or(Value::Null)
}

fn label_for(input: &Value, session_id: &str) -> Option<String> {
    input
        .get("labels")
        .and_then(|labels| labels.get(session_id))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}"))
}

fn string_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing string field {field}"))
}

fn string_field_opt(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
