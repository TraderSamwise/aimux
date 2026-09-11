use super::fixture_release_contracts::run_installed_shim_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const INSTALLED_SHIM: &str =
    include_str!("../../../../../testdata/contracts/v1/release/installed-shim.json");

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
fn fixture_installed_shim_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(INSTALLED_SHIM).expect("installed shim fixture parses");
    assert_eq!(contract.cases.len(), 3);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/installed-shim.test.ts");
        assert!(case.input.get("args").and_then(Value::as_array).is_some());
        let actual = run_installed_shim_contract_case(&repo_root(), &case.input);
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
        "{} installed shim parity failures:\n{}",
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
