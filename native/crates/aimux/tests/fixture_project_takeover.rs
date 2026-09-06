use serde_json::Value;

const PROJECT_TAKEOVER: &str =
    include_str!("../../../../testdata/contracts/v1/project-takeover/takeover.json");

#[test]
#[ignore = "project-takeover.ts has no Rust implementation surface outside daemon/project ownership yet; corpus captures side effects for the takeover checklist"]
fn fixture_project_takeover_needs_rust_api() {
    let contract: Value =
        serde_json::from_str(PROJECT_TAKEOVER).expect("valid project-takeover fixture");
    let cases = contract["cases"].as_array().expect("project-takeover cases");
    assert_eq!(cases.len(), 5, "unexpected project-takeover case count");
}
