use aimux::inbox_cleanup::inbox_cleanup_contract;
use serde_json::{Value, json};

const INBOX_CLEANUP: &str =
    include_str!("../../../../../testdata/contracts/v1/notifications/inbox-cleanup.json");

#[test]
fn fixture_inbox_cleanup_matches_typescript() {
    let contract: Value =
        serde_json::from_str(INBOX_CLEANUP).expect("valid notifications/inbox-cleanup fixture");
    let cases = contract["cases"].as_array().expect("inbox-cleanup cases");
    assert_eq!(cases.len(), 8, "unexpected inbox-cleanup case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = inbox_cleanup_contract(case);
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
        "{} notifications/inbox-cleanup parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
