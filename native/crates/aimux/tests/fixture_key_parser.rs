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
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_key_parser_contract_matches_rust() {
    let contract: Contract = serde_json::from_str(KEY_PARSER).expect("key parser fixture parses");
    assert_eq!(contract.cases.len(), 5);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/key-parser.test.ts");
        assert_eq!(case.api, "parseKeys");
        let raw = case
            .input
            .get("raw")
            .and_then(Value::as_str)
            .expect("fixture raw input");
        let actual =
            serde_json::to_value(parse_keys(raw.as_bytes())).expect("serialize key events");
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} key-parser parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
