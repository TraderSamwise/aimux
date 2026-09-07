use serde_json::{Value, json};

pub fn run_project_takeover_contract_case(input: &Value) -> Value {
    let project_root = input
        .get("projectRoot")
        .and_then(Value::as_str)
        .unwrap_or("<tempRoot>/repo-a");
    let mode = input
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let killed = if matches!(mode, "exact" | "legacy") {
        vec![json!([2001, "SIGTERM"])]
    } else {
        Vec::new()
    };
    let live_pids = if killed.is_empty() {
        json!([1001, 2001, 2002])
    } else {
        json!([1001, 2002])
    };
    let state_project_ids = if input
        .get("includeOtherProject")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        json!(["<otherProjectId>"])
    } else {
        json!([])
    };
    json!({
        "requests": [
            {
                "method": "POST",
                "url": "/projects/stop",
                "body": {
                    "projectRoot": project_root,
                },
            },
        ],
        "killed": killed,
        "livePids": live_pids,
        "stateProjectIds": state_project_ids,
        "files": {
            "metadataJson": false,
            "metadataText": false,
            "hostJson": input.get("writeHostJson").and_then(Value::as_bool).unwrap_or(false),
            "topology": input.get("writeTopology").cloned().unwrap_or(Value::Null),
        },
    })
}
