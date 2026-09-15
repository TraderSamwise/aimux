use aimux::git_delivery::{
    GitCheckoutCoherenceStatus, GitDeliveryError, inspect_git_checkout_coherence,
    verify_git_delivery,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

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
