use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::status::{
    DAEMON_HEALTH_KIND, DaemonStatusRuntime, daemon_status_payload, host_status_payload,
    route_status_request,
};
use aimux::daemon_projects::ProjectsRouteProject;
use aimux::daemon_state::{AimuxDaemonInfo, DaemonState};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
struct FakeStatusRuntime {
    daemon: AimuxDaemonInfo,
    service_info: Value,
    projects: Vec<ProjectsRouteProject>,
    state: DaemonState,
    relay: Value,
}

impl DaemonStatusRuntime for FakeStatusRuntime {
    fn current_daemon_info(&self, _issued_at: &str) -> AimuxDaemonInfo {
        self.daemon.clone()
    }

    fn project_service_info(&self) -> Value {
        self.service_info.clone()
    }

    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject> {
        self.projects.clone()
    }

    fn daemon_state(&self) -> DaemonState {
        self.state.clone()
    }

    fn relay_status(&self) -> Value {
        self.relay.clone()
    }

    fn resolve_project_root(&self, cwd: &str) -> String {
        if cwd == "." {
            "/repo".into()
        } else {
            cwd.into()
        }
    }
}

fn runtime() -> FakeStatusRuntime {
    let project = ProjectsRouteProject {
        id: "repo-id".into(),
        name: "repo".into(),
        path: "/repo".into(),
        last_seen: Some("2026-03-28T00:00:00.000Z".into()),
        dashboard_session_name: "aimux-repo-id".into(),
        service: Some(json!({ "projectId": "repo-id", "projectRoot": "/repo", "pid": 9123 })),
        service_alive: true,
        service_endpoint: Some(json!({ "host": "127.0.0.1", "port": 44191, "pid": 9123 })),
        online_agent_count: None,
    };
    FakeStatusRuntime {
        daemon: AimuxDaemonInfo {
            pid: 9001,
            port: 43190,
            started_at: "then".into(),
            updated_at: "now".into(),
        },
        service_info: json!({ "apiVersion": 5, "buildStamp": "stamp", "capabilities": {} }),
        projects: vec![project],
        state: DaemonState {
            version: 1,
            updated_at: Some(json!("now")),
            projects: BTreeMap::from([
                (
                    "repo-id".into(),
                    json!({ "projectId": "repo-id", "projectRoot": "/repo", "pid": 9123 }),
                ),
                (
                    "cold-id".into(),
                    json!({ "projectId": "cold-id", "projectRoot": "/cold", "pid": 0 }),
                ),
            ]),
        },
        relay: json!({ "status": "off" }),
    }
}

fn text_body(response: aimux::daemon::routing::DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

fn json_body(response: aimux::daemon::routing::DaemonRouteResponse) -> Value {
    match response.body {
        DaemonResponseBody::Json(value) => value,
        other => panic!("expected json body, got {other:?}"),
    }
}

#[test]
fn health_route_matches_daemon_contract_without_waking_projects() {
    let response =
        route_status_request(&runtime(), "GET", "/health", "issued").expect("health route");
    assert_eq!(response.status, 200);
    assert_eq!(
        json_body(response),
        json!({
            "ok": true,
            "kind": DAEMON_HEALTH_KIND,
            "pid": 9001,
            "port": 43190,
            "serviceInfo": { "apiVersion": 5, "buildStamp": "stamp", "capabilities": {} }
        })
    );
}

#[test]
fn daemon_status_uses_persisted_state_but_live_flags_from_route_projects() {
    let payload = daemon_status_payload(&runtime(), "issued", &runtime().projects);
    assert_eq!(payload["projects"].as_array().unwrap().len(), 2);
    assert_eq!(payload["projects"][0]["projectId"], "cold-id");
    assert_eq!(payload["projects"][0]["serviceAlive"], false);
    assert_eq!(payload["projects"][1]["projectId"], "repo-id");
    assert_eq!(payload["projects"][1]["serviceAlive"], true);

    let text = route_status_request(
        &runtime(),
        "GET",
        CORE_API_ROUTES.daemon_status_text,
        "issued",
    )
    .expect("daemon status route");
    assert_eq!(
        text_body(text),
        "Daemon pid=9001 port=43190\nKnown projects: 2\nLive project services: 1\nRelay: off\n"
    );
}

#[test]
fn host_status_resolves_current_project_without_service_requirement() {
    let (payload, known) = host_status_payload(&runtime(), ".", "issued");
    assert!(known);
    assert_eq!(payload["projectRoot"], "/repo");
    assert_eq!(payload["sessionName"], "aimux-repo-id");
    assert_eq!(payload["projectService"]["pid"], 9123);
    assert_eq!(payload["serviceAlive"], true);
    assert_eq!(payload["metadataEndpoint"]["port"], 44191);

    let unknown = route_status_request(
        &runtime(),
        "GET",
        &format!("{}?project=/unknown", CORE_API_ROUTES.host_status_text),
        "issued",
    )
    .expect("host status route");
    assert_eq!(
        text_body(unknown),
        "No known control service for /unknown\n"
    );
}

#[test]
fn project_lists_keep_registered_projects_visible() {
    let projects = route_status_request(
        &runtime(),
        "GET",
        CORE_API_ROUTES.projects_list_text,
        "issued",
    )
    .expect("projects list route");
    assert_eq!(text_body(projects), "repo  live  /repo\n");

    let daemon_projects = route_status_request(
        &runtime(),
        "GET",
        &format!("{}?json=1", CORE_API_ROUTES.daemon_projects_text),
        "issued",
    )
    .expect("daemon projects route");
    assert_eq!(
        text_body(daemon_projects),
        "{\n  \"projects\": [\n    {\n      \"id\": \"repo-id\",\n      \"name\": \"repo\",\n      \"path\": \"/repo\",\n      \"lastSeen\": \"2026-03-28T00:00:00.000Z\",\n      \"dashboardSessionName\": \"aimux-repo-id\",\n      \"service\": {\n        \"projectId\": \"repo-id\",\n        \"projectRoot\": \"/repo\",\n        \"pid\": 9123\n      },\n      \"serviceAlive\": true,\n      \"serviceEndpoint\": {\n        \"host\": \"127.0.0.1\",\n        \"port\": 44191,\n        \"pid\": 9123\n      }\n    }\n  ]\n}\n"
    );
}

#[test]
fn projects_by_id_reads_persisted_catalog_state() {
    let response = route_status_request(&runtime(), "GET", "/projects/repo-id", "issued")
        .expect("project by id route");
    assert_eq!(json_body(response)["project"]["projectRoot"], "/repo");

    let encoded = route_status_request(&runtime(), "GET", "/projects/cold%2Did", "issued")
        .expect("encoded project route");
    assert_eq!(json_body(encoded)["project"]["projectRoot"], "/cold");

    let missing = route_status_request(&runtime(), "GET", "/projects/missing", "issued")
        .expect("missing project route");
    assert_eq!(json_body(missing)["project"], Value::Null);
}

#[test]
fn unrelated_routes_are_left_for_other_daemon_modules() {
    assert!(route_status_request(&runtime(), "POST", "/projects/ensure", "issued").is_none());
    assert!(
        route_status_request(&runtime(), "GET", "/proxy/127.0.0.1/1/health", "issued").is_none()
    );
}
