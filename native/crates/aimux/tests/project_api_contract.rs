use std::collections::HashSet;

use aimux::project_api_contract::{
    PROJECT_API_VIEWS, collect_project_api_routes, event_names,
    project_api_mutation_reason_for_route, project_api_views_for_mutation_route, routes,
};

#[test]
fn defines_unique_absolute_project_routes() {
    let routes = collect_project_api_routes();
    assert!(!routes.is_empty());
    assert!(routes.iter().all(|route| route.starts_with('/')));
    let unique: HashSet<_> = routes.iter().copied().collect();
    assert_eq!(unique.len(), routes.len());
}

#[test]
fn route_list_matches_shared_contract_fixture() {
    let fixture = include_str!("../../../../testdata/contracts/v1/project-api/routes.json");
    let value: serde_json::Value = serde_json::from_str(fixture).expect("valid route fixture");
    let expected: Vec<&str> = value["routes"]
        .as_array()
        .expect("routes array")
        .iter()
        .map(|route| route.as_str().expect("route string"))
        .collect();
    assert_eq!(collect_project_api_routes(), expected);
}

#[test]
fn keeps_shared_tui_app_screen_routes_stable() {
    assert_eq!(routes::DESKTOP_STATE, "/desktop-state");
    assert_eq!(routes::DIAGNOSTICS_LIFECYCLE, "/diagnostics/lifecycle");
    assert_eq!(routes::COORDINATION_WORKLIST, "/coordination-worklist");
    assert_eq!(routes::PROJECT_OBSERVABILITY, "/project-observability");
    assert_eq!(routes::TOPOLOGY, "/topology");
    assert_eq!(routes::LIBRARY, "/library");
    assert_eq!(
        routes::graveyard_actions::RESURRECT_WORKTREE,
        "/graveyard/worktrees/resurrect"
    );
    assert_eq!(routes::live_pane::OUTPUT, "/live-pane/output");
    assert_eq!(routes::live_pane::INPUT, "/live-pane/input");
    assert_eq!(routes::live_pane::INTERRUPT, "/live-pane/interrupt");
    assert_eq!(routes::live_pane::RESIZE, "/live-pane/resize");
    assert_eq!(routes::live_pane::ATTACH, "/live-pane/attach");
}

#[test]
fn defines_shared_sse_event_names_and_api_backed_views() {
    assert_eq!(event_names::PROJECT_UPDATE, "project_update");
    assert_eq!(event_names::AGENT_OUTPUT, "agent_output");
    assert!(PROJECT_API_VIEWS.contains(&"coordination-worklist"));
    assert!(PROJECT_API_VIEWS.contains(&"desktop-state"));
    assert!(PROJECT_API_VIEWS.contains(&"notifications"));
    assert!(PROJECT_API_VIEWS.contains(&"plans"));
    assert!(!PROJECT_API_VIEWS.contains(&"inbox"));
}

#[test]
fn maps_mutation_routes_to_shared_client_invalidations() {
    assert_eq!(
        project_api_views_for_mutation_route("PUT", "/plans/codex-1"),
        Some(vec!["plans"])
    );
    assert_eq!(
        project_api_views_for_mutation_route("POST", routes::notifications::READ),
        Some(vec![
            "coordination-worklist",
            "notifications",
            "project-observability"
        ])
    );
    assert_eq!(
        project_api_views_for_mutation_route("POST", routes::agents::SPAWN),
        Some(vec![
            "agents",
            "coordination-worklist",
            "desktop-state",
            "graveyard",
            "project-observability",
            "team",
            "topology",
            "worktrees"
        ])
    );
    assert_eq!(
        project_api_views_for_mutation_route("POST", routes::live_pane::INTERRUPT),
        Some(vec![
            "agents",
            "coordination-worklist",
            "desktop-state",
            "graveyard",
            "project-observability",
            "team",
            "topology",
            "worktrees"
        ])
    );
    assert_eq!(
        project_api_views_for_mutation_route("POST", routes::tasks::ASSIGN),
        Some(vec![
            "coordination-worklist",
            "project-observability",
            "tasks",
            "threads"
        ])
    );
    assert_eq!(
        project_api_views_for_mutation_route("GET", routes::controls::SWITCH_NEXT),
        Some(vec![
            "agents",
            "coordination-worklist",
            "desktop-state",
            "project-observability",
            "topology",
            "worktrees"
        ])
    );
    assert_eq!(
        project_api_views_for_mutation_route("POST", "/future-mutation"),
        Some(PROJECT_API_VIEWS.to_vec())
    );
    assert_eq!(
        project_api_views_for_mutation_route("GET", routes::agents::LIST),
        None
    );
}

#[test]
fn formats_mutation_reasons_like_typescript() {
    assert_eq!(
        project_api_mutation_reason_for_route("post", routes::tasks::ASSIGN),
        "POST /tasks/assign"
    );
    assert_eq!(project_api_mutation_reason_for_route("", ""), "REQUEST /");
}
