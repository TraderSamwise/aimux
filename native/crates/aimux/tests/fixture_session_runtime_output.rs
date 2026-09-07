use aimux::session_runtime_output_contract::run_session_runtime_output_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/session-runtime-output.json");

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
fn fixture_session_runtime_output_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("session runtime output fixture parses");
    assert_eq!(contract.source, "src/multiplexer/session-runtime-core.ts");
    assert_eq!(contract.cases.len(), 5);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/session-runtime-core.ts");
        assert_eq!(case.api, "readAgentOutput");
        let actual = run_session_runtime_output_contract_case(&case.input);
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
        "{} session runtime output parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
