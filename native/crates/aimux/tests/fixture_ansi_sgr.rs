use serde_json::Value;

const SGR_SPANS: &str = include_str!("../../../../testdata/contracts/v1/ansi/sgr-spans.json");

#[test]
#[ignore = "Rust has strip/truncate ANSI helpers but no app/lib/ansi.ts-compatible SGR span parser yet"]
fn fixture_ansi_sgr_span_contract_cases_are_checklist() {
    let contract: Value = serde_json::from_str(SGR_SPANS).expect("valid SGR fixture json");
    let cases = contract["cases"].as_array().expect("SGR fixture cases");
    assert_eq!(cases.len(), 17, "unexpected SGR contract case count");
    for case in cases {
        assert!(case["input"].is_string(), "SGR case has raw input");
        assert!(
            case["output"]["lines"].is_array(),
            "SGR case has recorded spans"
        );
    }
}
