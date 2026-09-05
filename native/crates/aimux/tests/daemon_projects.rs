use aimux::daemon_projects::{build_projects_route_projects, count_online_desktop_agents};
use aimux::project_catalog::DesktopProjectInfo;
use serde_json::{Value, json};
use std::collections::HashMap;

fn desktop_project(id: &str) -> DesktopProjectInfo {
    DesktopProjectInfo {
        id: id.into(),
        name: id.into(),
        path: format!("/tmp/{id}"),
        last_seen: Some("2026-03-28T00:00:00.000Z".into()),
        dashboard_session_name: format!("aimux-{id}"),
    }
}

#[test]
fn projects_route_keeps_registered_projects_when_services_are_dead() {
    let projects = vec![desktop_project("proj-a"), desktop_project("proj-b")];
    let services_by_id = HashMap::from([
        (
            "proj-a".into(),
            json!({ "projectId": "proj-a", "status": "running" }),
        ),
        (
            "proj-b".into(),
            json!({ "projectId": "proj-b", "status": "stopped" }),
        ),
    ]);
    let actor_states_by_id = HashMap::new();
    let endpoints_by_id = HashMap::from([(
        "proj-a".into(),
        json!({ "host": "127.0.0.1", "port": 43191, "pid": 123 }),
    )]);

    let result = build_projects_route_projects(
        &projects,
        &services_by_id,
        &actor_states_by_id,
        &endpoints_by_id,
        |service| service["status"] == "running",
    );

    assert_eq!(result.len(), 2);
    assert!(result[0].service_alive);
    assert_eq!(result[0].service.as_ref().unwrap()["projectId"], "proj-a");
    assert!(!result[1].service_alive);
    assert!(result[1].service.is_none());
}

#[test]
fn projects_route_prefers_actor_state_over_persisted_service_state() {
    let projects = vec![desktop_project("proj-a")];
    let services_by_id = HashMap::from([("proj-a".into(), json!({ "status": "stopped" }))]);
    let actor_states_by_id = HashMap::from([("proj-a".into(), json!({ "status": "running" }))]);
    let endpoints_by_id = HashMap::new();

    let result = build_projects_route_projects(
        &projects,
        &services_by_id,
        &actor_states_by_id,
        &endpoints_by_id,
        |service| service["status"] == "running",
    );

    assert!(result[0].service_alive);
    assert_eq!(result[0].service.as_ref().unwrap()["status"], "running");
}

#[test]
fn projects_route_treats_null_actor_state_as_absent_like_typescript_nullish_coalescing() {
    let projects = vec![desktop_project("proj-a")];
    let services_by_id = HashMap::from([("proj-a".into(), json!({ "status": "running" }))]);
    let actor_states_by_id = HashMap::from([("proj-a".into(), Value::Null)]);
    let endpoints_by_id = HashMap::new();

    let result = build_projects_route_projects(
        &projects,
        &services_by_id,
        &actor_states_by_id,
        &endpoints_by_id,
        |service| service["status"] == "running",
    );

    assert!(result[0].service_alive);
    assert_eq!(result[0].service.as_ref().unwrap()["status"], "running");
}

#[test]
fn counts_online_sessions_from_worktree_groups_and_hides_control_sessions() {
    let count = count_online_desktop_agents(&json!({
        "worktreeGroups": [
            {
                "sessions": [
                    { "status": "running" },
                    { "status": "offline" },
                    { "status": "exited" },
                    { "status": "idle", "overseer": true },
                    { "status": "idle", "team": { "role": "overseer" } },
                    { "status": "offline", "pendingAction": { "kind": "spawn" } },
                    { "status": "idle", "team": { "role": "scribe" } },
                    { "status": "idle", "team": { "role": "scribe" }, "scribe": false }
                ]
            },
            { "sessions": [{ "status": "waiting" }] }
        ]
    }));

    assert_eq!(count, Some(4));
}

#[test]
fn counts_top_level_sessions_and_teammates() {
    assert_eq!(
        count_online_desktop_agents(&json!({
            "sessions": [{ "status": "running" }, { "status": "offline" }],
            "teammates": [{ "status": "idle" }, { "status": "exited" }]
        })),
        Some(2)
    );
}

#[test]
fn returns_none_when_no_known_session_collections_exist() {
    assert_eq!(count_online_desktop_agents(&json!({})), None);
    assert_eq!(
        count_online_desktop_agents(&json!({ "sessions": {}, "teammates": {} })),
        None
    );
}

#[test]
fn matches_javascript_truthiness_for_pending_action() {
    for pending_action in [json!({}), json!([]), json!("yes"), json!(1)] {
        assert_eq!(
            count_online_desktop_agents(
                &json!({ "sessions": [{ "status": "offline", "pendingAction": pending_action }] })
            ),
            Some(1)
        );
    }
    for pending_action in [Value::Null, json!(false), json!(""), json!(0)] {
        assert_eq!(
            count_online_desktop_agents(
                &json!({ "sessions": [{ "status": "offline", "pendingAction": pending_action }] })
            ),
            Some(0)
        );
    }
}
