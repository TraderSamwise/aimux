use serde_json::Value;

const PROJECT_CATALOG_REGISTRY: &str =
    include_str!("../../../../testdata/contracts/v1/project-catalog/registry.json");

#[test]
fn fixture_project_catalog_registry_is_loaded() {
    let contract: Value =
        serde_json::from_str(PROJECT_CATALOG_REGISTRY).expect("valid project catalog fixture");
    assert_eq!(contract["version"], 1);
    assert_eq!(
        contract["source"], "src/project-scanner.ts",
        "unexpected project catalog source"
    );
    assert_eq!(
        contract["projects"].as_array().map(Vec::len),
        Some(0),
        "project catalog corpus currently has no recorded projects"
    );
}
