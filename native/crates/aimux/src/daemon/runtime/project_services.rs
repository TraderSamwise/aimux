use crate::cli_launcher::{AimuxCliLaunchOptions, get_aimux_project_service_launch_command};
use crate::daemon_state::{ProjectServiceState, is_pid_alive};
use crate::process_inspector::{ProjectServiceProcessIdentity, is_aimux_project_service_process};
use std::path::Path;
use std::process::{Command, Stdio};

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

impl ProjectServiceLauncher for SystemProjectServiceLauncher {
    fn launch(
        &self,
        project_id: &str,
        project_root: &Path,
        _project_state_dir: &Path,
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
        let mut command = Command::new(&launch.command);
        command
            .args(&launch.args)
            .env("AIMUX_NATIVE_BIN", &launch.command)
            .current_dir(project_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let child = command.spawn().map_err(|error| error.to_string())?;
        i32::try_from(child.id()).map_err(|_| "project service pid overflow".to_owned())
    }

    fn terminate(&self, service: &ProjectServiceState, force: bool) -> Result<(), String> {
        if !is_pid_alive(service.pid) {
            return Ok(());
        }
        let expected = ProjectServiceProcessIdentity {
            project_id: Some(service.project_id.clone()),
            project_root: Some(service.project_root.clone()),
        };
        if !is_aimux_project_service_process(service.pid, &expected) {
            return Err(format!(
                "refusing to signal unverified aimux project service pid={}",
                service.pid
            ));
        }
        signal_pid(
            service.pid,
            if force { libc::SIGKILL } else { libc::SIGTERM },
        )
        .map_err(|error| error.to_string())
    }
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
