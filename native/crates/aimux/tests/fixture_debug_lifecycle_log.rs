use aimux::debug_logging_contract::run_debug_lifecycle_log_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const DEBUG_LIFECYCLE_LOG: &str =
    include_str!("../../../../testdata/contracts/v1/debug/lifecycle-log.json");

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_debug_lifecycle_log_checklist() {
    let contract: Contract =
        serde_json::from_str(DEBUG_LIFECYCLE_LOG).expect("valid debug/lifecycle-log fixture");
    assert_eq!(
        contract.cases.len(),
        3,
        "unexpected debug lifecycle log case count"
    );

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "logLifecycleAlways");
        let actual = run_debug_lifecycle_log_contract_case(&case.input);
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
        "{} debug lifecycle log parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
