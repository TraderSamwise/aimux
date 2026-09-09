use aimux::config::default_config;
use aimux::core_cli::{CoreCommandCall, CoreCommandOk, CoreLoopActorContext};
use aimux::core_cli_executor::{CoreCliRuntime, run_core_cli_with};
use aimux::core_cli_routing::is_core_cli_command;
use aimux::daemon::text::auth::AuthFlowResult;
use aimux::daemon::text::operations::RestartControlPlaneTextResult;
use aimux::daemon_state::{AimuxDaemonInfo, DaemonState, StoppedDaemonInfo};
use aimux::native_cli_dispatch::{
    native_root_tool_launch_args_for_config, normalize_root_dispatch_args,
};
use aimux::root_session_launch::{RootSessionLaunchMode, parse_root_resume_args};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/cli/top-level-dispatch.json");

#[test]
fn fixture_cli_top_level_dispatch_matches_native_regression_contract() {
    let contract: Value =
        serde_json::from_str(FIXTURE).expect("valid cli/top-level-dispatch fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("top-level dispatch cases");
    assert_eq!(cases.len(), 12, "unexpected top-level dispatch case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = cli_top_level_dispatch_actual(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} cli/top-level-dispatch parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn cli_top_level_dispatch_actual(case: &Value) -> Value {
    let args = string_array(&case["input"]["args"]);
    let mut config = default_config();
    if let Some(disabled) = case["input"]["disabledTool"].as_str()
        && let Some(tool) = config
            .get_mut("tools")
            .and_then(|tools| tools.get_mut(disabled))
        && let Some(tool) = tool.as_object_mut()
    {
        tool.insert("enabled".to_owned(), Value::Bool(false));
    }
    let normalized = normalize_root_dispatch_args(&args);
    if let Some(request) = parse_root_resume_args(&normalized) {
        return json!({
            "normalizedArgs": normalized,
            "rootSession": {
                "mode": match request.mode {
                    RootSessionLaunchMode::Resume => "resume",
                    RootSessionLaunchMode::Restore => "restore",
                },
                "toolFilter": request.tool_filter,
                "ignoredArgs": request.ignored_args,
            },
            "launchArgs": Value::Null,
            "execution": Value::Null,
        });
    }
    let launch_args = native_root_tool_launch_args_for_config(&normalized, &config);
    let execution_args = launch_args
        .as_ref()
        .or_else(|| is_core_cli_command(&normalized).then_some(&normalized));
    let execution = execution_args.map(|execution_args| {
        let mut runtime = FakeRuntime::default();
        let execution = run_core_cli_with(execution_args, &mut runtime);
        json!({
            "code": execution.code,
            "stdout": normalize_stdout(&execution.stdout),
            "stderr": execution.stderr,
            "textRoutes": runtime.text_routes,
        })
    });
    json!({
        "normalizedArgs": normalized,
        "rootSession": Value::Null,
        "launchArgs": launch_args,
        "execution": execution,
    })
}

fn normalize_stdout(stdout: &[String]) -> Value {
    Value::Array(
        stdout
            .iter()
            .map(|line| serde_json::from_str::<Value>(line).unwrap_or_else(|_| json!(line)))
            .collect(),
    )
}

#[derive(Debug, Default)]
struct FakeRuntime {
    text_routes: Vec<Value>,
}

impl CoreCliRuntime for FakeRuntime {
    fn cwd(&self) -> String {
        "/repo".into()
    }

    fn resolve_project_root(&self, path: &str) -> String {
        if path == "/repo" {
            "/repo".into()
        } else {
            format!("/resolved/{path}")
        }
    }

    fn load_daemon_info(&self) -> Option<AimuxDaemonInfo> {
        Some(AimuxDaemonInfo {
            pid: 123,
            port: 43190,
            started_at: "2026-09-08T00:00:00.000Z".into(),
            updated_at: "2026-09-08T00:00:00.000Z".into(),
        })
    }

    fn load_daemon_state(&self) -> DaemonState {
        DaemonState::empty()
    }

    fn has_remote_credentials(&self) -> bool {
        false
    }

    fn loop_actor_context(&self) -> CoreLoopActorContext {
        CoreLoopActorContext::default()
    }

    fn credentials_for_status(&self) -> Option<Value> {
        None
    }

    fn whoami_payload(&self) -> Value {
        json!({ "credentials": Value::Null })
    }

    fn set_remote_enabled(&self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }

    fn clear_credentials(&self) -> String {
        "none".into()
    }

    fn run_login_flow(&self, _security_unlock: bool) -> Result<AuthFlowResult, String> {
        unreachable!("top-level dispatch fixture does not exercise login")
    }

    fn list_remote_security_devices(&self, _pending: bool) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }

    fn update_remote_security_device(
        &self,
        _device_id: &str,
        _action: &str,
        _approval_code: Option<&str>,
    ) -> Result<Value, String> {
        unreachable!("top-level dispatch fixture does not exercise security devices")
    }

    fn request_core_command(&mut self, request: &CoreCommandCall) -> Result<CoreCommandOk, String> {
        Ok(CoreCommandOk {
            ok: true,
            id: "test".into(),
            command: request.command.to_owned(),
            issued_at: "2026-09-08T00:00:00.000Z".into(),
            result: json!({ "ok": true }),
        })
    }

    fn request_daemon_text(&mut self, path: &str, body: Option<Value>) -> Result<String, String> {
        self.text_routes.push(json!({
            "path": path,
            "body": body.clone(),
        }));
        if path.starts_with("/core/lifecycle/spawn-text") {
            let tool = body
                .as_ref()
                .and_then(|body| body.get("tool"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            return Ok(json!({
                "ok": true,
                "projectRoot": "/repo",
                "sessionId": format!("{tool}-1"),
                "tool": tool,
                "worktreePath": "/repo",
                "opened": false,
                "tmuxTarget": {
                    "sessionName": "aimux-repo",
                    "windowId": "@9",
                    "windowIndex": 9,
                    "windowName": tool,
                    "paneDead": false
                }
            })
            .to_string());
        }
        if path.starts_with("/core/services/create-text") {
            return Ok("service service-1 running\n".into());
        }
        Ok("ok\n".into())
    }

    fn selected_log_path(&self, _options: &aimux::core_cli_routing::CoreLogsArgs) -> PathBuf {
        PathBuf::from("/tmp/aimux.log")
    }

    fn read_log_lines(&self, _path: &Path, _lines: usize) -> String {
        String::new()
    }

    fn clear_log(&self, _path: &Path) -> Result<(), String> {
        Ok(())
    }

    fn init_project(&self, _project_root: &str) -> Result<(), String> {
        Ok(())
    }

    fn is_git_project_root(&self, _project_root: &str) -> bool {
        true
    }

    fn runtime_topology_path(&self, _project_root: &str) -> PathBuf {
        PathBuf::from("/repo/.aimux/runtime-topology.yaml")
    }

    fn read_text_file(&self, _path: &Path) -> Result<String, String> {
        Ok(String::new())
    }

    fn read_runtime_topology(&self, _path: &Path) -> Result<Value, String> {
        Ok(json!({ "version": 1, "rigs": [] }))
    }

    fn open_dashboard_target(&mut self, _target: &Value) -> Result<(), String> {
        Ok(())
    }

    fn restart_control_plane(
        &mut self,
        _project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        unreachable!("top-level dispatch fixture does not exercise restart")
    }

    fn stop_daemon(&mut self, _signal: &str) -> Result<Option<StoppedDaemonInfo>, String> {
        Ok(None)
    }

    fn debug_state_report(&self, _target: &str) -> Result<String, String> {
        Ok(String::new())
    }

    fn runtime_migration_audit(&self, _project_root: &str) -> Result<String, String> {
        Ok(String::new())
    }

    fn runtime_migration_import(&self, _project_root: &str) -> Result<String, String> {
        Ok(String::new())
    }

    fn runtime_migration_rollback(&self, _manifest: &str) -> Result<String, String> {
        Ok(String::new())
    }

    fn desktop_notifier_doctor_report(&self) -> Result<Value, String> {
        Ok(json!({ "transport": "disabled" }))
    }

    fn desktop_notifier_doctor_text(&self) -> Result<String, String> {
        Ok("desktop notifications disabled\n".into())
    }

    fn send_desktop_notification_test(&self, _title: &str, _body: &str) -> Result<Value, String> {
        Ok(json!({ "ok": false }))
    }
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("string array")
        .iter()
        .map(|item| item.as_str().expect("string").to_owned())
        .collect()
}
