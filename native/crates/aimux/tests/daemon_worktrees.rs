use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::worktrees::{
    CLI_PROJECT_MUTATION_TIMEOUT_MS, DaemonWorktreeTextRuntime, route_worktree_text_request,
};
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Value, json};

#[derive(Debug, Default)]
struct FakeWorktreeRuntime {
    calls: Vec<(String, String, Option<Value>, Option<u64>)>,
    fail_get: bool,
}

impl DaemonWorktreeTextRuntime for FakeWorktreeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        if value == "." {
            "/repo".into()
        } else {
            value.into()
        }
    }

    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.calls
            .push((project.into(), route_path.into(), None, None));
        if self.fail_get {
            return ProjectServiceJsonResult::error(DaemonRouteResponse::text(
                503,
                "Error: project service unavailable\n",
            ));
        }
        match route_path {
            project_routes::WORKTREES => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "ok": true, "worktrees": [{ "name": "main", "branch": "master", "path": "/repo" }] }),
            ),
            project_routes::GRAVEYARD => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "ok": true, "entries": [{ "id": "claude-1", "tool": "claude" }], "worktrees": [] }),
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
        self.calls.push((
            project.into(),
            route_path.into(),
            Some(body.clone()),
            timeout_ms,
        ));
        match route_path {
            project_routes::worktree_actions::CREATE => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "ok": true, "path": format!("/repo/.aimux/worktrees/{}", body["name"].as_str().unwrap()), "status": "created" }),
            ),
            project_routes::worktree_actions::CACHE_CLEANUP => ProjectServiceJsonResult::ok(
                "/repo",
                json!({
                    "ok": true,
                    "dryRun": true,
                    "plan": {
                        "enabled": true,
                        "targets": [{ "path": "/repo/.cache", "worktreePath": "/repo", "relativePath": ".cache", "sizeBytes": 1024 }],
                        "reclaimableBytes": 1024
                    },
                    "results": []
                }),
            ),
            project_routes::worktree_actions::REMOVE => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "ok": true, "path": body["path"].clone(), "status": "removed" }),
            ),
            project_routes::worktree_actions::GRAVEYARD => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "ok": true, "path": body["path"].clone(), "status": "graveyarded" }),
            ),
            project_routes::graveyard_actions::RESURRECT_WORKTREE => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "ok": true, "path": body["path"].clone(), "status": "resurrected" }),
            ),
            project_routes::graveyard_actions::DELETE_WORKTREE => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "ok": true, "path": body["path"].clone(), "status": "deleted" }),
            ),
            project_routes::agents::KILL => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "ok": true, "sessionId": body["sessionId"].clone(), "status": "graveyard" }),
            ),
            project_routes::graveyard_actions::RESURRECT_AGENT => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "ok": true, "sessionId": body["sessionId"].clone(), "status": "offline" }),
            ),
            project_routes::graveyard_actions::CLEANUP => ProjectServiceJsonResult::ok(
                "/repo",
                json!({
                    "ok": true,
                    "dryRun": body["dryRun"].clone(),
                    "plan": { "enabled": true, "retentionDays": 30 },
                    "results": [{ "kind": "agent", "id": "claude-old", "status": "dry-run" }]
                }),
            ),
            _ => ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "not found\n")),
        }
    }
}

fn text_body(response: aimux::daemon::routing::DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

#[test]
fn worktree_list_and_create_match_text_and_json_contracts() {
    let mut runtime = FakeWorktreeRuntime::default();
    let listed = route_worktree_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.worktree_list_text),
        None,
    )
    .expect("worktree list");
    assert!(text_body(listed).contains("main"));

    let listed_json = route_worktree_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&json=1",
            CORE_API_ROUTES.worktree_list_text
        ),
        None,
    )
    .expect("worktree list json");
    assert_eq!(
        serde_json::from_str::<Value>(&text_body(listed_json)).unwrap(),
        json!([{ "name": "main", "branch": "master", "path": "/repo" }])
    );

    let created = route_worktree_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&name=feature",
            CORE_API_ROUTES.worktree_create_text
        ),
        None,
    )
    .expect("worktree create");
    assert_eq!(
        text_body(created),
        "Created worktree \"feature\" at /repo/.aimux/worktrees/feature\n"
    );
}

#[test]
fn worktree_path_routes_resolve_relative_paths_and_use_mutation_timeout() {
    let mut runtime = FakeWorktreeRuntime::default();
    for (route, expected_text, expected_service_route) in [
        (
            CORE_API_ROUTES.worktree_remove_text,
            "removed /repo/relative\n",
            project_routes::worktree_actions::REMOVE,
        ),
        (
            CORE_API_ROUTES.worktree_graveyard_text,
            "graveyarded /repo/relative\n",
            project_routes::worktree_actions::GRAVEYARD,
        ),
        (
            CORE_API_ROUTES.worktree_resurrect_text,
            "resurrected /repo/relative\n",
            project_routes::graveyard_actions::RESURRECT_WORKTREE,
        ),
        (
            CORE_API_ROUTES.worktree_delete_graveyard_text,
            "deleted /repo/relative\n",
            project_routes::graveyard_actions::DELETE_WORKTREE,
        ),
    ] {
        let response = route_worktree_text_request(
            &mut runtime,
            "POST",
            route,
            Some(&json!({ "project": "/repo", "path": "relative" })),
        )
        .expect("worktree path route");
        assert_eq!(text_body(response), expected_text);
        let call = runtime.calls.last().expect("last service call");
        assert_eq!(call.1, expected_service_route);
        assert_eq!(call.2.as_ref().unwrap()["path"], "/repo/relative");
        assert_eq!(call.3, Some(CLI_PROJECT_MUTATION_TIMEOUT_MS));
    }
}

#[test]
fn worktree_cache_cleanup_preserves_default_body_and_json_shape() {
    let mut runtime = FakeWorktreeRuntime::default();
    let cleanup = route_worktree_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo",
            CORE_API_ROUTES.worktree_cache_cleanup_text
        ),
        None,
    )
    .expect("worktree cleanup");
    assert!(
        text_body(cleanup)
            .contains("Worktree cache cleanup would remove 1 item(s), 1.0KB; 0 failed.")
    );
    let call = runtime.calls.last().expect("cleanup call");
    assert_eq!(
        call.2,
        Some(json!({ "dryRun": true, "includeActive": false }))
    );
    assert_eq!(call.3, Some(CLI_PROJECT_MUTATION_TIMEOUT_MS));

    let cleanup_json = route_worktree_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&json=1&dryRun=0&includeActive=1",
            CORE_API_ROUTES.worktree_cache_cleanup_text
        ),
        None,
    )
    .expect("worktree cleanup json");
    let parsed = serde_json::from_str::<Value>(&text_body(cleanup_json)).unwrap();
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["projectRoot"], "/repo");
    assert_eq!(parsed["plan"]["reclaimableBytes"], 1024);
    let call = runtime.calls.last().expect("cleanup json call");
    assert_eq!(
        call.2,
        Some(json!({ "dryRun": false, "includeActive": true }))
    );
}

#[test]
fn graveyard_routes_match_project_service_proxy_contract() {
    let mut runtime = FakeWorktreeRuntime::default();
    let listed = route_worktree_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.graveyard_list_text),
        None,
    )
    .expect("graveyard list");
    assert!(text_body(listed).contains("claude-1"));

    let resurrected = route_worktree_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&sessionId=claude-1",
            CORE_API_ROUTES.graveyard_resurrect_text
        ),
        None,
    )
    .expect("graveyard resurrect");
    assert_eq!(text_body(resurrected), "resurrected claude-1\n");

    let sent = route_worktree_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&sessionId=claude-1",
            CORE_API_ROUTES.graveyard_send_text
        ),
        None,
    )
    .expect("graveyard send");
    assert_eq!(text_body(sent), "graveyarded claude-1\n");

    let cleanup = route_worktree_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=/repo&dryRun=1",
            CORE_API_ROUTES.graveyard_cleanup_text
        ),
        None,
    )
    .expect("graveyard cleanup");
    assert!(text_body(cleanup).contains("Graveyard cleanup would remove 1 item(s); 0 failed."));
}

#[test]
fn validation_and_service_errors_return_text_route_responses() {
    let mut runtime = FakeWorktreeRuntime::default();
    let missing = route_worktree_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.worktree_remove_text,
        Some(&json!({ "project": "/repo" })),
    )
    .expect("worktree remove");
    assert_eq!(missing.status, 400);
    assert_eq!(text_body(missing), "path is required\n");

    let mut failed = FakeWorktreeRuntime {
        fail_get: true,
        ..FakeWorktreeRuntime::default()
    };
    let response = route_worktree_text_request(
        &mut failed,
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.worktree_list_text),
        None,
    )
    .expect("worktree list");
    assert_eq!(response.status, 503);
    assert_eq!(text_body(response), "Error: project service unavailable\n");
}

#[test]
fn unrelated_routes_are_left_for_other_modules() {
    let mut runtime = FakeWorktreeRuntime::default();
    assert!(
        route_worktree_text_request(&mut runtime, "GET", CORE_API_ROUTES.task_list_text, None)
            .is_none()
    );
}
