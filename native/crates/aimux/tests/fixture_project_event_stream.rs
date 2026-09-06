use serde::Deserialize;
use serde_json::Value;

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
#[ignore = "checklist: dashboard project event stream parity belongs to fenced dashboard/TUI runtime implementation"]
fn fixture_project_event_stream_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(PROJECT_EVENT_STREAM).expect("project event stream fixture parses");
    assert_eq!(contract.cases.len(), 22);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/multiplexer/project-event-stream.test.ts");
        assert_eq!(case.api, "DashboardProjectEventAdapter");
        assert!(case.input.get("ops").and_then(Value::as_array).is_some());
        assert!(case.output.get("host").and_then(Value::as_object).is_some());
    }
}
