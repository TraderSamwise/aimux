use serde::Deserialize;
use serde_json::Value;

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
#[ignore = "checklist: general terminal KeyEvent parser parity belongs to terminal/dashboard control implementation"]
fn fixture_key_parser_contract_is_captured() {
    let contract: Contract = serde_json::from_str(KEY_PARSER).expect("key parser fixture parses");
    assert_eq!(contract.cases.len(), 5);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/key-parser.test.ts");
        assert_eq!(case.api, "parseKeys");
        assert!(case.input.get("raw").and_then(Value::as_str).is_some());
        assert!(case.output.as_array().is_some());
    }
}
