use serde::Deserialize;
use serde_json::Value;

use aimux::release_version_contract::run_release_version_contract_case;

const VERSION_CONTRACT: &str =
    include_str!("../../../../../testdata/contracts/v1/release/version.json");

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
fn fixture_version_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(VERSION_CONTRACT).expect("version fixture parses");
    assert_eq!(contract.cases.len(), 6);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/version.test.ts");
        assert!(case.api.starts_with("readAimux"));
        assert!(case.input.get("files").and_then(Value::as_object).is_some());
        assert!(case.output.as_str().is_some());
        assert_eq!(
            run_release_version_contract_case(&case.input),
            case.output,
            "{} ({})",
            case.id,
            case.api
        );
    }
}
