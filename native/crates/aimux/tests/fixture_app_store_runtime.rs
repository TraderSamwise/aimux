#[path = "../src/app_store_runtime_contract.rs"]
mod app_store_runtime_contract;

use app_store_runtime_contract::{
    run_app_chat_output_contract_case, run_app_project_list_contract_case,
    run_app_resource_request_tracker_contract_case, run_app_ui_defaults_contract_case,
};
use serde::Deserialize;
use serde_json::Value;

const CHAT_OUTPUT: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/chat-output.json");
const PROJECT_LIST: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/project-list.json");
const RESOURCE_TRACKER: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/resource-request-tracker.json");
const UI_DEFAULTS: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/ui-defaults.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn app_chat_output_contract_matches_typescript() {
    assert_contract(CHAT_OUTPUT, 20, run_app_chat_output_contract_case);
}

#[test]
fn app_project_list_contract_matches_typescript() {
    assert_contract(PROJECT_LIST, 7, run_app_project_list_contract_case);
}

#[test]
fn app_resource_request_tracker_contract_matches_typescript() {
    assert_contract(
        RESOURCE_TRACKER,
        3,
        run_app_resource_request_tracker_contract_case,
    );
}

#[test]
fn app_ui_defaults_contract_matches_typescript() {
    assert_contract(UI_DEFAULTS, 1, run_app_ui_defaults_contract_case);
}

fn assert_contract(fixture: &str, expected_count: usize, run: fn(&Value) -> Value) {
    let contract: Contract = serde_json::from_str(fixture).expect("app store fixture parses");
    assert_eq!(contract.cases.len(), expected_count);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
