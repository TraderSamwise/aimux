use aimux::core_command_contract::CORE_COMMAND_NAMES;
use aimux::daemon::core_commands::{
    CoreCommandFailure, DaemonCoreCommandRuntime, optional_project_root, project_restart_result,
    require_project_root, route_core_command,
};
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::status::DaemonStatusRuntime;
use aimux::daemon_projects::ProjectsRouteProject;
use aimux::daemon_state::{AimuxDaemonInfo, DaemonState};
use aimux::daemon_supervisor::try_acquire_runtime_restart_lock;
use aimux::paths::PathResolver;
use serde_json::{Map, Value, json};

mod support;
use support::TestIsolation;

#[derive(Debug, Clone)]
struct FakeCoreRuntime {
    calls: Vec<String>,
    credentials: bool,
    relay: Value,
    record_prepare: bool,
}

impl Default for FakeCoreRuntime {
    fn default() -> Self {
        Self {
            calls: Vec::new(),
            credentials: true,
            relay: json!({ "status": "connected" }),
            record_prepare: false,
        }
    }
}

impl DaemonStatusRuntime for FakeCoreRuntime {
    fn current_daemon_info(&self, _issued_at: &str) -> AimuxDaemonInfo {
        AimuxDaemonInfo {
            pid: 9001,
            port: 43190,
            started_at: "then".into(),
            updated_at: "now".into(),
        }
    }

    fn project_service_info(&self) -> Value {
        json!({ "apiVersion": 5, "buildStamp": "stamp", "capabilities": {} })
    }

    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject> {
        vec![ProjectsRouteProject {
            id: "repo-id".into(),
            name: "repo".into(),
            path: "/repo".into(),
            last_seen: Some("2026-03-28T00:00:00.000Z".into()),
            dashboard_session_name: "aimux-repo-id".into(),
            service: Some(json!({ "projectId": "repo-id", "projectRoot": "/repo", "pid": 9123 })),
            service_alive: true,
            service_endpoint: Some(json!({ "host": "127.0.0.1", "port": 44191, "pid": 9123 })),
            online_agent_count: None,
        }]
    }

    fn daemon_state(&self) -> DaemonState {
        DaemonState {
            version: 1,
            updated_at: Some(json!("state-time")),
            projects: Map::from_iter([(
                "repo-id".into(),
                json!({ "projectId": "repo-id", "projectRoot": "/repo", "pid": 9123 }),
            )]),
        }
    }

    fn relay_status(&self) -> Value {
        self.relay.clone()
    }

    fn resolve_project_root(&self, cwd: &str) -> String {
        cwd.into()
    }
}

impl DaemonCoreCommandRuntime for FakeCoreRuntime {
    fn next_core_command_id(&self) -> String {
        "generated-id".into()
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        self.calls.push(format!("ensure:{project_root}"));
        Ok(json!({ "projectRoot": project_root, "pid": 9200 }))
    }

    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String> {
        self.calls.push(format!("stop:{project_root}:{force}"));
        Ok(json!({ "projectRoot": project_root, "pid": 9200 }))
    }

    fn restart_project_service(
        &mut self,
        project_root: &str,
        serve_only: bool,
    ) -> Result<Value, String> {
        self.calls
            .push(format!("restart:{project_root}:{serve_only}"));
        Ok(json!({
            "projectRoot": project_root,
            "project": { "projectRoot": project_root, "pid": 9201 },
            "dashboardSessionName": "aimux-repo",
            "dashboardTarget": { "sessionName": "aimux-repo", "windowIndex": 1 }
        }))
    }

    fn overseer_watch(
        &mut self,
        project_root: &str,
        session_id: &str,
        goal: Option<&str>,
        instructions: Option<&str>,
    ) -> Result<Value, CoreCommandFailure> {
        self.calls.push(format!(
            "watch:{project_root}:{session_id}:{}:{}",
            goal.unwrap_or(""),
            instructions.unwrap_or("")
        ));
        if session_id == "missing" {
            return Err(CoreCommandFailure {
                status: 404,
                error: "agent not found: missing".into(),
            });
        }
        Ok(json!({
            "projectRoot": project_root,
            "sessionId": session_id,
            "overseerSessionId": "claude-overseer",
            "watchedSessionIds": [session_id],
            "instructions": instructions,
        }))
    }

    fn restart_control_plane(
        &mut self,
        issued_at: &str,
        project_root: Option<&str>,
    ) -> Result<Value, String> {
        self.calls.push(format!(
            "control:{issued_at}:{}",
            project_root.unwrap_or("")
        ));
        Ok(
            json!({ "restart": { "summary": { "failures": 0 } }, "text": "Aimux Restart\n  failures: 0" }),
        )
    }

    fn prepare_restart_control_plane(
        &mut self,
        project_root: Option<&str>,
        force: bool,
        wait_for_capture: bool,
    ) -> Result<(), String> {
        if self.record_prepare {
            self.calls.push(format!(
                "prepare:{}:{force}:{wait_for_capture}",
                project_root.unwrap_or("")
            ));
        }
        Ok(())
    }

    fn has_remote_credentials(&self) -> bool {
        self.credentials
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        self.calls.push("relay-enable".into());
        self.relay.clone()
    }

    fn disable_relay(&mut self) -> Value {
        self.calls.push("relay-disable".into());
        json!({ "status": "off" })
    }

    fn relay_auth_failed_message(&self, relay: &Value) -> String {
        relay
            .get("lastError")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("Relay rejected credentials -- run `aimux login` again")
            .into()
    }
}

fn json_body(response: aimux::daemon::routing::DaemonRouteResponse) -> Value {
    match response.body {
        DaemonResponseBody::Json(value) => value,
        other => panic!("expected json body, got {other:?}"),
    }
}

#[test]
fn validates_core_command_envelope_like_daemon() {
    let mut runtime = FakeCoreRuntime::default();
    assert_eq!(
        json_body(route_core_command(
            &mut runtime,
            Some(&json!({ "id": " bad ", "command": "nope" })),
            "issued"
        )),
        json!({ "ok": false, "id": "bad", "command": "nope", "error": "unknown core command" })
    );

    assert_eq!(
        json_body(route_core_command(&mut runtime, Some(&json!({})), "issued")),
        json!({ "ok": false, "id": "generated-id", "error": "unknown core command" })
    );
}

#[test]
fn dispatches_ping_status_and_project_list_without_project_wake() {
    let mut runtime = FakeCoreRuntime::default();

    let ping = json_body(route_core_command(
        &mut runtime,
        Some(&json!({ "id": "p", "command": CORE_COMMAND_NAMES.ping })),
        "issued",
    ));
    assert_eq!(ping["result"], json!({ "pong": true }));

    let status = json_body(route_core_command(
        &mut runtime,
        Some(&json!({ "id": "s", "command": CORE_COMMAND_NAMES.status })),
        "issued",
    ));
    assert_eq!(status["result"]["daemon"]["pid"], 9001);
    assert_eq!(status["result"]["projects"].as_array().unwrap().len(), 1);
    assert_eq!(
        status["result"]["projects"][0],
        json!({
            "id": "repo-id",
            "name": "repo",
            "path": "/repo",
            "lastSeen": "2026-03-28T00:00:00.000Z",
            "dashboardSessionName": "aimux-repo-id",
            "service": { "projectId": "repo-id", "projectRoot": "/repo", "pid": 9123 },
            "serviceAlive": true,
            "serviceEndpoint": { "host": "127.0.0.1", "port": 44191, "pid": 9123 }
        })
    );
    assert_eq!(status["result"]["updatedAt"], "state-time");

    let projects = json_body(route_core_command(
        &mut runtime,
        Some(&json!({ "id": "l", "command": CORE_COMMAND_NAMES.projects_list })),
        "issued",
    ));
    assert_eq!(projects["result"]["projects"][0]["path"], "/repo");
    assert!(runtime.calls.is_empty());
}

#[test]
fn project_mutation_commands_validate_root_and_call_runtime() {
    let mut runtime = FakeCoreRuntime::default();
    let missing = route_core_command(
        &mut runtime,
        Some(&json!({ "id": "e", "command": CORE_COMMAND_NAMES.project_ensure, "payload": {} })),
        "issued",
    );
    assert_eq!(
        json_body(missing),
        json!({ "ok": false, "id": "e", "command": CORE_COMMAND_NAMES.project_ensure, "error": "projectRoot is required" })
    );

    for (command, expected_call) in [
        (CORE_COMMAND_NAMES.project_ensure, "ensure:/repo"),
        (CORE_COMMAND_NAMES.project_stop, "stop:/repo:false"),
        (CORE_COMMAND_NAMES.project_kill, "stop:/repo:true"),
    ] {
        let response = json_body(route_core_command(
            &mut runtime,
            Some(
                &json!({ "id": command, "command": command, "payload": { "projectRoot": "/repo" } }),
            ),
            "issued",
        ));
        assert_eq!(response["result"]["project"]["projectRoot"], "/repo");
        assert!(runtime.calls.contains(&expected_call.to_owned()));
    }
}

#[test]
fn project_restart_collapses_text_payload_to_command_result_contract() {
    let mut runtime = FakeCoreRuntime::default();
    let response = json_body(route_core_command(
        &mut runtime,
        Some(&json!({
            "id": "restart",
            "command": CORE_COMMAND_NAMES.project_restart,
            "payload": { "projectRoot": "/repo", "serve": true, "open": true }
        })),
        "issued",
    ));
    assert_eq!(runtime.calls, ["restart:/repo:true"]);
    assert_eq!(
        response["result"],
        json!({
            "project": { "projectRoot": "/repo", "pid": 9201 },
            "dashboardSessionName": "aimux-repo",
            "dashboardTarget": { "sessionName": "aimux-repo", "windowIndex": 1 }
        })
    );

    assert_eq!(
        project_restart_result(json!({ "project": { "pid": 1 }, "projectRoot": "/repo" })),
        json!({ "project": { "pid": 1 } })
    );
}

#[test]
fn overseer_watch_trims_inputs_and_propagates_domain_failures() {
    let mut runtime = FakeCoreRuntime::default();
    let response = json_body(route_core_command(
        &mut runtime,
        Some(&json!({
            "id": "watch",
            "command": CORE_COMMAND_NAMES.overseer_watch,
            "payload": { "projectRoot": "/repo", "sessionId": " codex-1 ", "goal": " go ", "instructions": " watch CI " }
        })),
        "issued",
    ));
    assert_eq!(response["result"]["watchedSessionIds"], json!(["codex-1"]));
    assert_eq!(response["result"]["instructions"], "watch CI");
    assert_eq!(runtime.calls, ["watch:/repo:codex-1:go:watch CI"]);

    let missing = json_body(route_core_command(
        &mut runtime,
        Some(&json!({
            "id": "watch",
            "command": CORE_COMMAND_NAMES.overseer_watch,
            "payload": { "projectRoot": "/repo", "sessionId": "missing" }
        })),
        "issued",
    ));
    assert_eq!(
        missing,
        json!({ "ok": false, "id": "watch", "command": CORE_COMMAND_NAMES.overseer_watch, "error": "agent not found: missing" })
    );
}

#[test]
fn restart_and_relay_commands_match_daemon_bus_contracts() {
    let _isolation = TestIsolation::new("daemon-core-restart");
    let mut runtime = FakeCoreRuntime::default();
    let restart = json_body(route_core_command(
        &mut runtime,
        Some(
            &json!({ "id": "r", "command": CORE_COMMAND_NAMES.restart, "payload": { "projectRoot": "relative" } }),
        ),
        "issued",
    ));
    assert_eq!(restart["result"]["text"], "Aimux Restart\n  failures: 0");
    assert!(runtime.calls[0].starts_with("control:issued:"));
    assert!(runtime.calls[0].ends_with("/relative"));

    let relay_status = json_body(route_core_command(
        &mut runtime,
        Some(&json!({ "id": "rs", "command": CORE_COMMAND_NAMES.relay_status })),
        "issued",
    ));
    assert_eq!(relay_status["result"]["relay"]["status"], "connected");

    let relay_enable = json_body(route_core_command(
        &mut runtime,
        Some(&json!({ "id": "re", "command": CORE_COMMAND_NAMES.relay_enable })),
        "issued",
    ));
    assert_eq!(relay_enable["result"]["relay"]["status"], "connected");

    let relay_disable = json_body(route_core_command(
        &mut runtime,
        Some(&json!({ "id": "rd", "command": CORE_COMMAND_NAMES.relay_disable })),
        "issued",
    ));
    assert_eq!(relay_disable["result"]["relay"]["status"], "off");
}

#[test]
fn restart_core_command_refuses_concurrent_restart_before_runtime_call() {
    let _isolation = TestIsolation::new("daemon-core-restart-busy");
    let resolver = PathResolver::from_env();
    let _lock = try_acquire_runtime_restart_lock(&resolver)
        .expect("acquire restart lock")
        .expect("restart lock");
    let mut runtime = FakeCoreRuntime {
        record_prepare: true,
        ..FakeCoreRuntime::default()
    };
    let response = json_body(route_core_command(
        &mut runtime,
        Some(&json!({ "id": "r", "command": CORE_COMMAND_NAMES.restart })),
        "issued",
    ));
    assert_eq!(
        response,
        json!({ "ok": false, "id": "r", "command": CORE_COMMAND_NAMES.restart, "error": "aimux restart is already running" })
    );
    assert_eq!(runtime.calls, vec!["prepare::false:true"]);
}

#[test]
fn restart_core_command_forwards_force_to_preflight_and_locked_recheck() {
    let _isolation = TestIsolation::new("daemon-core-restart-force");
    let mut runtime = FakeCoreRuntime {
        record_prepare: true,
        ..FakeCoreRuntime::default()
    };

    let response = json_body(route_core_command(
        &mut runtime,
        Some(&json!({
            "id": "r",
            "command": CORE_COMMAND_NAMES.restart,
            "payload": { "projectRoot": "/repo", "force": true }
        })),
        "issued",
    ));

    assert_eq!(response["result"]["text"], "Aimux Restart\n  failures: 0");
    assert_eq!(
        runtime.calls,
        vec![
            "prepare:/repo:true:true",
            "prepare:/repo:true:false",
            "control:issued:/repo",
        ]
    );
}

#[test]
fn relay_enable_requires_credentials_and_preserves_auth_failed_message() {
    let mut no_credentials = FakeCoreRuntime {
        credentials: false,
        ..FakeCoreRuntime::default()
    };
    assert_eq!(
        json_body(route_core_command(
            &mut no_credentials,
            Some(&json!({ "id": "relay", "command": CORE_COMMAND_NAMES.relay_enable })),
            "issued"
        )),
        json!({ "ok": false, "id": "relay", "command": CORE_COMMAND_NAMES.relay_enable, "error": "Not logged in. Run `aimux login` first." })
    );

    let mut auth_failed = FakeCoreRuntime {
        relay: json!({ "status": "auth_failed", "lastError": "bad token" }),
        ..FakeCoreRuntime::default()
    };
    assert_eq!(
        json_body(route_core_command(
            &mut auth_failed,
            Some(&json!({ "id": "relay", "command": CORE_COMMAND_NAMES.relay_enable })),
            "issued"
        )),
        json!({ "ok": false, "id": "relay", "command": CORE_COMMAND_NAMES.relay_enable, "error": "bad token" })
    );
}

#[test]
fn project_root_validators_match_core_command_error_contracts() {
    let missing = require_project_root("id", CORE_COMMAND_NAMES.project_ensure, Some(&json!({})))
        .expect_err("missing root");
    assert_eq!(
        json_body(missing),
        json!({ "ok": false, "id": "id", "command": CORE_COMMAND_NAMES.project_ensure, "error": "projectRoot is required" })
    );

    assert_eq!(
        optional_project_root("id", CORE_COMMAND_NAMES.restart, Some(&json!({}))).unwrap(),
        None
    );
    let empty = optional_project_root(
        "id",
        CORE_COMMAND_NAMES.restart,
        Some(&json!({ "projectRoot": " " })),
    )
    .expect_err("empty optional root");
    assert_eq!(
        json_body(empty),
        json!({ "ok": false, "id": "id", "command": CORE_COMMAND_NAMES.restart, "error": "projectRoot must be a non-empty string when provided" })
    );
}
