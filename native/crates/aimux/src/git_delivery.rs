use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitDeliveryCheck {
    pub head_sha: String,
    pub source_repo: String,
    pub target_project_root: String,
    pub target_ref: String,
    pub source_common_dir: String,
    pub target_common_dir: String,
    pub shares_object_store: bool,
    pub target_checkout: GitCheckoutCoherence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCheckoutCoherence {
    pub repo: String,
    pub head_sha: String,
    pub status: GitCheckoutCoherenceStatus,
    pub stale_base: Option<String>,
    pub files: Vec<GitCheckoutFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitCheckoutCoherenceStatus {
    Coherent,
    Stale,
    Modified,
}

impl GitCheckoutCoherenceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Coherent => "coherent",
            Self::Stale => "stale",
            Self::Modified => "modified",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCheckoutFile {
    pub path: String,
    pub index_status: char,
    pub worktree_status: char,
    pub head_blob: Option<String>,
    pub index_blob: Option<String>,
    pub worktree_blob: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitDeliveryError {
    GitCommand {
        cwd: Box<str>,
        args: Vec<String>,
        message: Box<str>,
    },
    Undelivered {
        head_sha: String,
        source_repo: Box<str>,
        target_project_root: Box<str>,
        target_ref: Box<str>,
        source_common_dir: Box<str>,
        target_common_dir: Box<str>,
        shares_object_store: bool,
        detail: Box<str>,
    },
    StaleTargetCheckout {
        target_project_root: Box<str>,
        target_ref: Box<str>,
        head_sha: Box<str>,
        stale_base: Box<str>,
        files: Vec<String>,
    },
}

impl Display for GitDeliveryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::GitCommand { cwd, args, message } => {
                write!(
                    formatter,
                    "git delivery check could not run `git -C {cwd} {}`: {message}",
                    args.join(" ")
                )
            }
            Self::Undelivered {
                head_sha,
                source_repo,
                target_project_root,
                target_ref,
                source_common_dir,
                target_common_dir,
                shares_object_store,
                detail,
            } => {
                write!(
                    formatter,
                    "git delivery check failed: HEAD {head_sha} from {source_repo} is not reachable from {target_ref} in {target_project_root}. source common dir: {source_common_dir}; target common dir: {target_common_dir}; shares object store: {shares_object_store}; {detail}"
                )
            }
            Self::StaleTargetCheckout {
                target_project_root,
                target_ref,
                head_sha,
                stale_base,
                files,
            } => {
                write!(
                    formatter,
                    "git delivery check failed: target checkout {target_project_root} is stale behind its own {target_ref} ({head_sha}); index/worktree content still matches previous checkout {stale_base} for: {}",
                    files.join(", ")
                )
            }
        }
    }
}

impl std::error::Error for GitDeliveryError {}

pub fn verify_git_delivery(
    cwd: &str,
    target_project_root: &str,
    target_ref: &str,
) -> Result<GitDeliveryCheck, GitDeliveryError> {
    let target_ref = target_ref.trim();
    let target_ref = if target_ref.is_empty() {
        "HEAD"
    } else {
        target_ref
    };
    let head_sha = git_output(cwd, &["rev-parse", "--verify", "HEAD"])?;
    let source_repo = git_output(cwd, &["rev-parse", "--show-toplevel"])?;
    let source_common_dir = git_common_dir(cwd)?;
    let target_common_dir = git_common_dir(target_project_root)?;
    let shares_object_store = canonical_equal(&source_common_dir, &target_common_dir);
    let ancestry = Command::new("git")
        .arg("-C")
        .arg(target_project_root)
        .args(["merge-base", "--is-ancestor", &head_sha, target_ref])
        .output()
        .map_err(|error| GitDeliveryError::GitCommand {
            cwd: target_project_root.into(),
            args: vec![
                "merge-base".into(),
                "--is-ancestor".into(),
                head_sha.clone(),
                target_ref.to_owned(),
            ],
            message: error.to_string().into_boxed_str(),
        })?;
    if ancestry.status.success() {
        let target_checkout = inspect_git_checkout_coherence(target_project_root)?;
        if target_checkout.status == GitCheckoutCoherenceStatus::Stale {
            return Err(GitDeliveryError::StaleTargetCheckout {
                target_project_root: target_project_root.into(),
                target_ref: target_ref.into(),
                head_sha: target_checkout.head_sha.clone().into_boxed_str(),
                stale_base: target_checkout
                    .stale_base
                    .clone()
                    .unwrap_or_else(|| "unknown".into())
                    .into_boxed_str(),
                files: target_checkout
                    .files
                    .iter()
                    .map(|file| file.path.clone())
                    .collect(),
            });
        }
        return Ok(GitDeliveryCheck {
            head_sha,
            source_repo,
            target_project_root: target_project_root.to_owned(),
            target_ref: target_ref.to_owned(),
            source_common_dir,
            target_common_dir,
            shares_object_store,
            target_checkout,
        });
    }
    let stderr = String::from_utf8_lossy(&ancestry.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&ancestry.stdout).trim().to_owned();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!(
            "`git merge-base --is-ancestor {head_sha} {target_ref}` exited with {}",
            ancestry.status
        )
    };
    Err(GitDeliveryError::Undelivered {
        head_sha,
        source_repo: source_repo.into_boxed_str(),
        target_project_root: target_project_root.into(),
        target_ref: target_ref.into(),
        source_common_dir: source_common_dir.into_boxed_str(),
        target_common_dir: target_common_dir.into_boxed_str(),
        shares_object_store,
        detail: detail.into_boxed_str(),
    })
}

pub fn git_current_branch(repo: &str) -> Result<String, GitDeliveryError> {
    git_output(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
}

pub fn inspect_git_checkout_coherence(
    repo: &str,
) -> Result<GitCheckoutCoherence, GitDeliveryError> {
    let repo_root = git_output(repo, &["rev-parse", "--show-toplevel"])?;
    let head_sha = git_output(repo, &["rev-parse", "--verify", "HEAD"])?;
    let status_entries = git_status_entries(&repo_root)?;
    if status_entries.is_empty() {
        return Ok(GitCheckoutCoherence {
            repo: repo_root,
            head_sha,
            status: GitCheckoutCoherenceStatus::Coherent,
            stale_base: None,
            files: Vec::new(),
        });
    }

    let stale_candidates = stale_base_candidates(&repo_root, &head_sha)?;
    let mut files = Vec::new();
    let mut stale_base = None;
    for candidate in stale_candidates {
        let mut candidate_files = Vec::new();
        let mut all_match = true;
        for entry in &status_entries {
            if entry.index_status == '?' || entry.worktree_status != ' ' {
                all_match = false;
                break;
            }
            let head_blob = tree_blob(&repo_root, "HEAD", &entry.path)?;
            let base_blob = tree_blob(&repo_root, &candidate, &entry.path)?;
            let index_blob = index_blob(&repo_root, &entry.path)?;
            let worktree_blob = worktree_blob(&repo_root, &entry.path)?;
            if index_blob != base_blob || worktree_blob != base_blob || head_blob == base_blob {
                all_match = false;
                break;
            }
            candidate_files.push(GitCheckoutFile {
                path: entry.path.clone(),
                index_status: entry.index_status,
                worktree_status: entry.worktree_status,
                head_blob,
                index_blob,
                worktree_blob,
            });
        }
        if all_match && !candidate_files.is_empty() {
            files = candidate_files;
            stale_base = Some(candidate);
            break;
        }
    }

    if let Some(stale_base) = stale_base {
        return Ok(GitCheckoutCoherence {
            repo: repo_root,
            head_sha,
            status: GitCheckoutCoherenceStatus::Stale,
            stale_base: Some(stale_base),
            files,
        });
    }

    let files = status_entries
        .into_iter()
        .map(|entry| {
            let head_blob = tree_blob(&repo_root, "HEAD", &entry.path)?;
            let index_blob = index_blob(&repo_root, &entry.path)?;
            let worktree_blob = worktree_blob(&repo_root, &entry.path)?;
            Ok(GitCheckoutFile {
                path: entry.path,
                index_status: entry.index_status,
                worktree_status: entry.worktree_status,
                head_blob,
                index_blob,
                worktree_blob,
            })
        })
        .collect::<Result<Vec<_>, GitDeliveryError>>()?;

    Ok(GitCheckoutCoherence {
        repo: repo_root,
        head_sha,
        status: GitCheckoutCoherenceStatus::Modified,
        stale_base: None,
        files,
    })
}

fn git_common_dir(cwd: &str) -> Result<String, GitDeliveryError> {
    let raw = git_output(cwd, &["rev-parse", "--git-common-dir"])?;
    let path = PathBuf::from(raw.trim());
    let resolved = if path.is_absolute() {
        path
    } else {
        Path::new(cwd).join(path)
    };
    Ok(resolved.to_string_lossy().into_owned())
}

fn git_output(cwd: &str, args: &[&str]) -> Result<String, GitDeliveryError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| GitDeliveryError::GitCommand {
            cwd: cwd.into(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            message: error.to_string().into_boxed_str(),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Err(GitDeliveryError::GitCommand {
            cwd: cwd.into(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            message: if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("exited with {}", output.status)
            }
            .into_boxed_str(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[derive(Debug)]
struct GitStatusEntry {
    index_status: char,
    worktree_status: char,
    path: String,
}

fn git_status_entries(repo: &str) -> Result<Vec<GitStatusEntry>, GitDeliveryError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .output()
        .map_err(|error| GitDeliveryError::GitCommand {
            cwd: repo.into(),
            args: vec![
                "status".into(),
                "--porcelain=v1".into(),
                "-z".into(),
                "--untracked-files=all".into(),
            ],
            message: error.to_string().into_boxed_str(),
        })?;
    if !output.status.success() {
        return Err(GitDeliveryError::GitCommand {
            cwd: repo.into(),
            args: vec![
                "status".into(),
                "--porcelain=v1".into(),
                "-z".into(),
                "--untracked-files=all".into(),
            ],
            message: String::from_utf8_lossy(&output.stderr)
                .trim()
                .to_owned()
                .into_boxed_str(),
        });
    }
    let mut entries = Vec::new();
    let mut fields = output.stdout.split(|byte| *byte == 0);
    while let Some(raw) = fields.next() {
        if raw.is_empty() || raw.len() < 4 {
            continue;
        }
        let index_status = raw[0] as char;
        let worktree_status = raw[1] as char;
        let path = String::from_utf8_lossy(&raw[3..]).into_owned();
        if matches!(index_status, 'R' | 'C') {
            let _ = fields.next();
        }
        entries.push(GitStatusEntry {
            index_status,
            worktree_status,
            path,
        });
    }
    Ok(entries)
}

fn stale_base_candidates(repo: &str, head_sha: &str) -> Result<Vec<String>, GitDeliveryError> {
    let mut candidates = Vec::new();
    for spec in ["HEAD@{1}", "HEAD^1"] {
        let Ok(candidate) = git_output(repo, &["rev-parse", "--verify", spec]) else {
            continue;
        };
        if candidate == head_sha || candidates.contains(&candidate) {
            continue;
        }
        if git_is_ancestor(repo, &candidate, head_sha)? {
            candidates.push(candidate);
        }
    }
    Ok(candidates)
}

fn git_is_ancestor(repo: &str, ancestor: &str, descendant: &str) -> Result<bool, GitDeliveryError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .output()
        .map_err(|error| GitDeliveryError::GitCommand {
            cwd: repo.into(),
            args: vec![
                "merge-base".into(),
                "--is-ancestor".into(),
                ancestor.into(),
                descendant.into(),
            ],
            message: error.to_string().into_boxed_str(),
        })?;
    Ok(output.status.success())
}

fn tree_blob(repo: &str, treeish: &str, path: &str) -> Result<Option<String>, GitDeliveryError> {
    let spec = format!("{treeish}:{path}");
    optional_git_output(repo, &["rev-parse", "--verify", &spec])
}

fn index_blob(repo: &str, path: &str) -> Result<Option<String>, GitDeliveryError> {
    let spec = format!(":{path}");
    optional_git_output(repo, &["rev-parse", "--verify", &spec])
}

fn worktree_blob(repo: &str, path: &str) -> Result<Option<String>, GitDeliveryError> {
    let full_path = Path::new(repo).join(path);
    if !full_path.is_file() {
        return Ok(None);
    }
    optional_git_output(repo, &["hash-object", "--", path])
}

fn optional_git_output(cwd: &str, args: &[&str]) -> Result<Option<String>, GitDeliveryError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| GitDeliveryError::GitCommand {
            cwd: cwd.into(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            message: error.to_string().into_boxed_str(),
        })?;
    if output.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ));
    }
    Ok(None)
}

fn canonical_equal(left: &str, right: &str) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| PathBuf::from(left));
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| PathBuf::from(right));
    left == right
}
