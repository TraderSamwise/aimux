use aimux::project_service::statusline::render_tmux_statusline_contract;
use serde_json::{Value, json};

const TMUX_STATUSLINE_RENDER: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/statusline-render.json");

#[test]
fn fixture_tmux_statusline_render_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_STATUSLINE_RENDER).expect("valid statusline render fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("statusline render cases");
    assert_eq!(cases.len(), 7, "unexpected statusline render case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = render_tmux_statusline_contract(&case["input"]);
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
        "{} tmux-statusline-render parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
