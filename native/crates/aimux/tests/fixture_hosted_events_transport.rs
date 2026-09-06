#[path = "../src/hosted_events_transport_contract.rs"]
mod hosted_events_transport_contract;

use hosted_events_transport_contract::{
    run_hosted_events_contract_case, run_mobile_push_contract_case,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

const HOSTED_EVENTS_FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/hosted/events.json");
const MOBILE_PUSH_FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/notifications/mobile-push.json");

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
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn hosted_events_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(HOSTED_EVENTS_FIXTURE).expect("hosted events fixture parses");
    assert_eq!(contract.cases.len(), 20);
    assert_contract_cases(contract, run_hosted_events_contract_case, "hosted events");
}

#[test]
fn mobile_push_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(MOBILE_PUSH_FIXTURE).expect("mobile push fixture parses");
    assert_eq!(contract.cases.len(), 2);
    assert_contract_cases(contract, run_mobile_push_contract_case, "mobile push");
}

fn assert_contract_cases(contract: Contract, run: fn(&Value) -> Value, label: &str) {
    let mut failures = Vec::new();
    for case in contract.cases {
        let mut input = case.input;
        if input.get("api").is_none()
            && let Some(object) = input.as_object_mut()
        {
            object.insert("api".to_owned(), Value::String(case.api));
        }
        let mut actual = run(&input);
        assert_erased_fields_are_structured(&actual, &case.output, &case.id);
        actual = normalize_dynamic(actual, &mut NormalizationState::default());
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{label} parity failures:\n{}",
        failures.join("\n\n")
    );
}

#[derive(Default)]
struct NormalizationState {
    ids: BTreeMap<String, String>,
    timestamps: BTreeMap<String, String>,
}

fn normalize_dynamic(value: Value, state: &mut NormalizationState) -> Value {
    match value {
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| normalize_dynamic(value, state))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_dynamic(value, state)))
                .collect(),
        ),
        Value::String(text) if is_uuid_v4(&text) => {
            let next = state.ids.len() + 1;
            let token = state
                .ids
                .entry(text)
                .or_insert_with(|| format!("<id:{next}>"))
                .clone();
            Value::String(token)
        }
        Value::String(text) if text != "1970-01-01T00:00:00.000Z" && is_iso_timestamp(&text) => {
            let next = state.timestamps.len() + 1;
            let token = state
                .timestamps
                .entry(text)
                .or_insert_with(|| format!("<ts:{next}>"))
                .clone();
            Value::String(token)
        }
        Value::String(text) => Value::String(text),
        other => other,
    }
}

fn assert_erased_fields_are_structured(actual: &Value, expected: &Value, case_id: &str) {
    match (actual, expected) {
        (Value::Array(actual), Value::Array(expected)) => {
            for (actual, expected) in actual.iter().zip(expected) {
                assert_erased_fields_are_structured(actual, expected, case_id);
            }
        }
        (Value::Object(actual), Value::Object(expected)) => {
            for (key, expected) in expected {
                if let Some(actual) = actual.get(key) {
                    assert_erased_fields_are_structured(actual, expected, case_id);
                }
            }
        }
        (Value::String(actual), Value::String(expected)) if expected.starts_with("<id:") => {
            assert!(
                is_uuid_v4(actual),
                "{case_id}: erased id field was not a UUID: {actual}"
            );
        }
        (Value::String(actual), Value::String(expected)) if expected.starts_with("<ts:") => {
            assert!(
                is_iso_timestamp(actual),
                "{case_id}: erased timestamp field was not ISO: {actual}"
            );
        }
        _ => {}
    }
}

fn is_uuid_v4(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn is_iso_timestamp(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        })
}
