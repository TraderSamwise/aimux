use aimux::project_api_contract::{
    PROJECT_API_VIEWS, collect_project_api_routes, event_names, invalidations,
    project_api_mutation_reason_for_route, project_api_views_for_mutation_route, routes,
};
use serde_json::{Value, json};

const PROJECT_API_BEHAVIOR: &str =
    include_str!("../../../../testdata/contracts/v1/project-api/behavior.json");

#[test]
fn fixture_project_api_behavior_matches_typescript() {
    let contract: Value =
        serde_json::from_str(PROJECT_API_BEHAVIOR).expect("valid project api behavior fixture");
    let cases = contract["cases"].as_array().expect("project api cases");
    assert_eq!(cases.len(), 6, "unexpected project api case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = project_api_actual(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} project-api/behavior parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn project_api_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "routeInvariants" => {
            let routes = collect_project_api_routes();
            let unique = routes.iter().collect::<std::collections::BTreeSet<_>>();
            json!({
                "count": routes.len(),
                "allAbsolute": routes.iter().all(|route| route.starts_with('/')),
                "uniqueCount": unique.len(),
            })
        }
        "sharedRoutes" => json!({
            "desktopState": routes::DESKTOP_STATE,
            "diagnosticsLifecycle": routes::DIAGNOSTICS_LIFECYCLE,
            "coordinationWorklist": routes::COORDINATION_WORKLIST,
            "projectObservability": routes::PROJECT_OBSERVABILITY,
            "topology": routes::TOPOLOGY,
            "library": routes::LIBRARY,
            "resurrectWorktree": routes::graveyard_actions::RESURRECT_WORKTREE,
            "livePaneOutput": routes::live_pane::OUTPUT,
            "livePaneInput": routes::live_pane::INPUT,
            "livePaneInterrupt": routes::live_pane::INTERRUPT,
            "livePaneResize": routes::live_pane::RESIZE,
            "livePaneAttach": routes::live_pane::ATTACH,
        }),
        "eventsAndViews" => json!({
            "projectUpdate": event_names::PROJECT_UPDATE,
            "agentOutput": event_names::AGENT_OUTPUT,
            "views": PROJECT_API_VIEWS,
            "containsCoordinationWorklist": PROJECT_API_VIEWS.contains(&"coordination-worklist"),
            "containsDesktopState": PROJECT_API_VIEWS.contains(&"desktop-state"),
            "containsNotifications": PROJECT_API_VIEWS.contains(&"notifications"),
            "containsPlans": PROJECT_API_VIEWS.contains(&"plans"),
            "containsInbox": PROJECT_API_VIEWS.contains(&"inbox"),
        }),
        "invalidationGroups" => json!({
            "all": invalidations::ALL,
            "agentLifecycle": invalidations::AGENT_LIFECYCLE,
            "serviceLifecycle": invalidations::SERVICE_LIFECYCLE,
            "worktreeLifecycle": invalidations::WORKTREE_LIFECYCLE,
            "workflow": invalidations::WORKFLOW,
            "notifications": invalidations::NOTIFICATIONS,
            "team": invalidations::TEAM,
            "library": invalidations::LIBRARY,
            "plans": invalidations::PLANS,
            "workOutline": invalidations::WORK_OUTLINE,
            "runtime": invalidations::RUNTIME,
            "operationFailures": invalidations::OPERATION_FAILURES,
            "repair": invalidations::REPAIR,
        }),
        "viewsForMutationRoutes" => Value::Array(
            case["input"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| {
                    let method = item["method"].as_str().expect("method");
                    let pathname = item["pathname"].as_str().expect("pathname");
                    json!({
                        "method": method,
                        "pathname": pathname,
                        "views": project_api_views_for_mutation_route(method, pathname),
                    })
                })
                .collect(),
        ),
        "mutationReasons" => Value::Array(
            case["input"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| {
                    let method = item["method"].as_str().expect("method");
                    let pathname = item["pathname"].as_str().expect("pathname");
                    json!({
                        "method": method,
                        "pathname": pathname,
                        "reason": project_api_mutation_reason_for_route(method, pathname),
                    })
                })
                .collect(),
        ),
        api => json!({ "error": format!("unknown project api api: {api}") }),
    }
}
