#![cfg(unix)]

use aimux::project_service::lifecycle::{ProjectLifecycleRuntime, SystemProjectLifecycleRuntime};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const TEST_NAME: &str = "retained_fork_runtime_preserves_server_identity_and_partial_failure_state";
const FAKE_TMUX: &str = r#"#!/bin/sh
set -eu
printf 'CALL\n' >> "$AIMUX_FORK_RUNTIME_LOG"
printf '%s\n' "$@" >> "$AIMUX_FORK_RUNTIME_LOG"
if [ "${TMUX+x}" = x ] || [ "${TMUX_PANE+x}" = x ]; then
  printf 'inherited tmux context reached runtime: TMUX=%s TMUX_PANE=%s\n' "${TMUX-unset}" "${TMUX_PANE-unset}" >&2
  exit 41
fi
if [ -n "$AIMUX_FORK_RUNTIME_EXPECT_SOCKET" ]; then
  if [ "${1-}" != '-S' ] || [ "${2-}" != "$AIMUX_FORK_RUNTIME_EXPECT_SOCKET" ]; then
    printf 'explicit AIMUX socket was not preserved\n' >&2
    exit 42
  fi
  shift 2
elif [ "${1-}" = '-S' ]; then
  printf 'unexpected explicit socket on default runtime\n' >&2
  exit 43
fi
case "${1-}" in
  new-window)
    printf '@42\t42\tfork-target\n'
    case "$AIMUX_FORK_RUNTIME_CASE" in
      *partial*) printf 'retaining newly created fork failed\n' >&2; exit 9 ;;
      *) exit 0 ;;
    esac
    ;;
  kill-window)
    if [ "${2-}" != '-t' ] || [ "${3-}" != '@42' ]; then
      printf 'cleanup targeted the wrong created window\n' >&2
      exit 44
    fi
    case "$AIMUX_FORK_RUNTIME_CASE" in
      *cleanup-fails*) printf 'cleanup transport denied\n' >&2; exit 10 ;;
      *) exit 0 ;;
    esac
    ;;
  *) printf 'unexpected tmux command: %s\n' "${1-}" >&2; exit 45 ;;
esac
"#;

struct ProbeDirectory(PathBuf);

impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn child_case(case: &str) {
    let root = PathBuf::from(std::env::var_os("AIMUX_FORK_RUNTIME_ROOT").expect("child root"));
    let detached = !case.contains("open");
    let mut runtime = SystemProjectLifecycleRuntime;
    let result = runtime.create_restart_window(
        "managed-project",
        "fork-target",
        root.to_str().expect("utf8 root"),
        "/configured/target-wrapper",
        &["--target-only".into()],
        detached,
    );
    if case.contains("partial") {
        let error = result.expect_err("partial retained creation must report failure");
        assert!(
            error
                .message
                .contains("retaining newly created fork failed"),
            "{error}"
        );
        if case.contains("cleanup-fails") {
            assert!(
                error.message.contains("cleanup transport denied"),
                "{error}"
            );
            let target = error
                .unreaped_target
                .as_ref()
                .expect("failed cleanup must retain typed target");
            assert_eq!(target.window_id, "@42");
            assert_eq!(target.session_name, "managed-project");
        } else {
            assert!(
                error.unreaped_target.is_none(),
                "cleaned target must not be reported live: {error}"
            );
        }
    } else {
        let target = result.expect("inherited tmux state must not redirect managed launch");
        assert_eq!(target.window_id, "@42");
        assert_eq!(target.session_name, "managed-project");
        assert_eq!(target.window_index, 42);
    }
    let calls = fs::read_to_string(std::env::var_os("AIMUX_FORK_RUNTIME_LOG").expect("call log"))
        .expect("read actual tmux calls");
    assert_eq!(
        calls.lines().filter(|line| *line == "new-window").count(),
        1,
        "{calls}"
    );
    assert_eq!(
        calls.lines().any(|line| line == "-d"),
        detached,
        "open must preserve detached choice: {calls}"
    );
    assert_eq!(
        calls.contains("kill-window\n-t\n@42\n"),
        case.contains("partial"),
        "partial creation must clean the recovered target: {calls}"
    );
}

#[test]
fn retained_fork_runtime_preserves_server_identity_and_partial_failure_state() {
    if let Some(case) = std::env::var_os("AIMUX_FORK_RUNTIME_CASE") {
        child_case(case.to_str().expect("utf8 case"));
        return;
    }
    let directory = ProbeDirectory(std::env::temp_dir().join(format!(
        "aimux-fork-runtime-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos()
    )));
    fs::create_dir_all(&directory.0).expect("runtime probe directory");
    let tmux = directory.0.join("fake-tmux");
    fs::write(&tmux, FAKE_TMUX).expect("fake tmux executable");
    fs::set_permissions(&tmux, fs::Permissions::from_mode(0o700)).expect("executable fake tmux");
    for case in [
        "default-detached",
        "explicit-open",
        "default-partial-cleanup-ok",
        "explicit-partial-cleanup-ok",
        "default-partial-cleanup-fails",
        "explicit-partial-cleanup-fails",
    ] {
        let socket = if case.starts_with("explicit") {
            directory
                .0
                .join("foreign-home-runtime.sock")
                .to_string_lossy()
                .into_owned()
        } else {
            String::new()
        };
        let log = directory.0.join(format!("{case}.calls"));
        let mut child = Command::new(std::env::current_exe().expect("test executable"));
        child
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env("AIMUX_TMUX_BIN", &tmux)
            .env("TMUX", "/foreign/inherited-server.sock,777,1")
            .env("TMUX_PANE", "%777")
            .env("AIMUX_FORK_RUNTIME_CASE", case)
            .env("AIMUX_FORK_RUNTIME_ROOT", &directory.0)
            .env("AIMUX_FORK_RUNTIME_LOG", &log)
            .env("AIMUX_FORK_RUNTIME_EXPECT_SOCKET", &socket);
        if socket.is_empty() {
            child.env_remove("AIMUX_TMUX_SOCKET_PATH");
        } else {
            child.env("AIMUX_TMUX_SOCKET_PATH", &socket);
        }
        let output = child.output().expect("run isolated system adapter case");
        assert!(
            output.status.success(),
            "system adapter case {case} failed ({}):\n{}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            log.is_file(),
            "case {case} never invoked the system tmux adapter"
        );
    }
}
