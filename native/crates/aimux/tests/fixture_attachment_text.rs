use aimux::attachment_text_contract::recover_wrapped_attachments_contract;
use serde_json::{Value, json};

const ATTACHMENT_TEXT: &str =
    include_str!("../../../../testdata/contracts/v1/attachments/text.json");

#[test]
fn fixture_attachment_text_matches_typescript() {
    let contract: Value = serde_json::from_str(ATTACHMENT_TEXT).expect("valid attachment fixture");
    let cases = contract["cases"].as_array().expect("attachment cases");
    assert_eq!(cases.len(), 129, "unexpected attachment text case count");
    let mut failures = Vec::new();
    for case in cases {
        let tail = case["input"]["tail"].as_str().expect("case tail");
        let actual = recover_wrapped_attachments_contract(tail);
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
        "{} attachment text parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
