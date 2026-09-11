use aimux::tmux_window_open::tmux_window_open_contract;
use serde_json::{Value, json};

const TMUX_WINDOW_OPEN: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/window-open.json");

#[test]
fn fixture_tmux_window_open_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_WINDOW_OPEN).expect("valid tmux window-open fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("tmux window-open cases");
    assert_eq!(cases.len(), 8, "unexpected tmux window-open case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = tmux_window_open_contract(case["api"].as_str().expect("api"), &case["input"]);
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
        "{} tmux-window-open parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
