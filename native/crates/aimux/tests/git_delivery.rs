use aimux::git_delivery::{
    GIT_COMMAND_TIMEOUT, GitCheckoutCoherenceStatus, GitDeliveryError,
    inspect_git_checkout_coherence, inspect_git_checkout_coherence_within, verify_git_delivery,
    verify_git_delivery_within,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct TempGitFixture {
    root: PathBuf,
}

impl TempGitFixture {
    fn new(name: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aimux-git-delivery-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temp git fixture root");
        Self { root }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

impl Drop for TempGitFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn standalone_clone_commit_is_reported_undelivered() {
    let fixture = TempGitFixture::new("standalone-clone");
    let source = fixture.path("source");
    let clone = fixture.path("clone");
    create_source_repo(&source);

    run_git(
        &fixture.root,
        &["clone", path_str(&source), path_str(&clone)],
    );
    configure_git_user(&clone);
    fs::write(clone.join("file.txt"), "base\nclone-only\n").expect("update clone file");
    run_git(&clone, &["add", "file.txt"]);
    run_git(&clone, &["commit", "-m", "clone only"]);
    let clone_head = git_output(&clone, &["rev-parse", "HEAD"]);

    let result = verify_git_delivery(path_str(&clone), path_str(&source), "master");

    let Err(GitDeliveryError::Undelivered {
        head_sha,
        shares_object_store,
        ..
    }) = result
    else {
        panic!("standalone clone commit should be undelivered: {result:?}");
    };
    assert_eq!(head_sha, clone_head);
    assert!(
        !shares_object_store,
        "standalone clone must not be reported as sharing the source object store"
    );
    assert!(
        !git_status(
            &source,
            &["cat-file", "-e", &format!("{clone_head}^{{commit}}")]
        )
        .success(),
        "source checkout should not know clone-only commit objects"
    );
}

#[test]
fn linked_worktree_commit_reachable_from_target_ref_passes() {
    let fixture = TempGitFixture::new("linked-worktree");
    let source = fixture.path("source");
    let linked = fixture.path("linked");
    create_source_repo(&source);

    run_git(
        &source,
        &["worktree", "add", "-b", "agent", path_str(&linked)],
    );
    configure_git_user(&linked);
    fs::write(linked.join("file.txt"), "base\nlinked-worktree\n").expect("update linked file");
    run_git(&linked, &["add", "file.txt"]);
    run_git(&linked, &["commit", "-m", "linked worktree"]);
    let linked_head = git_output(&linked, &["rev-parse", "HEAD"]);

    let check =
        verify_git_delivery(path_str(&linked), path_str(&source), "agent").expect("delivered");

    assert_eq!(check.head_sha, linked_head);
    assert!(
        check.shares_object_store,
        "linked worktree must report the same git common dir as the source checkout"
    );
    assert!(
        git_status(
            &source,
            &["cat-file", "-e", &format!("{linked_head}^{{commit}}")]
        )
        .success(),
        "source checkout should immediately know linked-worktree commit objects"
    );
}

#[test]
fn target_checkout_stale_behind_head_is_reported_and_refused() {
    let fixture = TempGitFixture::new("stale-target");
    let source = fixture.path("source");
    let linked = fixture.path("linked");
    create_source_repo(&source);

    run_git(
        &source,
        &["worktree", "add", "-b", "agent", path_str(&linked)],
    );
    configure_git_user(&linked);
    fs::write(linked.join("file.txt"), "base\nlanded\n").expect("update linked file");
    run_git(&linked, &["add", "file.txt"]);
    run_git(&linked, &["commit", "-m", "landed"]);
    let linked_head = git_output(&linked, &["rev-parse", "HEAD"]);
    let previous_master = git_output(&source, &["rev-parse", "HEAD"]);
    run_git(&source, &["update-ref", "refs/heads/master", &linked_head]);

    let checkout = inspect_git_checkout_coherence(path_str(&source)).expect("inspect checkout");
    assert_eq!(checkout.status, GitCheckoutCoherenceStatus::Stale);
    assert_eq!(checkout.head_sha, linked_head);
    assert_eq!(
        checkout.stale_base.as_deref(),
        Some(previous_master.as_str())
    );
    assert_eq!(
        checkout
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["file.txt"]
    );

    let result = verify_git_delivery(path_str(&linked), path_str(&source), "master");
    let Err(GitDeliveryError::StaleTargetCheckout {
        target_project_root,
        files,
        ..
    }) = result
    else {
        panic!("stale target checkout should be refused: {result:?}");
    };
    assert_eq!(target_project_root.as_ref(), path_str(&source));
    assert_eq!(files, ["file.txt"]);
}

#[test]
fn genuine_uncommitted_work_is_modified_not_stale() {
    let fixture = TempGitFixture::new("modified-target");
    let source = fixture.path("source");
    create_source_repo(&source);
    fs::write(source.join("file.txt"), "base\ngenuine work\n").expect("edit source file");

    let checkout = inspect_git_checkout_coherence(path_str(&source)).expect("inspect checkout");
    assert_eq!(checkout.status, GitCheckoutCoherenceStatus::Modified);
    assert_eq!(
        checkout
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["file.txt"]
    );

    let check = verify_git_delivery(path_str(&source), path_str(&source), "master")
        .expect("modified target checkout is not pure staleness");
    assert_eq!(
        check.target_checkout.status,
        GitCheckoutCoherenceStatus::Modified
    );
}

#[test]
fn clean_checkout_is_coherent() {
    let fixture = TempGitFixture::new("coherent-target");
    let source = fixture.path("source");
    create_source_repo(&source);

    let checkout = inspect_git_checkout_coherence(path_str(&source)).expect("inspect checkout");
    assert_eq!(checkout.status, GitCheckoutCoherenceStatus::Coherent);
    assert!(checkout.files.is_empty());
}

/// Untracked files are still reported, and still carry no HEAD or index blob
/// -- a path in neither place has neither, whatever it cost to find out.
#[test]
fn untracked_files_are_reported_without_tracked_blobs() {
    let fixture = TempGitFixture::new("untracked-swarm");
    let source = fixture.path("source");
    create_source_repo(&source);
    for index in 0..60 {
        fs::write(source.join(format!("untracked-{index}.txt")), "noise\n")
            .expect("write untracked file");
    }

    let checkout = inspect_git_checkout_coherence(path_str(&source)).expect("inspect checkout");
    assert_eq!(checkout.status, GitCheckoutCoherenceStatus::Modified);
    // The report renders `files.len()` as the uncommitted count, so dropping
    // them would make that number lie.
    assert_eq!(checkout.files.len(), 60);
    assert!(
        checkout
            .files
            .iter()
            .all(|file| file.head_blob.is_none() && file.index_blob.is_none()),
        "an untracked path is in neither HEAD nor the index"
    );
}

/// A quoted or carriage-returned path cannot ride the batch pipe:
/// `hash-object --stdin-paths` C-unquotes a line starting with `"`, so the
/// batch would answer with the hash of a different file entirely.
#[test]
fn a_quoted_path_is_hashed_as_itself() {
    let fixture = TempGitFixture::new("quoted-path");
    let repo = fixture.path("source");
    create_bare_repo(&repo);
    let quoted = "\"q.txt\"";
    fs::write(repo.join(quoted), "quoted\n").expect("write quoted file");
    fs::write(repo.join("q.txt"), "decoy\n").expect("write decoy file");
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "seed"]);
    fs::write(repo.join(quoted), "quoted changed\n").expect("modify quoted file");
    let truth = git_output(&repo, &["hash-object", "--", quoted]);

    let checkout = inspect_git_checkout_coherence(path_str(&repo)).expect("inspect checkout");
    let file = checkout
        .files
        .iter()
        .find(|file| file.path == quoted)
        .expect("the quoted path is reported");
    assert_eq!(
        file.worktree_blob.as_deref(),
        Some(truth.as_str()),
        "the quoted path must hash as itself, not as q.txt"
    );
}

/// `--untracked-files=normal` is load-bearing for the cost: `all` enumerated
/// every file under an untracked directory, which is what reached 34,990
/// entries on the checkout that wedged.
#[test]
fn an_untracked_directory_collapses_to_one_entry() {
    let fixture = TempGitFixture::new("untracked-collapse");
    let repo = fixture.path("source");
    create_bare_repo(&repo);
    fs::write(repo.join("tracked.txt"), "base\n").expect("seed file");
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "seed"]);
    let nest = repo.join("nest");
    fs::create_dir_all(&nest).expect("create untracked dir");
    for index in 0..50 {
        fs::write(nest.join(format!("file-{index}.txt")), "noise\n").expect("write nested file");
    }

    let checkout = inspect_git_checkout_coherence(path_str(&repo)).expect("inspect checkout");
    assert_eq!(
        checkout.files.len(),
        1,
        "fifty files under one untracked directory is one entry, not fifty"
    );
    assert_eq!(checkout.files[0].index_status, '?');
}

fn create_bare_repo(path: &Path) {
    fs::create_dir_all(path).expect("create repo");
    run_git(path, &["init", "--initial-branch=master"]);
    configure_git_user(path);
}

fn create_source_repo(path: &Path) {
    fs::create_dir_all(path).expect("create source repo");
    run_git(path, &["init", "--initial-branch=master"]);
    configure_git_user(path);
    fs::write(path.join("file.txt"), "base\n").expect("write base file");
    run_git(path, &["add", "file.txt"]);
    run_git(path, &["commit", "-m", "base"]);
}

fn configure_git_user(path: &Path) {
    run_git(path, &["config", "user.email", "aimux-test@example.com"]);
    run_git(path, &["config", "user.name", "Aimux Test"]);
}

fn run_git(cwd: &Path, args: &[&str]) {
    let output = git_command(cwd, args).expect("run git");
    assert!(
        output.status.success(),
        "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_output(cwd: &Path, args: &[&str]) -> String {
    let output = git_command(cwd, args).expect("run git");
    assert!(output.status.success(), "git {:?} failed", args);
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn git_status(cwd: &Path, args: &[&str]) -> std::process::ExitStatus {
    git_command(cwd, args).expect("run git").status
}

fn git_command(cwd: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("git").arg("-C").arg(cwd).args(args).output()
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("utf8 temp path")
}

/// A `git` that never answers must be killed and NAMED, not waited on.
///
/// Every call in this module used to be an unbounded `Command::output()`, and
/// the daemon's coherence report makes them with the global runtime mutex
/// held: on 2026-10-11 a stuck checkout held that lock until `kill -9`. These
/// four tests run the real entry points with the budget already spent, which
/// is the one way to reach the deadline without waiting for a hang.
#[test]
fn a_delivery_check_whose_budget_is_spent_names_the_call_it_gave_up_on() {
    let fixture = TempGitFixture::new("delivery-deadline");
    let source = fixture.path("source");
    create_source_repo(&source);

    let started = Instant::now();
    let result = verify_git_delivery_within(
        path_str(&source),
        path_str(&source),
        "master",
        Duration::ZERO,
    );

    let Err(GitDeliveryError::GitCommand { cwd, args, message }) = result else {
        panic!("a spent budget must be an error, not an answer: {result:?}");
    };
    assert_eq!(cwd.as_ref(), path_str(&source));
    assert_eq!(args, vec!["rev-parse", "--verify", "HEAD"]);
    assert!(
        message.contains("timed out"),
        "the message must say the call was given up on: {message}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "giving up took {:?}, so something is still waiting on the child",
        started.elapsed()
    );
}

#[test]
fn a_coherence_scan_whose_budget_is_spent_is_an_error_not_a_clean_checkout() {
    let fixture = TempGitFixture::new("coherence-deadline");
    let repo = fixture.path("repo");
    create_source_repo(&repo);
    fs::write(repo.join("file.txt"), "base\nmodified\n").expect("modify tracked file");

    let started = Instant::now();
    let result = inspect_git_checkout_coherence_within(path_str(&repo), Duration::ZERO);

    let Err(GitDeliveryError::GitCommand { cwd, args, message }) = result else {
        panic!("a scan that could not ask must not report a coherent checkout: {result:?}");
    };
    assert_eq!(cwd.as_ref(), path_str(&repo));
    assert_eq!(args, vec!["rev-parse", "--show-toplevel"]);
    assert!(message.contains("timed out"), "{message}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// The inverse, and the one that would break the product: the deadline must
/// not change what a healthy `git` answers.
#[test]
fn the_real_budget_still_answers_a_delivery_check() {
    let fixture = TempGitFixture::new("delivery-budget-ok");
    let source = fixture.path("source");
    create_source_repo(&source);

    let bounded = verify_git_delivery_within(
        path_str(&source),
        path_str(&source),
        "master",
        GIT_COMMAND_TIMEOUT,
    )
    .expect("a healthy repo answers within the real budget");
    let unbounded =
        verify_git_delivery(path_str(&source), path_str(&source), "master").expect("same answer");
    assert_eq!(bounded, unbounded);
}

#[test]
fn the_real_budget_still_answers_a_coherence_scan() {
    let fixture = TempGitFixture::new("coherence-budget-ok");
    let repo = fixture.path("repo");
    create_source_repo(&repo);
    fs::write(repo.join("file.txt"), "base\nmodified\n").expect("modify tracked file");

    let bounded = inspect_git_checkout_coherence_within(path_str(&repo), GIT_COMMAND_TIMEOUT)
        .expect("a healthy repo answers within the real budget");
    let unbounded = inspect_git_checkout_coherence(path_str(&repo)).expect("same answer");
    assert_eq!(bounded.status, GitCheckoutCoherenceStatus::Modified);
    assert_eq!(bounded, unbounded);
    // The batch pipe really was exercised, so its bounded path is covered too.
    assert_eq!(bounded.files.len(), 1);
    assert!(bounded.files[0].worktree_blob.is_some());
}
