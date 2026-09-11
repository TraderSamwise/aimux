#![cfg(unix)]

mod support;

use aimux::daemon_state::{metadata_endpoint_path, metadata_endpoint_text_path};
use aimux::expose_socket::expose_socket_path_file;
use aimux::paths::{PathResolver, compute_project_id};
use std::fs;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use support::TestIsolation;

#[test]
fn project_service_sigterm_clears_endpoint_and_expose_socket_artifacts() {
    let isolation = TestIsolation::new("project-service-sigterm-cleanup");
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

    let mut resolver = PathResolver::from_env();
    let project_id = compute_project_id(&project_root);
    let project_state_dir = resolver.project_state_dir_for(&project_root);

    let mut service = Command::new(env!("CARGO_BIN_EXE_aimux"));
    let mut service = isolation
        .apply_to_command(&mut service)
        .current_dir(&project_root)
        .args([
            "__project-service-internal",
            "--project-id",
            &project_id,
            "--project-root",
        ])
        .arg(&project_root)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn project service");

    let socket_path_file = expose_socket_path_file(&project_state_dir);
    wait_for_path(
        metadata_endpoint_path(&project_state_dir),
        "metadata endpoint json",
    );
    wait_for_path(
        metadata_endpoint_text_path(&project_state_dir),
        "metadata endpoint text",
    );
    wait_for_path(&socket_path_file, "expose socket path marker");
    let socket_path = fs::read_to_string(&socket_path_file).expect("read expose socket path");
    let socket_path = std::path::PathBuf::from(socket_path.trim());
    assert!(
        socket_path.exists(),
        "expose socket should exist while project service is running"
    );

    signal_pid(service.id(), libc::SIGTERM);
    wait_for_child_exit(&mut service, "project service");

    assert!(
        !metadata_endpoint_path(&project_state_dir).exists(),
        "project service SIGTERM should clear metadata endpoint json"
    );
    assert!(
        !metadata_endpoint_text_path(&project_state_dir).exists(),
        "project service SIGTERM should clear metadata endpoint text"
    );
    assert!(
        !socket_path_file.exists(),
        "project service SIGTERM should clear expose socket marker"
    );
    assert!(
        !socket_path.exists(),
        "project service SIGTERM should remove expose socket"
    );
}

fn wait_for_path(path: impl AsRef<Path>, label: &str) {
    let path = path.as_ref();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(Instant::now() < deadline, "{label} did not appear");
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

fn signal_pid(pid: u32, signal: libc::c_int) {
    // SAFETY: The test sends a standard POSIX signal to a child process it
    // spawned inside an isolated Aimux home.
    unsafe {
        assert_eq!(libc::kill(pid as libc::pid_t, signal), 0);
    }
}
