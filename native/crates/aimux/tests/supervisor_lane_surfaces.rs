use aimux::config::merge_config_layers;
use aimux::dashboard_controller::{DashboardController, DashboardControllerEffect, DashboardKey};
use aimux::dashboard_model::{DashboardKept, DesktopStateSnapshot, filter_dashboard_visible_model};
use aimux::dashboard_navigation::{DashboardNavigationGroupKind, dashboard_navigation_groups};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::dashboard_tool_picker::enabled_dashboard_tools;
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
};
use aimux::tui_render::text::strip_ansi;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

struct ProbeDirectory(PathBuf);

impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The TUI half of the comparison, standing in a named lane.
///
/// It used to park on `/feature` for BOTH probes and call the no-Tab result
/// the default, which only matched the app because `n` ignored the cursor
/// entirely. That made the gate agree with the app by reproducing the bug: a
/// user standing in a worktree got a supervisor control agent on both
/// surfaces. The two probes now stand where the app's two chips point, so
/// equal intent is compared with equal intent.
fn spawn_body(snapshot: &DesktopStateSnapshot, lane: Lane) -> Value {
    let mut controller = DashboardController::new(snapshot);
    controller.navigation.worktree_index = dashboard_navigation_groups(snapshot)
        .iter()
        .position(|group| match lane {
            Lane::Supervisor => group.kind == DashboardNavigationGroupKind::Supervisor,
            Lane::Feature => group.path.is_some_and(|path| path.ends_with("/feature")),
            Lane::DefaultFocus => false,
        })
        .unwrap_or_else(|| match lane {
            // The only lane that is not looked up: whatever the controller
            // already focused. A NAMED lane that vanished must not quietly
            // become this one -- the assertion downstream would then report a
            // role mismatch instead of the missing lane.
            Lane::DefaultFocus => controller.navigation.worktree_index,
            other => panic!("the lane under test is gone: {}", other.name()),
        });
    let DashboardControllerEffect::OpenAgentToolPicker(mode) =
        controller.handle_key(snapshot, DashboardKey::NewAgent)
    else {
        panic!("n must open the agent picker");
    };
    controller.open_tool_picker(
        enabled_dashboard_tools(&merge_config_layers(None, None)),
        mode,
    );
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(snapshot, DashboardKey::Enter)
    else {
        panic!("Enter must submit a spawn request");
    };
    assert_eq!(request.path, "/agents/spawn");
    request.body
}

#[derive(Clone, Copy)]
enum Lane {
    Supervisor,
    Feature,
    /// Where the dashboard puts the cursor on a FIRST run, before any saved
    /// navigation is restored.
    DefaultFocus,
}

impl Lane {
    fn name(self) -> &'static str {
        match self {
            Lane::Supervisor => "supervisor",
            Lane::Feature => "feature",
            Lane::DefaultFocus => "default focus",
        }
    }
}

/// The same probe with one Tab, which is the only way to reach the other lane
/// without moving the cursor.
fn tabbed_spawn_body(snapshot: &DesktopStateSnapshot, lane: Lane) -> Value {
    let mut controller = DashboardController::new(snapshot);
    controller.navigation.worktree_index = dashboard_navigation_groups(snapshot)
        .iter()
        .position(|group| match lane {
            Lane::Supervisor => group.kind == DashboardNavigationGroupKind::Supervisor,
            Lane::Feature => group.path.is_some_and(|path| path.ends_with("/feature")),
            Lane::DefaultFocus => panic!("the Tab probe needs a named lane"),
        })
        .expect("the lane under test");
    let DashboardControllerEffect::OpenAgentToolPicker(mode) =
        controller.handle_key(snapshot, DashboardKey::NewAgent)
    else {
        panic!("n must open the agent picker");
    };
    controller.open_tool_picker(
        enabled_dashboard_tools(&merge_config_layers(None, None)),
        mode,
    );
    assert_eq!(
        controller.handle_key(snapshot, DashboardKey::Tab),
        DashboardControllerEffect::Render
    );
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(snapshot, DashboardKey::Enter)
    else {
        panic!("Enter must submit a spawn request");
    };
    request.body
}

#[test]
fn supervisor_lane_visibility_and_new_agent_defaults_match_the_app() {
    let directory = ProbeDirectory(
        std::env::temp_dir().join(format!("aimux-supervisor-surfaces-{}", std::process::id())),
    );
    fs::create_dir_all(directory.0.join("feature")).expect("create isolated project");
    let root = directory.0.to_string_lossy().into_owned();
    let topology = json!({
        "sessions": [], "services": [],
        "worktrees": [{
            "id": "feature", "name": "feature", "branch": "feature", "status": "active",
            "path": directory.0.join("feature").to_string_lossy()
        }]
    });
    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &json!({}),
        },
        Some(&Default::default()),
    );
    assert_eq!(state["supervisorLane"]["sessions"], json!([]));
    assert_eq!(state["agentCreation"]["defaultRole"], "control");
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(state.clone()).expect("desktop snapshot");
    let active = filter_dashboard_visible_model(&snapshot, true, &DashboardKept::default());
    assert!(active.snapshot.worktree_groups.is_empty());
    let rendered = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &active.snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 120,
        rows: 60,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("test"),
        hide_offline_agents: true,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let tui_visible = strip_ansi(&rendered.frame).contains("SUPERVISOR");
    assert!(tui_visible, "the empty supervisor lane must be rendered");
    let default_spawn = spawn_body(&snapshot, Lane::Supervisor);
    let worktree_spawn = spawn_body(&snapshot, Lane::Feature);
    assert_eq!(default_spawn["role"], "control");
    assert!(default_spawn.get("worktreePath").is_none());
    assert_eq!(worktree_spawn["role"], "coder");
    assert!(
        worktree_spawn["worktreePath"]
            .as_str()
            .is_some_and(|path| path.ends_with("/feature")),
        "the worktree probe must carry its own checkout: {worktree_spawn}"
    );
    // Tab still crosses between the two, from the lane the cursor is in.
    assert_eq!(
        tabbed_spawn_body(&snapshot, Lane::Feature),
        default_spawn,
        "Tab out of a worktree must give exactly the supervisor body"
    );
    // The fact the old gate was really pinning, kept rather than dropped: what
    // the two surfaces do when nobody chooses anything.
    //
    // They DIFFER, deliberately. The app has no cursor, so its preselected
    // chip is the policy's `defaultTarget` and it spawns a control in the
    // supervisor lane. The TUI's cursor always names a lane, and its default
    // focus is the main checkout, so it spawns a coder there. Asserted rather
    // than left uncovered, because an undeclared divergence between these two
    // is exactly what this file exists to catch -- if either side changes its
    // untouched default, this fails and the choice gets made on purpose.
    let tui_untouched = spawn_body(&snapshot, Lane::DefaultFocus);
    assert_eq!(
        tui_untouched["role"], "coder",
        "the TUI's default focus is the main checkout"
    );
    assert!(
        tui_untouched.get("worktreePath").is_none(),
        "the main checkout is an absent path: {tui_untouched}"
    );
    // The app's untouched chip is pinned on the app's own side, in
    // lib/supervisor-lane.cross-surface.test.ts, which asserts the Supervisor
    // Lane chip is preselected and that launching it equals `defaultSpawn`.
    // Restating `default_spawn["role"] == "control"` here would only repeat
    // the assertion twelve lines above.
    let probe = directory.0.join("surfaces.json");
    fs::write(
        &probe,
        serde_json::to_vec(&json!({
            "state": state, "defaultSpawn": default_spawn, "worktreeSpawn": worktree_spawn,
            "tuiSupervisorVisible": tui_visible,
        }))
        .expect("serialize observations"),
    )
    .expect("write observations");
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let report = directory.0.join("surface-comparison.json");
    let result = Command::new(project.join("scripts/run-yarn"))
        .current_dir(&project)
        .args([
            "--cwd",
            "app",
            "vitest",
            "run",
            "lib/supervisor-lane.cross-surface.test.ts",
            "--reporter=json",
            &format!(
                "--outputFile={}",
                report.to_str().expect("comparison report path is utf8")
            ),
        ])
        .env("AIMUX_SUPERVISOR_SURFACE_PROBE", &probe)
        .output()
        .expect("run scoped app surface comparison");
    assert!(
        result.status.success(),
        "app/TUI surface comparison failed ({}):\n{}\n{}",
        result.status,
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    // The comparison skips itself when the probe is absent, and a skipped
    // suite exits 0 -- so a lost probe or a renamed env var would read as
    // agreement. Count what actually ran.
    let summary: Value = fs::read(&report)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| {
            panic!(
                "the surface comparison wrote no report:\n{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            )
        });
    let passed = summary["numPassedTests"].as_u64().unwrap_or(0);
    let pending = summary["numPendingTests"].as_u64().unwrap_or(0);
    assert!(
        passed > 0 && pending == 0,
        "the surface comparison did not run: {passed} passed, {pending} skipped"
    );
}

/// A worktree deleted out from under a running agent is still a LANE: the
/// service emits a group for every path a session names, row or no row. It
/// renders as an ordinary healthy checkout -- name from the path basename,
/// `pathMissing` null, because the service has no row and so no verdict.
///
/// Built from the real payload rather than a hand-assembled snapshot. A
/// nav-layer shape that `build_worktree_groups` cannot emit proves nothing,
/// and that is exactly what the first attempt at this guard pinned.
#[test]
fn a_lane_with_no_topology_row_is_never_the_default_destination() {
    let directory = ProbeDirectory(
        std::env::temp_dir().join(format!("aimux-rowless-lane-{}", std::process::id())),
    );
    fs::create_dir_all(&directory.0).expect("create isolated project");
    let root = directory.0.to_string_lossy().into_owned();
    let deleted = directory
        .0
        .join("deleted-wt")
        .to_string_lossy()
        .into_owned();
    let topology = json!({
        "sessions": [{
            "id": "codex-stranded", "status": "running", "tool": "codex",
            "toolConfigKey": "codex", "command": "codex", "worktreePath": deleted
        }],
        "services": [],
        // No row for `deleted`: the worktree is gone from git's point of view.
        "worktrees": []
    });
    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &json!({}),
        },
        Some(&Default::default()),
    );
    let snapshot: DesktopStateSnapshot = serde_json::from_value(state).expect("desktop snapshot");
    let groups = dashboard_navigation_groups(&snapshot);
    let lane = groups
        .iter()
        .position(|group| group.path.is_some_and(|path| path == deleted))
        .expect("the stranded lane must still be rendered");
    assert!(
        !groups[lane].path_missing,
        "the service has no row and so gives no verdict; if it ever does, \
         this test is pinning the wrong thing"
    );

    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.worktree_index = lane;
    let DashboardControllerEffect::OpenAgentToolPicker(mode) =
        controller.handle_key(&snapshot, DashboardKey::NewAgent)
    else {
        panic!("n must open the agent picker");
    };
    controller.open_tool_picker(
        enabled_dashboard_tools(&merge_config_layers(None, None)),
        mode,
    );
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("Enter must submit a spawn request");
    };
    assert!(
        request.body.get("worktreePath").is_none(),
        "a checkout with no row behind it must not be handed to tmux as a cwd: {}",
        request.body
    );
    assert_eq!(request.body["role"], "control");
}

/// The other direction, which the first attempt at this guard broke: a LIVE
/// checkout whose session spells its path with a trailing slash becomes its
/// own nav lane, because navigation buckets by the literal string while the
/// service groups by identity. It has a row, so it is a real destination.
#[test]
fn a_live_checkout_spelled_differently_is_still_a_destination() {
    let directory = ProbeDirectory(
        std::env::temp_dir().join(format!("aimux-spelling-lane-{}", std::process::id())),
    );
    fs::create_dir_all(directory.0.join("feature")).expect("create isolated project");
    let root = directory.0.to_string_lossy().into_owned();
    let feature = directory.0.join("feature").to_string_lossy().into_owned();
    let slashed = format!("{feature}/");
    let topology = json!({
        "sessions": [{
            "id": "codex-slashed", "status": "running", "tool": "codex",
            "toolConfigKey": "codex", "command": "codex", "worktreePath": slashed
        }],
        "services": [],
        "worktrees": [{
            "id": "feature", "name": "feature", "branch": "feature",
            "status": "active", "path": feature
        }]
    });
    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &json!({}),
        },
        Some(&Default::default()),
    );
    let snapshot: DesktopStateSnapshot = serde_json::from_value(state).expect("desktop snapshot");
    let groups = dashboard_navigation_groups(&snapshot);
    let lane = groups
        .iter()
        .position(|group| group.path == Some(slashed.as_str()))
        .expect("the differently spelled lane");

    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.worktree_index = lane;
    let DashboardControllerEffect::OpenAgentToolPicker(mode) =
        controller.handle_key(&snapshot, DashboardKey::NewAgent)
    else {
        panic!("n must open the agent picker");
    };
    controller.open_tool_picker(
        enabled_dashboard_tools(&merge_config_layers(None, None)),
        mode,
    );
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("Enter must submit a spawn request");
    };
    assert_eq!(
        request.body["worktreePath"], slashed,
        "a checkout that exists must stay reachable: {}",
        request.body
    );
    assert_eq!(request.body["role"], "coder");
}
