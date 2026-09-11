use aimux::daemon::core_commands::run_core_command_behavior_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const CORE_COMMAND_BEHAVIOR: &str =
    include_str!("../../../../../testdata/contracts/v1/core-command/behavior.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_core_command_behavior_matches_rust() {
    let contract: Contract =
        serde_json::from_str(CORE_COMMAND_BEHAVIOR).expect("valid core-command behavior fixture");
    assert_eq!(
        contract.cases.len(),
        6,
        "unexpected core command case count"
    );

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "AimuxDaemon.routeRequest");
        let actual = run_core_command_behavior_contract_case(&case.input);
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
        "{} core-command behavior parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
