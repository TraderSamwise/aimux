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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitDeliveryError {
    GitCommand {
        cwd: String,
        args: Vec<String>,
        message: String,
    },
    Undelivered {
        head_sha: String,
        source_repo: String,
        target_project_root: String,
        target_ref: String,
        source_common_dir: String,
        target_common_dir: String,
        shares_object_store: bool,
        detail: String,
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
            cwd: target_project_root.to_owned(),
            args: vec![
                "merge-base".into(),
                "--is-ancestor".into(),
                head_sha.clone(),
                target_ref.to_owned(),
            ],
            message: error.to_string(),
        })?;
    if ancestry.status.success() {
        return Ok(GitDeliveryCheck {
            head_sha,
            source_repo,
            target_project_root: target_project_root.to_owned(),
            target_ref: target_ref.to_owned(),
            source_common_dir,
            target_common_dir,
            shares_object_store,
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
        source_repo,
        target_project_root: target_project_root.to_owned(),
        target_ref: target_ref.to_owned(),
        source_common_dir,
        target_common_dir,
        shares_object_store,
        detail,
    })
}

pub fn git_current_branch(repo: &str) -> Result<String, GitDeliveryError> {
    git_output(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
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
            cwd: cwd.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            message: error.to_string(),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Err(GitDeliveryError::GitCommand {
            cwd: cwd.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            message: if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("exited with {}", output.status)
            },
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn canonical_equal(left: &str, right: &str) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| PathBuf::from(left));
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| PathBuf::from(right));
    left == right
}
