use crate::async_subprocess::{AsyncCommand, command_task_name};
use crate::cli_launcher::{AimuxCliLaunchOptions, get_aimux_project_service_launch_command};
use crate::daemon_state::{ProjectServiceState, try_is_pid_alive};
use crate::process_inspector::{ProjectServiceProcessIdentity, is_aimux_project_service_process};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;
use std::process::Stdio;

pub const PROJECT_SERVICE_STARTUP_TIMEOUT_MS: u64 = 10_000;

pub trait ProjectServiceLauncher: Send + Sync {
    fn launch(
        &self,
        project_id: &str,
        project_root: &Path,
        project_state_dir: &Path,
    ) -> Result<i32, String>;
    fn terminate(&self, service: &ProjectServiceState, force: bool) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct SystemProjectServiceLauncher;

pub fn project_service_stdio_log_path(project_state_dir: &Path) -> std::path::PathBuf {
    project_state_dir
        .join("logs")
        .join("project-service-stdio.log")
}

impl ProjectServiceLauncher for SystemProjectServiceLauncher {
    fn launch(
        &self,
        project_id: &str,
        project_root: &Path,
        project_state_dir: &Path,
    ) -> Result<i32, String> {
        let project_root_text = project_root.to_string_lossy().into_owned();
        let current_exe = std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .ok();
        let mut env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        if let Some(current_exe) = current_exe.as_deref() {
            env.insert("AIMUX_NATIVE_BIN".into(), current_exe.to_owned());
        }
        let launch = get_aimux_project_service_launch_command(
            project_id,
            &project_root_text,
            AimuxCliLaunchOptions {
                env,
                current_argv_entry: current_exe.clone().or_else(|| std::env::args().next()),
                current_entry_path: current_exe.clone(),
                process_exec_path: current_exe,
                home_dir: None,
            },
        );
        let mut command = AsyncCommand::new(&launch.command);
        command
            .args(&launch.args)
            .env("AIMUX_NATIVE_BIN", &launch.command)
            .current_dir(project_root)
            .stdin(Stdio::null());
        let (stdout, stderr) = project_service_child_stdio(project_state_dir).map_err(|error| {
            format!("failed to open project service stdout/stderr log: {error}")
        })?;
        command
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        command.setsid();
        let child_id = command
            .spawn_detached(command_task_name("project-service", &launch.command))
            .map_err(|error| error.to_string())?;
        i32::try_from(child_id).map_err(|_| "project service pid overflow".to_owned())
    }

    fn terminate(&self, service: &ProjectServiceState, force: bool) -> Result<(), String> {
        let expected = ProjectServiceProcessIdentity {
            project_id: Some(service.project_id.clone()),
            project_root: Some(service.project_root.clone()),
        };
        if !verify_project_service_pid_for_termination(
            service.pid,
            &expected,
            try_is_pid_alive,
            is_aimux_project_service_process,
        )? {
            return Ok(());
        }
        signal_pid(
            service.pid,
            if force { libc::SIGKILL } else { libc::SIGTERM },
        )
        .map_err(|error| error.to_string())
    }
}

fn verify_project_service_pid_for_termination(
    pid: i32,
    expected: &ProjectServiceProcessIdentity,
    is_alive: impl Fn(i32) -> Result<bool, String>,
    mut is_project_service_process: impl FnMut(i32, &ProjectServiceProcessIdentity) -> bool,
) -> Result<bool, String> {
    match is_alive(pid) {
        Ok(false) => Ok(false),
        Ok(true) => {
            if is_project_service_process(pid, expected) {
                Ok(true)
            } else {
                Err(format!(
                    "refusing to signal unverified aimux project service pid={pid}"
                ))
            }
        }
        Err(error) => Err(format!(
            "failed to verify aimux project service pid={pid} before termination: {error}"
        )),
    }
}

fn project_service_child_stdio(project_state_dir: &Path) -> io::Result<(File, File)> {
    let path = project_service_stdio_log_path(project_state_dir);
    open_append_log_pair(&path)
        .map_err(|error| io::Error::new(error.kind(), format!("{} ({})", error, path.display())))
}

fn open_append_log_pair(path: &Path) -> io::Result<(File, File)> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let stdout = OpenOptions::new().create(true).append(true).open(path)?;
    let stderr = stdout.try_clone()?;
    Ok((stdout, stderr))
}

#[cfg(unix)]
fn signal_pid(pid: i32, signal: i32) -> std::io::Result<()> {
    unsafe {
        if libc::kill(pid, signal) == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

#[cfg(not(unix))]
fn signal_pid(_pid: i32, _signal: i32) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ProjectServiceProcessIdentity, project_service_child_stdio,
        verify_project_service_pid_for_termination,
    };
    use std::io::Write;

    fn expected_identity() -> ProjectServiceProcessIdentity {
        ProjectServiceProcessIdentity {
            project_id: Some("project".to_owned()),
            project_root: Some("/repo".to_owned()),
        }
    }

    #[test]
    fn termination_pid_probe_failure_is_not_reported_as_dead() {
        let error = verify_project_service_pid_for_termination(
            123,
            &expected_identity(),
            |_| Err("ps unavailable".to_owned()),
            |_, _| true,
        )
        .expect_err("probe failure should block termination");

        assert!(
            error.contains("failed to verify aimux project service pid=123 before termination"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn dead_pid_skips_termination_without_identity_probe() {
        let mut identity_probe_called = false;
        let live = verify_project_service_pid_for_termination(
            123,
            &expected_identity(),
            |_| Ok(false),
            |_, _| {
                identity_probe_called = true;
                true
            },
        )
        .expect("dead pid");

        assert!(!live);
        assert!(!identity_probe_called);
    }

    #[test]
    fn project_service_child_stdio_captures_stdout_and_stderr() {
        let root = std::env::temp_dir().join(format!(
            "aimux-project-service-stdio-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let state_dir = root.join("state");

        let (mut stdout, mut stderr) = project_service_child_stdio(&state_dir).expect("stdio logs");
        writeln!(stdout, "startup stdout").expect("write stdout");
        writeln!(stderr, "startup stderr").expect("write stderr");
        drop(stdout);
        drop(stderr);

        let log = std::fs::read_to_string(state_dir.join("logs/project-service-stdio.log"))
            .expect("stdio log");
        assert!(log.contains("startup stdout"));
        assert!(log.contains("startup stderr"));
        let _ = std::fs::remove_dir_all(root);
    }
}
