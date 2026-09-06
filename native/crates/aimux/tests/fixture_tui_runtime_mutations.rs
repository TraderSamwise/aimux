use serde::Deserialize;
use serde_json::Value;

const TUI_RUNTIME_MUTATIONS: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/tui-runtime-mutations.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
#[ignore = "checklist: TUI runtime mutation queue parity belongs to fenced dashboard/TUI runtime implementation"]
fn fixture_tui_runtime_mutations_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(TUI_RUNTIME_MUTATIONS).expect("TUI runtime mutations fixture parses");
    assert_eq!(contract.cases.len(), 9);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(
            case.api,
            "queueTuiNotificationContext/queueTuiSessionSeen/clearTuiRuntimeMutationQueue"
        );
        assert!(case.input.get("ops").and_then(Value::as_array).is_some());
        assert!(case
            .output
            .get("calls")
            .and_then(Value::as_object)
            .and_then(|calls| calls.get("mutations"))
            .and_then(Value::as_array)
            .is_some());
    }
}
