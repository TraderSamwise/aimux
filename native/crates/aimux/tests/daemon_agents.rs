use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::agents::{
    DaemonAgentTextRuntime, ProjectServicePostOptions, route_agent_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
struct Call {
    project: String,
    route_path: String,
    body: Option<Value>,
    ensure_project: Option<bool>,
}

#[derive(Debug, Default)]
struct FakeAgentRuntime {
    calls: Vec<Call>,
    fail_event: bool,
    invalid_agents: bool,
}

impl DaemonAgentTextRuntime for FakeAgentRuntime {
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
        self.calls.push(Call {
            project: project.into(),
            route_path: route_path.into(),
            body: None,
            ensure_project: None,
        });
        match route_path {
            project_routes::agents::LIST if self.invalid_agents => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "agents": [{ "id": "claude-1" }, []] }),
            ),
            project_routes::agents::LIST => ProjectServiceJsonResult::ok(
                "/repo",
                json!({
                    "agents": [{
                        "id": "claude-1",
                        "tool": "claude",
                        "role": "dev",
                        "status": "running",
                        "activity": "busy",
                        "attention": "needed",
                        "worktreePath": "/repo/wt",
                        "task": { "description": "Ship", "status": "todo" }
                    }]
                }),
            ),
            _ => ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "not found\n")),
        }
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        options: ProjectServicePostOptions,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            project: project.into(),
            route_path: route_path.into(),
            body: Some(body.clone()),
            ensure_project: Some(options.ensure_project),
        });
        match route_path {
            project_routes::agents::SPAWN => {
                ProjectServiceJsonResult::ok("/repo", json!({ "sessionId": "claude-1" }))
            }
            project_routes::agents::STOP => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "sessionId": body["sessionId"].clone(), "status": "offline" }),
            ),
            project_routes::agents::KILL => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "sessionId": body["sessionId"].clone(), "status": "graveyard", "previousStatus": "running" }),
            ),
            project_routes::agents::FORK => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "sessionId": "codex-2", "threadId": "thread-1" }),
            ),
            project_routes::agents::INPUT => {
                ProjectServiceJsonResult::ok("/repo", json!({ "ok": true }))
            }
            project_routes::agents::RENAME => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "sessionId": body["sessionId"].clone(), "label": body["label"].clone() }),
            ),
            project_routes::agents::MIGRATE => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "sessionId": body["sessionId"].clone() }),
            ),
            project_routes::agents::LOOP => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "sessionId": body["sessionId"].clone(), "loop": { "goal": "canonical goal" } }),
            ),
            project_routes::runtime::EVENT if self.fail_event => ProjectServiceJsonResult::error(
                DaemonRouteResponse::json(502, json!({ "error": "event failed" })),
            ),
            project_routes::runtime::EVENT => {
                ProjectServiceJsonResult::ok("/repo", json!({ "ok": true }))
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
fn lifecycle_routes_match_agent_project_service_contracts() {
    let mut runtime = FakeAgentRuntime::default();

    let spawned = route_agent_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=.&tool=claude&worktreePath=wt&open=0",
            CORE_API_ROUTES.lifecycle_spawn_text
        ),
        Some(&json!({ "extraArgs": ["--model", "gpt-5"] })),
    )
    .expect("spawn route");
    assert_eq!(text_body(spawned), "spawned claude-1\n");
    let spawn_call = runtime.calls.last().unwrap();
    assert_eq!(spawn_call.project, ".");
    assert_eq!(spawn_call.route_path, project_routes::agents::SPAWN);
    assert_eq!(spawn_call.ensure_project, Some(true));
    assert_eq!(
        spawn_call.body.as_ref().unwrap(),
        &json!({
            "tool": "claude",
            "worktreePath": "/repo/wt",
            "extraArgs": ["--model", "gpt-5"],
            "open": false
        })
    );

    let stopped = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.lifecycle_stop_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1" })),
    )
    .expect("stop route");
    assert_eq!(text_body(stopped), "stopped claude-1\n");
    assert_eq!(runtime.calls.last().unwrap().ensure_project, Some(false));

    let killed = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.lifecycle_kill_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1" })),
    )
    .expect("kill route");
    assert_eq!(text_body(killed), "graveyarded claude-1\n");
    assert_eq!(runtime.calls.last().unwrap().ensure_project, Some(false));

    let forked = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.lifecycle_fork_text,
        Some(&json!({
            "project": "/repo",
            "sourceSessionId": "claude-1",
            "tool": "codex",
            "instruction": "continue",
            "worktreePath": "../other"
        })),
    )
    .expect("fork route");
    assert_eq!(text_body(forked), "forked codex-2\nthread thread-1\n");
    assert_eq!(
        runtime.calls.last().unwrap().body.as_ref().unwrap(),
        &json!({
            "sourceSessionId": "claude-1",
            "tool": "codex",
            "instruction": "continue",
            "worktreePath": "/other",
            "open": true
        })
    );
}

#[test]
fn agent_read_mutation_routes_match_text_and_json_shapes() {
    let mut runtime = FakeAgentRuntime::default();

    let input = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.agent_input_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1", "text": "hello" })),
    )
    .expect("input route");
    assert_eq!(text_body(input), "delivered to claude-1\n");

    let ps = route_agent_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.agent_ps_text),
        None,
    )
    .expect("ps route");
    let ps_text = text_body(ps);
    assert!(ps_text.contains("claude-1  [claude:dev]  running  busy/needed"));
    assert!(ps_text.contains("worktree: /repo/wt"));
    assert!(ps_text.contains("task: Ship (todo)"));

    let ps_json = route_agent_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=/repo&json=1", CORE_API_ROUTES.agent_ps_text),
        None,
    )
    .expect("ps json route");
    assert_eq!(json_text(ps_json)[0]["id"], "claude-1");

    let list = route_agent_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.agent_list_text),
        None,
    )
    .expect("list route");
    let list_text = text_body(list);
    assert!(list_text.contains("wt  /repo/wt"));
    assert!(
        list_text
            .contains("  running  canonical=claude  aimux=claude-1  state=busy/needed  role=dev")
    );
    assert!(list_text.contains("    task: Ship (todo)"));

    let list_json = route_agent_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=/repo&json=1", CORE_API_ROUTES.agent_list_text),
        None,
    )
    .expect("list json route");
    assert_eq!(json_text(list_json)[0]["id"], "claude-1");

    let invalid_ps = route_agent_text_request(
        &mut FakeAgentRuntime {
            invalid_agents: true,
            ..FakeAgentRuntime::default()
        },
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.agent_ps_text),
        None,
    )
    .expect("ps route");
    assert_eq!(invalid_ps.status, 502);
    assert_eq!(
        text_body(invalid_ps),
        "Error: project service returned invalid agent ps response: agents entries are invalid\n"
    );

    let invalid_list = route_agent_text_request(
        &mut FakeAgentRuntime {
            invalid_agents: true,
            ..FakeAgentRuntime::default()
        },
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.agent_list_text),
        None,
    )
    .expect("list route");
    assert_eq!(invalid_list.status, 502);
    assert_eq!(
        text_body(invalid_list),
        "Error: project service returned invalid agent list response: agents entries are invalid\n"
    );

    let missing_label = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.agent_rename_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1" })),
    )
    .expect("rename route");
    assert_eq!(missing_label.status, 400);
    assert_eq!(text_body(missing_label), "label is required\n");

    let renamed_empty = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.agent_rename_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1", "label": "" })),
    )
    .expect("rename route");
    assert_eq!(text_body(renamed_empty), "renamed claude-1 ->\n");

    let migrated = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.agent_migrate_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1", "worktreePath": "wt" })),
    )
    .expect("migrate route");
    assert_eq!(text_body(migrated), "migrated claude-1 -> /repo/wt\n");
    let migrate_call = runtime.calls.last().unwrap();
    assert_eq!(migrate_call.project, "/repo");
    assert_eq!(
        migrate_call.body.as_ref().unwrap(),
        &json!({ "sessionId": "claude-1", "worktreePath": "/repo/wt" })
    );
}

#[test]
fn loop_routes_preserve_source_defaults_and_best_effort_event_write() {
    let mut runtime = FakeAgentRuntime::default();

    let added = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.loop_add_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1", "goal": "ship", "updatedBy": "sam" })),
    )
    .expect("loop add");
    assert_eq!(text_body(added), "loop on claude-1 — canonical goal\n");
    assert_eq!(
        runtime.calls.last().unwrap().body.as_ref().unwrap(),
        &json!({
            "sessionId": "claude-1",
            "source": "human",
            "updatedBy": "sam",
            "active": true,
            "action": "add",
            "goal": "ship"
        })
    );

    let removed = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.loop_remove_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1", "source": "overseer" })),
    )
    .expect("loop remove");
    assert_eq!(text_body(removed), "loop off claude-1\n");
    assert_eq!(
        runtime.calls.last().unwrap().body.as_ref().unwrap(),
        &json!({
            "sessionId": "claude-1",
            "source": "overseer",
            "active": false,
            "action": "remove"
        })
    );

    let done = route_agent_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.loop_done_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1" })),
    )
    .expect("loop done");
    assert_eq!(text_body(done), "loop done claude-1\n");
    assert_eq!(
        runtime.calls[runtime.calls.len() - 2]
            .body
            .as_ref()
            .unwrap(),
        &json!({
            "sessionId": "claude-1",
            "source": "agent",
            "active": false,
            "action": "done"
        })
    );
    assert_eq!(
        runtime.calls.last().unwrap().body.as_ref().unwrap(),
        &json!({
            "session": "claude-1",
            "event": {
                "kind": "task_done",
                "message": "Loop goal completed.",
                "tone": "success",
                "source": "loop"
            }
        })
    );
    assert_eq!(runtime.calls.last().unwrap().ensure_project, Some(false));

    let mut failed_event = FakeAgentRuntime {
        fail_event: true,
        ..FakeAgentRuntime::default()
    };
    let blocked = route_agent_text_request(
        &mut failed_event,
        "POST",
        CORE_API_ROUTES.loop_block_text,
        Some(&json!({ "project": "/repo", "sessionId": "claude-1", "reason": "waiting" })),
    )
    .expect("loop block");
    assert_eq!(
        text_body(blocked),
        "aimux: loop exited, but the status event could not be recorded: [object Object]\nloop blocked claude-1\n"
    );
    assert_eq!(
        failed_event.calls[failed_event.calls.len() - 2]
            .body
            .as_ref()
            .unwrap(),
        &json!({
            "sessionId": "claude-1",
            "source": "agent",
            "active": false,
            "action": "block",
            "reason": "waiting"
        })
    );
    assert_eq!(
        failed_event.calls.last().unwrap().body.as_ref().unwrap(),
        &json!({
            "session": "claude-1",
            "event": { "kind": "blocked", "message": "waiting", "source": "loop" }
        })
    );
}

#[test]
fn unrelated_agent_routes_are_left_for_other_modules() {
    assert!(
        route_agent_text_request(
            &mut FakeAgentRuntime::default(),
            "GET",
            CORE_API_ROUTES.task_list_text,
            None,
        )
        .is_none()
    );
}
