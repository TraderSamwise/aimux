use aimux::tmux_expose::{balanced_cols, compute_layout, match_client_size, tile_preview};
use serde_json::{Value, json};

const TMUX_EXPOSE_LAYOUT: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/expose-layout.json");

#[test]
fn fixture_tmux_expose_layout_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_EXPOSE_LAYOUT).expect("valid expose layout fixture");
    let cases = contract["cases"].as_array().expect("expose layout cases");
    assert_eq!(cases.len(), 24, "unexpected expose layout case count");

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
        "{} tmux-expose-layout parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    match case["api"].as_str().expect("api") {
        "balancedCols" => json!({
            "cols": balanced_cols(case["input"]["count"].as_i64().expect("count"))
        }),
        "computeLayout" => serde_json::to_value(compute_layout(
            case["input"]["itemCount"].as_i64().expect("item count"),
            case["input"]["cols"].as_i64().expect("cols"),
            case["input"]["rows"].as_i64().expect("rows"),
        ))
        .expect("serialize layout"),
        "matchClientSize" => json!({
            "size": match_client_size(
                case["input"]["listing"].as_str().expect("listing"),
                case["input"]["clientTty"].as_str().expect("client tty"),
            )
        }),
        "tilePreview" => json!({
            "lines": tile_preview(
                case["input"]["raw"].as_str().expect("raw"),
                case["input"]["count"].as_i64().expect("count"),
            )
        }),
        unexpected => panic!("unexpected api {unexpected}"),
    }
}
