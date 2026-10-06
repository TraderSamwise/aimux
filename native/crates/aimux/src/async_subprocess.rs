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
        /// The working directory the spawn was given, and what we found when
        /// we went and looked at it.
        ///
        /// Carried because a missing working directory fails the spawn with the
        /// same `ENOENT` a missing program does, and without this the message
        /// could only ever accuse the program. That is how a deleted worktree
        /// came out as `failed to run /opt/homebrew/bin/tmux: No such file or
        /// directory` on a machine where tmux was installed and working.
        ///
        /// The verdict is taken once, where the spawn failed -- not in
        /// `Display`. Formatting must not do filesystem I/O: the same error
        /// would read differently each time it was printed, and a directory
        /// recreated in between would make the message deny a cause that was
        /// real.
        working_directory: Option<WorkingDirectory>,
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
            Self::Spawn {
                program,
                working_directory,
                source,
            } => match working_directory
                .as_ref()
                .and_then(WorkingDirectory::missing)
            {
                // Say which side is missing, and say it only when we looked.
                // `ENOENT` from a spawn means "something in this call does not
                // exist"; the program is merely the half that was named before.
                Some((path, reason)) => write!(
                    formatter,
                    "failed to run {program} in {}: that working directory is not there ({reason})",
                    path.display()
                ),
                // Say that the directory was checked and was there, so the
                // next reader does not go and check it again. `ENOENT` from a
                // spawn also covers a missing program and a missing dynamic
                // loader or interpreter, and those are what remain here.
                None => match working_directory {
                    Some(directory) if source.kind() == std::io::ErrorKind::NotFound => write!(
                        formatter,
                        "failed to run {program} (its working directory {} is there): {source}",
                        directory.path.display()
                    ),
                    _ => write!(formatter, "failed to run {program}: {source}"),
                },
            },
            Self::Timeout { program, duration } => {
                write!(formatter, "{program} timed out after {duration:?}")
            }
        }
    }
}

impl std::error::Error for AsyncCommandError {}

/// A spawn's working directory and whether it was there when the spawn failed.
#[derive(Debug)]
pub struct WorkingDirectory {
    path: PathBuf,
    /// Why the directory could not be read, when that is what went wrong.
    missing_reason: Option<String>,
}

impl WorkingDirectory {
    fn missing(&self) -> Option<(&std::path::Path, &str)> {
        self.missing_reason
            .as_deref()
            .map(|reason| (self.path.as_path(), reason))
    }
}

/// Look at the directory once, at the moment the spawn failed.
///
/// Only `ENOENT`-shaped failures are candidates. Then we go and look: if the
/// directory stats fine the program keeps the blame, because `ENOENT` from a
/// spawn also covers a missing program and a missing dynamic loader or
/// interpreter. Guessing from the errno alone would have swapped one wrong
/// accusation for another.
fn judge_working_directory(path: PathBuf, source: &std::io::Error) -> WorkingDirectory {
    let missing_reason = (source.kind() == std::io::ErrorKind::NotFound)
        .then(|| {
            std::fs::metadata(&path)
                .err()
                // Both gates are not-found: the spawn has to have failed the
                // way a missing path fails, AND the directory has to be the
                // path that is missing. Defensive rather than demonstrated -- a
                // `chdir` that succeeded leaves little room for the stat to then
                // fail some other way -- but without it the rule this function
                // states is not the rule it applies, and "not there (Permission
                // denied)" should be unreachable by construction, not by luck.
                .filter(|error| error.kind() == std::io::ErrorKind::NotFound)
                .map(|error| error.to_string())
        })
        .flatten();
    WorkingDirectory {
        path,
        missing_reason,
    }
}

fn spawn_error(
    program: String,
    current_dir: Option<PathBuf>,
    source: std::io::Error,
) -> AsyncCommandError {
    AsyncCommandError::Spawn {
        program,
        working_directory: current_dir.map(|path| judge_working_directory(path, &source)),
        source,
    }
}

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

    /// Run to completion with no deadline.
    ///
    /// For a command whose whole job is to block until the user is done with
    /// it — a tmux attach, a `switch-client` that hands the terminal over. The
    /// 30s default is right for a query and catastrophic here: it ends the
    /// session out from under whoever is looking at it.
    pub fn status_unbounded(
        &mut self,
        name: impl Into<String>,
    ) -> Result<ExitStatus, AsyncCommandError> {
        // aimux-async-seam: permanent - interactive foreground bridge; the child owns the terminal until the user leaves
        block_on_named(name, run_status_unbounded(self))
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

    /// The two things an error needs, read before the command is consumed.
    fn failure_context(&self) -> (String, Option<PathBuf>) {
        (self.program_display(), self.current_dir.clone())
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
    let (program, current_dir) = command.failure_context();
    let mut command = command.build_tokio_command();
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(source)) => Err(spawn_error(program, current_dir, source)),
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
    let (program, current_dir) = command.failure_context();
    let mut command = command.build_tokio_command();
    match tokio::time::timeout(timeout, command.status()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(source)) => Err(spawn_error(program, current_dir, source)),
        Err(_) => Err(AsyncCommandError::Timeout {
            program,
            duration: timeout,
        }),
    }
}

async fn run_status_unbounded(command: &mut AsyncCommand) -> Result<ExitStatus, AsyncCommandError> {
    let (program, current_dir) = command.failure_context();
    let mut command = command.build_tokio_command();
    command
        .status()
        .await
        .map_err(|source| spawn_error(program, current_dir, source))
}

async fn run_spawn_detached(command: &mut AsyncCommand) -> Result<u32, AsyncCommandError> {
    let (program, current_dir) = command.failure_context();
    command.detached();
    let mut command = command.build_tokio_command();
    command
        .spawn()
        .map_err(|source| spawn_error(program.clone(), current_dir.clone(), source))
        .and_then(|child| {
            child.id().ok_or_else(|| {
                spawn_error(
                    program,
                    current_dir,
                    std::io::Error::other("spawned child has no process id"),
                )
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

    /// A spawn into a directory that is gone names the DIRECTORY.
    ///
    /// This is the bug. A deleted agent worktree made `create_window` fail with
    /// `failed to run /opt/homebrew/bin/tmux: No such file or directory` on a
    /// machine where tmux was installed and working, because a missing working
    /// directory fails a spawn with the same `ENOENT` a missing program does
    /// and only the program was ever named.
    #[test]
    fn a_missing_working_directory_is_named_instead_of_the_program() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let missing =
            std::env::temp_dir().join(format!("aimux-missing-cwd-{}-spawn", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        let mut command = AsyncCommand::new("/bin/sh");
        command.args(["-c", "true"]).current_dir(&missing);

        let error = command.output().expect_err("spawn should fail");
        let message = error.to_string();
        assert!(
            message.contains(&missing.display().to_string()),
            "the directory that is missing has to be named: {message}"
        );
        assert!(
            message.contains("working directory is not there"),
            "and named as the working directory: {message}"
        );
    }

    /// A missing PROGRAM is still the program's fault.
    ///
    /// The inverse, and the reason the check stats the directory rather than
    /// reading the errno: `ENOENT` alone cannot tell the two apart, so a fix
    /// that blamed the directory whenever one was set would have swapped one
    /// wrong accusation for another.
    #[test]
    fn a_missing_program_is_still_the_program_even_with_a_working_directory() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let present = std::env::temp_dir();
        let mut command = AsyncCommand::new("/definitely/not/aimux");
        command.current_dir(&present);

        let message = command.output().expect_err("spawn should fail").to_string();
        assert!(
            message.contains("/definitely/not/aimux"),
            "the program has to be named: {message}"
        );
        assert!(
            !message.contains("working directory is not there"),
            "a directory that exists must not be blamed: {message}"
        );
        assert!(
            message.contains("is there"),
            "and the message should say the directory was checked: {message}"
        );
    }

    /// A working directory we could not READ is not one we know is gone.
    ///
    /// The inverse of the test above, and the case a first version got wrong:
    /// the directory was blamed whenever the spawn said not-found and the stat
    /// said anything at all, so `EACCES` or `ENOTDIR` printed "that working
    /// directory is not there (Permission denied)".
    #[test]
    fn a_working_directory_we_cannot_read_is_not_declared_missing() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let root =
            std::env::temp_dir().join(format!("aimux-cwd-unreadable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("scratch");
        let not_a_directory = root.join("file");
        std::fs::write(&not_a_directory, b"x").expect("write");
        // `ENOTDIR` rather than a mode-0 parent: root stats straight through
        // permissions, so that form of the test would hold for the wrong reason
        // wherever the suite runs as root.
        let cwd = not_a_directory.join("child");
        let probe = std::fs::metadata(&cwd).expect_err("the stat has to fail");
        assert_ne!(probe.kind(), std::io::ErrorKind::NotFound, "{probe}");

        let mut command = AsyncCommand::new("/definitely/not/aimux");
        command.current_dir(&cwd);
        let message = command.output().expect_err("spawn should fail").to_string();

        assert!(
            !message.contains("working directory is not there"),
            "a directory we could not read must not be reported as deleted: {message}"
        );
        assert!(
            message.contains("/definitely/not/aimux"),
            "and the program stays named: {message}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// With no working directory set, the message is unchanged.
    #[test]
    fn a_spawn_with_no_working_directory_reads_as_before() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let mut command = AsyncCommand::new("/definitely/not/aimux");
        let message = command.output().expect_err("spawn should fail").to_string();
        assert_eq!(
            message,
            "failed to run /definitely/not/aimux: No such file or directory (os error 2)"
        );
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

        terminate_child_and_wait(pid);
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

    fn terminate_child_and_wait(pid: i32) {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut status = 0;
            let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if waited == pid {
                return;
            }
            if waited == -1 && !pid_alive(pid) {
                return;
            }
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
