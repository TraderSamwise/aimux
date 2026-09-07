use aimux::multiplexer_runtime_helpers::run_multiplexer_runtime_helpers_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const RUNTIME_HELPERS: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/runtime-helpers.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    sources: Vec<String>,
    subject: String,
    case_count: usize,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_multiplexer_runtime_helpers_contract_matches_rust() {
    let contract: Contract =
        serde_json::from_str(RUNTIME_HELPERS).expect("multiplexer runtime helpers fixture parses");
    assert_eq!(
        contract.subject,
        "multiplexer dashboard/runtime helper functions"
    );
    assert_eq!(contract.case_count, 10);
    assert_eq!(contract.cases.len(), contract.case_count);
    assert!(
        contract
            .sources
            .contains(&"src/multiplexer/dashboard-control.test.ts".to_string())
    );
    assert!(
        contract
            .sources
            .contains(&"src/multiplexer/dashboard-ops.test.ts".to_string())
    );
    assert!(
        contract
            .sources
            .contains(&"src/multiplexer/session-launch.test.ts".to_string())
    );
    assert!(
        contract
            .sources
            .contains(&"src/multiplexer/session-runtime-core.test.ts".to_string())
    );
    assert!(
        contract
            .sources
            .contains(&"src/multiplexer/subscreens.test.ts".to_string())
    );

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert!(
            contract.sources.contains(&case.source),
            "case {} source {} is not declared",
            case.id,
            case.source
        );
        assert!(!case.api.is_empty());
        assert!(!case.input.is_null());
        assert!(!case.output.is_null());
        let actual = run_multiplexer_runtime_helpers_contract_case(&case.api, &case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "api": case.api,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} multiplexer runtime helper parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
