use aimux::project_service::statusline::render_tmux_statusline_contract;
use serde_json::{Value, json};

const TMUX_STATUSLINE_RENDER: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/statusline-render.json");
const TMUX_STATUSLINE_NODE_FRAME: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/statusline-node-frame-v1.json");

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

#[test]
fn fixture_tmux_statusline_whole_chrome_matches_node_frame() {
    let contract: Value =
        serde_json::from_str(TMUX_STATUSLINE_NODE_FRAME).expect("valid statusline frame fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("statusline frame cases");
    assert_eq!(cases.len(), 7, "unexpected statusline frame case count");

    let mut failures = Vec::new();
    for case in cases {
        let top = render_frame_line(case, "top");
        let bottom = render_frame_line(case, "bottom");
        let actual = json!({
            "top": top,
            "bottom": bottom,
            "frame": format!("{}\n{}", top, bottom),
        });
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux-statusline whole chrome frame parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn render_frame_line(case: &Value, line: &str) -> String {
    let input = &case["input"];
    let actual = render_tmux_statusline_contract(&json!({
        "data": input["data"],
        "projectRoot": input["projectRoot"],
        "line": line,
        "options": input["options"],
    }));
    actual["text"].as_str().expect("statusline text").to_owned()
}
