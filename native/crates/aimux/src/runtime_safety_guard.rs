use crate::daemon::routing::DaemonRouteUrl;
use crate::debug_logging::log_lifecycle_always;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

pub const TEST_HARNESS_HEADER: &str = "x-aimux-test-harness";
pub const TEST_HARNESS_ENV_VAR: &str = "AIMUX_TEST_HARNESS";
pub const TEST_ISOLATION_MARKER: &str = "test-isolation.json";
const CARGO_TEST_HEADER_VALUE: &str = "cargo-test";
const TEST_ISOLATION_OWNER_WATCHDOG_INTERVAL_MS: u64 = 500;
const TEST_PROJECT_PREFIXES: &[&str] = &[
    "aimux-dashboard-cmd-installed.",
    "aimux-dashboard-cmd-source.",
    "aimux-expose-dashboard-cmd.",
    "aimux-live-dashboard-cmd.",
    "aimux-rust-project-service-",
    "amx-test-",
];
const PROJECT_ROOT_REQUEST_FIELDS: &[&str] = &[
    "cwd",
    "project",
    "projectPath",
    "projectRoot",
    "repoRoot",
    "root",
    "worktreePath",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestIsolationLease {
    pub kind: String,
    pub owner_pid: i32,
}

pub fn load_test_isolation_lease(daemon_home: &Path) -> Result<Option<TestIsolationLease>, String> {
    let marker = daemon_home.join(TEST_ISOLATION_MARKER);
    if !marker.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&marker).map_err(|error| {
        format!(
            "could not read test isolation marker {}: {error}",
            marker.display()
        )
    })?;
    let value = serde_json::from_str::<Value>(&raw).map_err(|error| {
        format!(
            "could not parse test isolation marker {}: {error}",
            marker.display()
        )
    })?;
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "test isolation marker {} is missing string kind",
                marker.display()
            )
        })?
        .to_owned();
    let owner_pid = value
        .get("ownerPid")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            format!(
                "test isolation marker {} is missing integer ownerPid",
                marker.display()
            )
        })?;
    let owner_pid = i32::try_from(owner_pid).map_err(|_| {
        format!(
            "test isolation marker {} ownerPid is out of range",
            marker.display()
        )
    })?;
    if owner_pid <= 0 {
        return Err(format!(
            "test isolation marker {} ownerPid must be positive, got {owner_pid}",
            marker.display()
        ));
    }
    Ok(Some(TestIsolationLease { kind, owner_pid }))
}

pub fn spawn_test_isolation_owner_watchdog(
    aimux_home: &Path,
    process_label: &'static str,
) -> Option<Arc<AtomicBool>> {
    let lease = match load_test_isolation_lease(aimux_home) {
        Ok(Some(lease)) => lease,
        Ok(None) => return None,
        Err(error) => {
            log_lifecycle_always(
                "test isolation watchdog not started",
                process_label,
                Some(json!({ "aimuxHome": aimux_home.to_string_lossy(), "error": error })),
            );
            return None;
        }
    };
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let aimux_home = aimux_home.to_path_buf();
    let owner_pid = lease.owner_pid;
    let kind = lease.kind.clone();
    let aimux_home_for_thread = aimux_home.clone();
    let kind_for_thread = kind.clone();
    let interval = Duration::from_millis(TEST_ISOLATION_OWNER_WATCHDOG_INTERVAL_MS);
    thread::Builder::new()
        .name(format!("aimux-{process_label}-test-isolation-watchdog"))
        .spawn(move || {
            while !stop_for_thread.load(Ordering::SeqCst) {
                thread::sleep(interval);
                if let Some(reason) =
                    test_isolation_owner_stop_reason(&aimux_home_for_thread, &lease, process_label)
                {
                    log_lifecycle_always(
                        "process stopping after test isolation owner ended",
                        process_label,
                        Some(json!({
                            "aimuxHome": aimux_home_for_thread.to_string_lossy(),
                            "ownerPid": owner_pid,
                            "kind": kind_for_thread,
                            "reason": reason,
                        })),
                    );
                    stop_for_thread.store(true, Ordering::SeqCst);
                    return;
                }
            }
        })
        .map_err(|error| {
            log_lifecycle_always(
                "test isolation watchdog spawn failed",
                process_label,
                Some(json!({
                    "aimuxHome": aimux_home.to_string_lossy(),
                    "ownerPid": owner_pid,
                    "kind": kind,
                    "error": error.to_string(),
                })),
            );
        })
        .ok()?;
    Some(stop)
}

pub fn test_isolation_owner_stop_reason(
    aimux_home: &Path,
    lease: &TestIsolationLease,
    process_label: &'static str,
) -> Option<String> {
    test_isolation_owner_stop_reason_with_probe(
        aimux_home,
        lease,
        crate::daemon_state::try_is_pid_alive,
        process_label,
    )
}

pub fn test_isolation_owner_stop_reason_with_probe(
    aimux_home: &Path,
    lease: &TestIsolationLease,
    pid_alive: impl Fn(i32) -> Result<bool, String>,
    process_label: &'static str,
) -> Option<String> {
    let marker = aimux_home.join(TEST_ISOLATION_MARKER);
    match marker.try_exists() {
        Ok(true) => {}
        Ok(false) => {
            return Some(format!(
                "test isolation marker disappeared: {}",
                marker.display()
            ));
        }
        Err(error) => {
            log_lifecycle_always(
                "test isolation marker probe failed",
                process_label,
                Some(json!({ "marker": marker.to_string_lossy(), "error": error.to_string() })),
            );
            return None;
        }
    }
    match pid_alive(lease.owner_pid) {
        Ok(true) => None,
        Ok(false) => Some(format!(
            "test isolation owner pid {} exited",
            lease.owner_pid
        )),
        Err(error) => {
            log_lifecycle_always(
                "test isolation owner probe failed",
                process_label,
                Some(json!({ "ownerPid": lease.owner_pid, "error": error })),
            );
            None
        }
    }
}

pub fn mark_daemon_test_harness_request(headers: &mut BTreeMap<String, String>) {
    let aimux_home = crate::paths::PathResolver::from_env().global_aimux_dir();
    if should_refuse_cargo_test_for_daemon_home(&aimux_home) {
        headers.insert(
            TEST_HARNESS_HEADER.to_owned(),
            CARGO_TEST_HEADER_VALUE.to_owned(),
        );
    }
}

pub fn daemon_test_harness_header_for_url(url: &str) -> Option<(&'static str, &'static str)> {
    let aimux_home = crate::paths::PathResolver::from_env().global_aimux_dir();
    daemon_test_harness_header_for_url_with_home(url, &aimux_home)
}

pub fn daemon_test_harness_header_for_url_with_home(
    url: &str,
    daemon_home: &Path,
) -> Option<(&'static str, &'static str)> {
    (is_loopback_daemon_url(url) && should_refuse_cargo_test_for_daemon_home(daemon_home))
        .then_some((TEST_HARNESS_HEADER, CARGO_TEST_HEADER_VALUE))
}

pub fn request_refusal_reason(headers: &BTreeMap<String, String>) -> Option<&'static str> {
    header_value(headers, TEST_HARNESS_HEADER)
        .is_some_and(|value| value == CARGO_TEST_HEADER_VALUE)
        .then_some("cargo test harness")
}

pub fn default_daemon_run_refusal_reason_for_exe(
    daemon_port: u16,
    exe: &Path,
) -> Option<&'static str> {
    default_daemon_run_refusal_reason_for_exe_with_build_identity(
        daemon_port,
        exe,
        is_internal_cargo_aimux_build(),
    )
}

fn default_daemon_run_refusal_reason_for_exe_with_build_identity(
    daemon_port: u16,
    exe: &Path,
    is_internal_cargo_build: bool,
) -> Option<&'static str> {
    if daemon_port != crate::daemon_state::DEFAULT_DAEMON_PORT {
        return None;
    }
    if !is_aimux_binary_path(exe) {
        return None;
    }
    is_internal_cargo_build.then_some("cargo target daemon on default port")
}

pub fn default_daemon_run_refusal_reason(daemon_port: u16) -> Option<&'static str> {
    default_daemon_run_refusal_reason_for_exe(daemon_port, &std::env::current_exe().ok()?)
}

pub fn missing_daemon_test_isolation_lease_refusal_reason(daemon_home: &Path) -> Option<String> {
    missing_daemon_test_isolation_lease_refusal_reason_for_process(
        daemon_home,
        is_cargo_test_process_context(),
    )
}

pub(crate) fn missing_daemon_test_isolation_lease_refusal_reason_for_process(
    daemon_home: &Path,
    is_cargo_test_process: bool,
) -> Option<String> {
    if !is_cargo_test_process {
        return None;
    }
    match load_test_isolation_lease(daemon_home) {
        Ok(Some(_)) => None,
        Ok(None) => Some(format!(
            "cargo-test daemon requires test isolation lease at {}",
            daemon_home.join(TEST_ISOLATION_MARKER).display()
        )),
        Err(error) => Some(format!(
            "cargo-test daemon has invalid test isolation lease: {error}"
        )),
    }
}

pub fn request_project_refusal_reason(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Option<&'static str> {
    for key in PROJECT_ROOT_REQUEST_FIELDS {
        if let Some(reason) = route_url
            .search_param(key)
            .and_then(project_root_text_refusal_reason)
        {
            return Some(reason);
        }
    }
    body.and_then(project_root_fields_refusal_reason)
}

pub fn request_missing_project_refusal_reason(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Option<&'static str> {
    for key in PROJECT_ROOT_REQUEST_FIELDS {
        if let Some(reason) = route_url
            .search_param(key)
            .and_then(missing_project_root_text_refusal_reason)
        {
            return Some(reason);
        }
    }
    body.and_then(missing_project_root_fields_refusal_reason)
}

pub fn project_materialization_refusal_reason(
    project_root: &Path,
    daemon_home: &Path,
) -> Option<&'static str> {
    project_materialization_refusal_reason_for_process(
        project_root,
        daemon_home,
        is_cargo_test_process_context(),
    )
}

pub(crate) fn project_materialization_refusal_reason_for_process(
    project_root: &Path,
    daemon_home: &Path,
    is_cargo_test_process: bool,
) -> Option<&'static str> {
    match crate::paths::project_root_status(project_root) {
        crate::paths::ProjectRootStatus::GitCheckout => {}
        crate::paths::ProjectRootStatus::NotCheckout => return Some("non-checkout project"),
        crate::paths::ProjectRootStatus::Unreachable => return Some("unreachable project"),
    }
    if is_cargo_test_process && !is_isolated_test_aimux_home(daemon_home) {
        return Some("cargo test harness");
    }
    None
}

pub fn should_refuse_cargo_test_for_daemon_home(daemon_home: &Path) -> bool {
    is_cargo_test_process_context() && !is_isolated_test_aimux_home(daemon_home)
}

pub fn is_isolated_test_aimux_home(daemon_home: &Path) -> bool {
    matches!(load_test_isolation_lease(daemon_home), Ok(Some(_)))
}

pub fn is_cargo_test_harness_binary() -> bool {
    is_cargo_test_harness_binary_path().is_some()
}

pub fn is_cargo_test_process_context() -> bool {
    std::env::var_os(TEST_HARNESS_ENV_VAR).is_some()
        || is_any_cargo_test_harness_binary_path()
        || std::env::vars_os().any(|(key, _)| {
            key.to_str()
                .is_some_and(|key| key.starts_with("CARGO_BIN_EXE_"))
        })
        || std::env::var_os("CARGO_TARGET_TMPDIR").is_some()
}

fn is_cargo_test_harness_binary_path() -> Option<()> {
    let Ok(exe) = std::env::current_exe() else {
        return None;
    };
    let parent = exe
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())?;
    if parent != "deps" {
        return None;
    }
    exe.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.contains('-')
                && (name.starts_with("project_service_")
                    || name.starts_with("desktop_notifier-")
                    || name.starts_with("mobile_push_bridge-")
                    || name.starts_with("daemon_"))
        })
        .then_some(())
}

fn is_any_cargo_test_harness_binary_path() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(parent) = exe
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    parent == "deps"
        && exe
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains('-'))
}

fn is_internal_cargo_aimux_build() -> bool {
    cfg!(debug_assertions) || crate::build_info().profile == "native-dev"
}

fn is_aimux_binary_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "aimux")
}

#[cfg(test)]
fn is_cargo_target_aimux_binary_path(path: &Path) -> bool {
    if !is_aimux_binary_path(path) {
        return false;
    }
    let components = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    components.windows(2).any(|window| {
        let parent = window[0];
        let profile = window[1];
        (parent == "target" || parent.starts_with("aimux-cargo-target-"))
            && matches!(profile, "debug" | "release")
    })
}

fn path_has_test_fixture_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name.to_str().is_some_and(has_test_fixture_prefix),
        _ => false,
    })
}

fn project_root_fields_refusal_reason(value: &Value) -> Option<&'static str> {
    match value {
        Value::Object(map) => {
            for key in PROJECT_ROOT_REQUEST_FIELDS {
                if let Some(reason) = map
                    .get(*key)
                    .and_then(Value::as_str)
                    .and_then(project_root_text_refusal_reason)
                {
                    return Some(reason);
                }
            }
            for child in map.values() {
                if let Some(reason) = project_root_fields_refusal_reason(child) {
                    return Some(reason);
                }
            }
            None
        }
        Value::Array(values) => values.iter().find_map(project_root_fields_refusal_reason),
        _ => None,
    }
}

fn missing_project_root_fields_refusal_reason(value: &Value) -> Option<&'static str> {
    match value {
        Value::Object(map) => {
            for key in PROJECT_ROOT_REQUEST_FIELDS {
                if let Some(reason) = map
                    .get(*key)
                    .and_then(Value::as_str)
                    .and_then(missing_project_root_text_refusal_reason)
                {
                    return Some(reason);
                }
            }
            for child in map.values() {
                if let Some(reason) = missing_project_root_fields_refusal_reason(child) {
                    return Some(reason);
                }
            }
            None
        }
        Value::Array(values) => values
            .iter()
            .find_map(missing_project_root_fields_refusal_reason),
        _ => None,
    }
}

fn missing_project_root_text_refusal_reason(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return None;
    }
    match crate::paths::project_root_status(path) {
        crate::paths::ProjectRootStatus::GitCheckout => None,
        crate::paths::ProjectRootStatus::NotCheckout => Some("non-checkout project"),
        crate::paths::ProjectRootStatus::Unreachable => Some("unreachable project"),
    }
}

fn project_root_text_refusal_reason(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if matches!(
        crate::paths::project_root_status(path),
        crate::paths::ProjectRootStatus::GitCheckout
    ) {
        return None;
    }
    if is_ephemeral_or_fixture_temp_project_root(path) {
        return Some("temporary project");
    }
    if is_temp_path_text(trimmed) && string_has_test_fixture_component(trimmed) {
        return Some("test fixture project");
    }
    None
}

fn string_has_test_fixture_component(value: &str) -> bool {
    value
        .split(['/', '\\', ':', ' ', '@', '(', ')'])
        .any(has_test_fixture_prefix)
}

fn has_test_fixture_prefix(value: &str) -> bool {
    let trimmed = value.trim();
    TEST_PROJECT_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
}

fn is_ephemeral_or_fixture_temp_project_root(path: &Path) -> bool {
    crate::paths::is_ephemeral_temp_project_root(path)
        || (is_temp_path(path) && path_has_test_fixture_component(path))
}

fn is_temp_path_text(value: &str) -> bool {
    is_temp_path(Path::new(value))
}

fn is_temp_path(path: &Path) -> bool {
    let resolved = lexical_resolve(
        &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        path,
    );
    temp_dirs()
        .into_iter()
        .any(|directory| resolved == directory || resolved.starts_with(directory))
}

fn temp_dirs() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for candidate in [
        std::env::temp_dir(),
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
        PathBuf::from("/var/tmp"),
    ] {
        let resolved = lexical_resolve(&PathBuf::from("/"), &candidate);
        if !directories.contains(&resolved) {
            directories.push(resolved.clone());
        }
        if let Ok(canonical) = std::fs::canonicalize(&resolved)
            && !directories.contains(&canonical)
        {
            directories.push(canonical);
        }
    }
    directories
}

fn lexical_resolve(base: &Path, path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                out.push(component);
            }
        }
    }
    out
}

fn header_value<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .or_else(|| headers.get(&canonical_header_name(name)))
        .map(String::as_str)
}

fn canonical_header_name(name: &str) -> String {
    name.split('-')
        .map(|part| {
            let mut chars = part.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn is_loopback_daemon_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let Some(authority) = rest.split('/').next() else {
        return false;
    };
    let Some((host, port)) = authority.rsplit_once(':') else {
        return false;
    };
    if port.parse::<u16>().is_err() {
        return false;
    }
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

#[cfg(test)]
mod tests {
    use super::{
        TEST_ISOLATION_MARKER, default_daemon_run_refusal_reason_for_exe_with_build_identity,
        is_cargo_target_aimux_binary_path, load_test_isolation_lease,
        missing_daemon_test_isolation_lease_refusal_reason_for_process,
        request_project_refusal_reason,
    };
    use crate::daemon::routing::DaemonRouteUrl;
    use crate::daemon_state::DEFAULT_DAEMON_PORT;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_project_root(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "{name}-{}-{}-{timestamp}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn mark_test_isolation(path: &Path) {
        fs::create_dir_all(path).expect("create marked project root");
        fs::write(
            path.join(TEST_ISOLATION_MARKER),
            format!(
                r#"{{"ownerPid":{},"kind":"cargo-test"}}"#,
                std::process::id()
            ),
        )
        .expect("write test isolation marker");
    }

    #[test]
    fn test_isolation_lease_parses_owner_identity() {
        let aimux_home = temp_project_root("aimux-test-lease-home");
        mark_test_isolation(&aimux_home);

        let lease = load_test_isolation_lease(&aimux_home)
            .expect("load lease")
            .expect("lease present");

        assert_eq!(lease.kind, "cargo-test");
        assert_eq!(lease.owner_pid, std::process::id() as i32);
        fs::remove_dir_all(aimux_home).expect("remove lease home");
    }

    #[test]
    fn malformed_test_isolation_lease_is_not_empty_absence() {
        let aimux_home = temp_project_root("aimux-test-lease-bad");
        fs::create_dir_all(&aimux_home).expect("create lease home");
        fs::write(
            aimux_home.join(TEST_ISOLATION_MARKER),
            r#"{"kind":"cargo-test"}"#,
        )
        .expect("write bad marker");

        let error = load_test_isolation_lease(&aimux_home).expect_err("bad marker should fail");

        assert!(
            error.contains("missing integer ownerPid"),
            "unexpected error: {error}"
        );
        fs::remove_dir_all(aimux_home).expect("remove lease home");
    }

    #[test]
    fn cargo_test_daemon_requires_valid_test_isolation_lease() {
        let aimux_home = temp_project_root("aimux-test-daemon-lease");
        fs::create_dir_all(&aimux_home).expect("create lease home");

        let missing =
            missing_daemon_test_isolation_lease_refusal_reason_for_process(&aimux_home, true)
                .expect("missing lease should refuse");
        assert!(
            missing.contains("requires test isolation lease"),
            "unexpected missing-lease reason: {missing}"
        );

        fs::write(
            aimux_home.join(TEST_ISOLATION_MARKER),
            r#"{"kind":"cargo-test"}"#,
        )
        .expect("write malformed marker");
        let malformed =
            missing_daemon_test_isolation_lease_refusal_reason_for_process(&aimux_home, true)
                .expect("malformed lease should refuse");
        assert!(
            malformed.contains("invalid test isolation lease"),
            "unexpected malformed-lease reason: {malformed}"
        );

        mark_test_isolation(&aimux_home);
        assert_eq!(
            missing_daemon_test_isolation_lease_refusal_reason_for_process(&aimux_home, true),
            None
        );

        fs::remove_dir_all(aimux_home).expect("remove lease home");
    }

    #[test]
    fn non_test_daemon_does_not_require_test_isolation_lease() {
        let aimux_home = temp_project_root("aimux-real-daemon-no-lease");
        fs::create_dir_all(&aimux_home).expect("create lease home");

        assert_eq!(
            missing_daemon_test_isolation_lease_refusal_reason_for_process(&aimux_home, false),
            None
        );

        fs::remove_dir_all(aimux_home).expect("remove lease home");
    }

    #[test]
    fn default_daemon_run_refuses_internal_cargo_builds_on_default_port() {
        assert_eq!(
            default_daemon_run_refusal_reason_for_exe_with_build_identity(
                DEFAULT_DAEMON_PORT,
                Path::new("/Users/sam/cs/aimux/native/target/debug/aimux"),
                true,
            ),
            Some("cargo target daemon on default port")
        );
        assert_eq!(
            default_daemon_run_refusal_reason_for_exe_with_build_identity(
                DEFAULT_DAEMON_PORT,
                Path::new("/tmp/aimux-cargo-target-codex-8s9so6/debug/aimux"),
                true,
            ),
            Some("cargo target daemon on default port")
        );
        assert_eq!(
            default_daemon_run_refusal_reason_for_exe_with_build_identity(
                DEFAULT_DAEMON_PORT,
                Path::new("/Users/sam/.cache/gate-probe-target/debug/aimux"),
                true,
            ),
            Some("cargo target daemon on default port")
        );
        assert_eq!(
            default_daemon_run_refusal_reason_for_exe_with_build_identity(
                DEFAULT_DAEMON_PORT,
                Path::new("/Users/sam/cs/aimux/native/target/release/aimux"),
                true,
            ),
            Some("cargo target daemon on default port")
        );
    }

    #[test]
    fn cargo_target_path_heuristic_still_recognizes_legacy_target_shapes() {
        assert!(is_cargo_target_aimux_binary_path(Path::new(
            "/Users/sam/cs/aimux/native/target/debug/aimux"
        )));
        assert!(is_cargo_target_aimux_binary_path(Path::new(
            "/tmp/aimux-cargo-target-codex-8s9so6/debug/aimux"
        )));
        assert!(is_cargo_target_aimux_binary_path(Path::new(
            "/Users/sam/cs/aimux/native/target/release/aimux"
        )));
        assert!(!is_cargo_target_aimux_binary_path(Path::new(
            "/Users/sam/.cache/gate-probe-target/debug/aimux"
        )));
    }

    #[test]
    fn default_daemon_run_allows_installed_binary_and_non_default_internal_cargo_port() {
        assert_eq!(
            default_daemon_run_refusal_reason_for_exe_with_build_identity(
                DEFAULT_DAEMON_PORT,
                Path::new("/Users/sam/.aimux/native/local-47a40168/native/darwin-arm64/aimux"),
                false,
            ),
            None
        );
        assert_eq!(
            default_daemon_run_refusal_reason_for_exe_with_build_identity(
                47_123,
                Path::new("/tmp/aimux-cargo-target-codex-8s9so6/debug/aimux"),
                true,
            ),
            None
        );
    }

    #[test]
    fn marked_temp_project_root_refuses_daemon_request() {
        let project_root = temp_project_root("aimux-agent-restore-harness");
        mark_test_isolation(&project_root);
        let body = json!({ "projectRoot": project_root.to_string_lossy() });

        assert_eq!(
            request_project_refusal_reason(&DaemonRouteUrl::parse("/projects/ensure"), Some(&body)),
            Some("temporary project")
        );

        fs::remove_dir_all(project_root).expect("remove marked project root");
    }

    #[test]
    fn unmarked_temp_project_root_name_does_not_refuse_daemon_request() {
        let project_root = temp_project_root("aimux-agent-restore-real");
        fs::create_dir_all(&project_root).expect("create unmarked project root");
        let body = json!({ "projectRoot": project_root.to_string_lossy() });

        assert_eq!(
            request_project_refusal_reason(&DaemonRouteUrl::parse("/projects/ensure"), Some(&body)),
            None
        );

        fs::remove_dir_all(project_root).expect("remove unmarked project root");
    }
}
