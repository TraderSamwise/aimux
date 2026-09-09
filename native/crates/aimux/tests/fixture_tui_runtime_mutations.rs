use aimux::tui_runtime_mutations::run_tui_runtime_mutations_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

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
fn fixture_tui_runtime_mutations_contract_matches_rust() {
    let contract: Contract =
        serde_json::from_str(TUI_RUNTIME_MUTATIONS).expect("TUI runtime mutations fixture parses");
    assert_eq!(contract.cases.len(), 9);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(
            case.api,
            "queueTuiNotificationContext/queueTuiSessionSeen/clearTuiRuntimeMutationQueue"
        );
        let actual = run_tui_runtime_mutations_contract_case(&case.input);
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
        "{} TUI runtime mutation parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
