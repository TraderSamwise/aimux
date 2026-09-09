use serde_json::Value;
use std::cmp::Ordering;

pub fn orchestration_routing_contract(api: &str, input: &Value) -> Value {
    match api {
        "resolveOrchestrationTarget" => resolve_orchestration_target(input).unwrap_or(Value::Null),
        "resolveOrchestrationRecipients" => Value::Array(
            resolve_orchestration_recipients(input)
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
        _ => Value::Null,
    }
}

fn resolve_orchestration_target(input: &Value) -> Option<Value> {
    let candidates = input["candidates"].as_array()?;
    let explicit = explicit_recipients(input);
    if !explicit.is_empty() {
        return explicit.into_iter().find_map(|id| {
            candidates
                .iter()
                .find(|candidate| {
                    string_field(candidate, "id") == Some(id.as_str())
                        && !bool_field(candidate, "exited")
                })
                .cloned()
        });
    }
    sorted_candidates(input).into_iter().next().cloned()
}

fn resolve_orchestration_recipients(input: &Value) -> Vec<String> {
    let candidates = input["candidates"].as_array().cloned().unwrap_or_default();
    let explicit = explicit_recipients(input);
    if !explicit.is_empty() {
        return explicit
            .into_iter()
            .filter(|id| {
                candidates.iter().any(|candidate| {
                    string_field(candidate, "id") == Some(id.as_str())
                        && !bool_field(candidate, "exited")
                })
            })
            .collect();
    }
    sorted_candidates(input)
        .into_iter()
        .filter_map(|candidate| string_field(candidate, "id").map(str::to_owned))
        .collect()
}

fn sorted_candidates(input: &Value) -> Vec<&Value> {
    let mut filtered = input["candidates"]
        .as_array()
        .map(|candidates| {
            candidates
                .iter()
                .filter(|candidate| implicit_match(candidate, input))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    filtered.sort_by(|left, right| {
        score_candidate(right, input)
            .partial_cmp(&score_candidate(left, input))
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                string_field(left, "id")
                    .unwrap_or_default()
                    .cmp(string_field(right, "id").unwrap_or_default())
            })
    });
    filtered
}

fn implicit_match(candidate: &Value, input: &Value) -> bool {
    if bool_field(candidate, "exited")
        || !bool_field(candidate, "canReceiveInput")
        || candidate.get("isAlive") == Some(&Value::Bool(false))
    {
        return false;
    }
    if let Some(assignee) = string_field(input, "assignee")
        && string_field(candidate, "role") != Some(assignee)
    {
        return false;
    }
    if let Some(tool) = string_field(input, "tool")
        && string_field(candidate, "tool") != Some(tool)
    {
        return false;
    }
    if let Some(worktree_path) = string_field(input, "worktreePath")
        && string_field(candidate, "worktreePath") != Some(worktree_path)
    {
        return false;
    }
    true
}

fn score_candidate(candidate: &Value, input: &Value) -> f64 {
    let mut score = 0.0;
    if let Some(worktree_path) = string_field(input, "worktreePath")
        && string_field(candidate, "worktreePath") == Some(worktree_path)
    {
        score += 10.0;
    }
    if let Some(assignee) = string_field(input, "assignee")
        && string_field(candidate, "role") == Some(assignee)
    {
        score += 8.0;
    }
    if let Some(tool) = string_field(input, "tool")
        && string_field(candidate, "tool") == Some(tool)
    {
        score += 6.0;
    }
    if bool_field(candidate, "canReceiveInput") {
        score += 5.0;
    }
    match string_field(candidate, "status") {
        Some("idle") => score += 3.0,
        Some("waiting") => score += 2.0,
        Some("running") => score += 1.0,
        _ => {}
    }
    score
        - number_field(candidate, "workflowPressure")
            .unwrap_or(0.0)
            .min(20.0)
}

fn explicit_recipients(input: &Value) -> Vec<String> {
    let raw = match input.get("to") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect::<Vec<_>>(),
        Some(Value::String(value)) => vec![value.as_str()],
        _ => Vec::new(),
    };
    let mut values = Vec::new();
    for value in raw {
        let value = value.trim();
        if !value.is_empty() && !values.iter().any(|existing| existing == value) {
            values.push(value.to_owned());
        }
    }
    values
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn number_field(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}
