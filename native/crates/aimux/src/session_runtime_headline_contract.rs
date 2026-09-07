use serde_json::{Value, json};

pub fn run_session_runtime_headline_contract_case(input: &Value) -> Value {
    let status_headline = read_status_headline(input);
    let derived_headline = status_headline
        .clone()
        .or_else(|| derive_history_headline(input));
    json!({
        "statusHeadline": status_headline,
        "derivedHeadline": derived_headline,
    })
}

fn read_status_headline(input: &Value) -> Option<String> {
    let content = input.get("statusFile")?.as_str()?.trim();
    if content.is_empty() {
        return None;
    }
    content.lines().next().map(slice_80)
}

fn derive_history_headline(input: &Value) -> Option<String> {
    let lines = input.get("historyLines")?.as_array()?;
    let mut turns = Vec::new();
    for line in lines {
        let Some(line) = line.as_str().map(str::trim) else {
            continue;
        };
        if line.is_empty() {
            continue;
        }
        let Ok(turn) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        turns.push(turn);
    }
    turns
        .into_iter()
        .rev()
        .take(3)
        .find(|turn| turn.get("type").and_then(Value::as_str) == Some("prompt"))
        .and_then(|turn| turn.get("content").and_then(Value::as_str).map(slice_80))
}

fn slice_80(value: &str) -> String {
    value.chars().take(80).collect()
}
