use aimux::project_api_contract::routes;
use aimux::project_service::agent_roles::agent_role_registry_path;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::topology::{
    build_project_topology, build_topology_worktrees_from_desktop_state, health_for_status,
    rollup_health,
};
use serde_json::json;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn health_for_status_maps_status_and_pending_action() {
    assert_eq!(health_for_status(Some("running"), None), "active");
    assert_eq!(health_for_status(Some("waiting"), None), "attention");
    assert_eq!(health_for_status(Some("idle"), None), "idle");
    assert_eq!(health_for_status(Some("offline"), None), "offline");
    assert_eq!(health_for_status(Some("exited"), None), "offline");
    // In flight, whatever it is spelled: the vocabulary is closed today, but an
    // action nobody here has heard of is still an action under way.
    assert_eq!(
        health_for_status(Some("running"), Some("stopping")),
        "active"
    );
    assert_eq!(
        health_for_status(Some("running"), Some("resurrecting")),
        "active"
    );
    assert_eq!(health_for_status(Some("waiting"), None), "attention");
    assert_eq!(health_for_status(None, None), "idle");
}

#[test]
fn rollup_health_returns_highest_priority_health() {
    assert_eq!(rollup_health(&[]), "idle");
    assert_eq!(rollup_health(&["offline", "idle"]), "idle");
    assert_eq!(rollup_health(&["idle", "active"]), "active");
    assert_eq!(rollup_health(&["active", "attention"]), "attention");
    assert_eq!(rollup_health(&["offline", "offline"]), "offline");
}

#[test]
fn builds_worktree_views_rows_counts_and_project_health() {
    let topology = build_project_topology(
        "aimux",
        vec![
            json!({
                "name": "main",
                "branch": "master",
                "path": "/repo",
                "status": "active",
                "sessions": [
                    { "id": "a1", "command": "claude", "label": "coder", "role": "coder", "status": "running" },
                    { "id": "a2", "command": "codex", "status": "waiting" },
                ],
                "services": [{ "id": "s1", "command": "yarn dev", "label": "web", "status": "running" }],
            }),
            json!({
                "name": "wt-x",
                "branch": "feat/x",
                "path": "/repo/wt-x",
                "status": "offline",
                "sessions": [{ "id": "a3", "command": "claude", "status": "offline" }],
                "services": [],
            }),
        ],
        None,
    );

    assert_eq!(
        topology["counts"],
        json!({ "worktrees": 2, "agents": 3, "services": 1 })
    );
    assert_eq!(topology["worktrees"][0]["health"], "attention");
    assert_eq!(topology["worktrees"][1]["health"], "offline");
    assert_eq!(topology["health"], "attention");
    assert_eq!(
        topology["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["worktree", "agent", "agent", "service", "worktree", "agent"]
    );
    let agent_row = find_row(&topology, "sessionId", "a1");
    assert_eq!(agent_row["kind"], "agent");
    assert_eq!(agent_row["depth"], 1);
    assert_eq!(agent_row["label"], "coder");
    assert_eq!(agent_row["detail"], "coder");
    assert_eq!(agent_row["health"], "active");
    let service_row = find_row(&topology, "serviceId", "s1");
    assert_eq!(service_row["kind"], "service");
    assert_eq!(service_row["health"], "active");
    assert_eq!(service_row["worktreePath"], "/repo");
}

#[test]
fn treats_pending_and_removing_worktree_health_specially() {
    let topology = build_project_topology(
        "aimux",
        vec![
            json!({
                "name": "creating",
                "branch": "feat/new",
                "pending": true,
                "sessions": [],
                "services": [],
            }),
            json!({
                "name": "dying",
                "branch": "feat/old",
                "removing": true,
                "sessions": [{ "id": "x", "command": "claude", "status": "running" }],
                "services": [],
            }),
        ],
        None,
    );
    // Both are work in flight, not a checkout asking for the person and not one
    // that is already gone: `offline` is what a removal leaves behind, not what
    // it looks like while it runs.
    assert_eq!(topology["worktrees"][0]["health"], "active");
    assert_eq!(topology["worktrees"][1]["health"], "active");
}

#[test]
fn groups_desktop_state_sessions_teammates_and_services_by_worktree() {
    let state = json!({
        "sessions": [
            { "id": "live-1", "command": "claude", "status": "running", "worktreePath": "/repo" },
            { "id": "main-1", "command": "shell", "status": "idle" },
        ],
        "teammates": [{ "id": "team-1", "command": "codex", "status": "waiting", "worktreePath": "/repo" }],
        "services": [{ "id": "svc-1", "command": "yarn dev", "status": "running", "worktreePath": "/repo" }],
        "worktrees": [
            { "name": "main", "path": "/repo", "branch": "master" },
            { "name": "empty", "path": "/empty", "branch": "empty" },
        ],
    });

    let worktrees = build_topology_worktrees_from_desktop_state(&state);
    assert_eq!(worktrees[0]["status"], "active");
    assert_eq!(worktrees[0]["sessions"].as_array().unwrap().len(), 3);
    assert_eq!(worktrees[0]["services"].as_array().unwrap().len(), 1);
    assert_eq!(worktrees[1]["status"], "offline");
    assert_eq!(worktrees[1]["sessions"].as_array().unwrap().len(), 0);
}

#[test]
fn route_serves_topology_from_injected_or_derived_desktop_state() {
    let project = temp_project("route-derived");
    let state_dir = project.join("state");
    let derived = route_project_service_request(
        &ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir),
        "GET",
        routes::TOPOLOGY,
        None,
    );
    assert_eq!(derived.status, 200);
    assert_eq!(derived.body["ok"], true);
    assert_eq!(
        derived.body["topology"]["counts"],
        json!({ "worktrees": 1, "agents": 0, "services": 0 })
    );
    cleanup(project);

    let context = ProjectServiceRequestContext::new("/repo").with_desktop_state(json!({
        "mainCheckoutInfo": { "name": "aimux" },
        "sessions": [
            { "id": "live-1", "command": "claude", "status": "running", "worktreePath": "/repo" },
            { "id": "main-1", "command": "shell", "status": "idle" },
        ],
        "teammates": [{ "id": "team-1", "command": "codex", "status": "waiting", "worktreePath": "/repo" }],
        "services": [{ "id": "svc-1", "command": "yarn dev", "status": "running", "worktreePath": "/repo" }],
        "worktrees": [
            { "name": "main", "path": "/repo", "branch": "master" },
            { "name": "empty", "path": "/empty", "branch": "empty" },
        ],
    }));
    let response = route_project_service_request(&context, "GET", routes::TOPOLOGY, None);
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["topology"]["projectName"], "aimux");
    assert_eq!(
        response.body["topology"]["counts"],
        json!({ "worktrees": 2, "agents": 3, "services": 1 })
    );
    assert!(
        response.body["topology"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "worktree"
                && row["label"] == "empty"
                && row["status"] == "offline")
    );
    assert!(
        response.body["topology"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "agent" && row["sessionId"] == "team-1")
    );
    assert!(
        response.body["topology"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "service" && row["serviceId"] == "svc-1")
    );
}

/// A tree is drawn from edges, so the response has to carry them.
///
/// Both of them: `parentSessionId` is who spawned an agent and `watchedBy` is
/// who runs its loop, and neither implies the other -- a `/watch` binding
/// exists on sessions with no team parent at all. Topology builds from desktop
/// state, which never loads the role registry, so before this the response had
/// no supervision edge and every agent read as a direct report of its checkout.
#[test]
fn topology_rows_name_each_agents_own_manager() {
    let registry = json!({
        "version": 1,
        "sessions": {},
        "watchBindings": { "mid": "top", "coder": "mid" },
        "roleSlots": {}
    });
    let topology = build_project_topology(
        "aimux",
        vec![json!({
            "name": "main",
            "branch": "master",
            "path": "/repo",
            "status": "active",
            "sessions": [
                { "id": "top", "command": "claude", "label": "Lead", "role": "overseer", "status": "running" },
                { "id": "mid", "command": "claude", "label": "Mid", "role": "overseer", "status": "running",
                  "team": { "parentSessionId": "top" } },
                { "id": "coder", "command": "codex", "label": "Coder", "role": "coder", "status": "running",
                  "team": { "parentSessionId": "mid" } },
            ],
            "services": [],
        })],
        Some(&registry),
    );

    let top = find_row(&topology, "sessionId", "top");
    assert!(
        top.get("watchedBy").is_none(),
        "the top of the tree answers to nobody: {top}"
    );
    assert!(top.get("parentSessionId").is_none(), "{top}");

    let mid = find_row(&topology, "sessionId", "mid");
    assert_eq!(mid["watchedBy"], "top", "{mid}");
    assert_eq!(mid["parentSessionId"], "top", "{mid}");

    // The leaf answers to the middle manager, not to the top. A response that
    // named the root for every agent would still pass a one-level assertion.
    let coder = find_row(&topology, "sessionId", "coder");
    assert_eq!(coder["watchedBy"], "mid", "{coder}");
    assert_eq!(coder["parentSessionId"], "mid", "{coder}");
}

/// Who spawned an agent is not who runs its loop.
///
/// Every `/watch` binding in the project is on a session with no team parent,
/// so a response that filled one field from the other would be wrong in the
/// only case the edge is actually used.
#[test]
fn the_two_parent_edges_are_reported_separately() {
    let registry = json!({
        "version": 1,
        "sessions": {},
        "watchBindings": { "adopted": "watcher" },
        "roleSlots": {}
    });
    let topology = build_project_topology(
        "aimux",
        vec![json!({
            "name": "main",
            "branch": "master",
            "path": "/repo",
            "sessions": [
                { "id": "watcher", "command": "claude", "status": "running" },
                { "id": "adopted", "command": "codex", "status": "running",
                  "team": { "parentSessionId": "spawner" } },
                { "id": "spawner", "command": "claude", "status": "running" },
            ],
            "services": [],
        })],
        Some(&registry),
    );

    let adopted = find_row(&topology, "sessionId", "adopted");
    assert_eq!(adopted["watchedBy"], "watcher", "{adopted}");
    assert_eq!(adopted["parentSessionId"], "spawner", "{adopted}");
}

/// A project with no bindings has no edges, and says so by omission.
///
/// The registry a project that never bound a watch loads is an empty one, not
/// an absent one -- that is the shape the route actually hands the builder, so
/// it is the shape asserted here. `None` is checked too, because the builder's
/// signature allows it and the desktop-state tests use it.
#[test]
fn an_empty_registry_leaves_the_supervision_edge_absent() {
    let worktree = json!({
        "name": "main",
        "branch": "master",
        "path": "/repo",
        "sessions": [{ "id": "solo", "command": "claude", "status": "running" }],
        "services": [],
    });
    let empty = aimux::project_service::agent_roles::empty_agent_role_registry();
    for registry in [Some(&empty), None] {
        let topology = build_project_topology("aimux", vec![worktree.clone()], registry);
        let row = find_row(&topology, "sessionId", "solo");
        assert!(row.get("watchedBy").is_none(), "{row}");
        assert!(row.get("parentSessionId").is_none(), "{row}");
    }
}

/// The route has to be the thing that loads it.
///
/// A helper proved in isolation says nothing about whether the response a
/// client reads carries the edge: the builder takes `Option<&Value>`, and a
/// route passing `None` would satisfy every assertion above.
#[test]
fn the_route_reads_the_supervision_edge_from_the_registry_on_disk() {
    let project = temp_project("route-watch-bindings");
    let state_dir = project.join("state");
    std::fs::create_dir_all(&state_dir).expect("state dir");
    std::fs::write(
        agent_role_registry_path(&state_dir),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "sessions": {},
            "watchBindings": { "coder-1": "mid-1", "mid-1": "top-1" },
            "roleSlots": {}
        }))
        .expect("serialize registry"),
    )
    .expect("write registry");

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_desktop_state(json!({
            "mainCheckoutInfo": { "name": "aimux" },
            "mainCheckoutPath": "/repo",
            "sessions": [
                { "id": "top-1", "command": "claude", "status": "running", "worktreePath": "/repo" },
                { "id": "mid-1", "command": "claude", "status": "running", "worktreePath": "/repo",
                  "team": { "parentSessionId": "top-1" } },
                { "id": "coder-1", "command": "codex", "status": "running", "worktreePath": "/repo" },
            ],
            "services": [],
            "worktrees": [{ "name": "main", "path": "/repo", "branch": "master" }],
        }));
    let response = route_project_service_request(&context, "GET", routes::TOPOLOGY, None);

    assert_eq!(response.status, 200, "{:?}", response.body);
    let topology = &response.body["topology"];
    assert_eq!(
        find_row(topology, "sessionId", "coder-1")["watchedBy"],
        "mid-1",
        "the route served rows with no supervision edge: {:?}",
        response.body
    );
    assert_eq!(
        find_row(topology, "sessionId", "mid-1")["watchedBy"],
        "top-1"
    );
    assert_eq!(
        find_row(topology, "sessionId", "mid-1")["parentSessionId"],
        "top-1"
    );
    cleanup(project);
}

/// A corrupt registry is not a project with no managers.
///
/// Read as empty, it would draw a tree flat and hand the person a confident
/// wrong org chart. The loader already answers `Ok(empty)` for a project that
/// never bound a watch, so an error here is a real failure and is reported.
#[test]
fn the_route_refuses_a_corrupt_registry_rather_than_drawing_it_flat() {
    let project = temp_project("route-corrupt-registry");
    let state_dir = project.join("state");
    std::fs::create_dir_all(&state_dir).expect("state dir");
    std::fs::write(agent_role_registry_path(&state_dir), "{ not json").expect("write registry");

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_desktop_state(json!({
            "mainCheckoutInfo": { "name": "aimux" },
            "sessions": [{ "id": "solo", "command": "claude", "status": "running" }],
            "services": [],
            "worktrees": [{ "name": "main", "path": "/repo", "branch": "master" }],
        }));
    let response = route_project_service_request(&context, "GET", routes::TOPOLOGY, None);

    assert_eq!(response.status, 500, "{:?}", response.body);
    assert_eq!(response.body["ok"], false);
    assert!(
        response.body["error"]
            .as_str()
            .is_some_and(|error| error.contains("agent-role-registry.json")),
        "the refusal must name what could not be read: {:?}",
        response.body
    );
    cleanup(project);
}

fn find_row<'a>(topology: &'a serde_json::Value, key: &str, value: &str) -> &'a serde_json::Value {
    topology["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row[key] == value)
        .expect("row")
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-topology-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}

/// Absent is carried as absent.
///
/// The row's weight reads `recentOutput != Some(false)`, so turning an
/// unanswered question into `false` would draw a plain name on this screen for
/// an agent the dashboard draws bold.
#[test]
fn an_unanswered_question_is_not_carried_as_a_no() {
    let worktrees = vec![serde_json::json!({
        "name": "feature-a",
        "path": "/repo/.aimux/worktrees/feature-a",
        "status": "active",
        "sessions": [
            { "id": "codex-1", "command": "codex", "status": "running", "label": "Coder" }
        ],
        "services": []
    })];
    let topology =
        aimux::project_service::topology::build_project_topology("repo", worktrees, None);
    let row = find_rows(&topology)
        .into_iter()
        .find(|row| row["sessionId"] == "codex-1")
        .expect("the agent has a row");
    assert!(
        row.get("recentOutput").is_none(),
        "a session with no published answer must not be carried as a quiet \
         one: {row}"
    );
}

fn find_rows(topology: &serde_json::Value) -> Vec<serde_json::Value> {
    fn walk(value: &serde_json::Value, out: &mut Vec<serde_json::Value>) {
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    walk(item, out);
                }
            }
            serde_json::Value::Object(map) => {
                if map.contains_key("kind") && map.contains_key("depth") {
                    out.push(value.clone());
                    return;
                }
                for nested in map.values() {
                    walk(nested, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(topology, &mut out);
    out
}
