use aimux::tmux_expose_preview_sanitize::{
    sanitize_expose_preview_line, sanitize_expose_preview_output,
};
use serde_json::{Value, json};

const TMUX_EXPOSE_PREVIEW_SANITIZE: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/expose-preview-sanitize.json");

#[test]
fn fixture_tmux_expose_preview_sanitize_matches_typescript_contract() {
    let contract: Value = serde_json::from_str(TMUX_EXPOSE_PREVIEW_SANITIZE)
        .expect("valid expose preview sanitize fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("expose preview sanitize cases");
    assert_eq!(
        cases.len(),
        7,
        "unexpected expose preview sanitize case count"
    );

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux-expose-preview-sanitize parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    match case["api"].as_str().expect("api") {
        "sanitizeExposePreviewLine" => json!({
            "line": sanitize_expose_preview_line(case["input"]["line"].as_str().expect("line"))
        }),
        "sanitizeExposePreviewOutput" => json!({
            "lines": sanitize_expose_preview_output(case["input"]["raw"].as_str().expect("raw"))
        }),
        unexpected => panic!("unexpected api {unexpected}"),
    }
}
