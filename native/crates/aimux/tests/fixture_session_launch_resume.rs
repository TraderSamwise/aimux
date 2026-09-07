use aimux::session_launch_resume_contract::run_session_launch_resume_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/session-launch-resume.json");

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
fn fixture_session_launch_resume_match_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("session launch resume fixture parses");
    assert_eq!(contract.source, "src/multiplexer/session-launch.ts");
    assert_eq!(contract.cases.len(), 6);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/session-launch.ts");
        let actual = run_session_launch_resume_contract_case(&case.api, &case.input);
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
        "{} session launch resume parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
