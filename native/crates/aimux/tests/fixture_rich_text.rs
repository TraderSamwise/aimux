use aimux::terminal_rich_text_contract::parse_sgr_rich_text_contract;
use serde::Deserialize;
use serde_json::{Value, json};

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
fn fixture_rich_text_contract_is_captured() {
    let contract: Contract = serde_json::from_str(RICH_TEXT).expect("rich text fixture parses");
    assert_eq!(contract.cases.len(), 6);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/rich-text.test.ts");
        let text = case
            .input
            .get("text")
            .and_then(Value::as_str)
            .expect("input text");
        let actual = parse_sgr_rich_text_contract(text);
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
        "{} rich-text parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
