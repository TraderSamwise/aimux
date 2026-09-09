use aimux::launcher_env::{CliEntry, cli_entry_for};

#[test]
fn routes_core_expose_and_main_like_launcher_env() {
    assert_eq!(
        cli_entry_for(&["node", "aimux", "daemon", "status"]),
        CliEntry::Core
    );
    assert_eq!(
        cli_entry_for(&["node", "aimux", "projects", "list", "--json"]),
        CliEntry::Core
    );
    assert_eq!(
        cli_entry_for(&["node", "aimux", "daemon", "run"]),
        CliEntry::Main
    );
    assert_eq!(
        cli_entry_for(&["node", "aimux", "doctor", "versions"]),
        CliEntry::Core
    );
    assert_eq!(
        cli_entry_for(&["node", "aimux", "expose"]),
        CliEntry::Expose
    );
    assert_eq!(
        cli_entry_for(&["node", "aimux", "dashboard-reload"]),
        CliEntry::Main
    );
    assert_eq!(cli_entry_for(&["node", "aimux", "unknown"]), CliEntry::Main);
}

#[test]
fn global_logging_flags_match_launcher_env_fixture() {
    assert_eq!(
        cli_entry_for(&["node", "aimux", "--debug", "remote", "status"]),
        CliEntry::Main
    );
    assert_eq!(
        cli_entry_for(&[
            "node",
            "aimux",
            "daemon",
            "project-ensure",
            "--project",
            "/p",
            "--trace"
        ]),
        CliEntry::Main
    );
    assert_eq!(
        cli_entry_for(&[
            "node",
            "aimux",
            "daemon",
            "project-ensure",
            "--project",
            "--json",
            "--debug"
        ]),
        CliEntry::Core
    );
    assert_eq!(
        cli_entry_for(&["node", "aimux", "--log-level", "debug", "build-info"]),
        CliEntry::Main
    );
}
