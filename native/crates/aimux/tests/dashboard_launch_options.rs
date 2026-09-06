use aimux::dashboard_controller::DashboardKey;
use aimux::dashboard_launch_options::{
    DashboardLaunchOptionsState, LaunchOptionsField, LineState, parse_env_assignments,
    parse_shell_args, render_launch_options_overlay, render_line_window,
};
use aimux::dashboard_tool_picker::DashboardToolEntry;
use serde_json::{Map, Value, json};

#[test]
fn parses_shell_args_like_typescript_contract() {
    assert_eq!(
        parse_shell_args("--message \"hello world\" --name 'sam test'").expect("args"),
        vec!["--message", "hello world", "--name", "sam test"]
    );
    assert_eq!(
        parse_shell_args("--name hello\\ world --literal 'a\\b'").expect("args"),
        vec!["--name", "hello world", "--literal", "a\\b"]
    );
    assert_eq!(
        parse_shell_args("--empty \"\" --next").expect("args"),
        vec!["--empty", "", "--next"]
    );
    assert_eq!(
        parse_shell_args("--message \"hello").unwrap_err(),
        "unterminated double quote"
    );
}

#[test]
fn parses_env_assignments_like_typescript_contract() {
    assert_eq!(
        parse_env_assignments("CLAUDE_YOLO=1 MSG=\"hello world\"").expect("env"),
        Map::from_iter([
            ("CLAUDE_YOLO".into(), Value::String("1".into())),
            ("MSG".into(), Value::String("hello world".into())),
        ])
    );
    assert!(parse_env_assignments("   ").expect("env").is_empty());
    assert_eq!(
        parse_env_assignments("FOO=bar --flag").unwrap_err(),
        "invalid env var \"--flag\" (expected NAME=VALUE)"
    );
}

#[test]
fn line_editor_matches_cursor_and_control_key_contract() {
    let mut state = LineState::new("hello world".into());
    state.cursor = 6;
    assert!(state.apply_key(DashboardKey::Ctrl('u')));
    assert_eq!(state.text, "world");
    assert_eq!(state.cursor, 0);
    state.apply_key(DashboardKey::Printable('X'));
    state.apply_key(DashboardKey::Ctrl('k'));
    assert_eq!(state.text, "X");
    assert_eq!(state.cursor, 1);
}

#[test]
fn render_line_window_highlights_cursor_and_scrolls() {
    let mut state = LineState::new("0123456789".into());
    state.cursor = 9;
    let output = render_line_window(&state, 5);

    assert!(output.contains("\x1b[7m9\x1b[27m"));
    assert_eq!(
        output.replace("\x1b[7m", "").replace("\x1b[27m", "").len(),
        5
    );
}

#[test]
fn launch_override_combines_base_args_extra_args_and_env() {
    let tool = tool_with_defaults();
    let mut state = DashboardLaunchOptionsState::new(&tool);
    state.args = LineState::new("--model gpt-5.6".into());
    state.env = LineState::new("AIMUX_FAST=1".into());

    let launch = state.launch_override(&tool).expect("launch override");

    assert_eq!(launch.command, "codex");
    assert_eq!(launch.args, vec!["--base", "--model", "gpt-5.6"]);
    assert_eq!(
        launch.env,
        Map::from_iter([("AIMUX_FAST".into(), Value::String("1".into()))])
    );
}

#[test]
fn render_launch_options_overlay_includes_fields() {
    let tool = tool_with_defaults();
    let state = DashboardLaunchOptionsState::new(&tool);

    let output = render_launch_options_overlay(&state, Some(&tool), 100, 30);

    assert!(output.contains("CODEX: LAUNCH OPTIONS"));
    assert!(output.contains("Extra args:"));
    assert!(output.contains("Env vars:"));
}

#[test]
fn toggles_active_launch_options_field() {
    let tool = tool_with_defaults();
    let mut state = DashboardLaunchOptionsState::new(&tool);

    assert_eq!(state.active_field, LaunchOptionsField::Args);
    state.toggle_field();
    assert_eq!(state.active_field, LaunchOptionsField::Env);
}

fn tool_with_defaults() -> DashboardToolEntry {
    DashboardToolEntry {
        key: "codex".into(),
        command: "codex".into(),
        args: vec!["--base".into()],
        default_args: vec!["--danger".into()],
        default_env: Map::from_iter([("CODEX_MODE".into(), json!("fast"))]),
    }
}
