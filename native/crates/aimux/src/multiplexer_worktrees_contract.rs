use serde_json::{json, Value};

pub fn run_multiplexer_worktrees_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "worktreeSettlePollDelay" => Value::Array(
            input
                .get("calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(delay_call_output)
                .collect(),
        ),
        api => panic!("unknown multiplexer worktrees api: {api}"),
    }
}

fn delay_call_output(call: &Value) -> Value {
    let attempt = number_field(call, "attempt");
    let base_ms = number_field(call, "baseMs");
    let max_ms = call.get("maxMs").and_then(Value::as_i64).unwrap_or(2_000);
    let delay_ms = worktree_settle_poll_delay(attempt, base_ms, max_ms);
    let mut output = call.clone();
    if let Value::Object(object) = &mut output {
        object.insert("delayMs".to_owned(), json!(delay_ms));
    }
    output
}

fn worktree_settle_poll_delay(attempt: i64, base_ms: i64, max_ms: i64) -> i64 {
    if attempt <= 2 {
        return base_ms;
    }
    let decayed = ((base_ms as f64) * 1.5_f64.powi((attempt - 2) as i32)).round() as i64;
    decayed.min(base_ms.max(max_ms))
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or_default()
}
