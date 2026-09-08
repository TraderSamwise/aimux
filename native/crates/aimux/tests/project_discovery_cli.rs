use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn project_scoped_cli_refuses_non_git_cwd_before_daemon_activation() {
    let fixture = CliFixture::new("non-git", 46520);
    let plain = fixture.root.join("plain");
    fs::create_dir_all(&plain).expect("create plain dir");

    let output = fixture
        .command()
        .current_dir(&plain)
        .args(["ps", "--json"])
        .output()
        .expect("run aimux ps");

    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stdout).is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(&format!(
            "{} is not a git repository. Run `git init` first, or cd into a repo.",
            plain.display()
        )),
        "{stderr}"
    );
    assert!(
        !fixture.node_log.exists(),
        "non-git refusal should not invoke node fallback"
    );
    assert!(
        !fixture.aimux_home.join("daemon/daemon.json").exists(),
        "non-git refusal should not start the daemon"
    );
}

#[test]
fn projects_list_round_trips_multiple_git_projects_through_isolated_daemon() {
    let fixture = CliFixture::new("multi-project", 46540);
    let alpha = git_repo(fixture.root.join("alpha"));
    let beta = git_repo(fixture.root.join("beta"));

    let alpha_ensure = fixture
        .command()
        .current_dir(&alpha)
        .args([
            "daemon",
            "project-ensure",
            "--project",
            path_str(&alpha),
            "--json",
        ])
        .output()
        .expect("ensure alpha project");
    assert!(
        alpha_ensure.status.success(),
        "{}",
        String::from_utf8_lossy(&alpha_ensure.stderr)
    );
    let alpha_body: Value = serde_json::from_slice(&alpha_ensure.stdout).expect("alpha json");
    assert_eq!(alpha_body["project"]["projectRoot"], path_str(&alpha));

    let beta_ensure = fixture
        .command()
        .current_dir(&beta)
        .args([
            "daemon",
            "project-ensure",
            "--project",
            path_str(&beta),
            "--json",
        ])
        .output()
        .expect("ensure beta project");
    assert!(
        beta_ensure.status.success(),
        "{}",
        String::from_utf8_lossy(&beta_ensure.stderr)
    );

    let list = fixture
        .command()
        .current_dir(&alpha)
        .args(["projects", "list", "--json"])
        .output()
        .expect("list projects");
    assert!(
        list.status.success(),
        "{}",
        String::from_utf8_lossy(&list.stderr)
    );
    let body: Value = serde_json::from_slice(&list.stdout).expect("projects json");
    let projects = body["projects"].as_array().expect("projects array");
    let paths = projects
        .iter()
        .map(|project| project["path"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    assert!(paths.contains(&path_str(&alpha)));
    assert!(paths.contains(&path_str(&beta)));
    assert!(
        projects
            .iter()
            .all(|project| project["serviceAlive"].as_bool().is_some()),
        "serviceAlive must be present for every listed project"
    );
    assert!(
        !fixture.node_log.exists(),
        "project discovery should not invoke node fallback"
    );
}

fn git_repo(path: PathBuf) -> PathBuf {
    fs::create_dir_all(path.join(".git")).expect("create git marker");
    path
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("utf8 path")
}

fn fake_node(root: &Path, log: &Path, code: i32) -> PathBuf {
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
    make_executable(&path);
    path
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path).expect("script metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("chmod script");
    }
}

fn shell_single_quote(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "'\\''")
}

struct CliFixture {
    root: PathBuf,
    home: PathBuf,
    aimux_home: PathBuf,
    node_log: PathBuf,
    node: PathBuf,
    port: u16,
}

impl CliFixture {
    fn new(label: &str, base_port: u16) -> Self {
        let root = temp_root(label);
        let home = root.join("home");
        let aimux_home = root.join("aimux-home");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&aimux_home).expect("create aimux home");
        let node_log = root.join("node.log");
        let node = fake_node(&root, &node_log, 9);
        let offset = u16::try_from(TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed) % 400)
            .expect("port offset");
        Self {
            root,
            home,
            aimux_home,
            node_log,
            node,
            port: base_port + offset,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_aimux"));
        command
            .env("AIMUX_ROOT", &self.root)
            .env("AIMUX_NODE_BIN", &self.node)
            .env("HOME", &self.home)
            .env("AIMUX_HOME", &self.aimux_home)
            .env("AIMUX_DAEMON_PORT", self.port.to_string());
        command
    }
}

impl Drop for CliFixture {
    fn drop(&mut self) {
        let _ = self.command().args(["daemon", "stop"]).output();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn temp_root(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-project-discovery-cli-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create temp root");
    path
}
