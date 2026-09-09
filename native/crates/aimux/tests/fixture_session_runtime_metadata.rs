use aimux::session_runtime_metadata_contract::run_session_runtime_metadata_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/session-runtime-metadata.json");

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
fn fixture_session_runtime_metadata_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("session runtime metadata fixture parses");
    assert_eq!(contract.source, "src/multiplexer/session-runtime-core.ts");
    assert_eq!(contract.cases.len(), 4);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/session-runtime-core.ts");
        assert_eq!(case.api, "buildTmuxWindowMetadata");
        let actual = run_session_runtime_metadata_contract_case(&case.input);
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
        "{} session runtime metadata parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
