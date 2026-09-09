#[path = "fixture_hosted_runtime_contract.rs"]
mod hosted_runtime_contract;

use hosted_runtime_contract::run_hosted_runtime_contract_case;
use serde::Deserialize;
use serde_json::Value;

const HOSTED_CONFIG: &str = include_str!("../../../../testdata/contracts/v1/hosted/config.json");
const HOSTED_RATE_LIMIT: &str =
    include_str!("../../../../testdata/contracts/v1/hosted/rate-limit.json");
const EXPOSE_PREVIEW_CROP: &str =
    include_str!("../../../../testdata/contracts/v1/expose/preview-crop.json");

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
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn hosted_config_contract_matches_typescript() {
    assert_fixture("hosted config", HOSTED_CONFIG, 18);
}

#[test]
fn hosted_rate_limit_contract_matches_typescript() {
    assert_fixture("hosted rate limit", HOSTED_RATE_LIMIT, 7);
}

#[test]
fn expose_preview_crop_contract_matches_typescript() {
    assert_fixture("expose preview crop", EXPOSE_PREVIEW_CROP, 4);
}

fn assert_fixture(label: &str, fixture: &str, expected_count: usize) {
    let contract: Contract = serde_json::from_str(fixture).expect("hosted runtime fixture parses");
    assert_eq!(contract.cases.len(), expected_count);
    let mut failures = Vec::new();
    for case in contract.cases {
        let mut input = case.input;
        if input.get("api").is_none()
            && let Some(object) = input.as_object_mut()
        {
            object.insert("api".to_owned(), Value::String(case.api));
        }
        let actual = run_hosted_runtime_contract_case(&input);
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
