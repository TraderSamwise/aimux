use aimux::dashboard_control_overlay_output_contract::run_dashboard_control_overlay_output_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!(
    "../../../../testdata/contracts/v1/multiplexer/dashboard-control-overlay-output.json"
);

#[derive(Debug, Deserialize)]
struct Contract {
    source: String,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_dashboard_control_overlay_output_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("dashboard control overlay output fixture parses");
    assert_eq!(contract.source, "src/multiplexer/dashboard-control.ts");
    assert_eq!(contract.cases.len(), 5);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/dashboard-control.ts");
        let actual = run_dashboard_control_overlay_output_contract_case(&case.api, &case.input);
        if actual != case.output {
            failures.push(serde_json::json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} dashboard control overlay output parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
