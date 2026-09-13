use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::scribe::{DaemonScribeTextRuntime, route_scribe_text_request};
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
struct Call {
    project: String,
    route_path: String,
    body: Value,
}

#[derive(Debug, Default)]
struct FakeScribeRuntime {
    calls: Vec<Call>,
}

impl DaemonScribeTextRuntime for FakeScribeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn default_tool(&self, _project_root: &str) -> String {
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
        ProjectServiceJsonResult::ok("/repo", json!({ "sessionId": "scribe-1" }))
    }
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

#[test]
fn scribe_clear_forwards_optional_worktree_target() {
    let mut runtime = FakeScribeRuntime::default();
    let response = route_scribe_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.scribe_clear_text,
        Some(&json!({
            "project": "/repo",
            "sessionId": "scribe-1",
            "worktreePath": "/repo/worktrees/scribe-1"
        })),
    )
    .expect("scribe clear");

    assert_eq!(text_body(response), "scribe cleared scribe-1\n");
    assert_eq!(
        runtime.calls.last().unwrap(),
        &Call {
            project: "/repo".into(),
            route_path: project_routes::agents::SCRIBE.into(),
            body: json!({
                "sessionId": "scribe-1",
                "active": false,
                "worktreePath": "/repo/worktrees/scribe-1"
            }),
        }
    );
}
