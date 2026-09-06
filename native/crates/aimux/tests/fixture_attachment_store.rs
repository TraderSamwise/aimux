use aimux::attachment_store_contract::{
    attachment_store_contract, attachment_store_contract_is_supported,
};
use serde_json::{Value, json};

const ATTACHMENT_STORE: &str =
    include_str!("../../../../testdata/contracts/v1/attachments/store.json");

#[test]
fn fixture_attachment_store_matches_typescript() {
    let contract: Value =
        serde_json::from_str(ATTACHMENT_STORE).expect("valid attachment-store fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("attachment-store cases");
    assert_eq!(cases.len(), 33, "unexpected attachment-store case count");
    let mut failures = Vec::new();
    for case in cases {
        assert!(
            attachment_store_contract_is_supported(case),
            "unsupported attachment-store case: {}",
            case["id"]
        );
        let actual = attachment_store_contract(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} attachment-store parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
