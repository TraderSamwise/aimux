use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::team::{DaemonTeamTextRuntime, route_team_text_request};
use aimux::daemon::text::worktrees::CLI_PROJECT_MUTATION_TIMEOUT_MS;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, PartialEq)]
struct Call {
    project: String,
    route_path: String,
    body: Option<Value>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Default)]
struct FakeTeamRuntime {
    calls: Vec<Call>,
    invalid_roles: bool,
    invalid_default_role: bool,
}

impl DaemonTeamTextRuntime for FakeTeamRuntime {
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
        if route_path != project_routes::team::CONFIG {
            return ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "not found\n"));
        }
        ProjectServiceJsonResult::ok("/repo", self.config_response())
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
            project_routes::team::INIT
            | project_routes::team::ADD_ROLE
            | project_routes::team::REMOVE_ROLE
            | project_routes::team::DEFAULT_ROLE => {
                ProjectServiceJsonResult::ok("/repo", self.config_response())
            }
            _ => ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "not found\n")),
        }
    }
}

impl FakeTeamRuntime {
    fn config_response(&self) -> Value {
        if self.invalid_roles {
            return json!({ "config": { "roles": [], "defaultRole": "builder" } });
        }
        if self.invalid_default_role {
            return json!({ "config": { "roles": {}, "defaultRole": null } });
        }
        let roles = Map::from_iter([
            (
                "builder".into(),
                json!({ "description": "Build features", "reviewedBy": "reviewer", "canEdit": true }),
            ),
            ("reviewer".into(), json!({ "description": "Review work" })),
        ]);
        json!({ "config": { "roles": roles, "defaultRole": "builder" } })
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
fn team_show_and_init_match_config_contracts() {
    let mut runtime = FakeTeamRuntime::default();
    let shown = route_team_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.team_show_text),
        None,
    )
    .expect("team show");
    assert_eq!(
        text_body(shown),
        "Team Roles:\n  builder: Build features (reviewed by: reviewer, can edit)\n  reviewer: Review work\n\nDefault role: builder\n"
    );
    assert_eq!(
        runtime.calls.last().unwrap().route_path,
        project_routes::team::CONFIG
    );

    let initialized = route_team_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.team_init_text,
        Some(&json!({ "project": "/repo" })),
    )
    .expect("team init");
    assert_eq!(
        text_body(initialized),
        "Team config initialized with default roles:\n  builder: Build features\n  reviewer: Review work\n"
    );
    let call = runtime.calls.last().unwrap();
    assert_eq!(call.route_path, project_routes::team::INIT);
    assert_eq!(call.body.as_ref().unwrap(), &json!({}));
    assert_eq!(call.timeout_ms, Some(CLI_PROJECT_MUTATION_TIMEOUT_MS));
}

#[test]
fn team_role_mutations_preserve_extra_body_and_renderers() {
    let mut runtime = FakeTeamRuntime::default();
    let added = route_team_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.team_add_text,
        Some(&json!({
            "project": "/repo",
            "role": "builder",
            "description": "Build features",
            "reviewedBy": "reviewer",
            "canEdit": true
        })),
    )
    .expect("team add");
    assert_eq!(text_body(added), "Role \"builder\" saved.\n");
    let add_call = runtime.calls.last().unwrap();
    assert_eq!(add_call.route_path, project_routes::team::ADD_ROLE);
    assert_eq!(
        add_call.body.as_ref().unwrap(),
        &json!({
            "role": "builder",
            "description": "Build features",
            "reviewedBy": "reviewer",
            "canEdit": true
        })
    );
    assert_eq!(add_call.timeout_ms, Some(CLI_PROJECT_MUTATION_TIMEOUT_MS));

    let removed = route_team_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&role=reviewer",
            CORE_API_ROUTES.team_remove_text
        ),
        None,
    )
    .expect("team remove");
    assert_eq!(text_body(removed), "Role \"reviewer\" removed.\n");
    assert_eq!(
        runtime.calls.last().unwrap().route_path,
        project_routes::team::REMOVE_ROLE
    );

    let defaulted = route_team_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&role=builder",
            CORE_API_ROUTES.team_default_text
        ),
        None,
    )
    .expect("team default");
    assert_eq!(text_body(defaulted), "Default role set to \"builder\".\n");
    assert_eq!(
        runtime.calls.last().unwrap().route_path,
        project_routes::team::DEFAULT_ROLE
    );
}

#[test]
fn team_json_and_invalid_upstream_config_match_daemon_errors() {
    let shown_json = route_team_text_request(
        &mut FakeTeamRuntime::default(),
        "GET",
        &format!("{}?project=/repo&json=1", CORE_API_ROUTES.team_show_text),
        None,
    )
    .expect("team show");
    assert_eq!(json_text(shown_json)["config"]["defaultRole"], "builder");

    let invalid_roles = route_team_text_request(
        &mut FakeTeamRuntime {
            invalid_roles: true,
            ..FakeTeamRuntime::default()
        },
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.team_show_text),
        None,
    )
    .expect("team show");
    assert_eq!(invalid_roles.status, 502);
    assert_eq!(
        text_body(invalid_roles),
        "Error: project service returned invalid team show response: config.roles is required\n"
    );

    let invalid_default = route_team_text_request(
        &mut FakeTeamRuntime {
            invalid_default_role: true,
            ..FakeTeamRuntime::default()
        },
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.team_show_text),
        None,
    )
    .expect("team show");
    assert_eq!(invalid_default.status, 502);
    assert_eq!(
        text_body(invalid_default),
        "Error: project service returned invalid team show response: config.defaultRole is required\n"
    );
}

#[test]
fn team_validation_and_unrelated_routes_match_daemon_split() {
    let missing = route_team_text_request(
        &mut FakeTeamRuntime::default(),
        "POST",
        CORE_API_ROUTES.team_add_text,
        Some(&json!({ "project": "/repo" })),
    )
    .expect("team add");
    assert_eq!(missing.status, 400);
    assert_eq!(text_body(missing), "role is required\n");

    assert!(
        route_team_text_request(
            &mut FakeTeamRuntime::default(),
            "GET",
            CORE_API_ROUTES.notification_list_text,
            None,
        )
        .is_none()
    );
}
