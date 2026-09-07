use aimux::dashboard_control_worktree_sessions_contract::run_dashboard_control_worktree_sessions_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!(
    "../../../../testdata/contracts/v1/multiplexer/dashboard-control-worktree-sessions.json"
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
fn fixture_dashboard_control_worktree_sessions_matches_typescript() {
    let contract = serde_json::from_str::<Contract>(FIXTURE)
        .expect("dashboard control worktree fixture parses");
    assert_eq!(contract.source, "src/multiplexer/dashboard-control.ts");
    assert_eq!(contract.cases.len(), 4);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/dashboard-control.ts");
        assert_eq!(case.api, "updateWorktreeSessions");
        let actual = run_dashboard_control_worktree_sessions_contract_case(&case.input);
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
        "{} dashboard control worktree session parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
