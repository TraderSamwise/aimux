use aimux::coordination_tasks_threads_contract::coordination_tasks_threads_contract;
use serde_json::{Value, json};

const TASKS_THREADS: &str =
    include_str!("../../../../testdata/contracts/v1/coordination/tasks-threads.json");

#[test]
fn fixture_tasks_threads_matches_typescript() {
    let contract: Value = serde_json::from_str(TASKS_THREADS).expect("valid tasks-threads fixture");
    let cases = contract["cases"].as_array().expect("tasks-threads cases");
    assert_eq!(cases.len(), 7, "unexpected tasks-threads case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = coordination_tasks_threads_contract(case);
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
        "{} tasks/threads parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
