#[path = "../src/metadata_interaction_display_contract.rs"]
mod metadata_interaction_display_contract;
#[path = "../src/metadata_output_previews_contract.rs"]
mod metadata_output_previews_contract;

use metadata_interaction_display_contract::run_metadata_interaction_display_contract_case;
use metadata_output_previews_contract::run_metadata_output_previews_contract_case;
use serde::Deserialize;
use serde_json::Value;

const INTERACTION_DISPLAY: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-server/interaction-display.json");
const OUTPUT_PREVIEWS: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-server/output-previews.json");

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
fn metadata_interaction_display_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(INTERACTION_DISPLAY).expect("interaction display fixture parses");
    assert_eq!(contract.cases.len(), 5);
    assert_contract_cases(
        contract.cases,
        run_metadata_interaction_display_contract_case,
        "metadata interaction display",
    );
}

#[test]
fn metadata_output_previews_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(OUTPUT_PREVIEWS).expect("output previews fixture parses");
    assert_eq!(contract.cases.len(), 8);
    assert_contract_cases(
        contract.cases,
        run_metadata_output_previews_contract_case,
        "metadata output previews",
    );
}

fn assert_contract_cases(cases: Vec<Case>, run: fn(&Value) -> Value, label: &str) {
    let mut failures = Vec::new();
    for case in cases {
        let actual = run(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} parity failures:\n{}",
        label,
        failures.join("\n\n")
    );
}
