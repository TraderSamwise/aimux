use serde::Deserialize;
use serde_json::Value;

const RICH_TEXT: &str = include_str!("../../../../testdata/contracts/v1/terminal/rich-text.json");

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
    input: Value,
    output: Value,
}

#[test]
#[ignore = "checklist: rich-text SGR projection has no Rust public API matching the TypeScript rich-text helpers yet"]
fn fixture_rich_text_contract_is_captured() {
    let contract: Contract = serde_json::from_str(RICH_TEXT).expect("rich text fixture parses");
    assert_eq!(contract.cases.len(), 6);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/rich-text.test.ts");
        assert!(case.input.get("text").and_then(Value::as_str).is_some());
        assert!(case.output.get("lines").and_then(Value::as_array).is_some());
        assert!(case.output.get("text").and_then(Value::as_str).is_some());
    }
}
