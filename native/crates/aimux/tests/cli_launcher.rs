use aimux::cli_launcher::{
    AimuxCliLaunchOptions, AimuxCliLaunchSource, get_aimux_current_cli_identity,
    get_aimux_daemon_launch_command, get_aimux_dashboard_launch_command,
    get_aimux_project_service_launch_command, get_aimux_stable_shim_path_from,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        path.push(format!(
            "aimux-cli-launcher-test-{}-{sequence}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create test dir");
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn options(
    test_dir: &TestDir,
    env: BTreeMap<String, String>,
    current_argv_entry: Option<String>,
) -> AimuxCliLaunchOptions {
    AimuxCliLaunchOptions {
        env,
        current_argv_entry,
        current_entry_path: Some(
            test_dir
                .0
                .join("current/aimux")
                .to_string_lossy()
                .into_owned(),
        ),
        home_dir: Some(test_dir.0.join("home")),
    }
}

#[test]
fn stable_shim_path_uses_trimmed_env_or_home_default() {
    let test_dir = TestDir::new();
    assert_eq!(
        get_aimux_stable_shim_path_from(&BTreeMap::new(), test_dir.0.join("home")),
        test_dir
            .0
            .join("home/.local/bin/aimux")
            .to_string_lossy()
            .into_owned()
    );
    assert_eq!(
        get_aimux_stable_shim_path_from(
            &BTreeMap::from([("AIMUX_CLI_BIN".into(), "  /tmp/custom-aimux  ".into())]),
            test_dir.0.join("home")
        ),
        "/tmp/custom-aimux"
    );
}

#[test]
fn launch_command_uses_current_entry_when_stable_shim_is_absent() {
    let test_dir = TestDir::new();
    let command = get_aimux_daemon_launch_command(options(
        &test_dir,
        BTreeMap::new(),
        Some(test_dir.0.join("dev/aimux").to_string_lossy().into_owned()),
    ));

    assert_eq!(command.source, AimuxCliLaunchSource::CurrentEntry);
    assert_eq!(command.command, command.current_entry_path);
    assert_eq!(command.args, vec!["daemon", "run"]);
}

#[test]
fn launch_command_uses_stable_shim_for_current_stable_entry() {
    let test_dir = TestDir::new();
    let stable = test_dir.0.join("home/.local/bin/aimux");
    fs::create_dir_all(stable.parent().expect("stable parent")).expect("create stable parent");
    fs::write(&stable, "#!/bin/sh\n").expect("write stable shim");
    let command = get_aimux_daemon_launch_command(options(
        &test_dir,
        BTreeMap::new(),
        Some(stable.to_string_lossy().into_owned()),
    ));

    assert_eq!(command.source, AimuxCliLaunchSource::StableShim);
    assert_eq!(command.command, stable.to_string_lossy());
    assert_eq!(command.args, vec!["daemon", "run"]);
}

#[test]
fn launch_command_uses_stable_shim_for_native_install_root_entry() {
    let test_dir = TestDir::new();
    let stable = test_dir.0.join("bin/aimux");
    let native_entry = test_dir.0.join("native/bin/aimux");
    fs::create_dir_all(stable.parent().expect("stable parent")).expect("create stable parent");
    fs::create_dir_all(native_entry.parent().expect("native parent"))
        .expect("create native parent");
    fs::write(&stable, "#!/bin/sh\n").expect("write stable shim");
    fs::write(&native_entry, "#!/bin/sh\n").expect("write native entry");

    let command = get_aimux_dashboard_launch_command(options(
        &test_dir,
        BTreeMap::from([
            (
                "AIMUX_CLI_BIN".into(),
                stable.to_string_lossy().into_owned(),
            ),
            (
                "AIMUX_INSTALL_ROOT".into(),
                test_dir.0.join("native").to_string_lossy().into_owned(),
            ),
        ]),
        Some(native_entry.to_string_lossy().into_owned()),
    ));

    assert_eq!(command.source, AimuxCliLaunchSource::StableShim);
    assert_eq!(command.command, stable.to_string_lossy());
    assert_eq!(command.args, vec!["__dashboard-internal-native"]);
}

#[test]
fn dashboard_launch_uses_native_internal_command_by_default() {
    let test_dir = TestDir::new();
    let default_command = get_aimux_dashboard_launch_command(options(
        &test_dir,
        BTreeMap::new(),
        Some(test_dir.0.join("dev/aimux").to_string_lossy().into_owned()),
    ));
    assert_eq!(default_command.args, vec!["__dashboard-internal-native"]);

    let node_command = get_aimux_dashboard_launch_command(options(
        &test_dir,
        BTreeMap::from([("AIMUX_DASHBOARD_IMPLEMENTATION".into(), "node".into())]),
        Some(test_dir.0.join("dev/aimux").to_string_lossy().into_owned()),
    ));
    assert_eq!(node_command.args, vec!["--tmux-dashboard-internal"]);

    let native_command = get_aimux_dashboard_launch_command(options(
        &test_dir,
        BTreeMap::from([("AIMUX_DASHBOARD_IMPLEMENTATION".into(), " native ".into())]),
        Some(test_dir.0.join("dev/aimux").to_string_lossy().into_owned()),
    ));
    assert_eq!(native_command.args, vec!["__dashboard-internal-native"]);
}

#[test]
fn project_service_and_identity_args_match_typescript_helpers() {
    let test_dir = TestDir::new();
    let project = get_aimux_project_service_launch_command(
        "project-1",
        "/repo",
        options(&test_dir, BTreeMap::new(), None),
    );
    assert_eq!(
        project.args,
        vec![
            "__project-service-internal",
            "--project-id",
            "project-1",
            "--project-root",
            "/repo"
        ]
    );

    let identity = get_aimux_current_cli_identity(options(&test_dir, BTreeMap::new(), None));
    assert_eq!(identity.args, Vec::<String>::new());
    assert_eq!(identity.source, AimuxCliLaunchSource::CurrentEntry);
}

#[test]
fn project_service_launch_uses_native_current_entry_even_from_native_install_root() {
    let test_dir = TestDir::new();
    let stable = test_dir.0.join("bin/aimux");
    let native_entry = test_dir.0.join("native/bin/aimux");
    fs::create_dir_all(stable.parent().expect("stable parent")).expect("create stable parent");
    fs::create_dir_all(native_entry.parent().expect("native parent"))
        .expect("create native parent");
    fs::write(&stable, "#!/bin/sh\n").expect("write stable shim");
    fs::write(&native_entry, "#!/bin/sh\n").expect("write native entry");

    let command = get_aimux_project_service_launch_command(
        "project-1",
        "/repo",
        options(
            &test_dir,
            BTreeMap::from([
                (
                    "AIMUX_CLI_BIN".into(),
                    stable.to_string_lossy().into_owned(),
                ),
                (
                    "AIMUX_INSTALL_ROOT".into(),
                    test_dir.0.join("native").to_string_lossy().into_owned(),
                ),
            ]),
            Some(native_entry.to_string_lossy().into_owned()),
        ),
    );

    assert_eq!(command.source, AimuxCliLaunchSource::CurrentEntry);
    assert_eq!(command.command, command.current_entry_path);
    assert_eq!(
        command.args,
        vec![
            "__project-service-internal",
            "--project-id",
            "project-1",
            "--project-root",
            "/repo"
        ]
    );
}
