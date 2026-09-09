//! Drives the PRODUCTION builtin metadata watchers against the recovered Node
//! corpus. Only the scenario driver lives here; every parser, dedupe and effect
//! below is the code the project service runs.

use aimux::builtin_metadata_watchers::{BuiltinMetadataWatchers, MetadataEffects};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-watchers/builtin.json");

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

#[derive(Default)]
struct Collected {
    statuses: Vec<Value>,
    progresses: Vec<Value>,
    logs: Vec<Value>,
    contexts: Vec<Value>,
    events: Vec<Value>,
}

impl Collected {
    fn absorb(&mut self, effects: MetadataEffects) {
        self.statuses.extend(effects.statuses);
        self.progresses.extend(effects.progresses);
        self.logs.extend(effects.logs);
        self.contexts.extend(effects.contexts);
        self.events.extend(effects.events);
    }

    fn into_value(self) -> Value {
        json!({
            "statuses": self.statuses,
            "progresses": self.progresses,
            "logs": self.logs,
            "contexts": self.contexts,
            "events": self.events,
        })
    }
}

/// Harness-only: the corpus grows history between polls.
fn append_history_turn(history: &mut Value, operation: &Value) {
    let session_id = operation
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if !history.is_object() {
        *history = Value::Object(Map::new());
    }
    let Some(history) = history.as_object_mut() else {
        return;
    };
    let entry = history
        .entry(session_id)
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(turns) = entry.as_array_mut() {
        turns.push(operation["turn"].clone());
    }
}

fn snapshot(input: &Value, exchange: &Value, history: &Value) -> Value {
    let mut next = input.as_object().cloned().unwrap_or_default();
    next.insert("exchange".to_owned(), exchange.clone());
    next.insert("history".to_owned(), history.clone());
    Value::Object(next)
}

fn run_case(input: &Value) -> Value {
    let mut watchers = BuiltinMetadataWatchers::new();
    let mut collected = Collected::default();
    let mut exchange = input["exchange"].clone();
    let mut history = input["history"].clone();

    collected.absorb(watchers.scan(&snapshot(input, &exchange, &history)));

    if input.get("waitAfterStartMs").is_some() {
        collected.absorb(watchers.scan(&snapshot(input, &exchange, &history)));
    }

    for operation in input["afterStart"].as_array().into_iter().flatten() {
        match operation["op"].as_str().unwrap_or_default() {
            "writeExchange" => exchange = operation["exchange"].clone(),
            "appendTurn" => append_history_turn(&mut history, operation),
            "wait" => {
                collected.absorb(watchers.scan(&snapshot(input, &exchange, &history)));
            }
            _ => {}
        }
    }

    collected.into_value()
}

#[test]
fn builtin_metadata_watchers_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("fixture parses");
    assert_eq!(contract.cases.len(), 5);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
