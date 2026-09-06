use aimux::core_command_transport::DaemonHttpMethod;
use aimux::dashboard_actions::DashboardActionRequest;
use aimux::dashboard_client::{
    ProjectServiceEndpoint, build_project_service_json_request, find_project_service_endpoint,
};
use aimux::project_api_contract::routes;
use serde_json::json;
use std::path::Path;

#[test]
fn finds_loopback_project_service_endpoint_for_registered_project() {
    let endpoint = find_project_service_endpoint(
        &json!({
            "projects": [
                {
                    "projectRoot": "/repo",
                    "serviceEndpoint": {
                        "host": "127.0.0.1",
                        "port": 44191
                    }
                }
            ]
        }),
        Path::new("/repo"),
    )
    .expect("endpoint");

    assert_eq!(
        endpoint,
        ProjectServiceEndpoint {
            host: "127.0.0.1".into(),
            port: 44191,
        }
    );
}

#[test]
fn rejects_missing_or_non_loopback_project_service_endpoint() {
    let missing = find_project_service_endpoint(&json!({ "projects": [] }), Path::new("/repo"))
        .expect_err("missing project");
    assert_eq!(
        missing.to_string(),
        "project is not registered with the daemon: /repo"
    );

    let remote = find_project_service_endpoint(
        &json!({
            "projects": [
                {
                    "path": "/repo",
                    "serviceEndpoint": {
                        "host": "10.0.0.2",
                        "port": 44191
                    }
                }
            ]
        }),
        Path::new("/repo"),
    )
    .expect_err("remote endpoint");
    assert_eq!(
        remote.to_string(),
        "project service endpoint must be loopback"
    );
}

#[test]
fn builds_desktop_state_get_request() {
    let request = build_project_service_json_request(
        &endpoint(),
        DaemonHttpMethod::Get,
        routes::DESKTOP_STATE,
        None,
    )
    .expect("request");

    assert_eq!(request.url, "http://127.0.0.1:44191/desktop-state");
    assert_eq!(request.method, DaemonHttpMethod::Get);
    assert_eq!(request.headers.get("accept").unwrap(), "application/json");
    assert!(request.body.is_none());
}

#[test]
fn builds_dashboard_action_post_request() {
    let action = DashboardActionRequest {
        method: "POST",
        path: routes::agents::RESUME,
        body: json!({ "sessionId": "codex-1" }),
    };
    let request = build_project_service_json_request(
        &endpoint(),
        DaemonHttpMethod::Post,
        action.path,
        Some(action.body),
    )
    .expect("request");

    assert_eq!(request.url, "http://127.0.0.1:44191/agents/resume");
    assert_eq!(request.method, DaemonHttpMethod::Post);
    assert_eq!(
        request.headers.get("content-type").unwrap(),
        "application/json"
    );
    assert_eq!(request.headers.get("content-length").unwrap(), "23");
    assert_eq!(request.body.as_deref(), Some(r#"{"sessionId":"codex-1"}"#));
}

fn endpoint() -> ProjectServiceEndpoint {
    ProjectServiceEndpoint {
        host: "127.0.0.1".into(),
        port: 44191,
    }
}
