//! What a coherence inspection costs in git invocations.
//!
//! The field-based assertions this replaces could be satisfied by a change
//! that set the flag correctly and still spawned git per file. Only counting
//! execs can prove it does not, so this puts a shim ahead of git on `PATH`
//! and reads the log. It mutates process-global `PATH`, which is why the
//! target is classified serial.

use aimux::git_delivery::{GitCheckoutCoherenceStatus, inspect_git_checkout_coherence};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// A checkout with this many changed files costs the same as one with a few:
/// the point of the batch is that the count stops scaling with the files.
const FILES: usize = 120;

/// Headroom over the handful of invocations an inspection actually makes, so
/// the gate fails on a return to per-file spawning rather than on a tweak.
const BUDGET: usize = 40;

#[test]
fn inspecting_a_modified_checkout_stays_inside_its_spawn_budget() {
    let spy = GitSpy::new("modified-budget");
    let repo = spy.dir.join("repo");
    create_repo(&repo);
    for index in 0..FILES {
        fs::write(repo.join(format!("tracked-{index}.txt")), "base\n").expect("seed file");
    }
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "seed"]);
    for index in 0..FILES {
        fs::write(repo.join(format!("tracked-{index}.txt")), "changed\n").expect("modify file");
    }
    for index in 0..FILES {
        fs::write(repo.join(format!("untracked-{index}.txt")), "noise\n").expect("untracked file");
    }

    let counted = spy.count_while(|| {
        let checkout = inspect_git_checkout_coherence(path_str(&repo)).expect("inspect checkout");
        assert_eq!(checkout.status, GitCheckoutCoherenceStatus::Modified);
        assert!(
            checkout.files.len() >= FILES,
            "every modified file is still reported, got {}",
            checkout.files.len()
        );
        assert!(
            checkout
                .files
                .iter()
                .filter(|file| file.index_status == 'M')
                .all(|file| file.head_blob.is_some()),
            "and tracked modifications still carry real blobs"
        );
    });
    assert!(
        counted <= BUDGET,
        "{FILES} changed files cost {counted} git invocations; a per-file lookup would be in the hundreds"
    );
}

/// The path the review found: HEAD at B with index and worktree at an
/// ancestor, so every entry matches the base and nothing broke the loop early.
/// That cost four spawns per entry per candidate, uncapped.
#[test]
fn inspecting_a_stale_checkout_stays_inside_its_spawn_budget() {
    let spy = GitSpy::new("stale-budget");
    let repo = spy.dir.join("repo");
    create_repo(&repo);
    for index in 0..FILES {
        fs::write(repo.join(format!("tracked-{index}.txt")), "base\n").expect("seed file");
    }
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "base"]);
    let base = git_stdout(&repo, &["rev-parse", "--verify", "HEAD"]);
    for index in 0..FILES {
        fs::write(repo.join(format!("tracked-{index}.txt")), "advanced\n").expect("advance file");
    }
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "advance"]);
    // Index and worktree back at the ancestor, HEAD left ahead of them.
    run_git(&repo, &["checkout", &base, "--", "."]);

    let counted = spy.count_while(|| {
        let checkout = inspect_git_checkout_coherence(path_str(&repo)).expect("inspect checkout");
        assert_eq!(
            checkout.status,
            GitCheckoutCoherenceStatus::Stale,
            "the staleness signal delivery refusals depend on must survive batching"
        );
        assert_eq!(checkout.stale_base.as_deref(), Some(base.as_str()));
        assert_eq!(checkout.files.len(), FILES);
    });
    assert!(
        counted <= BUDGET,
        "a stale checkout of {FILES} files cost {counted} git invocations; the per-entry loop would be over 900"
    );
}

struct GitSpy {
    dir: PathBuf,
    bin: PathBuf,
    log: PathBuf,
}

impl GitSpy {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aimux-git-spy-{label}-{nanos}"));
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).expect("create shim dir");
        let log = dir.join("git-invocations.log");
        let real = real_git();
        let shim = bin.join("git");
        fs::write(
            &shim,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{}\"\nexec \"{}\" \"$@\"\n",
                log.display(),
                real.display()
            ),
        )
        .expect("write shim");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).expect("chmod shim");
        }
        Self { dir, bin, log }
    }

    /// Counts only what `body` spawns: the fixture's own setup runs before the
    /// shim is on `PATH`, so it cannot pad the budget.
    ///
    /// Serialised across tests in this binary. Cargo runs them on threads and
    /// `PATH` is process-global, so two overlapping spies logged into each
    /// other's files and both counts were wrong.
    fn count_while(&self, body: impl FnOnce()) -> usize {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("spy lock poisoned");
        let previous = std::env::var("PATH").unwrap_or_default();
        let _ = fs::remove_file(&self.log);
        // SAFETY-adjacent: PATH is process-global, which is why this target is
        // in native-test-serial-targets.txt.
        unsafe { std::env::set_var("PATH", format!("{}:{previous}", self.bin.display())) };
        body();
        unsafe { std::env::set_var("PATH", &previous) };
        fs::read_to_string(&self.log)
            .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
            .unwrap_or(0)
    }
}

impl Drop for GitSpy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn real_git() -> PathBuf {
    for candidate in [
        "/opt/homebrew/bin/git",
        "/usr/bin/git",
        "/usr/local/bin/git",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    panic!("no real git found to shim");
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
