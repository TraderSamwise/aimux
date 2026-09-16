use crate::async_subprocess::AsyncCommand;
use crate::backend_session_ids::{
    BackendSessionDiscoveryOptions, codex_backend_session_ids_for_cwd,
};
use crate::paths::{is_git_project_root, project_checkout_required_message};
use crate::tmux::{
    AIMUX_TMUX_SOCKET_PATH_ENV, CapturePaneOptions, TmuxRuntimeManager, TmuxTarget,
    clear_history_argv, kill_window_argv, new_window_argv, rename_window_argv,
    set_window_option_argv, tmux_command_from_env,
};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::process::Command as TokioCommand;

const LIFECYCLE_SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedPullRequestWorktree {
    pub branch: String,
    pub head_oid: String,
}

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
    fn prepare_pull_request_worktree(
        &mut self,
        main_repo: &str,
        name: &str,
        pr: u64,
    ) -> Result<PreparedPullRequestWorktree, String> {
        let _ = (main_repo, name, pr);
        Err("pull request worktree creation is not supported by this runtime".into())
    }
    fn create_worktree_from_branch(
        &mut self,
        main_repo: &str,
        branch: &str,
        target_path: &str,
    ) -> Result<(), String> {
        self.create_worktree(main_repo, branch, target_path)
    }
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

pub(crate) trait AsyncProjectLifecycleRuntime {
    async fn ensure_project_session(&mut self, project_root: &Path) -> Result<(), String>;
    async fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String>;
    async fn set_window_metadata(
        &mut self,
        window_id: &str,
        metadata: &Value,
    ) -> Result<(), String>;
    async fn set_window_option(
        &mut self,
        window_id: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String>;
    async fn clear_history(&mut self, window_id: &str) -> Result<(), String>;
    async fn wait_for_window_after_launch(
        &mut self,
        target: &TmuxTarget,
        timeout: Duration,
    ) -> bool;
    fn codex_backend_session_ids_for_cwd(&mut self, cwd: &str) -> Result<BTreeSet<String>, String>;
    async fn kill_window(&mut self, window_id: &str) -> Result<(), String>;
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

    fn prepare_pull_request_worktree(
        &mut self,
        main_repo: &str,
        name: &str,
        pr: u64,
    ) -> Result<PreparedPullRequestWorktree, String> {
        prepare_git_pull_request_worktree(main_repo, name, pr)
    }

    fn create_worktree_from_branch(
        &mut self,
        main_repo: &str,
        branch: &str,
        target_path: &str,
    ) -> Result<(), String> {
        create_git_worktree_from_branch(main_repo, branch, target_path)
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
        ProjectLifecycleRuntime::set_window_option(self, window_id, "@aimux-meta", &metadata)
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

impl AsyncProjectLifecycleRuntime for SystemProjectLifecycleRuntime {
    async fn ensure_project_session(&mut self, project_root: &Path) -> Result<(), String> {
        let project_root = project_root.to_path_buf();
        crate::async_runtime::spawn_blocking_named(
            crate::async_runtime::scoped_task_name(
                "project-service",
                "lifecycle-ensure-session",
                &project_root.to_string_lossy(),
            ),
            move || {
                TmuxRuntimeManager::new()
                    .ensure_project_session(&project_root, None, None)
                    .map(|_| ())
            },
        )
        .await
        .map_err(|error| format!("tmux ensure project session task failed: {error}"))?
    }

    async fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String> {
        let output = run_tmux_argv_output_async(
            new_window_argv(session_name, name, cwd, command, args, detached),
            format!("tmux failed to create window \"{name}\" in session {session_name}"),
            Some(cwd),
        )
        .await?;
        parse_tmux_target(session_name, &output)
    }

    async fn set_window_metadata(
        &mut self,
        window_id: &str,
        metadata: &Value,
    ) -> Result<(), String> {
        let metadata = serde_json::to_string(metadata).map_err(|error| error.to_string())?;
        AsyncProjectLifecycleRuntime::set_window_option(self, window_id, "@aimux-meta", &metadata)
            .await
    }

    async fn set_window_option(
        &mut self,
        window_id: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        run_tmux_argv_async(
            set_window_option_argv(window_id, key, value),
            format!("tmux set-window-option {key} failed for {window_id}"),
            None,
        )
        .await
    }

    async fn clear_history(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv_async(
            clear_history_argv(window_id),
            format!("tmux clear-history failed for {window_id}"),
            None,
        )
        .await
    }

    async fn wait_for_window_after_launch(
        &mut self,
        target: &TmuxTarget,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if has_window_async(target).await {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn codex_backend_session_ids_for_cwd(&mut self, cwd: &str) -> Result<BTreeSet<String>, String> {
        codex_backend_session_ids_for_cwd(cwd, &BackendSessionDiscoveryOptions::default())
    }

    async fn kill_window(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv_async(
            kill_window_argv(window_id),
            format!("tmux kill-window failed for {window_id}"),
            None,
        )
        .await
    }
}

async fn has_window_async(target: &TmuxTarget) -> bool {
    run_tmux_argv_output_async(
        vec![
            "display-message".to_owned(),
            "-p".to_owned(),
            "-t".to_owned(),
            target.window_id.clone(),
            "#{window_id}".to_owned(),
        ],
        format!("tmux failed to inspect window {}", target.window_id),
        None,
    )
    .await
    .is_ok_and(|output| output.trim() == target.window_id)
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

async fn run_tmux_argv_async(
    argv: Vec<String>,
    fallback_error: String,
    cwd: Option<&str>,
) -> Result<(), String> {
    run_tmux_argv_output_async(argv, fallback_error, cwd)
        .await
        .map(|_| ())
}

async fn run_tmux_argv_output_async(
    argv: Vec<String>,
    fallback_error: String,
    cwd: Option<&str>,
) -> Result<String, String> {
    let mut command = TokioCommand::new("tmux");
    if let Some(socket_path) =
        std::env::var_os(AIMUX_TMUX_SOCKET_PATH_ENV).filter(|value| !value.is_empty())
    {
        command.arg("-S").arg(socket_path);
    }
    command.args(argv);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.kill_on_drop(true);
    match tokio::time::timeout(LIFECYCLE_SUBPROCESS_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if stderr.is_empty() {
                Err(fallback_error)
            } else {
                Err(stderr)
            }
        }
        Ok(Err(error)) => Err(format!("{fallback_error}: {error}")),
        Err(_) => Err(format!(
            "{fallback_error}: tmux timed out after {LIFECYCLE_SUBPROCESS_TIMEOUT:?}"
        )),
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

fn create_git_worktree_from_branch(
    main_repo: &str,
    branch: &str,
    target_path: &str,
) -> Result<(), String> {
    run_git_argv(
        main_repo,
        &["worktree", "add", target_path, branch],
        format!("git worktree add exited for {target_path}"),
    )
}

fn prepare_git_pull_request_worktree(
    main_repo: &str,
    name: &str,
    pr: u64,
) -> Result<PreparedPullRequestWorktree, String> {
    ensure_origin_remote(main_repo)?;
    let pr_info = github_pull_request_info(main_repo, pr)?;
    if pr_info.state != "OPEN" {
        return Err(format!(
            "Pull request #{pr} is {}; only open pull requests can be checked out",
            pr_info.state
        ));
    }
    if pr_info.head_oid.trim().is_empty() {
        return Err(format!("Pull request #{pr} did not include a head commit"));
    }

    let branch = pull_request_branch_name(pr, name);
    let storage_ref = pull_request_storage_ref(pr, name);
    let refspec = format!("refs/pull/{pr}/head:{storage_ref}");
    run_git_argv(
        main_repo,
        &["fetch", "--no-tags", "origin", &refspec],
        format!("git fetch failed for pull request #{pr}"),
    )
    .map_err(|error| classify_git_pr_fetch_error(pr, error))?;

    let fetched_oid = git_ref_oid(main_repo, &storage_ref).map_err(|error| {
        format!("Fetched pull request #{pr}, but could not read {storage_ref}: {error}")
    })?;
    if fetched_oid != pr_info.head_oid {
        return Err(format!(
            "Fetched pull request #{pr} head {fetched_oid} did not match GitHub head {}",
            pr_info.head_oid
        ));
    }

    ensure_local_pull_request_branch(main_repo, &branch, &storage_ref, &fetched_oid, pr)?;
    Ok(PreparedPullRequestWorktree {
        branch,
        head_oid: fetched_oid,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GithubPullRequestInfo {
    state: String,
    head_oid: String,
}

fn github_pull_request_info(main_repo: &str, pr: u64) -> Result<GithubPullRequestInfo, String> {
    let output = run_gh_pr_view(
        main_repo,
        &["pr", "view", &pr.to_string(), "--json", "state,headRefOid"],
        format!("gh pr view failed for pull request #{pr}"),
    )
    .map_err(|error| classify_gh_pr_view_error(pr, error))?;
    let json: Value = serde_json::from_str(&output)
        .map_err(|error| format!("gh returned invalid JSON for pull request #{pr}: {error}"))?;
    let state = json
        .get("state")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("gh response for pull request #{pr} omitted state"))?;
    let head_oid = json
        .get("headRefOid")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("gh response for pull request #{pr} omitted headRefOid"))?;
    Ok(GithubPullRequestInfo {
        state: state.to_owned(),
        head_oid: head_oid.to_owned(),
    })
}

fn ensure_origin_remote(main_repo: &str) -> Result<(), String> {
    run_git_argv_output(
        main_repo,
        &["remote", "get-url", "origin"],
        "git remote origin is required to resolve pull requests".to_owned(),
    )
    .map(|_| ())
    .map_err(|error| format!("Git remote \"origin\" is required to resolve pull requests: {error}"))
}

fn ensure_local_pull_request_branch(
    main_repo: &str,
    branch: &str,
    storage_ref: &str,
    fetched_oid: &str,
    pr: u64,
) -> Result<(), String> {
    if branch_exists_in_repo(main_repo, branch) {
        if let Some(path) = branch_checkout_path(main_repo, branch)? {
            return Err(format!(
                "Local branch \"{branch}\" is already checked out at {path}"
            ));
        }
        let existing_oid = git_ref_oid(main_repo, &format!("refs/heads/{branch}"))?;
        if existing_oid != fetched_oid {
            return Err(format!(
                "Local branch \"{branch}\" already exists at {existing_oid}, but pull request #{pr} head is {fetched_oid}"
            ));
        }
        return Ok(());
    }
    run_git_argv(
        main_repo,
        &["branch", branch, storage_ref],
        format!("git branch failed for pull request #{pr}"),
    )
}

fn branch_checkout_path(main_repo: &str, branch: &str) -> Result<Option<String>, String> {
    let output = run_git_argv_output(
        main_repo,
        &["worktree", "list", "--porcelain"],
        "git worktree list failed while checking branch ownership".to_owned(),
    )?;
    let expected_branch = format!("refs/heads/{branch}");
    let mut current_path: Option<String> = None;
    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_owned());
            continue;
        }
        if let Some(found_branch) = line.strip_prefix("branch ") {
            if found_branch == expected_branch {
                return Ok(current_path);
            }
            continue;
        }
        if line.trim().is_empty() {
            current_path = None;
        }
    }
    Ok(None)
}

fn git_ref_oid(main_repo: &str, reference: &str) -> Result<String, String> {
    run_git_argv_output(
        main_repo,
        &["rev-parse", reference],
        format!("git rev-parse failed for {reference}"),
    )
    .map(|output| output.trim().to_owned())
}

fn pull_request_branch_name(pr: u64, name: &str) -> String {
    format!("aimux/pr-{pr}/{}", sanitize_ref_component(name))
}

fn pull_request_storage_ref(pr: u64, name: &str) -> String {
    format!("refs/aimux/pr/{pr}/{}", sanitize_ref_component(name))
}

fn sanitize_ref_component(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_dash = false;
    for character in value.chars() {
        let allowed = character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-');
        let next = if allowed { character } else { '-' };
        if next == '-' {
            if last_was_dash {
                continue;
            }
            last_was_dash = true;
        } else {
            last_was_dash = false;
        }
        output.push(next);
    }
    let trimmed = output
        .trim_matches(|character| matches!(character, '.' | '-' | '/'))
        .replace("..", "-");
    if trimmed.is_empty() || trimmed.ends_with(".lock") {
        "worktree".into()
    } else {
        trimmed
    }
}

fn run_gh_pr_view(cwd: &str, argv: &[&str], fallback_error: String) -> Result<String, String> {
    match gh_command(cwd).args(argv).output() {
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

fn gh_command(cwd: &str) -> AsyncCommand {
    let mut command = AsyncCommand::new("gh");
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

fn classify_gh_pr_view_error(pr: u64, error: String) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("no such file") || (lower.contains("not found") && lower.contains("gh")) {
        return format!("GitHub CLI `gh` is required to resolve pull request #{pr}: {error}");
    }
    if lower.contains("authentication")
        || lower.contains("authenticate")
        || lower.contains("authorization")
        || lower.contains("login")
        || lower.contains("oauth")
    {
        return format!("GitHub authentication is required to resolve pull request #{pr}: {error}");
    }
    if lower.contains("could not resolve host")
        || lower.contains("network")
        || lower.contains("timed out")
        || lower.contains("connection")
    {
        return format!("Network error while resolving pull request #{pr}: {error}");
    }
    if lower.contains("not found")
        || lower.contains("could not resolve")
        || lower.contains("no pull requests found")
    {
        return format!("Pull request #{pr} was not found: {error}");
    }
    format!("Failed to resolve pull request #{pr}: {error}")
}

fn classify_git_pr_fetch_error(pr: u64, error: String) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("couldn't find remote ref") || lower.contains("could not find remote ref") {
        return format!(
            "Pull request #{pr} was not found while fetching refs/pull/{pr}/head: {error}"
        );
    }
    if lower.contains("could not resolve host")
        || lower.contains("network")
        || lower.contains("timed out")
        || lower.contains("connection")
    {
        return format!("Network error while fetching pull request #{pr}: {error}");
    }
    if lower.contains("authentication")
        || lower.contains("permission denied")
        || lower.contains("could not read username")
        || lower.contains("repository not found")
    {
        return format!("GitHub authentication is required to fetch pull request #{pr}: {error}");
    }
    format!("Failed to fetch pull request #{pr}: {error}")
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
