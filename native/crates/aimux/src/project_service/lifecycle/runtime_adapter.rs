use crate::async_subprocess::AsyncCommand;
use crate::backend_session_ids::{
    BackendSessionDiscoveryOptions, codex_backend_session_ids_for_cwd,
};
use crate::paths::{is_git_project_root, project_checkout_required_message};
use crate::tmux::{
    CapturePaneOptions, TmuxRuntimeManager, TmuxTarget, clear_history_argv, kill_window_argv,
    new_window_argv, rename_window_argv, set_window_option_argv, tmux_command_from_env,
};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};

pub trait ProjectLifecycleRuntime {
    fn repair_legacy_project_session_names(&mut self, project_root: &Path) -> Result<(), String>;
    fn ensure_project_session(&mut self, project_root: &Path) -> Result<(), String>;
    fn find_main_repo(&mut self, cwd: &str) -> Result<String, String>;
    fn create_worktree(
        &mut self,
        main_repo: &str,
        name: &str,
        target_path: &str,
    ) -> Result<(), String>;
    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String>;
    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String>;
    fn set_window_option(&mut self, window_id: &str, key: &str, value: &str) -> Result<(), String>;
    fn clear_history(&mut self, window_id: &str) -> Result<(), String>;
    fn has_window(&mut self, target: &TmuxTarget) -> bool;
    fn capture_window(&mut self, target: &TmuxTarget) -> Option<String> {
        let _ = target;
        None
    }
    fn codex_backend_session_ids_for_cwd(&mut self, cwd: &str) -> Result<BTreeSet<String>, String> {
        codex_backend_session_ids_for_cwd(cwd, &BackendSessionDiscoveryOptions::default())
    }
    fn wait_for_window_after_launch(&mut self, target: &TmuxTarget, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.has_window(target) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    fn kill_window(&mut self, window_id: &str) -> Result<(), String>;
    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String>;
}

pub struct SystemProjectLifecycleRuntime;

impl ProjectLifecycleRuntime for SystemProjectLifecycleRuntime {
    fn repair_legacy_project_session_names(&mut self, project_root: &Path) -> Result<(), String> {
        TmuxRuntimeManager::new().repair_legacy_project_session_names(project_root, None);
        Ok(())
    }

    fn ensure_project_session(&mut self, project_root: &Path) -> Result<(), String> {
        TmuxRuntimeManager::new()
            .ensure_project_session(project_root, None, None)
            .map(|_| ())
    }

    fn find_main_repo(&mut self, cwd: &str) -> Result<String, String> {
        find_git_main_repo(cwd)
    }

    fn create_worktree(
        &mut self,
        main_repo: &str,
        name: &str,
        target_path: &str,
    ) -> Result<(), String> {
        create_git_worktree(main_repo, name, target_path)
    }

    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String> {
        let output = run_tmux_argv_output(
            new_window_argv(session_name, name, cwd, command, args, detached),
            format!("tmux failed to create window \"{name}\" in session {session_name}"),
        )?;
        parse_tmux_target(session_name, &output)
    }

    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        let metadata = serde_json::to_string(metadata).map_err(|error| error.to_string())?;
        self.set_window_option(window_id, "@aimux-meta", &metadata)
    }

    fn set_window_option(&mut self, window_id: &str, key: &str, value: &str) -> Result<(), String> {
        run_tmux_argv(
            set_window_option_argv(window_id, key, value),
            format!("tmux set-window-option {key} failed for {window_id}"),
        )
    }

    fn clear_history(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv(
            clear_history_argv(window_id),
            format!("tmux clear-history failed for {window_id}"),
        )
    }

    fn has_window(&mut self, target: &TmuxTarget) -> bool {
        TmuxRuntimeManager::new().has_window(target)
    }

    fn capture_window(&mut self, target: &TmuxTarget) -> Option<String> {
        TmuxRuntimeManager::new()
            .capture_target(
                target,
                CapturePaneOptions {
                    start_line: Some(-40),
                    ..CapturePaneOptions::default()
                },
            )
            .ok()
    }

    fn kill_window(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv(
            kill_window_argv(window_id),
            format!("tmux kill-window failed for {window_id}"),
        )
    }

    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String> {
        run_tmux_argv(
            rename_window_argv(window_id, name),
            format!("tmux rename-window failed for {window_id}"),
        )
    }
}

pub(super) fn remove_git_worktree_checkout(main_repo: &str, path: &str) -> Result<(), String> {
    run_git_argv(
        main_repo,
        &["worktree", "remove", path, "--force"],
        format!("git worktree remove exited for {path}"),
    )
}

pub(super) fn prune_git_worktrees(main_repo: &str) {
    let _ = run_git_argv(
        main_repo,
        &["worktree", "prune"],
        "git worktree prune failed".to_owned(),
    );
}

fn parse_tmux_target(session_name: &str, output: &str) -> Result<TmuxTarget, String> {
    let line = output.trim().lines().next().unwrap_or_default();
    let mut parts = line.split('\t');
    let window_id = parts.next().unwrap_or_default().trim();
    let window_index = parts
        .next()
        .unwrap_or_default()
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("invalid tmux new-window output: {line}"))?;
    let window_name = parts.next().unwrap_or_default().trim();
    if window_id.is_empty() || window_name.is_empty() {
        return Err(format!("invalid tmux new-window output: {line}"));
    }
    Ok(TmuxTarget {
        session_name: session_name.to_owned(),
        window_id: window_id.to_owned(),
        window_index,
        window_name: window_name.to_owned(),
        pane_dead: None,
    })
}

fn run_tmux_argv(argv: Vec<String>, fallback_error: String) -> Result<(), String> {
    run_tmux_argv_output(argv, fallback_error).map(|_| ())
}

fn run_tmux_argv_output(argv: Vec<String>, fallback_error: String) -> Result<String, String> {
    match tmux_command_from_env().args(argv).output() {
        Ok(output) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if stderr.is_empty() {
                Err(fallback_error)
            } else {
                Err(stderr)
            }
        }
        Err(error) => Err(format!("{fallback_error}: {error}")),
    }
}

fn find_git_main_repo(cwd: &str) -> Result<String, String> {
    if !is_git_project_root(cwd) {
        return Err(project_checkout_required_message(cwd));
    }
    let output = run_git_argv_output(
        cwd,
        &["worktree", "list", "--porcelain"],
        "git worktree list failed".to_owned(),
    )?;
    let first_line = output.lines().next().unwrap_or_default();
    if let Some(main_repo) = first_line.strip_prefix("worktree ") {
        return Ok(main_repo.to_owned());
    }
    run_git_argv_output(
        cwd,
        &["rev-parse", "--show-toplevel"],
        "git rev-parse --show-toplevel failed".to_owned(),
    )
    .map(|output| output.trim().to_owned())
}

fn create_git_worktree(main_repo: &str, name: &str, target_path: &str) -> Result<(), String> {
    if branch_exists_in_repo(main_repo, name) {
        run_git_argv(
            main_repo,
            &["worktree", "add", target_path, name],
            format!("git worktree add exited for {target_path}"),
        )
    } else {
        run_git_argv(
            main_repo,
            &["worktree", "add", target_path, "-b", name],
            format!("git worktree add exited for {target_path}"),
        )
    }
}

fn branch_exists_in_repo(cwd: &str, branch: &str) -> bool {
    let mut command = git_command(cwd);
    command.args(["show-ref", "--verify", "--quiet"]);
    command.arg(format!("refs/heads/{branch}"));
    command.status().is_ok_and(|status| status.success())
}

fn run_git_argv(cwd: &str, argv: &[&str], fallback_error: String) -> Result<(), String> {
    run_git_argv_output(cwd, argv, fallback_error).map(|_| ())
}

fn run_git_argv_output(cwd: &str, argv: &[&str], fallback_error: String) -> Result<String, String> {
    match git_command(cwd).args(argv).output() {
        Ok(output) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if stderr.is_empty() {
                Err(fallback_error)
            } else {
                Err(stderr)
            }
        }
        Err(error) => Err(format!("{fallback_error}: {error}")),
    }
}

fn git_command(cwd: &str) -> AsyncCommand {
    let mut command = AsyncCommand::new("git");
    command.current_dir(cwd);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(key);
    }
    command
}
