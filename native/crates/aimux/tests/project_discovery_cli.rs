use serde_json::Value;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn project_scoped_cli_refuses_non_git_cwd_before_daemon_io() {
    let fixture = CliFixture::new("non-git");
    let plain = fixture.root.join("plain");
    fs::create_dir_all(&plain).expect("create plain dir");

    let init = fixture
        .command()
        .current_dir(&plain)
        .args(["init"])
        .output()
        .expect("run aimux init");
    assert!(
        init.status.success(),
        "{}",
        String::from_utf8_lossy(&init.stderr)
    );
    assert!(
        plain.join(".aimux/config.json").exists(),
        "non-git project init should initialize the project directory"
    );

    let output = fixture
        .command()
        .current_dir(&plain)
        .args(["ps", "--json"])
        .output()
        .expect("run aimux ps");

    assert!(
        !output.status.success(),
        "non-git ps should fail before daemon IO\nstdout:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("is not a git repository. Run `git init` first, or cd into a repo."),
        "{stderr}"
    );
    assert!(
        !fixture.node_log.exists(),
        "non-git project activation should not invoke node fallback"
    );
    assert!(
        !fixture.aimux_home.join("daemon/daemon.json").exists(),
        "non-git project activation should fail before starting the isolated daemon"
    );
}

#[test]
fn project_scoped_cli_activates_git_cwd_through_isolated_daemon() {
    let fixture = CliFixture::new("git-cwd");
    let repo = git_repo(fixture.root.join("repo"));

    let output = fixture
        .command()
        .current_dir(&repo)
        .args(["ps", "--json"])
        .output()
        .expect("run aimux ps");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let body: Value = serde_json::from_slice(&output.stdout).expect("agent list json");
    assert_eq!(body.as_array().expect("agent list").len(), 0);
    assert!(
        !fixture.node_log.exists(),
        "git project activation should not invoke node fallback"
    );
    assert!(
        fixture.aimux_home.join("daemon/daemon.json").exists(),
        "git project activation should start the isolated daemon"
    );
}

#[test]
fn projects_list_round_trips_multiple_git_projects_through_isolated_daemon() {
    let fixture = CliFixture::new("multi-project");
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
    tmux_socket: PathBuf,
    node_log: PathBuf,
    node: PathBuf,
    port: u16,
}

impl CliFixture {
    fn new(label: &str) -> Self {
        let root = temp_root(label);
        let home = root.join("home");
        let aimux_home = root.join("aimux-home");
        let tmux_socket = root.join("tmux.sock");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&aimux_home).expect("create aimux home");
        write_test_isolation_marker(&aimux_home);
        let node_log = root.join("node.log");
        let node = fake_node(&root, &node_log, 9);
        Self {
            root,
            home,
            aimux_home,
            tmux_socket,
            node_log,
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
            .env("AIMUX_TEST_HARNESS", "cargo-test")
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

fn write_test_isolation_marker(aimux_home: &Path) {
    fs::write(
        aimux_home.join(aimux::runtime_safety_guard::TEST_ISOLATION_MARKER),
        format!(
            r#"{{"kind":"cargo-test","ownerPid":{}}}"#,
            std::process::id()
        ),
    )
    .expect("write isolated aimux home marker");
}

/// Ports this binary has already handed to a fixture.
///
/// `bind(0)` answers with a port that is free *right now*, and this function
/// drops the listener so the daemon can take it -- which leaves a window where
/// a second fixture asks, the first fixture's daemon has not bound yet, and
/// the kernel offers the same number twice.
///
/// That is not theoretical. On 2026-11-16 CI, `multi-project` failed with
/// "project service process exited before /health became ready" for a repo
/// under `.../multi-project-29580-2/alpha`, naming logs under
/// `.../git-cwd-29580-0/aimux-home/...` -- its CLI had reached the `git-cwd`
/// fixture's daemon, which started a project service under ITS home, and that
/// service died when `git-cwd`'s `Drop` ran `daemon stop` and deleted the
/// tree. Same pid, two fixtures, one port. Every env var is isolated per
/// fixture; the port was the one shared channel.
///
/// `AIMUX_TEST_HARNESS`/`ownerPid` isolation cannot catch this, because all
/// three fixtures share one test-binary pid.
static ALLOCATED_DAEMON_PORTS: std::sync::Mutex<Vec<u16>> = std::sync::Mutex::new(Vec::new());

/// Whether a port the kernel just offered is usable for a new fixture.
///
/// A separate function because it is the only part of the allocator that can
/// be proved. Whether `bind(0)` ever hands out the same number twice is the
/// kernel's business and it usually does not within one sequential run, so a
/// test that calls the allocator in a loop and finds distinct ports passes
/// just as happily without the dedup -- I wrote that test first and it did.
fn daemon_port_is_available_for_a_fixture(candidate: u16, already_allocated: &[u16]) -> bool {
    candidate != aimux::daemon_state::DEFAULT_DAEMON_PORT && !already_allocated.contains(&candidate)
}

fn allocate_daemon_port() -> u16 {
    for _ in 0..100 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("allocate daemon port");
        let port = listener.local_addr().expect("daemon address").port();
        let mut allocated = ALLOCATED_DAEMON_PORTS
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !daemon_port_is_available_for_a_fixture(port, &allocated) {
            // The listener stays alive across the retry, so the kernel cannot
            // offer this same number again on the next attempt.
            let _hold = listener;
            drop(allocated);
            continue;
        }
        allocated.push(port);
        return port;
    }
    panic!("failed to allocate a non-default daemon port this binary has not already used");
}

/// A port already given to a fixture is refused, and so is the real one.
///
/// This replaces a first attempt that called `allocate_daemon_port` sixteen
/// times and asserted the results were distinct. That test passed with the
/// dedup removed -- the kernel simply does not reuse a just-freed port within
/// one sequential run -- so it proved the OS's habits, not the fix. The race
/// it was supposed to cover needs one fixture's probe released and another's
/// daemon not yet bound, which no unit test can force; what IS provable is
/// the decision this harness now makes, so that is what is tested.
///
/// Why it matters: on 2026-11-16 CI, `multi-project` failed with "project
/// service process exited before /health became ready" for a repo under
/// `.../multi-project-29580-2/alpha` while naming logs under
/// `.../git-cwd-29580-0/aimux-home/...`. Its CLI had reached the `git-cwd`
/// fixture's daemon, which started a project service under ITS home, and that
/// service died when `git-cwd`'s `Drop` stopped the daemon and removed the
/// tree. Every env var is per-fixture; the port was the one shared channel,
/// and `ownerPid` isolation cannot separate fixtures that share a test binary.
#[test]
fn a_port_already_handed_to_a_fixture_is_not_handed_out_again() {
    assert!(
        daemon_port_is_available_for_a_fixture(45001, &[]),
        "a fresh port must be usable"
    );
    assert!(
        !daemon_port_is_available_for_a_fixture(45001, &[45001]),
        "a port this binary already gave a fixture must be refused -- two fixtures on one port is how one reaches the other's daemon"
    );
    assert!(
        daemon_port_is_available_for_a_fixture(45002, &[45001]),
        "a different port must still be usable"
    );
    assert!(
        !daemon_port_is_available_for_a_fixture(aimux::daemon_state::DEFAULT_DAEMON_PORT, &[]),
        "a fixture must never be given the real daemon port"
    );
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
