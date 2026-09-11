use aimux::release_version_contract::read_aimux_version_from_package_root;
use aimux::tui_render::text::strip_ansi;
use serde_json::Value;
use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

mod support;

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
    assert_eq!(
        String::from_utf8_lossy(&version.stdout),
        format!("{}\n", read_aimux_version_from_package_root(&root))
    );
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
    for command in [
        "  spawn",
        "  ui",
        "  logs",
        "  metadata",
        "  attachment",
        "  outline",
        "  team",
        "  remote",
        "  security",
        "  hosted",
        "  debug-state",
    ] {
        assert!(
            stdout.contains(command),
            "root help should include {command}"
        );
    }
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

    for (args, expected, forbidden) in [
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
    {
        let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
            .env("AIMUX_ROOT", &root)
            .env("AIMUX_NODE_BIN", &node)
            .env("HOME", root.join("home"))
            .env("AIMUX_HOME", root.join("aimux-home"))
            .env("AIMUX_DAEMON_PORT", allocate_daemon_port().to_string())
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
fn loop_list_entrypoint_reaches_core_cli_instead_of_known_command_fallback() {
    let fixture = NativeEntrypointFixture::new("native-loop-list");
    let repo = fixture.root.join("repo");
    fs::create_dir_all(repo.join(".git")).expect("create repo");

    let output = fixture
        .command()
        .current_dir(&repo)
        .args(["loop", "list", "--json"])
        .output()
        .expect("run native loop list");

    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).expect("loop list json"),
        serde_json::json!({ "agents": [] })
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("unsupported or invalid aimux command"));
    assert!(
        !fixture.log.exists(),
        "loop list should not invoke node fallback"
    );
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
    assert!(
        strip_ansi(&stdout).contains(&format!(
            "aimux v{}",
            read_aimux_version_from_package_root(&root)
        )),
        "{stdout}"
    );
    assert!(stdout.contains("agent multiplexer"));
    assert!(stdout.contains("Main Checkout"));
    assert!(stdout.contains("feature-a"));
    assert!(stdout.contains("tmux"));
    cleanup(root);
}

#[test]
fn native_dashboard_internal_version_prefers_running_binary_over_stale_aimux_env() {
    let root = temp_root("native-dashboard-current-exe-version");
    let current_root = root.join("install-current");
    let stale_root = root.join("install-stale");
    let current_binary = current_root
        .join("native")
        .join(host_native_dirname())
        .join("aimux");
    let stale_binary = stale_root
        .join("native")
        .join(host_native_dirname())
        .join("aimux");
    fs::create_dir_all(current_binary.parent().expect("current binary parent"))
        .expect("create current native dir");
    fs::create_dir_all(stale_binary.parent().expect("stale binary parent"))
        .expect("create stale native dir");
    fs::copy(env!("CARGO_BIN_EXE_aimux"), &current_binary).expect("copy native binary");
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&current_binary)
            .expect("current native metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&current_binary, permissions).expect("chmod current native binary");
    }
    fs::write(current_root.join("VERSION"), "local-current-exe\n").expect("write current version");
    fs::write(stale_root.join("VERSION"), "local-stale-env\n").expect("write stale version");
    fs::write(&stale_binary, "").expect("write stale native binary");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);
    let desktop_state_file = root.join("desktop-state.json");
    fs::write(
        &desktop_state_file,
        include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json"),
    )
    .expect("write desktop-state fixture");

    let output = Command::new(&current_binary)
        .env("AIMUX_ROOT", &stale_root)
        .env("AIMUX_NATIVE_BIN", &stale_binary)
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
        .expect("run installed native dashboard");

    assert!(output.status.success());
    assert!(
        !log.exists(),
        "native dashboard should not invoke node fallback"
    );
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    assert!(stdout.contains("aimux vlocal-current-exe"), "{stdout}");
    assert!(!stdout.contains("local-stale-env"), "{stdout}");
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
fn debug_daemon_run_refuses_default_port_before_writing_daemon_info() {
    let root = temp_root("native-debug-daemon-run-default-port");
    let aimux_home = root.join("aimux-home");
    fs::create_dir_all(root.join("home")).expect("create home");
    fs::create_dir_all(&aimux_home).expect("create aimux home");

    let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("HOME", root.join("home"))
        .env("AIMUX_HOME", &aimux_home)
        .env("AIMUX_TMUX_SOCKET_PATH", root.join("tmux.sock"))
        .env_remove("AIMUX_DAEMON_PORT")
        .args(["daemon", "run"])
        .output()
        .expect("run native daemon");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("refusing to run aimux daemon from a cargo target binary on default port"),
        "stderr should report default-port debug daemon refusal"
    );
    assert!(
        !aimux_home.join("daemon/daemon.json").exists(),
        "refusal must happen before daemon info is written"
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

    let isolation = support::TestIsolation::new("native-doctor-installs");
    let mut command = Command::new(env!("CARGO_BIN_EXE_aimux"));
    isolation
        .apply_to_command(&mut command)
        .current_dir(&root)
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_INSTALL_ROOT", &install_root)
        .env("AIMUX_NODE_BIN", node)
        .args(["doctor", "installs", "--json"]);
    let output = command.output().expect("run native aimux");

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
    for (command, expected) in [
        ("metadata", "Usage: aimux metadata [options] [command]"),
        ("logs", "Usage: aimux logs [options] [command]"),
        ("team", "Usage: aimux team [options] [command]"),
        ("outline", "Usage: aimux outline [options] [command]"),
        ("attachment", "Usage: aimux attachment [options] [command]"),
    ] {
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
            String::from_utf8_lossy(&output.stdout).contains(expected),
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
fn domain11_cli_command_help_is_command_scoped() {
    for (index, (args, expected)) in [
        (
            vec!["migration", "--help"],
            "Usage: aimux migration [options] [command]",
        ),
        (
            vec!["repair", "--help"],
            "Usage: aimux repair [options] [command]",
        ),
        (
            vec!["security", "--help"],
            "Usage: aimux security [options] [command]",
        ),
        (
            vec!["security", "devices", "--help"],
            "Usage: aimux security devices [options]",
        ),
        (
            vec!["security", "approve", "--help"],
            "Usage: aimux security approve <deviceId> [options]",
        ),
        (vec!["whoami", "--help"], "Usage: aimux whoami [options]"),
        (vec!["login", "--help"], "Usage: aimux login"),
        (vec!["logout", "--help"], "Usage: aimux logout"),
        (
            vec!["remote", "--help"],
            "Usage: aimux remote [options] [command]",
        ),
        (vec!["serve", "--help"], "Usage: aimux serve"),
        (
            vec!["notifications", "--help"],
            "Usage: aimux notifications [options] [command]",
        ),
        (
            vec!["hosted", "--help"],
            "Usage: aimux hosted [options] [command]",
        ),
        (
            vec!["dashboard-reload", "--help"],
            "Usage: aimux dashboard-reload [options]",
        ),
        (
            vec!["restart-runtime", "--help"],
            "Usage: aimux restart-runtime [options]",
        ),
        (
            vec!["id", "--help"],
            "Usage: aimux id <sessionId> [options]",
        ),
        (
            vec!["rename", "--help"],
            "Usage: aimux rename <sessionId> [options]",
        ),
        (
            vec!["stop", "--help"],
            "Usage: aimux stop [sessionId] [options]",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let root = temp_root(&format!("native-domain11-help-{index}"));
        fs::create_dir_all(root.join("home")).expect("create home");
        fs::create_dir_all(root.join("aimux-home")).expect("create aimux home");

        let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
            .env("HOME", root.join("home"))
            .env("AIMUX_HOME", root.join("aimux-home"))
            .env("AIMUX_DAEMON_PORT", allocate_daemon_port().to_string())
            .args(args)
            .output()
            .expect("run native aimux command help");

        assert!(output.status.success(), "{index} help should succeed");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stdout.contains(expected), "{stdout}");
        assert!(
            !stdout.contains("Usage: aimux [options] [command] [tool]"),
            "{stdout}"
        );
        assert!(stderr.is_empty(), "{stderr}");
        cleanup(root);
    }
}

#[test]
fn advertised_command_groups_render_command_scoped_help() {
    for (index, (args, expected)) in [
        (vec!["restart", "--help"], "Usage: aimux restart [options]"),
        (
            vec!["daemon", "--help"],
            "Usage: aimux daemon [options] [command]",
        ),
        (
            vec!["projects", "--help"],
            "Usage: aimux projects [options] [command]",
        ),
        (vec!["compact", "--help"], "Usage: aimux compact"),
        (
            vec!["worktree", "--help"],
            "Usage: aimux worktree [options] [command]",
        ),
        (
            vec!["thread", "--help"],
            "Usage: aimux thread [options] [command]",
        ),
        (vec!["threads", "--help"], "Usage: aimux threads [options]"),
        (
            vec!["input", "--help"],
            "Usage: aimux input <sessionId> <text...> [options]",
        ),
        (
            vec!["attachment", "--help"],
            "Usage: aimux attachment [options] [command]",
        ),
        (vec!["ps", "--help"], "Usage: aimux ps [options]"),
        (vec!["list", "--help"], "Usage: aimux list [options]"),
        (
            vec!["message", "--help"],
            "Usage: aimux message [options] [command]",
        ),
        (
            vec!["handoff", "--help"],
            "Usage: aimux handoff [options] [command]",
        ),
        (
            vec!["task", "--help"],
            "Usage: aimux task [options] [command]",
        ),
        (
            vec!["review", "--help"],
            "Usage: aimux review [options] [command]",
        ),
        (
            vec!["graveyard", "--help"],
            "Usage: aimux graveyard [options] [command]",
        ),
        (
            vec!["debug-state", "--help"],
            "Usage: aimux debug-state <sessionId>",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let root = temp_root(&format!("native-advertised-help-{index}"));
        fs::create_dir_all(root.join("home")).expect("create home");
        fs::create_dir_all(root.join("aimux-home")).expect("create aimux home");

        let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
            .env("HOME", root.join("home"))
            .env("AIMUX_HOME", root.join("aimux-home"))
            .env("AIMUX_DAEMON_PORT", allocate_daemon_port().to_string())
            .args(args)
            .output()
            .expect("run advertised command help");

        assert!(output.status.success(), "{index} help should succeed");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stdout.contains(expected), "{stdout}");
        assert!(
            !stdout.contains("Usage: aimux [options] [command] [tool]"),
            "{stdout}"
        );
        assert!(stderr.is_empty(), "{stderr}");
        cleanup(root);
    }
}

#[test]
fn advertised_subcommands_without_specific_help_render_group_scoped_help() {
    for (index, (args, expected)) in [
        (
            vec!["daemon", "ensure", "--help"],
            "Usage: aimux daemon [options] [command]",
        ),
        (
            vec!["daemon", "status", "--help"],
            "Usage: aimux daemon [options] [command]",
        ),
        (
            vec!["daemon", "projects", "--help"],
            "Usage: aimux daemon [options] [command]",
        ),
        (
            vec!["daemon", "project-ensure", "--help"],
            "Usage: aimux daemon [options] [command]",
        ),
        (
            vec!["daemon", "restart", "--help"],
            "Usage: aimux daemon [options] [command]",
        ),
        (
            vec!["daemon", "stop", "--help"],
            "Usage: aimux daemon [options] [command]",
        ),
        (
            vec!["daemon", "kill", "--help"],
            "Usage: aimux daemon [options] [command]",
        ),
        (
            vec!["projects", "list", "--help"],
            "Usage: aimux projects [options] [command]",
        ),
        (
            vec!["worktree", "list", "--help"],
            "Usage: aimux worktree [options] [command]",
        ),
        (
            vec!["thread", "list", "--help"],
            "Usage: aimux thread [options] [command]",
        ),
        (
            vec!["thread", "show", "--help"],
            "Usage: aimux thread [options] [command]",
        ),
        (
            vec!["thread", "open", "--help"],
            "Usage: aimux thread [options] [command]",
        ),
        (
            vec!["thread", "send", "--help"],
            "Usage: aimux thread [options] [command]",
        ),
        (
            vec!["thread", "mark-seen", "--help"],
            "Usage: aimux thread [options] [command]",
        ),
        (
            vec!["thread", "status", "--help"],
            "Usage: aimux thread [options] [command]",
        ),
        (
            vec!["attachment", "publish", "--help"],
            "Usage: aimux attachment [options] [command]",
        ),
        (
            vec!["message", "send", "--help"],
            "Usage: aimux message [options] [command]",
        ),
        (
            vec!["handoff", "send", "--help"],
            "Usage: aimux handoff [options] [command]",
        ),
        (
            vec!["handoff", "accept", "--help"],
            "Usage: aimux handoff [options] [command]",
        ),
        (
            vec!["handoff", "complete", "--help"],
            "Usage: aimux handoff [options] [command]",
        ),
        (
            vec!["task", "list", "--help"],
            "Usage: aimux task [options] [command]",
        ),
        (
            vec!["task", "show", "--help"],
            "Usage: aimux task [options] [command]",
        ),
        (
            vec!["task", "assign", "--help"],
            "Usage: aimux task [options] [command]",
        ),
        (
            vec!["task", "accept", "--help"],
            "Usage: aimux task [options] [command]",
        ),
        (
            vec!["task", "block", "--help"],
            "Usage: aimux task [options] [command]",
        ),
        (
            vec!["task", "cancel", "--help"],
            "Usage: aimux task [options] [command]",
        ),
        (
            vec!["task", "complete", "--help"],
            "Usage: aimux task [options] [command]",
        ),
        (
            vec!["task", "reopen", "--help"],
            "Usage: aimux task [options] [command]",
        ),
        (
            vec!["review", "list", "--help"],
            "Usage: aimux review [options] [command]",
        ),
        (
            vec!["review", "approve", "--help"],
            "Usage: aimux review [options] [command]",
        ),
        (
            vec!["review", "request-changes", "--help"],
            "Usage: aimux review [options] [command]",
        ),
        (
            vec!["graveyard", "list", "--help"],
            "Usage: aimux graveyard [options] [command]",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let root = temp_root(&format!("native-advertised-subcommand-help-{index}"));
        fs::create_dir_all(root.join("home")).expect("create home");
        fs::create_dir_all(root.join("aimux-home")).expect("create aimux home");

        let output = Command::new(env!("CARGO_BIN_EXE_aimux"))
            .env("HOME", root.join("home"))
            .env("AIMUX_HOME", root.join("aimux-home"))
            .env("AIMUX_DAEMON_PORT", allocate_daemon_port().to_string())
            .args(args)
            .output()
            .expect("run advertised subcommand help");

        assert!(output.status.success(), "{index} help should succeed");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stdout.contains(expected), "{stdout}");
        assert!(
            !stdout.contains("Usage: aimux [options] [command] [tool]"),
            "{stdout}"
        );
        assert!(stderr.is_empty(), "{stderr}");
        cleanup(root);
    }
}

#[test]
fn bare_default_command_groups_execute_instead_of_printing_help() {
    let fixture = NativeEntrypointFixture::new("native-bare-defaults");
    let repo = fixture.root.join("repo");
    fs::create_dir_all(repo.join(".git")).expect("create repo");

    for (args, forbidden) in [
        (
            vec!["projects"],
            "Usage: aimux projects [options] [command]",
        ),
        (
            vec!["worktree"],
            "Usage: aimux worktree [options] [command]",
        ),
        (
            vec!["graveyard"],
            "Usage: aimux graveyard [options] [command]",
        ),
    ] {
        let output = fixture
            .command()
            .current_dir(&repo)
            .args(args)
            .output()
            .expect("run bare default command");

        assert!(output.status.success(), "{output:?}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            !stdout.contains(forbidden),
            "bare command should execute its existing default, not print help: {stdout}"
        );
    }

    let no_default = fixture
        .command()
        .current_dir(&repo)
        .arg("task")
        .output()
        .expect("run bare parent command");
    assert!(no_default.status.success(), "{no_default:?}");
    let stdout = String::from_utf8_lossy(&no_default.stdout);
    assert!(stdout.contains("Usage: aimux task [options] [command]"));
    assert!(
        !fixture.log.exists(),
        "native default/help routing should not invoke node fallback"
    );
}

#[test]
fn invalid_known_commands_name_the_argument_problem_while_unknown_commands_stay_unknown() {
    let root = temp_root("native-known-command-invalid");
    fs::create_dir_all(root.join("dist")).expect("create dist");
    fs::create_dir_all(root.join("home")).expect("create home");
    fs::create_dir_all(root.join("aimux-home")).expect("create aimux home");
    fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 9);

    let invalid = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", &node)
        .env("HOME", root.join("home"))
        .env("AIMUX_HOME", root.join("aimux-home"))
        .env("AIMUX_DAEMON_PORT", allocate_daemon_port().to_string())
        .args(["projects", "remove", "--project", "/repo"])
        .output()
        .expect("run invalid known command");
    assert_eq!(invalid.status.code(), Some(2));
    let invalid_stderr = String::from_utf8_lossy(&invalid.stderr);
    assert!(
        invalid_stderr.contains("projects remove requires <path> as a positional argument"),
        "{invalid_stderr}"
    );
    assert!(
        invalid_stderr.contains("Usage: aimux projects <remove|unregister> <path>"),
        "{invalid_stderr}"
    );
    assert!(
        !invalid_stderr.contains("unsupported or invalid aimux command"),
        "{invalid_stderr}"
    );

    let unknown = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .env("HOME", root.join("home"))
        .env("AIMUX_HOME", root.join("aimux-home"))
        .env("AIMUX_DAEMON_PORT", allocate_daemon_port().to_string())
        .args(["unknown-command", "--json"])
        .output()
        .expect("run unknown command");
    assert_eq!(unknown.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("unrecognized subcommand"));
    assert!(!log.exists(), "native fallback should not invoke node");
    cleanup(root);
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

#[test]
fn hosted_status_entrypoint_matches_node_shape_without_node_fallback() {
    let fixture = NativeEntrypointFixture::new("native-hosted-status");
    fs::write(
        fixture.aimux_home.join("config.json"),
        r#"{
  "hosted": {
    "enabled": true,
    "bindAddress": "0.0.0.0",
    "port": 43210,
    "retentionDays": 45,
    "webhookUrl": "https://example.com/hook",
    "trustedForwardedHeader": "x-forwarded-for"
  }
}
"#,
    )
    .expect("write hosted config");

    let output = fixture
        .command()
        .args(["hosted", "status", "--json"])
        .output()
        .expect("run hosted status");

    assert!(output.status.success());
    assert!(
        !fixture.log.exists(),
        "hosted status should not invoke node fallback"
    );
    let body: Value = serde_json::from_slice(&output.stdout).expect("hosted status json");
    assert_eq!(body["enabled"], true);
    assert_eq!(body["bindAddress"], "0.0.0.0");
    assert_eq!(body["port"], 43210);
    assert_eq!(body["webhookConfigured"], true);
    assert_eq!(body["trustedForwardedHeader"], "x-forwarded-for");
    assert_eq!(body["retentionDays"], 45);
    assert_eq!(
        body["principals"],
        serde_json::json!({ "total": 0, "active": 0 })
    );
    assert_eq!(
        body["lockdown"],
        serde_json::json!({ "active": false, "since": null })
    );
    assert_eq!(body["startup"]["ok"], false);
    assert!(
        body["startup"]["error"]
            .as_str()
            .unwrap()
            .contains("hosted mode refuses to bind 0.0.0.0")
    );
}

#[test]
fn hosted_token_grant_lockdown_and_audit_entrypoints_mutate_native_store() {
    let fixture = NativeEntrypointFixture::new("native-hosted-roundtrip");
    let create = fixture
        .command()
        .args(["hosted", "token", "create", "--label", "sam"])
        .output()
        .expect("create hosted token");
    assert!(create.status.success());
    assert!(
        !fixture.log.exists(),
        "hosted token create should not invoke node fallback"
    );
    let stdout = String::from_utf8_lossy(&create.stdout);
    let principal_id = stdout
        .lines()
        .find_map(|line| line.strip_prefix("Principal: "))
        .and_then(|line| line.split_whitespace().next())
        .expect("principal id in output")
        .to_owned();
    assert!(principal_id.starts_with("prn_"));
    let token = stdout
        .lines()
        .find_map(|line| line.strip_prefix("Token:     "))
        .expect("token in output");
    assert!(token.starts_with("amx_"));

    let list = fixture
        .command()
        .args(["hosted", "token", "list", "--json"])
        .output()
        .expect("list hosted tokens");
    assert!(list.status.success());
    let listed: Value = serde_json::from_slice(&list.stdout).expect("principal list json");
    assert_eq!(listed[0]["id"], principal_id);
    assert_eq!(listed[0]["label"], "sam");
    assert_eq!(listed[0]["role"], "operator");
    assert_eq!(listed[0]["grants"], serde_json::json!([]));
    assert!(
        listed[0]["tokenHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(!String::from_utf8_lossy(&list.stdout).contains(token));

    let project = fixture.root.join("plain-project");
    fs::create_dir_all(&project).expect("create project");
    let grant = fixture
        .command()
        .args([
            "hosted",
            "grant",
            &principal_id,
            "--project",
            project.to_str().unwrap(),
            "--session",
            "claude-1",
        ])
        .output()
        .expect("grant hosted session");
    assert!(grant.status.success());
    assert!(
        String::from_utf8_lossy(&grant.stdout)
            .contains(&format!("Granted {principal_id} -> claude-1"))
    );

    let ungrant = fixture
        .command()
        .args([
            "hosted",
            "ungrant",
            &principal_id,
            "--project",
            project.to_str().unwrap(),
            "--session",
            "claude-1",
        ])
        .output()
        .expect("ungrant hosted session");
    assert!(ungrant.status.success());
    assert_eq!(
        String::from_utf8_lossy(&ungrant.stdout).trim(),
        format!("Removed claude-1 from {principal_id}")
    );

    let lockdown = fixture
        .command()
        .args(["hosted", "lockdown", "on"])
        .output()
        .expect("lock hosted mode");
    assert!(lockdown.status.success());
    assert!(fixture.aimux_home.join("hosted/lockdown.json").exists());

    let revoke = fixture
        .command()
        .args(["hosted", "token", "revoke", &principal_id])
        .output()
        .expect("revoke hosted token");
    assert!(revoke.status.success());
    assert_eq!(
        String::from_utf8_lossy(&revoke.stdout).trim(),
        format!("Revoked {principal_id}")
    );

    let tail = fixture
        .command()
        .args(["hosted", "audit", "tail", "--lines", "10", "--json"])
        .output()
        .expect("tail hosted audit");
    assert!(tail.status.success());
    let audit: Value = serde_json::from_slice(&tail.stdout).expect("audit json");
    let events = audit
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["event"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        events,
        [
            "hosted_grant_changed",
            "hosted_grant_changed",
            "hosted_lockdown",
            "hosted_token_revoked"
        ]
    );
    let outbox =
        fs::read_to_string(fixture.aimux_home.join("hosted/outbox.jsonl")).expect("hosted outbox");
    assert!(outbox.contains("hosted_token_revoked"));
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

fn host_native_dirname() -> String {
    format!("{}-{}", host_native_platform(), host_native_arch())
}

fn host_native_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        value => value,
    }
}

fn host_native_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        value => value,
    }
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

struct NativeEntrypointFixture {
    root: PathBuf,
    home: PathBuf,
    aimux_home: PathBuf,
    tmux_socket: PathBuf,
    log: PathBuf,
    node: PathBuf,
    port: u16,
}

impl NativeEntrypointFixture {
    fn new(label: &str) -> Self {
        let root = temp_root(label);
        let home = root.join("home");
        let aimux_home = root.join("aimux-home");
        let tmux_socket = root.join("tmux.sock");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&aimux_home).expect("create aimux home");
        let log = root.join("node.log");
        let node = fake_node(&root, &log, 9);
        Self {
            root,
            home,
            aimux_home,
            tmux_socket,
            log,
            node,
            port: allocate_daemon_port(),
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_aimux"));
        command
            .env("AIMUX_ROOT", &self.root)
            .env("AIMUX_NODE_BIN", &self.node)
            .env("HOME", &self.home)
            .env("AIMUX_HOME", &self.aimux_home)
            .env("AIMUX_TMUX_SOCKET_PATH", &self.tmux_socket)
            .env("AIMUX_DAEMON_PORT", self.port.to_string());
        command
    }
}

impl Drop for NativeEntrypointFixture {
    fn drop(&mut self) {
        let _ = self.command().args(["daemon", "stop"]).output();
        cleanup(self.root.clone());
    }
}

fn allocate_daemon_port() -> u16 {
    for _ in 0..100 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("allocate daemon port");
        let port = listener.local_addr().expect("daemon address").port();
        if port != aimux::daemon_state::DEFAULT_DAEMON_PORT {
            return port;
        }
    }
    panic!("failed to allocate non-default daemon port");
}
