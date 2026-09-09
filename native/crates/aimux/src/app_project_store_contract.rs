use serde_json::{Value, json};

pub fn run_app_project_store_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "emptyProjectObservability" => empty_project_observability(),
        "projectPlanResourceKey" => json!(
            array_field(input, "cases")
                .iter()
                .map(|case| format!(
                    "{}\0{}",
                    str_field(case, "projectPath"),
                    str_field(case, "sessionId")
                ))
                .collect::<Vec<_>>()
        ),
        "isCurrentProjectResourceRequest" => json!(
            array_field(input, "cases")
                .iter()
                .map(|case| is_current_project_resource_request(
                    case,
                    input.get("current").unwrap_or(&Value::Null)
                ))
                .collect::<Vec<_>>()
        ),
        "projectResourceRequestKey" => json!(project_resource_request_keys(input)),
        api => panic!("unknown app project store contract api: {api}"),
    }
}

fn empty_project_observability() -> Value {
    json!({
        "summary": {
            "agentsRunning": 0,
            "agentsWaiting": 0,
            "agentsOffline": 0,
            "services": 0,
            "worktrees": 0,
            "openTasks": 0,
            "doneTasks": 0,
            "unreadNotifications": 0,
        },
        "progress": {
            "pending": 0,
            "assigned": 0,
            "in_progress": 0,
            "blocked": 0,
            "done": 0,
            "failed": 0,
            "total": 0,
        },
        "story": [],
    })
}

fn is_current_project_resource_request(request: &Value, current: &Value) -> bool {
    str_field(request, "projectPath") == str_field(current, "projectPath")
        && endpoint_key(request) == endpoint_key(current)
        && number_field(request, "generation") == number_field(current, "generation")
}

fn project_resource_request_keys(input: &Value) -> Vec<String> {
    let mut sequence = 0;
    array_field(input, "cases")
        .iter()
        .map(|case| {
            let request = case.get("request").unwrap_or(&Value::Null);
            let request_sequence = match case.get("sequence").and_then(Value::as_i64) {
                Some(value) => value,
                None => {
                    sequence += 1;
                    sequence
                }
            };
            format!(
                "{}\0{}\0{}\0<scope:1>\0{}",
                str_field(request, "projectPath"),
                endpoint_key(request).unwrap_or_default(),
                number_field(request, "generation"),
                request_sequence
            )
        })
        .collect()
}

fn endpoint_key(value: &Value) -> Option<&str> {
    value.get("endpointKey").and_then(Value::as_str)
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}
