use aimux::hotkeys::run_hotkeys_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

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
fn fixture_hotkeys_contract_matches_rust() {
    let contract: Contract = serde_json::from_str(HOTKEYS).expect("hotkeys fixture parses");
    assert_eq!(contract.cases.len(), 2);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/hotkeys.test.ts");
        let actual = run_hotkeys_contract_case(&case.input);
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
        "{} hotkey parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
