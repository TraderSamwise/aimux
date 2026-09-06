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
    assert!(stdout.contains("aimux"));
    assert!(stdout.contains("agent multiplexer"));
    assert!(stdout.contains("Main Checkout"));
    assert!(stdout.contains("feature-a"));
    assert!(stdout.contains("native"));
    cleanup(root);
}

#[cfg(unix)]
#[test]
fn unknown_main_commands_delegate_to_node_launcher_with_original_args() {
    let root = temp_root("native-node-fallback");
    fs::create_dir_all(root.join("dist")).expect("create dist");
    fs::write(root.join("dist/launcher-bin.js"), "").expect("write launcher");
    let log = root.join("node.log");
    let node = fake_node(&root, &log, 7);

    let status = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .env("AIMUX_ROOT", &root)
        .env("AIMUX_NODE_BIN", node)
        .args(["unknown-command", "--json"])
        .status()
        .expect("run native aimux");

    assert_eq!(status.code(), Some(7));
    let recorded = fs::read_to_string(&log).expect("node fallback log");
    assert_eq!(
        recorded,
        format!(
            "{}\nunknown-command\n--json\n",
            root.join("dist/launcher-bin.js").display()
        )
    );
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
