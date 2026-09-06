use serde::Deserialize;
use serde_json::Value;

const PACKAGE_MANIFEST: &str =
    include_str!("../../../../testdata/contracts/v1/release/package-manifest.json");

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
    input: Value,
    output: Value,
}

#[test]
#[ignore = "checklist: package.json release file-list parity has no Rust public API"]
fn fixture_package_manifest_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(PACKAGE_MANIFEST).expect("package manifest fixture parses");
    assert_eq!(contract.cases.len(), 1);
    let case = &contract.cases[0];
    assert_eq!(case.id, "release-package-manifest-001");
    assert_eq!(case.source, "src/package-manifest.test.ts");
    assert_eq!(
        case.input.get("sourcePath").and_then(Value::as_str),
        Some("package.json")
    );
    assert!(case
        .output
        .get("required")
        .and_then(Value::as_array)
        .is_some());
    assert!(case
        .output
        .get("forbidden")
        .and_then(Value::as_array)
        .is_some());
}
