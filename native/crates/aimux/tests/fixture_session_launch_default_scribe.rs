use aimux::session_launch_default_scribe_contract::run_session_launch_default_scribe_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!(
    "../../../../testdata/contracts/v1/multiplexer/session-launch-default-scribe.json"
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
fn fixture_session_launch_default_scribe_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("session launch default scribe fixture parses");
    assert_eq!(contract.source, "src/multiplexer/session-launch.ts");
    assert_eq!(contract.cases.len(), 8);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/session-launch.ts");
        assert_eq!(case.api, "ensureDefaultScribeAgent");
        let actual = run_session_launch_default_scribe_contract_case(&case.input);
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
        "{} session launch default scribe parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
