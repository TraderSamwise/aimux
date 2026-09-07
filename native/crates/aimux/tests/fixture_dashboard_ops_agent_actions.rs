use aimux::dashboard_ops_mutations_contract::run_dashboard_ops_agent_actions_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/dashboard-ops-agent-actions.json");

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
fn fixture_dashboard_ops_agent_actions_match_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("dashboard ops agent-actions fixture parses");
    assert_eq!(contract.source, "src/multiplexer/dashboard-ops.ts");
    assert_eq!(contract.cases.len(), 6);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/dashboard-ops.ts");
        let actual = run_dashboard_ops_agent_actions_contract_case(&case.api, &case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} dashboard ops agent-action parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
