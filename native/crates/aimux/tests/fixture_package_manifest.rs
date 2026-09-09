mod fixture_release_contracts;

use fixture_release_contracts::run_package_manifest_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

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
fn fixture_package_manifest_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(PACKAGE_MANIFEST).expect("package manifest fixture parses");
    assert_eq!(contract.cases.len(), 1);

    let mut failures = Vec::new();
    let case = &contract.cases[0];
    assert_eq!(case.id, "release-package-manifest-001");
    assert_eq!(case.source, "src/package-manifest.test.ts");
    assert_eq!(
        case.input.get("sourcePath").and_then(Value::as_str),
        Some("package.json")
    );
    let actual = run_package_manifest_contract_case(&repo_root(), &case.input);
    if actual != case.output {
        failures.push(json!({
            "id": case.id,
            "expected": case.output,
            "actual": actual,
        }));
    }

    assert!(
        failures.is_empty(),
        "{} package manifest parity failures:\n{}",
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
