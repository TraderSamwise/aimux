use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::notifications::{
    DaemonNotificationTextRuntime, route_notification_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::worktrees::CLI_PROJECT_MUTATION_TIMEOUT_MS;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
struct Call {
    project: String,
    route_path: String,
    body: Option<Value>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Default)]
struct FakeNotificationRuntime {
    calls: Vec<Call>,
}

impl DaemonNotificationTextRuntime for FakeNotificationRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            project: project.into(),
            route_path: route_path.into(),
            body: None,
            timeout_ms: None,
        });
        match route_path {
            "/notifications?unread=1&sessionId=claude-1" => ProjectServiceJsonResult::ok(
                "/repo",
                json!({
                    "notifications": [{
                        "id": "note-1",
                        "unread": true,
                        "sessionId": "claude-1",
                        "title": "Need input",
                        "body": "Please respond"
                    }],
                    "unreadCount": 1
                }),
            ),
            project_routes::notifications::LIST => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "notifications": [], "unreadCount": 0 }),
            ),
            _ => ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "not found\n")),
        }
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            project: project.into(),
            route_path: route_path.into(),
            body: Some(body),
            timeout_ms,
        });
        match route_path {
            project_routes::runtime::NOTIFY => {
                ProjectServiceJsonResult::ok("/repo", json!({ "ok": true }))
            }
            project_routes::notifications::READ => {
                ProjectServiceJsonResult::ok("/repo", json!({ "updated": 2 }))
            }
            project_routes::notifications::CLEAR => {
                ProjectServiceJsonResult::ok("/repo", json!({ "cleared": 1 }))
            }
            _ => ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "not found\n")),
        }
    }
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

fn json_text(response: DaemonRouteResponse) -> Value {
    serde_json::from_str(&text_body(response)).expect("json text")
}

#[test]
fn notification_list_matches_query_and_text_json_contracts() {
    let mut runtime = FakeNotificationRuntime::default();
    let listed = route_notification_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&unread=1&sessionId=%20claude-1%20",
            CORE_API_ROUTES.notification_list_text
        ),
        None,
    )
    .expect("notification list");
    assert_eq!(
        text_body(listed),
        "note-1 unread [claude-1] Need input: Please respond\n"
    );
    assert_eq!(
        runtime.calls.last().unwrap().route_path,
        "/notifications?unread=1&sessionId=claude-1"
    );

    let listed_json = route_notification_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&json=1",
            CORE_API_ROUTES.notification_list_text
        ),
        None,
    )
    .expect("notification list json");
    assert_eq!(json_text(listed_json)["notifications"], json!([]));
}

#[test]
fn notification_send_trims_fields_and_preserves_timeout() {
    let mut runtime = FakeNotificationRuntime::default();
    let sent = route_notification_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.notification_send_text,
        Some(&json!({
            "project": "/repo",
            "title": " Need input ",
            "subtitle": " Agent ",
            "body": " ",
            "sessionId": " claude-1 ",
            "kind": " prompt "
        })),
    )
    .expect("notification send");
    assert_eq!(text_body(sent), "Queued notification \"Need input\".\n");
    let call = runtime.calls.last().unwrap();
    assert_eq!(call.project, "/repo");
    assert_eq!(call.route_path, project_routes::runtime::NOTIFY);
    assert_eq!(call.timeout_ms, Some(CLI_PROJECT_MUTATION_TIMEOUT_MS));
    assert_eq!(
        call.body.as_ref().unwrap(),
        &json!({
            "title": "Need input",
            "subtitle": "Agent",
            "message": "Need input",
            "sessionId": "claude-1",
            "kind": "prompt",
            "force": true
        })
    );
}

#[test]
fn notification_read_and_clear_use_mutation_payload_contract() {
    let mut runtime = FakeNotificationRuntime::default();
    let read = route_notification_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&id=%20one%20&ids=two,three&sessionId=%20claude-1%20",
            CORE_API_ROUTES.notification_read_text
        ),
        Some(&json!({ "ids": [" four ", ""] })),
    )
    .expect("notification read");
    assert_eq!(text_body(read), "Marked 2 notifications as read.\n");
    let read_call = runtime.calls.last().unwrap();
    assert_eq!(read_call.route_path, project_routes::notifications::READ);
    assert_eq!(
        read_call.body.as_ref().unwrap(),
        &json!({ "id": "one", "ids": ["four"], "sessionId": "claude-1" })
    );
    assert_eq!(read_call.timeout_ms, Some(CLI_PROJECT_MUTATION_TIMEOUT_MS));

    let cleared = route_notification_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&ids=one,two",
            CORE_API_ROUTES.notification_clear_text
        ),
        None,
    )
    .expect("notification clear");
    assert_eq!(text_body(cleared), "Cleared 1 notification.\n");
    let clear_call = runtime.calls.last().unwrap();
    assert_eq!(clear_call.route_path, project_routes::notifications::CLEAR);
    assert_eq!(
        clear_call.body.as_ref().unwrap(),
        &json!({ "ids": ["one", "two"] })
    );
}

#[test]
fn notification_validation_and_unrelated_routes_match_daemon_split() {
    let mut runtime = FakeNotificationRuntime::default();
    let missing = route_notification_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.notification_send_text,
        Some(&json!({ "project": "/repo" })),
    )
    .expect("notification send");
    assert_eq!(missing.status, 400);
    assert_eq!(text_body(missing), "title is required\n");

    let bad_ids = route_notification_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.notification_read_text,
        Some(&json!({ "project": "/repo", "ids": [1] })),
    )
    .expect("notification read");
    assert_eq!(bad_ids.status, 400);
    assert_eq!(text_body(bad_ids), "ids must be an array of strings\n");

    assert!(
        route_notification_text_request(&mut runtime, "GET", CORE_API_ROUTES.team_show_text, None,)
            .is_none()
    );
}
