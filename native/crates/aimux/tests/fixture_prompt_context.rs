use aimux::project_service::prompt_context::{
    PROMPT_CONTEXT_MAX_BYTES, compose_with_prompt_context, normalize_prompt_context,
    prompt_context_byte_length,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/prompt-context/context.json");

#[derive(Clone)]
struct PromptContextEntry {
    text: String,
    updated_at: i64,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn prompt_context_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("prompt context fixture parses");
    assert_eq!(contract.cases.len(), 28);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_prompt_context_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

fn run_prompt_context_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "normalizePromptContext" => json!(normalize_prompt_context(str_field(input, "text"))),
        "promptContextByteLength" => json!(prompt_context_byte_length(str_field(input, "text"))),
        "composeWithPromptContext" => {
            let context = input.get("context").and_then(Value::as_str);
            json!(compose_with_prompt_context(
                str_field(input, "text"),
                context
            ))
        }
        "PROMPT_CONTEXT_MAX_BYTES" => json!(PROMPT_CONTEXT_MAX_BYTES),
        "PromptContextStore" => run_store_scenario(input),
        _ => panic!("unknown prompt context contract api: {api}"),
    }
}

fn run_store_scenario(input: &Value) -> Value {
    let mut now = number_field(input, "now");
    if now == 0 {
        now = 1000;
    }
    let ttl_ms = match number_field(input, "ttlMs") {
        0 => 60_000,
        ttl_ms => ttl_ms,
    };
    let mut entries = HashMap::<String, PromptContextEntry>::new();
    let mut outputs = Vec::new();

    for op in array_field(input, "ops") {
        match str_field(op, "kind") {
            "advance" => {
                now += number_field(op, "ms");
                outputs.push(json!({ "kind": "advance", "now": now }));
            }
            "set" => {
                prune_expired(&mut entries, now);
                let session_id = str_field(op, "sessionId");
                let normalized = normalize_prompt_context(str_field(op, "text"));
                let result = if normalized.is_empty() {
                    entries.remove(session_id);
                    Value::Null
                } else {
                    let entry = PromptContextEntry {
                        text: normalized,
                        updated_at: now,
                        expires_at: now + ttl_ms,
                    };
                    entries.insert(session_id.to_string(), entry.clone());
                    entry_value(&entry)
                };
                outputs.push(json!({ "kind": "set", "sessionId": session_id, "result": result }));
            }
            "get" => {
                let session_id = str_field(op, "sessionId");
                let result = match entries.get(session_id).cloned() {
                    Some(entry) if now >= entry.expires_at => {
                        entries.remove(session_id);
                        Value::Null
                    }
                    Some(entry) => entry_value(&entry),
                    None => Value::Null,
                };
                outputs.push(json!({ "kind": "get", "sessionId": session_id, "result": result }));
            }
            "clear" => {
                let session_id = str_field(op, "sessionId");
                entries.remove(session_id);
                outputs.push(json!({ "kind": "clear", "sessionId": session_id }));
            }
            "clearAll" => {
                entries.clear();
                outputs.push(json!({ "kind": "clearAll" }));
            }
            kind => panic!("unknown prompt context store op: {kind}"),
        }
    }

    json!(outputs)
}

fn prune_expired(entries: &mut HashMap<String, PromptContextEntry>, now: i64) {
    entries.retain(|_, entry| now < entry.expires_at);
}

fn entry_value(entry: &PromptContextEntry) -> Value {
    json!({
        "text": entry.text,
        "updatedAt": entry.updated_at,
        "expiresAt": entry.expires_at,
    })
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
