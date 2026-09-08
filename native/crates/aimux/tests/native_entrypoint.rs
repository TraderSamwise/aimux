use aimux::tui_render::text::strip_ansi;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn build_info_stays_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-build-info");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .args(["build-info", "--json"])
        .output()
        .expect("run native aimux");

    assert!(output.status.success());
    assert!(
        !log.exists(),
        "native command should not invoke node fallback"
    );
    let body: Value = serde_json::from_slice(&output.stdout).expect("build-info json");
    assert_eq!(body["profile"], "native-dev");
    assert_eq!(body["zero_node_cli_target"], true);
    cleanup(root);
}

#[test]
fn root_version_and_help_stay_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-root-help-version");
    fs::write(root.join("VERSION"), "9.8.7-test\n").expect("write version");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let version = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", &node)
        .arg("--version")
        .output()
        .expect("run native aimux version");
    assert!(version.status.success());
    assert_eq!(String::from_utf8_lossy(&version.stdout), "9.8.7-test\n");
    assert!(
        !log.exists(),
        "root --version should not invoke node fallback"
    );

    let help = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .arg("--help")
        .output()
        .expect("run native aimux help");
    assert!(help.status.success());
    let stdout = String::from_utf8_lossy(&help.stdout);
    assert!(stdout.contains("Native CLI agent multiplexer"));
    assert!(stdout.contains("compact"));
    assert!(stdout.contains("doctor"));
    assert!(!stdout.contains("--tmux-dashboard-internal"));
    assert!(!log.exists(), "root --help should not invoke node fallback");
    cleanup(root);
}

#[test]
fn core_subcommand_help_and_bare_parent_usage_stay_command_scoped() {
    let root = temp_root("native-core-scoped-help");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);
    fs::create_dir_all(root.join("home")).expect("create home");
    fs::create_dir_all(root.join("aimux-home")).expect("create aimux home");

    for (index, (args, expected, forbidden)) in [
        (
            vec!["overseer", "--help"],
            "Usage: aimux overseer [options] [command]",
            "Usage: aimux [options] [command] [tool]",
        ),
        (
            vec!["scribe", "--help"],
            "Usage: aimux scribe [options] [command]",
            "Usage: aimux [options] [command] [tool]",
        ),
        (
            vec!["host"],
            "Usage: aimux host [options] [command]",
            "unsupported or invalid aimux command",
        ),
        (
            vec!["loop", "list", "--help"],
            "Usage: aimux loop list [options]",
            "Usage: aimux [options] [command] [tool]",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
            .env("AIMUX_ROOT", &root)
            .env("AIMUX_NODE_BIN", &node)
            .env("HOME", root.join("home"))
            .env("AIMUX_HOME", root.join("aimux-home"))
            .env("AIMUX_DAEMON_PORT", format!("{}", 46270 + index))
            .args(args)
            .output()
            .expect("run native aimux help");
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stdout.contains(expected), "{stdout}");
        assert!(!stdout.contains(forbidden), "{stdout}");
        assert!(stderr.is_empty(), "{stderr}");
    }

    assert!(
        !log.exists(),
        "core help should not invoke node fallback or daemon I/O"
    );
    cleanup(root);
}

#[test]
fn ui_command_stays_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-ui");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .args(["ui", "--no-daemon"])
        .output()
        .expect("run native aimux");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Local UI build not found"),
        "stderr should report missing UI build"
    );
    assert!(!log.exists(), "ui command should not invoke node fallback");
    cleanup(root);
}

#[test]
fn native_dashboard_internal_once_renders_snapshot_without_node_fallback() {
    let root = temp_root("native-dashboard-internal");
    fs::write(root.join("VERSION"), "local-dashboard-test\n").expect("write version");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);
    let desktop_state_file = root.join("desktop-state.json");
    fs::write(
        &desktop_state_file,
        include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json"),
    )
    .expect("write desktop-state fixture");

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .args([
            "__dashboard-internal-native",
            "--project-root",
            root.to_str().unwrap(),
            "--desktop-state-file",
            desktop_state_file.to_str().unwrap(),
            "--cols",
            "120",
            "--rows",
            "32",
            "--once",
        ])
        .output()
        .expect("run native aimux");

    assert!(output.status.success());
    assert!(
        !log.exists(),
        "native dashboard should not invoke node fallback"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(strip_ansi(&stdout).contains("aimux vlocal-dashboard-test"));
    assert!(stdout.contains("agent multiplexer"));
    assert!(stdout.contains("Main Checkout"));
    assert!(stdout.contains("feature-a"));
    assert!(stdout.contains("native"));
    cleanup(root);
}

#[test]
fn root_dashboard_entry_stays_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-root-dashboard");
    fs::create_dir_all(root.join("dist")).expect("create dist");
    fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .env("AIMUX_DAEMON_PORT", "0")
        .output()
        .expect("run native aimux");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("AIMUX_DAEMON_PORT must be an integer between 1 and 65535"),
        "stderr should report invalid daemon port"
    );
    assert!(
        !log.exists(),
        "root dashboard command should not invoke node fallback"
    );
    cleanup(root);
}

#[test]
fn daemon_restart_stays_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-daemon-restart");
    fs::create_dir_all(root.join("dist")).expect("create dist");
    fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .env("AIMUX_DAEMON_PORT", "0")
        .args(["daemon", "restart", "--json"])
        .output()
        .expect("run native aimux");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("AIMUX_DAEMON_PORT must be an integer between 1 and 65535"),
        "stderr should report invalid daemon port"
    );
    assert!(
        !log.exists(),
        "daemon restart should not invoke node fallback"
    );
    cleanup(root);
}

#[test]
fn configured_tool_launch_stays_native_with_original_tool_args() {
    let root = temp_root("native-tool-launch");
    fs::create_dir_all(root.join(".git")).expect("create repo marker");
    fs::create_dir_all(root.join("dist")).expect("create dist");
    fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .current_dir(&root)
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .env("AIMUX_DAEMON_PORT", "0")
        .args(["codex", "--model", "gpt-5"])
        .output()
        .expect("run native aimux");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("AIMUX_DAEMON_PORT must be an integer between 1 and 65535"),
        "stderr should report invalid daemon port"
    );
    assert!(
        !log.exists(),
        "configured tool launch should not invoke node fallback"
    );
    cleanup(root);
}

#[test]
fn root_resume_entry_stays_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-root-resume");
    fs::create_dir_all(root.join(".git")).expect("create repo marker");
    fs::create_dir_all(root.join("dist")).expect("create dist");
    fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .current_dir(&root)
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .env("AIMUX_DAEMON_PORT", "0")
        .args(["--resume", "codex"])
        .output()
        .expect("run native aimux");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("AIMUX_DAEMON_PORT must be an integer between 1 and 65535"),
        "stderr should report invalid daemon port"
    );
    assert!(!log.exists(), "root resume should not invoke node fallback");
    cleanup(root);
}

#[test]
fn doctor_installs_stays_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-doctor-installs");
    let install_root = root.join("native");
    fs::create_dir_all(root.join("dist")).expect("create dist");
    fs::create_dir_all(&install_root).expect("create install root");
    fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .current_dir(&root)
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_INSTALL_ROOT", &install_root)
        .env("AIMUX_NODE_BIN", node)
        .args(["doctor", "installs", "--json"])
        .output()
        .expect("run native aimux");

    assert!(output.status.success());
    assert!(
        !log.exists(),
        "doctor installs should not invoke node fallback"
    );
    let body: Value = serde_json::from_slice(&output.stdout).expect("doctor installs json");
    assert_eq!(body["dryRun"], true);
    assert_eq!(
        body["plan"]["root"].as_str(),
        Some(install_root.to_str().unwrap())
    );
    cleanup(root);
}

#[test]
fn migration_audit_stays_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-migration-audit");
    let repo = root.join("repo");
    let home = root.join("home");
    fs::create_dir_all(repo.join(".git")).expect("create repo marker");
    fs::create_dir_all(&home).expect("create aimux home");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .current_dir(&repo)
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_HOME", &home)
        .env("AIMUX_NODE_BIN", node)
        .args(["migration", "audit"])
        .output()
        .expect("run native aimux");

    assert!(output.status.success());
    assert!(
        !log.exists(),
        "migration audit should not invoke node fallback"
    );
    let body: Value = serde_json::from_slice(&output.stdout).expect("migration audit json");
    assert_eq!(body["status"], "clean");
    assert_eq!(
        body["project"]["repoRoot"],
        repo.canonicalize().unwrap().to_str().unwrap()
    );
    cleanup(root);
}

#[test]
fn doctor_notifications_stays_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-doctor-notifications");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .env("AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS", "1")
        .args(["doctor", "notifications", "--json"])
        .output()
        .expect("run native aimux");

    assert!(output.status.success());
    assert!(
        !log.exists(),
        "doctor notifications should not invoke node fallback"
    );
    let body: Value = serde_json::from_slice(&output.stdout).expect("doctor notifications json");
    assert_eq!(body["transport"], "disabled");
    cleanup(root);
}

#[test]
fn notifications_test_stays_native_even_when_node_fallback_is_configured() {
    let root = temp_root("native-notifications-test");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .env("AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS", "1")
        .args(["notifications", "test", "--json"])
        .output()
        .expect("run native aimux");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        !log.exists(),
        "notifications test should not invoke node fallback"
    );
    let body: Value = serde_json::from_slice(&output.stdout).expect("notifications test json");
    assert_eq!(body["ok"], false);
    assert_eq!(body["attempt"]["transport"], "disabled");
    cleanup(root);
}

#[test]
fn known_auxiliary_command_help_stays_native_even_when_node_fallback_is_configured() {
    for command in ["metadata", "logs", "team", "outline", "attachment"] {
        let root = temp_root(&format!("native-{command}-help"));
        fs::create_dir_all(root.join("dist")).expect("create dist");
        fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
        let log = root.join("node.log");
        let node = fake_node(&root, &log, 9);

        let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
            .env("AIMUX_ROOT", &root)
            .env("AIMUX_NODE_BIN", node)
            .args([command, "--help"])
            .output()
            .expect("run native aimux known command help");

        assert!(output.status.success(), "{command} --help should succeed");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("Native CLI agent multiplexer"),
            "{command} --help should render native help"
        );
        assert!(
            !log.exists(),
            "{command} --help should not invoke node fallback"
        );
        cleanup(root);
    }
}

#[test]
fn malformed_known_auxiliary_commands_fail_native_without_node_fallback() {
    for args in [
        vec!["metadata", "event"],
        vec!["logs", "unknown"],
        vec!["team", "add"],
        vec!["outline", "show"],
        vec!["attachment", "publish"],
    ] {
        let root = temp_root(&format!("native-{}-invalid", args[0]));
        fs::create_dir_all(root.join("dist")).expect("create dist");
        fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
        let log = root.join("node.log");
        let node = fake_node(&root, &log, 9);

        let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
            .env("AIMUX_ROOT", &root)
            .env("AIMUX_NODE_BIN", node)
            .args(args)
            .output()
            .expect("run native aimux malformed known command");

        assert!(
            !output.status.success(),
            "malformed known command should fail natively"
        );
        assert!(!log.exists(), "known malformed command should stay native");
        cleanup(root);
    }
}

#[cfg(unix)]
#[test]
fn unknown_main_commands_fail_native_without_node_fallback() {
    let root = temp_root("native-no-node-fallback");
    fs::create_dir_all(root.join("dist")).expect("create dist");
    fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 7);

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .args(["unknown-command", "--json"])
        .output()
        .expect("run native aimux");

    assert_eq!(output.status.code(), Some(2));
    assert!(
        !log.exists(),
        "unknown command should not invoke node fallback"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("unrecognized subcommand"));
    cleanup(root);
}

fn fake_node(root: &std::path::Path, log: &std::path::Path, code: i32) -> PathBuf {
    let path = root.join("fake-node");
    fs::write(
        &path,
        format!(
            "#!/bin/sh\n: > '{}'\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\" >> '{}'; done\nexit {code}\n",
            shell_single_quote(log),
            shell_single_quote(log)
        ),
    )
    .expect("write fake node");
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path)
            .expect("fake node metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("chmod fake node");
    }
    path
}

fn shell_single_quote(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\'', "'\\''")
}

fn temp_root(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    fs::create_dir_all(&path).expect("create temp root");
    path
}

fn cleanup(path: PathBuf) {
    let _ = fs::remove_dir_all(path);
}
