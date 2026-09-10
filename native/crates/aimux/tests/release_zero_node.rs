use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("aimux-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn install_script_installs_native_cli_without_js_runtime() {
    let repo_root = repo_root();
    let temp = TempDir::new("release-zero-node");
    let archive = create_release_archive(&temp.0);
    let tool_path = create_tool_path(&temp.0);
    let install_root = temp.0.join("install-root");
    let bin_dir = temp.0.join("bin");

    let output = Command::new(posix_sh())
        .arg(repo_root.join("scripts/install.sh"))
        .arg(&archive)
        .env("PATH", &tool_path)
        .env("HOME", temp.0.join("home"))
        .env("AIMUX_INSTALL_ROOT", &install_root)
        .env("AIMUX_BIN_DIR", &bin_dir)
        .env("AIMUX_SKIP_POST_INSTALL_RESTART", "1")
        .output()
        .expect("run installer");

    assert!(
        output.status.success(),
        "installer failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let installed_shim = install_root.join("local-native/bin/aimux");
    let installed_text = fs::read_to_string(&installed_shim).expect("read installed shim");
    assert!(!installed_text.contains("AIMUX_NODE_BIN"));
    assert!(!installed_text.contains("installed-aimux-shim.sh"));
    assert!(installed_text.contains("exec \"$AIMUX_NATIVE_BIN\" \"$@\""));
    assert!(!install_root.join("local-native/node_modules").exists());
    assert!(
        !install_root
            .join("local-native/dist/launcher-bin.js")
            .exists()
    );

    let output = Command::new(bin_dir.join("aimux"))
        .arg("--version")
        .env("PATH", &tool_path)
        .env("HOME", temp.0.join("home"))
        .output()
        .expect("run installed shim");
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "native --version\n"
    );
}

#[test]
fn install_script_rejects_archives_without_native_cli() {
    let repo_root = repo_root();
    let temp = TempDir::new("release-no-native");
    let package_root = temp.0.join("pkg/aimux");
    fs::create_dir_all(&package_root).expect("create package root");
    fs::write(package_root.join("VERSION"), "local-native\n").expect("write version");
    fs::write(package_root.join("BUILD_STAMP"), "build-native\n").expect("write build stamp");
    let archive = tar_package(&temp.0);

    let output = Command::new(posix_sh())
        .arg(repo_root.join("scripts/install.sh"))
        .arg(&archive)
        .env("PATH", create_tool_path(&temp.0))
        .env("HOME", temp.0.join("home"))
        .env("AIMUX_INSTALL_ROOT", temp.0.join("install-root"))
        .env("AIMUX_BIN_DIR", temp.0.join("bin"))
        .env("AIMUX_SKIP_POST_INSTALL_RESTART", "1")
        .output()
        .expect("run installer");

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("release archive is missing native aimux binary")
    );
}

#[test]
fn homebrew_formula_does_not_require_node_runtime() {
    let workflow = fs::read_to_string(repo_root().join(".github/workflows/release.yml"))
        .expect("read release workflow");

    assert!(
        !workflow.contains("depends_on \"node\""),
        "Homebrew formula must not install Node for the native Aimux runtime"
    );
}

#[test]
fn release_workflow_runs_inline_steps_with_bash() {
    let workflow = fs::read_to_string(repo_root().join(".github/workflows/release.yml"))
        .expect("read release workflow");

    assert!(
        workflow.contains("defaults:\n  run:\n    shell: bash"),
        "release workflow inline steps use pipefail and must run under bash explicitly"
    );
}

#[test]
fn release_asset_compiles_native_binary_with_selected_build_profile() {
    let repo = repo_root();
    let script =
        fs::read_to_string(repo.join("scripts/build-release-asset.sh")).expect("read script");
    let build_script =
        fs::read_to_string(repo.join("native/crates/aimux/build.rs")).expect("read build script");

    assert!(
        script.contains("export AIMUX_BUILD_PROFILE=\"$BUILD_PROFILE\""),
        "release build must pass the selected BUILD_PROFILE into the native binary compile"
    );
    let export_profile = script
        .find("export AIMUX_BUILD_PROFILE=\"$BUILD_PROFILE\"")
        .expect("profile export");
    let cargo_build = script
        .find("cargo build --manifest-path native/Cargo.toml -p aimux --release")
        .expect("cargo build");
    assert!(
        export_profile < cargo_build,
        "release asset must export the build profile before compiling the native binary"
    );
    assert!(
        build_script.contains("cargo:rerun-if-env-changed=AIMUX_BUILD_PROFILE"),
        "Cargo must rebuild aimux when AIMUX_BUILD_PROFILE changes"
    );
    assert!(
        script.contains("CARGO_TARGET_ROOT=\"${CARGO_TARGET_DIR:-\"$ROOT_DIR/native/target\"}\""),
        "release asset must copy from the selected Cargo target directory"
    );
    assert!(
        script.contains("NATIVE_BUILD_ARTIFACT=\"$CARGO_TARGET_ROOT/release/aimux\""),
        "release asset must name the freshly built native artifact"
    );
    assert!(
        script.contains("cp \"$NATIVE_BUILD_ARTIFACT\" \"$PKG_DIR/native/$PLATFORM-$ARCH/aimux\""),
        "release asset must package the freshly built native artifact"
    );
    assert!(
        script.contains("BUILD_STAMP=\"$(release_build_stamp)\""),
        "release asset must generate one release stamp before compiling the native binary"
    );
    let stamp_generation = script
        .find("BUILD_STAMP=\"$(release_build_stamp)\"")
        .expect("build stamp generation");
    let stamp_export = script
        .find("export AIMUX_RELEASE_BUILD_STAMP=\"$BUILD_STAMP\"")
        .expect("build stamp export");
    assert!(
        stamp_generation < stamp_export && stamp_export < cargo_build,
        "release asset must embed the generated release stamp into the native binary compile"
    );
    assert!(
        !script.contains("AIMUX_RELEASE_BUILD_STAMP:-"),
        "release asset must not accept a caller-supplied stamp as proof"
    );
    assert!(
        script.contains("bash \"$ROOT_DIR/scripts/verify-release-asset.sh\""),
        "release asset must verify the archived runtime against an independent binary witness"
    );
    assert!(
        script.contains("Cross-architecture release assets are not supported by this script"),
        "release asset must reject cross-arch relabeling instead of renaming the host binary"
    );
    assert!(
        build_script.contains("cargo:rerun-if-env-changed=AIMUX_RELEASE_BUILD_STAMP"),
        "Cargo must rebuild aimux when the release stamp changes"
    );
}

#[test]
fn release_asset_verifier_rejects_mismatched_archive_build_stamp() {
    let repo = repo_root();
    let temp = TempDir::new("release-stamp-mismatch");
    create_witness_archive(&temp.0, "stamp-from-archive", "stamp-from-binary");
    let archive = tar_package(&temp.0);

    let output = Command::new("bash")
        .arg(repo.join("scripts/verify-release-asset.sh"))
        .arg(&archive)
        .output()
        .expect("run release verifier");

    assert!(
        !output.status.success(),
        "mismatched archive passed verifier\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(
            "Release build stamp mismatch: archive stamp-from-archive, binary stamp-from-binary"
        ),
        "verifier did not name both stamps\nstderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn release_asset_verifier_accepts_matching_archive_build_stamp() {
    let repo = repo_root();
    let temp = TempDir::new("release-stamp-match");
    create_witness_archive(&temp.0, "matching-stamp", "matching-stamp");
    let archive = tar_package(&temp.0);

    let output = Command::new("bash")
        .arg(repo.join("scripts/verify-release-asset.sh"))
        .arg(&archive)
        .output()
        .expect("run release verifier");

    assert!(
        output.status.success(),
        "matching archive failed verifier\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn release_asset_builder_rejects_cross_arch_labeling_before_build() {
    let repo = repo_root();
    let current = platform_arch();
    let (platform, arch) = current
        .split_once('-')
        .expect("platform arch fixture contains dash");
    let requested_arch = if arch == "arm64" { "x64" } else { "arm64" };

    let output = Command::new("bash")
        .arg(repo.join("scripts/build-release-asset.sh"))
        .env("AIMUX_RELEASE_PLATFORM", platform)
        .env("AIMUX_RELEASE_ARCH", requested_arch)
        .env("AIMUX_BUILD_PROFILE", "local")
        .output()
        .expect("run release builder");

    assert!(
        !output.status.success(),
        "cross-arch relabeling was accepted\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("Cross-architecture release assets are not supported by this script"),
        "cross-arch refusal did not explain the requested and host arches\nstderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn release_source_hash_no_git_fallback_handles_paths_with_spaces() {
    let repo = repo_root();
    let temp = TempDir::new("release-source-hash-spaces");
    fs::write(temp.0.join("package.json"), "{\"version\":\"0.1.0\"}\n").expect("write package");
    fs::write(temp.0.join("yarn.lock"), "# lock\n").expect("write lock");
    for dir in ["scripts", "native", "app", "docs"] {
        fs::create_dir_all(temp.0.join(dir)).expect("create top-level dir");
    }
    let spaced_dir = temp
        .0
        .join("app/ios/Pods/Target Support Files/Aimux Fixture");
    fs::create_dir_all(&spaced_dir).expect("create spaced dir");
    fs::write(
        spaced_dir.join("fixture config [one] $value.txt"),
        "fixture\n",
    )
    .expect("write spaced file");

    let script =
        fs::read_to_string(repo.join("scripts/build-release-asset.sh")).expect("read script");
    let function_start = script
        .find("release_source_hash() {")
        .expect("release_source_hash function");
    let function_end = script
        .find("\nrelease_build_stamp() {")
        .expect("release_build_stamp function");
    let runner = temp.0.join("run-release-source-hash.sh");
    fs::write(
        &runner,
        format!(
            "#!/usr/bin/env bash\nset -euo pipefail\nROOT_DIR={}\ncd \"$ROOT_DIR\"\n{}\nrelease_source_hash\n",
            shell_quote(&temp.0),
            &script[function_start..function_end]
        ),
    )
    .expect("write runner");
    let mut permissions = fs::metadata(&runner)
        .expect("runner metadata")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&runner, permissions).expect("chmod runner");

    let output = Command::new("bash")
        .arg(&runner)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .output()
        .expect("run source hash fallback");

    assert!(
        output.status.success(),
        "no-git source hash failed for a path with spaces\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim().len(),
        12,
        "source hash should remain the 12-character stamp suffix witness"
    );
}

#[test]
fn release_bash_scripts_report_clear_error_when_invoked_with_sh() {
    let repo = repo_root();

    for script in [
        "scripts/build-local-ui.sh",
        "scripts/build-release-asset.sh",
        "scripts/cargo-sweep-stale-targets.sh",
        "scripts/check-staged-rustfmt.sh",
        "scripts/verify-codex-developer-instructions.sh",
        "scripts/verify-release-asset.sh",
    ] {
        let output = Command::new(posix_sh())
            .arg(repo.join(script))
            .output()
            .expect("run release script with sh");

        assert!(
            !output.status.success(),
            "{script} unexpectedly succeeded under sh"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("must be run with bash"),
            "{script} did not report the required interpreter\nstderr:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("Illegal option"),
            "{script} still leaked the shell's pipefail error\nstderr:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn create_release_archive(root: &Path) -> PathBuf {
    let package_root = root.join("pkg/aimux");
    fs::create_dir_all(package_root.join(format!("native/{}/", platform_arch())))
        .expect("create native dir");
    fs::create_dir_all(package_root.join("scripts")).expect("create scripts dir");
    fs::write(package_root.join("VERSION"), "local-native\n").expect("write version");
    fs::write(package_root.join("BUILD_STAMP"), "build-native\n").expect("write build stamp");
    fs::write(
        package_root.join("scripts/tmux-control.sh"),
        "#!/bin/sh\nexit 0\n",
    )
    .expect("write script");
    let native_bin = package_root.join(format!("native/{}/aimux", platform_arch()));
    fs::write(&native_bin, "#!/bin/sh\nprintf 'native %s\\n' \"$*\"\n").expect("write native bin");
    let mut permissions = fs::metadata(&native_bin)
        .expect("native metadata")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&native_bin, permissions).expect("chmod native bin");
    tar_package(root)
}

fn create_witness_archive(root: &Path, archive_stamp: &str, binary_stamp: &str) {
    let package_root = root.join("pkg/aimux");
    fs::create_dir_all(package_root.join(format!("native/{}/", platform_arch())))
        .expect("create native dir");
    fs::write(package_root.join("VERSION"), "local-witness\n").expect("write version");
    fs::write(
        package_root.join("BUILD_STAMP"),
        format!("{archive_stamp}\n"),
    )
    .expect("write build stamp");
    let native_bin = package_root.join(format!("native/{}/aimux", platform_arch()));
    fs::write(
        &native_bin,
        format!("#!/bin/sh\nAIMUX_EMBEDDED_BUILD_STAMP={binary_stamp}\nexit 0\n"),
    )
    .expect("write native witness");
    let mut permissions = fs::metadata(&native_bin)
        .expect("native metadata")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&native_bin, permissions).expect("chmod native witness");
}

fn tar_package(root: &Path) -> PathBuf {
    let archive = root.join("aimux-native.tar.gz");
    let output = Command::new("tar")
        .args(["-czf"])
        .arg(&archive)
        .args(["-C"])
        .arg(root.join("pkg"))
        .arg("aimux")
        .output()
        .expect("run tar");
    assert!(
        output.status.success(),
        "tar failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    archive
}

fn create_tool_path(root: &Path) -> PathBuf {
    let tool_dir = root.join("tools");
    fs::create_dir_all(&tool_dir).expect("create tool dir");
    for tool in [
        "cat", "chmod", "cp", "ln", "mkdir", "mktemp", "mv", "rm", "sed", "sh", "tar", "uname",
    ] {
        std::os::unix::fs::symlink(system_tool(tool), tool_dir.join(tool)).expect("link tool");
    }
    tool_dir
}

fn system_tool(name: &str) -> PathBuf {
    ["/bin", "/usr/bin"]
        .into_iter()
        .map(|prefix| Path::new(prefix).join(name))
        .find(|path| path.exists())
        .unwrap_or_else(|| panic!("missing system tool: {name}"))
}

fn platform_arch() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "x86_64") => "linux-x64",
        other => panic!("unsupported test platform: {other:?}"),
    }
}

fn posix_sh() -> &'static str {
    if Path::new("/bin/dash").exists() {
        "/bin/dash"
    } else {
        "/bin/sh"
    }
}
