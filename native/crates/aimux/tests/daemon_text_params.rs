use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::text::params::{
    ProjectServiceJsonResult, client_suffix_for_session, required_project_service_array,
    required_project_service_object, required_project_service_string, resolve_lifecycle_worktree,
    resolve_project_relative_path,
};
use serde_json::json;

fn text_body(response: aimux::daemon::routing::DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

#[test]
fn validates_project_service_shapes_with_daemon_error_text() {
    let json = json!({
        "name": "agent-1",
        "items": [1, 2],
        "thread": { "id": "thread-1" }
    });
    assert_eq!(
        required_project_service_string(&json, "agent rename", "name").unwrap(),
        "agent-1"
    );
    assert_eq!(
        required_project_service_array(&json, "worktree list", "items").unwrap(),
        vec![json!(1), json!(2)]
    );
    assert_eq!(
        required_project_service_object(&json, "thread show", "thread").unwrap(),
        json!({ "id": "thread-1" })
    );

    let missing =
        required_project_service_string(&json, "spawn", "sessionId").expect_err("missing session");
    assert_eq!(
        text_body(missing),
        "Error: project service returned invalid spawn response: sessionId is required\n"
    );
}

#[test]
fn resolves_daemon_relative_paths_like_node_path_resolve() {
    assert_eq!(
        resolve_lifecycle_worktree("/repo/project", Some("worktrees/a")),
        Some("/repo/project/worktrees/a".into())
    );
    assert_eq!(
        resolve_lifecycle_worktree("/repo/project", Some("/tmp/other")),
        Some("/tmp/other".into())
    );
    assert_eq!(resolve_lifecycle_worktree("/repo/project", None), None);
    assert_eq!(
        resolve_project_relative_path("/repo/project", "../sibling"),
        "/repo/sibling"
    );
}

#[test]
fn extracts_client_suffix_only_for_aimux_client_sessions() {
    assert_eq!(
        client_suffix_for_session(Some("aimux-repo-client-deadbeef")),
        Some("deadbeef".into())
    );
    assert_eq!(
        client_suffix_for_session(Some("aimux-repo-client-nope")),
        None
    );
    assert_eq!(client_suffix_for_session(Some("aimux-repo")), None);
    assert_eq!(client_suffix_for_session(None), None);
}

#[test]
fn project_service_json_result_carries_route_response_contract() {
    let ok = ProjectServiceJsonResult::ok("/repo", json!({ "ok": true }));
    assert_eq!(
        ok,
        ProjectServiceJsonResult::Ok {
            project_root: "/repo".into(),
            json: json!({ "ok": true })
        }
    );

    let error = ProjectServiceJsonResult::error(aimux::daemon::routing::DaemonRouteResponse::text(
        503,
        "Error: unavailable\n",
    ));
    assert!(matches!(error, ProjectServiceJsonResult::Err { .. }));
}
