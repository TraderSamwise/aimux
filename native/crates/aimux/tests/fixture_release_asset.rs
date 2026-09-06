use serde::Deserialize;
use serde_json::Value;

const RELEASE_ASSET: &str = include_str!("../../../../testdata/contracts/v1/release/asset.json");

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
#[ignore = "checklist: release asset shell packaging parity has no Rust public API; corpus protects phase-8 packaging expectations"]
fn fixture_release_asset_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(RELEASE_ASSET).expect("release asset fixture parses");
    assert_eq!(contract.cases.len(), 3);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/release-asset-contract.test.ts");
        assert_eq!(
            case.input.get("sourcePath").and_then(Value::as_str),
            Some("scripts/build-release-asset.sh")
        );
        assert!(case
            .output
            .get("contains")
            .and_then(Value::as_array)
            .is_some());
        assert!(case
            .output
            .get("notContains")
            .and_then(Value::as_array)
            .is_some());
    }
}
