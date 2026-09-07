use serde::Deserialize;
use serde_json::Value;

const COMMAND_SPEC: &str =
    include_str!("../../../../testdata/contracts/v1/dashboard/command-spec.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
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
#[ignore = "parity bug behind dashboard_*: TypeScript dashboard command spec launches the legacy Node dashboard while Rust launches the native dashboard"]
fn fixture_dashboard_command_spec_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(COMMAND_SPEC).expect("dashboard command-spec fixture parses");
    assert_eq!(contract.source, "src/dashboard/command-spec.test.ts");
    assert_eq!(contract.case_count, 9);
    assert_eq!(contract.cases.len(), contract.case_count);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert_eq!(case.api, "getDashboardCommandSpec");
        assert!(!case.input.is_null());
        assert!(!case.output.is_null());
    }
}
