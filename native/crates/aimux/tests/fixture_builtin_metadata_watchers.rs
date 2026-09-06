use aimux::builtin_metadata_watchers_contract::builtin_metadata_watchers_contract;
use serde_json::{Value, json};

const BUILTIN_METADATA_WATCHERS: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-watchers/builtin.json");

#[test]
fn fixture_builtin_metadata_watchers_matches_typescript() {
    let contract: Value = serde_json::from_str(BUILTIN_METADATA_WATCHERS)
        .expect("valid builtin metadata watchers fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("builtin metadata watchers cases");
    assert_eq!(
        cases.len(),
        5,
        "unexpected builtin metadata watchers case count"
    );

    let mut failures = Vec::new();
    for case in cases {
        let actual = builtin_metadata_watchers_contract(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} builtin metadata watcher parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
