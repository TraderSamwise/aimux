#![cfg(unix)]

mod support;

use std::fs;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use support::TestIsolation;

#[test]
fn expose_sigterm_restores_cursor_after_terminal_takeover() {
    let isolation = TestIsolation::new("expose-sigterm-cursor");
    let project_root = isolation.root().join("repo");
    let project_state_dir = isolation.root().join("state");
    fs::create_dir_all(&project_root).expect("create project root");
    fs::create_dir_all(&project_state_dir).expect("create project state dir");
    let stdout_path = isolation.root().join("expose.stdout");
    let stderr_path = isolation.root().join("expose.stderr");
    let stdout_file = fs::File::create(&stdout_path).expect("create stdout file");
    let stderr_file = fs::File::create(&stderr_path).expect("create stderr file");

    let mut command = Command::new(env!("CARGO_BIN_EXE_aimux"));
    let mut child = isolation
        .apply_to_command(&mut command)
        .arg("expose")
        .arg("--project-root")
        .arg(&project_root)
        .arg("--project-state-dir")
        .arg(&project_state_dir)
        .arg("--current-window")
        .arg("codex")
        .arg("--current-window-id")
        .arg("@1")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .expect("spawn expose child");
    let _stdin = child.stdin.take().expect("keep expose stdin open");

    wait_for_stdout_to_contain(&mut child, &stdout_path, "\x1b[?25l");
    signal_pid(child.id(), libc::SIGTERM);
    let status = wait_for_child_exit(&mut child, Duration::from_secs(5));
    assert!(
        status.success(),
        "expose should exit cleanly after SIGTERM; status={status:?} stderr={}",
        fs::read_to_string(&stderr_path).unwrap_or_default()
    );

    let output = fs::read_to_string(&stdout_path).expect("read expose stdout");
    let hide_at = output
        .find("\x1b[?25l")
        .unwrap_or_else(|| panic!("expected expose to hide cursor before signal:\n{output}"));
    let show_at = output
        .rfind("\x1b[?25h")
        .unwrap_or_else(|| panic!("expected expose to restore cursor after signal:\n{output}"));
    assert!(
        hide_at < show_at,
        "expected cursor hide before restore after signal:\n{output}"
    );
}

fn wait_for_stdout_to_contain(child: &mut Child, path: &std::path::Path, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let output = fs::read_to_string(path).unwrap_or_default();
        if output.contains(needle) {
            return;
        }
        if let Some(status) = child
            .try_wait()
            .unwrap_or_else(|error| panic!("poll expose child: {error}"))
        {
            panic!("expose exited before writing {needle:?}: {status:?}");
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for expose stdout to contain {needle:?}; stdout={output:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .unwrap_or_else(|error| panic!("poll expose child: {error}"))
        {
            return status;
        }
        if Instant::now() >= deadline {
            signal_pid(child.id(), libc::SIGKILL);
            panic!("expose did not exit after SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn signal_pid(pid: u32, signal: libc::c_int) {
    // SAFETY: The test sends POSIX signals only to the child process it spawned
    // inside an isolated Aimux home.
    unsafe {
        assert_eq!(libc::kill(pid as libc::pid_t, signal), 0);
    }
}
