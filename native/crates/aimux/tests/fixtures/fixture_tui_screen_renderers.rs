use aimux::tui_screen_renderers::{
    run_tui_screen_overlay_contract_case, run_tui_subscreen_renderer_contract_case,
};
use serde::Deserialize;
use serde_json::{Value, json};

const SCREEN_OVERLAYS: &str =
    include_str!("../../../../../testdata/contracts/v1/tui/screen-overlays.json");
const SUBSCREEN_RENDERERS: &str =
    include_str!("../../../../../testdata/contracts/v1/tui/subscreen-renderers.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
    case_count: usize,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_tui_screen_overlay_renderers_match_rust() {
    let contract: Contract =
        serde_json::from_str(SCREEN_OVERLAYS).expect("tui screen overlays fixture parses");
    assert_eq!(contract.source, "src/tui/screens/overlay-renderers.test.ts");
    assert_eq!(contract.case_count, 13);
    assert_eq!(contract.cases.len(), contract.case_count);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(!case.api.is_empty());
        let actual = run_tui_screen_overlay_contract_case(&case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "api": case.api,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tui screen overlay parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_tui_subscreen_renderers_match_rust() {
    let contract: Contract =
        serde_json::from_str(SUBSCREEN_RENDERERS).expect("tui subscreen renderers fixture parses");
    assert_eq!(
        contract.source,
        "src/tui/screens/subscreen-renderers.test.ts"
    );
    assert_eq!(contract.case_count, 5);
    assert_eq!(contract.cases.len(), contract.case_count);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(!case.api.is_empty());
        assert!(!case.input.is_null());
        let actual = run_tui_subscreen_renderer_contract_case(&case.api, &case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "api": case.api,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tui subscreen renderer parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
