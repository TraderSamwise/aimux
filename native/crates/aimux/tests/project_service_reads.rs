use aimux::project_api_contract::routes;
use aimux::project_service::reads::route_read_request;
use aimux::project_service::router::ProjectServiceRequestContext;
use serde_json::Value;

#[test]
fn health_route_matches_project_service_contract_shape() {
    let context = ProjectServiceRequestContext::with_project_state_dir("/repo", "/state/repo");
    let response = route_read_request(&context, "GET", routes::HEALTH).expect("health route");
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], Value::Bool(true));
    assert_eq!(response.body["projectStateDir"], "/state/repo");
    assert!(response.body["pid"].as_u64().is_some());
    assert_eq!(response.body["serviceInfo"]["apiVersion"], 5);
    assert_eq!(
        response.body["serviceInfo"]["capabilities"]["parsedAgentOutput"],
        Value::Bool(true)
    );
}

#[test]
fn read_split_returns_unimplemented_for_known_unported_reads() {
    let context = ProjectServiceRequestContext::with_project_state_dir("/repo", "/state/repo");
    let response = route_read_request(&context, "GET", routes::DIAGNOSTICS).expect("known read");
    assert_eq!(response.status, 501);
    assert_eq!(response.body["group"], "reads");
}
