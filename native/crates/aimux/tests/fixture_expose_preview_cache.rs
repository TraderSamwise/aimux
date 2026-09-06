#[path = "../src/expose_preview_cache_contract.rs"]
mod expose_preview_cache_contract;

use expose_preview_cache_contract::run_expose_preview_cache_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/expose/preview-cache.json");

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
fn expose_preview_cache_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("expose preview cache fixture parses");
    assert_eq!(contract.cases.len(), 8);
    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_expose_preview_cache_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "expose preview cache parity failures:\n{}",
        failures.join("\n\n")
    );
}
