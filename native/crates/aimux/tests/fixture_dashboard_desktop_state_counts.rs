use serde_json::Value;

const DESKTOP_STATE_COUNTS: &str =
    include_str!("../../../../testdata/contracts/v1/dashboard/desktop-state-counts.json");

#[test]
fn fixture_dashboard_desktop_state_counts_is_loaded() {
    let contract: Value =
        serde_json::from_str(DESKTOP_STATE_COUNTS).expect("valid desktop counts fixture");
    assert_eq!(contract["version"], 1);
    assert_eq!(
        contract["source"], "src/multiplexer/dashboard-model.ts",
        "unexpected desktop counts source"
    );
    assert_eq!(
        contract["cases"].as_array().map(Vec::len),
        Some(0),
        "desktop counts corpus currently has no recorded cases"
    );
}
