use aimux::dashboard_model_services_lifecycle_contract::run_dashboard_model_services_lifecycle_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!(
    "../../../../testdata/contracts/v1/multiplexer/dashboard-model-services-lifecycle.json"
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
fn fixture_dashboard_model_services_lifecycle_matches_typescript() {
    let contract = serde_json::from_str::<Contract>(FIXTURE)
        .expect("dashboard model lifecycle fixture parses");
    assert_eq!(contract.source, "src/multiplexer/dashboard-model.ts");
    assert_eq!(contract.cases.len(), 4);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert!(!case.name.is_empty());
        assert_eq!(case.source, "src/multiplexer/dashboard-model.ts");
        assert!(matches!(
            case.api.as_str(),
            "startProjectServices" | "stopProjectServices"
        ));
        let actual = run_dashboard_model_services_lifecycle_contract_case(&case.input);
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
        "{} dashboard model services lifecycle parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
