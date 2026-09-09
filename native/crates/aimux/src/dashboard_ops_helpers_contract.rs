use serde_json::{Value, json};

pub fn run_dashboard_ops_helpers_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "runDashboardOperation" => run_dashboard_operation(input),
        "clearDashboardSubscreens" => clear_dashboard_subscreens(),
        "waitForSessionStartForHost" => wait_for_session_start_for_host(input),
        api => panic!("unknown dashboard ops helper api: {api}"),
    }
}

fn run_dashboard_operation(input: &Value) -> Value {
    let title = string_field(input, "title");
    let lines = input.get("lines").cloned().unwrap_or_else(|| json!([]));
    let error_title = optional_string(input, "errorTitle").unwrap_or_else(|| title.clone());
    let result = input.get("workResult").cloned().unwrap_or(Value::Null);
    json!({
        "result": result,
        "error": Value::Null,
        "calls": [
            {
                "method": "dashboardFeedback.runOperation",
                "args": [title, lines, Value::Null, error_title],
            },
            { "method": "work", "args": [] },
        ],
    })
}

fn clear_dashboard_subscreens() -> Value {
    json!({
        "calls": [{ "method": "dashboardState.resetSubscreen", "args": [] }],
    })
}

fn wait_for_session_start_for_host(input: &Value) -> Value {
    if input.get("runtimePresent").and_then(Value::as_bool) == Some(true)
        && input.get("runtimeLive").and_then(Value::as_bool) == Some(true)
    {
        let session_id = string_field(input, "sessionId");
        json!({
            "result": true,
            "calls": [{
                "method": "isSessionRuntimeLive",
                "args": [{ "id": session_id, "command": "codex" }],
            }],
        })
    } else {
        json!({ "result": false, "calls": [] })
    }
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_field(value: &Value, key: &str) -> String {
    optional_string(value, key).unwrap_or_default()
}
