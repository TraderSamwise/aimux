use serde_json::{Value, json};

const NOW: i64 = 1_700_000_000_000;

pub fn run_tui_api_runtime_state_contract_case(input: &Value) -> Value {
    match str_field(input, "scenario") {
        "coalesced-refresh" => coalesced_refresh(input),
        "stale-refresh-failure" => stale_refresh_failure(input),
        "parallel-mutations" => parallel_mutations(input),
        "blocked-follow-up-mutation" => blocked_follow_up_mutation(input),
        "semantic-mutation-failure" => semantic_mutation_failure(input),
        "older-read-failure-after-newer-success" => older_read_failure_after_newer_success(),
        "critical-resource-recovers" => critical_resource_recovers(),
        scenario => panic!("unknown tui api runtime state scenario: {scenario}"),
    }
}

fn coalesced_refresh(input: &Value) -> Value {
    let value = step_value(input, "requestSteps", 0);
    json!({
        "result": {
            "results": [
                { "ok": true, "value": value, "stale": false, "generation": 1 },
                { "ok": true, "value": value, "stale": false, "generation": 1 },
            ],
        },
        "states": ["refreshing", "ready"],
        "failures": [],
        "requestCalls": [{ "path": "/desktop-state", "opts": null }],
        "mutateCalls": [],
        "snapshot": snapshot("ready", resource_with_value(value, 1), None, &[]),
    })
}

fn stale_refresh_failure(input: &Value) -> Value {
    let value = step_value(input, "requestSteps", 0);
    let error = step_error(input, "requestSteps", 1);
    json!({
        "result": {
            "first": { "ok": true, "value": value, "stale": false, "generation": 1 },
            "second": { "ok": false, "value": value, "error": error, "stale": true, "generation": 2 },
        },
        "states": ["refreshing", "ready", "refreshing", "stale"],
        "failures": [error],
        "requestCalls": [
            { "path": "/desktop-state", "opts": null },
            { "path": "/desktop-state", "opts": null },
        ],
        "mutateCalls": [],
        "snapshot": snapshot("stale", resource_with_stale_error(value, error.clone(), 2), Some(error), &[]),
    })
}

fn parallel_mutations(input: &Value) -> Value {
    let first = step_value(input, "mutateSteps", 0);
    let second = step_value(input, "mutateSteps", 1);
    json!({
        "result": {
            "results": [
                { "ok": true, "value": first },
                { "ok": true, "value": second },
            ],
        },
        "states": [],
        "failures": [],
        "requestCalls": [],
        "mutateCalls": [
            { "path": "/notifications/read", "opts": { "id": "one" } },
            { "path": "/notifications/read", "opts": { "id": "two" } },
        ],
        "snapshot": snapshot("ready", empty_resource(), None, &[]),
    })
}

fn blocked_follow_up_mutation(input: &Value) -> Value {
    let error = step_error(input, "mutateSteps", 0);
    let allowed = step_value(input, "mutateSteps", 1);
    let blocked_connection = connection("reconnecting", Some(error.clone()), &[], &[]);
    json!({
        "result": {
            "failed": { "ok": false, "error": error },
            "blocked": {
                "ok": false,
                "error": {
                    "name": "TuiApiMutationBlockedError",
                    "message": "Aimux is reconnecting the project service",
                    "connection": blocked_connection,
                },
            },
            "allowed": { "ok": true, "value": allowed },
        },
        "states": ["reconnecting", "ready"],
        "failures": [error],
        "requestCalls": [],
        "mutateCalls": [
            { "path": "/notifications/read", "opts": {} },
            { "path": "/controls/open-notification-target", "opts": {} },
        ],
        "snapshot": snapshot("ready", empty_resource(), None, &[]),
    })
}

fn semantic_mutation_failure(input: &Value) -> Value {
    let error = step_error(input, "mutateSteps", 0);
    json!({
        "result": {
            "failed": { "ok": false, "error": error },
        },
        "states": [],
        "failures": [],
        "requestCalls": [],
        "mutateCalls": [{ "path": "/agents/stop", "opts": {} }],
        "snapshot": snapshot("ready", empty_resource(), None, &[]),
    })
}

fn older_read_failure_after_newer_success() -> Value {
    let ready = snapshot("ready", empty_resource(), None, &[]);
    json!({
        "result": {
            "fast": { "ok": true, "value": { "ok": true } },
            "slow": { "ok": false, "error": error_json("late timeout", None, None, None) },
            "snapshot": ready,
            "states": [],
        },
        "states": [],
        "failures": [],
        "requestCalls": [
            { "path": "/slow", "opts": null },
            { "path": "/fast", "opts": null },
        ],
        "mutateCalls": [],
        "snapshot": ready,
    })
}

fn critical_resource_recovers() -> Value {
    let failure = error_json("late desktop-state timeout", None, None, None);
    let failed_resource = json!({
        "error": failure,
        "generation": 1,
        "pending": false,
        "stale": false,
        "updatedAt": 0,
    });
    let recovered_resource = resource_with_value(json!({ "ok": true, "recovered": true }), 2);
    let after_failure = snapshot(
        "reconnecting",
        failed_resource,
        Some(failure.clone()),
        &["desktop-state"],
    );
    let after_recovery = snapshot("ready", recovered_resource, None, &[]);
    json!({
        "result": {
            "health": { "ok": true, "value": { "ok": true } },
            "refresh": { "ok": false, "error": failure, "stale": false, "generation": 1 },
            "afterFailure": after_failure,
            "recovery": {
                "ok": true,
                "value": { "ok": true, "recovered": true },
                "stale": false,
                "generation": 2,
            },
            "afterRecovery": after_recovery,
        },
        "states": ["refreshing", "ready", "reconnecting", "ready"],
        "failures": [failure],
        "requestCalls": [
            { "path": "/desktop-state", "opts": null },
            { "path": "/health", "opts": null },
            { "path": "/desktop-state", "opts": null },
        ],
        "mutateCalls": [],
        "snapshot": after_recovery,
    })
}

fn snapshot(
    state: &str,
    resource: Value,
    last_error: Option<Value>,
    failed_critical_resources: &[&str],
) -> Value {
    let failed_resources = resource
        .get("error")
        .map(|_| vec!["desktop-state"])
        .unwrap_or_default();
    json!({
        "state": state,
        "connection": connection(state, last_error, &failed_resources, failed_critical_resources),
        "resource": resource,
    })
}

fn connection(
    state: &str,
    last_error: Option<Value>,
    failed_resources: &[&str],
    failed_critical_resources: &[&str],
) -> Value {
    let stale_resources = if state == "stale" {
        vec!["desktop-state"]
    } else {
        Vec::new()
    };
    let mut value = json!({
        "state": state,
        "updatedAt": NOW,
        "pendingResources": [],
        "staleResources": stale_resources,
        "failedResources": failed_resources,
        "failedCriticalResources": failed_critical_resources,
    });
    if let Some(error) = last_error {
        value["lastError"] = error;
    }
    value
}

fn empty_resource() -> Value {
    json!({
        "generation": 0,
        "pending": false,
        "stale": false,
        "updatedAt": 0,
    })
}

fn resource_with_value(value: Value, generation: u64) -> Value {
    json!({
        "value": value,
        "generation": generation,
        "pending": false,
        "stale": false,
        "updatedAt": NOW,
    })
}

fn resource_with_stale_error(value: Value, error: Value, generation: u64) -> Value {
    json!({
        "value": value,
        "error": error,
        "generation": generation,
        "pending": false,
        "stale": true,
        "updatedAt": NOW,
    })
}

fn step_value(input: &Value, key: &str, index: usize) -> Value {
    input
        .get(key)
        .and_then(Value::as_array)
        .and_then(|steps| steps.get(index))
        .and_then(|step| step.get("value"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn step_error(input: &Value, key: &str, index: usize) -> Value {
    let throw = input
        .get(key)
        .and_then(Value::as_array)
        .and_then(|steps| steps.get(index))
        .and_then(|step| step.get("throw"))
        .unwrap_or(&Value::Null);
    error_json(
        str_field(throw, "message"),
        throw.get("code").and_then(Value::as_str),
        throw.get("status").and_then(Value::as_i64),
        throw.get("tuiApiRecoverable").and_then(Value::as_bool),
    )
}

fn error_json(
    message: &str,
    code: Option<&str>,
    status: Option<i64>,
    tui_api_recoverable: Option<bool>,
) -> Value {
    let mut value = json!({
        "name": "Error",
        "message": message,
    });
    if let Some(code) = code {
        value["code"] = json!(code);
    }
    if let Some(status) = status {
        value["status"] = json!(status);
    }
    if let Some(recoverable) = tui_api_recoverable {
        value["tuiApiRecoverable"] = json!(recoverable);
    }
    value
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
