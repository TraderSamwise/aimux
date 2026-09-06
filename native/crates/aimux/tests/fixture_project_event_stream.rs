use aimux::dashboard_project_events::DashboardProjectEventAdapterContract;
use serde::Deserialize;
use serde_json::{Value, json};

const PROJECT_EVENT_STREAM: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/project-event-stream.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
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
fn fixture_project_event_stream_contract_matches_rust_adapter() {
    let contract: Contract =
        serde_json::from_str(PROJECT_EVENT_STREAM).expect("project event stream fixture parses");
    assert_eq!(contract.cases.len(), 22);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/multiplexer/project-event-stream.test.ts");
        assert_eq!(case.api, "DashboardProjectEventAdapter");
        assert!(case.input.get("ops").and_then(Value::as_array).is_some());
        assert!(case.output.get("host").and_then(Value::as_object).is_some());

        let actual = DashboardProjectEventAdapterContract::run_input(&case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} project-event-stream parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
