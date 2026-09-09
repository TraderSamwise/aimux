use aimux::dashboard_readiness::{dashboard_ready_option_commands, runtime_owner_id_from_parts};
use aimux::tmux::{
    TMUX_DASHBOARD_BUILD_OPTION, TMUX_DASHBOARD_OWNER_OPTION, TMUX_DASHBOARD_READY_OPTION,
};

#[test]
fn runtime_owner_id_matches_typescript_json_shape() {
    assert_eq!(
        runtime_owner_id_from_parts("/Users/sam/.aimux", "43190"),
        r#"{"home":"/Users/sam/.aimux","port":"43190"}"#
    );
}

#[test]
fn dashboard_ready_option_commands_set_build_owner_then_ready() {
    let commands = dashboard_ready_option_commands("%42", "build-123", "owner-123");

    assert_eq!(
        commands,
        vec![
            vec![
                "set-window-option",
                "-q",
                "-t",
                "%42",
                TMUX_DASHBOARD_BUILD_OPTION,
                "build-123",
            ],
            vec![
                "set-window-option",
                "-q",
                "-t",
                "%42",
                TMUX_DASHBOARD_OWNER_OPTION,
                "owner-123",
            ],
            vec![
                "set-window-option",
                "-q",
                "-t",
                "%42",
                TMUX_DASHBOARD_READY_OPTION,
                "build-123",
            ],
        ]
    );
}
