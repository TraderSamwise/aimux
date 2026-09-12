use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::{ExitStatus, Output, Stdio};
use std::time::Duration;

use tokio::process::Command;

use crate::async_runtime::{block_on_named, scoped_task_name};

const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum AsyncCommandError {
    Spawn {
        program: String,
        source: std::io::Error,
    },
    Timeout {
        program: String,
        duration: Duration,
    },
}

impl std::fmt::Display for AsyncCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn { program, source } => {
                write!(formatter, "failed to run {program}: {source}")
            }
            Self::Timeout { program, duration } => {
                write!(formatter, "{program} timed out after {duration:?}")
            }
        }
    }
}

impl std::error::Error for AsyncCommandError {}

pub struct AsyncCommand {
    program: OsString,
    args: Vec<OsString>,
    current_dir: Option<PathBuf>,
    envs: Vec<(OsString, OsString)>,
    env_remove: Vec<OsString>,
    stdin: Option<Stdio>,
    stdout: Option<Stdio>,
    stderr: Option<Stdio>,
    kill_on_drop: bool,
    setsid: bool,
}

impl AsyncCommand {
    pub fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            program: program.as_ref().to_owned(),
            args: Vec::new(),
            current_dir: None,
            envs: Vec::new(),
            env_remove: Vec::new(),
            stdin: None,
            stdout: None,
            stderr: None,
            kill_on_drop: true,
            setsid: false,
        }
    }

    pub fn arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self {
        self.args.push(arg.as_ref().to_owned());
        self
    }

    pub fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(args.into_iter().map(|arg| arg.as_ref().to_owned()));
        self
    }

    pub fn current_dir(&mut self, path: impl Into<PathBuf>) -> &mut Self {
        self.current_dir = Some(path.into());
        self
    }

    pub fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
        self.envs
            .push((key.as_ref().to_owned(), value.as_ref().to_owned()));
        self
    }

    pub fn env_remove(&mut self, key: impl AsRef<OsStr>) -> &mut Self {
        self.env_remove.push(key.as_ref().to_owned());
        self
    }

    pub fn stdin(&mut self, stdio: Stdio) -> &mut Self {
        self.stdin = Some(stdio);
        self
    }

    pub fn stdout(&mut self, stdio: Stdio) -> &mut Self {
        self.stdout = Some(stdio);
        self
    }

    pub fn stderr(&mut self, stdio: Stdio) -> &mut Self {
        self.stderr = Some(stdio);
        self
    }

    pub fn detached(&mut self) -> &mut Self {
        self.kill_on_drop = false;
        self
    }

    pub fn setsid(&mut self) -> &mut Self {
        self.setsid = true;
        self
    }

    pub fn output(&mut self) -> Result<Output, AsyncCommandError> {
        let name = command_task_name("subprocess", &self.program_display());
        self.output_timeout(name, DEFAULT_COMMAND_TIMEOUT)
    }

    pub async fn output_async(&mut self) -> Result<Output, AsyncCommandError> {
        self.output_timeout_async(DEFAULT_COMMAND_TIMEOUT).await
    }

    pub fn output_timeout(
        &mut self,
        name: impl Into<String>,
        timeout: Duration,
    ) -> Result<Output, AsyncCommandError> {
        // aimux-async-seam: permanent - bounded output bridge for sync CLI, TUI, debug, git-root, and process-inspection callers
        block_on_named(name, run_output(self, timeout))
    }

    pub async fn output_timeout_async(
        &mut self,
        timeout: Duration,
    ) -> Result<Output, AsyncCommandError> {
        run_output(self, timeout).await
    }

    pub fn status(&mut self) -> Result<ExitStatus, AsyncCommandError> {
        let name = command_task_name("subprocess", &self.program_display());
        self.status_timeout(name, DEFAULT_COMMAND_TIMEOUT)
    }

    pub async fn status_async(&mut self) -> Result<ExitStatus, AsyncCommandError> {
        self.status_timeout_async(DEFAULT_COMMAND_TIMEOUT).await
    }

    pub fn status_timeout(
        &mut self,
        name: impl Into<String>,
        timeout: Duration,
    ) -> Result<ExitStatus, AsyncCommandError> {
        // aimux-async-seam: permanent - bounded status bridge for sync CLI, readiness, hyperlink, cleanup, and runtime-adapter callers
        block_on_named(name, run_status(self, timeout))
    }

    pub async fn status_timeout_async(
        &mut self,
        timeout: Duration,
    ) -> Result<ExitStatus, AsyncCommandError> {
        run_status(self, timeout).await
    }

    pub fn spawn_detached(&mut self, name: impl Into<String>) -> Result<u32, AsyncCommandError> {
        // aimux-async-seam: permanent - detached launch bridge for sync long-lived process launchers; helper disables kill_on_drop
        block_on_named(name, run_spawn_detached(self))
    }

    pub async fn spawn_detached_async(&mut self) -> Result<u32, AsyncCommandError> {
        run_spawn_detached(self).await
    }

    fn program_display(&self) -> String {
        self.program.to_string_lossy().into_owned()
    }

    fn build_tokio_command(&mut self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        if let Some(current_dir) = self.current_dir.as_ref() {
            command.current_dir(current_dir);
        }
        for (key, value) in &self.envs {
            command.env(key, value);
        }
        for key in &self.env_remove {
            command.env_remove(key);
        }
        if let Some(stdin) = self.stdin.take() {
            command.stdin(stdin);
        }
        if let Some(stdout) = self.stdout.take() {
            command.stdout(stdout);
        }
        if let Some(stderr) = self.stderr.take() {
            command.stderr(stderr);
        }
        command.kill_on_drop(self.kill_on_drop);
        #[cfg(unix)]
        if self.setsid {
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        command
    }
}

async fn run_output(
    command: &mut AsyncCommand,
    timeout: Duration,
) -> Result<Output, AsyncCommandError> {
    let program = command.program_display();
    let mut command = command.build_tokio_command();
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(source)) => Err(AsyncCommandError::Spawn { program, source }),
        Err(_) => Err(AsyncCommandError::Timeout {
            program,
            duration: timeout,
        }),
    }
}

async fn run_status(
    command: &mut AsyncCommand,
    timeout: Duration,
) -> Result<ExitStatus, AsyncCommandError> {
    let program = command.program_display();
    let mut command = command.build_tokio_command();
    match tokio::time::timeout(timeout, command.status()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(source)) => Err(AsyncCommandError::Spawn { program, source }),
        Err(_) => Err(AsyncCommandError::Timeout {
            program,
            duration: timeout,
        }),
    }
}

async fn run_spawn_detached(command: &mut AsyncCommand) -> Result<u32, AsyncCommandError> {
    let program = command.program_display();
    command.detached();
    let mut command = command.build_tokio_command();
    command
        .spawn()
        .map_err(|source| AsyncCommandError::Spawn {
            program: program.clone(),
            source,
        })
        .and_then(|child| {
            child.id().ok_or_else(|| AsyncCommandError::Spawn {
                program,
                source: std::io::Error::other("spawned child has no process id"),
            })
        })
}

pub fn command_task_name(component: &str, program: &str) -> String {
    scoped_task_name(component, "subprocess", program)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::process::ExitStatusExt;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn timed_out_command_is_killed() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let root =
            std::env::temp_dir().join(format!("aimux-async-subprocess-{}", std::process::id()));
        fs::create_dir_all(&root).expect("temp dir");
        let pid_path = root.join("pid");

        let started = Instant::now();
        let mut command = AsyncCommand::new("/bin/sh");
        command.args([
            "-c",
            &format!(
                "echo $$ > {}; while :; do sleep 1; done",
                pid_path.display()
            ),
        ]);
        let error = command
            .output_timeout(
                command_task_name("async-subprocess-test", "sleep"),
                Duration::from_millis(100),
            )
            .expect_err("command should time out");
        assert!(matches!(error, AsyncCommandError::Timeout { .. }));
        assert!(started.elapsed() < Duration::from_secs(2));

        let pid = wait_for_pid_file(&pid_path);
        wait_until_not_alive(pid);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn non_zero_status_preserves_stderr() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let mut command = AsyncCommand::new("/bin/sh");
        command.args(["-c", "printf 'bad thing\\n' >&2; exit 7"]);
        let output = command.output().expect("command should run");
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(String::from_utf8_lossy(&output.stderr), "bad thing\n");
    }

    #[test]
    fn spawn_error_is_distinct_from_timeout() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let mut command = AsyncCommand::new("/definitely/not/aimux");
        let error = command
            .output_timeout(
                command_task_name("async-subprocess-test", "missing"),
                Duration::from_secs(5),
            )
            .expect_err("spawn should fail");
        assert!(matches!(error, AsyncCommandError::Spawn { .. }));
    }

    #[test]
    fn sync_subprocess_call_runs_from_blocking_pool_route() {
        let route_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_io()
            .enable_time()
            .build()
            .expect("route runtime");
        let handle = route_runtime.spawn(async {
            crate::async_runtime::spawn_blocking_named(
                command_task_name("async-subprocess-test", "blocking-route"),
                || {
                    let mut command = AsyncCommand::new("/bin/sh");
                    command.args(["-c", "printf route-ok"]);
                    command.output().expect("subprocess should run")
                },
            )
            .await
            .expect("blocking route should finish")
        });
        let output = route_runtime
            // aimux-async-seam: test - async_subprocess unit test awaits spawned runtime handle
            .block_on(handle)
            .expect("route worker should not panic");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "route-ok");
    }

    #[test]
    fn shared_runtime_blocking_subprocess_call_still_runs() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let handle = crate::async_runtime::spawn_blocking_named(
            command_task_name("async-subprocess-test", "shared-blocking-route"),
            || {
                let mut command = AsyncCommand::new("/bin/sh");
                command.args(["-c", "printf shared-ok"]);
                command.output().expect("subprocess should run")
            },
        );
        let output = crate::async_runtime::process_runtime()
            // aimux-async-seam: test - async_subprocess unit test awaits spawned runtime handle
            .block_on(handle)
            .expect("blocking route should not panic");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "shared-ok");
    }

    #[test]
    fn detached_spawn_survives_helper_returning() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let root =
            std::env::temp_dir().join(format!("aimux-async-detached-{}", std::process::id()));
        fs::create_dir_all(&root).expect("temp dir");
        let pid_path = root.join("pid");

        let mut command = AsyncCommand::new("/bin/sh");
        command.args([
            "-c",
            &format!(
                "echo $$ > {}; while :; do sleep 1; done",
                pid_path.display()
            ),
        ]);
        let child_id = command
            .spawn_detached(command_task_name("async-subprocess-test", "detached"))
            .expect("detached child should spawn");
        let pid = wait_for_pid_file(&pid_path);
        assert_eq!(pid, child_id as i32);
        assert!(pid_alive(pid), "detached child died when helper returned");

        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        wait_until_not_alive(pid);
        let _ = fs::remove_dir_all(root);
    }

    fn wait_for_pid_file(path: &std::path::Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(text) = fs::read_to_string(path)
                && let Ok(pid) = text.trim().parse::<i32>()
            {
                return pid;
            }
            assert!(Instant::now() < deadline, "pid file was not written");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_until_not_alive(pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while pid_alive(pid) {
            assert!(Instant::now() < deadline, "process {pid} survived timeout");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn pid_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn exit_status_ext_available_for_signal_mutation_tests() {
        let status = ExitStatus::from_raw(9);
        assert_ne!(status.code(), Some(0));
    }
}
