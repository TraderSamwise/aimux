use aimux::agent_display::{AgentDisplayInput, resolve_statusline_model};
use aimux::backend_session_ids::{build_agent_identity_payload, resolve_agent_identity};
use aimux::config::load_config_for_known_project_root;
use aimux::dashboard_create::DashboardCreatePlan;
use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::dashboard_tool_picker::{
    DashboardToolPickerEffect, DashboardToolPickerMode, DashboardToolPickerState,
    enabled_dashboard_tools,
};
use aimux::project_api_contract::routes;
use aimux::project_service::lifecycle::{
    ProjectLifecycleRuntime, route_lifecycle_request_with_runtime,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::statusline::{
    build_statusline_snapshot, render_tmux_statusline_contract,
};
use aimux::runtime_topology::{
    coerce_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::tmux::{LiveWindowIndex, TmuxTarget, TmuxWindowInfo, project_session};
use aimux::tui_render::text::strip_ansi;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const SOURCE_ID: &str = "codex-lookalike-source";
const TARGET_ID: &str = "claude-lookalike-fork";
const TARGET_TOOL: &str = "codex-profile";
const TARGET_COMMAND: &str = "/bin/claude-shim";
const AT: &str = "2026-01-01T00:00:00.000Z";

struct ProbeDirectory(PathBuf);

impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct ForkRuntime {
    target: Option<TmuxTarget>,
    launch: Option<(String, Vec<String>)>,
    metadata: BTreeMap<String, Value>,
}

impl ProjectLifecycleRuntime for ForkRuntime {
    fn repair_legacy_project_session_names(&mut self, _project_root: &Path) -> Result<(), String> {
        Ok(())
    }
    fn ensure_project_session(&mut self, _project_root: &Path) -> Result<(), String> {
        Ok(())
    }
    fn find_main_repo(&mut self, _cwd: &str) -> Result<String, String> {
        Err("fork surface test must not discover another checkout".into())
    }
    fn create_worktree(
        &mut self,
        _main_repo: &str,
        _name: &str,
        _target_path: &str,
    ) -> Result<(), String> {
        Err("fork surface test must reuse the source checkout".into())
    }
    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        _cwd: &str,
        command: &str,
        args: &[String],
        _detached: bool,
    ) -> Result<TmuxTarget, String> {
        assert!(self.target.is_none(), "fork must create exactly one window");
        let target = TmuxTarget {
            session_name: session_name.into(),
            window_id: "@12".into(),
            window_index: 12,
            window_name: name.into(),
            pane_dead: Some(false),
        };
        self.launch = Some((command.into(), args.to_vec()));
        self.target = Some(target.clone());
        Ok(target)
    }
    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        self.metadata.insert(window_id.into(), metadata.clone());
        Ok(())
    }
    fn set_window_option(
        &mut self,
        _window_id: &str,
        _key: &str,
        _value: &str,
    ) -> Result<(), String> {
        Ok(())
    }
    fn clear_history(&mut self, _window_id: &str) -> Result<(), String> {
        Ok(())
    }
    fn has_window(&mut self, target: &TmuxTarget) -> bool {
        self.target
            .as_ref()
            .is_some_and(|known| known.window_id == target.window_id)
    }
    fn list_windows(&mut self, session_name: &str) -> Result<Vec<TmuxWindowInfo>, String> {
        let target = self.target.as_ref().ok_or("no fork window was created")?;
        assert_eq!(session_name, target.session_name);
        Ok(vec![TmuxWindowInfo {
            id: target.window_id.clone(),
            index: target.window_index,
            name: target.window_name.clone(),
            active: false,
            activity: None,
            pane_dead: Some(false),
        }])
    }
    fn capture_window(&mut self, _target: &TmuxTarget) -> Option<String> {
        Some("configured target is ready".into())
    }
    fn kill_window(&mut self, window_id: &str) -> Result<(), String> {
        assert_eq!(
            self.target.as_ref().map(|target| target.window_id.as_str()),
            Some(window_id)
        );
        self.target = None;
        Ok(())
    }
    fn rename_window(&mut self, _window_id: &str, _name: &str) -> Result<(), String> {
        Err("fork surface test must leave the source window unchanged".into())
    }
}

fn find_session<'a>(value: &'a Value, field: &str, id: &str) -> &'a Value {
    value[field]
        .as_array()
        .expect("session array")
        .iter()
        .find(|session| session["id"] == id)
        .expect("requested session exists")
}

#[test]
fn fork_tool_identity_matches_cli_tmux_tui_statusline_and_the_real_app() {
    let directory = ProbeDirectory(std::env::temp_dir().join(format!(
        "aimux-fork-surfaces-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos()
    )));
    let root = &directory.0;
    fs::create_dir_all(root.join(".git")).expect("isolated checkout marker");
    fs::create_dir_all(root.join(".aimux/context").join(SOURCE_ID))
        .expect("source context directory");
    fs::write(
        root.join(".aimux/context").join(SOURCE_ID).join("live.md"),
        "Continue the source conversation about the fork surface regression.",
    )
    .expect("source context");
    fs::write(root.join(".aimux/config.json"), serde_json::to_vec(&json!({
        "runtime": { "agentPreambleEnabled": false },
        "tools": {
            "source-profile": { "command": "/bin/codex-shim", "args": ["--source-only"], "enabled": true },
            TARGET_TOOL: {
                "command": TARGET_COMMAND, "args": ["--target-only"], "enabled": true,
                "wrapperEnabled": true, "preambleFlag": ["--target-context"],
                "sessionIdFlag": ["--native-id", "{sessionId}"],
                "defaultArgs": ["--model", "target-model"],
                "defaultEnv": { "FORK_PROFILE": "target-profile" },
                "resumeArgs": ["--resume", "{sessionId}"]
            }
        }
    })).expect("serialize config")).expect("write config");
    let state_dir = root.join("state");
    let tmux_session = project_session(root, "aimux").session_name;
    let topology = coerce_runtime_topology(&json!({
        "version": 1, "generatedAt": AT,
        "rigs": [{ "id": "rig-1", "name": "surface", "projectRoot": root, "createdAt": AT, "updatedAt": AT }],
        "nodes": [{ "id": "agent:source", "rigId": "rig-1", "logicalId": SOURCE_ID,
            "runtime": "source-profile", "toolConfigKey": "source-profile", "cwd": root,
            "label": "codex misleading", "createdAt": AT }],
        "bindings": [{ "id": "tmux:source", "nodeId": "agent:source", "tmuxSession": tmux_session,
            "tmuxWindowId": "@11", "tmuxWindowIndex": 11, "tmuxWindowName": "source", "updatedAt": AT }],
        "sessions": [{ "id": SOURCE_ID, "nodeId": "agent:source", "status": "running",
            "tool": "source-profile", "toolConfigKey": "source-profile", "command": "/bin/codex-shim",
            "args": ["--source-only"], "backendSessionId": "source-native-id", "label": "codex misleading",
            "createdAt": AT, "updatedAt": AT }]
    })).expect("source topology");
    let source_before = find_session(&topology, "sessions", SOURCE_ID).clone();
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).expect("write topology");
    let context = ProjectServiceRequestContext::with_project_state_dir(root, &state_dir)
        .with_live_windows(LiveWindowIndex::from_pairs([
            ("@11", tmux_session.as_str()),
            ("@12", tmux_session.as_str()),
        ]));
    let config = load_config_for_known_project_root(root);
    let mut picker = DashboardToolPickerState::with_mode(
        enabled_dashboard_tools(&config),
        DashboardToolPickerMode::Fork {
            source_session_id: SOURCE_ID.into(),
        },
    );
    picker.index = picker
        .tools
        .iter()
        .position(|tool| tool.key == TARGET_TOOL)
        .expect("target class available");
    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(mut request)) =
        picker.create_selected(None)
    else {
        panic!("the TUI must submit a configured fork request");
    };
    request.body["targetSessionId"] = json!(TARGET_ID);
    let mut runtime = ForkRuntime::default();
    let response = route_lifecycle_request_with_runtime(
        &context,
        request.method,
        request.path,
        Some(&request.body),
        &mut runtime,
    )
    .expect("fork route");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body["tool"], TARGET_TOOL);
    let (launch_command, launch_args) = runtime.launch.as_ref().expect("fork launched");
    let launch = format!("{launch_command} {}", launch_args.join(" "));
    assert!(launch.contains(TARGET_COMMAND), "{launch}");
    assert!(
        launch.contains("--target-only") && launch.contains("target-model"),
        "{launch}"
    );
    assert!(!launch.contains("--source-only"), "{launch}");
    let target = runtime.target.as_ref().expect("fork window survives");
    let tmux_metadata = runtime
        .metadata
        .get(&target.window_id)
        .expect("target tmux metadata");
    assert_eq!(
        tmux_metadata["args"],
        json!(["--target-only", "--model", "target-model"])
    );
    let topology =
        read_runtime_topology(runtime_topology_path(&state_dir)).expect("persisted topology");
    assert_eq!(
        find_session(&topology, "sessions", SOURCE_ID),
        &source_before
    );
    let identity = resolve_agent_identity(root.to_str().expect("utf8 root"), TARGET_ID, &topology)
        .expect("CLI identity");
    let canonical = build_agent_identity_payload(root.to_str().expect("utf8 root"), &identity);
    assert_ne!(canonical["backendSessionId"], "source-native-id");
    assert!(
        canonical["backendSessionId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
    let agents = route_project_service_request(&context, "GET", routes::agents::LIST, None);
    let desktop = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);
    assert_eq!(agents.status, 200, "{}", agents.body);
    assert_eq!(desktop.status, 200, "{}", desktop.body);
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(desktop.body.clone()).expect("TUI snapshot");
    let frame = strip_ansi(
        &render_dashboard_frame(&DashboardRenderInput {
            snapshot: &snapshot,
            overseer_sessions: &[],
            scribe_sessions: &[],
            cols: 180,
            rows: 60,
            nav_level: DashboardNavLevel::Sessions,
            selected_session_id: Some(TARGET_ID),
            selected_service_id: None,
            focused_worktree_path: None,
            focused_group_index: None,
            runtime_label: Some("tmux"),
            version: Some("test"),
            hide_offline_agents: false,
            hidden_offline_agent_count: 0,
            scroll_offset: 0,
            footer_progress: None,
            footer_note: None,
            footer_alerts: &[],
            details_sidebar_visible: true,
            preview_source: "output",
            scribe_preview_entries: &[],
        })
        .frame,
    );
    let tui_tool = frame
        .lines()
        .find_map(|line| {
            line.split_once("Canonical: ")
                .and_then(|(_, value)| value.split_whitespace().next())
        })
        .expect("TUI renders canonical tool");
    let statusline = build_statusline_snapshot(&context).expect("statusline snapshot");
    let statusline_target = find_session(&statusline, "sessions", TARGET_ID);
    let statusline_identity =
        resolve_statusline_model(&AgentDisplayInput::from_value(statusline_target));
    let footer = render_tmux_statusline_contract(&json!({
        "data": statusline, "projectRoot": root, "line": "bottom",
        "options": { "currentWindowId": "@12", "currentPath": root, "width": 240 }
    }));
    assert!(
        footer["text"]
            .as_str()
            .expect("rendered footer")
            .contains(TARGET_COMMAND),
        "{footer}"
    );
    let probe = root.join("fork-surfaces.json");
    fs::write(
        &probe,
        serde_json::to_vec(&json!({
            "agents": agents.body, "desktop": desktop.body, "expectedTool": TARGET_TOOL,
            "sourceId": SOURCE_ID, "targetId": TARGET_ID, "canonicalId": canonical["canonical"],
            "tmuxMetadataTool": tmux_metadata["toolConfigKey"], "tuiTool": tui_tool,
            "statuslineTool": statusline_identity.tool,
        }))
        .expect("serialize surface observations"),
    )
    .expect("write surface observations");
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let report = root.join("fork-surface-report.json");
    let result = Command::new(project.join("scripts/run-yarn"))
        .current_dir(&project)
        .args([
            "--cwd",
            "app",
            "vitest",
            "run",
            "lib/fork-tool.cross-surface.test.ts",
            "--reporter=json",
        ])
        .arg(format!("--outputFile={}", report.display()))
        .env("AIMUX_FORK_SURFACE_PROBE", &probe)
        .output()
        .expect("run scoped app identity comparison");
    let report_bytes = fs::read(&report);
    let report_detail = match report_bytes.as_ref() {
        Ok(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        Err(error) => format!("could not read app report: {error}"),
    };
    assert!(
        result.status.success(),
        "app fork comparison failed ({}):\n{}\n{}\n{}",
        result.status,
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
        report_detail,
    );
    let summary: Value =
        serde_json::from_slice(&fs::read(&report).expect("app comparison report must exist"))
            .expect("app comparison report must be JSON");
    let passed = summary["numPassedTests"]
        .as_u64()
        .expect("passed test count");
    let pending = summary["numPendingTests"]
        .as_u64()
        .expect("pending test count");
    assert!(
        passed > 0 && pending == 0,
        "comparison did not run: {passed} passed, {pending} pending"
    );
    let actual_comparison_ran = summary["testResults"]
        .as_array()
        .expect("test results")
        .iter()
        .flat_map(|suite| {
            suite["assertionResults"]
                .as_array()
                .expect("assertion results")
        })
        .any(|assertion| {
            assertion["title"] == "compares the real fork across every surface"
                && assertion["status"] == "passed"
        });
    assert!(
        actual_comparison_ran,
        "the real probe comparison must pass; the static fixture is insufficient"
    );
}
