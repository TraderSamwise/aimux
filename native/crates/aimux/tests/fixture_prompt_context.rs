#[path = "../src/prompt_context_contract.rs"]
mod prompt_context_contract;

use prompt_context_contract::run_prompt_context_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/prompt-context/context.json");

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
fn prompt_context_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("prompt context fixture parses");
    assert_eq!(contract.cases.len(), 28);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_prompt_context_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
