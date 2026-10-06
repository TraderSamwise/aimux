//! A worktree the topology still lists, whose checkout is gone from disk.
//!
//! Measured on one real project on 2026-10-06: 24 worktrees recorded, 13 with
//! no directory, 5 of those still rendered as live groups with agents in them.
//! Pressing `n` in one produced `tmux failed to create window "codex" ...
//! No such file or directory`, which named tmux on a machine where tmux worked.
//!
//! The verdict is the project service's, taken once, so the TUI and the app
//! say the same thing instead of each asking the filesystem for itself.

use aimux::dashboard_model::{
    DesktopStateSnapshot, MainCheckoutInfo, WorktreeGroup, WorktreeStatus,
};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::project_service::desktop_state::{DesktopStateInput, build_desktop_state};
use aimux::tui_render::text::strip_ansi;
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

fn build_state(project_root: &str, topology: &Value) -> Value {
    let metadata_sessions = BTreeMap::new();
    let exchange = json!({});
    build_desktop_state(DesktopStateInput {
        project_root: project_root.to_owned(),
        topology,
        metadata_sessions: &metadata_sessions,
        exchange: &exchange,
    })
}

/// One worktree group as the service would serve it.
fn worktree_group_value(name: &str, path_missing: bool) -> WorktreeGroup {
    WorktreeGroup {
        name: name.to_owned(),
        branch: name.to_owned(),
        path: Some(format!("/gone/{name}")),
        status: WorktreeStatus::Active,
        pending: false,
        removing: false,
        path_missing,
        pending_action: None,
        operation_failure: None,
        sessions: Vec::new(),
        services: Vec::new(),
        extra: Default::default(),
    }
}

fn missing_group(name: &str, pending_action: Option<&str>) -> WorktreeGroup {
    let mut group = worktree_group_value(name, true);
    group.pending_action = pending_action.map(ToOwned::to_owned);
    group
}

/// Render a real dashboard frame holding one worktree group.
fn render_frame(group: WorktreeGroup) -> String {
    let snapshot = DesktopStateSnapshot {
        sessions: Vec::new(),
        teammates: Vec::new(),
        services: Vec::new(),
        worktrees: Vec::new(),
        worktree_groups: vec![group],
        main_checkout_info: MainCheckoutInfo {
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
    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 120,
        rows: 50,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    strip_ansi(&result.frame)
}

fn group_for(project_root: &str, worktree_path: &str) -> Value {
    let topology = topology_with_worktree(project_root, worktree_path);
    let state = build_state(project_root, &topology);
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
/// The first version marked just the detail panel and a test that only checked
/// the field survived into navigation -- which would have stayed green with
/// every renderer change reverted. This renders a real frame and reads it.
#[test]
fn the_row_a_user_reads_says_the_checkout_is_missing() {
    let frame = render_frame(missing_group("affiliate-system", None));
    assert!(
        frame.contains(aimux::dashboard_renderer::WORKTREE_CHECKOUT_MISSING_LABEL),
        "the rendered dashboard has to say it:\n{frame}"
    );
}

/// And a worktree being CREATED still reads as creating.
///
/// This is the regression the first version shipped: `creating` is minutes of
/// git work with no directory on disk yet, and marking on absence alone turned
/// every ordinary create into a red `checkout missing`. The service declines to
/// mark a checkout that is still arriving, and the renderer puts the in-flight
/// action first -- both halves, because either alone leaves the other path
/// wrong.
#[test]
fn a_worktree_still_being_created_does_not_read_as_a_missing_checkout() {
    let frame = render_frame(missing_group("being-made", Some("creating")));
    assert!(
        !frame.contains(aimux::dashboard_renderer::WORKTREE_CHECKOUT_MISSING_LABEL),
        "a create in flight must not read as a failure:\n{frame}"
    );
    assert!(frame.contains("creating"), "{frame}");
}

/// The service does not mark a checkout that has not arrived yet.
///
/// The other half of the test above, at the source: `ACTIVE_WORKTREE_STATUSES`
/// includes `planned`, `creating` and `removing`, so a bare "no directory"
/// rule marks every worktree mid-create.
#[test]
fn a_worktree_mid_lifecycle_is_never_marked_by_the_service() {
    for status in ["planned", "creating", "removing"] {
        let root = scratch(status);
        let worktree = root.join("worktrees").join("arriving");
        let mut topology =
            topology_with_worktree(&root.to_string_lossy(), &worktree.to_string_lossy());
        topology["worktrees"][0]["status"] = json!(status);
        let state = build_state(&root.to_string_lossy(), &topology);
        let group = state["worktreeGroups"]
            .as_array()
            .expect("groups")
            .iter()
            .find(|group| {
                group.get("path").and_then(Value::as_str) == Some(&*worktree.to_string_lossy())
            });
        if let Some(group) = group {
            assert_eq!(
                group.get("pathMissing"),
                None,
                "a worktree with status {status:?} has no checkout yet: {group}"
            );
        }
        let _ = fs::remove_dir_all(&root);
    }
}

/// The picker a user chooses from says it too.
#[test]
fn the_worktree_picker_says_it() {
    let overlay = aimux::dashboard_service_input::render_worktree_list_overlay(
        &[worktree_group_value("affiliate-system", true)],
        100,
        40,
    );
    assert!(
        strip_ansi(&overlay).contains(aimux::dashboard_renderer::WORKTREE_CHECKOUT_MISSING_LABEL),
        "{overlay}"
    );
}

/// And so does the CLI table, which reads the worktree ROWS, not the groups.
///
/// Marking only the groups left `aimux worktree list` printing every deleted
/// checkout exactly like a live one, and nothing caught it.
#[test]
fn the_cli_worktree_table_says_it() {
    let lines = aimux::core_text::render_core_worktree_list_lines(&json!({
        "worktrees": [{
            "name": "affiliate-system",
            "branch": "affiliate-system",
            "path": "/gone/affiliate-system",
            "pathMissing": true,
        }],
    }))
    .join("\n");
    assert!(
        lines.contains(aimux::dashboard_renderer::WORKTREE_CHECKOUT_MISSING_LABEL),
        "{lines}"
    );
}

/// The top-level worktree row carries the verdict, which is what the CLI reads.
#[test]
fn the_worktree_rows_carry_the_verdict_not_only_the_groups() {
    let root = scratch("rows");
    let worktree = root.join("worktrees").join("affiliate-system");
    let topology = topology_with_worktree(&root.to_string_lossy(), &worktree.to_string_lossy());
    let state = build_state(&root.to_string_lossy(), &topology);

    let row = state["worktrees"]
        .as_array()
        .expect("worktrees")
        .iter()
        .find(|row| row.get("path").and_then(Value::as_str) == Some(&*worktree.to_string_lossy()))
        .unwrap_or_else(|| panic!("no row for the worktree in {state}"));
    assert_eq!(row.get("pathMissing"), Some(&Value::Bool(true)), "{row}");
    let _ = fs::remove_dir_all(&root);
}
