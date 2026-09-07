use serde_json::{Value, json};

pub fn run_dashboard_model_services_lifecycle_contract_case(input: &Value) -> Value {
    let calls = lifecycle_calls(input);
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();

    if api == "startProjectServices" {
        return json!({
            "result": Value::Null,
            "host": {
                "projectServiceStartupMetadataSettling": input.get("projectServiceStartupMetadataSettling").cloned().unwrap_or(Value::Null),
                "projectServiceUiRefreshPending": input.get("projectServiceUiRefreshPending").cloned().unwrap_or(Value::Null),
                "projectServiceUiRefreshTimer": Value::Null,
                "metadataServer": if input.get("metadataServer").and_then(Value::as_bool) == Some(true) { json!("set") } else { Value::Null },
                "loopWatcher": Value::Null,
                "scribeWatcher": Value::Null,
                "transcriptReconciler": Value::Null,
                "pluginRuntime": Value::Null,
                "endpointPresence": endpoint_presence(input, false),
                "calls": calls,
            },
        });
    }

    json!({
        "result": Value::Null,
        "host": {
            "projectServiceStartupMetadataSettling": false,
            "projectServiceUiRefreshPending": false,
            "projectServiceUiRefreshTimer": Value::Null,
            "metadataServer": Value::Null,
            "loopWatcher": Value::Null,
            "scribeWatcher": Value::Null,
            "transcriptReconciler": Value::Null,
            "pluginRuntime": Value::Null,
            "endpointPresence": endpoint_presence(input, true),
            "calls": calls,
        },
    })
}

fn lifecycle_calls(input: &Value) -> Vec<Value> {
    if input.get("api").and_then(Value::as_str) == Some("startProjectServices") {
        return Vec::new();
    }
    let mut calls = Vec::new();
    if input.get("metadataServer").and_then(Value::as_bool) == Some(true) {
        calls.push(json!({ "method": "metadataServer.stop", "args": [] }));
    }
    if input.get("loopWatcher").and_then(Value::as_bool) == Some(true) {
        calls.push(json!({ "method": "loopWatcher.stop", "args": [] }));
    }
    if input.get("scribeWatcher").and_then(Value::as_bool) == Some(true) {
        calls.push(json!({ "method": "scribeWatcher.stop", "args": [] }));
    }
    if input.get("transcriptReconciler").and_then(Value::as_bool) == Some(true) {
        calls.push(json!({ "method": "transcriptReconciler.stop", "args": [] }));
    }
    if input.get("pluginRuntime").and_then(Value::as_bool) == Some(true) {
        calls.push(json!({ "method": "pluginRuntime.stop", "args": [] }));
    }
    calls
}

fn endpoint_presence(input: &Value, after_stop: bool) -> Value {
    let Some(endpoint) = input.get("endpoint") else {
        return endpoint_flags(false);
    };
    if after_stop
        && input.get("metadataServer").and_then(Value::as_bool) == Some(true)
        && endpoint.get("pid").and_then(Value::as_str) == Some("<PID>")
    {
        return endpoint_flags(false);
    }
    endpoint_flags(true)
}

fn endpoint_flags(present: bool) -> Value {
    json!({ "json": present, "text": present, "host": false })
}
