use serde_json::{Value, json};

pub fn session_runtime_events(input: &Value) -> Value {
    let event = &input["event"];
    match event["kind"].as_str().unwrap_or_default() {
        "data" => json!([{ "type": "output", "data": event["data"] }]),
        "exit" => json!([{ "type": "exit", "code": event["code"] }]),
        _ => json!([]),
    }
}
