use aimux::ansi_sgr_spans::parse_ansi_lines_contract;
use serde_json::Value;

const SGR_SPANS: &str = include_str!("../../../../testdata/contracts/v1/ansi/sgr-spans.json");

#[test]
fn fixture_ansi_sgr_span_contract_cases_match_typescript() {
    let contract: Value = serde_json::from_str(SGR_SPANS).expect("valid SGR fixture json");
    let cases = contract["cases"].as_array().expect("SGR fixture cases");
    assert_eq!(cases.len(), 17, "unexpected SGR contract case count");
    let mut failures = Vec::new();
    for case in cases {
        let input = case["input"].as_str().expect("SGR case input");
        let actual = parse_ansi_lines_contract(input);
        if actual != case["output"] {
            failures.push(serde_json::json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} ansi/sgr parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize SGR failures")
    );
}
