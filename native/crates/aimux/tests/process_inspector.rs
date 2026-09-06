use aimux::process_inspector::{
    ProjectServiceProcessIdentity, command_arg_value_matches, is_aimux_daemon_process_args,
    is_aimux_project_service_process_args, is_exited_process_state,
    is_native_aimux_daemon_process_args, is_native_aimux_project_service_process_args,
    is_pid_alive, list_process_args, list_process_parents, read_process_args,
};

#[test]
fn command_arg_value_matching_preserves_shell_quote_and_flag_boundaries() {
    assert!(command_arg_value_matches(
        "node main.js __project-service-internal --project-id abc --project-root /repo",
        "--project-id",
        "abc"
    ));
    assert!(command_arg_value_matches(
        "node main.js --project-root '/repo with spaces' --project-id other",
        "--project-root",
        "/repo with spaces"
    ));
    assert!(command_arg_value_matches(
        "node main.js --project-root \"/repo with spaces\"",
        "--project-root",
        "/repo with spaces"
    ));
    assert!(!command_arg_value_matches(
        "node main.js --other-project-id abc",
        "--project-id",
        "abc"
    ));
    assert!(!command_arg_value_matches(
        "node main.js --project-id abc --project-root /repo",
        "--project-id",
        "abc --project-root /repo"
    ));
}

#[test]
fn project_service_process_identity_matches_type_script_conditions() {
    let expected = ProjectServiceProcessIdentity {
        project_id: Some("project-1".into()),
        project_root: Some("/repo".into()),
    };
    assert!(is_aimux_project_service_process_args(
        "node launcher-bin.js __project-service-internal --project-id project-1 --project-root /repo",
        None,
        &expected
    ));
    assert!(!is_aimux_project_service_process_args(
        "node launcher-bin.js __project-service-internal --project-id project-2 --project-root /repo",
        None,
        &expected
    ));
    assert!(!is_aimux_project_service_process_args(
        "node launcher-bin.js daemon run --project-id project-1 --project-root /repo",
        None,
        &expected
    ));
}

#[test]
fn project_service_identity_falls_back_to_cwd_for_legacy_processes() {
    let cwd = std::env::current_dir().expect("current dir");
    let expected = ProjectServiceProcessIdentity {
        project_id: None,
        project_root: Some(cwd.to_string_lossy().into_owned()),
    };
    assert!(is_aimux_project_service_process_args(
        "node launcher-bin.js __project-service-internal",
        Some("."),
        &expected
    ));
}

#[test]
fn daemon_process_identity_requires_aimux_daemon_run_command() {
    assert!(is_aimux_daemon_process_args(
        "/Users/sam/.aimux/native/current/bin/aimux daemon run"
    ));
    assert!(is_aimux_daemon_process_args(
        "/opt/homebrew/bin/node /Users/sam/.aimux/native/current/dist/launcher-bin.js daemon run daemon"
    ));
    assert!(!is_aimux_daemon_process_args(
        "/opt/homebrew/bin/node /tmp/not-aimux.js daemon run"
    ));
    assert!(!is_aimux_daemon_process_args(
        "/Users/sam/.aimux/native/current/bin/aimux project start"
    ));
}

#[test]
fn native_process_identity_rejects_node_launcher_control_plane() {
    let expected = ProjectServiceProcessIdentity {
        project_id: Some("project-1".into()),
        project_root: Some("/repo".into()),
    };
    assert!(is_native_aimux_project_service_process_args(
        "/Users/sam/.aimux/native/current/bin/aimux __project-service-internal --project-id project-1 --project-root /repo",
        None,
        &expected
    ));
    assert!(!is_native_aimux_project_service_process_args(
        "/opt/homebrew/bin/node /Users/sam/.aimux/native/current/dist/launcher-bin.js __project-service-internal --project-id project-1 --project-root /repo",
        None,
        &expected
    ));
    assert!(is_native_aimux_daemon_process_args(
        "/Users/sam/.aimux/native/current/bin/aimux daemon run"
    ));
    assert!(!is_native_aimux_daemon_process_args(
        "/opt/homebrew/bin/node /Users/sam/.aimux/native/current/dist/launcher-bin.js daemon run"
    ));
}

#[test]
fn process_liveness_and_state_checks_match_node_helpers() {
    let pid = std::process::id() as i32;
    assert!(is_pid_alive(pid));
    assert!(
        read_process_args(pid)
            .expect("current process args")
            .contains("process_inspector")
    );
    assert!(!is_pid_alive(-1));
    assert!(is_exited_process_state("Z+"));
    assert!(is_exited_process_state("  Z"));
    assert!(!is_exited_process_state("S+"));
}

#[test]
fn process_lists_parse_real_ps_output() {
    let pid = std::process::id() as i32;
    assert!(list_process_args().iter().any(|entry| entry.pid == pid));
    assert!(
        list_process_parents()
            .iter()
            .any(|(entry_pid, _)| *entry_pid == pid)
    );
}
