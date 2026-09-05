use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::overseer::{DaemonOverseerTextRuntime, route_overseer_text_request};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
struct Call {
    project: String,
    route_path: String,
    body: Value,
}

#[derive(Debug, Default)]
struct FakeOverseerRuntime {
    calls: Vec<Call>,
}

impl DaemonOverseerTextRuntime for FakeOverseerRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        if value == "." {
            "/repo".into()
        } else {
            value.into()
        }
    }

    fn default_tool(&self, project_root: &str) -> String {
        assert_eq!(project_root, "/repo");
        "claude".into()
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            project: project.into(),
            route_path: route_path.into(),
            body,
        });
        match route_path {
            project_routes::agents::SPAWN => {
                ProjectServiceJsonResult::ok("/repo", json!({ "sessionId": "overseer-1" }))
            }
            project_routes::agents::OVERSEER => {
                ProjectServiceJsonResult::ok("/repo", json!({ "sessionId": "overseer-1" }))
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
fn overseer_start_uses_default_tool_and_resolves_worktree() {
    let mut runtime = FakeOverseerRuntime::default();
    let response = route_overseer_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=.&worktreePath=wt&open=false",
            CORE_API_ROUTES.overseer_start_text
        ),
        None,
    )
    .expect("overseer start");
    assert_eq!(text_body(response), "overseer overseer-1\n");
    assert_eq!(
        runtime.calls,
        [Call {
            project: "/repo".into(),
            route_path: project_routes::agents::SPAWN.into(),
            body: json!({
                "tool": "claude",
                "worktreePath": "/repo/wt",
                "open": false,
                "overseer": true
            }),
        }]
    );
}

#[test]
fn overseer_start_preserves_explicit_tool_and_json_payload() {
    let mut runtime = FakeOverseerRuntime::default();
    let response = route_overseer_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&json=1",
            CORE_API_ROUTES.overseer_start_text
        ),
        Some(&json!({ "tool": "codex" })),
    )
    .expect("overseer start");
    let payload = json_text(response);
    assert_eq!(payload["sessionId"], "overseer-1");
    assert_eq!(payload["tool"], "codex");
    assert_eq!(
        runtime.calls.last().unwrap().body,
        json!({ "tool": "codex", "open": true, "overseer": true })
    );
}

#[test]
fn overseer_clear_matches_project_service_contract() {
    let mut runtime = FakeOverseerRuntime::default();
    let response = route_overseer_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.overseer_clear_text,
        Some(&json!({ "project": "/repo", "sessionId": "overseer-1" })),
    )
    .expect("overseer clear");
    assert_eq!(text_body(response), "overseer cleared overseer-1\n");
    assert_eq!(
        runtime.calls.last().unwrap(),
        &Call {
            project: "/repo".into(),
            route_path: project_routes::agents::OVERSEER.into(),
            body: json!({ "sessionId": "overseer-1", "active": false }),
        }
    );
}

#[test]
fn overseer_validation_and_unrelated_routes_match_daemon_split() {
    let missing = route_overseer_text_request(
        &mut FakeOverseerRuntime::default(),
        "POST",
        CORE_API_ROUTES.overseer_clear_text,
        Some(&json!({ "project": "/repo" })),
    )
    .expect("overseer clear");
    assert_eq!(missing.status, 400);
    assert_eq!(text_body(missing), "sessionId is required\n");

    assert!(
        route_overseer_text_request(
            &mut FakeOverseerRuntime::default(),
            "GET",
            CORE_API_ROUTES.team_show_text,
            None,
        )
        .is_none()
    );
}
