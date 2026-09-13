use aimux::core_cli::{CoreCommandCall, CoreCommandOk, CoreLoopActorContext};
use aimux::core_cli_executor::{CoreCliRuntime, run_core_cli_with};
use aimux::core_command_contract::CORE_COMMAND_NAMES;
use aimux::daemon::text::auth::AuthFlowResult;
use aimux::daemon::text::operations::{
    RestartControlPlaneTextResult, render_runtime_restart_result,
};
use aimux::daemon_state::{AimuxDaemonInfo, DaemonState, StoppedDaemonInfo};
use aimux::native_cli_dispatch::CORE_SERVICE_CREATE_TEXT_ROUTE;
use aimux::native_cli_dispatch::{
    CORE_LOOP_LIST_TEXT_ROUTE, CORE_OVERSEER_STATUS_TEXT_ROUTE, CORE_REVIEW_LIST_TEXT_ROUTE,
    CORE_SCRIBE_STATUS_TEXT_ROUTE,
};
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug)]
struct FakeRuntime {
    cwd: String,
    daemon_info: Option<AimuxDaemonInfo>,
    daemon_state: DaemonState,
    commands: Vec<CoreCommandCall>,
    text_routes: Vec<(String, Option<Value>)>,
    open_targets: Vec<Value>,
    restart_calls: Vec<(Option<String>, bool)>,
    restart_progress: Vec<String>,
    stop_daemon_calls: Vec<String>,
    stopped_daemon: Option<StoppedDaemonInfo>,
    login_calls: Cell<usize>,
    security_unlock_calls: Cell<usize>,
    credentials: Option<Value>,
    cleared_credentials: Cell<usize>,
    remote_enabled: Cell<Option<bool>>,
    security_devices: Vec<Value>,
    pending_security_devices: Vec<Value>,
    security_updates: RefCell<Vec<(String, String, Option<String>)>>,
    fail_commands: bool,
    git_project_root: bool,
    real_git_paths: bool,
    restart_failures: i64,
    log_path: PathBuf,
    log_output: String,
    clear_count: Cell<usize>,
    topology_path: PathBuf,
    topology_raw: String,
    topology_json: Value,
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
            restart_progress: Vec::new(),
            stop_daemon_calls: Vec::new(),
            stopped_daemon: Some(StoppedDaemonInfo {
                daemon: daemon_info(),
                stopped_project_services: Vec::new(),
            }),
            login_calls: Cell::new(0),
            security_unlock_calls: Cell::new(0),
            credentials: None,
            cleared_credentials: Cell::new(0),
            remote_enabled: Cell::new(None),
            security_devices: Vec::new(),
            pending_security_devices: Vec::new(),
            security_updates: RefCell::new(Vec::new()),
            fail_commands: false,
            git_project_root: true,
            real_git_paths: false,
            restart_failures: 0,
            log_path: PathBuf::from("/tmp/aimux.log"),
            log_output: String::new(),
            clear_count: Cell::new(0),
            topology_path: PathBuf::from("/repo/.aimux/runtime-topology.yaml"),
            topology_raw: "version: 1\ngeneratedAt: now\n".into(),
            topology_json: json!({ "version": 1, "generatedAt": "now", "rigs": [] }),
        }
    }
}

impl CoreCliRuntime for FakeRuntime {
    fn cwd(&self) -> String {
        self.cwd.clone()
    }

    fn resolve_project_root(&self, path: &str) -> String {
        if self.real_git_paths {
            let home_dir = PathBuf::from("/tmp/aimux-test-home");
            let mut resolver = aimux::paths::PathResolver::new(&self.cwd, home_dir, None);
            return resolver
                .resolve_repo_root(path)
                .to_string_lossy()
                .into_owned();
        }
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

    fn list_remote_security_devices(&self, pending: bool) -> Result<Vec<Value>, String> {
        Ok(if pending {
            self.pending_security_devices.clone()
        } else {
            self.security_devices.clone()
        })
    }

    fn update_remote_security_device(
        &self,
        device_id: &str,
        action: &str,
        approval_code: Option<&str>,
    ) -> Result<Value, String> {
        self.security_updates.borrow_mut().push((
            device_id.to_owned(),
            action.to_owned(),
            approval_code.map(str::to_owned),
        ));
        let device = self
            .security_devices
            .iter()
            .find(|device| device.get("id").and_then(Value::as_str) == Some(device_id))
            .cloned()
            .unwrap_or_else(|| {
                json!({
                    "id": device_id,
                    "kind": "web",
                    "name": "Browser",
                    "platform": "macOS",
                    "lastSeenAt": "2026-09-09T00:00:00.000Z",
                    "approved": action == "approve",
                    "blocked": action == "block"
                })
            });
        Ok(device)
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
        } else if path.starts_with("/core/agents/list-text?") {
            "Main Checkout  /repo\n  ready  canonical=claude  aimux=claude-1\n".into()
        } else if path == "/core/agents/input-text" {
            "delivered to claude-1\n".into()
        } else if path.starts_with("/core/agents/rename-text") {
            "renamed claude-1 -> reviewer\n".into()
        } else if path.starts_with("/core/agents/migrate-text") {
            "migrated claude-1 -> feature\n".into()
        } else if path.starts_with("/core/lifecycle/spawn-text") {
            "spawned claude-1\n".into()
        } else if path.starts_with(CORE_SERVICE_CREATE_TEXT_ROUTE) {
            "service service-1 running\n".into()
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
        } else if path.starts_with("/core/scribe/") {
            "scribe ok\n".into()
        } else if path.starts_with("/core/team/") {
            "team ok\n".into()
        } else if path.starts_with("/core/notifications/") {
            "notifications ok\n".into()
        } else if path.starts_with("/core/outline/") {
            "outline ok\n".into()
        } else if path.starts_with("/core/attachment/") {
            "Attached files:\n- notes.txt (text/plain, 5 bytes): /tmp/notes.txt\n".into()
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
        } else if path.starts_with("/core/doctor/versions-text?json=1") {
            "{\n  \"cliVersion\": \"test-cli\",\n  \"summary\": { \"projects\": 0 },\n  \"expected\": { \"runtimeContract\": \"2\" }\n}\n".into()
        } else if path.starts_with("/core/doctor/versions-text") {
            concat!(
                "Aimux Versions\n",
                "  cli version: test-cli\n",
                "  build profile: test\n",
                "  cli launcher: /tmp/aimux\n",
                "  cli current entry: /tmp/aimux\n",
                "  cli stable shim: /tmp/stable/aimux\n",
                "  expected project service: api=5 build=test-build capabilities=parsedAgentOutput, attachmentRead, chatEventStream, agentTranscriptMessages, agentActivityState\n",
                "  expected runtime owner: test-owner\n",
                "  expected tmux runtime contract: 2\n",
                "  daemon: running pid=123 endpoint=http://127.0.0.1:46290\n",
                "  daemon projects: 0\n",
                "  tmux: unavailable\n",
                "  tmux sessions: 0\n",
                "  projects: 0 (0 ok, 0 stopped, 0 inactive, 0 need attention, 0 need runtime rebuild)\n"
            )
            .into()
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

    fn init_project(&self, _project_root: &str) -> Result<(), String> {
        Ok(())
    }

    fn is_git_project_root(&self, _project_root: &str) -> bool {
        if self.real_git_paths {
            return aimux::paths::is_git_project_root(_project_root);
        }
        self.git_project_root
    }

    fn runtime_topology_path(&self, _project_root: &str) -> PathBuf {
        self.topology_path.clone()
    }

    fn read_text_file(&self, _path: &Path) -> Result<String, String> {
        Ok(self.topology_raw.clone())
    }

    fn read_runtime_topology(&self, _path: &Path) -> Result<Value, String> {
        Ok(self.topology_json.clone())
    }

    fn open_dashboard_target(&mut self, target: &Value) -> Result<(), String> {
        self.open_targets.push(target.clone());
        Ok(())
    }

    fn restart_control_plane(
        &mut self,
        project_root: Option<&str>,
        force: bool,
    ) -> Result<RestartControlPlaneTextResult, String> {
        self.restart_calls
            .push((project_root.map(str::to_owned), force));
        let mut restart = json!({
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
        });
        if force {
            restart["restartGuard"] = json!({
                "force": {
                    "status": "bypassed",
                    "atRiskSessions": [{
                        "projectRoot": project_root.unwrap_or("/repo"),
                        "sessionId": "codex-pending",
                        "tool": "codex",
                        "status": "running"
                    }],
                    "tmuxErrors": []
                }
            });
        }
        let text = render_runtime_restart_result(&restart);
        Ok(RestartControlPlaneTextResult { restart, text })
    }

    fn emit_restart_progress(&mut self, message: &str) {
        self.restart_progress.push(message.to_owned());
    }

    fn stop_daemon(&mut self, signal: &str) -> Result<Option<StoppedDaemonInfo>, String> {
        self.stop_daemon_calls.push(signal.to_owned());
        Ok(self.stopped_daemon.clone())
    }

    fn debug_state_report(&self, target: &str) -> Result<String, String> {
        Ok(format!(
            "{{\n  \"version\": 1,\n  \"target\": \"{target}\"\n}}"
        ))
    }

    fn runtime_migration_audit(&self, project_root: &str) -> Result<String, String> {
        Ok(format!("migration audit {project_root}"))
    }

    fn runtime_migration_import(&self, project_root: &str) -> Result<String, String> {
        Ok(format!("migration import {project_root}"))
    }

    fn runtime_migration_rollback(&self, manifest: &str) -> Result<String, String> {
        Ok(format!("migration rollback {manifest}"))
    }

    fn desktop_notifier_doctor_report(&self) -> Result<Value, String> {
        Ok(json!({
            "platform": "macos",
            "transport": "mac-helper",
            "helperPath": "/tmp/aimux-notifier.app/Contents/MacOS/aimux-notifier",
            "helperCandidates": ["/tmp/aimux-notifier.app/Contents/MacOS/aimux-notifier"],
        }))
    }

    fn desktop_notifier_doctor_text(&self) -> Result<String, String> {
        Ok("Desktop notifications\nPlatform: macos\nTransport: mac-helper".into())
    }

    fn send_desktop_notification_test(
        &self,
        title: &str,
        body: &str,
        open_url: Option<&str>,
    ) -> Result<Value, String> {
        Ok(json!({
            "ok": true,
            "attempt": {
                "transport": "mac-helper",
                "helperPath": format!("/tmp/{title}-{body}-{}/aimux-notifier.app/Contents/MacOS/aimux-notifier", open_url.unwrap_or("none")),
                "ok": true,
                "exitCode": 0,
                "stdout": "",
                "stderr": "",
            }
        }))
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

fn run_git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("run git command");
    assert!(
        output.status.success(),
        "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
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
        "projectServiceFleet": {
            "catalogProjectCount": 1,
            "liveProjectServiceCount": 1,
            "coldCatalogProjectCount": 0,
            "daemonStateProjectCount": 1,
            "staleDaemonStateProjectCount": 0
        },
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
fn init_executes_locally_without_daemon_fallback() {
    let mut runtime = FakeRuntime::default();

    let execution = run_core_cli_with(&args(&["init"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert_eq!(
        execution.stdout,
        ["Initialized .aimux/ with config.json and .gitignore"]
    );
    assert!(runtime.commands.is_empty());
    assert!(runtime.text_routes.is_empty());
}

#[test]
fn non_git_projects_gate_materializing_project_commands_before_daemon_requests() {
    let mut runtime = FakeRuntime {
        git_project_root: false,
        ..FakeRuntime::default()
    };
    let expected =
        "/repo is not a git repository. Run `git init` first, or cd into a repo.".to_owned();

    for command in [
        ["worktree", "list"].as_slice(),
        ["migrate", "agent-1", "--worktree", "feature"].as_slice(),
    ] {
        let execution = run_core_cli_with(&args(command), &mut runtime);
        assert_eq!(execution.code, 1, "{command:?}");
        assert_eq!(
            execution.stderr,
            std::slice::from_ref(&expected),
            "{command:?}"
        );
    }

    for command in [["init"].as_slice(), ["projects"].as_slice()] {
        let execution = run_core_cli_with(&args(command), &mut runtime);
        assert_ne!(execution.code, 1, "{command:?}");
    }

    let before_commands = runtime.commands.len();
    let before_text_routes = runtime.text_routes.len();
    for command in [
        ["ps"].as_slice(),
        ["list"].as_slice(),
        ["serve"].as_slice(),
        ["host", "restart"].as_slice(),
        ["dashboard-reload"].as_slice(),
        ["restart-runtime"].as_slice(),
    ] {
        let execution = run_core_cli_with(&args(command), &mut runtime);
        assert_eq!(execution.code, 1, "{command:?}");
        assert_eq!(
            execution.stderr,
            std::slice::from_ref(&expected),
            "{command:?}"
        );
    }
    assert_eq!(runtime.commands.len(), before_commands);
    assert_eq!(runtime.text_routes.len(), before_text_routes);
}

#[test]
fn materializing_cli_commands_succeed_from_real_git_worktree() {
    let fixture_root = std::env::temp_dir().join(format!(
        "aimux-rust-core-cli-worktree-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    let main_repo = fixture_root.join("main");
    let worktree = fixture_root.join("feature");
    let _ = fs::remove_dir_all(&fixture_root);
    fs::create_dir_all(&fixture_root).expect("create fixture root");

    run_git(&fixture_root, &["init", "-q", "main"]);
    run_git(&main_repo, &["config", "user.email", "test@example.com"]);
    run_git(&main_repo, &["config", "user.name", "Aimux Test"]);
    fs::write(main_repo.join("README.md"), "initial\n").expect("write README");
    run_git(&main_repo, &["add", "README.md"]);
    run_git(&main_repo, &["commit", "-q", "-m", "initial"]);
    run_git(
        &main_repo,
        &[
            "worktree",
            "add",
            "-q",
            worktree.to_str().expect("utf8 worktree path"),
            "-b",
            "feature",
        ],
    );
    assert!(worktree.join(".git").is_file());

    let cwd = worktree.to_string_lossy().into_owned();
    let mut expected_resolver =
        aimux::paths::PathResolver::new(&cwd, PathBuf::from("/tmp/aimux-test-home"), None);
    let expected_root = expected_resolver.resolve_repo_root(&cwd);
    let mut runtime = FakeRuntime {
        cwd,
        real_git_paths: true,
        ..FakeRuntime::default()
    };

    let execution = run_core_cli_with(&args(&["ps", "--json"]), &mut runtime);

    assert_eq!(execution.code, 0, "{:?}", execution.stderr);
    assert_eq!(execution.stdout, ["claude-1  [claude]  ready"]);
    assert_eq!(
        runtime.text_routes,
        [(
            format!(
                "/core/agents/ps-text?project={}&json=1",
                encode_query_component(&expected_root.to_string_lossy())
            ),
            None,
        )]
    );
    assert!(runtime.commands.is_empty());

    fs::remove_dir_all(&fixture_root).expect("remove fixture root");
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

    let bare_projects = run_core_cli_with(&args(&["projects"]), &mut runtime);
    assert_eq!(bare_projects.code, 0);
    assert_eq!(bare_projects.stdout, ["repo  live  /repo"]);

    let projects = run_core_cli_with(&args(&["projects", "list", "--json"]), &mut runtime);
    assert_eq!(projects.code, 0);
    let parsed: Value = serde_json::from_str(&projects.stdout[0]).expect("projects JSON");
    assert_eq!(parsed["projects"][0]["path"], "/repo");
}

#[test]
fn host_topology_executes_locally_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let path = run_core_cli_with(&args(&["host", "topology"]), &mut runtime);
    let raw = run_core_cli_with(&args(&["host", "topology", "--raw"]), &mut runtime);
    let parsed = run_core_cli_with(&args(&["host", "topology", "--json"]), &mut runtime);

    assert_eq!(path.stdout, ["/repo/.aimux/runtime-topology.yaml"]);
    assert_eq!(raw.stdout, ["version: 1\ngeneratedAt: now"]);
    assert_eq!(
        serde_json::from_str::<Value>(&parsed.stdout[0]).unwrap(),
        json!({ "version": 1, "generatedAt": "now", "rigs": [] })
    );
    assert!(runtime.commands.is_empty());
    assert!(runtime.text_routes.is_empty());
}

#[test]
fn agent_identity_executes_locally_without_core_command_fallback() {
    let mut runtime = FakeRuntime {
        topology_json: json!({
            "sessions": [{
                "id": "codex-1",
                "tool": "codex",
                "toolConfigKey": "codex",
                "command": "codex",
                "status": "running",
                "backendSessionId": "0710a963-a473-430f-9f9a-e27dd4546328",
                "worktreePath": "/repo",
            }],
            "nodes": [],
            "bindings": [],
        }),
        ..FakeRuntime::default()
    };

    let text = run_core_cli_with(&args(&["id", "codex-1", "--project=/repo"]), &mut runtime);
    let json = run_core_cli_with(
        &args(&["id", "codex-1", "--project=/repo", "--json"]),
        &mut runtime,
    );
    let missing = run_core_cli_with(&args(&["id", "ghost-1", "--project=/repo"]), &mut runtime);

    assert_eq!(text.code, 0);
    assert_eq!(
        text.stdout,
        [
            "codex-1  canonical=codex  backend=0710a963-a473-430f-9f9a-e27dd4546328  status=running  source=topology",
            "worktree: /repo",
        ]
    );
    assert_eq!(json.code, 0);
    assert!(json.stdout[0].contains("\"aimuxId\": \"codex-1\""));
    assert_eq!(missing.code, 1);
    assert_eq!(
        missing.stderr,
        ["Error: Agent \"ghost-1\" is not managed in runtime topology"]
    );
    assert!(runtime.commands.is_empty());
    assert!(runtime.text_routes.is_empty());
}

#[test]
fn compact_claims_cli_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let compact = run_core_cli_with(&args(&["compact"]), &mut runtime);

    assert_eq!(compact.code, 1);
    assert_eq!(compact.stderr, ["No history found at /repo/.aimux/history"]);
    assert!(runtime.commands.is_empty());
    assert!(runtime.text_routes.is_empty());
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

    let json_execution = run_core_cli_with(&args(&["daemon", "status", "--json"]), &mut runtime);
    assert_eq!(json_execution.code, 0);
    let parsed: Value = serde_json::from_str(&json_execution.stdout[0]).expect("status JSON");
    assert_eq!(
        parsed["projectServiceFleet"],
        json!({
            "catalogProjectCount": 0,
            "liveProjectServiceCount": 0,
            "coldCatalogProjectCount": 0,
            "daemonStateProjectCount": 1,
            "staleDaemonStateProjectCount": 1
        })
    );
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
    assert_eq!(text.stdout.len(), 1);
    assert!(text.stdout[0].starts_with("Aimux Versions\n"));
    assert!(text.stdout[0].contains("  cli version: test-cli\n"));
    assert!(text.stdout[0].contains("  daemon projects: 0\n"));
    assert!(!text.stdout[0].contains("Runtime Coherence"));

    let json = run_core_cli_with(&args(&["doctor", "versions", "--json"]), &mut runtime);
    assert_eq!(json.code, 0);
    let report = serde_json::from_str::<Value>(&json.stdout[0]).expect("doctor json");
    assert_eq!(report["cliVersion"], json!("test-cli"));
    assert_eq!(report["summary"]["projects"], json!(0));
    assert_eq!(report["expected"]["runtimeContract"], json!("2"));
    let disk = run_core_cli_with(
        &args(&["doctor", "disk", "--project=/repo", "--include-active"]),
        &mut runtime,
    );
    assert_eq!(disk.code, 0);
    assert_eq!(disk.stdout, ["Runtime Coherence\n  ok"]);

    let exchange = run_core_cli_with(
        &args(&["doctor", "exchange", "--project=/repo", "--json"]),
        &mut runtime,
    );
    assert_eq!(exchange.code, 0);
    assert_eq!(exchange.stdout, ["Runtime Coherence\n  ok"]);

    let lifecycle = run_core_cli_with(&args(&["doctor", "lifecycle"]), &mut runtime);
    assert_eq!(lifecycle.code, 0);
    assert_eq!(lifecycle.stdout, ["Runtime Coherence\n  ok"]);

    let stability = run_core_cli_with(
        &args(&["doctor", "stability", "--project=/repo", "--json"]),
        &mut runtime,
    );
    assert_eq!(stability.code, 0);
    assert_eq!(stability.stdout, ["Runtime Coherence\n  ok"]);

    let tmux = run_core_cli_with(
        &args(&[
            "doctor",
            "tmux",
            "--project-root=/repo",
            "--session=aimux-repo",
            "--window-id=@1",
        ]),
        &mut runtime,
    );
    assert_eq!(tmux.code, 0);
    assert_eq!(tmux.stdout, ["Runtime Coherence\n  ok"]);
    assert_eq!(
        runtime.text_routes,
        [
            ("/core/doctor/versions-text".into(), None),
            ("/core/doctor/versions-text?json=1".into(), None),
            (
                "/core/doctor/disk-text?project=%2Frepo&includeActive=1".into(),
                None,
            ),
            (
                "/core/doctor/exchange-text?projectRoot=%2Frepo&json=1".into(),
                None,
            ),
            (
                "/core/doctor/lifecycle-text?projectRoot=%2Frepo".into(),
                None,
            ),
            (
                "/core/doctor/stability-text?projectRoot=%2Frepo&json=1".into(),
                None,
            ),
            (
                "/core/doctor/tmux-text?projectRoot=%2Frepo&session=aimux-repo&windowId=%401"
                    .into(),
                None,
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn debug_state_executes_native_local_report_without_daemon() {
    let mut runtime = FakeRuntime::default();
    let execution = run_core_cli_with(&args(&["debug-state", "codex-a1"]), &mut runtime);
    assert_eq!(execution.code, 0);
    assert_eq!(
        execution.stdout,
        ["{\n  \"version\": 1,\n  \"target\": \"codex-a1\"\n}"]
    );
    assert!(runtime.text_routes.is_empty());
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

    let json = run_core_cli_with(
        &args(&[
            "host",
            "agent-read",
            "claude-1",
            "--project=/repo",
            "--json",
        ]),
        &mut runtime,
    );
    assert_eq!(json.code, 0);
    assert_eq!(json.stdout, ["pane output"]);
    assert_eq!(
        runtime.text_routes.last(),
        Some(&(
            "/core/host-agent-read-text?project=%2Frepo&sessionId=claude-1&startLine=-120&json=1"
                .into(),
            None,
        ))
    );
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
    let list = run_core_cli_with(
        &args(&["list", "--project", "/repo", "--json"]),
        &mut runtime,
    );

    assert_eq!(ps.code, 0);
    assert_eq!(ps.stdout, ["claude-1  [claude]  ready"]);
    assert_eq!(list.code, 0);
    assert_eq!(
        list.stdout,
        ["Main Checkout  /repo\n  ready  canonical=claude  aimux=claude-1"]
    );
    assert_eq!(
        runtime.text_routes,
        [
            ("/core/agents/ps-text?project=%2Frepo&json=1".into(), None,),
            ("/core/agents/list-text?project=%2Frepo&json=1".into(), None,),
        ]
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
                "force": false,
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
fn migration_commands_execute_native_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let audit = run_core_cli_with(
        &args(&["migration", "audit", "--project", "./child"]),
        &mut runtime,
    );
    let import = run_core_cli_with(
        &args(&["migration", "import", "--project=./child"]),
        &mut runtime,
    );
    let rollback = run_core_cli_with(
        &args(&["migration", "rollback", "backups/manifest.json"]),
        &mut runtime,
    );

    assert_eq!(audit.stdout, ["migration audit /resolved/./child"]);
    assert_eq!(import.stdout, ["migration import /resolved/./child"]);
    assert_eq!(
        rollback.stdout,
        ["migration rollback backups/manifest.json"]
    );
    assert!(runtime.commands.is_empty());
    assert!(runtime.text_routes.is_empty());
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
    let service = run_core_cli_with(
        &args(&["service", "create", "--", "yarn", "dev"]),
        &mut runtime,
    );
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
    let default_tool_fork = run_core_cli_with(&args(&["fork", "claude-1"]), &mut runtime);

    assert_eq!(spawn.stdout, ["spawned claude-1"]);
    assert_eq!(stop.stdout, ["stopped claude-1"]);
    assert_eq!(service.stdout, ["service service-1 running"]);
    assert_eq!(kill.stdout, ["graveyarded claude-1"]);
    assert_eq!(fork.stdout, ["forked codex-2\nthread thread-1"]);
    assert_eq!(default_tool_fork.code, 1);
    assert!(default_tool_fork.stdout.is_empty());
    assert_eq!(default_tool_fork.stderr, ["error: invalid fork arguments"]);
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/lifecycle/spawn-text?project=%2Frepo&tool=claude&open=0&worktreePath=feature"
                    .into(),
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
                CORE_SERVICE_CREATE_TEXT_ROUTE.into(),
                Some(json!({
                    "project": "/repo",
                    "command": "yarn dev",
                    "worktreePath": null,
                })),
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
    let list = run_core_cli_with(&args(&["loop", "list"]), &mut runtime);

    assert_eq!(add.stdout, ["loop ok"]);
    assert_eq!(remove.stdout, ["loop ok"]);
    assert_eq!(done.stdout, ["loop ok"]);
    assert_eq!(block.stdout, ["loop ok"]);
    assert_eq!(list.stdout, ["loop ok"]);
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
            (format!("{CORE_LOOP_LIST_TEXT_ROUTE}?project=%2Frepo"), None,),
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
    let status = run_core_cli_with(&args(&["overseer", "status"]), &mut runtime);

    assert_eq!(start.stdout, ["overseer ok"]);
    assert_eq!(clear.stdout, ["overseer ok"]);
    assert_eq!(status.stdout, ["overseer ok"]);
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
            (
                format!("{CORE_OVERSEER_STATUS_TEXT_ROUTE}?project=%2Frepo"),
                None,
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn scribe_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let start = run_core_cli_with(
        &args(&[
            "scribe",
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
        &args(&["scribe", "clear", "scribe-1", "--project=/repo"]),
        &mut runtime,
    );
    let status = run_core_cli_with(&args(&["scribe", "status"]), &mut runtime);

    assert_eq!(start.stdout, ["scribe ok"]);
    assert_eq!(clear.stdout, ["scribe ok"]);
    assert_eq!(status.stdout, ["scribe ok"]);
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/scribe/start-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "tool": "claude",
                    "worktreePath": "feature",
                    "open": false,
                })),
            ),
            (
                "/core/scribe/clear-text".into(),
                Some(json!({ "project": "/repo", "sessionId": "scribe-1" })),
            ),
            (
                format!("{CORE_SCRIBE_STATUS_TEXT_ROUTE}?project=%2Frepo"),
                None,
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
            "--session=claude-1",
            "--json",
        ]),
        &mut runtime,
    );
    let clear = run_core_cli_with(
        &args(&["clear-notifications", "--project=/repo", "--id=note-4"]),
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
                    "ids": [],
                    "sessionId": "claude-1",
                })),
            ),
            (
                "/core/notifications/clear-text".into(),
                Some(json!({
                    "project": "/repo",
                    "id": "note-4",
                    "ids": [],
                    "sessionId": null,
                })),
            ),
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn desktop_notification_commands_execute_native_without_core_command_fallback() {
    let mut runtime = FakeRuntime::default();

    let doctor_text = run_core_cli_with(&args(&["doctor", "notifications"]), &mut runtime);
    let doctor_json =
        run_core_cli_with(&args(&["doctor", "notifications", "--json"]), &mut runtime);
    let test_text = run_core_cli_with(
        &args(&[
            "notifications",
            "test",
            "--title",
            "Ping",
            "--body=Ready",
            "--open-url",
            " aimux:///agent/codex-1/chat ",
        ]),
        &mut runtime,
    );
    let test_json = run_core_cli_with(
        &args(&[
            "notifications",
            "test",
            "--title= ",
            "--body",
            " ",
            "--json",
        ]),
        &mut runtime,
    );

    assert_eq!(
        doctor_text.stdout,
        ["Desktop notifications\nPlatform: macos\nTransport: mac-helper"]
    );
    assert_eq!(
        serde_json::from_str::<Value>(&doctor_json.stdout[0]).unwrap()["transport"],
        "mac-helper"
    );
    assert_eq!(
        test_text.stdout,
        [
            "Sent notification via mac-helper (/tmp/Ping-Ready-aimux:///agent/codex-1/chat/aimux-notifier.app/Contents/MacOS/aimux-notifier)."
        ]
    );
    let payload = serde_json::from_str::<Value>(&test_json.stdout[0]).unwrap();
    assert_eq!(payload["ok"], true);
    assert_eq!(
        payload["attempt"]["helperPath"],
        "/tmp/Aimux notification test-Desktop notification delivery is working.-none/aimux-notifier.app/Contents/MacOS/aimux-notifier"
    );
    assert!(runtime.commands.is_empty());
    assert!(runtime.text_routes.is_empty());
}

#[test]
fn outline_and_attachment_commands_execute_native_text_routes_without_core_command_fallback() {
    let mut runtime = FakeRuntime {
        cwd: "/repo/subdir".into(),
        ..FakeRuntime::default()
    };

    let list = run_core_cli_with(
        &args(&[
            "outline",
            "list",
            "--session=codex-1",
            "--search=parser",
            "--json",
        ]),
        &mut runtime,
    );
    let show = run_core_cli_with(&args(&["outline", "show", "outline-1"]), &mut runtime);
    let update = run_core_cli_with(
        &args(&[
            "outline",
            "update",
            "--title=Parser",
            "--summary=Port it",
            "--topic-key=parser",
            "--session=codex-1",
        ]),
        &mut runtime,
    );
    let attachment = run_core_cli_with(
        &args(&[
            "attachment",
            "publish",
            "notes.txt",
            "--session=codex-1",
            "--name=Notes.txt",
            "--mime=text/plain",
        ]),
        &mut runtime,
    );

    assert_eq!(list.stdout, ["outline ok"]);
    assert_eq!(show.stdout, ["outline ok"]);
    assert_eq!(update.stdout, ["outline ok"]);
    assert_eq!(
        attachment.stdout,
        ["Attached files:\n- notes.txt (text/plain, 5 bytes): /tmp/notes.txt"]
    );
    assert_eq!(
        runtime.text_routes,
        [
            (
                "/core/outline/list-text?project=%2Frepo&session=codex-1&search=parser&json=1"
                    .into(),
                None,
            ),
            (
                "/core/outline/list-text?project=%2Frepo&entryId=outline-1".into(),
                None,
            ),
            (
                "/core/outline/update-text".into(),
                Some(json!({
                    "project": "/repo",
                    "title": "Parser",
                    "summary": "Port it",
                    "topicKey": "parser",
                    "sessionId": "codex-1",
                    "worktreePath": null,
                    "status": null,
                    "source": null,
                })),
            ),
            (
                "/core/attachment/publish-text".into(),
                Some(json!({
                    "project": "/repo",
                    "path": "/repo/subdir/notes.txt",
                    "sessionId": "codex-1",
                    "filename": "Notes.txt",
                    "mimeType": "text/plain",
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
    let message_json = run_core_cli_with(
        &args(&["message", "send", "please", "--to=claude-1", "--json"]),
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
    assert_eq!(message_json.stdout, ["task task-1\nthread thread-1"]);
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
                "/core/message/send-text?json=1".into(),
                Some(json!({
                    "project": "/repo",
                    "thread": null,
                    "from": null,
                    "to": "claude-1",
                    "assignee": null,
                    "tool": null,
                    "worktree": null,
                    "kind": null,
                    "body": "please",
                    "title": null,
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
    let review_list = run_core_cli_with(&args(&["review", "list"]), &mut runtime);

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
        review_list,
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
            (
                format!("{CORE_REVIEW_LIST_TEXT_ROUTE}?project=%2Frepo"),
                None,
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
            "--body",
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
    let threads = run_core_cli_with(
        &args(&["threads", "--project=/repo", "--json"]),
        &mut runtime,
    );

    for execution in [list, show, open, send, mark_seen, status, threads] {
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
            ("/core/thread/list-text?project=%2Frepo&json=1".into(), None,),
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
fn security_device_commands_match_node_cli_surface() {
    let device = json!({
        "id": "dev-1",
        "deviceId": "browser-1",
        "kind": "web",
        "name": "Sam MBP",
        "platform": "macOS",
        "lastSeenAt": "2026-09-09T00:00:00.000Z",
        "lastCountry": "SG",
        "approved": false,
        "blocked": false
    });
    let mut runtime = FakeRuntime {
        credentials: Some(json!({
            "userId": "user-1",
            "relayUrl": "wss://relay.example",
            "remoteEnabled": true
        })),
        security_devices: vec![device.clone()],
        ..FakeRuntime::default()
    };

    let list = run_core_cli_with(&args(&["security", "devices"]), &mut runtime);
    assert_eq!(list.code, 0);
    assert_eq!(
        list.stdout,
        [
            "Remote client devices (most recent first)",
            "",
            "pending  Sam MBP from SG",
            "  id       dev-1",
            "  platform macOS",
            "  seen     2026-09-09T00:00:00.000Z"
        ]
    );

    let list_json = run_core_cli_with(&args(&["security", "devices", "--json"]), &mut runtime);
    assert_eq!(list_json.code, 0);
    assert_eq!(
        serde_json::from_str::<Value>(&list_json.stdout[0]).expect("devices json"),
        json!({ "devices": [device] })
    );

    let approve = run_core_cli_with(
        &args(&["security", "approve", "dev-1", "--code", "123456"]),
        &mut runtime,
    );
    assert_eq!(approve.code, 0);
    assert_eq!(approve.stdout, ["Approved dev-1 (Sam MBP)"]);
    assert_eq!(
        runtime.security_updates.borrow().as_slice(),
        [("dev-1".into(), "approve".into(), Some("123456".into()))]
    );

    let revoke = run_core_cli_with(&args(&["security", "revoke", "dev-1"]), &mut runtime);
    assert_eq!(revoke.code, 0);
    assert_eq!(revoke.stdout, ["Blocked dev-1 (Sam MBP)"]);
    assert_eq!(
        runtime.security_updates.borrow().last(),
        Some(&("dev-1".into(), "block".into(), None))
    );
}

#[test]
fn security_live_device_approval_matches_node_noninteractive_empty_state() {
    let mut runtime = FakeRuntime {
        credentials: Some(json!({
            "userId": "user-1",
            "relayUrl": "wss://relay.example",
            "remoteEnabled": true
        })),
        pending_security_devices: Vec::new(),
        ..FakeRuntime::default()
    };

    let text = run_core_cli_with(&args(&["security", "device", "approve"]), &mut runtime);
    assert_eq!(text.code, 0);
    assert_eq!(
        text.stdout,
        ["No live remote clients are waiting for approval."]
    );

    let json = run_core_cli_with(
        &args(&["security", "device", "approve", "dev-2", "--json"]),
        &mut runtime,
    );
    assert_eq!(json.code, 0);
    assert_eq!(
        serde_json::from_str::<Value>(&json.stdout[0]).expect("approve live json"),
        serde_json::json!({
            "ok": false,
            "devices": [],
            "error": "No live remote clients are waiting for approval"
        })
    );
}

#[test]
fn restart_control_plane_runs_native_restart_and_preserves_project_scope() {
    let mut runtime = FakeRuntime::default();

    let current = run_core_cli_with(&args(&["restart"]), &mut runtime);

    assert_eq!(current.code, 0);
    assert!(current.stdout[0].contains("Aimux Restart"));
    assert!(current.stdout[0].contains("failures: 0"));
    assert!(current.stderr.is_empty());
    assert_eq!(runtime.restart_calls, [(Some("/repo".into()), false)]);
    assert!(runtime.commands.is_empty());

    let execution = run_core_cli_with(
        &args(&["restart", "--project", "child", "--force"]),
        &mut runtime,
    );

    assert_eq!(execution.code, 0);
    assert!(execution.stdout[0].contains("Restart forced before backendSessionId capture"));
    assert!(execution.stdout[0].contains("codex-pending (codex, running) in /resolved/child"));
    assert!(execution.stderr.is_empty());
    assert_eq!(
        runtime.restart_calls,
        [
            (Some("/repo".into()), false),
            (Some("/resolved/child".into()), true)
        ]
    );
    assert!(runtime.commands.is_empty());

    let all = run_core_cli_with(&args(&["restart", "--all"]), &mut runtime);

    assert_eq!(all.code, 0);
    assert_eq!(
        runtime.restart_calls,
        [
            (Some("/repo".into()), false),
            (Some("/resolved/child".into()), true),
            (None, false)
        ]
    );
    assert!(runtime.commands.is_empty());
}

#[test]
fn restart_control_plane_does_not_require_git_cwd_without_project_scope() {
    let mut runtime = FakeRuntime {
        cwd: "/Users/sam".into(),
        git_project_root: false,
        ..FakeRuntime::default()
    };

    let execution = run_core_cli_with(&args(&["restart"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert!(execution.stdout[0].contains("Aimux Restart"));
    assert!(execution.stdout[0].contains("failures: 0"));
    assert!(execution.stderr.is_empty());
    assert_eq!(runtime.restart_calls, [(None, false)]);
    assert!(runtime.commands.is_empty());
}

#[test]
fn restart_control_plane_text_emits_progress_before_route_returns() {
    let mut runtime = FakeRuntime::default();

    let execution = run_core_cli_with(&args(&["restart"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert_eq!(runtime.restart_calls, [(Some("/repo".into()), false)]);
    assert_eq!(
        runtime.restart_progress,
        ["Restarting Aimux control plane..."]
    );
}

#[test]
fn restart_control_plane_json_does_not_emit_text_progress() {
    let mut runtime = FakeRuntime::default();

    let execution = run_core_cli_with(&args(&["restart", "--json"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert_eq!(runtime.restart_calls, [(Some("/repo".into()), false)]);
    assert!(runtime.restart_progress.is_empty());
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
    assert_eq!(runtime.restart_calls, [(None, false)]);
    let report: Value = serde_json::from_str(&execution.stdout[0]).expect("restart json");
    assert_eq!(report["summary"]["failures"], json!(2));
}

#[test]
fn daemon_stop_and_kill_execute_native_local_supervisor_action() {
    let mut stop_runtime = FakeRuntime::default();
    let stop = run_core_cli_with(&args(&["daemon", "stop"]), &mut stop_runtime);

    assert_eq!(stop.code, 0);
    assert_eq!(stop.stdout, ["Stopped aimux daemon pid 9001"]);
    assert_eq!(stop_runtime.stop_daemon_calls, ["SIGTERM"]);
    assert!(stop_runtime.commands.is_empty());
    assert!(stop_runtime.text_routes.is_empty());

    let mut kill_runtime = FakeRuntime {
        stopped_daemon: None,
        ..FakeRuntime::default()
    };
    let kill = run_core_cli_with(&args(&["daemon", "kill", "--json"]), &mut kill_runtime);

    assert_eq!(kill.code, 0);
    assert_eq!(kill_runtime.stop_daemon_calls, ["SIGKILL"]);
    let payload: Value = serde_json::from_str(&kill.stdout[0]).expect("stop json");
    assert_eq!(payload["stopped"], Value::Null);
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

#[test]
fn host_restart_json_uses_existing_restart_command_renderer() {
    let mut runtime = FakeRuntime::default();

    let execution = run_core_cli_with(&args(&["host", "restart", "--json"]), &mut runtime);

    assert_eq!(execution.code, 0);
    assert!(execution.stderr.is_empty());
    let payload: Value = serde_json::from_str(&execution.stdout[0]).expect("restart json");
    assert_eq!(payload["projectRoot"], "/repo");
    assert_eq!(runtime.commands.len(), 1);
    assert_eq!(
        runtime.commands[0].command,
        CORE_COMMAND_NAMES.project_restart
    );
    assert!(runtime.open_targets.is_empty());
}
