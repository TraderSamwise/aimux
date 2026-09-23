//! Moving an agent's plane through the route moves it on every surface.
//!
//! The plane decides where an agent is SHOWN. It is independent of the agent's
//! role and of where its working directory is, so a move has to change every
//! rendering of that agent and change nothing about what the agent IS.
//!
//! The surfaces are compared against each other rather than against a fixture.
//! A test per surface passes happily while the surfaces disagree, which is how
//! this whole class of bug survived.
//!
//! What this does NOT cover: the three ways a person starts a move. The CLI's
//! body-building is pinned in `core_cli.rs`, its translation to a project path
//! in `daemon::text::agents`, and the app's in `agent-actions.test.tsx`. Here
//! the dashboard is covered only as far as the planes its picker offers -- see
//! `the_dashboard_picker_offers_the_planes_the_route_accepts`.

mod support;

use aimux::daemon_state::{MetadataState, load_metadata_state, save_metadata_state};
use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_navigation::dashboard_navigation_groups;
use aimux::project_api_contract::routes;
use aimux::project_service::agent_roles::load_agent_role_registry;
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::switchable_agents::{
    AgentListScope, SwitchableContext, SwitchableListOptions, list_switchable_agent_items,
    topology_switchable_entries_for_context,
};
use aimux::runtime_topology::{
    coerce_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const WORKTREE: &str = "feature";

struct Project {
    root: PathBuf,
    state_dir: PathBuf,
}

impl Project {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-agent-plane-surfaces-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let state_dir = root.join("state");
        let worktree = root.join(WORKTREE);
        fs::create_dir_all(&state_dir).expect("state dir");
        fs::create_dir_all(&worktree).expect("worktree dir");
        let project = Self { root, state_dir };
        project.write_topology();
        project.write_metadata();
        project
    }

    fn worktree_path(&self) -> String {
        self.root.join(WORKTREE).to_string_lossy().into_owned()
    }

    fn root_path(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn context(&self) -> ProjectServiceRequestContext {
        ProjectServiceRequestContext::with_project_state_dir(&self.root, &self.state_dir)
            .with_live_windows(support::live_windows("aimux", &["@1", "@2"]))
    }

    /// `coder` works in the worktree; `boss` is an overseer with NO stored
    /// plane, so it sits in the supervisor plane only because its role puts it
    /// there. Those are the two directions a move has to handle.
    fn write_topology(&self) {
        let sessions = vec![
            session_row("coder", 1, &self.worktree_path()),
            session_row("boss", 2, &self.root_path()),
        ];
        let nodes = sessions
            .iter()
            .map(|session| {
                json!({
                    "id": format!("node-{}", session["id"].as_str().unwrap_or_default()),
                    "rigId": "rig-1",
                    "logicalId": session["id"],
                    "toolConfigKey": "claude",
                    "cwd": session["worktreePath"],
                    "createdAt": "2026-01-01T00:00:00.000Z",
                })
            })
            .collect::<Vec<_>>();
        let bindings = sessions
            .iter()
            .enumerate()
            .map(|(index, session)| {
                json!({
                    "id": format!("tmux:{}", session["id"].as_str().unwrap_or_default()),
                    "nodeId": format!("node-{}", session["id"].as_str().unwrap_or_default()),
                    "tmuxSession": "aimux",
                    "tmuxWindowId": format!("@{}", index + 1),
                    "tmuxWindowIndex": index + 1,
                    "tmuxWindowName": session["id"],
                    "updatedAt": "2026-01-01T00:00:00.000Z",
                })
            })
            .collect::<Vec<_>>();
        let topology = coerce_runtime_topology(&json!({
            "version": 1,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "rigs": [{
                "id": "rig-1",
                "name": "repo",
                "projectRoot": self.root_path(),
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
            }],
            "nodes": nodes,
            "edges": [],
            "bindings": bindings,
            "sessions": sessions,
            "services": [],
            "worktrees": [{
                "id": "worktree-feature",
                "rigId": "rig-1",
                "path": self.worktree_path(),
                "name": WORKTREE,
                "branch": WORKTREE,
                "status": "active",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
            }],
            "worktreeGraveyard": [],
            "teamRoles": [],
            "remoteClients": [],
            "lifecycleOperations": [],
            "exchangeRefs": [],
        }))
        .expect("coerce topology");
        write_runtime_topology(runtime_topology_path(&self.state_dir), &topology)
            .expect("write topology");
    }

    fn write_metadata(&self) {
        save_metadata_state(
            &self.state_dir,
            &MetadataState {
                version: 1,
                sessions: BTreeMap::from([
                    (
                        "coder".into(),
                        json!({ "worktreePath": self.worktree_path() }),
                    ),
                    (
                        "boss".into(),
                        json!({ "overseer": true, "projectControl": true }),
                    ),
                ]),
            },
        )
        .expect("write metadata");
    }

    fn topology(&self) -> Value {
        aimux::runtime_topology::read_runtime_topology(runtime_topology_path(&self.state_dir))
            .expect("read topology")
    }

    fn desktop_state(&self) -> Value {
        build_desktop_state_with_live_window_ids(
            DesktopStateInput {
                project_root: self.root_path(),
                topology: &self.topology(),
                metadata_sessions: &load_metadata_state(&self.state_dir).sessions,
                exchange: &json!({}),
            },
            Some(&support::live_windows("aimux", &["@1", "@2"])),
        )
    }

    fn move_plane(&self, session_id: &str, lane: Value) {
        let response = route_project_service_request(
            &self.context(),
            "POST",
            routes::agents::PLANE,
            Some(&json!({ "sessionId": session_id, "lane": lane })),
        );
        assert_eq!(
            response.status, 200,
            "plane move refused: {}",
            response.body
        );
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn session_row(id: &str, index: usize, worktree_path: &str) -> Value {
    json!({
        "id": id,
        "nodeId": format!("node-{id}"),
        "tool": "claude",
        "toolConfigKey": "claude",
        "command": "claude",
        "args": [],
        "label": id,
        "worktreePath": worktree_path,
        "status": "running",
        "createdAt": format!("2026-01-0{index}T00:00:00.000Z"),
        "updatedAt": format!("2026-01-0{index}T00:00:00.000Z"),
    })
}

fn ids(sessions: &[Value]) -> Vec<String> {
    sessions
        .iter()
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect()
}

/// Who the GUI payload puts in the supervisor lane.
fn payload_supervisor_lane(state: &Value) -> Vec<String> {
    ids(&state["supervisorLane"]["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

/// Who the TUI dashboard puts there. This re-partitions the sessions itself
/// rather than reading `worktreeGroups`, so it is a second answer, not an echo.
fn dashboard_supervisor_lane(state: &Value) -> Vec<String> {
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(state.clone()).expect("desktop state snapshot");
    dashboard_navigation_groups(&snapshot)
        .iter()
        .filter(|group| group.name.to_ascii_lowercase().contains("supervisor"))
        .flat_map(|group| group.sessions.iter().map(|session| session.id.clone()))
        .collect()
}

/// The registry is a second store. `set_agent_plane` writes both it and the
/// session metadata, and the `/agents` route is the one path that overlays the
/// registry on top -- an overlay that once recomputed the plane and clobbered
/// what was stored. Every other surface reads metadata alone and would stay
/// green through that.
fn agents_route_lane(project: &Project, session_id: &str) -> Value {
    let response =
        route_project_service_request(&project.context(), "GET", routes::agents::LIST, None);
    assert_eq!(response.status, 200, "{}", response.body);
    response.body["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .find(|agent: &Value| agent.get("id").and_then(Value::as_str) == Some(session_id))
        .map(|agent| agent.get("lane").cloned().unwrap_or(Value::Null))
        .unwrap_or(Value::Null)
}

/// The registry is the second store, and on `/agents` it OVERRIDES metadata.
/// So a lane that is written to metadata but not to the registry reads fine
/// today and diverges the moment something writes a stale registry entry --
/// assert the store itself, not only what a read of it happens to produce.
fn registry_lane(project: &Project, session_id: &str) -> Value {
    load_agent_role_registry(&project.state_dir)
        .expect("role registry")
        .get("sessions")
        .and_then(|sessions| sessions.get(session_id))
        .and_then(|entry| entry.get("lane"))
        .cloned()
        .unwrap_or(Value::Null)
}

/// The footer chips scope to one worktree and drop the supervisor plane
/// entirely, so a single render proves nothing: read the same state from both
/// sides of the scope.
fn chip_names(state: &Value, project_root: &str, current_path: &str) -> String {
    let rendered = aimux::project_service::statusline::render_tmux_statusline_contract(&json!({
        "data": state,
        "projectRoot": project_root,
        "line": "bottom",
        "options": { "currentPath": current_path, "width": 400 },
    }));
    rendered["text"].as_str().unwrap_or_default().to_owned()
}

fn switchable_ids(project: &Project) -> Vec<String> {
    let context = project.context();
    let metadata = load_metadata_state(&project.state_dir).sessions;
    let projection =
        topology_switchable_entries_for_context(&context, &project.topology(), &metadata);
    let switch_context = SwitchableContext {
        project_root: project.root_path(),
        current_path: Some(project.root_path()),
        current_window: None,
        current_window_id: Some("@1".into()),
        current_client_session: Some("client-1".into()),
    };
    list_switchable_agent_items(
        &projection.entries,
        &metadata,
        &switch_context,
        &SwitchableListOptions {
            scope: AgentListScope::All,
            use_expose_role_visibility: true,
            ..SwitchableListOptions::default()
        },
        &json!({}),
    )
    .into_iter()
    .map(|item| item.id)
    .collect()
}

#[test]
fn a_plane_move_through_the_route_moves_the_agent_on_every_surface() {
    let project = Project::new("move");
    let root = project.root_path();
    let worktree = project.worktree_path();

    // Before: boss is in the supervisor plane because of its ROLE, with nothing
    // stored; coder is in its worktree.
    let before = project.desktop_state();
    assert_eq!(payload_supervisor_lane(&before), vec!["boss".to_owned()]);
    assert_eq!(dashboard_supervisor_lane(&before), vec!["boss".to_owned()]);
    assert!(
        chip_names(&before, &root, &worktree).contains("coder"),
        "coder starts as a chip in its own worktree"
    );
    assert!(
        !chip_names(&before, &root, &root).contains("boss"),
        "the chips drop the supervisor plane, so boss starts absent"
    );

    project.move_plane("coder", json!({ "kind": "supervisor" }));
    project.move_plane("boss", json!({ "kind": "worktree", "worktreePath": root }));

    let after = project.desktop_state();
    assert_eq!(
        payload_supervisor_lane(&after),
        vec!["coder".to_owned()],
        "the GUI payload follows the move in both directions"
    );
    assert_eq!(
        dashboard_supervisor_lane(&after),
        vec!["coder".to_owned()],
        "the TUI decides the lane for itself and has to reach the same answer"
    );
    assert!(
        !chip_names(&after, &root, &worktree).contains("coder"),
        "coder left its worktree's chips for the supervisor plane"
    );
    assert!(
        chip_names(&after, &root, &root).contains("boss"),
        "boss left the supervisor plane and became a chip in the main checkout"
    );
    assert_eq!(
        agents_route_lane(&project, "coder"),
        json!({ "kind": "supervisor" }),
        "the registry overlay must carry the stored plane, not recompute it"
    );
    assert_eq!(
        registry_lane(&project, "coder"),
        json!({ "kind": "supervisor" }),
        "both stores have to hold the move, or they disagree the moment one is read first"
    );
    assert_eq!(
        registry_lane(&project, "boss"),
        json!({ "kind": "worktree", "worktreePath": root })
    );

    // Everything that decides what an agent IS is untouched by where it shows.
    let boss = load_metadata_state(&project.state_dir).sessions["boss"].clone();
    assert_eq!(boss["overseer"], json!(true));
    assert_eq!(boss["projectControl"], json!(true));
    let rendered_boss = after["worktreeGroups"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|group| group["sessions"].as_array().cloned().unwrap_or_default())
        .find(|session| session["id"] == json!("boss"))
        .expect("boss renders in a worktree group");
    assert_eq!(rendered_boss["overseer"], json!(true));
    assert_eq!(rendered_boss["roleState"]["role"], json!("overseer"));
    assert_eq!(
        rendered_boss["worktreePath"],
        json!(root),
        "a plane move must not relocate the working directory"
    );

    // The switcher is the list n/p and Exposé walk.
    let switchable = switchable_ids(&project);
    assert!(
        switchable.contains(&"coder".to_owned()) && switchable.contains(&"boss".to_owned()),
        "both agents stay switchable after moving planes: {switchable:?}"
    );
}

/// Clearing drops the stored plane, so the derived one takes over again. For an
/// overseer that means going back to the supervisor plane without its role ever
/// having changed.
#[test]
fn clearing_a_plane_returns_an_agent_to_the_one_its_role_implies() {
    let project = Project::new("clear");
    let root = project.root_path();

    project.move_plane("boss", json!({ "kind": "worktree", "worktreePath": root }));
    let moved = project.desktop_state();
    assert!(payload_supervisor_lane(&moved).is_empty());

    project.move_plane("boss", Value::Null);
    let cleared = project.desktop_state();
    assert_eq!(payload_supervisor_lane(&cleared), vec!["boss".to_owned()]);
    assert_eq!(dashboard_supervisor_lane(&cleared), vec!["boss".to_owned()]);
    assert_eq!(
        agents_route_lane(&project, "boss"),
        json!({ "kind": "supervisor" }),
        "cleared, the plane is derived again rather than stored"
    );
    assert_eq!(
        registry_lane(&project, "boss"),
        Value::Null,
        "clearing has to remove the registry entry too, not leave it to win later"
    );
}

/// The dashboard's own picker has to offer the planes the route accepts, or the
/// key opens a menu whose entries are refused.
#[test]
fn the_dashboard_picker_offers_the_planes_the_route_accepts() {
    let project = Project::new("picker");
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(project.desktop_state()).expect("desktop state snapshot");
    let targets = aimux::dashboard_controller::plane_picker_targets(&snapshot);

    let labels = targets
        .iter()
        .map(|target| target.label.as_str())
        .collect::<Vec<_>>();
    assert!(labels.contains(&"supervisor"), "{labels:?}");
    assert!(labels.contains(&"default (by role)"), "{labels:?}");
    assert!(
        labels.iter().any(|label| label.contains(WORKTREE)),
        "the worktree plane has to be offered too: {labels:?}"
    );

    for target in targets {
        let Some(lane) = target.lane.clone() else {
            continue;
        };
        let response = route_project_service_request(
            &project.context(),
            "POST",
            routes::agents::PLANE,
            Some(&json!({ "sessionId": "coder", "lane": lane })),
        );
        assert_eq!(
            response.status, 200,
            "the picker offered a plane the route refuses: {} -> {}",
            target.label, response.body
        );
    }
}
