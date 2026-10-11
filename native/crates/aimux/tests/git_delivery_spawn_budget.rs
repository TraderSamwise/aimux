//! What a coherence inspection costs in git invocations.
//!
//! Field assertions could be satisfied by a change that set the flag correctly
//! and still spawned git per file, so this counts execs: a shim named `git`
//! goes ahead of the real one on `PATH` and logs every call.
//!
//! The claim is scale invariance, not a ceiling. A cap measured at one fixture
//! size cannot see a cost that still grows with the files, and a generous one
//! passes a chunked batch that spawns per 32 paths -- so the gate runs two
//! sizes and demands the same count.

use aimux::git_delivery::{GitCheckoutCoherenceStatus, inspect_git_checkout_coherence};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const SMALL: usize = 40;
const LARGE: usize = 160;

/// Below this the shim cannot have been on `PATH` at all: an inspection makes
/// several calls before it reaches any blob. Without a floor, a spy that
/// silently failed to install reports zero and passes every ceiling.
const MINIMUM_PLAUSIBLE: usize = 4;

#[test]
fn a_modified_checkout_costs_the_same_however_many_files_changed() {
    let small = inspect_modified(SMALL).0;
    let large = inspect_modified(LARGE).0;
    assert_eq!(
        small, large,
        "{SMALL} and {LARGE} changed files must cost the same; a per-file lookup would scale"
    );
}

/// The path a review found: HEAD at B with index and worktree at an ancestor,
/// so every entry matches the base and nothing breaks the loop early. That
/// cost four spawns per entry per candidate, and nothing capped it.
#[test]
fn a_stale_checkout_costs_the_same_however_many_files_are_behind() {
    let small = count_stale_inspection(SMALL);
    let large = count_stale_inspection(LARGE);
    assert_eq!(
        small, large,
        "a stale checkout of {SMALL} and of {LARGE} files must cost the same"
    );
}

/// An untracked file's content answers nothing the status characters have not,
/// and reading it means streaming an arbitrarily large file through git while
/// the daemon holds its runtime lock. Reading one changes neither the report
/// nor the invocation count, so the only place it shows is what went down the
/// pipe.
#[test]
fn untracked_files_are_never_fed_to_a_batch() {
    let (_, batched) = inspect_modified(SMALL);
    assert!(
        batched.contains("tracked-0.txt"),
        "sanity: the tracked files did go down the pipe, got {batched:?}"
    );
    // Three batch calls each send every tracked path, so a log holding only
    // one payload's worth means the capture is truncating rather than
    // appending -- which is what `tee` without -a does where /dev/fd/3
    // resolves back to the file. Then this test would be watching one batch
    // and calling it all of them.
    let lines = batched
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    assert!(
        lines >= SMALL * 2,
        "only {lines} paths were captured for {SMALL} files across three batch calls; \
         the stdin capture is truncating, so this gate sees less than it claims"
    );
    assert!(
        !batched.contains("untracked-"),
        "an untracked path was handed to a batch call: {batched}"
    );
}

fn inspect_modified(files: usize) -> (usize, String) {
    let spy = GitSpy::new("modified");
    let repo = spy.dir.join("repo");
    seed_tracked(&repo, files);
    for index in 0..files {
        fs::write(repo.join(format!("tracked-{index}.txt")), "changed\n").expect("modify file");
        fs::write(repo.join(format!("untracked-{index}.txt")), "noise\n").expect("untracked file");
    }
    let counted = spy.count_while(|| {
        let checkout = inspect_git_checkout_coherence(path_str(&repo)).expect("inspect checkout");
        assert_eq!(checkout.status, GitCheckoutCoherenceStatus::Modified);
        assert!(
            checkout.files.len() >= files,
            "every modified file is still reported, got {}",
            checkout.files.len()
        );
        assert!(
            checkout
                .files
                .iter()
                .filter(|file| file.index_status != '?')
                .all(|file| file.head_blob.is_some()),
            "tracked modifications still carry real blobs"
        );
        assert!(
            checkout
                .files
                .iter()
                .filter(|file| file.index_status == '?')
                .all(|file| file.worktree_blob.is_none()),
            "and an untracked file is never reported with a content hash"
        );
    });
    (counted, spy.batched_paths())
}

fn count_stale_inspection(files: usize) -> usize {
    let spy = GitSpy::new("stale");
    let repo = spy.dir.join("repo");
    seed_tracked(&repo, files);
    let base = git_stdout(&repo, &["rev-parse", "--verify", "HEAD"]);
    for index in 0..files {
        fs::write(repo.join(format!("tracked-{index}.txt")), "advanced\n").expect("advance file");
    }
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "advance"]);
    // Index and worktree back at the ancestor, HEAD left ahead of them.
    run_git(&repo, &["checkout", &base, "--", "."]);
    spy.count_while(|| {
        let checkout = inspect_git_checkout_coherence(path_str(&repo)).expect("inspect checkout");
        assert_eq!(
            checkout.status,
            GitCheckoutCoherenceStatus::Stale,
            "the staleness signal delivery refusals depend on must survive batching"
        );
        assert_eq!(checkout.stale_base.as_deref(), Some(base.as_str()));
        assert_eq!(checkout.files.len(), files);
    })
}

struct GitSpy {
    dir: PathBuf,
    bin: PathBuf,
    log: PathBuf,
    /// What the batch calls were fed. The specs travel on stdin, so argv
    /// cannot show which files were actually read.
    stdin_log: PathBuf,
    _guard: MutexGuard<'static, ()>,
}

/// Held for a spy's whole life, not just the counted body: a sibling fixture
/// spawning git while our shim is installed both races `set_var` and lands in
/// our log. Locking only the body reported 1 invocation where there were 8.
fn spy_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl GitSpy {
    fn new(label: &str) -> Self {
        let guard = spy_lock();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aimux-git-spy-{label}-{nanos}"));
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).expect("create shim dir");
        let log = dir.join("git-invocations.log");
        let stdin_log = dir.join("git-stdin.log");
        let shim = bin.join("git");
        fs::write(
            &shim,
            format!(
                "#!/bin/sh\n\
                 printf '%s\\n' \"$*\" >> \"{log}\"\n\
                 case \"$*\" in\n\
                 *--stdin-paths*|*--batch-check*) exec 3>>\"{stdin}\"; tee -a /dev/fd/3 | \"{git}\" \"$@\" ;;\n\
                 *) exec \"{git}\" \"$@\" ;;\n\
                 esac\n",
                log = log.display(),
                stdin = stdin_log.display(),
                git = real_git().display()
            ),
        )
        .expect("write shim");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).expect("chmod shim");
        }
        Self {
            dir,
            bin,
            log,
            stdin_log,
            _guard: guard,
        }
    }

    /// Counts only what `body` spawns. The fixture's own setup runs before the
    /// shim is on `PATH`, so it cannot pad the count.
    fn count_while(&self, body: impl FnOnce()) -> usize {
        let logged = {
            let _path = PathShim::install(&self.bin, &self.log, &self.stdin_log);
            body();
            fs::read_to_string(&self.log).unwrap_or_default()
        };
        let counted = logged
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count();
        assert!(
            counted >= MINIMUM_PLAUSIBLE,
            "only {counted} git invocations were logged, so the shim cannot have been on PATH -- \
             this gate was measuring nothing"
        );
        counted
    }

    /// Every path handed to a batch call, which is the only place the files
    /// actually read are visible.
    fn batched_paths(&self) -> String {
        fs::read_to_string(&self.stdin_log).unwrap_or_default()
    }
}

impl Drop for GitSpy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Restores `PATH` on the way out even if the body panics, so one failing
/// assertion cannot leave the shim installed for everything after it.
struct PathShim {
    previous: String,
}

impl PathShim {
    fn install(bin: &Path, log: &Path, stdin_log: &Path) -> Self {
        let previous = std::env::var("PATH").unwrap_or_default();
        let _ = fs::remove_file(log);
        let _ = fs::remove_file(stdin_log);
        // PATH is process-global, which is why this target is listed in
        // scripts/native-test-serial-targets.txt and why the spy holds a lock.
        unsafe { std::env::set_var("PATH", format!("{}:{previous}", bin.display())) };
        Self { previous }
    }
}

impl Drop for PathShim {
    fn drop(&mut self) {
        unsafe { std::env::set_var("PATH", &self.previous) };
    }
}

/// Resolved from `PATH` once, before any shim is installed, so the shim cannot
/// end up exec'ing itself. Read rather than hardcoded, because the answer
/// differs between this machine and the Linux runners.
fn real_git() -> &'static Path {
    static GIT: OnceLock<PathBuf> = OnceLock::new();
    GIT.get_or_init(|| {
        let path = std::env::var("PATH").unwrap_or_default();
        for dir in path.split(':').filter(|dir| !dir.is_empty()) {
            if dir.contains("aimux-git-spy-") {
                continue;
            }
            let candidate = Path::new(dir).join("git");
            if candidate.is_file() {
                return candidate;
            }
        }
        panic!("no git on PATH to shim");
    })
}

fn seed_tracked(repo: &Path, files: usize) {
    create_repo(repo);
    for index in 0..files {
        fs::write(repo.join(format!("tracked-{index}.txt")), "base\n").expect("seed file");
    }
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "-m", "seed"]);
}

fn create_repo(path: &Path) {
    fs::create_dir_all(path).expect("create repo");
    run_git(path, &["init", "--initial-branch=master"]);
    run_git(path, &["config", "user.email", "aimux-test@example.com"]);
    run_git(path, &["config", "user.name", "Aimux Test"]);
}

fn run_git(cwd: &Path, args: &[&str]) {
    let output = Command::new(real_git())
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_stdout(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new(real_git())
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .expect("run git");
    assert!(output.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("utf8 temp path")
}
