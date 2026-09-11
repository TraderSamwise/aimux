use super::fixture_release_contracts::run_release_asset_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const RELEASE_ASSET: &str = include_str!("../../../../../testdata/contracts/v1/release/asset.json");

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
fn fixture_release_asset_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(RELEASE_ASSET).expect("release asset fixture parses");
    assert_eq!(contract.cases.len(), 3);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/release-asset-contract.test.ts");
        assert_eq!(
            case.input.get("sourcePath").and_then(Value::as_str),
            Some("scripts/build-release-asset.sh")
        );
        let actual = run_release_asset_contract_case(&repo_root(), &case.input);
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
        "{} release asset parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("repo root")
        .to_path_buf()
}
