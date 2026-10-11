use std::fmt::{self, Display, Formatter};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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
    // Comparable entries only, resolved once for every candidate rather than
    // four spawns per entry: a stale checkout of N files cost 8N spawns, and
    // nothing capped it.
    let comparable: Vec<&GitStatusEntry> = status_entries
        .iter()
        .take_while(|entry| entry.index_status != '?' && entry.worktree_status == ' ')
        .collect();
    let comparable_paths: Vec<String> = comparable.iter().map(|entry| entry.path.clone()).collect();
    let stale_head_blobs = tree_blobs(&repo_root, "HEAD", &comparable_paths)?;
    let stale_index_blobs = index_blobs(&repo_root, &comparable_paths)?;
    let stale_worktree_blobs = worktree_blobs(&repo_root, &comparable_paths)?;
    for candidate in stale_candidates {
        let mut candidate_files = Vec::new();
        // A run shorter than every entry means some entry disqualified the
        // checkout, exactly as the per-entry break did.
        let mut all_match = comparable.len() == status_entries.len();
        let base_blobs = tree_blobs(&repo_root, &candidate, &comparable_paths)?;
        for (index, entry) in comparable.iter().enumerate() {
            let head_blob = stale_head_blobs[index].clone();
            let base_blob = base_blobs[index].clone();
            let index_blob = stale_index_blobs[index].clone();
            let worktree_blob = stale_worktree_blobs[index].clone();
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

    let paths: Vec<String> = status_entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect();
    let head_blobs = tree_blobs(&repo_root, "HEAD", &paths)?;
    let index_blobs = index_blobs(&repo_root, &paths)?;
    let worktree_blobs = worktree_blobs(&repo_root, &paths)?;
    let files = status_entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| GitCheckoutFile {
            path: entry.path,
            index_status: entry.index_status,
            worktree_status: entry.worktree_status,
            head_blob: head_blobs[index].clone(),
            index_blob: index_blobs[index].clone(),
            worktree_blob: worktree_blobs[index].clone(),
        })
        .collect::<Vec<_>>();

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
        // Not `--untracked-files=all`: the per-file detail fed nothing but a
        // count, and collapsing untracked directories took one real checkout
        // from 34,990 entries to a handful, with the scan itself 842ms faster.
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
        .output()
        .map_err(|error| GitDeliveryError::GitCommand {
            cwd: repo.into(),
            args: vec![
                "status".into(),
                "--porcelain=v1".into(),
                "-z".into(),
                "--untracked-files=normal".into(),
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
                "--untracked-files=normal".into(),
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

/// Resolve many blob ids in ONE git invocation.
///
/// A `rev-parse` per file is what wedged the daemon: a checkout reporting
/// 34,990 status entries cost three spawns each, under the global runtime
/// lock. `cat-file --batch-check` answers the whole list down one pipe, so the
/// cost stops scaling with the number of changed files.
///
/// Answers come back in input order, one line per spec, and a spec git cannot
/// resolve echoes itself followed by ` missing` -- which is the same `None`
/// the per-file lookup returned for an absent blob.
fn batch_blobs(repo: &str, specs: &[String]) -> Result<Vec<Option<String>>, GitDeliveryError> {
    if specs.is_empty() {
        return Ok(Vec::new());
    }
    let args = ["cat-file", "--batch-check"];
    let fail = |message: String| GitDeliveryError::GitCommand {
        cwd: repo.into(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        message: message.into_boxed_str(),
    };
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| fail(error.to_string()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| fail("stdin not piped".into()))?;
    let mut payload = Vec::new();
    for spec in specs {
        payload.extend_from_slice(spec.as_bytes());
        payload.push(b'\n');
    }
    // Written from another thread because git answers while it reads: filling
    // the output pipe while we still held the input would deadlock both ends.
    let writer = std::thread::spawn(move || stdin.write_all(&payload));
    let output = child
        .wait_with_output()
        .map_err(|error| fail(error.to_string()))?;
    let written = writer
        .join()
        .map_err(|_| fail("stdin writer panicked".into()))?;
    written.map_err(|error| fail(error.to_string()))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut blobs: Vec<Option<String>> = text
        .lines()
        .map(|line| {
            if line.ends_with(" missing") || line == "missing" {
                return None;
            }
            line.split_whitespace().next().map(str::to_owned)
        })
        .collect();
    if blobs.len() != specs.len() {
        // A short answer is not an answer of `None`s: say which call came back
        // wrong rather than reporting every blob as absent.
        return Err(fail(format!(
            "cat-file answered {} of {} specs",
            blobs.len(),
            specs.len()
        )));
    }
    blobs.truncate(specs.len());
    Ok(blobs)
}

/// `cat-file` and `hash-object --stdin-paths` are both newline-delimited, so a
/// path containing one cannot be asked for in a batch. Git allows it, so the
/// rare case falls back to its own invocation rather than being reported absent.
fn path_is_batchable(path: &str) -> bool {
    !path.contains('\n')
}

fn tree_blobs(
    repo: &str,
    treeish: &str,
    paths: &[String],
) -> Result<Vec<Option<String>>, GitDeliveryError> {
    resolved_in_batches(
        repo,
        paths,
        |path| format!("{treeish}:{path}"),
        |repo, path| tree_blob(repo, treeish, path),
    )
}

fn index_blobs(repo: &str, paths: &[String]) -> Result<Vec<Option<String>>, GitDeliveryError> {
    resolved_in_batches(repo, paths, |path| format!(":{path}"), index_blob)
}

fn resolved_in_batches(
    repo: &str,
    paths: &[String],
    spec: impl Fn(&str) -> String,
    single: impl Fn(&str, &str) -> Result<Option<String>, GitDeliveryError>,
) -> Result<Vec<Option<String>>, GitDeliveryError> {
    let batchable: Vec<String> = paths
        .iter()
        .filter(|path| path_is_batchable(path))
        .map(|path| spec(path))
        .collect();
    let mut batched = batch_blobs(repo, &batchable)?.into_iter();
    let mut blobs = Vec::with_capacity(paths.len());
    for path in paths {
        if path_is_batchable(path) {
            blobs.push(batched.next().flatten());
        } else {
            blobs.push(single(repo, path)?);
        }
    }
    Ok(blobs)
}

/// Worktree hashes come from the files themselves, so only paths that are
/// present are asked about; the rest keep the `None` they always had.
fn worktree_blobs(repo: &str, paths: &[String]) -> Result<Vec<Option<String>>, GitDeliveryError> {
    let present: Vec<&String> = paths
        .iter()
        .filter(|path| Path::new(repo).join(path.as_str()).is_file())
        .collect();
    let batchable: Vec<String> = present
        .iter()
        .filter(|path| path_is_batchable(path))
        .map(|path| (*path).clone())
        .collect();
    let mut hashed = hash_object_batch(repo, &batchable)?.into_iter();
    let mut by_path = std::collections::BTreeMap::new();
    for path in &present {
        let hash = if path_is_batchable(path) {
            hashed.next().flatten()
        } else {
            worktree_blob(repo, path)?
        };
        by_path.insert((*path).clone(), hash);
    }
    Ok(paths
        .iter()
        .map(|path| by_path.get(path).cloned().flatten())
        .collect())
}

fn hash_object_batch(
    repo: &str,
    paths: &[String],
) -> Result<Vec<Option<String>>, GitDeliveryError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let args = ["hash-object", "--stdin-paths"];
    let fail = |message: String| GitDeliveryError::GitCommand {
        cwd: repo.into(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        message: message.into_boxed_str(),
    };
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| fail(error.to_string()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| fail("stdin not piped".into()))?;
    let mut payload = Vec::new();
    for path in paths {
        payload.extend_from_slice(path.as_bytes());
        payload.push(b'\n');
    }
    let writer = std::thread::spawn(move || stdin.write_all(&payload));
    let output = child
        .wait_with_output()
        .map_err(|error| fail(error.to_string()))?;
    let written = writer
        .join()
        .map_err(|_| fail("stdin writer panicked".into()))?;
    written.map_err(|error| fail(error.to_string()))?;
    if !output.status.success() {
        return Err(fail(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let hashes: Vec<Option<String>> = text
        .lines()
        .map(|line| Some(line.trim().to_owned()))
        .collect();
    if hashes.len() != paths.len() {
        return Err(fail(format!(
            "hash-object answered {} of {} paths",
            hashes.len(),
            paths.len()
        )));
    }
    Ok(hashes)
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
