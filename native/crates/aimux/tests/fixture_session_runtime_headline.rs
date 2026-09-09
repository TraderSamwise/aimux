use aimux::session_runtime_headline_contract::run_session_runtime_headline_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/session-runtime-headline.json");

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
fn fixture_session_runtime_headline_matches_typescript() {
    let contract =
        serde_json::from_str::<Contract>(FIXTURE).expect("session runtime headline fixture parses");
    assert_eq!(contract.source, "src/multiplexer/session-runtime-core.ts");
    assert_eq!(contract.cases.len(), 6);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert!(!case.name.is_empty());
        assert_eq!(case.source, "src/multiplexer/session-runtime-core.ts");
        assert_eq!(case.api, "readStatusHeadline+deriveHeadline");
        let actual = run_session_runtime_headline_contract_case(&case.input);
        if actual != case.output {
            failures.push(serde_json::json!({
                "id": case.id,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} session runtime headline parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
