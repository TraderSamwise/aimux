#[path = "../src/tool_output_watchers_contract.rs"]
mod tool_output_watchers_contract;

use serde::Deserialize;
use serde_json::Value;
use tool_output_watchers_contract::run_tool_output_watchers_contract_case;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/tool-output-watchers.json");

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
fn tool_output_watchers_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("tool output watchers fixture parses");
    assert_eq!(contract.cases.len(), 7);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_tool_output_watchers_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
