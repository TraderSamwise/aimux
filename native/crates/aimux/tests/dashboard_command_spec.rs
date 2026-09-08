use aimux::dashboard_command_spec::{
    DashboardCommandSpecOptions, get_dashboard_command_spec,
    get_dashboard_command_spec_with_options,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "aimux-dashboard-command-spec-{}-{sequence}-{unique}",
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

fn source_options(
    test_dir: &TestDir,
    env: BTreeMap<String, String>,
) -> DashboardCommandSpecOptions {
    let script_path = test_dir.0.join("src/launcher-bin");
    let implementation_path = test_dir.0.join("src/main");
    fs::create_dir_all(script_path.parent().expect("source parent")).expect("create source");
    fs::write(&script_path, "launcher-one").expect("write launcher");
    fs::write(&implementation_path, "main-one").expect("write implementation");
    DashboardCommandSpecOptions {
        env,
        script_path,
        implementation_path,
        process_exec_path: test_dir.0.join("node").to_string_lossy().into_owned(),
        home_dir: test_dir.0.join("home"),
        platform: "test-platform".into(),
        arch: "test-arch".into(),
    }
}

fn command_text(spec: &aimux::dashboard_command_spec::DashboardCommandSpec) -> &str {
    spec.dashboard_command.args.get(1).expect("wrapped command")
}

#[test]
fn production_dashboard_command_defaults_to_native_runtime() {
    let spec = get_dashboard_command_spec("/tmp/repo").expect("build default production spec");
    let command = command_text(&spec);

    assert!(command.contains("__dashboard-internal-native"));
    assert!(!command.contains("--tmux-dashboard-internal"));
}

#[test]
fn command_uses_dashboard_entrypoint_and_shell_wrapper() {
    let test_dir = TestDir::new();
    let options = source_options(&test_dir, BTreeMap::new());
    let script_path = options.script_path.to_string_lossy().into_owned();
    let spec = get_dashboard_command_spec_with_options("/tmp/repo", options).expect("build spec");
    let command = command_text(&spec);

    assert_eq!(spec.script_path, script_path);
    assert_eq!(spec.dashboard_command.command, "bash");
    assert_eq!(spec.dashboard_command.cwd, "/tmp/repo");
    assert_eq!(spec.dashboard_command.args[0], "-lc");
    assert!(command.contains("--tmux-dashboard-internal"));
    assert!(!command.contains("__dashboard-internal-native"));
    assert!(command.contains(&spec.script_path));
    assert!(command.contains("Starting Aimux dashboard..."));
    assert!(command.contains("trap 'rm -f \"$output_file\"' EXIT"));
    assert!(command.contains("trap 'rm -f \"$output_file\"; exit 130' INT TERM HUP"));
    assert!(!command.contains("/tmp/aimux-debug.log"));
    assert!(!command.contains("tee -a"));
    assert!(command.contains("printf '%s\\n'"));

    let parsed = Command::new("bash")
        .args(["-n", "-c", command])
        .status()
        .expect("parse shell command");
    assert!(parsed.success());
}

#[test]
fn dashboard_selector_uses_native_only_when_requested() {
    let test_dir = TestDir::new();
    let base_options = source_options(&test_dir, BTreeMap::new());
    let default = get_dashboard_command_spec_with_options("/tmp/repo", base_options.clone())
        .expect("native spec");
    let mut node_options = base_options;
    node_options
        .env
        .insert("AIMUX_DASHBOARD_IMPLEMENTATION".into(), "node".into());
    let node =
        get_dashboard_command_spec_with_options("/tmp/repo", node_options).expect("node spec");
    let mut native_options = source_options(
        &test_dir,
        BTreeMap::from([("AIMUX_DASHBOARD_IMPLEMENTATION".into(), "native".into())]),
    );
    native_options.process_exec_path = test_dir.0.join("node").to_string_lossy().into_owned();
    let native =
        get_dashboard_command_spec_with_options("/tmp/repo", native_options).expect("native spec");
    let node_command = command_text(&node);
    let default_command = command_text(&default);

    assert!(default_command.contains("--tmux-dashboard-internal"));
    assert!(!default_command.contains("__dashboard-internal-native"));
    assert!(node_command.contains("--tmux-dashboard-internal"));
    assert!(!node_command.contains("__dashboard-internal-native"));
    assert!(!node_command.contains("AIMUX_DASHBOARD_IMPLEMENTATION='node'"));
    assert!(command_text(&native).contains("__dashboard-internal-native"));
    assert!(!command_text(&native).contains("--tmux-dashboard-internal"));
    assert_ne!(node.dashboard_build_stamp, native.dashboard_build_stamp);
}

#[test]
fn launch_environment_is_allowlisted_quoted_and_unsets_stable_paths_for_source() {
    let test_dir = TestDir::new();
    let options = source_options(
        &test_dir,
        BTreeMap::from([
            ("AIMUX_ROOT".into(), "/old/aimux/install".into()),
            ("AIMUX_HOME".into(), "/tmp/custom'home; echo unsafe".into()),
            ("AIMUX_DAEMON_PORT".into(), "43219".into()),
            ("AIMUX_CLI_BIN".into(), "/not/the/current/shim".into()),
            (
                "AIMUX_INSTALL_ROOT".into(),
                "/not/the/current/install".into(),
            ),
            ("SECRET_TOKEN".into(), "not-for-tmux".into()),
        ]),
    );
    let spec = get_dashboard_command_spec_with_options("/tmp/repo", options).expect("build spec");
    let command = command_text(&spec);

    assert!(command.contains("AIMUX_HOME='/tmp/custom'\"'\"'home; echo unsafe'"));
    assert!(command.contains("AIMUX_DAEMON_PORT='43219'"));
    assert!(command.contains("-u 'AIMUX_ROOT'"));
    assert!(command.contains("-u 'AIMUX_CLI_BIN'"));
    assert!(command.contains("-u 'AIMUX_INSTALL_ROOT'"));
    assert!(!command.contains("/old/aimux/install"));
    assert!(!command.contains("/not/the/current/shim"));
    assert!(!command.contains("/not/the/current/install"));
    assert!(!command.contains("SECRET_TOKEN"));
    assert!(!command.contains("not-for-tmux"));
}

#[test]
fn native_dashboard_command_unsets_stale_aimux_root_from_tmux_environment() {
    let test_dir = TestDir::new();
    let native_root = test_dir.0.join("install-current");
    let stale_root = test_dir.0.join("install-stale");
    let native_binary = native_root
        .join("native")
        .join(host_native_dirname())
        .join("aimux");
    fs::create_dir_all(native_binary.parent().expect("native parent")).expect("create native");
    fs::write(&native_binary, "native-current").expect("write native binary");
    fs::write(native_root.join("VERSION"), "local-current\n").expect("write current version");
    fs::create_dir_all(&stale_root).expect("create stale root");
    fs::write(stale_root.join("VERSION"), "local-stale\n").expect("write stale version");

    let options = DashboardCommandSpecOptions {
        env: BTreeMap::from([
            ("AIMUX_DASHBOARD_IMPLEMENTATION".into(), "native".into()),
            (
                "AIMUX_INSTALL_ROOT".into(),
                native_root.to_string_lossy().into_owned(),
            ),
            (
                "AIMUX_ROOT".into(),
                stale_root.to_string_lossy().into_owned(),
            ),
        ]),
        script_path: native_binary.clone(),
        implementation_path: native_binary.clone(),
        process_exec_path: native_binary.to_string_lossy().into_owned(),
        home_dir: test_dir.0.join("home"),
        platform: host_native_platform().into(),
        arch: host_native_arch().into(),
    };

    let spec = get_dashboard_command_spec_with_options("/tmp/repo", options).expect("build spec");
    let command = command_text(&spec);

    assert!(command.contains("__dashboard-internal-native"));
    assert!(command.contains("-u 'AIMUX_ROOT'"));
    assert!(!command.contains(&stale_root.to_string_lossy().into_owned()));
    assert!(command.contains(&native_binary.to_string_lossy().into_owned()));
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

#[test]
fn stamp_changes_for_source_artifacts_and_non_default_environment() {
    let test_dir = TestDir::new();
    let options = source_options(&test_dir, BTreeMap::new());
    let first = get_dashboard_command_spec_with_options("/tmp/repo", options.clone())
        .expect("first spec")
        .dashboard_build_stamp;

    fs::write(&options.implementation_path, "main-two").expect("change implementation");
    let implementation_changed =
        get_dashboard_command_spec_with_options("/tmp/repo", options.clone())
            .expect("implementation spec")
            .dashboard_build_stamp;
    assert_ne!(implementation_changed, first);

    fs::write(&options.script_path, "launcher-two").expect("change launcher");
    let launcher_changed = get_dashboard_command_spec_with_options("/tmp/repo", options.clone())
        .expect("launcher spec")
        .dashboard_build_stamp;
    assert_ne!(launcher_changed, implementation_changed);

    let mut env_options = options;
    env_options
        .env
        .insert("AIMUX_DAEMON_PORT".into(), "43191".into());
    let env_changed = get_dashboard_command_spec_with_options("/tmp/repo", env_options)
        .expect("environment spec")
        .dashboard_build_stamp;
    assert_ne!(env_changed, launcher_changed);
}

#[test]
fn explicit_launch_defaults_do_not_change_the_stamp() {
    let test_dir = TestDir::new();
    let implicit = source_options(&test_dir, BTreeMap::new());
    let implicit_stamp = get_dashboard_command_spec_with_options("/tmp/repo", implicit.clone())
        .expect("implicit spec")
        .dashboard_build_stamp;
    let mut explicit = implicit;
    explicit.env = BTreeMap::from([
        (
            "AIMUX_HOME".into(),
            explicit
                .home_dir
                .join(".aimux")
                .to_string_lossy()
                .into_owned(),
        ),
        ("AIMUX_DAEMON_PORT".into(), "43190".into()),
        ("AIMUX_ENV".into(), "production".into()),
        ("AIMUX_WEB_APP_URL".into(), "https://aimux.app".into()),
    ]);
    let spec =
        get_dashboard_command_spec_with_options("/tmp/repo", explicit).expect("explicit spec");

    assert_eq!(spec.dashboard_build_stamp, implicit_stamp);
    assert!(command_text(&spec).contains("AIMUX_ENV='production'"));
    assert!(command_text(&spec).contains("AIMUX_WEB_APP_URL='https://aimux.app'"));
}

#[cfg(unix)]
#[test]
fn stable_shim_uses_install_artifacts_and_keeps_stable_environment() {
    use std::os::unix::fs::symlink;

    let test_dir = TestDir::new();
    let install_root = create_install(&test_dir.0, "one", "native-one");
    let shim = test_dir.0.join("stable/bin/aimux");
    fs::create_dir_all(shim.parent().expect("shim parent")).expect("create shim parent");
    symlink(install_root.join("bin/aimux"), &shim).expect("link stable shim");
    let options = source_options(
        &test_dir,
        BTreeMap::from([
            ("AIMUX_CLI_BIN".into(), shim.to_string_lossy().into_owned()),
            (
                "AIMUX_INSTALL_ROOT".into(),
                test_dir.0.join("src").to_string_lossy().into_owned(),
            ),
        ]),
    );
    let first = get_dashboard_command_spec_with_options("/tmp/repo", options.clone())
        .expect("first stable spec");
    assert!(command_text(&first).contains(&format!("AIMUX_CLI_BIN='{}'", shim.to_string_lossy())));
    assert!(!command_text(&first).contains("-u 'AIMUX_CLI_BIN'"));
    assert!(command_text(&first).contains("--tmux-dashboard-internal"));
    assert!(!command_text(&first).contains("__dashboard-internal-native"));

    fs::write(install_root.join("dist/launcher-bin.js"), "launcher-two")
        .expect("change installed launcher");
    let installed_launcher_changed =
        get_dashboard_command_spec_with_options("/tmp/repo", options.clone())
            .expect("changed launcher spec")
            .dashboard_build_stamp;
    assert_ne!(installed_launcher_changed, first.dashboard_build_stamp);

    fs::write(install_root.join("dist/main.js"), "main-two").expect("change installed main");
    let installed_js_changed =
        get_dashboard_command_spec_with_options("/tmp/repo", options.clone())
            .expect("changed JS spec")
            .dashboard_build_stamp;
    assert_ne!(installed_js_changed, installed_launcher_changed);

    fs::write(
        install_root.join("native/test-platform-test-arch/aimux"),
        "native-two",
    )
    .expect("change native binary");
    let native_changed = get_dashboard_command_spec_with_options("/tmp/repo", options.clone())
        .expect("changed native spec")
        .dashboard_build_stamp;
    assert_ne!(native_changed, installed_js_changed);

    fs::write(&options.implementation_path, "source-main-two").expect("change source main");
    let source_changed = get_dashboard_command_spec_with_options("/tmp/repo", options)
        .expect("source-changed stable spec")
        .dashboard_build_stamp;
    assert_eq!(source_changed, native_changed);
}

#[cfg(unix)]
#[test]
fn stable_native_dashboard_stamp_does_not_require_installed_js_artifacts() {
    use std::os::unix::fs::symlink;

    let test_dir = TestDir::new();
    let install_root = create_install(&test_dir.0, "native-only", "native-one");
    fs::remove_file(install_root.join("dist/launcher-bin.js")).expect("remove launcher");
    fs::remove_file(install_root.join("dist/main.js")).expect("remove main");
    let shim = test_dir.0.join("stable/bin/aimux");
    fs::create_dir_all(shim.parent().expect("shim parent")).expect("create shim parent");
    symlink(install_root.join("bin/aimux"), &shim).expect("link stable shim");
    let options = source_options(
        &test_dir,
        BTreeMap::from([
            ("AIMUX_CLI_BIN".into(), shim.to_string_lossy().into_owned()),
            (
                "AIMUX_INSTALL_ROOT".into(),
                test_dir.0.join("src").to_string_lossy().into_owned(),
            ),
        ]),
    );

    let first = get_dashboard_command_spec_with_options("/tmp/repo", options.clone())
        .expect("native-only stable spec");
    assert!(command_text(&first).contains("--tmux-dashboard-internal"));
    assert!(!command_text(&first).contains("__dashboard-internal-native"));

    fs::write(
        install_root.join("native/test-platform-test-arch/aimux"),
        "native-two",
    )
    .expect("change native binary");
    let native_changed = get_dashboard_command_spec_with_options("/tmp/repo", options.clone())
        .expect("changed native spec")
        .dashboard_build_stamp;
    assert_eq!(native_changed, first.dashboard_build_stamp);

    fs::write(&options.implementation_path, "source-main-two").expect("change source main");
    let source_changed = get_dashboard_command_spec_with_options("/tmp/repo", options)
        .expect("source-changed native stable spec")
        .dashboard_build_stamp;
    assert_ne!(source_changed, native_changed);
}

fn create_install(root: &Path, label: &str, native_contents: &str) -> PathBuf {
    let install_root = root.join("installs").join(label);
    fs::create_dir_all(install_root.join("bin")).expect("create install bin");
    fs::create_dir_all(install_root.join("dist")).expect("create install dist");
    fs::create_dir_all(install_root.join("native/test-platform-test-arch"))
        .expect("create install native");
    fs::write(install_root.join("bin/aimux"), "#!/bin/sh\n").expect("write install shim");
    fs::write(install_root.join("dist/launcher-bin.js"), "launcher-one")
        .expect("write installed launcher");
    fs::write(install_root.join("dist/main.js"), "main-one").expect("write installed main");
    fs::write(
        install_root.join("native/test-platform-test-arch/aimux"),
        native_contents,
    )
    .expect("write native binary");
    install_root
}
