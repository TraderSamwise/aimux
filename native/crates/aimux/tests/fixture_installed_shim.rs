use serde::Deserialize;
use serde_json::Value;

const INSTALLED_SHIM: &str =
    include_str!("../../../../testdata/contracts/v1/release/installed-shim.json");

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
#[ignore = "checklist: installed shell shim parity has no Rust public API"]
fn fixture_installed_shim_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(INSTALLED_SHIM).expect("installed shim fixture parses");
    assert_eq!(contract.cases.len(), 3);
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, "src/installed-shim.test.ts");
        assert!(case.input.get("args").and_then(Value::as_array).is_some());
        assert!(case.output.get("status").and_then(Value::as_i64).is_some());
    }
}
