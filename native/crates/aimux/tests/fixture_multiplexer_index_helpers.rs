use aimux::multiplexer_index_helpers_contract::run_multiplexer_index_helpers_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/index-helpers.json");

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
fn fixture_multiplexer_index_helpers_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("multiplexer index helpers fixture parses");
    assert_eq!(contract.source, "src/multiplexer/index.ts");
    assert_eq!(contract.cases.len(), 8);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/index.ts");
        let actual = run_multiplexer_index_helpers_contract_case(&case.api, &case.input);
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
        "{} multiplexer index helpers parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
