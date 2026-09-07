use serde_json::{Value, json};

pub fn run_tui_api_runtime_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "isTuiApiConnectionMutationBlocked" => {
            if let Some(snapshots) = input.get("snapshots").and_then(Value::as_array) {
                Value::Array(
                    snapshots
                        .iter()
                        .map(|snapshot| {
                            json!({
                                "snapshot": snapshot,
                                "blocked": is_mutation_blocked(snapshot, value_field(input, "options")),
                            })
                        })
                        .collect(),
                )
            } else {
                Value::Bool(is_mutation_blocked(
                    value_field(input, "snapshot"),
                    value_field(input, "options"),
                ))
            }
        }
        "isRecoverableTuiApiError" => {
            if let Some(errors) = input.get("errors").and_then(Value::as_array) {
                Value::Array(
                    errors
                        .iter()
                        .map(|error| {
                            json!({
                                "error": error,
                                "recoverable": is_recoverable_tui_api_error(error),
                            })
                        })
                        .collect(),
                )
            } else {
                Value::Bool(is_recoverable_tui_api_error(value_field(input, "error")))
            }
        }
        "hasTuiApiRuntimeReadTransport" => Value::Array(
            input
                .get("hosts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|host| {
                    let host = host.as_str().unwrap_or_default();
                    json!({
                        "host": host,
                        "hasReadTransport": host == "with-read-transport",
                    })
                })
                .collect(),
        ),
        api => panic!("unknown tui api runtime api: {api}"),
    }
}

fn is_mutation_blocked(snapshot: &Value, options: &Value) -> bool {
    if options.get("allowDuringReconnect").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if !snapshot
        .get("failedCriticalResources")
        .and_then(Value::as_array)
        .map(Vec::is_empty)
        .unwrap_or(true)
    {
        return true;
    }
    matches!(
        str_field(snapshot, "state"),
        "failed" | "reconnecting" | "stale" | "repairing"
    )
}

fn is_recoverable_tui_api_error(error: &Value) -> bool {
    match error.get("tuiApiRecoverable").and_then(Value::as_bool) {
        Some(true) => return true,
        Some(false) => return false,
        None => {}
    }
    if let Some(status) = error.get("status").and_then(Value::as_i64) {
        if matches!(status, 408 | 409 | 425 | 429) || status >= 500 {
            return true;
        }
        if (400..500).contains(&status) {
            return false;
        }
    }
    if matches!(
        str_field(error, "code"),
        "ETIMEDOUT" | "ECONNREFUSED" | "ECONNRESET" | "EPIPE"
    ) {
        return true;
    }
    true
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
