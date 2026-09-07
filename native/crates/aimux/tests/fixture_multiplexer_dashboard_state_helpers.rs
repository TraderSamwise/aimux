use serde::Deserialize;
use serde_json::Value;

const DASHBOARD_STATE_HELPERS: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/dashboard-state-helpers.json");

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
#[ignore = "checklist: TypeScript multiplexer dashboard state helpers are behind dashboard_* and tmux* ownership fences"]
fn fixture_multiplexer_dashboard_state_helpers_contract_is_captured() {
    let contract: Contract = serde_json::from_str(DASHBOARD_STATE_HELPERS)
        .expect("multiplexer dashboard-state helpers fixture parses");
    assert_eq!(contract.subject, "multiplexer dashboard state helpers");
    assert_eq!(contract.case_count, 7);
    assert_eq!(contract.cases.len(), contract.case_count);
    for source in [
        "src/multiplexer/archives.test.ts",
        "src/multiplexer/dashboard-tail-methods.test.ts",
        "src/multiplexer/dashboard-view-methods.test.ts",
        "src/multiplexer/persistence-methods.test.ts",
        "src/multiplexer/runtime-state.test.ts",
    ] {
        assert!(contract.sources.contains(&source.to_string()));
    }

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
    }
}
