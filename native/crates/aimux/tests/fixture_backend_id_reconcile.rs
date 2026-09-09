use aimux::backend_id_reconcile_contract::backend_id_reconcile_contract;
use serde_json::{Value, json};

const BACKEND_ID_RECONCILE: &str =
    include_str!("../../../../testdata/contracts/v1/backend-id-reconcile/reconcile.json");

#[test]
fn fixture_backend_id_reconcile_matches_typescript() {
    let contract: Value =
        serde_json::from_str(BACKEND_ID_RECONCILE).expect("valid backend-id fixture");
    let cases = contract["cases"].as_array().expect("backend-id cases");
    assert_eq!(cases.len(), 9, "unexpected backend-id-reconcile case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = backend_id_reconcile_contract(&case["input"]);
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
        "{} backend-id-reconcile parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
