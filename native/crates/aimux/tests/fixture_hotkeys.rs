use serde::Deserialize;
use serde_json::Value;

const HOTKEYS: &str = include_str!("../../../../testdata/contracts/v1/terminal/hotkeys.json");

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
#[ignore = "checklist: global leader hotkey parity belongs to fenced dashboard/control implementation"]
fn fixture_hotkeys_contract_is_captured() {
    let contract: Contract = serde_json::from_str(HOTKEYS).expect("hotkeys fixture parses");
    assert_eq!(contract.cases.len(), 2);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/hotkeys.test.ts");
        assert!(case.input.get("chunks").and_then(Value::as_array).is_some());
        assert!(case
            .output
            .get("actions")
            .and_then(Value::as_array)
            .is_some());
        assert!(case
            .output
            .get("writes")
            .and_then(Value::as_array)
            .is_some());
    }
}
