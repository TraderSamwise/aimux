use aimux::inbox_cleanup::run_inbox_cleanup_runtime_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const INBOX_CLEANUP_RUNTIME: &str =
    include_str!("../../../../../testdata/contracts/v1/notifications/inbox-cleanup-runtime.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_inbox_cleanup_runtime_contract_matches_rust() {
    let contract: Contract =
        serde_json::from_str(INBOX_CLEANUP_RUNTIME).expect("inbox cleanup runtime fixture parses");
    assert_eq!(contract.cases.len(), 2);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "persistenceMethods.cleanupInbox");
        let actual = run_inbox_cleanup_runtime_contract_case(&json!({
            "name": case.name,
            "input": case.input,
        }));
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
        "{} inbox-cleanup-runtime parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
