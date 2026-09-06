use aimux::terminal_key_parser::parse_keys;
use serde::Deserialize;
use serde_json::{Value, json};

const KEY_PARSER: &str = include_str!("../../../../testdata/contracts/v1/terminal/key-parser.json");

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
fn native_terminal_key_parser_matches_typescript_contract() {
    let contract: Contract = serde_json::from_str(KEY_PARSER).expect("key parser fixture parses");
    assert_eq!(contract.cases.len(), 5);

    let mut failures = Vec::new();
    for case in contract.cases {
        let raw = case.input["raw"].as_str().unwrap_or_default();
        let actual =
            serde_json::to_value(parse_keys(raw.as_bytes())).expect("serialize key events");
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} terminal key-parser parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
