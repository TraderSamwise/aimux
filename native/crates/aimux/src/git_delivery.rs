use std::ffi::OsString;
use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::OnceLock;
use std::time::Duration;

use crate::async_subprocess::{AsyncCommand, command_task_name};

/// How long any one `git` call in this module may take before it is killed and
/// reported.
///
/// The daemon's coherence report calls in here, and an unbounded `git` there
/// held the global runtime mutex for as long as the child lived: a stuck
/// `index.lock` or an unresponsive filesystem blocked every other daemon
/// request, and on 2026-10-11 only `kill -9` ended it. The number is the
/// subprocess default this repo already uses rather than a new one; the only
/// measured figure in this module is 842ms for a 34,990-entry status scan, so
/// it is tens of times the worst case anyone has seen.
pub const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Where `git` is, found once per process.
///
/// A bare `"git"` makes the OS walk `PATH` on every spawn, and a coherence
/// scan spawns several; AGENTS.md "Subprocess Churn" asks for one resolution
/// and an absolute path to the children. The failure is cached too: a `PATH`
/// with no git on it does not fix itself between two calls, and re-walking it
/// per spawn is the retry loop that section forbids.
fn git_program() -> Result<&'static OsString, &'static str> {
    static GIT_PROGRAM: OnceLock<Result<OsString, String>> = OnceLock::new();
    GIT_PROGRAM
        .get_or_init(|| {
            crate::program_lookup::resolve_program_from_path("git", std::env::var_os("PATH"), None)
        })
        .as_ref()
        .map_err(String::as_str)
}

fn git_command(cwd: &str, args: &[&str]) -> Result<AsyncCommand, GitDeliveryError> {
    let program = git_program().map_err(|error| git_failure(cwd, args, error))?;
    let mut command = AsyncCommand::new(program);
    command.arg("-C").arg(cwd).args(args);
    Ok(command)
}

fn git_task_name(args: &[&str]) -> String {
    let subcommand = args
        .iter()
        .copied()
        .find(|arg| !arg.starts_with('-'))
        .unwrap_or("git");
    command_task_name("git-delivery", subcommand)
}

fn git_failure(cwd: &str, args: &[&str], message: impl Into<String>) -> GitDeliveryError {
    GitDeliveryError::GitCommand {
        cwd: cwd.into(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        message: message.into().into_boxed_str(),
    }
}

/// Run `git` with a deadline, naming the call that failed.
///
/// A non-zero exit is an answer and comes back as `Ok`; only a spawn failure
/// or the deadline is an error, so a caller that treats a failed exit as
/// "absent" cannot also swallow a wedged child.
fn git_run(cwd: &str, args: &[&str], budget: Duration) -> Result<Output, GitDeliveryError> {
    git_command(cwd, args)?
        .output_timeout(git_task_name(args), budget)
        .map_err(|error| git_failure(cwd, args, error.to_string()))
}

fn git_run_with_stdin(
    cwd: &str,
    args: &[&str],
    payload: Vec<u8>,
    budget: Duration,
) -> Result<Output, GitDeliveryError> {
    git_command(cwd, args)?
        .output_timeout_with_stdin(git_task_name(args), budget, payload)
        .map_err(|error| git_failure(cwd, args, error.to_string()))
}

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
    verify_git_delivery_within(cwd, target_project_root, target_ref, GIT_COMMAND_TIMEOUT)
}

/// `verify_git_delivery` with the deadline named, so a test can watch a budget
/// run out instead of waiting for a real `git` to hang.
pub fn verify_git_delivery_within(
    cwd: &str,
    target_project_root: &str,
    target_ref: &str,
    budget: Duration,
) -> Result<GitDeliveryCheck, GitDeliveryError> {
    let target_ref = target_ref.trim();
    let target_ref = if target_ref.is_empty() {
        "HEAD"
    } else {
        target_ref
    };
    let head_sha = git_output(cwd, &["rev-parse", "--verify", "HEAD"], budget)?;
    let source_repo = git_output(cwd, &["rev-parse", "--show-toplevel"], budget)?;
    let source_common_dir = git_common_dir(cwd, budget)?;
    let target_common_dir = git_common_dir(target_project_root, budget)?;
    let shares_object_store = canonical_equal(&source_common_dir, &target_common_dir);
    let ancestry = git_run(
        target_project_root,
        &["merge-base", "--is-ancestor", &head_sha, target_ref],
        budget,
    )?;
    if ancestry.status.success() {
        let target_checkout = inspect_git_checkout_coherence_within(target_project_root, budget)?;
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
    git_output(
        repo,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        GIT_COMMAND_TIMEOUT,
    )
}

pub fn inspect_git_checkout_coherence(
    repo: &str,
) -> Result<GitCheckoutCoherence, GitDeliveryError> {
    inspect_git_checkout_coherence_within(repo, GIT_COMMAND_TIMEOUT)
}

/// `inspect_git_checkout_coherence` with the deadline named.
///
/// The budget is per child, not per scan: a checkout with several stale-base
/// candidates makes a dozen calls, and the whole scan can take a multiple of
/// it. That is deliberate -- no single call may hang, and the caller decides
/// how long it is willing to spend in total. The daemon's answer to the total
/// is to hold no lock while it asks.
pub fn inspect_git_checkout_coherence_within(
    repo: &str,
    budget: Duration,
) -> Result<GitCheckoutCoherence, GitDeliveryError> {
    let repo_root = git_output(repo, &["rev-parse", "--show-toplevel"], budget)?;
    let head_sha = git_output(repo, &["rev-parse", "--verify", "HEAD"], budget)?;
    let status_entries = git_status_entries(&repo_root, budget)?;
    if status_entries.is_empty() {
        return Ok(GitCheckoutCoherence {
            repo: repo_root,
            head_sha,
            status: GitCheckoutCoherenceStatus::Coherent,
            stale_base: None,
            files: Vec::new(),
        });
    }

    let stale_candidates = stale_base_candidates(&repo_root, &head_sha, budget)?;
    let mut files = Vec::new();
    let mut stale_base = None;
    // Comparable entries only, resolved once for every candidate rather than
    // four spawns per entry: a stale checkout of N files cost 8N spawns, and
    // nothing capped it.
    let comparable: Vec<&GitStatusEntry> = status_entries
        .iter()
        .take_while(|entry| entry.index_status != '?' && entry.worktree_status == ' ')
        .collect();
    // A run shorter than every entry means some entry already disqualified the
    // checkout, exactly as the per-entry break did -- and then there is
    // nothing worth asking git about either.
    // Nothing to compare against means nothing worth asking git either.
    let comparable_explains_everything =
        comparable.len() == status_entries.len() && !stale_candidates.is_empty();
    let comparable_paths: Vec<String> = if comparable_explains_everything {
        comparable.iter().map(|entry| entry.path.clone()).collect()
    } else {
        Vec::new()
    };
    let stale_head_blobs = tree_blobs(&repo_root, "HEAD", &comparable_paths, budget)?;
    let stale_index_blobs = index_blobs(&repo_root, &comparable_paths, budget)?;
    let stale_worktree_blobs = worktree_blobs(&repo_root, &comparable_paths, budget)?;
    for candidate in stale_candidates {
        if !comparable_explains_everything {
            break;
        }
        let mut candidate_files = Vec::new();
        let mut all_match = true;
        let base_blobs = tree_blobs(&repo_root, &candidate, &comparable_paths, budget)?;
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

    // Tracked paths only. An untracked one is in neither HEAD nor the index,
    // and hashing its contents answers nothing the status characters have not
    // -- while streaming an arbitrarily large file through git under the lock.
    let tracked: Vec<String> = status_entries
        .iter()
        .filter(|entry| entry.index_status != '?')
        .map(|entry| entry.path.clone())
        .collect();
    let head_blobs = tree_blobs(&repo_root, "HEAD", &tracked, budget)?;
    let index_blobs = index_blobs(&repo_root, &tracked, budget)?;
    let worktree_blobs = worktree_blobs(&repo_root, &tracked, budget)?;
    let mut answered = 0usize;
    let files = status_entries
        .into_iter()
        .map(|entry| {
            if entry.index_status == '?' {
                return GitCheckoutFile {
                    path: entry.path,
                    index_status: entry.index_status,
                    worktree_status: entry.worktree_status,
                    head_blob: None,
                    index_blob: None,
                    worktree_blob: None,
                };
            }
            let index = answered;
            answered += 1;
            GitCheckoutFile {
                path: entry.path,
                index_status: entry.index_status,
                worktree_status: entry.worktree_status,
                head_blob: head_blobs[index].clone(),
                index_blob: index_blobs[index].clone(),
                worktree_blob: worktree_blobs[index].clone(),
            }
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

fn git_common_dir(cwd: &str, budget: Duration) -> Result<String, GitDeliveryError> {
    let raw = git_output(cwd, &["rev-parse", "--git-common-dir"], budget)?;
    let path = PathBuf::from(raw.trim());
    let resolved = if path.is_absolute() {
        path
    } else {
        Path::new(cwd).join(path)
    };
    Ok(resolved.to_string_lossy().into_owned())
}

fn git_output(cwd: &str, args: &[&str], budget: Duration) -> Result<String, GitDeliveryError> {
    let output = git_run(cwd, args, budget)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Err(git_failure(
            cwd,
            args,
            if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("exited with {}", output.status)
            },
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[derive(Debug)]
struct GitStatusEntry {
    index_status: char,
    worktree_status: char,
    path: String,
}

fn git_status_entries(
    repo: &str,
    budget: Duration,
) -> Result<Vec<GitStatusEntry>, GitDeliveryError> {
    // Not `--untracked-files=all`: the per-file detail fed nothing but a
    // count, and collapsing untracked directories took one real checkout
    // from 34,990 entries to a handful, with the scan itself 842ms faster.
    // `--no-optional-locks` because this is a report: `status` would otherwise
    // take `index.lock` to write back its refresh, and an expired budget now
    // SIGKILLs the child -- leaving behind the stale lock this whole change
    // exists to stop waiting on.
    let args = [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
    ];
    let output = git_run(repo, &args, budget)?;
    if !output.status.success() {
        return Err(git_failure(
            repo,
            &args,
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
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

fn stale_base_candidates(
    repo: &str,
    head_sha: &str,
    budget: Duration,
) -> Result<Vec<String>, GitDeliveryError> {
    let mut candidates = Vec::new();
    for spec in ["HEAD@{1}", "HEAD^1"] {
        // `optional_git_output`, not `git_output`: a spec git does not have is
        // a `None` to skip, and a git that never answered is an error to
        // report. Collapsing the two made a wedged `rev-parse` read as "no
        // such base", which is how a stale checkout came back `Modified`.
        let Some(candidate) = optional_git_output(repo, &["rev-parse", "--verify", spec], budget)?
        else {
            continue;
        };
        if candidate == head_sha || candidates.contains(&candidate) {
            continue;
        }
        if git_is_ancestor(repo, &candidate, head_sha, budget)? {
            candidates.push(candidate);
        }
    }
    Ok(candidates)
}

fn git_is_ancestor(
    repo: &str,
    ancestor: &str,
    descendant: &str,
    budget: Duration,
) -> Result<bool, GitDeliveryError> {
    let output = git_run(
        repo,
        &["merge-base", "--is-ancestor", ancestor, descendant],
        budget,
    )?;
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
fn batch_blobs(
    repo: &str,
    specs: &[String],
    budget: Duration,
) -> Result<Vec<Option<String>>, GitDeliveryError> {
    if specs.is_empty() {
        return Ok(Vec::new());
    }
    let args = ["cat-file", "--batch-check"];
    let output = git_run_with_stdin(repo, &args, lines_payload(specs), budget)?;
    let text = String::from_utf8_lossy(&output.stdout);
    let blobs: Vec<Option<String>> = text
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
        return Err(git_failure(
            repo,
            &args,
            format!("cat-file answered {} of {} specs", blobs.len(), specs.len()),
        ));
    }
    Ok(blobs)
}

/// One newline-terminated line per item, which is what every batch pipe here
/// reads.
fn lines_payload(items: &[String]) -> Vec<u8> {
    let mut payload = Vec::new();
    for item in items {
        payload.extend_from_slice(item.as_bytes());
        payload.push(b'\n');
    }
    payload
}

/// Whether a path can be asked for down a batch pipe at all.
///
/// Newlines delimit the protocol. Worse, `hash-object --stdin-paths` runs a
/// line starting with `"` through C-unquoting, so a file literally named
/// `"q.txt"` would be answered with the hash of `q.txt` -- the right shape of
/// answer for the wrong file -- and `strbuf_getline` strips a trailing `\r`,
/// turning the path into one git cannot open. Those fall back to their own
/// invocation rather than being silently mis-hashed.
fn path_is_batchable(path: &str) -> bool {
    !path.contains('\n') && !path.contains('\r') && !path.starts_with('"')
}

fn tree_blobs(
    repo: &str,
    treeish: &str,
    paths: &[String],
    budget: Duration,
) -> Result<Vec<Option<String>>, GitDeliveryError> {
    resolved_in_batches(
        repo,
        paths,
        |path| format!("{treeish}:{path}"),
        |repo, path| tree_blob(repo, treeish, path, budget),
        budget,
    )
}

fn index_blobs(
    repo: &str,
    paths: &[String],
    budget: Duration,
) -> Result<Vec<Option<String>>, GitDeliveryError> {
    resolved_in_batches(
        repo,
        paths,
        |path| format!(":{path}"),
        |repo, path| index_blob(repo, path, budget),
        budget,
    )
}

fn resolved_in_batches(
    repo: &str,
    paths: &[String],
    spec: impl Fn(&str) -> String,
    single: impl Fn(&str, &str) -> Result<Option<String>, GitDeliveryError>,
    budget: Duration,
) -> Result<Vec<Option<String>>, GitDeliveryError> {
    let batchable: Vec<String> = paths
        .iter()
        .filter(|path| path_is_batchable(path))
        .map(|path| spec(path))
        .collect();
    let mut batched = batch_blobs(repo, &batchable, budget)?.into_iter();
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
fn worktree_blobs(
    repo: &str,
    paths: &[String],
    budget: Duration,
) -> Result<Vec<Option<String>>, GitDeliveryError> {
    let present: Vec<&String> = paths
        .iter()
        .filter(|path| Path::new(repo).join(path.as_str()).is_file())
        .collect();
    let batchable: Vec<String> = present
        .iter()
        .filter(|path| path_is_batchable(path))
        .map(|path| (*path).clone())
        .collect();
    let mut hashed = hash_object_batch(repo, &batchable, budget)?.into_iter();
    let mut by_path = std::collections::BTreeMap::new();
    for path in &present {
        let hash = if path_is_batchable(path) {
            hashed.next().flatten()
        } else {
            worktree_blob(repo, path, budget)?
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
    budget: Duration,
) -> Result<Vec<Option<String>>, GitDeliveryError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let args = ["hash-object", "--stdin-paths"];
    let output = git_run_with_stdin(repo, &args, lines_payload(paths), budget)?;
    if !output.status.success() {
        return Err(git_failure(
            repo,
            &args,
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let hashes: Vec<Option<String>> = text
        .lines()
        .map(|line| Some(line.trim().to_owned()))
        .collect();
    if hashes.len() != paths.len() {
        return Err(git_failure(
            repo,
            &args,
            format!(
                "hash-object answered {} of {} paths",
                hashes.len(),
                paths.len()
            ),
        ));
    }
    Ok(hashes)
}

fn tree_blob(
    repo: &str,
    treeish: &str,
    path: &str,
    budget: Duration,
) -> Result<Option<String>, GitDeliveryError> {
    let spec = format!("{treeish}:{path}");
    optional_git_output(repo, &["rev-parse", "--verify", &spec], budget)
}

fn index_blob(
    repo: &str,
    path: &str,
    budget: Duration,
) -> Result<Option<String>, GitDeliveryError> {
    let spec = format!(":{path}");
    optional_git_output(repo, &["rev-parse", "--verify", &spec], budget)
}

fn worktree_blob(
    repo: &str,
    path: &str,
    budget: Duration,
) -> Result<Option<String>, GitDeliveryError> {
    let full_path = Path::new(repo).join(path);
    if !full_path.is_file() {
        return Ok(None);
    }
    optional_git_output(repo, &["hash-object", "--", path], budget)
}

/// A git call whose failure means "no such object", not "could not ask".
///
/// A non-zero exit is the absent answer; a spawn failure or an expired budget
/// still comes back as an error, because a wedged child reported as `None`
/// would make every blob look absent and the checkout look coherent.
fn optional_git_output(
    cwd: &str,
    args: &[&str],
    budget: Duration,
) -> Result<Option<String>, GitDeliveryError> {
    let output = git_run(cwd, args, budget)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The batch pipes and the candidate walk, reached directly.
    ///
    /// `inspect_git_checkout_coherence_within` with a spent budget dies at its
    /// first `rev-parse`, so nothing below it is covered from outside: an
    /// adversarial review made `git_run_with_stdin` ignore its budget and
    /// every integration test still passed. These reach the private callers.
    fn fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aimux-git-delivery-unit-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("fixture root");
        let repo = root.to_string_lossy().into_owned();
        for args in [
            vec!["init", "--initial-branch=master"],
            vec!["config", "user.email", "aimux-test@example.com"],
            vec!["config", "user.name", "Aimux Test"],
        ] {
            git_run(&repo, &args, GIT_COMMAND_TIMEOUT).expect("set up the fixture repo");
        }
        std::fs::write(root.join("file.txt"), "base\n").expect("write file");
        git_run(&repo, &["add", "file.txt"], GIT_COMMAND_TIMEOUT).expect("add");
        git_run(&repo, &["commit", "-m", "base"], GIT_COMMAND_TIMEOUT).expect("commit");
        root
    }

    fn timed_out(error: &GitDeliveryError, expected_args: &[&str]) {
        let GitDeliveryError::GitCommand { args, message, .. } = error else {
            panic!("expected a named git failure, got {error:?}");
        };
        assert_eq!(args, expected_args);
        assert!(message.contains("timed out"), "{message}");
    }

    #[test]
    fn a_spent_budget_stops_the_blob_batch_pipe() {
        let root = fixture("batch");
        let repo = root.to_string_lossy().into_owned();
        let specs = vec!["HEAD:file.txt".to_owned()];

        let answered =
            batch_blobs(&repo, &specs, GIT_COMMAND_TIMEOUT).expect("the real budget answers");
        assert_eq!(answered.len(), 1);
        assert!(answered[0].is_some(), "the fixture has that blob");

        let error =
            batch_blobs(&repo, &specs, Duration::ZERO).expect_err("a spent budget must not answer");
        timed_out(&error, &["cat-file", "--batch-check"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_spent_budget_stops_the_hash_batch_pipe() {
        let root = fixture("hash");
        let repo = root.to_string_lossy().into_owned();
        let paths = vec!["file.txt".to_owned()];

        let answered =
            hash_object_batch(&repo, &paths, GIT_COMMAND_TIMEOUT).expect("the real budget answers");
        assert_eq!(answered.len(), 1);

        let error = hash_object_batch(&repo, &paths, Duration::ZERO)
            .expect_err("a spent budget must not answer");
        timed_out(&error, &["hash-object", "--stdin-paths"]);
        let _ = std::fs::remove_dir_all(root);
    }

    /// Children get an absolute `git`, resolved once.
    ///
    /// A bare name is a `PATH` walk per spawn, and a coherence scan spawns
    /// several. Asserted on the command this module actually builds, because
    /// a resolver nothing passes to its children resolves nothing.
    #[test]
    fn every_git_child_is_spawned_by_absolute_path() {
        let program = git_program().expect("git is on PATH in a dev environment");
        assert!(
            Path::new(program).is_absolute(),
            "{program:?} is not an absolute path"
        );
        assert!(
            crate::program_lookup::executable_file_exists(Path::new(program)),
            "{program:?} is not an executable file"
        );
        assert!(
            std::ptr::eq(program, git_program().expect("still resolvable")),
            "git was resolved twice instead of once per process"
        );

        let command = git_command("/", &["rev-parse", "HEAD"]).expect("build the command");
        assert_eq!(command.program(), program.as_os_str());
    }

    /// A candidate git could not be ASKED about is not a candidate that is
    /// absent: this walk used to `continue` on any error, so a wedged
    /// `rev-parse` made a stale checkout report as merely modified.
    #[test]
    fn a_spent_budget_stops_the_stale_base_walk_instead_of_skipping_it() {
        let root = fixture("stale-walk");
        let repo = root.to_string_lossy().into_owned();
        let head = git_output(
            &repo,
            &["rev-parse", "--verify", "HEAD"],
            GIT_COMMAND_TIMEOUT,
        )
        .expect("head sha");

        stale_base_candidates(&repo, &head, GIT_COMMAND_TIMEOUT)
            .expect("the real budget answers, even with no candidates");

        let error = stale_base_candidates(&repo, &head, Duration::ZERO)
            .expect_err("a spent budget must not read as 'no such base'");
        timed_out(&error, &["rev-parse", "--verify", "HEAD@{1}"]);
        let _ = std::fs::remove_dir_all(root);
    }
}
