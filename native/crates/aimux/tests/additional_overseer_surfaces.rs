mod support;

use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::dashboard_model::{DesktopStateSnapshot, dashboard_overseer_sessions};
use aimux::dashboard_navigation::dashboard_navigation_groups;
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::project_api_contract::routes;
use aimux::project_service::agents::overseer_session_ids;
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::runtime_topology::{
    coerce_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::tui_render::text::strip_ansi;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

struct Project(PathBuf);

impl Drop for Project {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove isolated project");
    }
}

fn ids(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|row| row["id"].as_str().expect("session identity").to_owned())
        .collect()
}

fn observe(project: &Project, count: usize, demote: bool) -> Value {
    let root = project.0.to_string_lossy().into_owned();
    let feature = project.0.join("feature").to_string_lossy().into_owned();
    let supervisor = json!({ "kind": "supervisor" });
    let worktree = json!({ "kind": "worktree", "worktreePath": feature });
    let mut entries = vec![
        (
            "alpha",
            9,
            "director-a",
            json!({ "overseer": true, "projectControl": true, "lane": supervisor }),
        ),
        (
            "beta",
            4,
            "director-b",
            json!({ "team": { "role": "overseer" }, "projectControl": !demote, "lane": supervisor }),
        ),
        (
            "scribe",
            5,
            "scribe-only",
            json!({ "scribe": true, "projectControl": true, "lane": supervisor }),
        ),
        (
            "control",
            2,
            "control-only",
            json!({ "projectControl": true, "lane": supervisor }),
        ),
        (
            "overseer-worker",
            1,
            "prefix-decoy",
            json!({ "projectControl": false, "lane": worktree }),
        ),
        (
            "worker",
            8,
            "overseer-fake",
            json!({ "overseer": false, "lane": worktree }),
        ),
        (
            "former",
            3,
            "former-role",
            json!({ "team": { "role": "overseer" }, "projectControl": false, "lane": worktree }),
        ),
        (
            "contradictory",
            7,
            "noncontrol",
            json!({ "overseer": true, "projectControl": false, "lane": supervisor }),
        ),
    ];
    if count == 3 {
        entries.push((
            "gamma",
            6,
            "director-c",
            json!({ "overseer": true, "lane": worktree }),
        ));
    }
    let metadata = entries
        .iter()
        .filter(|(id, _, _, _)| *id != "alpha")
        .map(|(id, _, _, flags)| ((*id).to_owned(), flags.clone()))
        .collect::<BTreeMap<_, _>>();
    let sessions = entries.iter().map(|(id, index, label, flags)| {
        let mut session = json!({
            "id": id, "nodeId": format!("node-{id}"), "command": "claude", "toolConfigKey": "claude",
            "label": label, "worktreePath": feature, "status": "running",
            "createdAt": format!("2026-01-{:02}T00:00:00.000Z", 10 - index),
            "updatedAt": "2026-01-10T00:00:00.000Z",
        });
        if let Some(team) = flags.get("team") {
            session["team"] = team.clone();
        }
        if *id == "alpha" {
            for (key, value) in flags.as_object().expect("topology-only control flags") {
                session[key] = value.clone();
            }
        }
        if *id == "gamma" {
            session["overseer"] = json!(true);
            session["projectControl"] = json!(false);
        }
        if *id == "worker" {
            session["overseer"] = json!(true);
            session["projectControl"] = json!(true);
        }
        session
    }).collect::<Vec<_>>();
    let nodes = entries
        .iter()
        .map(|(id, _, _, _)| {
            json!({
                "id": format!("node-{id}"), "rigId": "rig", "logicalId": id,
                "toolConfigKey": "claude", "cwd": feature, "createdAt": "2026-01-01T00:00:00.000Z",
            })
        })
        .collect::<Vec<_>>();
    let bindings = entries
        .iter()
        .map(|(id, index, _, _)| {
            json!({
                "id": format!("tmux:{id}"), "nodeId": format!("node-{id}"), "tmuxSession": "aimux",
                "tmuxWindowId": format!("@{index}"), "tmuxWindowIndex": index, "tmuxWindowName": id,
                "updatedAt": "2026-01-01T00:00:00.000Z",
            })
        })
        .collect::<Vec<_>>();
    let topology = coerce_runtime_topology(&json!({
        "version": 1, "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig", "name": "repo", "projectRoot": root,
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "sessions": sessions, "nodes": nodes, "bindings": bindings, "services": [],
        "worktrees": [{ "id": "feature", "rigId": "rig", "name": "feature", "branch": "feature",
            "path": feature, "status": "active", "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z" }],
    }))
    .expect("coerce topology");
    let state_dir = project.0.join("state");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).expect("write topology");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: metadata.clone(),
        },
    )
    .expect("write metadata");
    let windows = entries
        .iter()
        .map(|(_, index, _, _)| format!("@{index}"))
        .collect::<Vec<_>>();
    let live = support::live_windows(
        "aimux",
        &windows.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root,
            topology: &topology,
            metadata_sessions: &metadata,
            exchange: &json!({}),
        },
        Some(&live),
    );
    let expected = if demote {
        vec!["gamma", "alpha"]
    } else if count == 3 {
        vec!["beta", "gamma", "alpha"]
    } else {
        vec!["beta", "alpha"]
    };
    assert_eq!(state["overseerSessionIds"], json!(expected));
    assert_eq!(
        overseer_session_ids(state["sessions"].as_array().expect("desktop sessions")),
        expected
    );
    let response = route_project_service_request(
        &ProjectServiceRequestContext::with_project_state_dir(&project.0, &state_dir)
            .with_live_windows(live),
        "GET",
        routes::agents::LIST,
        None,
    );
    assert_eq!(response.status, 200, "agents route: {}", response.body);
    assert_eq!(
        response.body["overseerSessionIds"],
        state["overseerSessionIds"]
    );
    for rows in [&state["sessions"], &response.body["agents"]] {
        let worker = rows
            .as_array()
            .expect("published sessions")
            .iter()
            .find(|session| session["id"] == "worker")
            .expect("demoted worker");
        assert_eq!(worker["projectControl"], false);
        assert_eq!(worker["overseer"], false);
        assert_eq!(worker["lane"]["kind"], "worktree");
    }
    let snapshot: DesktopStateSnapshot = serde_json::from_value(state.clone()).expect("snapshot");
    let overseers = dashboard_overseer_sessions(&snapshot);
    assert_eq!(
        overseers
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        expected
    );
    let overlay = strip_ansi(
        &aimux::tui_screen_renderers::render_overseer_overlay_output(
            &json!({"dashboardOverseerSessionsCache": overseers}),
            160,
            80,
        ),
    );
    let overlay_positions = overseers
        .iter()
        .map(|session| {
            overlay
                .find(session.label.as_deref().expect("overseer label"))
                .expect("every published overseer is rendered in its management overlay")
        })
        .collect::<Vec<_>>();
    assert!(overlay_positions.windows(2).all(|pair| pair[0] < pair[1]));
    let groups = dashboard_navigation_groups(&snapshot);
    let tui_groups = groups.iter().map(|group| json!({
        "supervisor": group.name == "Supervisor", "ids": group.sessions.iter().map(|session| session.id.clone()).collect::<Vec<_>>(),
    })).collect::<Vec<_>>();
    let supervisor_ids = ids(state["supervisorLane"]["sessions"]
        .as_array()
        .expect("supervisor sessions"));
    assert_eq!(
        supervisor_ids,
        ["control", "beta", "scribe", "contradictory", "alpha"]
    );
    assert_eq!(tui_groups[0]["ids"], json!(supervisor_ids));
    let rendered = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &overseers,
        scribe_sessions: &[],
        cols: 160,
        rows: 100,
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
    let text = strip_ansi(&rendered.frame);
    let mut positions = Vec::new();
    for session in groups.iter().flat_map(|group| &group.sessions) {
        let label = session.label.as_deref().expect("unique rendered label");
        positions.push(
            text.find(label)
                .unwrap_or_else(|| panic!("missing {label}:\n{text}")),
        );
    }
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "TUI render must preserve navigation identity order:\n{text}"
    );
    json!({ "name": format!("{count}-overseers-demoted-{demote}"), "state": state,
        "tuiGroups": tui_groups, "tuiOverseerIds": overseers.iter().map(|session| session.id.clone()).collect::<Vec<_>>() })
}

#[test]
fn additional_overseer_identity_order_and_rendering_match_across_surfaces() {
    let project = Project(std::env::temp_dir().join(format!(
        "aimux-additional-overseer-surfaces-{}",
        std::process::id()
    )));
    fs::create_dir_all(project.0.join("feature")).expect("create isolated project");
    let cases = vec![
        observe(&project, 2, false),
        observe(&project, 3, false),
        observe(&project, 3, true),
    ];
    let probe = project.0.join("surfaces.json");
    fs::write(
        &probe,
        serde_json::to_vec(&cases).expect("serialize observations"),
    )
    .expect("write observations");
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let result = Command::new(repository.join("scripts/run-yarn"))
        .current_dir(&repository)
        .args([
            "--cwd",
            "app",
            "vitest",
            "run",
            "lib/overseer-set.cross-surface.test.ts",
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
