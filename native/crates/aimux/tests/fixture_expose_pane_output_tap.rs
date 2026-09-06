use serde_json::Value;

const EXPOSE_PANE_OUTPUT_TAP: &str =
    include_str!("../../../../testdata/contracts/v1/expose/pane-output-tap.json");

#[test]
#[ignore = "ExposePaneOutputTap parity depends on tmux pipe management, which is outside this ownership slice"]
fn fixture_expose_pane_output_tap_cases_are_contract_checklist() {
    let contract: Value =
        serde_json::from_str(EXPOSE_PANE_OUTPUT_TAP).expect("valid expose tap fixture");
    let cases = contract["cases"].as_array().expect("expose tap cases");
    assert_eq!(cases.len(), 14, "unexpected expose tap case count");
}
