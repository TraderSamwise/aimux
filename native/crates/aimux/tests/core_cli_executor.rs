use aimux::core_cli::{CoreCommandCall, CoreCommandOk, CoreLoopActorContext};
use aimux::core_cli_executor::{CoreCliRuntime, run_core_cli_with};
use aimux::core_command_contract::CORE_COMMAND_NAMES;
use aimux::daemon::text::auth::AuthFlowResult;
use aimux::daemon::text::operations::RestartControlPlaneTextResult;
use aimux::daemon_state::{AimuxDaemonInfo, DaemonState};
use serde_json::{Value, json};
use std::cell::Cell;
use std::path::{Path, PathBuf};

#[derive(Debug)]
struct FakeRuntime {
    cwd: String,
    daemon_info: Option<AimuxDaemonInfo>,
    daemon_state: DaemonState,
    commands: Vec<CoreCommandCall>,
    text_routes: Vec<(String, Option<Value>)>,
    open_targets: Vec<Value>,
    restart_calls: Vec<Option<String>>,
    login_calls: Cell<usize>,
    security_unlock_calls: Cell<usize>,
    credentials: Option<Value>,
    cleared_credentials: Cell<usize>,
    remote_enabled: Cell<Option<bool>>,
    fail_commands: bool,
    restart_failures: i64,
    log_path: PathBuf,
    log_output: String,
    clear_count: Cell<usize>,
}

impl Default for FakeRuntime {
    fn default() -> Self {
        Self {
            cwd: "/repo".into(),
            daemon_info: Some(daemon_info()),
            daemon_state: DaemonState::empty(),
            commands: Vec::new(),
            text_routes: Vec::new(),
            open_targets: Vec::new(),
            restart_calls: Vec::new(),
            login_calls: Cell::new(0),
            security_unlock_calls: Cell::new(0),
            credentials: None,
            cleared_credentials: Cell::new(0),
            remote_enabled: Cell::new(None),
            fail_commands: false,
            restart_failures: 0,
            log_path: PathBuf::from("/tmp/aimux.log"),
            log_output: String::new(),
            clear_count: Cell::new(0),
        }
    }
}

impl CoreCliRuntime for FakeRuntime {
    fn cwd(&self) -> String {
        self.cwd.clone()
    }

    fn resolve_project_root(&self, path: &str) -> String {
        if path == "." || path == self.cwd {
            "/repo".into()
        } else {
            format!("/resolved/{path}")
        }
    }

    fn load_daemon_info(&self) -> Option<AimuxDaemonInfo> {
        self.daemon_info.clone()
    }

    fn load_daemon_state(&self) -> DaemonState {
        self.daemon_state.clone()
    }

    fn has_remote_credentials(&self) -> bool {
        self.credentials.is_some()
    }

    fn loop_actor_context(&self) -> CoreLoopActorContext {
        CoreLoopActorContext::default()
    }

    fn credentials_for_status(&self) -> Option<Value> {
        self.credentials.as_ref().map(|credentials| {
            json!({
                "relayUrl": credentials["relayUrl"].clone(),
                "remoteEnabled": credentials["remoteEnabled"].clone(),
            })
        })
    }

    fn whoami_payload(&self) -> Value {
        json!({ "credentials": self.credentials.clone() })
    }

    fn set_remote_enabled(&self, enabled: bool) -> Result<(), String> {
        self.remote_enabled.set(Some(enabled));
        Ok(())
    }

    fn clear_credentials(&self) -> String {
        self.cleared_credentials
            .set(self.cleared_credentials.get() + 1);
        if self.credentials.is_some() {
            "cleared".into()
        } else {
            "none".into()
        }
    }

    fn run_login_flow(&self, security_unlock: bool) -> Result<AuthFlowResult, String> {
        if security_unlock {
            self.security_unlock_calls
                .set(self.security_unlock_calls.get() + 1);
        } else {
            self.login_calls.set(self.login_calls.get() + 1);
        }
        Ok(AuthFlowResult {
            user_id: "user-1".into(),
            relay: Value::Null,
            messages: vec![
                "Opening your browser to sign in...".into(),
                "If it doesn't open, visit:\n  https://aimux.app/cli-auth?callback=local\n".into(),
            ],
        })
    }

    fn request_core_command(&mut self, request: &CoreCommandCall) -> Result<CoreCommandOk, String> {
        self.commands.push(request.clone());
        if self.fail_commands {
            return Err("offline".into());
        }
        Ok(command_ok(request.command, response_for(request)))
    }

    fn request_daemon_text(&mut self, path: &str, body: Option<Value>) -> Result<String, String> {
        self.text_routes.push((path.to_owned(), body));
        Ok(if path.starts_with("/core/host-agent-stream-text?") {
            "streamed output\n".into()
        } else if path.starts_with("/core/host-agent-read-text?") {
            "pane output\n".into()
        } else if path.starts_with("/core/agents/ps-text?") {
            "claude-1  [claude]  ready\n".into()
        } else if path == "/core/agents/input-text" {
            "delivered to claude-1\n".into()
        } else if path.starts_with("/core/agents/rename-text") {
            "renamed claude-1 -> reviewer\n".into()
        } else if path.starts_with("/core/agents/migrate-text") {
            "migrated claude-1 -> feature\n".into()
        } else if path.starts_with("/core/lifecycle/spawn-text") {
            "spawned claude-1\n".into()
        } else if path.starts_with("/core/lifecycle/stop-text") {
            "stopped claude-1\n".into()
        } else if path.starts_with("/core/lifecycle/kill-text") {
            "graveyarded claude-1\n".into()
        } else if path.starts_with("/core/lifecycle/fork-text") {
            "forked codex-2\nthread thread-1\n".into()
        } else if path.starts_with("/core/loop/") {
            "loop ok\n".into()
        } else if path.starts_with("/core/overseer/") {
            "overseer ok\n".into()
        } else if path.starts_with("/core/team/") {
            "team ok\n".into()
        } else if path.starts_with("/core/notifications/") {
            "notifications ok\n".into()
        } else if path.starts_with("/core/task/")
            || path.starts_with("/core/review/")
            || path.starts_with("/core/message/")
            || path.starts_with("/core/handoff/")
            || path.starts_with("/core/thread/")
        {
            "task task-1\nthread thread-1\n".into()
        } else if path.starts_with("/core/worktree/") || path.starts_with("/core/graveyard/") {
            "worktree ok\n".into()
        } else if path.starts_with("/core/metadata-text") {
            "metadata ok\n".into()
        } else if path.starts_with("/core/repair-text")
            || path.starts_with("/core/repair-exchange-text")
        {
            "repair ok\n".into()
        } else if path.ends_with("?json=1") {
            "{\n  \"generatedAt\": \"now\",\n  \"projects\": []\n}\n".into()
        } else {
            "Runtime Coherence\n  ok\n".into()
        })
    }

    fn selected_log_path(&self, _options: &aimux::core_cli_routing::CoreLogsArgs) -> PathBuf {
        self.log_path.clone()
    }

    fn read_log_lines(&self, _path: &Path, _lines: usize) -> String {
        self.log_output.clone()
    }

    fn clear_log(&self, _path: &Path) -> Result<(), String> {
        self.clear_count.set(self.clear_count.get() + 1);
        Ok(())
    }

    fn open_dashboard_target(&mut self, target: &Value) -> Result<(), String> {
        self.open_targets.push(target.clone());
        Ok(())
    }

    fn restart_control_plane(
        &mut self,
        project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        self.restart_calls.push(project_root.map(str::to_owned));
        Ok(RestartControlPlaneTextResult {
            restart: json!({
                "daemon": {
                    "previous": null,
                    "current": { "pid": 9001 },
                    "retained": false
                },
                "projects": [],
                "summary": {
                    "projects": 0,
                    "servicesEnsured": 0,
                    "runtimeRepairs": 0,
                    "dashboardsReloaded": 0,
                    "runtimeRebuildRequired": 0,
                    "orphanProcessesCleaned": 0,
                    "orphanTmuxSessionsCleaned": 0,
                    "failures": self.restart_failures
                }
            }),
            text: format!("Aimux Restart\n  failures: {}", self.restart_failures),
        })
    }
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn daemon_info() -> AimuxDaemonInfo {
    AimuxDaemonInfo {
        pid: 9001,
        port: 43190,
        started_at: "then".into(),
        updated_at: "now".into(),
    }
}

fn command_ok(command: &str, result: Value) -> CoreCommandOk {
    CoreCommandOk {
        ok: true,
        id: "test".into(),
        command: command.into(),
        issued_at: "1970-01-01T00:00:00.000Z".into(),
        result,
    }
}

fn status_result() -> Value {
    json!({
        "daemon": {
            "pid": 9001,
            "port": 43190,
            "serviceInfo": { "apiVersion": 5, "buildStamp": "stamp", "capabilities": {} }
        },
        "projects": [{
            "id": "repo-id",
            "name": "repo",
            "path": "/repo",
            "serviceAlive": true,
            "service": { "pid": 9002 },
            "serviceEndpoint": { "host": "127.0.0.1", "port": 44000 },
            "dashboardSessionName": "aimux-repo"
        }],
        "relay": { "status": "off" }
    })
}

fn response_for(request: &CoreCommandCall) -> Value {
    match request.command {
        command if command == CORE_COMMAND_NAMES.status => status_result(),
        command if command == CORE_COMMAND_NAMES.projects_list => {
            json!({ "projects": status_result()["projects"].clone() })
        }
        command if command == CORE_COMMAND_NAMES.project_ensure => {
            json!({ "project": { "projectRoot": request.payload.as_ref().unwrap()["projectRoot"].clone(), "pid": 9100 } })
        }
        command
            if command == CORE_COMMAND_NAMES.project_stop
                || command == CORE_COMMAND_NAMES.project_kill =>
        {
            json!({ "project": { "projectRoot": request.payload.as_ref().unwrap()["projectRoot"].clone(), "pid": 9100 } })
        }
        command if command == CORE_COMMAND_NAMES.project_restart => json!({
            "project": { "projectRoot": request.payload.as_ref().unwrap()["projectRoot"].clone(), "pid": 9101 },
            "dashboardSessionName": "aimux-repo",
            "dashboardTarget": { "sessionName": "aimux-repo", "windowIndex": 1 }
        }),
        command if command == CORE_COMMAND_NAMES.relay_disable => {
            json!({ "relay": { "status": "off" } })
        }
        command if command == CORE_COMMAND_NAMES.relay_enable => {
            json!({ "relay": { "status": "connected" } })
        }
        command if command == CORE_COMMAND_NAMES.relay_status => {
            json!({ "relay": { "status": "connected" } })
        }
        _ => json!({}),
    }
}

#[test]
fn host_and_project_commands_execute_through_core_requests() {
    let mut runtime = FakeRuntime::default();

    let serve = run_core_cli_with(&args(&["serve"]), &mut runtime);
    assert_eq!(serve.code, 0);
    assert_eq!(
        serve.stdout,
        ["aimux serve: daemon managing /repo (service pid 9100)"]
    );
    assert_eq!(
        runtime.commands[0].command,
        CORE_COMMAND_NAMES.project_ensure
    );
    assert_eq!(
        runtime.commands[0].payload,
        Some(json!({ "projectRoot": "/repo" }))
    );

    let restart = run_core_cli_with(&args(&["host", "restart", "--serve"]), &mut runtime);
    assert_eq!(restart.code, 0);
    assert_eq!(restart.stdout, ["Restarted project service for aimux-repo"]);
    assert_eq!(
        runtime.commands[1].command,
        CORE_COMMAND_NAMES.project_restart
    );
    assert_eq!(
        runtime.commands[1].payload,
        Some(json!({ "projectRoot": "/repo", "serve": true }))
    );
}

#[test]
fn host_status_and_projects_render_text_and_json_like_core_cli() {
    let mut runtime = FakeRuntime::default();

    let host = run_core_cli_with(&args(&["host", "status"]), &mut runtime);
    assert_eq!(host.code, 0);
    assert_eq!(
        host.stdout,
        [
            "Service: live",
            "Service pid=9002",
            "Metadata: {\"host\":\"127.0.0.1\",\"port\":44000}",
            "Expected manifest: {\"apiVersion\":5,\"buildStamp\":\"stamp\",\"capabilities\":{}}",
            "Tmux session: aimux-repo"
        ]
    );

    let projects = run_core_cli_with(&args(&["projects", "list", "--json"]), &mut runtime);
    assert_eq!(projects.code, 0);
    let parsed: Value = serde_json::from_str(&projects.stdout[0]).expect("projects JSON");
    assert_eq!(parsed["projects"][0]["path"], "/repo");
}

#[test]
fn daemon_status_uses_stored_state_when_daemon_request_fails() {
    let mut runtime = FakeRuntime {
        fail_commands: true,
        daemon_state: DaemonState {
            version: 1,
            updated_at: Some(json!("now")),
            projects: [(
                "repo-id".into(),
                json!({ "projectId": "repo-id", "projectRoot": "/repo", "pid": 9002 }),
            )]
            .into_iter()
            .collect(),
        },
        ..FakeRuntime::default()
    };

    let execution = run_core_cli_with(&args(&["daemon", "status"]), &mut runtime);
    assert_eq!(execution.code, 0);
    assert_eq!(
        execution.stdout,
        [
            "Daemon pid=9001 port=43190",
            "Known projects: 1",
            "Live project services: 0",
            "Relay: off"
        ]
    );
    assert_eq!(runtime.commands[0].command, CORE_COMMAND_NAMES.status);
    assert!(!runtime.commands[0].options.ensure_daemon);
    assert_eq!(runtime.commands[0].options.timeout_ms, Some(1000));
}

#[test]
fn logs_execute_without_daemon_requests() {
    let mut runtime = FakeRuntime {
        daemon_info: None,
        log_output: "one\ntwo".into(),
        ..FakeRuntime::default()
    };

    let path = run_core_cli_with(&args(&["logs", "path", "--daemon"]), &mut runtime);
    assert_eq!(path.code, 0);
    assert_eq!(path.stdout, ["/tmp/aimux.log"]);
    assert!(path.stderr.is_empty());

    let tail = run_core_cli_with(&args(&["logs", "tail", "-n", "2"]), &mut runtime);
    assert_eq!(tail.stdout, ["one\ntwo"]);

    let clear = run_core_cli_with(&args(&["logs", "clear"]), &mut runtime);
    assert_eq!(clear.code, 0);
    assert_eq!(clear.stdout, ["Cleared /tmp/aimux.log"]);
    assert_eq!(runtime.clear_count.get(), 1);
    assert!(runtime.commands.is_empty());
}

#[test]
fn doctor_versions_executes_daemon_text_route() {
    let mut runtime = FakeRuntime::default();

    let text = run_core_cli_with(&args(&["doctor", "versions"]), &mut runtime);
    assert_eq!(text.code, 0);
    assert_eq!(text.stdout, ["Runtime Coherence\n  ok"]);

    let json = run_core_cli_with(&args(&["doctor", "versions", "--json"]), &mut runtime);
    assert_eq!(json.code, 0);
    assert_eq!(
        serde_json::from_str::<Value>(&json.stdout[0]).expect("doctor json"),
        json!({ "generatedAt": "now", "projects": [] })
    );
    assert_eq!(
        runtime.text_routes,
        [
            ("/core/doctor/versions-text".into(), None),
            ("/core/doctor/versions-text?json=1".into(), None)
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn dashboard_reload_and_runtime_restart_execute_native_text_routes() {
    let mut runtime = FakeRuntime::default();

    let reload = run_core_cli_with(
        &args(&[
            "dashboard-reload",
            "--open",
            "--client-tty",
            "/dev/ttys001",
            "--current-client-session=aimux-repo-client-abc12345",
        ]),
        &mut runtime,
    );
    assert_eq!(reload.code, 0);
    assert_eq!(reload.stdout, ["Runtime Coherence\n  ok"]);

    let restart = run_core_cli_with(
        &args(&["restart-runtime", "--project-root", "child", "--json"]),
        &mut runtime,
    );
    assert_eq!(restart.code, 0);
    assert_eq!(
        serde_json::from_str::<Value>(&restart.stdout[0]).expect("runtime restart json"),
        json!({ "generatedAt": "now", "projects": [] })
    );
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/dashboard-reload-text".into(),
                Some(json!({
                    "projectRoot": "/repo",
                    "open": true,
                    "clientTty": "/dev/ttys001",
                    "currentClientSession": "aimux-repo-client-abc12345"
                })),
            ),
            (
                "/core/runtime-restart-text?json=1".into(),
                Some(json!({ "projectRoot": "/resolved/child" })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn host_agent_read_executes_native_text_route_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let read = run_core_cli_with(
        &args(&[
            "host",
            "agent-read",
            "claude-1",
            "--project=/repo",
            "--lines",
            "80",
        ]),
        &mut runtime,
    );

    assert_eq!(read.code, 0);
    assert_eq!(read.stdout, ["pane output"]);
    assert_eq!(
        runtime.text_routes,
        [(
            "/core/host-agent-read-text?project=%2Frepo&sessionId=claude-1&startLine=-80".into(),
            None,
        )]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn host_agent_stream_executes_native_text_route_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let stream = run_core_cli_with(
        &args(&[
            "host",
            "agent-stream",
            "claude-1",
            "--project=/repo",
            "--start-line",
            "-80",
            "--interval-ms",
            "250",
        ]),
        &mut runtime,
    );

    assert_eq!(stream.code, 0);
    assert_eq!(stream.stdout, ["streamed output"]);
    assert_eq!(
        runtime.text_routes,
        [(
            "/core/host-agent-stream-text?project=%2Frepo&sessionId=claude-1&startLine=-80&intervalMs=250".into(),
            None,
        )]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn agent_ps_executes_native_text_route_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let ps = run_core_cli_with(&args(&["ps", "--project", "/repo", "--json"]), &mut runtime);

    assert_eq!(ps.code, 0);
    assert_eq!(ps.stdout, ["claude-1  [claude]  ready"]);
    assert_eq!(
        runtime.text_routes,
        [("/core/agents/ps-text?project=%2Frepo&json=1".into(), None,)]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn agent_input_executes_native_text_route_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let input = run_core_cli_with(
        &args(&["input", "claude-1", "hello", "--project", "/repo"]),
        &mut runtime,
    );

    assert_eq!(input.code, 0);
    assert_eq!(input.stdout, ["delivered to claude-1"]);
    assert_eq!(
        runtime.text_routes,
        [(
            "/core/agents/input-text".into(),
            Some(json!({
                "project": "/repo",
                "sessionId": "claude-1",
                "text": "hello",
            })),
        )]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn agent_rename_and_migrate_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let rename = run_core_cli_with(
        &args(&[
            "rename",
            "claude-1",
            "--label",
            "reviewer",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let migrate = run_core_cli_with(
        &args(&["migrate", "claude-1", "--worktree", "feature"]),
        &mut runtime,
    );

    assert_eq!(rename.code, 0);
    assert_eq!(rename.stdout, ["renamed claude-1 -> reviewer"]);
    assert_eq!(migrate.code, 0);
    assert_eq!(migrate.stdout, ["migrated claude-1 -> feature"]);
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/agents/rename-text".into(),
                Some(json!({
                    "project": "/repo",
                    "sessionId": "claude-1",
                    "label": "reviewer",
                })),
            ),
            (
                "/core/agents/migrate-text".into(),
                Some(json!({
                    "project": "/repo",
                    "sessionId": "claude-1",
                    "worktreePath": "feature",
                })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn lifecycle_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let spawn = run_core_cli_with(
        &args(&[
            "spawn",
            "--tool",
            "claude",
            "--worktree",
            "feature",
            "--no-open",
        ]),
        &mut runtime,
    );
    let stop = run_core_cli_with(&args(&["stop", "claude-1"]), &mut runtime);
    let kill = run_core_cli_with(&args(&["kill", "claude-1"]), &mut runtime);
    let fork = run_core_cli_with(
        &args(&[
            "fork",
            "claude-1",
            "--tool",
            "codex",
            "--instruction",
            "continue",
        ]),
        &mut runtime,
    );

    assert_eq!(spawn.stdout, ["spawned claude-1"]);
    assert_eq!(stop.stdout, ["stopped claude-1"]);
    assert_eq!(kill.stdout, ["graveyarded claude-1"]);
    assert_eq!(fork.stdout, ["forked codex-2\nthread thread-1"]);
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/lifecycle/spawn-text".into(),
                Some(json!({
                    "project": "/repo",
                    "tool": "claude",
                    "worktreePath": "feature",
                    "open": false,
                })),
            ),
            (
                "/core/lifecycle/stop-text".into(),
                Some(json!({ "project": "/repo", "sessionId": "claude-1" })),
            ),
            (
                "/core/lifecycle/kill-text".into(),
                Some(json!({ "project": "/repo", "sessionId": "claude-1" })),
            ),
            (
                "/core/lifecycle/fork-text".into(),
                Some(json!({
                    "project": "/repo",
                    "sourceSessionId": "claude-1",
                    "tool": "codex",
                    "instruction": "continue",
                    "worktreePath": null,
                    "open": true,
                })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn loop_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let add = run_core_cli_with(
        &args(&["loop", "add", "claude-1", "--goal", "keep going"]),
        &mut runtime,
    );
    let remove = run_core_cli_with(&args(&["loop", "remove", "claude-1"]), &mut runtime);
    let done = run_core_cli_with(
        &args(&["loop", "done", "--session", "claude-1", "--reason", "done"]),
        &mut runtime,
    );
    let block = run_core_cli_with(
        &args(&["loop", "block", "--session=claude-1", "--reason=blocked"]),
        &mut runtime,
    );

    assert_eq!(add.stdout, ["loop ok"]);
    assert_eq!(remove.stdout, ["loop ok"]);
    assert_eq!(done.stdout, ["loop ok"]);
    assert_eq!(block.stdout, ["loop ok"]);
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/loop/add-text".into(),
                Some(json!({
                    "project": "/repo",
                    "sessionId": "claude-1",
                    "source": "human",
                    "goal": "keep going",
                })),
            ),
            (
                "/core/loop/remove-text".into(),
                Some(json!({
                    "project": "/repo",
                    "sessionId": "claude-1",
                    "source": "human",
                })),
            ),
            (
                "/core/loop/done-text".into(),
                Some(json!({
                    "project": "/repo",
                    "sessionId": "claude-1",
                    "source": "agent",
                    "reason": "done",
                })),
            ),
            (
                "/core/loop/block-text".into(),
                Some(json!({
                    "project": "/repo",
                    "sessionId": "claude-1",
                    "source": "agent",
                    "reason": "blocked",
                })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn overseer_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let start = run_core_cli_with(
        &args(&[
            "overseer",
            "start",
            "--tool",
            "claude",
            "--worktree",
            "feature",
            "--no-open",
            "--json",
        ]),
        &mut runtime,
    );
    let clear = run_core_cli_with(
        &args(&["overseer", "clear", "boss", "--project=/repo"]),
        &mut runtime,
    );

    assert_eq!(start.stdout, ["overseer ok"]);
    assert_eq!(clear.stdout, ["overseer ok"]);
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/overseer/start-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "tool": "claude",
                    "worktreePath": "feature",
                    "open": false,
                })),
            ),
            (
                "/core/overseer/clear-text".into(),
                Some(json!({ "project": "/repo", "sessionId": "boss" })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn team_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let show = run_core_cli_with(&args(&["team", "show", "--project=/repo"]), &mut runtime);
    let init = run_core_cli_with(&args(&["team", "init", "--json"]), &mut runtime);
    let add = run_core_cli_with(
        &args(&[
            "team",
            "add",
            "planner",
            "-d",
            "Plans work",
            "--reviewed-by",
            "reviewer",
            "--can-edit",
            "--json",
        ]),
        &mut runtime,
    );
    let default_role = run_core_cli_with(
        &args(&["team", "default", "--project=/repo", "planner"]),
        &mut runtime,
    );
    let remove = run_core_cli_with(
        &args(&["team", "remove", "--json", "--project=/repo", "planner"]),
        &mut runtime,
    );

    assert_eq!(show.stdout, ["team ok"]);
    assert_eq!(init.stdout, ["team ok"]);
    assert_eq!(add.stdout, ["team ok"]);
    assert_eq!(default_role.stdout, ["team ok"]);
    assert_eq!(remove.stdout, ["team ok"]);
    assert_eq!(
        runtime.text_routes,
        [
            ("/core/team/show-text?project=%2Frepo".into(), None),
            (
                "/core/team/init-text?json=1".into(),
                Some(json!({ "project": "/repo" })),
            ),
            (
                "/core/team/add-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "role": "planner",
                    "description": "Plans work",
                    "reviewedBy": "reviewer",
                    "canEdit": true,
                })),
            ),
            (
                "/core/team/default-text".into(),
                Some(json!({ "project": "/repo", "role": "planner" })),
            ),
            (
                "/core/team/remove-text?json=1".into(),
                Some(json!({ "project": "/repo", "role": "planner" })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn notification_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let notify = run_core_cli_with(
        &args(&[
            "notify",
            "--project=/repo",
            "--title",
            "Heads up",
            "--subtitle=Agent",
            "--body",
            "Ready",
            "--session=claude-1",
            "--kind=attention",
            "--json",
        ]),
        &mut runtime,
    );
    let list = run_core_cli_with(
        &args(&[
            "list-notifications",
            "--project=/repo",
            "--unread",
            "--session",
            "claude-1",
        ]),
        &mut runtime,
    );
    let read = run_core_cli_with(
        &args(&[
            "read-notifications",
            "--project",
            "/repo",
            "--id=note-1",
            "--ids",
            "note-2,note-3",
            "--session=claude-1",
            "--json",
        ]),
        &mut runtime,
    );
    let clear = run_core_cli_with(
        &args(&[
            "clear-notifications",
            "--project=/repo",
            "--ids=note-4,note-5",
        ]),
        &mut runtime,
    );

    assert_eq!(notify.stdout, ["notifications ok"]);
    assert_eq!(list.stdout, ["notifications ok"]);
    assert_eq!(read.stdout, ["notifications ok"]);
    assert_eq!(clear.stdout, ["notifications ok"]);
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/notifications/send-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "title": "Heads up",
                    "subtitle": "Agent",
                    "body": "Ready",
                    "sessionId": "claude-1",
                    "kind": "attention",
                })),
            ),
            (
                "/core/notifications/list-text?project=%2Frepo&unread=1&sessionId=claude-1".into(),
                None,
            ),
            (
                "/core/notifications/read-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "id": "note-1",
                    "ids": ["note-2", "note-3"],
                    "sessionId": "claude-1",
                })),
            ),
            (
                "/core/notifications/clear-text".into(),
                Some(json!({
                    "project": "/repo",
                    "id": null,
                    "ids": ["note-4", "note-5"],
                    "sessionId": null,
                })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn collaboration_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let message = run_core_cli_with(
        &args(&[
            "message",
            "send",
            "please",
            "--to",
            "claude-1,codex-1",
            "--assignee=coder",
            "--tool=claude",
            "--worktree=feature",
            "--project=/repo",
            "--from=user",
            "--title=Ask",
            "--kind=decision",
            "--thread=thread-1",
        ]),
        &mut runtime,
    );
    let handoff = run_core_cli_with(
        &args(&[
            "handoff",
            "send",
            "take over",
            "--to=claude-1",
            "--title=Takeover",
            "--json",
        ]),
        &mut runtime,
    );
    let accept = run_core_cli_with(
        &args(&[
            "handoff",
            "accept",
            "thread-1",
            "--from=claude-1",
            "--body=ok",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let complete = run_core_cli_with(
        &args(&[
            "handoff",
            "complete",
            "thread-1",
            "--from=claude-1",
            "--body=done",
            "--project=/repo",
        ]),
        &mut runtime,
    );

    assert_eq!(message.stdout, ["task task-1\nthread thread-1"]);
    assert_eq!(handoff.stdout, ["task task-1\nthread thread-1"]);
    assert_eq!(accept.stdout, ["task task-1\nthread thread-1"]);
    assert_eq!(complete.stdout, ["task task-1\nthread thread-1"]);
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/message/send-text".into(),
                Some(json!({
                    "project": "/repo",
                    "thread": "thread-1",
                    "from": "user",
                    "to": "claude-1,codex-1",
                    "assignee": "coder",
                    "tool": "claude",
                    "worktree": "feature",
                    "kind": "decision",
                    "body": "please",
                    "title": "Ask",
                })),
            ),
            (
                "/core/handoff/send-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "from": null,
                    "to": "claude-1",
                    "assignee": null,
                    "tool": null,
                    "body": "take over",
                    "title": "Takeover",
                    "worktree": null,
                })),
            ),
            (
                "/core/handoff/accept-text".into(),
                Some(json!({
                    "project": "/repo",
                    "threadId": "thread-1",
                    "from": "claude-1",
                    "body": "ok",
                })),
            ),
            (
                "/core/handoff/complete-text".into(),
                Some(json!({
                    "project": "/repo",
                    "threadId": "thread-1",
                    "from": "claude-1",
                    "body": "done",
                })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn task_and_review_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let list = run_core_cli_with(
        &args(&[
            "task",
            "list",
            "--session",
            "claude-1",
            "--status=todo",
            "--json",
        ]),
        &mut runtime,
    );
    let show = run_core_cli_with(
        &args(&["task", "show", "task-1", "--project", "/repo", "--json"]),
        &mut runtime,
    );
    let assign = run_core_cli_with(
        &args(&[
            "task",
            "assign",
            "Ship it",
            "--from=user",
            "--to=claude-1",
            "--assignee=coder",
            "--tool=claude",
            "--prompt=Implement",
            "--type=review",
            "--diff",
            "--- before\n+++ after",
            "--worktree=feature",
            "--project=/repo",
            "--json",
        ]),
        &mut runtime,
    );
    let accept = run_core_cli_with(
        &args(&[
            "task",
            "accept",
            "task-1",
            "--from=claude-1",
            "--body=ok",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let block = run_core_cli_with(
        &args(&[
            "task",
            "block",
            "task-1",
            "--from=claude-1",
            "--body",
            "blocked",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let complete = run_core_cli_with(
        &args(&[
            "task",
            "complete",
            "task-1",
            "--from=claude-1",
            "--result=shipped",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let reopen = run_core_cli_with(
        &args(&[
            "task",
            "reopen",
            "task-1",
            "--from=claude-1",
            "--body=again",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let approve = run_core_cli_with(
        &args(&[
            "review",
            "approve",
            "task-1",
            "--from=reviewer",
            "--body=ok",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let request_changes = run_core_cli_with(
        &args(&[
            "review",
            "request-changes",
            "task-1",
            "--from=reviewer",
            "--body=fix",
            "--project=/repo",
            "--json",
        ]),
        &mut runtime,
    );

    for execution in [
        list,
        show,
        assign,
        accept,
        block,
        complete,
        reopen,
        approve,
        request_changes,
    ] {
        assert_eq!(execution.stdout, ["task task-1\nthread thread-1"]);
    }
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/task/list-text?project=%2Frepo&session=claude-1&status=todo&json=1".into(),
                None,
            ),
            (
                "/core/task/show-text?project=%2Frepo&taskId=task-1&json=1".into(),
                None,
            ),
            (
                "/core/task/assign-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "from": "user",
                    "to": "claude-1",
                    "assignee": "coder",
                    "tool": "claude",
                    "description": "Ship it",
                    "prompt": "Implement",
                    "type": "review",
                    "diff": "--- before\n+++ after",
                    "worktree": "feature",
                })),
            ),
            (
                "/core/task/accept-text".into(),
                Some(json!({
                    "project": "/repo",
                    "taskId": "task-1",
                    "from": "claude-1",
                    "body": "ok",
                })),
            ),
            (
                "/core/task/block-text".into(),
                Some(json!({
                    "project": "/repo",
                    "taskId": "task-1",
                    "from": "claude-1",
                    "body": "blocked",
                })),
            ),
            (
                "/core/task/complete-text".into(),
                Some(json!({
                    "project": "/repo",
                    "taskId": "task-1",
                    "from": "claude-1",
                    "body": null,
                    "result": "shipped",
                })),
            ),
            (
                "/core/task/reopen-text".into(),
                Some(json!({
                    "project": "/repo",
                    "taskId": "task-1",
                    "from": "claude-1",
                    "body": "again",
                })),
            ),
            (
                "/core/review/approve-text".into(),
                Some(json!({
                    "project": "/repo",
                    "taskId": "task-1",
                    "from": "reviewer",
                    "body": "ok",
                })),
            ),
            (
                "/core/review/request-changes-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "taskId": "task-1",
                    "from": "reviewer",
                    "body": "fix",
                })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn thread_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let list = run_core_cli_with(
        &args(&[
            "thread",
            "list",
            "--session",
            "claude-1",
            "--project=/repo",
            "--json",
        ]),
        &mut runtime,
    );
    let show = run_core_cli_with(
        &args(&["thread", "show", "thread-1", "--project", "/repo"]),
        &mut runtime,
    );
    let open = run_core_cli_with(
        &args(&[
            "thread",
            "open",
            "--title=Plan",
            "--from=user",
            "--participants=claude-1,codex-1",
            "--kind=handoff",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let send = run_core_cli_with(
        &args(&[
            "thread",
            "send",
            "thread-1",
            "body",
            "--from=user",
            "--to=claude-1",
            "--kind=reply",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let mark_seen = run_core_cli_with(
        &args(&[
            "thread",
            "mark-seen",
            "thread-1",
            "--session=claude-1",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let status = run_core_cli_with(
        &args(&[
            "thread",
            "status",
            "thread-1",
            "--status=waiting",
            "--owner=user",
            "--waiting-on=claude-1,codex-1",
            "--project=/repo",
        ]),
        &mut runtime,
    );

    for execution in [list, show, open, send, mark_seen, status] {
        assert_eq!(execution.stdout, ["task task-1\nthread thread-1"]);
    }
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/thread/list-text?project=%2Frepo&session=claude-1&json=1".into(),
                None,
            ),
            (
                "/core/thread/show-text?project=%2Frepo&threadId=thread-1".into(),
                None,
            ),
            (
                "/core/thread/open-text".into(),
                Some(json!({
                    "project": "/repo",
                    "title": "Plan",
                    "from": "user",
                    "participants": "claude-1,codex-1",
                    "kind": "handoff",
                })),
            ),
            (
                "/core/thread/send-text".into(),
                Some(json!({
                    "project": "/repo",
                    "threadId": "thread-1",
                    "from": "user",
                    "to": "claude-1",
                    "kind": "reply",
                    "body": "body",
                })),
            ),
            (
                "/core/thread/mark-seen-text".into(),
                Some(json!({
                    "project": "/repo",
                    "threadId": "thread-1",
                    "session": "claude-1",
                })),
            ),
            (
                "/core/thread/status-text".into(),
                Some(json!({
                    "project": "/repo",
                    "threadId": "thread-1",
                    "status": "waiting",
                    "owner": "user",
                    "waitingOn": "claude-1,codex-1",
                })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn worktree_and_graveyard_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let list = run_core_cli_with(
        &args(&["worktree", "list", "--project=/repo", "--json"]),
        &mut runtime,
    );
    let create = run_core_cli_with(
        &args(&["worktree", "create", "feature", "--project=/repo"]),
        &mut runtime,
    );
    let cleanup = run_core_cli_with(
        &args(&[
            "worktree",
            "cleanup-caches",
            "--project=/repo",
            "--yes",
            "--include-active",
            "--json",
        ]),
        &mut runtime,
    );
    let remove = run_core_cli_with(
        &args(&["worktree", "remove", "../feature", "--project=/repo"]),
        &mut runtime,
    );
    let graveyard_worktree = run_core_cli_with(
        &args(&["worktree", "graveyard", "../feature", "--project=/repo"]),
        &mut runtime,
    );
    let resurrect_worktree = run_core_cli_with(
        &args(&["worktree", "resurrect", "../feature", "--project=/repo"]),
        &mut runtime,
    );
    let delete_worktree = run_core_cli_with(
        &args(&[
            "worktree",
            "delete-graveyard",
            "../feature",
            "--project=/repo",
        ]),
        &mut runtime,
    );
    let graveyard_list = run_core_cli_with(
        &args(&["graveyard", "list", "--project=/repo"]),
        &mut runtime,
    );
    let graveyard_send = run_core_cli_with(
        &args(&["graveyard", "send", "claude-1", "--project=/repo", "--json"]),
        &mut runtime,
    );
    let graveyard_resurrect = run_core_cli_with(
        &args(&["graveyard", "resurrect", "claude-1", "--project=/repo"]),
        &mut runtime,
    );
    let graveyard_cleanup = run_core_cli_with(
        &args(&["graveyard", "cleanup", "--project=/repo", "--dry-run"]),
        &mut runtime,
    );

    for execution in [
        list,
        create,
        cleanup,
        remove,
        graveyard_worktree,
        resurrect_worktree,
        delete_worktree,
        graveyard_list,
        graveyard_send,
        graveyard_resurrect,
        graveyard_cleanup,
    ] {
        assert_eq!(execution.stdout, ["worktree ok"]);
    }
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/worktree/list-text?project=%2Frepo&json=1".into(),
                None,
            ),
            (
                "/core/worktree/create-text".into(),
                Some(json!({ "project": "/repo", "name": "feature" })),
            ),
            (
                "/core/worktree/cache-cleanup-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "dryRun": false,
                    "includeActive": true,
                })),
            ),
            (
                "/core/worktree/remove-text".into(),
                Some(json!({ "project": "/repo", "path": "../feature" })),
            ),
            (
                "/core/worktree/graveyard-text".into(),
                Some(json!({ "project": "/repo", "path": "../feature" })),
            ),
            (
                "/core/worktree/resurrect-text".into(),
                Some(json!({ "project": "/repo", "path": "../feature" })),
            ),
            (
                "/core/worktree/delete-graveyard-text".into(),
                Some(json!({ "project": "/repo", "path": "../feature" })),
            ),
            ("/core/graveyard/list-text?project=%2Frepo".into(), None,),
            (
                "/core/graveyard/send-text?json=1".into(),
                Some(json!({ "project": "/repo", "sessionId": "claude-1" })),
            ),
            (
                "/core/graveyard/resurrect-text".into(),
                Some(json!({ "project": "/repo", "sessionId": "claude-1" })),
            ),
            (
                "/core/graveyard/cleanup-text".into(),
                Some(json!({ "project": "/repo", "dryRun": true })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn metadata_and_repair_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let metadata = run_core_cli_with(
        &args(&["metadata", "set-status", "claude-1", "--", "-waiting"]),
        &mut runtime,
    );
    let repair = run_core_cli_with(
        &args(&["repair", "--project-root=.", "--open", "--json"]),
        &mut runtime,
    );
    let exchange = run_core_cli_with(
        &args(&["repair", "exchange", "--project=/repo"]),
        &mut runtime,
    );

    assert_eq!(metadata.stdout, ["metadata ok"]);
    assert_eq!(repair.stdout, ["repair ok"]);
    assert_eq!(exchange.stdout, ["repair ok"]);
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/metadata-text?project=%2Frepo&arg=metadata&arg=set-status&arg=claude-1&arg=--&arg=-waiting".into(),
                None,
            ),
            (
                "/core/repair-text?json=1".into(),
                Some(json!({ "projectRoot": "/repo", "open": true })),
            ),
            (
                "/core/repair-exchange-text".into(),
                Some(json!({ "projectRoot": "/repo" })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn invalid_dashboard_and_runtime_restart_args_fail_before_io() {
    let mut runtime = FakeRuntime::default();

    let reload = run_core_cli_with(&args(&["dashboard-reload", "--json"]), &mut runtime);
    assert_eq!(reload.code, 1);
    assert_eq!(reload.stderr, ["error: invalid dashboard-reload arguments"]);

    let restart = run_core_cli_with(
        &args(&["restart-runtime", "--open", "--json"]),
        &mut runtime,
    );
    assert_eq!(restart.code, 1);
    assert_eq!(
        restart.stderr,
        ["Error: restart-runtime --open cannot be combined with --json"]
    );
    assert!(runtime.commands.is_empty());
    assert!(runtime.text_routes.is_empty());
}

#[test]
fn unsupported_runtime_features_fail_before_side_effects() {
    let mut runtime = FakeRuntime::default();

    let enable = run_core_cli_with(&args(&["remote", "enable"]), &mut runtime);
    assert_eq!(enable.code, 1);
    assert_eq!(enable.stderr, ["Not logged in. Run `aimux login` first."]);
    assert!(runtime.commands.is_empty());
}

#[test]
fn remote_status_and_whoami_use_native_credentials_without_leaking_token() {
    let mut runtime = FakeRuntime {
        credentials: Some(json!({
            "userId": "user-1",
            "relayUrl": "wss://relay.example",
            "remoteEnabled": true,
            "token": "secret-token"
        })),
        ..FakeRuntime::default()
    };

    let status = run_core_cli_with(&args(&["remote", "status", "--json"]), &mut runtime);
    assert_eq!(status.code, 0);
    assert_eq!(runtime.commands[0].command, CORE_COMMAND_NAMES.relay_status);
    let status_json: Value = serde_json::from_str(&status.stdout[0]).expect("status json");
    assert_eq!(status_json["loggedIn"], true);
    assert_eq!(status_json["relay"]["status"], "connected");
    assert!(!status.stdout[0].contains("secret-token"));

    let whoami = run_core_cli_with(&args(&["whoami", "--json"]), &mut runtime);
    assert_eq!(whoami.code, 0);
    let whoami_json: Value = serde_json::from_str(&whoami.stdout[0]).expect("whoami json");
    assert_eq!(
        whoami_json,
        json!({
            "loggedIn": true,
            "userId": "user-1",
            "relayUrl": "wss://relay.example",
            "remoteEnabled": true
        })
    );
}

#[test]
fn remote_disable_without_daemon_updates_native_credentials_locally() {
    let mut runtime = FakeRuntime {
        daemon_info: None,
        credentials: Some(json!({
            "userId": "user-1",
            "relayUrl": "wss://relay.example",
            "remoteEnabled": true
        })),
        ..FakeRuntime::default()
    };

    let execution = run_core_cli_with(&args(&["remote", "disable"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert_eq!(execution.stdout, ["✓ Remote access disabled."]);
    assert!(runtime.commands.is_empty());
    assert_eq!(runtime.remote_enabled.get(), Some(false));
}

#[test]
fn logout_clears_native_credentials_after_best_effort_relay_disable() {
    let mut runtime = FakeRuntime {
        credentials: Some(json!({
            "userId": "user-1",
            "relayUrl": "wss://relay.example",
            "remoteEnabled": true
        })),
        ..FakeRuntime::default()
    };

    let execution = run_core_cli_with(&args(&["logout"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert_eq!(execution.stdout, ["✓ Logged out. Remote access disabled."]);
    assert_eq!(
        runtime.commands[0].command,
        CORE_COMMAND_NAMES.relay_disable
    );
    assert_eq!(runtime.cleared_credentials.get(), 1);
}

#[test]
fn login_runs_native_browser_flow_and_best_effort_relay_enable() {
    let mut runtime = FakeRuntime::default();

    let execution = run_core_cli_with(&args(&["login"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert_eq!(runtime.login_calls.get(), 1);
    assert_eq!(runtime.commands[0].command, CORE_COMMAND_NAMES.relay_enable);
    assert_eq!(
        execution.stdout,
        [
            "Opening your browser to sign in...",
            "If it doesn't open, visit:\n  https://aimux.app/cli-auth?callback=local\n",
            "",
            "✓ Logged in as user-1",
            "Remote access is enabled (connection: connected)."
        ]
    );
}

#[test]
fn security_unlock_uses_native_login_flow_without_daemon_relay_request_when_offline() {
    let mut runtime = FakeRuntime {
        daemon_info: None,
        ..FakeRuntime::default()
    };

    let execution = run_core_cli_with(&args(&["security", "unlock"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert_eq!(runtime.security_unlock_calls.get(), 1);
    assert!(runtime.commands.is_empty());
    assert!(
        execution
            .stdout
            .contains(&"✓ Security unlocked for user-1".into())
    );
    assert!(
        execution
            .stdout
            .contains(&"Remote access is enabled. The daemon will connect on next start.".into())
    );
}

#[test]
fn restart_control_plane_runs_native_restart_and_preserves_project_scope() {
    let mut runtime = FakeRuntime::default();

    let execution = run_core_cli_with(&args(&["restart", "--project", "child"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert_eq!(execution.stdout, ["Aimux Restart\n  failures: 0"]);
    assert!(execution.stderr.is_empty());
    assert_eq!(runtime.restart_calls, [Some("/resolved/child".into())]);
    assert!(runtime.commands.is_empty());
}

#[test]
fn restart_control_plane_json_outputs_restart_report_and_fails_on_failures() {
    let mut runtime = FakeRuntime {
        restart_failures: 2,
        ..FakeRuntime::default()
    };

    let execution = run_core_cli_with(&args(&["daemon", "restart", "--json"]), &mut runtime);

    assert_eq!(execution.code, 1);
    assert!(execution.stderr.is_empty());
    assert_eq!(runtime.restart_calls, [None]);
    let report: Value = serde_json::from_str(&execution.stdout[0]).expect("restart json");
    assert_eq!(report["summary"]["failures"], json!(2));
}

#[test]
fn host_restart_open_restarts_project_then_opens_dashboard_target() {
    let mut runtime = FakeRuntime::default();

    let execution = run_core_cli_with(&args(&["host", "restart", "--open"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert_eq!(
        execution.stdout,
        ["Restarted project service for aimux-repo"]
    );
    assert!(execution.stderr.is_empty());
    assert_eq!(runtime.commands.len(), 1);
    assert_eq!(
        runtime.commands[0].command,
        CORE_COMMAND_NAMES.project_restart
    );
    assert_eq!(
        runtime.open_targets,
        [json!({ "sessionName": "aimux-repo", "windowIndex": 1 })]
    );
}
