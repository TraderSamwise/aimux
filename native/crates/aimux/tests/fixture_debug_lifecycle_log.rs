use serde_json::Value;

const DEBUG_LIFECYCLE_LOG: &str =
    include_str!("../../../../testdata/contracts/v1/debug/lifecycle-log.json");

#[test]
#[ignore = "Rust logging subsystem does not expose logLifecycleAlways parity API yet; captured corpus is the checklist for that port."]
fn fixture_debug_lifecycle_log_checklist() {
    let contract: Value =
        serde_json::from_str(DEBUG_LIFECYCLE_LOG).expect("valid debug/lifecycle-log fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("debug lifecycle log cases");
    assert_eq!(cases.len(), 3, "unexpected debug lifecycle log case count");
}
