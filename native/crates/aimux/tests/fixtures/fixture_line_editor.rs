use aimux::dashboard_controller::DashboardKey;
use aimux::dashboard_launch_options::{LineState, render_line_window};
use serde::Deserialize;
use serde_json::{Value, json};

const LINE_EDITOR: &str =
    include_str!("../../../../../testdata/contracts/v1/terminal/line-editor.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_line_editor_matches_typescript() {
    let contract: Contract = serde_json::from_str(LINE_EDITOR).expect("line editor fixture parses");
    assert_eq!(contract.cases.len(), 14);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} line-editor parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    let initial = input["initial"].as_str().unwrap_or_default().to_owned();
    let mut state = LineState::new(initial);
    if let Some(cursor) = input["cursor"].as_u64() {
        state.cursor = cursor as usize;
    }
    if input["kind"].as_str() == Some("render") {
        let max_width = input["maxWidth"].as_u64().unwrap_or(80) as usize;
        let rendered = render_line_window(&state, max_width);
        return json!({
            "rendered": rendered,
            "visibleLength": visible_length(&rendered),
        });
    }

    let mut consumed = Vec::new();
    for event in input["events"].as_array().into_iter().flatten() {
        if let Some(cursor) = event["setCursor"].as_u64() {
            state.cursor = cursor as usize;
            consumed.push(Value::Null);
            continue;
        }
        consumed.push(Value::Bool(apply_event(&mut state, event)));
    }
    json!({
        "state": {
            "text": state.text,
            "cursor": state.cursor,
        },
        "consumed": consumed,
    })
}

fn apply_event(state: &mut LineState, event: &Value) -> bool {
    if event["name"].as_str() == Some("paste") {
        let text = event["char"].as_str().unwrap_or_default();
        let mut consumed = false;
        for character in text.replace(['\r', '\n'], " ").chars() {
            consumed = state.apply_key(DashboardKey::Printable(character));
        }
        return consumed || text.is_empty();
    }
    let key = match event["name"].as_str().unwrap_or_default() {
        "left" => DashboardKey::Left,
        "right" => DashboardKey::Right,
        "home" => DashboardKey::Home,
        "end" => DashboardKey::End,
        "backspace" => DashboardKey::Backspace,
        "delete" => DashboardKey::Delete,
        "enter" => DashboardKey::Enter,
        "escape" => DashboardKey::Back,
        "tab" => DashboardKey::Tab,
        name if event["ctrl"].as_bool().unwrap_or(false) && name.len() == 1 => {
            DashboardKey::Ctrl(name.chars().next().unwrap())
        }
        "" => {
            let text = event["char"].as_str().unwrap_or_default();
            let Some(character) = text.chars().next() else {
                return false;
            };
            DashboardKey::Printable(character)
        }
        _ => DashboardKey::Other,
    };
    state.apply_key(key)
}

fn visible_length(value: &str) -> usize {
    let mut chars = value.chars().peekable();
    let mut len = 0;
    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next == 'm' {
                    break;
                }
            }
            continue;
        }
        len += 1;
    }
    len
}
