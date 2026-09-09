use aimux::runtime_exchange_import::runtime_exchange_import_contract;
use serde_json::{Value, json};

const RUNTIME_EXCHANGE_IMPORT: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-exchange/import.json");

#[test]
fn fixture_runtime_exchange_import_matches_typescript() {
    let contract: Value =
        serde_json::from_str(RUNTIME_EXCHANGE_IMPORT).expect("valid exchange-import fixture");
    let cases = contract["cases"].as_array().expect("exchange-import cases");
    assert_eq!(
        cases.len(),
        3,
        "unexpected runtime-exchange/import case count"
    );
    let mut failures = Vec::new();
    for case in cases {
        let actual = runtime_exchange_import_contract(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} runtime-exchange/import parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
