use serde_json::Value;

const PROJECT_SCANNER: &str =
    include_str!("../../../../testdata/contracts/v1/project-catalog/scanner.json");

#[test]
#[ignore = "project-scanner.ts desktop discovery has no Rust public scanner API yet; corpus is captured for the daemon/project catalog checklist"]
fn fixture_project_scanner_needs_rust_api() {
    let contract: Value = serde_json::from_str(PROJECT_SCANNER).expect("valid scanner fixture");
    let cases = contract["cases"].as_array().expect("scanner cases");
    assert_eq!(cases.len(), 8, "unexpected project-scanner case count");
}
