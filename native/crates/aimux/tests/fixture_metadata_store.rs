use serde_json::Value;

const METADATA_STORE: &str =
    include_str!("../../../../testdata/contracts/v1/metadata-store/store.json");

#[test]
#[ignore = "metadata-store parity requires daemon_state/project-service metadata persistence work outside this ownership slice"]
fn fixture_metadata_store_cases_are_contract_checklist() {
    let contract: Value = serde_json::from_str(METADATA_STORE).expect("valid metadata fixture");
    let cases = contract["cases"].as_array().expect("metadata cases");
    assert_eq!(cases.len(), 21, "unexpected metadata-store case count");
}
