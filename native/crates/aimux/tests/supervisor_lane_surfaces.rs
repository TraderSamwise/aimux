use aimux::config::merge_config_layers;
use aimux::dashboard_controller::{DashboardController, DashboardControllerEffect, DashboardKey};
use aimux::dashboard_model::{DashboardKept, DesktopStateSnapshot, filter_dashboard_visible_model};
use aimux::dashboard_navigation::dashboard_navigation_groups;
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

fn spawn_body(snapshot: &DesktopStateSnapshot, worktree: bool) -> Value {
    let mut controller = DashboardController::new(snapshot);
    controller.navigation.worktree_index = dashboard_navigation_groups(snapshot)
        .iter()
        .position(|group| group.path.is_some_and(|path| path.ends_with("/feature")))
        .expect("feature group");
    let DashboardControllerEffect::OpenAgentToolPicker(mode) =
        controller.handle_key(snapshot, DashboardKey::NewAgent)
    else {
        panic!("n must open the agent picker");
    };
    controller.open_tool_picker(
        enabled_dashboard_tools(&merge_config_layers(None, None)),
        mode,
    );
    if worktree {
        assert_eq!(
            controller.handle_key(snapshot, DashboardKey::Tab),
            DashboardControllerEffect::Render
        );
    }
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(snapshot, DashboardKey::Enter)
    else {
        panic!("Enter must submit a spawn request");
    };
    assert_eq!(request.path, "/agents/spawn");
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
    let default_spawn = spawn_body(&snapshot, false);
    let worktree_spawn = spawn_body(&snapshot, true);
    assert_eq!(default_spawn["role"], "control");
    assert!(default_spawn.get("worktreePath").is_none());
    assert_eq!(worktree_spawn["role"], "coder");
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
    let result = Command::new(project.join("scripts/run-yarn"))
        .current_dir(&project)
        .args([
            "--cwd",
            "app",
            "vitest",
            "run",
            "lib/supervisor-lane.cross-surface.test.ts",
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
}
