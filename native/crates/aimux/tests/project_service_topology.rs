use aimux::project_api_contract::routes;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::topology::{
    build_project_topology, build_topology_worktrees_from_desktop_state, health_for_status,
    rollup_health,
};
use serde_json::json;

#[test]
fn health_for_status_maps_status_and_pending_action() {
    assert_eq!(health_for_status(Some("running"), None), "active");
    assert_eq!(health_for_status(Some("waiting"), None), "attention");
    assert_eq!(health_for_status(Some("idle"), None), "idle");
    assert_eq!(health_for_status(Some("offline"), None), "offline");
    assert_eq!(health_for_status(Some("exited"), None), "offline");
    assert_eq!(
        health_for_status(Some("running"), Some("stopping")),
        "attention"
    );
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
    );
    assert_eq!(topology["worktrees"][0]["health"], "attention");
    assert_eq!(topology["worktrees"][1]["health"], "offline");
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
fn route_serves_topology_from_injected_desktop_state_and_501_without_it() {
    let unsupported = route_project_service_request(
        &ProjectServiceRequestContext::new("/repo"),
        "GET",
        routes::TOPOLOGY,
        None,
    );
    assert_eq!(unsupported.status, 501);
    assert_eq!(
        unsupported.body["error"],
        "desktop state not supported by this service"
    );

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

fn find_row<'a>(topology: &'a serde_json::Value, key: &str, value: &str) -> &'a serde_json::Value {
    topology["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row[key] == value)
        .expect("row")
}
