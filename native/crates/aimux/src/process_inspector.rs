use std::path::Path;
use std::process::Command;

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

pub fn read_process_args(pid: i32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", "args=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned()).filter(|args| !args.is_empty())
}

pub fn read_process_args_from_ps_output(stdout: &str) -> Option<String> {
    Some(stdout.trim().to_owned()).filter(|args| !args.is_empty())
}

pub fn list_process_args() -> Vec<ProcessArgsEntry> {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,args="]).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    list_process_args_from_ps_output(&text)
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

pub fn list_process_parents() -> Vec<(i32, i32)> {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,ppid="]).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<i32>().ok()?;
            let ppid = parts.next()?.parse::<i32>().ok()?;
            (pid > 0 && ppid >= 0).then_some((pid, ppid))
        })
        .collect()
}

pub fn read_process_cwd(pid: i32) -> Option<String> {
    let output = Command::new("lsof")
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
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub fn read_process_start_time(pid: i32) -> Option<String> {
    let output = Command::new("ps")
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
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

pub fn is_aimux_project_service_process(
    pid: i32,
    expected: &ProjectServiceProcessIdentity,
) -> bool {
    let Some(args) = read_process_args(pid) else {
        return false;
    };
    is_aimux_project_service_process_args(&args, read_process_cwd(pid).as_deref(), expected)
}

pub fn is_aimux_daemon_process(pid: i32) -> bool {
    read_process_args(pid).is_some_and(|args| is_aimux_daemon_process_args(&args))
}

pub fn is_native_aimux_daemon_process(pid: i32) -> bool {
    read_process_args(pid).is_some_and(|args| is_native_aimux_daemon_process_args(&args))
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
    let Some(args) = read_process_args(pid) else {
        return false;
    };
    is_native_aimux_project_service_process_args(&args, read_process_cwd(pid).as_deref(), expected)
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
