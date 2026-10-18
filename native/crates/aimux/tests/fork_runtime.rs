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

const MALFORMED_TEST_NAME: &str =
    "retained_fork_runtime_keeps_malformed_creation_ownership_explicit";
const MALFORMED_FAKE_TMUX: &str = r#"#!/bin/sh
set -eu
printf 'CALL\n' >> "$AIMUX_FORK_MALFORMED_LOG"
printf '%s\n' "$@" >> "$AIMUX_FORK_MALFORMED_LOG"
case "${1-}" in
  new-window)
    case "$AIMUX_FORK_MALFORMED_CASE" in
      blank) exit 0 ;;
      unusable) printf 'not-a-target\n'; exit 0 ;;
      unusable-fields) printf 'not-a-target\t147\tfork-target\n'; exit 0 ;;
      ambiguous-fields) printf '@147\t147\tfork-target\n@148\t148\tother\n'; exit 0 ;;
      ambiguous) printf '@147\tbad-index\tfork-target\n@148\tbad-index\tother\n'; exit 0 ;;
      *) printf '@147\tbad-index\tfork-target\n' ;;
    esac
    case "$AIMUX_FORK_MALFORMED_CASE" in
      partial*) printf 'retention failed after creation\n' >&2; exit 9 ;;
      *) exit 0 ;;
    esac
    ;;
  kill-window)
    if [ "${2-}" != '-t' ] || [ "${3-}" != '@147' ]; then
      printf 'cleanup targeted the wrong window\n' >&2; exit 44
    fi
    case "$AIMUX_FORK_MALFORMED_CASE" in
      *cleanup-fails*) printf 'cleanup transport denied\n' >&2; exit 10 ;;
      *) exit 0 ;;
    esac
    ;;
  list-windows)
    if [ "${2-}" != '-t' ] || [ "${3-}" != 'managed-project' ]; then
      printf 'inventory targeted the wrong session\n' >&2; exit 45
    fi
    case "$AIMUX_FORK_MALFORMED_CASE" in
      *query-error*) printf 'inventory transport denied\n' >&2; exit 11 ;;
      *bad-index*) printf '@147\tbad-index\tfork-target\t0\t0\t0\n'; exit 0 ;;
      *absent*) exit 0 ;;
      *) printf '@147\t147\tfork-target\t0\t0\t0\n'; exit 0 ;;
    esac
    ;;
  *) printf 'unexpected tmux command: %s\n' "${1-}" >&2; exit 46 ;;
esac
"#;

fn malformed_child_case(case: &str) {
    let root = PathBuf::from(std::env::var_os("AIMUX_FORK_MALFORMED_ROOT").expect("child root"));
    let mut runtime = SystemProjectLifecycleRuntime;
    let error = runtime
        .create_restart_window(
            "managed-project",
            "fork-target",
            root.to_str().expect("utf8 root"),
            "/configured/target-wrapper",
            &["--target-only".into()],
            true,
        )
        .expect_err("malformed target response must report failure");
    assert!(
        error.message.contains("invalid tmux new-window output"),
        "{error}"
    );
    if case.starts_with("partial") {
        assert!(
            error.message.contains("retention failed after creation"),
            "{error}"
        );
    }
    if case.ends_with("exists") {
        let target = error
            .unreaped_target
            .as_ref()
            .expect("verified target must retain full identity");
        assert_eq!(target.window_id, "@147");
        assert_eq!(target.window_index, 147);
        assert_eq!(target.window_name, "fork-target");
        assert_eq!(target.session_name, "managed-project");
        assert_eq!(target.pane_dead, Some(false));
        assert!(error.uncertain_creation.is_none());
    } else if case.ends_with("query-error")
        || case.ends_with("bad-index")
        || matches!(
            case,
            "blank" | "unusable" | "unusable-fields" | "ambiguous" | "ambiguous-fields"
        )
    {
        let uncertain = error
            .uncertain_creation
            .as_ref()
            .expect("unknown ownership must be explicit");
        assert_eq!(uncertain.session_name, "managed-project");
        assert_eq!(
            uncertain.window_id.as_deref(),
            (case.ends_with("query-error") || case.ends_with("bad-index")).then_some("@147")
        );
        assert!(error.unreaped_target.is_none());
    } else {
        assert!(error.unreaped_target.is_none());
        assert!(error.uncertain_creation.is_none());
    }
    if case.contains("cleanup-fails") {
        assert!(
            error.message.contains("cleanup transport denied"),
            "{error}"
        );
    }
    if case.ends_with("query-error") {
        assert!(
            error.message.contains("inventory transport denied"),
            "{error}"
        );
    }
    if case.ends_with("bad-index") {
        assert!(
            error.message.contains("invalid tmux window inventory"),
            "{error}"
        );
        assert!(error.message.contains("bad-index"), "{error}");
    }
    if case.ends_with("absent") {
        assert!(
            error.message.contains("verified window @147 is absent"),
            "{error}"
        );
    }
    let calls = fs::read_to_string(std::env::var_os("AIMUX_FORK_MALFORMED_LOG").expect("call log"))
        .expect("read actual tmux calls");
    let known_id = case.starts_with("success") || case.starts_with("partial");
    assert_eq!(
        calls.lines().filter(|line| *line == "new-window").count(),
        1,
        "{calls}"
    );
    assert_eq!(
        calls.contains("kill-window\n-t\n@147\n"),
        known_id,
        "{calls}"
    );
    assert_eq!(
        calls.lines().any(|line| line == "list-windows"),
        case.contains("cleanup-fails"),
        "{calls}"
    );
}

#[test]
fn retained_fork_runtime_keeps_malformed_creation_ownership_explicit() {
    if let Some(case) = std::env::var_os("AIMUX_FORK_MALFORMED_CASE") {
        malformed_child_case(case.to_str().expect("utf8 case"));
        return;
    }
    let directory = ProbeDirectory(std::env::temp_dir().join(format!(
        "aimux-fork-malformed-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos()
    )));
    fs::create_dir_all(&directory.0).expect("runtime probe directory");
    let tmux = directory.0.join("fake-tmux");
    fs::write(&tmux, MALFORMED_FAKE_TMUX).expect("fake tmux executable");
    fs::set_permissions(&tmux, fs::Permissions::from_mode(0o700)).expect("executable fake tmux");
    for case in [
        "success-cleanup-ok",
        "partial-cleanup-ok",
        "success-cleanup-fails-exists",
        "partial-cleanup-fails-exists",
        "success-cleanup-fails-absent",
        "success-cleanup-fails-query-error",
        "success-cleanup-fails-bad-index",
        "blank",
        "unusable",
        "unusable-fields",
        "ambiguous",
        "ambiguous-fields",
    ] {
        let log = directory.0.join(format!("{case}.calls"));
        let output = Command::new(std::env::current_exe().expect("test executable"))
            .args(["--exact", MALFORMED_TEST_NAME, "--nocapture"])
            .env("AIMUX_TMUX_BIN", &tmux)
            .env_remove("AIMUX_TMUX_SOCKET_PATH")
            .env("AIMUX_FORK_MALFORMED_CASE", case)
            .env("AIMUX_FORK_MALFORMED_ROOT", &directory.0)
            .env("AIMUX_FORK_MALFORMED_LOG", &log)
            .output()
            .expect("run isolated malformed response case");
        assert!(
            output.status.success(),
            "malformed creation case {case} failed ({}):\n{}\n{}",
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

const INVENTORY_TEST_NAME: &str =
    "managed_window_inventory_preserves_absence_and_refuses_malformed_rows";
const INVENTORY_FAKE_TMUX: &str = r#"#!/bin/sh
set -eu
printf 'CALL\n' >> "$AIMUX_VERIFIED_INVENTORY_LOG"
printf '%s\n' "$@" >> "$AIMUX_VERIFIED_INVENTORY_LOG"
if [ "${1-}" != 'list-windows' ] || [ "${2-}" != '-t' ] || [ "${3-}" != 'managed-project' ]; then
  printf 'unexpected inventory command\n' >&2; exit 51
fi
case "$AIMUX_VERIFIED_INVENTORY_CASE" in
  empty) exit 0 ;;
  empty-fields) printf '@0\t0\t\t0\t\t0\n' ;;
  populated) printf '@1\t1\tfork-target\t1\t12345\t0\n@2\t2\tother\t0\t\t1\n' ;;
  index) printf '@1\tbad-index\tfork-target\t0\t\t0\n' ;;
  negative-index) printf '@1\t-1\tfork-target\t0\t\t0\n' ;;
  overflow-index) printf '@1\t9223372036854775808\tfork-target\t0\t\t0\n' ;;
  missing-fields) printf '@1\t1\tfork-target\t0\n' ;;
  extra-fields) printf '@1\t1\tfork-target\t0\t\t0\textra\n' ;;
  active) printf '@1\t1\tfork-target\ttrue\t\t0\n' ;;
  pane-dead) printf '@1\t1\tfork-target\t0\t\t2\n' ;;
  activity) printf '@1\t1\tfork-target\t0\tnot-timestamp\t0\n' ;;
  duplicate) printf '@1\t1\tfork-target\t0\t\t0\n@1\t2\tother\t0\t\t0\n' ;;
  id) printf 'not-a-window\t1\tfork-target\t0\t\t0\n' ;;
  *) printf 'unknown inventory case\n' >&2; exit 52 ;;
esac
"#;

fn inventory_child_case(case: &str) {
    let mut runtime = SystemProjectLifecycleRuntime;
    let result = runtime.list_windows("managed-project");
    match case {
        "empty" => assert!(
            result
                .expect("successful empty inventory must stay empty")
                .is_empty()
        ),
        "empty-fields" => {
            let windows = result.expect("present empty name and absent activity are valid");
            assert_eq!(windows.len(), 1);
            assert_eq!(windows[0].id, "@0");
            assert_eq!(windows[0].index, 0);
            assert_eq!(windows[0].name, "");
            assert_eq!(windows[0].activity, None);
            assert!(!windows[0].active);
            assert_eq!(windows[0].pane_dead, Some(false));
        }
        "populated" => {
            let windows = result.expect("complete inventory rows are valid");
            assert_eq!(windows.len(), 2);
            assert_eq!(windows[0].activity, Some(12345));
            assert!(windows[0].active);
            assert_eq!(windows[1].activity, None);
            assert_eq!(windows[1].pane_dead, Some(true));
        }
        _ => {
            let error = result.expect_err("malformed inventory must never create default fields");
            assert!(
                error.contains("invalid tmux window inventory"),
                "{case}: {error}"
            );
            assert!(error.contains("managed-project"), "{case}: {error}");
            let expected_field = match case {
                "index" | "negative-index" | "overflow-index" => "index",
                "missing-fields" | "extra-fields" => "columns",
                "active" => "window_active",
                "pane-dead" => "pane_dead",
                "activity" => "window_activity",
                "duplicate" => "duplicate window id",
                "id" => "window id",
                _ => panic!("unknown case {case}"),
            };
            assert!(error.contains(expected_field), "{case}: {error}");
        }
    }
    let log =
        fs::read_to_string(std::env::var_os("AIMUX_VERIFIED_INVENTORY_LOG").expect("call log"))
            .expect("read inventory call log");
    assert_eq!(
        log.lines().filter(|line| *line == "list-windows").count(),
        1,
        "{log}"
    );
}

#[test]
fn managed_window_inventory_preserves_absence_and_refuses_malformed_rows() {
    if let Some(case) = std::env::var_os("AIMUX_VERIFIED_INVENTORY_CASE") {
        inventory_child_case(case.to_str().expect("utf8 case"));
        return;
    }
    let directory = ProbeDirectory(std::env::temp_dir().join(format!(
        "aimux-verified-inventory-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos()
    )));
    fs::create_dir_all(&directory.0).expect("inventory probe directory");
    let tmux = directory.0.join("fake-tmux");
    fs::write(&tmux, INVENTORY_FAKE_TMUX).expect("fake tmux executable");
    fs::set_permissions(&tmux, fs::Permissions::from_mode(0o700)).expect("executable fake tmux");
    for case in [
        "empty",
        "empty-fields",
        "populated",
        "index",
        "negative-index",
        "overflow-index",
        "missing-fields",
        "extra-fields",
        "active",
        "pane-dead",
        "activity",
        "duplicate",
        "id",
    ] {
        let log = directory.0.join(format!("{case}.calls"));
        let output = Command::new(std::env::current_exe().expect("test executable"))
            .args(["--exact", INVENTORY_TEST_NAME, "--nocapture"])
            .env("AIMUX_TMUX_BIN", &tmux)
            .env_remove("AIMUX_TMUX_SOCKET_PATH")
            .env("AIMUX_VERIFIED_INVENTORY_CASE", case)
            .env("AIMUX_VERIFIED_INVENTORY_LOG", &log)
            .output()
            .expect("run isolated inventory case");
        assert!(
            output.status.success(),
            "inventory case {case} failed ({}):\n{}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            log.is_file(),
            "inventory case {case} never invoked the system adapter"
        );
    }
}
