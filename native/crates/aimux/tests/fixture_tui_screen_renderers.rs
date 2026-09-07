use serde::Deserialize;
use serde_json::Value;

const SCREEN_OVERLAYS: &str =
    include_str!("../../../../testdata/contracts/v1/tui/screen-overlays.json");
const SUBSCREEN_RENDERERS: &str =
    include_str!("../../../../testdata/contracts/v1/tui/subscreen-renderers.json");

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
#[ignore = "checklist: TypeScript TUI overlay renderer APIs are behind the dashboard/TUI render ownership fence"]
fn fixture_tui_screen_overlay_renderers_are_captured() {
    let contract: Contract =
        serde_json::from_str(SCREEN_OVERLAYS).expect("tui screen overlays fixture parses");
    assert_eq!(contract.source, "src/tui/screens/overlay-renderers.test.ts");
    assert_eq!(contract.case_count, 13);
    assert_eq!(contract.cases.len(), contract.case_count);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(!case.api.is_empty());
        assert!(case.input.get("api").and_then(Value::as_str).is_some());
        assert!(case
            .output
            .get("rendered")
            .and_then(Value::as_str)
            .is_some());
        assert!(case
            .output
            .get("visibleText")
            .and_then(Value::as_str)
            .is_some());
    }
}

#[test]
#[ignore = "checklist: TypeScript TUI subscreen renderer APIs are behind the dashboard/TUI render ownership fence"]
fn fixture_tui_subscreen_renderers_are_captured() {
    let contract: Contract =
        serde_json::from_str(SUBSCREEN_RENDERERS).expect("tui subscreen renderers fixture parses");
    assert_eq!(
        contract.source,
        "src/tui/screens/subscreen-renderers.test.ts"
    );
    assert_eq!(contract.case_count, 5);
    assert_eq!(contract.cases.len(), contract.case_count);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(!case.api.is_empty());
        assert!(!case.input.is_null());
        assert!(case
            .output
            .get("rendered")
            .and_then(Value::as_str)
            .is_some());
        assert!(case
            .output
            .get("visibleText")
            .and_then(Value::as_str)
            .is_some());
    }
}
