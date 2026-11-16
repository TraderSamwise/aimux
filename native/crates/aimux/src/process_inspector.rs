use crate::async_subprocess::AsyncCommand;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessArgsEntry {
    pub pid: i32,
    pub args: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectServiceProcessIdentity {
    pub project_id: Option<String>,
    pub project_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessFingerprint {
    pub pid: i32,
    pub args: String,
    pub started_at: String,
}

fn trim_shell_quotes(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

pub fn command_arg_value_matches(args: &str, flag: &str, expected: &str) -> bool {
    let mut rest = args;
    while let Some(index) = find_flag(rest, flag) {
        let after_flag = &rest[index + flag.len()..];
        let Some(after_space) = after_flag.strip_prefix(char::is_whitespace) else {
            rest = after_flag;
            continue;
        };
        let end = after_space.find(" --").unwrap_or(after_space.len());
        if trim_shell_quotes(after_space[..end].trim()) == expected {
            return true;
        }
        rest = &after_space[end..];
    }
    false
}

pub fn process_env_value(args: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    args.split_whitespace().find_map(|token| {
        token
            .strip_prefix(&prefix)
            .map(trim_shell_quotes)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

pub fn process_ancestry_contains_executable(
    pid: i32,
    executable_name: &str,
    process_args: &[ProcessArgsEntry],
    process_parents: &[(i32, i32)],
) -> bool {
    if pid <= 0 || executable_name.is_empty() {
        return false;
    }
    let args_by_pid = process_args
        .iter()
        .map(|entry| (entry.pid, entry.args.as_str()))
        .collect::<BTreeMap<_, _>>();
    let parent_by_pid = process_parents.iter().copied().collect::<BTreeMap<_, _>>();
    let mut seen = BTreeSet::new();
    let mut current = pid;
    while current > 0 && seen.insert(current) {
        if args_by_pid
            .get(&current)
            .and_then(|args| process_executable_name(args))
            .is_some_and(|name| name == executable_name)
        {
            return true;
        }
        let Some(parent) = parent_by_pid.get(&current).copied() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    false
}

pub fn is_process_descended_from_executable(pid: i32, executable_name: &str) -> bool {
    process_ancestry_contains_executable(
        pid,
        executable_name,
        &list_process_args(),
        &list_process_parents(),
    )
}

fn process_executable_name(args: &str) -> Option<&str> {
    let first = args.split_whitespace().next()?;
    Path::new(trim_shell_quotes(first))
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
}

fn find_flag(input: &str, flag: &str) -> Option<usize> {
    let mut offset = 0;
    while let Some(index) = input[offset..].find(flag) {
        let absolute = offset + index;
        let starts_at_boundary = absolute == 0
            || input[..absolute]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        if starts_at_boundary {
            return Some(absolute);
        }
        offset = absolute + flag.len();
    }
    None
}

/// Program name to the PATH it was resolved under and the answer, if any.
///
/// Named because the inline type was complex enough that clippy asked, and a
/// name says what the pair means: the PATH is stored so a changed PATH
/// re-resolves rather than serving a stale absolute path.
type ResolvedPrograms = HashMap<&'static str, (Option<OsString>, Option<Arc<OsString>>)>;

/// `ps`, resolved once per process rather than spawned by name.
///
/// `read_process_args` alone has eleven callers and runs on every
/// project-service liveness check, so a bare `"ps"` made the OS walk PATH on
/// every one of them. AGENTS.md's Subprocess Churn section opens with exactly
/// this: "A bare program name makes the OS walk PATH on every call; on a
/// developer Mac that is routinely a dozen failed execs before the hit."
///
/// Returns `None` rather than an error because every caller here already
/// treats "could not ask" as "no answer" -- the liveness filter fails closed
/// on it, which is the safe direction. A memo that cannot resolve simply
/// re-resolves next call.
fn ps_program() -> Option<Arc<OsString>> {
    resolved_program("ps")
}

/// `ps` for the `try_*` variants, which report a failed resolve rather than
/// folding it into "no answer".
///
/// A named helper so the message lives in one place and the call stays on one
/// line -- the spawn-site audit matches a single-line marker, and an inline
/// `ok_or_else` was long enough that rustfmt wrapped it and the gate could no
/// longer see the site at all.
fn ps_program_or_error() -> Result<Arc<OsString>, String> {
    ps_program().ok_or_else(|| "could not resolve ps on PATH".to_owned())
}

/// `lsof`, resolved once per process. Reached from `read_process_cwd`, which
/// the liveness filter calls on its second attempt when the args alone do not
/// match.
fn lsof_program() -> Option<Arc<OsString>> {
    resolved_program("lsof")
}

/// The shared memo, keyed on PATH so a changed PATH re-resolves.
///
/// Mirrors `git_delivery::git_program`, including recovering a poisoned guard:
/// this is a memo, and refusing to resolve because another thread panicked
/// elsewhere would be worse than reading it again.
fn resolved_program(name: &'static str) -> Option<Arc<OsString>> {
    static PROGRAMS: OnceLock<Mutex<ResolvedPrograms>> = OnceLock::new();
    let path_env = std::env::var_os("PATH");
    let cache = PROGRAMS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut slot = cache.lock().unwrap_or_else(|error| error.into_inner());
    if let Some((cached_path, resolved)) = slot.get(name)
        && *cached_path == path_env
    {
        return resolved.clone();
    }
    let resolved = crate::program_lookup::resolve_program_from_path(name, path_env.clone(), None)
        .ok()
        .map(Arc::new);
    slot.insert(name, (path_env, resolved.clone()));
    resolved
}

pub fn read_process_args(pid: i32) -> Option<String> {
    let output = AsyncCommand::new(ps_program()?.as_os_str())
        .args(["-o", "args=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned()).filter(|args| !args.is_empty())
}

pub fn read_process_args_with_env(pid: i32) -> Option<String> {
    try_read_process_args_with_env(pid).ok().flatten()
}

/// The same read, with a failed `ps` kept as an error rather than an absence.
/// One spawn site: everything that needs a process environment comes through
/// here, so the subprocess gate can still count them.
pub fn try_read_process_args_with_env(pid: i32) -> Result<Option<String>, String> {
    let output = AsyncCommand::new(ps_program_or_error()?.as_os_str())
        .args(["eww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .map_err(|error| format!("failed to run ps environment inventory: {error}"))?;
    // A process that exited between listing it and inspecting it is gone, not
    // an inventory failure.
    if !output.status.success() {
        return Ok(None);
    }
    Ok(read_process_args_from_ps_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

pub fn read_process_args_from_ps_output(stdout: &str) -> Option<String> {
    Some(stdout.trim().to_owned()).filter(|args| !args.is_empty())
}

pub fn list_process_args() -> Vec<ProcessArgsEntry> {
    try_list_process_args().unwrap_or_default()
}

pub fn try_list_process_args() -> Result<Vec<ProcessArgsEntry>, String> {
    let output = AsyncCommand::new(ps_program_or_error()?.as_os_str())
        .args(["-axo", "pid=,args="])
        .output()
        .map_err(|error| format!("failed to run ps process inventory: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let detail = if stderr.is_empty() {
            output.status.to_string()
        } else {
            format!("{}: {stderr}", output.status)
        };
        return Err(format!("ps process inventory failed: {detail}"));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(list_process_args_from_ps_output(&text))
}

pub fn list_process_args_from_ps_output(stdout: &str) -> Vec<ProcessArgsEntry> {
    stdout.lines().filter_map(parse_process_args_line).collect()
}

fn parse_process_args_line(line: &str) -> Option<ProcessArgsEntry> {
    let trimmed = line.trim_start();
    let split = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let pid = trimmed[..split].parse::<i32>().ok()?;
    let args = trimmed[split..].trim().to_owned();
    (pid > 0 && !args.is_empty()).then_some(ProcessArgsEntry { pid, args })
}

/// The pid-to-parent map, with a failed `ps` kept as an error.
///
/// `list_process_parents` returns an empty list when `ps` fails, which is right
/// for a best-effort reaper that simply skips a pass. A diagnostic that answers
/// "are there duplicates?" needs the difference: an empty map would read as
/// "nothing wrong".
pub fn try_list_process_parents() -> Result<BTreeMap<i32, i32>, String> {
    let output = AsyncCommand::new(ps_program_or_error()?.as_os_str())
        .args(["-axo", "pid=,ppid="])
        .output()
        .map_err(|error| format!("failed to run ps: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if stderr.is_empty() {
            format!("ps exited with {}", output.status)
        } else {
            format!("ps failed: {stderr}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<i32>().ok()?;
            let ppid = parts.next()?.parse::<i32>().ok()?;
            (pid > 0 && ppid >= 0).then_some((pid, ppid))
        })
        .collect())
}

/// Best-effort parents for the reaper, which simply skips a pass when `ps`
/// fails. One spawn site: this delegates rather than running its own `ps`.
pub fn list_process_parents() -> Vec<(i32, i32)> {
    try_list_process_parents()
        .map(|parents| parents.into_iter().collect())
        .unwrap_or_default()
}

pub fn read_process_cwd(pid: i32) -> Option<String> {
    let output = AsyncCommand::new(lsof_program()?.as_os_str())
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    read_process_cwd_from_lsof_output(&text)
}

pub fn read_process_cwd_from_lsof_output(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix('n').map(str::trim))
        .filter(|cwd| !cwd.is_empty())
        .map(str::to_owned)
}

pub fn is_exited_process_state(state: &str) -> bool {
    state.trim().starts_with('Z')
}

fn read_process_state(pid: i32) -> Option<String> {
    let output = AsyncCommand::new(ps_program()?.as_os_str())
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub fn read_process_start_time(pid: i32) -> Option<String> {
    let output = AsyncCommand::new(ps_program()?.as_os_str())
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|started_at| !started_at.is_empty())
}

pub fn read_process_fingerprint(pid: i32) -> Option<ProcessFingerprint> {
    Some(ProcessFingerprint {
        pid,
        args: read_process_args(pid)?,
        started_at: read_process_start_time(pid)?,
    })
}

pub fn process_fingerprint_matches(expected: &ProcessFingerprint) -> bool {
    read_process_fingerprint(expected.pid).is_some_and(|actual| actual == *expected)
}

pub fn is_pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    if !pid_signal_zero(pid) {
        return false;
    }
    if cfg!(windows) {
        return true;
    }
    read_process_state(pid).is_none_or(|state| !is_exited_process_state(&state))
}

#[cfg(unix)]
fn pid_signal_zero(pid: i32) -> bool {
    unsafe {
        if libc::kill(pid, 0) == 0 {
            return true;
        }
        errno() == libc::EPERM
    }
}

#[cfg(target_os = "macos")]
fn errno() -> i32 {
    unsafe { *libc::__error() }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn errno() -> i32 {
    unsafe { *libc::__errno_location() }
}

#[cfg(not(unix))]
fn pid_signal_zero(pid: i32) -> bool {
    AsyncCommand::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

pub fn is_aimux_project_service_process(
    pid: i32,
    expected: &ProjectServiceProcessIdentity,
) -> bool {
    process_args_match_with_optional_cwd(pid, read_process_args, read_process_cwd, |args, cwd| {
        is_aimux_project_service_process_args(args, cwd, expected)
    })
}

pub fn is_aimux_daemon_process(pid: i32) -> bool {
    read_process_args(pid).is_some_and(|args| is_aimux_daemon_process_args(&args))
}

pub fn is_native_aimux_daemon_process(pid: i32) -> bool {
    read_process_args(pid).is_some_and(|args| is_native_aimux_daemon_process_args(&args))
}

/// The `AIMUX_HOME` a running process was started with, which is the only thing
/// that says whether it belongs to this control plane. Two aimux daemons under
/// different homes are separate installations that know nothing about each
/// other, so counting them together reported a developer's own daemon as a leak
/// inside every isolated test home on the machine.
///
/// `Ok(None)` means the process is gone, or declared no home. An unreadable
/// environment is an error and never an absent one: "not ours" and "could not
/// ask" have to take different paths at the call site.
pub fn try_read_process_aimux_home(pid: i32) -> Result<Option<String>, String> {
    if pid <= 0 {
        return Ok(None);
    }
    Ok(
        try_read_process_args_with_env(pid)?
            .and_then(|args| process_env_value(&args, "AIMUX_HOME")),
    )
}

pub fn is_aimux_daemon_process_args(args: &str) -> bool {
    let executable_matches = args
        .split_whitespace()
        .map(trim_shell_quotes)
        .any(is_aimux_executable_token);
    executable_matches && has_arg_sequence(args, &["daemon", "run"])
}

pub fn is_native_aimux_daemon_process_args(args: &str) -> bool {
    first_arg_token(args).is_some_and(is_native_aimux_executable_token)
        && has_arg_sequence(args, &["daemon", "run"])
}

fn is_aimux_executable_token(token: &str) -> bool {
    let name = Path::new(token)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(token);
    name == "aimux" || name.starts_with("launcher-bin")
}

fn is_native_aimux_executable_token(token: &str) -> bool {
    let name = Path::new(token)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(token);
    name == "aimux"
}

fn first_arg_token(args: &str) -> Option<&str> {
    args.split_whitespace().map(trim_shell_quotes).next()
}

pub fn is_native_aimux_project_service_process(
    pid: i32,
    expected: &ProjectServiceProcessIdentity,
) -> bool {
    process_args_match_with_optional_cwd(pid, read_process_args, read_process_cwd, |args, cwd| {
        is_native_aimux_project_service_process_args(args, cwd, expected)
    })
}

pub fn is_current_native_aimux_project_service_process(
    pid: i32,
    expected: &ProjectServiceProcessIdentity,
    expected_binary: &Path,
) -> bool {
    process_args_match_with_optional_cwd(pid, read_process_args, read_process_cwd, |args, cwd| {
        is_current_native_aimux_project_service_process_args(args, cwd, expected, expected_binary)
    })
}

fn process_args_match_with_optional_cwd(
    pid: i32,
    read_args: impl FnOnce(i32) -> Option<String>,
    read_cwd: impl FnOnce(i32) -> Option<String>,
    matches: impl Fn(&str, Option<&str>) -> bool,
) -> bool {
    let Some(args) = read_args(pid) else {
        return false;
    };
    if matches(&args, None) {
        return true;
    }
    matches(&args, read_cwd(pid).as_deref())
}

pub fn is_aimux_project_service_process_args(
    args: &str,
    cwd: Option<&str>,
    expected: &ProjectServiceProcessIdentity,
) -> bool {
    if !args.contains("__project-service-internal") {
        return false;
    }
    if !args.contains("--project-id")
        && !args.contains("--project-root")
        && let Some(project_root) = expected.project_root.as_deref()
    {
        return cwd.is_some_and(|cwd| normalize_path(cwd) == normalize_path(project_root));
    }
    if let Some(project_id) = expected.project_id.as_deref()
        && !command_arg_value_matches(args, "--project-id", project_id)
    {
        return false;
    }
    if let Some(project_root) = expected.project_root.as_deref()
        && !command_arg_value_matches(args, "--project-root", project_root)
    {
        return false;
    }
    true
}

pub fn is_native_aimux_project_service_process_args(
    args: &str,
    cwd: Option<&str>,
    expected: &ProjectServiceProcessIdentity,
) -> bool {
    first_arg_token(args).is_some_and(is_native_aimux_executable_token)
        && is_aimux_project_service_process_args(args, cwd, expected)
}

pub fn is_current_native_aimux_project_service_process_args(
    args: &str,
    cwd: Option<&str>,
    expected: &ProjectServiceProcessIdentity,
    expected_binary: &Path,
) -> bool {
    first_arg_token(args).is_some_and(|token| {
        is_native_aimux_executable_token(token)
            && normalize_path(token) == normalize_path(&expected_binary.to_string_lossy())
    }) && is_aimux_project_service_process_args(args, cwd, expected)
}

fn has_arg_sequence(args: &str, sequence: &[&str]) -> bool {
    let tokens = args
        .split_whitespace()
        .map(trim_shell_quotes)
        .collect::<Vec<_>>();
    tokens
        .windows(sequence.len())
        .any(|window| window == sequence)
}

fn normalize_path(path: &str) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| {
            let path = Path::new(path);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| ".".into())
                    .join(path)
            }
        })
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::Path;

    #[test]
    fn project_service_process_match_skips_cwd_when_args_identify_project() {
        let cwd_calls = Cell::new(0);
        let expected = ProjectServiceProcessIdentity {
            project_id: Some("project-1".to_owned()),
            project_root: Some("/repo".to_owned()),
        };
        let args =
            "/bin/aimux __project-service-internal --project-id project-1 --project-root /repo";

        let matched = process_args_match_with_optional_cwd(
            42,
            |_| Some(args.to_owned()),
            |_| {
                cwd_calls.set(cwd_calls.get() + 1);
                Some("/wrong".to_owned())
            },
            |args, cwd| {
                is_current_native_aimux_project_service_process_args(
                    args,
                    cwd,
                    &expected,
                    Path::new("/bin/aimux"),
                )
            },
        );

        assert!(matched);
        assert_eq!(cwd_calls.get(), 0);
    }

    #[test]
    fn project_service_process_match_uses_cwd_fallback_for_old_args() {
        let cwd_calls = Cell::new(0);
        let expected = ProjectServiceProcessIdentity {
            project_id: None,
            project_root: Some("/repo".to_owned()),
        };
        let args = "/bin/aimux __project-service-internal";

        let matched = process_args_match_with_optional_cwd(
            42,
            |_| Some(args.to_owned()),
            |_| {
                cwd_calls.set(cwd_calls.get() + 1);
                Some("/repo".to_owned())
            },
            |args, cwd| is_native_aimux_project_service_process_args(args, cwd, &expected),
        );

        assert!(matched);
        assert_eq!(cwd_calls.get(), 1);
    }

    #[test]
    fn process_env_value_reads_ps_eww_env_tokens() {
        let args = "/Users/sam/.aimux/native/current/native/darwin-arm64/aimux __project-service-internal --project-root /Users/sam AIMUX_HOME=/Users/sam/.aimux PATH=/bin";

        assert_eq!(
            process_env_value(args, "AIMUX_HOME"),
            Some("/Users/sam/.aimux".to_owned())
        );
        assert_eq!(process_env_value(args, "MISSING"), None);
    }

    /// `ps` is resolved once per process, not per call.
    ///
    /// `read_process_args` alone has eleven callers and runs on every
    /// project-service liveness check. Spawned by bare name, each of those
    /// made the OS walk PATH -- the hazard AGENTS.md's Subprocess Churn
    /// section opens with. The same allocation on a second call is what
    /// "resolved once" means observably; a memo that re-resolved would hand
    /// back a different `Arc`.
    #[test]
    fn ps_is_resolved_once_per_process() {
        let Some(first) = super::ps_program() else {
            eprintln!("skipping: ps is not on PATH here, so there is nothing to memoise");
            return;
        };
        let second = super::ps_program().expect("ps resolved once already");
        assert!(
            std::sync::Arc::ptr_eq(&first, &second),
            "ps was resolved twice, so the memo is not holding and every liveness check pays a PATH walk"
        );
        assert!(
            std::path::Path::new(first.as_os_str()).is_absolute(),
            "ps resolved to {first:?}, which is not absolute, so the OS still has to search for it"
        );
    }
}
