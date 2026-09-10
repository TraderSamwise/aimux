use aimux::daemon_state::{
    AimuxDaemonInfo, DaemonState, ProjectServiceState, clear_daemon_info, load_daemon_state,
    save_daemon_info, save_daemon_state,
};
use aimux::daemon_supervisor::{
    DAEMON_HEALTH_KIND, DAEMON_START_LOCK_STALE_MS, RUNTIME_RESTART_LOCK_STALE_MS,
    assert_not_stale_against_daemon_with, daemon_start_lock_path, is_aimux_daemon_health,
    is_lock_stale, is_matching_daemon_health, read_lock_pid, release_daemon_start_lock,
    runtime_restart_lock_is_owned_by, runtime_restart_lock_path, runtime_restart_steal_lock_path,
    signal_number, signal_to_number, stop_daemon_info_with, stop_daemon_process_info_with,
    try_acquire_daemon_start_lock_with, try_acquire_runtime_restart_lock_with,
};
use aimux::paths::PathResolver;
use aimux::project_service_manifest::{
    ProjectServiceManifest, project_service_capabilities, should_keep_unresponsive_daemon,
};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let mut path = std::env::temp_dir();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        path.push(format!("aimux-daemon-supervisor-test-{unique}"));
        fs::create_dir_all(&path).expect("create test dir");
        Self(path)
    }

    fn resolver(&self) -> PathResolver {
        PathResolver::new(
            &self.0,
            self.0.join("home"),
            Some(self.0.join("global").to_string_lossy().into_owned()),
        )
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn manifest(build_stamp: &str) -> ProjectServiceManifest {
    ProjectServiceManifest {
        api_version: 5,
        capabilities: project_service_capabilities(),
        build_stamp: build_stamp.into(),
    }
}

fn health(build_stamp: &str) -> Value {
    json!({
        "ok": true,
        "kind": DAEMON_HEALTH_KIND,
        "pid": 123,
        "port": 43190,
        "serviceInfo": {
            "apiVersion": 5,
            "buildStamp": build_stamp,
            "capabilities": project_service_capabilities()
        }
    })
}

#[test]
fn health_identity_and_manifest_matching_follow_typescript_rules() {
    assert!(is_aimux_daemon_health(&health("1000.1000-abc")));
    assert!(!is_aimux_daemon_health(
        &json!({ "kind": DAEMON_HEALTH_KIND, "pid": 0 })
    ));
    assert!(!is_aimux_daemon_health(
        &json!({ "kind": "other", "pid": 1 })
    ));
    assert!(is_matching_daemon_health(
        &health("1000.1000-abc"),
        &manifest("1000.1000-abc")
    ));
    assert!(!is_matching_daemon_health(
        &health("1000.1000-abc"),
        &manifest("999.999-old")
    ));
}

#[test]
fn stale_build_error_text_matches_supervisor_contract() {
    let error = assert_not_stale_against_daemon_with(&health("2000.0-new"), "1000.0-old")
        .expect_err("newer daemon must be rejected");
    assert_eq!(
        error.to_string(),
        "aimux daemon is a newer build (2000.0-new) than this process (1000.0-old); reload this client instead of restarting the daemon"
    );
    assert!(assert_not_stale_against_daemon_with(&health("1000.0-old"), "2000.0-new").is_ok());
}

#[test]
fn unresponsive_daemon_policy_matches_adopt_existing_truth_table() {
    assert!(should_keep_unresponsive_daemon(None, true));
    assert!(should_keep_unresponsive_daemon(Some(true), true));
    assert!(!should_keep_unresponsive_daemon(Some(false), true));
    assert!(!should_keep_unresponsive_daemon(None, false));
}

#[test]
fn signal_validation_rejects_process_groups_and_unknown_signals_without_syscall() {
    assert!(signal_to_number("SIGTERM").is_ok());
    assert!(signal_number(1, "SIGTERM").is_ok());
    assert_eq!(
        signal_number(0, "SIGTERM").unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    assert_eq!(
        signal_number(-1, "SIGTERM").unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    assert_eq!(
        signal_number(1, "SIGBOGUS").unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
}

#[test]
fn daemon_start_lock_acquire_release_and_stale_rules_match_typescript() {
    let test_dir = TestDir::new();
    let resolver = test_dir.resolver();
    let lock_path = daemon_start_lock_path(&resolver);
    let owner_pid = 111;
    let acquired = try_acquire_daemon_start_lock_with(&lock_path, owner_pid, 1, |_| false)
        .expect("acquire lock")
        .expect("new lock");
    assert_eq!(acquired, lock_path);
    assert_eq!(read_lock_pid(&lock_path), Some(owner_pid));

    assert!(
        try_acquire_daemon_start_lock_with(&lock_path, 222, current_millis(), |pid| pid
            == owner_pid)
        .expect("contended lock")
        .is_none()
    );
    assert!(!is_lock_stale(
        &lock_path,
        DAEMON_START_LOCK_STALE_MS,
        lock_mtime_millis(&lock_path) + u128::from(DAEMON_START_LOCK_STALE_MS)
    ));
    assert!(is_lock_stale(
        &lock_path,
        DAEMON_START_LOCK_STALE_MS,
        lock_mtime_millis(&lock_path) + u128::from(DAEMON_START_LOCK_STALE_MS) + 1
    ));

    release_daemon_start_lock(Some(&lock_path), 999).expect("foreign release");
    assert!(lock_path.exists());
    release_daemon_start_lock(Some(&lock_path), owner_pid).expect("owner release");
    assert!(!lock_path.exists());
}

#[test]
fn stale_or_dead_lock_is_reclaimed_and_owner_file_must_be_integer_pid() {
    let test_dir = TestDir::new();
    let resolver = test_dir.resolver();
    let lock_path = daemon_start_lock_path(&resolver);
    fs::create_dir_all(&lock_path).expect("create lock");
    fs::write(lock_path.join("owner.json"), "{\"pid\":\"111\"}\n").expect("write malformed owner");
    assert_eq!(read_lock_pid(&lock_path), None);

    let acquired = try_acquire_daemon_start_lock_with(&lock_path, 222, current_millis(), |_| false)
        .expect("reclaim malformed lock")
        .expect("acquired after reclaim");
    assert_eq!(acquired, lock_path);
    assert_eq!(read_lock_pid(&lock_path), Some(222));
}

#[test]
fn runtime_restart_lock_matches_node_busy_and_reclaim_rules() {
    let test_dir = TestDir::new();
    let resolver = test_dir.resolver();
    let lock_path = runtime_restart_lock_path(&resolver);
    let steal_path = runtime_restart_steal_lock_path(&resolver);
    let owner_pid = 111;
    let acquired =
        try_acquire_runtime_restart_lock_with(&lock_path, &steal_path, owner_pid, 1, |_| false)
            .expect("acquire restart lock")
            .expect("new restart lock");
    assert_eq!(acquired, lock_path);
    assert_eq!(read_lock_pid(&lock_path), Some(owner_pid));
    assert!(runtime_restart_lock_is_owned_by(
        &resolver,
        owner_pid,
        current_millis(),
        |pid| pid == owner_pid
    ));

    assert!(
        try_acquire_runtime_restart_lock_with(
            &lock_path,
            &steal_path,
            222,
            current_millis(),
            |pid| { pid == owner_pid }
        )
        .expect("contended restart lock")
        .is_none()
    );
    assert!(lock_path.exists());
    assert!(!steal_path.exists());

    fs::remove_dir_all(&lock_path).expect("remove held lock");
    fs::create_dir_all(&lock_path).expect("create stale lock");
    fs::write(lock_path.join("owner.json"), "{\"pid\":111}\n").expect("write stale owner");
    let repair_lock = resolver
        .global_aimux_dir()
        .join("locks")
        .join("dashboard-control-plane-repair");
    fs::create_dir_all(&repair_lock).expect("create repair lock");
    fs::write(repair_lock.join("owner.json"), "{\"pid\":111}\n").expect("write repair owner");

    let reclaimed = try_acquire_runtime_restart_lock_with(
        &lock_path,
        &steal_path,
        222,
        current_millis() + u128::from(RUNTIME_RESTART_LOCK_STALE_MS) + 1,
        |pid| pid == 222,
    )
    .expect("reclaim restart lock")
    .expect("reclaimed restart lock");
    assert_eq!(reclaimed, lock_path);
    assert_eq!(read_lock_pid(&lock_path), Some(222));
    assert!(!repair_lock.exists());
    assert!(!steal_path.exists());

    fs::remove_dir_all(&lock_path).expect("remove reclaimed lock");
    fs::create_dir_all(&lock_path).expect("create second stale lock");
    fs::write(lock_path.join("owner.json"), "{\"pid\":333}\n").expect("write second owner");
    fs::create_dir_all(&steal_path).expect("create stale steal lock");
    fs::write(steal_path.join("owner.json"), "{\"pid\":333}\n").expect("write steal owner");
    let reclaimed_after_stale_steal = try_acquire_runtime_restart_lock_with(
        &lock_path,
        &steal_path,
        444,
        current_millis() + u128::from(RUNTIME_RESTART_LOCK_STALE_MS) + 1,
        |pid| pid == 444,
    )
    .expect("reclaim restart lock after stale steal")
    .expect("reclaimed restart lock after stale steal");
    assert_eq!(reclaimed_after_stale_steal, lock_path);
    assert_eq!(read_lock_pid(&lock_path), Some(444));
    assert!(!steal_path.exists());
}

#[test]
fn stop_daemon_info_clears_state_and_returns_only_verified_services() {
    let test_dir = TestDir::new();
    let resolver = test_dir.resolver();
    let info = AimuxDaemonInfo {
        pid: 9_999_991,
        port: 43190,
        started_at: "then".into(),
        updated_at: "now".into(),
    };
    let project = ProjectServiceState {
        project_id: "project-1".into(),
        project_root: "/repo".into(),
        pid: 9_999_992,
        started_at: "then".into(),
        updated_at: "now".into(),
        status: None,
        restart_count: None,
        last_restart_at: None,
        last_exit: None,
    };
    let state = DaemonState {
        version: 1,
        updated_at: Some(json!("now")),
        projects: Map::from_iter([(
            "project-1".into(),
            serde_json::to_value(project).expect("project JSON"),
        )]),
    };
    save_daemon_info(resolver.daemon_info_path(), &info).expect("save daemon info");
    save_daemon_state(resolver.daemon_state_path(), &state).expect("save daemon state");

    let mut signaled = Vec::new();
    let stopped = stop_daemon_info_with(
        &resolver,
        &info,
        state,
        "SIGTERM",
        |_| false,
        |_| true,
        |pid, signal| {
            signaled.push((pid, signal.to_owned()));
            Ok(())
        },
    )
    .expect("stop daemon info");
    assert_eq!(stopped.daemon, info);
    assert!(stopped.stopped_project_services.is_empty());
    assert_eq!(signaled, vec![(9_999_991, "SIGTERM".into())]);
    assert_eq!(
        fs::read_to_string(resolver.daemon_info_path()).expect("read daemon info"),
        ""
    );
    assert_eq!(
        load_daemon_state(resolver.daemon_state_path()),
        DaemonState::empty()
    );
    clear_daemon_info(resolver.daemon_info_path()).expect("clear is idempotent");
}

#[test]
fn stop_daemon_process_info_preserves_project_state_and_signals_only_daemon() {
    let test_dir = TestDir::new();
    let resolver = test_dir.resolver();
    let info = AimuxDaemonInfo {
        pid: 9_999_991,
        port: 43190,
        started_at: "then".into(),
        updated_at: "now".into(),
    };
    let project = ProjectServiceState {
        project_id: "project-1".into(),
        project_root: "/repo".into(),
        pid: 9_999_992,
        started_at: "then".into(),
        updated_at: "now".into(),
        status: None,
        restart_count: None,
        last_restart_at: None,
        last_exit: None,
    };
    let state = DaemonState {
        version: 1,
        updated_at: Some(json!("now")),
        projects: Map::from_iter([(
            "project-1".into(),
            serde_json::to_value(project).expect("project JSON"),
        )]),
    };
    save_daemon_info(resolver.daemon_info_path(), &info).expect("save daemon info");
    save_daemon_state(resolver.daemon_state_path(), &state).expect("save daemon state");

    let mut signaled = Vec::new();
    let mut waits = Vec::new();
    let stopped = stop_daemon_process_info_with(
        &resolver,
        &info,
        "SIGTERM",
        |_| true,
        |pid, signal| {
            signaled.push((pid, signal.to_owned()));
            Ok(())
        },
        |info, timeout_ms| {
            waits.push((info.pid, timeout_ms));
            true
        },
    )
    .expect("stop daemon process");

    assert_eq!(stopped.daemon, info);
    assert!(stopped.stopped_project_services.is_empty());
    assert_eq!(signaled, vec![(9_999_991, "SIGTERM".into())]);
    assert_eq!(waits, vec![(9_999_991, 1_500)]);
    assert_eq!(
        fs::read_to_string(resolver.daemon_info_path()).expect("read daemon info"),
        ""
    );
    assert_eq!(load_daemon_state(resolver.daemon_state_path()), state);
}

#[test]
fn stop_daemon_process_info_escalates_when_sigterm_does_not_exit() {
    let test_dir = TestDir::new();
    let resolver = test_dir.resolver();
    let info = AimuxDaemonInfo {
        pid: 9_999_991,
        port: 43190,
        started_at: "then".into(),
        updated_at: "now".into(),
    };
    save_daemon_info(resolver.daemon_info_path(), &info).expect("save daemon info");

    let mut signaled = Vec::new();
    let mut waits = Vec::new();
    let mut wait_results = [false, true].into_iter();
    let stopped = stop_daemon_process_info_with(
        &resolver,
        &info,
        "SIGTERM",
        |_| true,
        |pid, signal| {
            signaled.push((pid, signal.to_owned()));
            Ok(())
        },
        |info, timeout_ms| {
            waits.push((info.pid, timeout_ms));
            wait_results.next().unwrap_or(true)
        },
    )
    .expect("stop daemon process after kill");

    assert_eq!(stopped.daemon, info);
    assert_eq!(
        signaled,
        vec![(9_999_991, "SIGTERM".into()), (9_999_991, "SIGKILL".into())]
    );
    assert_eq!(waits, vec![(9_999_991, 1_500), (9_999_991, 1_500)]);
    assert_eq!(
        fs::read_to_string(resolver.daemon_info_path()).expect("read daemon info"),
        ""
    );
}

#[test]
fn stop_daemon_process_info_keeps_daemon_info_when_process_never_exits() {
    let test_dir = TestDir::new();
    let resolver = test_dir.resolver();
    let info = AimuxDaemonInfo {
        pid: 9_999_991,
        port: 43190,
        started_at: "then".into(),
        updated_at: "now".into(),
    };
    save_daemon_info(resolver.daemon_info_path(), &info).expect("save daemon info");

    let mut signaled = Vec::new();
    let error = stop_daemon_process_info_with(
        &resolver,
        &info,
        "SIGTERM",
        |_| true,
        |pid, signal| {
            signaled.push((pid, signal.to_owned()));
            Ok(())
        },
        |_, _| false,
    )
    .expect_err("non-exiting daemon must fail");

    assert_eq!(
        error.to_string(),
        "timed out stopping aimux daemon pid=9999991"
    );
    assert_eq!(
        signaled,
        vec![(9_999_991, "SIGTERM".into()), (9_999_991, "SIGKILL".into())]
    );
    assert!(
        fs::read_to_string(resolver.daemon_info_path())
            .expect("read daemon info")
            .contains("\"pid\": 9999991")
    );
}

#[test]
fn stop_daemon_info_refuses_to_signal_unverified_daemon_and_preserves_state() {
    let test_dir = TestDir::new();
    let resolver = test_dir.resolver();
    let info = AimuxDaemonInfo {
        pid: 9_999_991,
        port: 43190,
        started_at: "then".into(),
        updated_at: "now".into(),
    };
    let state = DaemonState {
        version: 1,
        updated_at: Some(json!("now")),
        projects: Map::new(),
    };
    save_daemon_info(resolver.daemon_info_path(), &info).expect("save daemon info");
    save_daemon_state(resolver.daemon_state_path(), &state).expect("save daemon state");

    let mut signaled = Vec::new();
    let error = stop_daemon_info_with(
        &resolver,
        &info,
        state.clone(),
        "SIGTERM",
        |_| false,
        |_| false,
        |pid, signal| {
            signaled.push((pid, signal.to_owned()));
            Ok(())
        },
    )
    .expect_err("unverified daemon must fail closed");

    assert_eq!(
        error.to_string(),
        "refusing to signal unverified aimux daemon pid=9999991"
    );
    assert!(signaled.is_empty());
    assert!(
        fs::read_to_string(resolver.daemon_info_path())
            .expect("read daemon info")
            .contains("\"pid\": 9999991")
    );
    assert_eq!(load_daemon_state(resolver.daemon_state_path()), state);
}

fn current_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn lock_mtime_millis(path: &PathBuf) -> u128 {
    fs::metadata(path)
        .expect("lock metadata")
        .modified()
        .expect("lock mtime")
        .duration_since(UNIX_EPOCH)
        .expect("mtime after epoch")
        .as_millis()
}
