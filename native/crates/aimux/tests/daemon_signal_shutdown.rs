#![cfg(unix)]

mod support;

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use support::TestIsolation;

#[test]
fn daemon_sigterm_cleans_registration_and_project_service_children() {
    let isolation = TestIsolation::new("daemon-sigterm-cleanup");
    let project_root = isolation.root().join("repo");
    fs::create_dir_all(&project_root).expect("create project root");
    let git_init = Command::new("git")
        .arg("init")
        .arg("--quiet")
        .arg(&project_root)
        .output()
        .expect("run git init");
    assert!(
        git_init.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&git_init.stderr)
    );

    let mut daemon = Command::new(env!("CARGO_BIN_EXE_aimux"));
    let mut daemon = isolation
        .apply_to_command(&mut daemon)
        .args(["daemon", "run"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");
    wait_for_daemon_health(isolation.daemon_port());
    assert!(
        isolation.aimux_home().join("daemon/daemon.json").exists(),
        "daemon info should exist while daemon is running"
    );

    let mut ps = Command::new(env!("CARGO_BIN_EXE_aimux"));
    let ps = isolation
        .apply_to_command(&mut ps)
        .args(["ps", "--project"])
        .arg(&project_root)
        .arg("--json")
        .output()
        .expect("run aimux ps");
    assert!(
        ps.status.success(),
        "aimux ps failed: stdout={} stderr={}",
        String::from_utf8_lossy(&ps.stdout),
        String::from_utf8_lossy(&ps.stderr)
    );
    let service_pids = wait_for_project_service_pids(&isolation);
    assert!(
        !service_pids.is_empty(),
        "daemon should materialize a project service before signal shutdown"
    );
    for pid in &service_pids {
        signal_pid(*pid, libc::SIGSTOP);
    }

    signal_pid(daemon.id(), libc::SIGTERM);
    wait_for_child_exit(&mut daemon, "daemon");

    assert_daemon_info_cleared(isolation.aimux_home().join("daemon/daemon.json"));
    for pid in service_pids {
        assert!(
            !pid_alive(pid),
            "daemon SIGTERM should wait for child project service pid {pid} before exiting"
        );
    }
}

#[test]
fn daemon_sighup_preserves_project_service_children_for_restart() {
    let isolation = TestIsolation::new("daemon-sighup-preserve-services");
    let project_root = isolation.root().join("repo");
    fs::create_dir_all(&project_root).expect("create project root");
    let git_init = Command::new("git")
        .arg("init")
        .arg("--quiet")
        .arg(&project_root)
        .output()
        .expect("run git init");
    assert!(
        git_init.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&git_init.stderr)
    );

    let mut daemon = Command::new(env!("CARGO_BIN_EXE_aimux"));
    let mut daemon = isolation
        .apply_to_command(&mut daemon)
        .args(["daemon", "run"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");
    wait_for_daemon_health(isolation.daemon_port());

    let mut ps = Command::new(env!("CARGO_BIN_EXE_aimux"));
    let ps = isolation
        .apply_to_command(&mut ps)
        .args(["ps", "--project"])
        .arg(&project_root)
        .arg("--json")
        .output()
        .expect("run aimux ps");
    assert!(
        ps.status.success(),
        "aimux ps failed: stdout={} stderr={}",
        String::from_utf8_lossy(&ps.stdout),
        String::from_utf8_lossy(&ps.stderr)
    );
    let service_pids = wait_for_project_service_pids(&isolation);
    assert!(
        !service_pids.is_empty(),
        "daemon should materialize a project service before restart signal shutdown"
    );

    signal_pid(daemon.id(), libc::SIGHUP);
    wait_for_child_exit(&mut daemon, "daemon");

    assert_daemon_info_cleared(isolation.aimux_home().join("daemon/daemon.json"));
    for pid in &service_pids {
        assert!(
            pid_alive(*pid),
            "daemon SIGHUP restart handoff must leave project service pid {pid} alive"
        );
    }
    for pid in service_pids {
        signal_pid(pid, libc::SIGTERM);
    }
}

#[test]
fn daemon_exits_when_test_isolation_owner_exits() {
    let isolation = TestIsolation::new("daemon-test-owner-exit");
    let mut owner = Command::new("sleep")
        .arg("60")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test owner");
    write_test_isolation_marker(isolation.aimux_home(), owner.id());

    let mut daemon = Command::new(env!("CARGO_BIN_EXE_aimux"));
    let mut daemon = isolation
        .apply_to_command(&mut daemon)
        .args(["daemon", "run"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");
    wait_for_daemon_health(isolation.daemon_port());

    signal_pid(owner.id(), libc::SIGTERM);
    wait_for_child_exit(&mut owner, "test owner");
    wait_for_child_exit(&mut daemon, "daemon after test owner exit");
    assert_daemon_info_cleared(isolation.aimux_home().join("daemon/daemon.json"));
}

#[test]
fn daemon_without_test_isolation_lease_is_not_reaped_by_watchdog() {
    let isolation = TestIsolation::new("daemon-no-test-lease");
    fs::remove_file(
        isolation
            .aimux_home()
            .join(aimux::runtime_safety_guard::TEST_ISOLATION_MARKER),
    )
    .expect("remove test isolation marker");

    let mut daemon = Command::new(env!("CARGO_BIN_EXE_aimux"));
    isolation
        .apply_to_command(&mut daemon)
        .args(["daemon", "run"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    remove_cargo_test_identity(&mut daemon);
    let mut daemon = daemon.spawn().expect("spawn non-test daemon");
    wait_for_daemon_health(isolation.daemon_port());
    std::thread::sleep(Duration::from_millis(1200));
    wait_for_daemon_health(isolation.daemon_port());

    signal_pid(daemon.id(), libc::SIGTERM);
    wait_for_child_exit(&mut daemon, "legitimate daemon");
}

#[test]
fn daemon_refuses_cargo_test_context_without_test_isolation_lease() {
    let isolation = TestIsolation::new("daemon-missing-test-lease");
    fs::remove_file(
        isolation
            .aimux_home()
            .join(aimux::runtime_safety_guard::TEST_ISOLATION_MARKER),
    )
    .expect("remove test isolation marker");

    let mut daemon = Command::new(env!("CARGO_BIN_EXE_aimux"));
    let mut daemon = isolation
        .apply_to_command(&mut daemon)
        .args(["daemon", "run"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");
    wait_for_child_exit(&mut daemon, "daemon missing test lease");
    let stderr = child_stderr(&mut daemon);

    assert!(
        stderr.contains("refusing cargo-test daemon without test isolation lease"),
        "daemon should refuse missing test lease loudly, got stderr={stderr:?}"
    );
}

fn wait_for_daemon_health(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            stream
                .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .expect("write daemon health request");
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            if response.contains("\"ok\":true") || response.contains("\"kind\":\"aimux-daemon\"") {
                return;
            }
        }
        assert!(
            Instant::now() < deadline,
            "daemon did not become healthy on port {port}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn write_test_isolation_marker(aimux_home: &std::path::Path, owner_pid: u32) {
    fs::write(
        aimux_home.join(aimux::runtime_safety_guard::TEST_ISOLATION_MARKER),
        format!(r#"{{"kind":"cargo-test","ownerPid":{owner_pid}}}"#),
    )
    .expect("write isolated aimux home marker");
}

fn remove_cargo_test_identity(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key
            .to_str()
            .is_some_and(|key| key.starts_with("CARGO_BIN_EXE_"))
        {
            command.env_remove(key);
        }
    }
    command.env_remove("CARGO_TARGET_TMPDIR");
    command.env_remove(aimux::runtime_safety_guard::TEST_HARNESS_ENV_VAR);
}

fn child_stderr(child: &mut Child) -> String {
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    stderr
}

fn wait_for_project_service_pids(isolation: &TestIsolation) -> Vec<u32> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let pids = isolation.project_service_pids();
        if !pids.is_empty() {
            return pids;
        }
        assert!(
            Instant::now() < deadline,
            "project service pid did not appear in daemon state"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn wait_for_child_exit(child: &mut Child, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child
            .try_wait()
            .unwrap_or_else(|error| panic!("wait for {label}: {error}"))
            .is_some()
        {
            return;
        }
        assert!(Instant::now() < deadline, "{label} did not exit");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn assert_daemon_info_cleared(path: impl AsRef<std::path::Path>) {
    let contents = fs::read_to_string(path.as_ref()).unwrap_or_default();
    assert!(
        contents.trim().is_empty(),
        "daemon SIGTERM should return through DaemonInfoGuard and clear daemon info, got {contents:?}"
    );
}

fn signal_pid(pid: u32, signal: libc::c_int) {
    // SAFETY: The test sends a standard POSIX signal to a child process it
    // spawned inside an isolated Aimux home.
    unsafe {
        assert_eq!(libc::kill(pid as libc::pid_t, signal), 0);
    }
}

fn pid_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
