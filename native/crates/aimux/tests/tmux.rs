use aimux::tmux::{
    CapturePaneOptions, MANAGED_TMUX_AGENT_WINDOW_OPTIONS, MANAGED_TMUX_SESSION_OPTIONS,
    MANAGED_TMUX_TERMINAL_FEATURES, TMUX_SEND_TEXT_CHUNK_BYTES, TmuxCommandSpec,
    attach_session_argv, build_default_root_mouse_bindings_config, capture_pane_argv,
    clear_history_argv, is_dashboard_window_name, is_meta_dashboard_window_name,
    is_tmux_client_session_for_host, is_tmux_client_session_name, kill_window_argv,
    legacy_project_session_name, new_dashboard_window_argv, new_session_argv, new_window_argv,
    packed_argv_bytes, project_client_session_name, project_session, resize_window_argv,
    respawn_window_argv, select_window_argv, send_carriage_return_argv,
    send_client_carriage_return_argv, send_client_enter_argv, send_enter_argv, send_escape_argv,
    send_key_argv, send_modified_enter_argv, send_text_argv, session_window_id_target,
    session_window_target, split_text_for_tmux_send_keys, start_pane_pipe_argv,
    stop_pane_pipe_argv, switch_client_argv, switch_client_to_target_argv, unlink_window_argv,
};
use serde_json::Value;

fn fixture_cases() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!(
        "../../../../testdata/contracts/v1/tmux/command-argv.json"
    ))
    .expect("valid tmux argv fixture")["cases"]
        .as_array()
        .expect("cases array")
        .clone()
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .expect("string array")
        .iter()
        .map(|value| value.as_str().expect("string").to_owned())
        .collect()
}

fn string(value: &Value, key: &str) -> String {
    value[key].as_str().expect("string").to_owned()
}

fn command_spec(input: &Value) -> TmuxCommandSpec {
    TmuxCommandSpec {
        cwd: string(input, "cwd"),
        command: string(input, "command"),
        args: strings(input, "args"),
    }
}

#[test]
fn argv_builders_match_shared_contract_fixture() {
    for case in fixture_cases() {
        let input = &case["input"];
        let operation = case["operation"].as_str();
        let argv = match operation {
            None => capture_pane_argv(
                input["windowId"].as_str().expect("window id"),
                CapturePaneOptions {
                    start_line: input["startLine"].as_i64(),
                    end_line: input["endLine"].as_i64(),
                    include_escapes: input["includeEscapes"].as_bool().unwrap_or(false),
                },
            ),
            Some("newSessionDefault") => new_session_argv(
                input["sessionName"].as_str().expect("session name"),
                input["projectRoot"].as_str().expect("project root"),
                None,
            ),
            Some("newSessionCommand") => new_session_argv(
                input["sessionName"].as_str().expect("session name"),
                input["projectRoot"].as_str().expect("project root"),
                Some(&command_spec(input)),
            ),
            Some("newDashboardWindowCommand") => new_dashboard_window_argv(
                input["sessionName"].as_str().expect("session name"),
                input["projectRoot"].as_str().expect("project root"),
                input["dashboardName"].as_str().expect("dashboard name"),
                Some(&command_spec(input)),
            ),
            Some("newWindow") => new_window_argv(
                input["sessionName"].as_str().expect("session name"),
                input["name"].as_str().expect("name"),
                input["cwd"].as_str().expect("cwd"),
                input["command"].as_str().expect("command"),
                &strings(input, "args"),
                input["detached"].as_bool().unwrap_or(false),
            ),
            Some("captureTarget") => capture_pane_argv(
                input["windowId"].as_str().expect("window id"),
                CapturePaneOptions {
                    start_line: input["startLine"].as_i64(),
                    end_line: input["endLine"].as_i64(),
                    include_escapes: input["includeEscapes"].as_bool().unwrap_or(false),
                },
            ),
            Some("startPanePipe") => start_pane_pipe_argv(
                input["windowId"].as_str().expect("window id"),
                input["command"].as_str().expect("command"),
                input["onlyIfNotPiped"].as_bool().unwrap_or(false),
            ),
            Some("resizeWindow") => resize_window_argv(
                input["windowId"].as_str().expect("window id"),
                input["cols"].as_i64().expect("cols"),
                input["rows"].as_i64().expect("rows"),
            ),
            Some("sendModifiedEnter") => {
                send_modified_enter_argv(input["windowId"].as_str().expect("window id"))
            }
            Some("respawnWindow") => respawn_window_argv(
                input["windowId"].as_str().expect("window id"),
                &command_spec(input),
            ),
            Some("switchClient") => switch_client_argv(
                input["sessionName"].as_str().expect("session name"),
                input["windowIndex"].as_i64().expect("window index"),
                input["clientTty"].as_str(),
            ),
            Some("unlinkWindow") => unlink_window_argv(
                input["sessionName"].as_str().expect("session name"),
                input["windowId"].as_str().expect("window id"),
            ),
            Some(other) => panic!("unknown tmux fixture operation: {other}"),
        };
        assert_eq!(argv, strings(&case, "expected"), "{}", case["name"]);
    }
}

#[test]
fn mirrors_session_and_window_naming_contracts() {
    assert!(is_tmux_client_session_name(
        "aimux-mobile-abc-client-deadbeef"
    ));
    assert!(is_tmux_client_session_name("-client-deadbeef"));
    assert!(!is_tmux_client_session_name(
        "aimux-mobile-abc-client-DEADBEEF"
    ));
    assert!(!is_tmux_client_session_name(
        "aimux-mobile-abc-client-deadbee"
    ));
    assert!(is_tmux_client_session_for_host(
        "aimux-mobile-abc-client-deadbeef",
        "aimux-mobile-abc"
    ));
    assert!(!is_tmux_client_session_for_host(
        "aimux-mobile-abc-client-deadbeef-extra",
        "aimux-mobile-abc"
    ));
    assert_eq!(
        project_client_session_name("aimux-mobile-abc", "deadbeef"),
        "aimux-mobile-abc-client-deadbeef"
    );
    assert_eq!(
        session_window_target("aimux-mobile-abc", 3),
        "aimux-mobile-abc:3"
    );
    assert_eq!(
        session_window_id_target("aimux-mobile-abc", "@3"),
        "aimux-mobile-abc:@3"
    );
    assert_eq!(
        project_session("/tmp/aimux-paths-demo", "aimux").session_name,
        "aimux-aimux-paths-demo-d2ba0b1d07f1"
    );
    assert_eq!(
        legacy_project_session_name("/tmp/aimux-paths-demo", "aimux"),
        "aimux-aimux-paths-demo-9a8cae6a70"
    );
    assert_eq!(
        legacy_project_session_name("/tmp/foo...bar///", "aimux"),
        "aimux-foo-bar-bf0a2a179e"
    );
    assert_eq!(
        legacy_project_session_name("/", "aimux"),
        "aimux-project-42099b4af0"
    );
    assert!(is_dashboard_window_name("dashboard"));
    assert!(is_dashboard_window_name("dashboard-deadbeef"));
    assert!(!is_dashboard_window_name("my-dashboard"));
    assert!(is_meta_dashboard_window_name("meta-dashboard"));
    assert!(is_meta_dashboard_window_name("meta-dashboard-deadbeef"));
    assert!(!is_meta_dashboard_window_name("dashboard"));
}

#[test]
fn mirrors_text_chunking_options_and_mouse_bindings() {
    let text = format!(
        "{}🙂{}",
        "a".repeat(TMUX_SEND_TEXT_CHUNK_BYTES - 1),
        "b".repeat(20)
    );
    let chunks = split_text_for_tmux_send_keys(&text, TMUX_SEND_TEXT_CHUNK_BYTES);
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks.concat(), text);
    assert!(
        chunks
            .iter()
            .all(|chunk| chunk.len() <= TMUX_SEND_TEXT_CHUNK_BYTES)
    );
    assert_eq!(
        split_text_for_tmux_send_keys("", TMUX_SEND_TEXT_CHUNK_BYTES),
        Vec::<String>::new()
    );
    assert_eq!(packed_argv_bytes(&["tmux".to_owned(), "🙂".to_owned()]), 10);

    assert_eq!(MANAGED_TMUX_SESSION_OPTIONS.prefix, "C-a");
    assert_eq!(MANAGED_TMUX_SESSION_OPTIONS.prefix2, "C-b");
    assert_eq!(MANAGED_TMUX_SESSION_OPTIONS.history_limit, "20000");
    assert_eq!(MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allow_passthrough, "on");
    assert_eq!(MANAGED_TMUX_TERMINAL_FEATURES[4], "xterm*:hyperlinks");

    let config = build_default_root_mouse_bindings_config("open-pane-link", "open-status-pr");
    assert_eq!(
        config,
        [
            "bind-key -T root MouseDown1Pane if-shell \"open-pane-link\" \"\" \"select-pane -t = \\; send-keys -M\"",
            "bind-key -T root MouseDrag1Pane if-shell -F \"#{||:#{pane_in_mode},#{mouse_any_flag}}\" { send-keys -M } { copy-mode -M }",
            "bind-key -T root WheelUpPane if-shell -F \"#{&&:#{!=:#{alternate_on},1},#{!=:#{mouse_any_flag},1}}\" \"copy-mode -e \\; send-keys -X -N 1 scroll-up\" \"send-keys -M\"",
            "bind-key -T root WheelDownPane if-shell -F \"#{||:#{alternate_on},#{mouse_any_flag}}\" { send-keys -M } { send-keys -M }",
            "bind-key -T root DoubleClick1Pane if-shell \"open-pane-link\" \"\" \"send-keys -M\"",
            "bind-key -T root MouseDown1Status if-shell \"open-status-pr\" \"\" \"\"",
            "bind-key -T root DoubleClick1Status if-shell \"open-status-pr\" \"\" \"\"",
            "bind-key -T root MouseDown1StatusDefault if-shell \"open-status-pr\" \"\" \"\"",
            "bind-key -T root DoubleClick1StatusDefault if-shell \"open-status-pr\" \"\" \"\"",
            "bind-key -T copy-mode WheelUpPane send-keys -X -N 1 scroll-up",
            "bind-key -T copy-mode WheelDownPane send-keys -X -N 1 scroll-down",
            "bind-key -T copy-mode-vi WheelUpPane send-keys -X -N 1 scroll-up",
            "bind-key -T copy-mode-vi WheelDownPane send-keys -X -N 1 scroll-down",
            "bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel",
            "bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel",
            "",
        ]
        .join("\n")
    );
}

#[test]
fn mirrors_remaining_low_level_command_vectors() {
    assert_eq!(stop_pane_pipe_argv("@3"), ["pipe-pane", "-t", "@3"]);
    assert_eq!(
        send_text_argv("@3", "hello"),
        ["send-keys", "-t", "@3", "-l", "hello"]
    );
    assert_eq!(send_enter_argv("@3"), ["send-keys", "-t", "@3", "Enter"]);
    assert_eq!(
        send_client_enter_argv("/dev/ttys001"),
        ["send-keys", "-K", "-c", "/dev/ttys001", "Enter"]
    );
    assert_eq!(
        send_client_carriage_return_argv("/dev/ttys001", "@3"),
        ["send-keys", "-c", "/dev/ttys001", "-t", "@3", "-H", "0d"]
    );
    assert_eq!(
        send_carriage_return_argv("@3"),
        ["send-keys", "-t", "@3", "-H", "0d"]
    );
    assert_eq!(
        send_escape_argv("@3"),
        ["send-keys", "-t", "@3", "-H", "1b"]
    );
    assert_eq!(send_key_argv("@3", "C-j"), ["send-keys", "-t", "@3", "C-j"]);
    assert_eq!(
        switch_client_to_target_argv("/dev/ttys001", "@3"),
        ["switch-client", "-c", "/dev/ttys001", "-t", "@3"]
    );
    assert_eq!(
        attach_session_argv("aimux-mobile-abc", None),
        ["attach-session", "-t", "aimux-mobile-abc"]
    );
    assert_eq!(
        attach_session_argv("aimux-mobile-abc", Some(3)),
        ["attach-session", "-t", "aimux-mobile-abc:3"]
    );
    assert_eq!(kill_window_argv("@3"), ["kill-window", "-t", "@3"]);
    assert_eq!(clear_history_argv("@3"), ["clear-history", "-t", "@3"]);
    assert_eq!(select_window_argv("@3"), ["select-window", "-t", "@3"]);
}
