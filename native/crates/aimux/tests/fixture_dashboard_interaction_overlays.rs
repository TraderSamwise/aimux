use aimux::dashboard_interaction_overlays_contract::run_dashboard_interaction_overlays_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!(
    "../../../../testdata/contracts/v1/multiplexer/dashboard-interaction-overlays.json"
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
    input: Value,
    output: Value,
}

#[test]
fn fixture_dashboard_interaction_overlays_match_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("dashboard interaction overlay fixture parses");
    assert_eq!(contract.source, "src/multiplexer/dashboard-interaction.ts");
    assert_eq!(contract.cases.len(), 24);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/dashboard-interaction.ts");
        let actual = run_dashboard_interaction_overlays_contract_case(&case.input);
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
        "{} dashboard interaction overlay parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
