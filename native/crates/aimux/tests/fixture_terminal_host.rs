use serde::Deserialize;
use serde_json::Value;

const TERMINAL_HOST: &str = include_str!("../../../../testdata/contracts/v1/terminal/host.json");

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
#[ignore = "checklist: terminal host escape-sequence parity belongs to terminal/dashboard control implementation"]
fn fixture_terminal_host_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(TERMINAL_HOST).expect("terminal host fixture parses");
    assert_eq!(contract.cases.len(), 2);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/terminal-host.test.ts");
        assert!(case.input.get("op").and_then(Value::as_str).is_some());
        assert!(case
            .output
            .get("containsFocusEnable")
            .and_then(Value::as_bool)
            .is_some());
        assert!(case
            .output
            .get("containsFocusDisable")
            .and_then(Value::as_bool)
            .is_some());
    }
}
