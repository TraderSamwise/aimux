//! A worktree the topology still lists, whose checkout is gone from disk.
//!
//! Measured on one real project on 2026-10-06: 24 worktrees recorded, 13 with
//! no directory, 5 of those still rendered as live groups with agents in them.
//! Pressing `n` in one produced `tmux failed to create window "codex" ...
//! No such file or directory`, which named tmux on a machine where tmux worked.
//!
//! The verdict is the project service's, taken once, so the TUI and the app
//! say the same thing instead of each asking the filesystem for itself.

use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::project_service::desktop_state::{DesktopStateInput, build_desktop_state};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "aimux-worktree-missing-{label}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn topology_with_worktree(project_root: &str, worktree_path: &str) -> Value {
    json!({
        "version": 1,
        "generatedAt": "1970-01-01T00:00:00.000Z",
        "rigs": [{
            "id": "rig",
            "name": "rig",
            "projectRoot": project_root,
            "createdAt": "1970-01-01T00:00:00.000Z",
            "updatedAt": "1970-01-01T00:00:00.000Z",
        }],
        "nodes": [],
        "edges": [],
        "bindings": [],
        "sessions": [],
        "services": [],
        "worktrees": [{
            "id": "worktree-under-test",
            "rigId": "rig",
            "name": "affiliate-system",
            "path": worktree_path,
            "branch": "affiliate-system",
            "status": "active",
            "createdAt": "1970-01-01T00:00:00.000Z",
            "updatedAt": "1970-01-01T00:00:00.000Z",
        }],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": [],
    })
}

fn group_for(project_root: &str, worktree_path: &str) -> Value {
    let topology = topology_with_worktree(project_root, worktree_path);
    let metadata_sessions = BTreeMap::new();
    let exchange = json!({});
    let state = build_desktop_state(DesktopStateInput {
        project_root: project_root.to_owned(),
        topology: &topology,
        metadata_sessions: &metadata_sessions,
        exchange: &exchange,
    });
    state["worktreeGroups"]
        .as_array()
        .expect("worktree groups")
        .iter()
        .find(|group| group.get("path").and_then(Value::as_str) == Some(worktree_path))
        .cloned()
        .unwrap_or_else(|| panic!("no group for {worktree_path} in {state}"))
}

/// The defect: a worktree whose checkout was deleted still read as ordinary.
#[test]
fn a_worktree_whose_checkout_is_gone_is_marked() {
    let root = scratch("gone");
    let worktree = root.join("worktrees").join("affiliate-system");
    let group = group_for(&root.to_string_lossy(), &worktree.to_string_lossy());

    assert_eq!(
        group.get("pathMissing"),
        Some(&Value::Bool(true)),
        "{group}"
    );
    let _ = fs::remove_dir_all(&root);
}

/// And one that is still there is left alone.
#[test]
fn a_worktree_that_is_still_there_is_not_marked() {
    let root = scratch("present");
    let worktree = root.join("worktrees").join("affiliate-system");
    fs::create_dir_all(&worktree).unwrap();
    let group = group_for(&root.to_string_lossy(), &worktree.to_string_lossy());

    assert_eq!(group.get("pathMissing"), None, "{group}");
    let _ = fs::remove_dir_all(&root);
}

/// A directory we cannot read is NOT a directory we know is gone.
///
/// The inverse that matters: an unavailable mount, a permission error on a
/// parent, a path only another namespace can see. Marking those would tell the
/// user to throw away a worktree that is still there, so only a positive
/// not-found counts.
///
/// The failure is forced with `ENOTDIR` -- a path whose parent is a regular
/// file -- rather than by removing permissions. A mode-0 parent proves nothing
/// when the tests run as root, because root stats through it and the assertion
/// would hold for the wrong reason; `ENOTDIR` is returned to everyone.
#[test]
fn a_worktree_we_cannot_stat_is_not_called_missing() {
    let root = scratch("unreadable");
    let not_a_directory = root.join("sealed");
    fs::write(&not_a_directory, b"this is a file\n").unwrap();
    let worktree = not_a_directory.join("affiliate-system");

    let error =
        fs::metadata(&worktree).expect_err("the stat has to fail for this test to mean anything");
    assert_ne!(
        error.kind(),
        std::io::ErrorKind::NotFound,
        "and fail as something OTHER than not-found: {error}"
    );

    let group = group_for(&root.to_string_lossy(), &worktree.to_string_lossy());

    assert_eq!(
        group.get("pathMissing"),
        None,
        "a directory we could not read must not be reported as deleted: {group}"
    );
    let _ = fs::remove_dir_all(&root);
}

/// The TUI reads the service's verdict rather than deciding for itself.
///
/// Pinned by parsing the served state into the snapshot the renderer consumes:
/// if the field stopped arriving, or the model dropped it, the dashboard would
/// quietly go back to rendering a deleted worktree as an ordinary one.
#[test]
fn the_dashboard_snapshot_carries_the_services_verdict() {
    let root = scratch("snapshot");
    let worktree = root.join("worktrees").join("affiliate-system");
    let topology = topology_with_worktree(&root.to_string_lossy(), &worktree.to_string_lossy());
    let metadata_sessions = BTreeMap::new();
    let exchange = json!({});
    let state = build_desktop_state(DesktopStateInput {
        project_root: root.to_string_lossy().into_owned(),
        topology: &topology,
        metadata_sessions: &metadata_sessions,
        exchange: &exchange,
    });

    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(state).expect("served state parses as a dashboard snapshot");
    let group = snapshot
        .worktree_groups
        .iter()
        .find(|group| group.path.as_deref() == Some(&*worktree.to_string_lossy()))
        .expect("the worktree group");
    assert!(group.path_missing, "the snapshot has to carry the verdict");
    let _ = fs::remove_dir_all(&root);
}

/// Every surface says the same words.
///
/// The TUI row, the TUI detail panel, the worktree picker, the migrate picker
/// and the CLI table all render the one constant; the app's copy is checked
/// against it here rather than trusted. `needs_response` was spelt three
/// different ways across four surfaces in this codebase until someone compared
/// them, and nothing had failed in the meantime.
#[test]
fn every_surface_says_the_checkout_is_missing_the_same_way() {
    let label = aimux::dashboard_renderer::WORKTREE_CHECKOUT_MISSING_LABEL;

    for (path, source) in [
        (
            "dashboard_renderer.rs",
            include_str!("../src/dashboard_renderer.rs"),
        ),
        (
            "dashboard_service_input.rs",
            include_str!("../src/dashboard_service_input.rs"),
        ),
        (
            "dashboard_controller.rs",
            include_str!("../src/dashboard_controller.rs"),
        ),
        (
            "core_text/worktrees.rs",
            include_str!("../src/core_text/worktrees.rs"),
        ),
    ] {
        assert!(
            source.contains("WORKTREE_CHECKOUT_MISSING_LABEL"),
            "{path} has to render the shared label, not its own spelling"
        );
    }

    let app = include_str!("../../../../app/components/WorktreeDashboard.tsx");
    assert!(
        app.contains(&format!("label: \"{label}\"")),
        "the app chip has to carry the same words as the TUI: {label:?}"
    );
}

/// The row a user reads, not only the panel they have to focus.
///
/// The first version marked just the detail panel: a deleted checkout's row
/// summarised as "2 idle" in the ordinary tone while the app's card already
/// carried a red chip, so the two surfaces disagreed in the one place the user
/// looks first.
#[test]
fn the_row_summary_says_it_rather_than_counting_agents() {
    use aimux::dashboard_model::{WorktreeGroup, WorktreeStatus};
    use aimux::dashboard_navigation::dashboard_navigation_groups;

    let mut snapshot = aimux::dashboard_model::DesktopStateSnapshot {
        sessions: Vec::new(),
        teammates: Vec::new(),
        services: Vec::new(),
        worktrees: Vec::new(),
        worktree_groups: vec![WorktreeGroup {
            name: "affiliate-system".into(),
            branch: "affiliate-system".into(),
            path: Some("/gone/affiliate-system".into()),
            status: WorktreeStatus::Active,
            pending: false,
            removing: false,
            path_missing: true,
            pending_action: None,
            operation_failure: None,
            sessions: Vec::new(),
            services: Vec::new(),
            extra: Default::default(),
        }],
        main_checkout_info: aimux::dashboard_model::MainCheckoutInfo {
            name: "Main Checkout".into(),
            branch: "master".into(),
            extra: Default::default(),
        },
        main_checkout_path: Some("/repo".into()),
        worktree_removal: None,
        worktree_removals: Vec::new(),
        agent_restore_offer: None,
        operation_failures: Vec::new(),
        extra: Default::default(),
    };

    let groups = dashboard_navigation_groups(&snapshot);
    let group = groups
        .iter()
        .find(|group| group.path == Some("/gone/affiliate-system"))
        .expect("the worktree group reaches navigation");
    assert!(
        group.path_missing,
        "the verdict has to survive into the navigation group the rows render from"
    );

    snapshot.worktree_groups[0].path_missing = false;
    let unmarked = dashboard_navigation_groups(&snapshot);
    assert!(
        !unmarked
            .iter()
            .find(|group| group.path == Some("/gone/affiliate-system"))
            .expect("the group")
            .path_missing,
        "and must not be invented when the service did not send it"
    );
}
