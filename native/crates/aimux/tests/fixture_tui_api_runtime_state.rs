use aimux::tui_api_runtime_state_contract::run_tui_api_runtime_state_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/tui-api-runtime-state.json");

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
fn fixture_tui_api_runtime_state_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("tui api runtime state fixture parses");
    assert_eq!(contract.source, "src/multiplexer/tui-api-runtime.ts");
    assert_eq!(contract.cases.len(), 23);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/tui-api-runtime.ts");
        assert_eq!(case.api, "TuiApiRuntime");
        let actual = run_tui_api_runtime_state_contract_case(&case.input);
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
        "{} tui api runtime state parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
