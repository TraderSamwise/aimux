use serde::Deserialize;
use serde_json::Value;

const TARGETS: &str = include_str!("../../../../testdata/contracts/v1/dashboard/targets.json");

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
#[ignore = "checklist: dashboard target discovery/replacement APIs are behind the dashboard_*/tmux* ownership fence"]
fn fixture_dashboard_targets_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(TARGETS).expect("dashboard targets fixture parses");
    assert_eq!(contract.source, "src/dashboard/targets.test.ts");
    assert_eq!(contract.case_count, 4);
    assert_eq!(contract.cases.len(), contract.case_count);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(matches!(
            case.api.as_str(),
            "findLiveDashboardTarget" | "resolveDashboardTarget"
        ));
        assert!(!case.input.is_null());
        assert!(case.output.get("calls").and_then(Value::as_array).is_some());
    }
}
