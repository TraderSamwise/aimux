use aimux::core_command_transport::DaemonHttpMethod;
use aimux::dashboard_actions::DashboardActionRequest;
use aimux::dashboard_client::{
    ProjectServiceEndpoint, build_project_service_json_request, find_project_service_endpoint,
};
use aimux::project_api_contract::routes;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn finds_loopback_project_service_endpoint_for_registered_project() {
    let repo = temp_git_root("dashboard-client-registered");
    let repo_text = repo.to_string_lossy().into_owned();
    let endpoint = find_project_service_endpoint(
        &json!({
            "projects": [
                {
                    "projectRoot": repo_text,
                    "serviceEndpoint": {
                        "host": "127.0.0.1",
                        "port": 44191
                    }
                }
            ]
        }),
        &repo,
    )
    .expect("endpoint");

    assert_eq!(
        endpoint,
        ProjectServiceEndpoint {
            host: "127.0.0.1".into(),
            port: 44191,
        }
    );
    fs::remove_dir_all(repo).expect("cleanup");
}

#[test]
fn rejects_missing_or_non_loopback_project_service_endpoint() {
    let repo = temp_git_root("dashboard-client-missing");
    let repo_text = repo.to_string_lossy().into_owned();
    let missing = find_project_service_endpoint(&json!({ "projects": [] }), &repo)
        .expect_err("missing project");
    assert_eq!(
        missing.to_string(),
        format!("project service is unavailable for {repo_text}")
    );

    let remote = find_project_service_endpoint(
        &json!({
            "projects": [
                {
                    "path": repo_text,
                    "serviceEndpoint": {
                        "host": "10.0.0.2",
                        "port": 44191
                    }
                }
            ]
        }),
        &repo,
    )
    .expect_err("remote endpoint");
    assert_eq!(
        remote.to_string(),
        "project service endpoint must be loopback"
    );
    fs::remove_dir_all(repo).expect("cleanup");
}

#[test]
fn dashboard_endpoint_rejects_non_git_directory_with_actionable_message() {
    let repo = temp_plain_dir("dashboard-client-non-git");
    let error =
        find_project_service_endpoint(&json!({ "projects": [] }), &repo).expect_err("non-git");

    assert_eq!(
        error.to_string(),
        format!(
            "{} is not a git repository. Run `git init` first, or cd into a repo.",
            repo.display()
        )
    );
    fs::remove_dir_all(repo).expect("cleanup");
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

#[test]
fn builds_statusline_refresh_post_request_for_dashboard_client() {
    let request = build_project_service_json_request(
        &endpoint(),
        DaemonHttpMethod::Post,
        routes::STATUSLINE_REFRESH,
        Some(json!({
            "sessionId": "aimux-proj-client-1234abcd",
            "force": true,
        })),
    )
    .expect("request");

    assert_eq!(request.url, "http://127.0.0.1:44191/statusline/refresh");
    assert_eq!(request.method, DaemonHttpMethod::Post);
    assert_eq!(
        request.headers.get("content-type").unwrap(),
        "application/json"
    );
    let body: serde_json::Value =
        serde_json::from_str(request.body.as_deref().expect("body")).expect("json");
    assert_eq!(body["force"], true);
    assert_eq!(body["sessionId"], "aimux-proj-client-1234abcd");
}

fn endpoint() -> ProjectServiceEndpoint {
    ProjectServiceEndpoint {
        host: "127.0.0.1".into(),
        port: 44191,
    }
}

fn temp_plain_dir(label: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_millis();
    let path = std::env::temp_dir().join(format!("aimux-{label}-{millis}-{}", std::process::id()));
    fs::create_dir_all(&path).expect("temp dir");
    path
}

fn temp_git_root(label: &str) -> PathBuf {
    let path = temp_plain_dir(label);
    fs::create_dir_all(path.join(".git")).expect("git dir");
    path
}
