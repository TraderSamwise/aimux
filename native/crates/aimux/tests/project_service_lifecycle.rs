use aimux::daemon_state::load_metadata_state;
use aimux::project_api_contract::routes;
use aimux::project_service::lifecycle::{
    ProjectLifecycleRuntime, ensure_default_scribe_agent, route_lifecycle_request_with_runtime,
};
use aimux::project_service::operation_failures::list_dashboard_operation_failures;
use aimux::project_service::process::{ProjectServiceStartup, run_project_service_startup_tasks};
use aimux::project_service::prompt_context::{get_prompt_context_text, set_prompt_context};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::runtime_exchange_path;
use aimux::runtime_topology::{
    coerce_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::tmux::TmuxTarget;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, remove_dir_all};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct FakeLifecycleRuntime {
    legacy_repairs: Vec<PathBuf>,
    ensured_sessions: Vec<PathBuf>,
    created: Vec<FakeCreateWindow>,
    cleared: Vec<String>,
    metadata: Vec<(String, Value)>,
    options: Vec<(String, String, String)>,
    killed: Vec<String>,
    existing_windows: Vec<String>,
    renamed: Vec<(String, String)>,
    codex_backend_ids_by_cwd: BTreeMap<String, Result<BTreeSet<String>, String>>,
    main_repo: Option<String>,
    worktrees_created: Vec<FakeCreateWorktree>,
    create_worktree_error: Option<String>,
    create_window_error: Option<String>,
    kill_window_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FakeCreateWindow {
    session_name: String,
    name: String,
    cwd: String,
    command: String,
    args: Vec<String>,
    detached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FakeCreateWorktree {
    main_repo: String,
    name: String,
    target_path: String,
}

impl ProjectLifecycleRuntime for FakeLifecycleRuntime {
    fn repair_legacy_project_session_names(&mut self, project_root: &Path) -> Result<(), String> {
        self.legacy_repairs.push(project_root.to_owned());
        Ok(())
    }

    fn ensure_project_session(&mut self, project_root: &Path) -> Result<(), String> {
        self.ensured_sessions.push(project_root.to_owned());
        Ok(())
    }

    fn find_main_repo(&mut self, cwd: &str) -> Result<String, String> {
        Ok(self.main_repo.clone().unwrap_or_else(|| cwd.to_owned()))
    }

    fn create_worktree(
        &mut self,
        main_repo: &str,
        name: &str,
        target_path: &str,
    ) -> Result<(), String> {
        self.worktrees_created.push(FakeCreateWorktree {
            main_repo: main_repo.to_owned(),
            name: name.to_owned(),
            target_path: target_path.to_owned(),
        });
        match &self.create_worktree_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String> {
        self.created.push(FakeCreateWindow {
            session_name: session_name.to_owned(),
            name: name.to_owned(),
            cwd: cwd.to_owned(),
            command: command.to_owned(),
            args: args.to_owned(),
            detached,
        });
        if let Some(error) = &self.create_window_error {
            return Err(error.clone());
        }
        let target = TmuxTarget {
            session_name: session_name.to_owned(),
            window_id: format!("@{}", self.created.len() + 10),
            window_index: self.created.len() as i64 + 10,
            window_name: name.to_owned(),
            pane_dead: None,
        };
        self.existing_windows.push(target.window_id.clone());
        Ok(target)
    }

    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        self.metadata.push((window_id.to_owned(), metadata.clone()));
        Ok(())
    }

    fn set_window_option(&mut self, window_id: &str, key: &str, value: &str) -> Result<(), String> {
        self.options
            .push((window_id.to_owned(), key.to_owned(), value.to_owned()));
        Ok(())
    }

    fn clear_history(&mut self, window_id: &str) -> Result<(), String> {
        self.cleared.push(window_id.to_owned());
        Ok(())
    }

    fn has_window(&mut self, target: &TmuxTarget) -> bool {
        self.existing_windows.contains(&target.window_id)
    }

    fn codex_backend_session_ids_for_cwd(&mut self, cwd: &str) -> Result<BTreeSet<String>, String> {
        self.codex_backend_ids_by_cwd
            .get(cwd)
            .cloned()
            .unwrap_or_else(|| Ok(BTreeSet::new()))
    }

    fn kill_window(&mut self, window_id: &str) -> Result<(), String> {
        self.killed.push(window_id.to_owned());
        match &self.kill_window_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String> {
        self.renamed.push((window_id.to_owned(), name.to_owned()));
        Ok(())
    }
}

#[test]
fn agent_stop_takes_session_offline_and_kills_window() {
    let project = temp_project("agent-stop");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();
    assert!(set_prompt_context(&state_dir, "codex-live", "form=event").is_some());

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::STOP,
        Some(&json!({ "sessionId": "codex-live" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["sessionId"], "codex-live");
    assert_eq!(response.body["status"], "offline");
    assert_eq!(response.body["transition"]["operation"], "agent.stop");
    assert_eq!(response.body["transition"]["phase"], "succeeded");
    assert_eq!(runtime.killed, vec!["@agent"]);
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-live");
    assert_eq!(session["status"], "offline");
    assert!(session["graveyardedAt"].is_null());
    assert!(session["graveyardReason"].is_null());
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "node-agent")
    );
    cleanup(project);
}

#[test]
fn agent_stop_reports_tmux_kill_failure_without_taking_session_offline() {
    let project = temp_project("agent-stop-kill-failure");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        kill_window_error: Some("tmux server refused kill-window".into()),
        ..Default::default()
    };
    assert!(set_prompt_context(&state_dir, "codex-live", "form=event").is_some());

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::STOP,
        Some(&json!({ "sessionId": "codex-live" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert!(response.body["error"].as_str().unwrap().contains(
        "tmux kill-window failed for session \"codex-live\": tmux server refused kill-window"
    ));
    assert_eq!(runtime.killed, vec!["@agent"]);
    let topology = read_topology(&state_dir);
    assert_eq!(session(&topology, "codex-live")["status"], "running");
    assert_eq!(
        get_prompt_context_text(&state_dir, "codex-live"),
        Some("form=event".to_owned())
    );
    cleanup(project);
}

#[test]
fn agent_stop_marks_codex_without_backend_history_fresh_relaunchable() {
    let project = temp_project("agent-stop-codex-fresh");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::STOP,
        Some(&json!({ "sessionId": "codex-live" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-live");
    assert_eq!(session["status"], "offline");
    assert_eq!(session["freshRelaunchAllowed"], true);
    assert!(session.get("backendSessionId").is_none());
    cleanup(project);
}

#[test]
fn agent_stop_records_discovered_codex_backend_before_taking_offline() {
    let project = temp_project("agent-stop-codex-discovered");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();
    let project_cwd = project.to_string_lossy().into_owned();
    runtime.codex_backend_ids_by_cwd.insert(
        project_cwd,
        Ok(BTreeSet::from([
            "0710a963-a473-430f-9f9a-e27dd4546328".into()
        ])),
    );

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::STOP,
        Some(&json!({ "sessionId": "codex-live" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-live");
    assert_eq!(
        session["backendSessionId"],
        "0710a963-a473-430f-9f9a-e27dd4546328"
    );
    assert_eq!(session["freshRelaunchAllowed"], false);
    cleanup(project);
}

#[test]
fn agent_stop_keeps_restore_blocked_when_codex_history_is_ambiguous() {
    let project = temp_project("agent-stop-codex-ambiguous");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();
    let project_cwd = project.to_string_lossy().into_owned();
    runtime.codex_backend_ids_by_cwd.insert(
        project_cwd,
        Ok(BTreeSet::from([
            "0710a963-a473-430f-9f9a-e27dd4546328".into(),
            "11111111-2222-3333-4444-555555555555".into(),
        ])),
    );

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::STOP,
        Some(&json!({ "sessionId": "codex-live" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-live");
    assert_eq!(session["freshRelaunchAllowed"], Value::Null);
    assert!(
        session["restoreBlockedReason"]
            .as_str()
            .unwrap()
            .contains("2 possible resumable sessions")
    );
    cleanup(project);
}

#[test]
fn agent_kill_moves_session_to_graveyard_and_preserves_previous_status() {
    let project = temp_project("agent-kill");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::KILL,
        Some(&json!({ "sessionId": "codex-live", "reason": "done" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "graveyard");
    assert_eq!(response.body["previousStatus"], "running");
    assert_eq!(response.body["transition"]["operation"], "agent.kill");
    assert_eq!(runtime.killed, vec!["@agent"]);
    assert_eq!(get_prompt_context_text(&state_dir, "codex-live"), None);
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-live");
    assert_eq!(session["status"], "graveyard");
    assert_eq!(session["graveyardReason"], "done");
    assert!(session["graveyardedAt"].as_str().is_some());
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "node-agent")
    );
    cleanup(project);
}

#[test]
fn agent_kill_reports_tmux_kill_failure_without_graveyarding_session() {
    let project = temp_project("agent-kill-kill-failure");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        kill_window_error: Some("tmux server refused kill-window".into()),
        ..Default::default()
    };
    assert!(set_prompt_context(&state_dir, "codex-live", "form=event").is_some());

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::KILL,
        Some(&json!({ "sessionId": "codex-live", "reason": "done" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert!(response.body["error"].as_str().unwrap().contains(
        "tmux kill-window failed for session \"codex-live\": tmux server refused kill-window"
    ));
    assert_eq!(runtime.killed, vec!["@agent"]);
    let topology = read_topology(&state_dir);
    let current = session(&topology, "codex-live");
    assert_eq!(current["status"], "running");
    assert!(current["graveyardedAt"].is_null());
    assert!(current["graveyardReason"].is_null());
    assert_eq!(
        get_prompt_context_text(&state_dir, "codex-live"),
        Some("form=event".to_owned())
    );
    cleanup(project);
}

#[test]
fn agent_rename_updates_metadata_topology_and_live_window_name() {
    let project = temp_project("agent-rename");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RENAME,
        Some(&json!({ "sessionId": "codex-live", "label": "  Review lane  " })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["label"], "Review lane");
    assert_eq!(response.body["transition"]["operation"], "agent.rename");
    assert_eq!(
        runtime.renamed,
        vec![("@agent".into(), "Review lane".into())]
    );
    let topology = read_topology(&state_dir);
    assert_eq!(session(&topology, "codex-live")["label"], "Review lane");
    cleanup(project);
}

#[test]
fn record_backend_session_updates_metadata_and_topology() {
    let project = temp_project("backend-session");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::RECORD_BACKEND_SESSION,
        Some(&json!({ "sessionId": "codex-live", "backendSessionId": "backend-123" })),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["backendSessionId"], "backend-123");
    let topology = read_topology(&state_dir);
    assert_eq!(
        session(&topology, "codex-live")["backendSessionId"],
        "backend-123"
    );
    cleanup(project);
}

#[test]
fn agent_spawn_launches_tool_and_records_topology_metadata() {
    let project = temp_project("agent-spawn");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    let worktree = project.join("wt");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SPAWN,
        Some(&json!({
            "tool": "mock",
            "sessionId": "mock-new",
            "worktreePath": worktree,
            "extraArgs": ["--raw", "value"],
            "open": false,
            "launchOverride": {
                "command": "/bin/mock",
                "args": ["--base", "--fast"],
                "env": { "MOCK_ENV": "1" }
            }
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "mock-new");
    assert_eq!(runtime.created.len(), 1);
    assert_eq!(
        response.body["tmuxTarget"]["sessionName"],
        runtime.created[0].session_name
    );
    assert_eq!(response.body["tmuxTarget"]["windowId"], "@11");
    assert_eq!(response.body["tmuxTarget"]["windowIndex"], 11);
    assert_eq!(response.body["tmuxTarget"]["windowName"], "/bin/mock");
    assert!(response.body.get("warning").is_none());
    assert!(response.body.get("warnings").is_none());
    assert_eq!(response.body["transition"]["operation"], "agent.spawn");
    assert_eq!(runtime.created[0].name, "/bin/mock");
    assert_eq!(runtime.created[0].cwd, worktree.to_string_lossy());
    assert_eq!(runtime.created[0].command, "env");
    assert!(runtime.created[0].detached);
    assert!(
        runtime.created[0]
            .args
            .iter()
            .any(|arg| arg == "MOCK_ENV=1")
    );
    assert_eq!(runtime.metadata[0].1["sessionId"], "mock-new");
    assert_eq!(runtime.metadata[0].1["toolConfigKey"], "mock");
    assert_eq!(
        runtime.metadata[0].1["args"],
        json!(["--base", "--fast", "--raw", "value"])
    );
    let topology = read_topology(&state_dir);
    let session = session(&topology, "mock-new");
    assert_eq!(session["status"], "running");
    assert_eq!(session["toolConfigKey"], "mock");
    assert_eq!(session["worktreePath"], worktree.to_string_lossy().as_ref());
    cleanup(project);
}

#[test]
fn agent_spawn_warns_when_tool_lacks_exact_backend_resume() {
    let project = temp_project("agent-spawn-restore-warning");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SPAWN,
        Some(&json!({
            "tool": "mock-unresumable",
            "sessionId": "mock-unresumable-new",
            "open": false
        })),
        &mut runtime,
    )
    .unwrap();

    let warning = "agent tool \"mock-unresumable\" does not support exact backend resume; this session cannot be restored after an Aimux restart";
    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "mock-unresumable-new");
    assert_eq!(response.body["warning"], warning);
    assert_eq!(
        response.body["warnings"],
        json!([{ "kind": "restartRestore", "message": warning }])
    );
    assert_eq!(runtime.created.len(), 1);
    cleanup(project);
}

#[test]
fn agent_spawn_failure_records_dashboard_operation_failure() {
    let project = temp_project("agent-spawn-failure");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    let worktree = project.join("wt");
    let worktree_path = worktree.to_string_lossy().into_owned();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        create_window_error: Some("tmux failed to create window".into()),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SPAWN,
        Some(&json!({
            "tool": "mock",
            "sessionId": "mock-failed",
            "worktreePath": worktree_path.clone(),
            "open": false
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert_eq!(response.body["error"], "tmux failed to create window");
    let failures = list_dashboard_operation_failures(&state_dir);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["targetKind"], "agent");
    assert_eq!(failures[0]["operation"], "create");
    assert_eq!(failures[0]["targetId"], "mock-failed");
    assert_eq!(failures[0]["message"], "tmux failed to create window");
    assert_eq!(failures[0]["worktreePath"], worktree_path);
    cleanup(project);
}

#[test]
fn agent_spawn_tmux_command_failure_records_user_facing_redacted_error() {
    let project = temp_project("agent-spawn-tmux-redacted");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    let worktree = project.join("wt");
    let worktree_path = worktree.to_string_lossy().into_owned();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let raw_error = "Command failed: tmux new-window env -i OPENAI_API_KEY=fake-openai-token SECRET_TOKEN=fake-secret-token mock\nstderr detail";
    let expected = "tmux failed while updating the managed runtime.\nRun aimux restart if it does not recover automatically.";
    let mut runtime = FakeLifecycleRuntime {
        create_window_error: Some(raw_error.into()),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SPAWN,
        Some(&json!({
            "tool": "mock",
            "sessionId": "mock-failed-redacted",
            "worktreePath": worktree_path.clone(),
            "open": false
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert_eq!(response.body["error"], expected);
    assert!(
        !response.body["error"]
            .as_str()
            .unwrap()
            .contains("fake-openai-token")
    );
    assert!(
        !response.body["error"]
            .as_str()
            .unwrap()
            .contains("fake-secret-token")
    );
    let failures = list_dashboard_operation_failures(&state_dir);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["message"], expected);
    assert!(
        !failures[0]["message"]
            .as_str()
            .unwrap()
            .contains("fake-openai-token")
    );
    assert!(
        !failures[0]["message"]
            .as_str()
            .unwrap()
            .contains("fake-secret-token")
    );
    cleanup(project);
}

#[test]
fn agent_spawn_ordinary_failure_keeps_bounded_diagnostic_lines() {
    let project = temp_project("agent-spawn-ordinary-diagnostic");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let raw_error = "\n failed to create pseudo terminal \n\n retry refused \n";
    let expected = "failed to create pseudo terminal\nretry refused";
    let mut runtime = FakeLifecycleRuntime {
        create_window_error: Some(raw_error.into()),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SPAWN,
        Some(&json!({
            "tool": "mock",
            "sessionId": "mock-ordinary-failed",
            "open": false
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert_eq!(response.body["error"], expected);
    let failures = list_dashboard_operation_failures(&state_dir);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["message"], expected);
    cleanup(project);
}

#[test]
fn default_scribe_startup_launches_configured_agent_and_marks_project_control() {
    let project = temp_project("default-scribe-create");
    write_project_scribe_config(&project);
    let state_dir = project.join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = ensure_default_scribe_agent(&context, &mut runtime);

    assert_eq!(response["created"], true);
    assert_eq!(response["sessionId"], "mock-scribe");
    assert_eq!(response["toolConfigKey"], "mock");
    assert_eq!(runtime.created.len(), 1);
    assert_eq!(runtime.created[0].name, "/bin/mock");
    assert_eq!(runtime.created[0].cwd, project.to_string_lossy());
    assert!(runtime.created[0].detached);
    for expected in [
        "AIMUX_SCRIBE=1",
        "AIMUX_TOOL_DEFAULT=1",
        "AIMUX_TEST_SCRIBE=1",
    ] {
        assert!(
            runtime.created[0].args.iter().any(|arg| arg == expected),
            "missing launch env {expected:?} in {:?}",
            runtime.created[0].args
        );
    }
    assert!(
        runtime.created[0]
            .args
            .iter()
            .any(|arg| arg.contains("--base") && arg.contains("--mode") && arg.contains("scribe"))
    );
    let metadata = &runtime.metadata[0].1;
    assert_eq!(metadata["sessionId"], "mock-scribe");
    assert_eq!(metadata["scribe"], true);
    assert_eq!(metadata["projectControl"], true);
    assert_eq!(metadata["team"]["role"], "scribe");
    let saved = load_metadata_state(&state_dir);
    assert_eq!(
        saved.sessions["mock-scribe"]["scribe"], true,
        "default scribe marker is persisted"
    );
    let topology = read_topology(&state_dir);
    let session = session(&topology, "mock-scribe");
    assert_eq!(session["status"], "running");
    assert_eq!(session["team"]["role"], "scribe");
    cleanup(project);
}

#[test]
fn default_scribe_startup_keeps_existing_live_scribe_without_duplicate_window() {
    let project = temp_project("default-scribe-existing");
    write_project_scribe_config(&project);
    let state_dir = project.join("state");
    write_agent_resume_topology(
        &state_dir,
        json!({
            "id": "existing-scribe",
            "nodeId": "agent:existing-scribe",
            "status": "idle",
            "tool": "mock",
            "toolConfigKey": "mock",
            "command": "/bin/mock",
            "args": ["--base"],
            "team": { "teamId": "scribe", "parentSessionId": "", "role": "scribe" },
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = ensure_default_scribe_agent(&context, &mut runtime);

    assert_eq!(response["created"], false);
    assert_eq!(response["reason"], "existing");
    assert_eq!(response["sessionId"], "existing-scribe");
    assert!(runtime.created.is_empty());
    let saved = load_metadata_state(&state_dir);
    assert_eq!(saved.sessions["existing-scribe"]["scribe"], true);
    cleanup(project);
}

#[test]
fn default_scribe_startup_honors_disabled_configuration() {
    let project = temp_project("default-scribe-disabled");
    let aimux_dir = project.join(".aimux");
    fs::create_dir_all(&aimux_dir).unwrap();
    fs::write(
        aimux_dir.join("config.json"),
        serde_json::to_string_pretty(&json!({ "scribe": { "defaultAgent": null } })).unwrap(),
    )
    .unwrap();
    let state_dir = project.join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = ensure_default_scribe_agent(&context, &mut runtime);

    assert_eq!(response["created"], false);
    assert_eq!(response["reason"], "disabled");
    assert!(runtime.created.is_empty());
    cleanup(project);
}

#[test]
fn project_service_startup_repairs_legacy_tmux_session_names() {
    let project = temp_project("startup-repair-legacy-tmux");
    let aimux_dir = project.join(".aimux");
    fs::create_dir_all(&aimux_dir).unwrap();
    fs::write(
        aimux_dir.join("config.json"),
        serde_json::to_string_pretty(&json!({ "scribe": { "defaultAgent": null } })).unwrap(),
    )
    .unwrap();
    let state_dir = project.join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let startup = ProjectServiceStartup {
        project_id: "startup-repair-legacy-tmux".to_owned(),
        project_root: project.clone(),
        project_state_dir: state_dir.clone(),
        desired_port: 43_001,
    };
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    run_project_service_startup_tasks(&startup, &context, &mut runtime);

    assert_eq!(runtime.legacy_repairs, vec![project.clone()]);
    assert!(runtime.created.is_empty());
    cleanup(project);
}

#[test]
fn teammate_create_launches_agent_with_team_metadata_and_extra_args() {
    let project = temp_project("teammate-create");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let worktree = project.join("wt");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::CREATE_TEAMMATE,
        Some(&json!({
            "parentSessionId": "codex-live",
            "role": "reviewer",
            "label": "Review lane",
            "tool": "mock",
            "sessionId": "mock-reviewer",
            "worktreePath": worktree,
            "extraArgs": ["--fast"],
            "open": true,
            "order": 2
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "mock-reviewer");
    assert_eq!(response.body["parentSessionId"], "codex-live");
    assert_eq!(response.body["teamId"], "team-codex-live");
    assert_eq!(response.body["role"], "reviewer");
    assert_eq!(response.body["label"], "Review lane");
    assert_eq!(response.body["transition"]["operation"], "agent.spawn");
    assert_eq!(runtime.created.len(), 1);
    assert_eq!(runtime.created[0].name, "Review lane");
    assert!(!runtime.created[0].detached);
    let metadata = &runtime.metadata[0].1;
    assert_eq!(metadata["args"], json!(["--base", "--fast"]));
    assert_eq!(metadata["team"]["teamId"], "team-codex-live");
    assert_eq!(metadata["team"]["parentSessionId"], "codex-live");
    assert_eq!(metadata["team"]["role"], "reviewer");
    assert_eq!(metadata["team"]["label"], "Review lane");
    assert_eq!(metadata["team"]["order"], 2.0);
    let topology = read_topology(&state_dir);
    let session = session(&topology, "mock-reviewer");
    assert_eq!(session["team"]["parentSessionId"], "codex-live");
    assert_eq!(session["label"], "Review lane");
    assert_eq!(session["worktreePath"], worktree.to_string_lossy().as_ref());
    cleanup(project);
}

#[test]
fn teammate_create_rejects_nested_team_parent() {
    let project = temp_project("teammate-create-nested");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_teammate_parent_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::CREATE_TEAMMATE,
        Some(&json!({
            "parentSessionId": "codex-child",
            "tool": "mock",
            "sessionId": "mock-grandchild"
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 400);
    assert_eq!(
        response.body["error"],
        "teammate agents cannot create or delegate to nested teams"
    );
    assert!(runtime.created.is_empty());
    cleanup(project);
}

#[test]
fn teammate_create_with_initial_task_persists_task_and_thread() {
    let project = temp_project("teammate-create-task");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::CREATE_TEAMMATE,
        Some(&json!({
            "parentSessionId": "codex-live",
            "tool": "mock",
            "sessionId": "mock-worker",
            "initialTask": {
                "title": "Review the diff",
                "body": "Check the changed files\nand report issues."
            }
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["task"]["assignedBy"], "codex-live");
    assert_eq!(response.body["task"]["assignedTo"], "mock-worker");
    assert_eq!(response.body["task"]["description"], "Review the diff");
    assert_eq!(
        response.body["task"]["prompt"],
        "Check the changed files\nand report issues."
    );
    assert_eq!(response.body["thread"]["kind"], "task");
    let exchange: Value =
        serde_yaml::from_str(&std::fs::read_to_string(runtime_exchange_path(&state_dir)).unwrap())
            .unwrap();
    assert_eq!(exchange["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(exchange["threads"].as_array().unwrap().len(), 1);
    cleanup(project);
}

#[test]
fn teammate_create_initial_task_requires_prompt_or_body() {
    let project = temp_project("teammate-create-task-invalid");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::CREATE_TEAMMATE,
        Some(&json!({
            "parentSessionId": "codex-live",
            "tool": "mock",
            "sessionId": "mock-worker",
            "initialTask": { "title": "No prompt" }
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 400);
    assert_eq!(
        response.body["error"],
        "initialTask requires body or prompt"
    );
    assert!(runtime.created.is_empty());
    cleanup(project);
}

#[test]
fn teammate_stop_routes_through_agent_stop_with_parent_metadata() {
    let project = temp_project("teammate-stop");
    let state_dir = project.join("state");
    write_teammate_lifecycle_topology(&state_dir, "running", Some("backend-child"));
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::STOP_TEAMMATE,
        Some(&json!({
            "parentSessionId": "codex-parent",
            "teammateSessionId": "codex-child"
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["parentSessionId"], "codex-parent");
    assert_eq!(response.body["teammateSessionId"], "codex-child");
    assert_eq!(response.body["sessionId"], "codex-child");
    assert_eq!(response.body["status"], "offline");
    assert_eq!(response.body["transition"]["operation"], "agent.stop");
    assert_eq!(runtime.killed, vec!["@child"]);
    assert_eq!(
        session(&read_topology(&state_dir), "codex-child")["status"],
        "offline"
    );
    cleanup(project);
}

#[test]
fn teammate_resume_routes_through_agent_resume_with_parent_metadata() {
    let project = temp_project("teammate-resume");
    let state_dir = project.join("state");
    write_teammate_lifecycle_topology(&state_dir, "offline", Some("backend-child"));
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RESUME_TEAMMATE,
        Some(&json!({
            "parentSessionId": "codex-parent",
            "teammateSessionId": "codex-child"
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["parentSessionId"], "codex-parent");
    assert_eq!(response.body["teammateSessionId"], "codex-child");
    assert_eq!(response.body["sessionId"], "codex-child");
    assert_eq!(response.body["status"], "running");
    assert_eq!(response.body["transition"]["operation"], "agent.resume");
    assert_eq!(runtime.created.len(), 1);
    cleanup(project);
}

#[test]
fn teammate_kill_routes_through_agent_kill_with_parent_metadata() {
    let project = temp_project("teammate-kill");
    let state_dir = project.join("state");
    write_teammate_lifecycle_topology(&state_dir, "running", Some("backend-child"));
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::KILL_TEAMMATE,
        Some(&json!({
            "parentSessionId": "codex-parent",
            "teammateSessionId": "codex-child"
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["parentSessionId"], "codex-parent");
    assert_eq!(response.body["teammateSessionId"], "codex-child");
    assert_eq!(response.body["status"], "graveyard");
    assert_eq!(response.body["previousStatus"], "running");
    assert_eq!(response.body["transition"]["operation"], "agent.kill");
    assert_eq!(runtime.killed, vec!["@child"]);
    cleanup(project);
}

#[test]
fn teammate_resurrect_routes_through_graveyard_resurrect_with_parent_metadata() {
    let project = temp_project("teammate-resurrect");
    let state_dir = project.join("state");
    write_teammate_lifecycle_topology(&state_dir, "graveyard", Some("backend-child"));
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RESURRECT_TEAMMATE,
        Some(&json!({
            "parentSessionId": "codex-parent",
            "teammateSessionId": "codex-child"
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["parentSessionId"], "codex-parent");
    assert_eq!(response.body["teammateSessionId"], "codex-child");
    assert_eq!(response.body["sessionId"], "codex-child");
    assert_eq!(response.body["status"], "offline");
    assert_eq!(
        response.body["transition"]["operation"],
        "graveyard.agent.resurrect"
    );
    assert_eq!(
        session(&read_topology(&state_dir), "codex-child")["status"],
        "offline"
    );
    cleanup(project);
}

#[test]
fn agent_fork_creates_handoff_thread_and_native_fork_launch() {
    let project = temp_project("agent-fork");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_agent_resume_topology(
        &state_dir,
        json!({
            "id": "mock-source",
            "nodeId": "agent:mock-source",
            "status": "running",
            "tool": "mock",
            "command": "/bin/mock",
            "args": ["--base"],
            "backendSessionId": "backend-123",
            "worktreePath": "/repo/worktree",
            "label": "source lane",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::FORK,
        Some(&json!({
            "sourceSessionId": "mock-source",
            "tool": "mock",
            "targetSessionId": "mock-fork",
            "instruction": "carry this forward",
            "open": false
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "mock-fork");
    let thread_id = response.body["threadId"].as_str().unwrap();
    assert_eq!(response.body["transition"]["operation"], "agent.fork");
    assert!(
        runtime.created[0]
            .args
            .last()
            .is_some_and(|arg| arg.contains("'--fork' 'backend-123'"))
    );
    assert_eq!(runtime.metadata[0].1["args"], json!(["--base"]));
    let exchange: Value = serde_yaml::from_str(
        &std::fs::read_to_string(state_dir.join("runtime-exchange.yaml")).unwrap(),
    )
    .unwrap();
    assert!(
        exchange["threads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|thread| {
                thread["id"] == thread_id
                    && thread["kind"] == "handoff"
                    && thread["waitingOn"] == json!(["mock-fork"])
            })
    );
    assert!(
        exchange["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| {
                message["threadId"] == thread_id
                    && message["kind"] == "handoff"
                    && message["body"] == "carry this forward"
            })
    );
    cleanup(project);
}

#[test]
fn agent_fork_without_tool_uses_source_session_tool() {
    let project = temp_project("agent-fork-source-tool");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_agent_resume_topology(
        &state_dir,
        json!({
            "id": "mock-source",
            "nodeId": "agent:mock-source",
            "status": "running",
            "tool": "mock",
            "toolConfigKey": "mock",
            "command": "/bin/mock",
            "args": ["--base"],
            "backendSessionId": "backend-123",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::FORK,
        Some(&json!({
            "sourceSessionId": "mock-source",
            "targetSessionId": "mock-fork",
            "open": false
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "mock-fork");
    assert_eq!(response.body["tool"], "mock");
    assert!(
        runtime.created[0]
            .args
            .iter()
            .any(|arg| arg.contains("/bin/mock"))
    );
    assert!(
        runtime.created[0]
            .args
            .last()
            .is_some_and(|arg| arg.contains("'--fork' 'backend-123'"))
    );
    assert_eq!(runtime.metadata[0].1["toolConfigKey"], "mock");
    cleanup(project);
}

#[test]
fn agent_switch_tool_replaces_live_window_and_keeps_session_id() {
    let project = temp_project("agent-switch-tool");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SWITCH_TOOL,
        Some(&json!({
            "sessionId": "codex-live",
            "tool": "mock2",
            "instruction": "continue"
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "codex-live");
    assert_eq!(response.body["tool"], "mock2");
    assert_eq!(response.body["transition"]["operation"], "agent.switchTool");
    assert_eq!(runtime.killed, vec!["@agent"]);
    assert_eq!(runtime.created.len(), 1);
    assert_eq!(runtime.created[0].name, "/bin/mock2");
    assert_eq!(runtime.metadata[0].1["sessionId"], "codex-live");
    assert_eq!(runtime.metadata[0].1["toolConfigKey"], "mock2");
    assert_eq!(runtime.metadata[0].1["command"], "/bin/mock2");
    assert_eq!(runtime.metadata[0].1["args"], json!(["--next"]));
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-live");
    assert_eq!(session["status"], "running");
    assert_eq!(session["toolConfigKey"], "mock2");
    assert_eq!(session["command"], "/bin/mock2");
    cleanup(project);
}

#[test]
fn agent_migrate_relaunches_same_session_in_target_worktree_with_backend_resume() {
    let project = temp_project("agent-migrate-backend");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    let source_worktree = project.join("source");
    let target_worktree = project.join("target");
    write_agent_resume_topology(
        &state_dir,
        json!({
            "id": "mock-live",
            "nodeId": "legacy-node",
            "status": "running",
            "tool": "mockp",
            "toolConfigKey": "mockp",
            "command": "/bin/mockp",
            "args": ["--base-p", "--resume", "stale-backend"],
            "backendSessionId": "backend-123",
            "worktreePath": source_worktree,
            "label": "mock lane",
            "team": { "teamId": "team-1", "parentSessionId": "parent-1", "role": "reviewer" },
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    let mut topology = read_topology(&state_dir);
    topology["bindings"] = json!([{
        "id": "tmux:mock-live",
        "nodeId": "legacy-node",
        "tmuxSession": "aimux",
        "tmuxWindowId": "@old",
        "tmuxWindowIndex": 1,
        "tmuxWindowName": "mock",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    }]);
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::MIGRATE,
        Some(&json!({
            "sessionId": "mock-live",
            "worktreePath": target_worktree
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "mock-live");
    assert_eq!(
        response.body["worktreePath"],
        target_worktree.to_string_lossy().as_ref()
    );
    assert_eq!(response.body["transition"]["operation"], "agent.migrate");
    assert_eq!(runtime.killed, vec!["@old"]);
    assert_eq!(runtime.created.len(), 1);
    let created = &runtime.created[0];
    assert_eq!(created.name, "mock lane");
    assert_eq!(created.cwd, target_worktree.to_string_lossy());
    assert!(
        created
            .args
            .last()
            .is_some_and(|arg| arg.contains("'--resume' 'backend-123'"))
    );
    assert_eq!(runtime.metadata[0].1["sessionId"], "mock-live");
    assert_eq!(runtime.metadata[0].1["backendSessionId"], "backend-123");
    assert_eq!(runtime.metadata[0].1["args"], json!(["--base-p"]));
    assert_eq!(
        runtime.metadata[0].1["worktreePath"],
        target_worktree.to_string_lossy().as_ref()
    );
    assert_eq!(runtime.metadata[0].1["team"]["parentSessionId"], "parent-1");
    let topology = read_topology(&state_dir);
    let session = session(&topology, "mock-live");
    assert_eq!(session["status"], "running");
    assert_eq!(session["args"], json!(["--base-p"]));
    assert_eq!(
        session["worktreePath"],
        target_worktree.to_string_lossy().as_ref()
    );
    assert_eq!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|binding| binding["id"] == "tmux:mock-live")
            .unwrap()["tmuxWindowId"],
        "@11"
    );
    cleanup(project);
}

#[test]
fn agent_migrate_without_backend_uses_continuity_preamble_and_does_not_resume() {
    let project = temp_project("agent-migrate-no-backend");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    let source_worktree = project.join("source");
    let target_worktree = project.join("target");
    std::fs::create_dir_all(project.join(".aimux/context/mock-live")).unwrap();
    std::fs::write(
        project.join(".aimux/context/mock-live/live.md"),
        "recent terminal output\n",
    )
    .unwrap();
    write_agent_resume_topology(
        &state_dir,
        json!({
            "id": "mock-live",
            "nodeId": "agent:mock-live",
            "status": "running",
            "tool": "mockp",
            "toolConfigKey": "mockp",
            "command": "/bin/mockp",
            "args": ["--base-p", "--resume", "stale-backend"],
            "worktreePath": source_worktree,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    let mut topology = read_topology(&state_dir);
    topology["bindings"] = json!([{
        "id": "tmux:mock-live",
        "nodeId": "agent:mock-live",
        "tmuxSession": "aimux",
        "tmuxWindowId": "@old",
        "tmuxWindowIndex": 1,
        "tmuxWindowName": "mock",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    }]);
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::MIGRATE,
        Some(&json!({
            "sessionId": "mock-live",
            "worktreePath": target_worktree,
            "instruction": "finish the parser"
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(runtime.killed, vec!["@old"]);
    assert_eq!(runtime.created.len(), 1);
    let created = &runtime.created[0];
    assert_eq!(created.cwd, target_worktree.to_string_lossy());
    assert!(
        !created
            .args
            .last()
            .unwrap()
            .contains("'--resume' 'stale-backend'")
    );
    assert!(
        created
            .args
            .last()
            .is_some_and(|arg| arg.contains("This session was migrated from"))
    );
    assert!(
        created
            .args
            .last()
            .is_some_and(|arg| arg.contains("finish the parser"))
    );
    assert!(runtime.metadata[0].1.get("backendSessionId").is_none());
    assert_eq!(runtime.metadata[0].1["args"], json!(["--base-p"]));
    cleanup(project);
}

#[test]
fn service_stop_and_remove_update_topology_and_kill_live_window() {
    let project = temp_project("service");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let stopped = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::STOP,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(stopped.status, 200);
    assert_eq!(stopped.body["status"], "stopped");
    assert_eq!(stopped.body["transition"]["operation"], "service.stop");
    assert_eq!(runtime.killed, vec!["@service"]);
    let topology = read_topology(&state_dir);
    let stopped_service = service(&topology, "svc-web");
    assert_eq!(stopped_service["status"], "stopped");
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "node-service")
    );
    assert!(
        state_dir
            .join("shell-state-suppress")
            .join("svc-web")
            .exists()
    );
    let saved = read_state(&state_dir);
    assert_eq!(saved["cwd"], project.to_string_lossy().as_ref());
    assert_eq!(saved["services"][0]["id"], "svc-web");
    assert_eq!(saved["services"][0]["label"], "web");
    assert_eq!(saved["services"][0]["launchCommandLine"], "yarn dev");

    let removed = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::REMOVE,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(removed.status, 200);
    assert_eq!(removed.body["status"], "removed");
    assert_eq!(removed.body["transition"]["operation"], "service.remove");
    let topology = read_topology(&state_dir);
    assert!(find(&topology, "services", "svc-web").is_none());
    assert!(find(&topology, "nodes", "node-service").is_none());
    assert_eq!(read_state(&state_dir)["services"], json!([]));
    cleanup(project);
}

#[test]
fn agent_resume_launches_exact_backend_resume_and_updates_topology_metadata() {
    let project = temp_project("agent-resume");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_agent_resume_topology(
        &state_dir,
        json!({
            "id": "mock-offline",
            "nodeId": "agent:mock-offline",
            "status": "offline",
            "tool": "mock",
            "command": "/bin/mock",
            "args": ["--base", "--resume", "stale-backend"],
            "backendSessionId": "backend-123",
            "worktreePath": "/repo/worktree",
            "label": "mock lane",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    std::fs::write(
        state_dir.join("metadata.json"),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "sessions": {
                "mock-offline": {
                    "derived": { "activity": "running", "attention": "normal" }
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RESUME,
        Some(&json!({ "sessionId": "mock-offline" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "mock-offline");
    assert_eq!(response.body["status"], "running");
    assert_eq!(response.body["transition"]["operation"], "agent.resume");
    assert_eq!(runtime.ensured_sessions, vec![project.clone()]);
    assert_eq!(runtime.created.len(), 1);
    let created = &runtime.created[0];
    assert_eq!(created.name, "mock lane");
    assert_eq!(created.cwd, "/repo/worktree");
    assert_eq!(created.command, "env");
    assert!(
        created
            .args
            .iter()
            .any(|arg| arg == "AIMUX_SESSION_ID=mock-offline")
    );
    assert!(
        created
            .args
            .last()
            .is_some_and(|arg| arg.contains("'--resume' 'backend-123'"))
    );
    assert_eq!(runtime.cleared, vec!["@11"]);
    assert_eq!(runtime.metadata[0].0, "@11");
    assert_eq!(runtime.metadata[0].1["kind"], "agent");
    assert_eq!(runtime.metadata[0].1["sessionId"], "mock-offline");
    assert_eq!(runtime.metadata[0].1["toolConfigKey"], "mock");
    assert_eq!(runtime.metadata[0].1["backendSessionId"], "backend-123");
    assert_eq!(runtime.metadata[0].1["args"], json!(["--base"]));
    assert_eq!(
        runtime.options,
        vec![
            ("@11".into(), "@aimux-tool".into(), "mock".into()),
            ("@11".into(), "allow-passthrough".into(), "on".into()),
            ("@11".into(), "aggressive-resize".into(), "on".into())
        ]
    );

    let topology = read_topology(&state_dir);
    let session = session(&topology, "mock-offline");
    assert_eq!(session["status"], "running");
    assert_eq!(session["args"], json!(["--base"]));
    assert_eq!(session["backendSessionId"], "backend-123");
    assert_eq!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|binding| binding["nodeId"] == "agent:mock-offline")
            .unwrap()["tmuxWindowId"],
        "@11"
    );
    let metadata: Value =
        serde_json::from_str(&std::fs::read_to_string(state_dir.join("metadata.json")).unwrap())
            .unwrap();
    assert_eq!(
        metadata["sessions"]["mock-offline"]["derived"]["activity"],
        "idle"
    );
    cleanup(project);
}

#[test]
fn agent_resume_refuses_missing_exact_backend_resume() {
    let project = temp_project("agent-resume-refuse");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_agent_resume_topology(
        &state_dir,
        json!({
            "id": "mock-offline",
            "nodeId": "agent:mock-offline",
            "status": "offline",
            "tool": "mock",
            "command": "/bin/mock",
            "args": ["--base"],
            "worktreePath": "/repo/worktree",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RESUME,
        Some(&json!({ "sessionId": "mock-offline" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert!(
        response.body["error"]
            .as_str()
            .unwrap()
            .contains("without an exact resumable backend session id")
    );
    assert!(runtime.created.is_empty());
    cleanup(project);
}

#[test]
fn agent_restore_force_fresh_relaunches_without_backend_id() {
    let project = temp_project("agent-restore-fresh");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_agent_resume_topology(
        &state_dir,
        json!({
            "id": "mock-offline",
            "nodeId": "agent:mock-offline",
            "status": "offline",
            "tool": "mock",
            "command": "/bin/mock",
            "args": ["--base", "--resume", "stale-backend"],
            "worktreePath": "/repo/worktree",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RESUME,
        Some(&json!({ "sessionId": "mock-offline", "fresh": true })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "mock-offline");
    assert_eq!(response.body["status"], "running");
    assert_eq!(response.body["transition"]["operation"], "agent.restore");
    assert_eq!(runtime.ensured_sessions, vec![project.clone()]);
    assert_eq!(runtime.created.len(), 1);
    let created = &runtime.created[0];
    assert_eq!(created.cwd, "/repo/worktree");
    assert_eq!(created.command, "env");
    assert!(
        created
            .args
            .last()
            .is_some_and(|arg| !arg.contains("--resume") && !arg.contains("stale-backend"))
    );
    assert_eq!(runtime.metadata[0].1["backendSessionId"], Value::Null);
    assert_eq!(runtime.metadata[0].1["args"], json!(["--base"]));
    let topology = read_topology(&state_dir);
    let session = session(&topology, "mock-offline");
    assert_eq!(session["status"], "running");
    assert_eq!(session["backendSessionId"], Value::Null);
    assert_eq!(session["args"], json!(["--base"]));
    cleanup(project);
}

#[test]
fn agent_resume_fresh_relaunch_clears_error_metadata_without_backend_id() {
    let project = temp_project("agent-resume-fresh");
    write_project_tool_config(&project);
    let state_dir = project.join("state");
    write_agent_resume_topology(
        &state_dir,
        json!({
            "id": "mock-error",
            "nodeId": "agent:mock-error",
            "status": "offline",
            "tool": "mock",
            "command": "/bin/mock",
            "args": ["--base"],
            "freshRelaunchAllowed": true,
            "worktreePath": "/repo/worktree",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    std::fs::write(
        state_dir.join("metadata.json"),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "sessions": {
                "mock-error": {
                    "status": "error",
                    "progress": "failed",
                    "derived": { "activity": "error", "attention": "error" }
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RESUME,
        Some(&json!({ "sessionId": "mock-error" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(runtime.metadata[0].1["backendSessionId"], Value::Null);
    assert_eq!(runtime.metadata[0].1["args"], json!(["--base"]));
    let metadata: Value =
        serde_json::from_str(&std::fs::read_to_string(state_dir.join("metadata.json")).unwrap())
            .unwrap();
    assert!(metadata["sessions"]["mock-error"].get("derived").is_none());
    assert!(metadata["sessions"]["mock-error"].get("status").is_none());
    assert!(metadata["sessions"]["mock-error"].get("progress").is_none());
    cleanup(project);
}

#[test]
fn service_create_launches_detached_window_with_metadata_policy_and_topology() {
    let project = temp_project("service-create");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::CREATE,
        Some(&json!({
            "serviceId": "svc-dev",
            "command": "yarn dev",
            "worktreePath": "/repo/apps/web"
        })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["serviceId"], "svc-dev");
    assert_eq!(response.body["status"], "running");
    assert_eq!(response.body["transition"]["operation"], "service.create");
    assert_eq!(runtime.ensured_sessions, vec![project.clone()]);
    assert_eq!(runtime.created.len(), 1);
    let created = &runtime.created[0];
    assert_eq!(created.name, "yarn");
    assert_eq!(created.cwd, "/repo/apps/web");
    assert_eq!(created.command, "env");
    assert!(created.detached);
    assert!(
        created
            .args
            .iter()
            .any(|arg| arg == "AIMUX_SESSION_ID=svc-dev")
    );
    assert!(created.args.iter().any(|arg| arg == "AIMUX_TOOL=service"));
    assert!(created.args.iter().any(|arg| arg == "-ic"));
    assert!(
        created
            .args
            .last()
            .is_some_and(|arg| arg.contains("Service command exited with status"))
    );
    assert!(expected_shell_rc_path(&state_dir).exists());
    assert_eq!(runtime.metadata[0].0, "@11");
    assert_eq!(runtime.metadata[0].1["kind"], "service");
    assert_eq!(runtime.metadata[0].1["sessionId"], "svc-dev");
    assert_eq!(runtime.metadata[0].1["args"], json!(["-lc", "yarn dev"]));
    assert_eq!(
        runtime.options,
        vec![
            ("@11".into(), "@aimux-tool".into(), "service".into()),
            ("@11".into(), "allow-passthrough".into(), "on".into()),
            ("@11".into(), "aggressive-resize".into(), "on".into())
        ]
    );

    let topology = read_topology(&state_dir);
    let service = service(&topology, "svc-dev");
    assert_eq!(service["status"], "running");
    assert_eq!(service["command"], runtime.metadata[0].1["command"]);
    assert_eq!(service["args"], json!(["-lc", "yarn dev"]));
    assert_eq!(service["launchCommandLine"], "yarn dev");
    assert_eq!(service["worktreePath"], "/repo/apps/web");
    assert_eq!(
        find(&topology, "nodes", "service:svc-dev").unwrap()["label"],
        "yarn"
    );
    let binding = topology["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|binding| binding["nodeId"] == "service:svc-dev")
        .unwrap();
    assert_eq!(binding["tmuxWindowId"], "@11");
    let saved = read_state(&state_dir);
    assert_eq!(saved["services"][0]["id"], "svc-dev");
    assert_eq!(saved["services"][0]["cwd"], "/repo/apps/web");
    assert_eq!(saved["services"][0]["label"], "yarn");
    assert_eq!(saved["services"][0]["tmuxTarget"]["windowId"], "@11");
    cleanup(project);
}

#[test]
fn service_resume_recreates_stopped_service_from_persisted_launch_state() {
    let project = temp_project("service-resume");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();
    let stopped = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::STOP,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(stopped.status, 200);
    runtime.killed.clear();

    let resumed = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::RESUME,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(resumed.status, 200);
    assert_eq!(resumed.body["serviceId"], "svc-web");
    assert_eq!(resumed.body["status"], "running");
    assert_eq!(resumed.body["transition"]["operation"], "service.resume");
    assert_eq!(runtime.ensured_sessions, vec![project.clone()]);
    assert_eq!(runtime.created.len(), 1);
    let created = &runtime.created[0];
    assert_eq!(created.name, "web");
    assert_eq!(created.cwd, "/repo");
    assert_eq!(created.command, "env");
    assert!(
        created
            .args
            .last()
            .is_some_and(|arg| arg.contains("Service command exited with status"))
    );
    assert_eq!(
        runtime.metadata[0].1["createdAt"],
        "2026-01-01T00:00:00.000Z"
    );
    assert!(runtime.killed.is_empty());
    let topology = read_topology(&state_dir);
    let service = service(&topology, "svc-web");
    assert_eq!(service["status"], "running");
    assert_eq!(service["createdAt"], "2026-01-01T00:00:00.000Z");
    assert_eq!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|binding| binding["nodeId"] == "service:svc-web")
            .unwrap()["tmuxWindowId"],
        "@11"
    );
    let saved = read_state(&state_dir);
    assert_eq!(saved["services"][0]["id"], "svc-web");
    assert_eq!(saved["services"][0]["cwd"], "/repo");
    assert_eq!(saved["services"][0]["tmuxTarget"]["windowId"], "@11");
    cleanup(project);
}

#[test]
fn service_lifecycle_status_surfaces_in_gui_read_models() {
    let project = temp_project("service-gui-status");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    move_fixture_service_to_project_root(&state_dir, &project);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    assert_gui_service_status(&context, "svc-web", "running");

    let stopped = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::STOP,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(stopped.status, 200);
    assert_eq!(stopped.body["status"], "stopped");
    assert_gui_service_status(&context, "svc-web", "exited");

    let resumed = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::RESUME,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(resumed.status, 200);
    assert_eq!(resumed.body["status"], "running");
    assert_gui_service_status(&context, "svc-web", "running");

    let removed = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::REMOVE,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(removed.status, 200);
    assert_eq!(removed.body["status"], "removed");
    assert_gui_service_absent(&context, "svc-web");
    cleanup(project);
}

#[test]
fn service_resume_kills_stale_retained_binding_before_recreate() {
    let project = temp_project("service-resume-stale");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let mut topology = read_topology(&state_dir);
    topology["services"].as_array_mut().unwrap()[0]["status"] = json!("stopped");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::RESUME,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(runtime.killed, vec!["@service"]);
    let topology = read_topology(&state_dir);
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "node-service")
    );
    assert!(find(&topology, "nodes", "node-service").is_none());
    assert_eq!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|binding| binding["nodeId"] == "service:svc-web")
            .unwrap()["tmuxWindowId"],
        "@11"
    );
    cleanup(project);
}

#[test]
fn service_remove_kills_retained_saved_target_for_stopped_service() {
    let project = temp_project("service-remove-retained");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let mut topology = read_topology(&state_dir);
    topology["services"].as_array_mut().unwrap()[0]["status"] = json!("stopped");
    topology["bindings"]
        .as_array_mut()
        .unwrap()
        .retain(|binding| binding["nodeId"] != "node-service");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("state.json"),
        serde_json::to_string_pretty(&json!({
            "savedAt": "2026-01-01T00:00:00.000Z",
            "cwd": "/repo",
            "services": [{
                "id": "svc-web",
                "label": "web",
                "launchCommandLine": "yarn dev",
                "tmuxTarget": {
                    "sessionName": "aimux",
                    "windowId": "@retained",
                    "windowIndex": 2,
                    "windowName": "web"
                }
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        existing_windows: vec!["@retained".to_owned()],
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::REMOVE,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(runtime.killed, vec!["@retained"]);
    assert_eq!(read_state(&state_dir)["services"], json!([]));
    cleanup(project);
}

#[test]
fn service_remove_ignores_retained_saved_target_when_window_is_absent() {
    let project = temp_project("service-remove-retained-absent");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let mut topology = read_topology(&state_dir);
    topology["services"].as_array_mut().unwrap()[0]["status"] = json!("stopped");
    topology["bindings"]
        .as_array_mut()
        .unwrap()
        .retain(|binding| binding["nodeId"] != "node-service");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("state.json"),
        serde_json::to_string_pretty(&json!({
            "savedAt": "2026-01-01T00:00:00.000Z",
            "cwd": "/repo",
            "services": [{
                "id": "svc-web",
                "label": "web",
                "launchCommandLine": "yarn dev",
                "tmuxTarget": {
                    "sessionName": "aimux",
                    "windowId": "@retained",
                    "windowIndex": 2,
                    "windowName": "web"
                }
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::REMOVE,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert!(runtime.killed.is_empty());
    assert_eq!(read_state(&state_dir)["services"], json!([]));
    cleanup(project);
}

#[test]
fn graveyard_agent_resurrect_restores_offline_and_clears_graveyard_state() {
    let project = temp_project("graveyard-agent-resurrect");
    let state_dir = project.join("state");
    let worktree = project.join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    write_graveyard_agent_topology(&state_dir, &worktree, false);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::RESURRECT_AGENT,
        Some(&json!({ "sessionId": "codex-old" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "codex-old");
    assert_eq!(response.body["status"], "offline");
    assert_eq!(
        response.body["transition"]["operation"],
        "graveyard.agent.resurrect"
    );
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-old");
    assert_eq!(session["status"], "offline");
    assert!(session.get("graveyardedAt").is_none());
    assert!(session.get("graveyardReason").is_none());
    assert!(session.get("restoreBlockedReason").is_none());
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "node-old")
    );
    cleanup(project);
}

#[test]
fn graveyard_agent_resurrect_routes_through_project_service_router() {
    let project = temp_project("graveyard-agent-router-resurrect");
    let state_dir = project.join("state");
    let worktree = project.join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    write_graveyard_agent_topology(&state_dir, &worktree, false);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::graveyard_actions::RESURRECT_AGENT,
        Some(&json!({ "id": "codex-old" })),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["sessionId"], "codex-old");
    assert_eq!(response.body["status"], "offline");
    assert_eq!(
        response.body["transition"]["operation"],
        "graveyard.agent.resurrect"
    );
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-old");
    assert_eq!(session["status"], "offline");
    assert!(session.get("graveyardedAt").is_none());
    assert!(session.get("graveyardReason").is_none());
    assert!(session.get("restoreBlockedReason").is_none());
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "node-old")
    );
    cleanup(project);
}

#[test]
fn graveyard_agent_resurrect_rejects_missing_active_worktree() {
    let project = temp_project("graveyard-agent-missing-worktree");
    let state_dir = project.join("state");
    let worktree = project.join("missing");
    write_graveyard_agent_topology(&state_dir, &worktree, false);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::RESURRECT_AGENT,
        Some(&json!({ "id": "codex-old" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert!(
        response.body["error"]
            .as_str()
            .unwrap()
            .contains("restore the worktree first")
    );
    assert_eq!(
        session(&read_topology(&state_dir), "codex-old")["status"],
        "graveyard"
    );
    cleanup(project);
}

#[test]
fn graveyard_agent_resurrect_allows_missing_graveyarded_worktree() {
    let project = temp_project("graveyard-agent-graveyarded-worktree");
    let state_dir = project.join("state");
    let worktree = project.join("missing-graveyarded");
    write_graveyard_agent_topology(&state_dir, &worktree, true);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::RESURRECT_AGENT,
        Some(&json!({ "sessionId": "codex-old" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(
        session(&read_topology(&state_dir), "codex-old")["status"],
        "offline"
    );
    cleanup(project);
}

#[test]
fn worktree_create_runs_git_and_persists_active_topology_entry() {
    let project = temp_project("worktree-create");
    let state_dir = project.join("state");
    write_worktree_create_topology(&state_dir, json!([]));
    let expected_path = project
        .join(".aimux/worktrees/demo")
        .to_string_lossy()
        .into_owned();
    let project_root = project.to_string_lossy().into_owned();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        main_repo: Some(project_root.clone()),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::CREATE,
        Some(&json!({ "name": "demo" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "created");
    assert_eq!(response.body["path"], expected_path);
    assert_eq!(response.body["transition"]["operation"], "worktree.create");
    assert_eq!(
        runtime.worktrees_created,
        vec![FakeCreateWorktree {
            main_repo: project_root.clone(),
            name: "demo".into(),
            target_path: expected_path.clone(),
        }]
    );
    let topology = read_topology(&state_dir);
    let worktree = &topology["worktrees"][0];
    assert_eq!(worktree["path"], expected_path);
    assert_eq!(worktree["name"], "demo");
    assert_eq!(worktree["branch"], "demo");
    assert_eq!(worktree["basePath"], project_root);
    assert_eq!(worktree["status"], "active");
    assert!(worktree.get("operationFailure").is_none());
    cleanup(project);
}

#[test]
fn worktree_create_rejects_existing_non_pending_worktree() {
    let project = temp_project("worktree-create-duplicate");
    let state_dir = project.join("state");
    let target_path = project.join(".aimux/worktrees/demo");
    write_worktree_create_topology(
        &state_dir,
        json!([{
            "id": "wt-demo",
            "rigId": "rig-1",
            "path": target_path.to_string_lossy().as_ref(),
            "name": "demo",
            "branch": "demo",
            "status": "active",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }]),
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        main_repo: Some(project.to_string_lossy().into_owned()),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::CREATE,
        Some(&json!({ "name": "demo" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert_eq!(response.body["error"], "Worktree \"demo\" already exists");
    assert!(runtime.worktrees_created.is_empty());
    assert_eq!(
        read_topology(&state_dir)["worktrees"][0]["status"],
        "active"
    );
    let failures = list_dashboard_operation_failures(&state_dir);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["targetKind"], "worktree");
    assert_eq!(failures[0]["operation"], "create");
    assert_eq!(failures[0]["message"], "Worktree \"demo\" already exists");
    assert_eq!(
        failures[0]["worktreePath"],
        target_path.to_string_lossy().as_ref()
    );
    cleanup(project);
}

#[test]
fn worktree_create_returns_creating_for_existing_pending_entry() {
    let project = temp_project("worktree-create-pending");
    let state_dir = project.join("state");
    let target_path = project.join(".aimux/worktrees/demo");
    let target_path_string = target_path.to_string_lossy().into_owned();
    write_worktree_create_topology(
        &state_dir,
        json!([{
            "id": "wt-demo",
            "rigId": "rig-1",
            "path": target_path_string,
            "name": "demo",
            "branch": "demo",
            "status": "creating",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }]),
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        main_repo: Some(project.to_string_lossy().into_owned()),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::CREATE,
        Some(&json!({ "name": "demo" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "creating");
    assert_eq!(
        response.body["path"],
        target_path.to_string_lossy().as_ref()
    );
    assert!(runtime.worktrees_created.is_empty());
    assert_eq!(
        read_topology(&state_dir)["worktrees"][0]["status"],
        "creating"
    );
    cleanup(project);
}

#[test]
fn worktree_create_failure_persists_error_topology_entry() {
    let project = temp_project("worktree-create-failure");
    let state_dir = project.join("state");
    write_worktree_create_topology(&state_dir, json!([]));
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        main_repo: Some(project.to_string_lossy().into_owned()),
        create_worktree_error: Some("fatal: branch failed".into()),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::CREATE,
        Some(&json!({ "name": "demo" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert_eq!(response.body["error"], "fatal: branch failed");
    assert_eq!(runtime.worktrees_created.len(), 1);
    let topology = read_topology(&state_dir);
    assert_eq!(topology["worktrees"][0]["status"], "error");
    assert_eq!(
        topology["worktrees"][0]["operationFailure"],
        "fatal: branch failed"
    );
    let failures = list_dashboard_operation_failures(&state_dir);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["targetKind"], "worktree");
    assert_eq!(failures[0]["operation"], "create");
    assert_eq!(failures[0]["message"], "fatal: branch failed");
    cleanup(project);
}

#[test]
fn worktree_cache_cleanup_dry_run_plans_targets_and_skips_protected_worktrees() {
    let project = temp_project("worktree-cache-cleanup-plan");
    std::fs::create_dir_all(&project).unwrap();
    let state_dir = project.join("state");
    let cold = project.join(".aimux/worktrees/cold");
    let active = project.join(".aimux/worktrees/active");
    let outside = project.join("manual");
    std::fs::create_dir_all(cold.join("node_modules/pkg")).unwrap();
    std::fs::create_dir_all(cold.join("apps/web/.next/cache")).unwrap();
    std::fs::create_dir_all(cold.join(".git/node_modules")).unwrap();
    std::fs::create_dir_all(active.join("node_modules")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(cold.join("node_modules/pkg/index.js"), "module").unwrap();
    std::fs::write(cold.join("apps/web/.next/cache/blob"), "cache").unwrap();
    std::fs::write(cold.join(".git/node_modules/ignored"), "ignored").unwrap();
    std::fs::write(active.join("node_modules/live.js"), "live").unwrap();
    write_cache_cleanup_topology(&state_dir, &project, &cold, &active, &outside);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        main_repo: Some(project.to_string_lossy().into_owned()),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::CACHE_CLEANUP,
        Some(&json!({ "dryRun": true, "includeActive": false })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    let result = &response.body["result"];
    assert_eq!(result["dryRun"], true);
    assert_eq!(result["plan"]["dryRun"], true);
    assert_eq!(result["plan"]["includeActive"], false);
    assert_eq!(
        result["plan"]["cacheDirNames"],
        json!(["node_modules", ".next"])
    );
    let mut relative_paths = result["plan"]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|target| target["relativePath"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    relative_paths.sort();
    assert_eq!(relative_paths, vec!["apps/web/.next", "node_modules"]);
    assert!(
        result["plan"]["targets"]
            .as_array()
            .unwrap()
            .iter()
            .all(|target| !target["path"].as_str().unwrap().contains("/.git/"))
    );
    let skipped = result["plan"]["skipped"].as_array().unwrap();
    assert!(
        skipped
            .iter()
            .any(|entry| entry["reason"] == "main-worktree")
    );
    assert!(
        skipped
            .iter()
            .any(|entry| entry["reason"] == "outside-aimux-worktrees")
    );
    let active_skip = skipped
        .iter()
        .find(|entry| entry["reason"] == "active-runtime")
        .unwrap();
    assert_eq!(active_skip["sessions"], json!(["agent-active"]));
    assert_eq!(active_skip["services"], json!(["svc-active"]));
    assert!(
        result["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "dry-run")
    );
    assert!(cold.join("node_modules").exists());
    assert!(cold.join("apps/web/.next").exists());
    cleanup(project);
}

#[test]
fn worktree_cache_cleanup_apply_removes_validated_cache_targets() {
    let project = temp_project("worktree-cache-cleanup-apply");
    std::fs::create_dir_all(&project).unwrap();
    let state_dir = project.join("state");
    let cold = project.join(".aimux/worktrees/cold");
    std::fs::create_dir_all(cold.join("node_modules/pkg")).unwrap();
    std::fs::write(cold.join("node_modules/pkg/index.js"), "module").unwrap();
    write_cache_cleanup_single_worktree_topology(&state_dir, &project, &cold);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        main_repo: Some(project.to_string_lossy().into_owned()),
        ..Default::default()
    };

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::CACHE_CLEANUP,
        Some(&json!({ "dryRun": false, "includeActive": true })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    let result = &response.body["result"];
    assert_eq!(result["dryRun"], false);
    assert_eq!(result["results"][0]["status"], "removed");
    assert!(result["reclaimedBytes"].as_u64().unwrap() > 0);
    assert!(!cold.join("node_modules").exists());
    cleanup(project);
}

#[test]
fn agent_restore_previous_without_offer_returns_not_accepted() {
    let project = temp_project("restore-previous-none");
    let state_dir = project.join("state");
    write_restore_previous_topology(&state_dir, &project);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_live_window_ids(["@stale"]);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RESTORE_PREVIOUS,
        Some(&json!({})),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["accepted"], false);
    assert_eq!(response.body["total"], 0);
    assert!(runtime.created.is_empty());
    cleanup(project);
}

#[test]
fn agent_restore_previous_reconciles_offer_restores_ready_sessions_and_writes_retry_offer() {
    let project = temp_project("restore-previous-accepted");
    std::fs::create_dir_all(&project).unwrap();
    let aimux_home = project.join("aimux-home");
    let state_dir = aimux_home
        .join("projects")
        .join(aimux::paths::compute_project_id(&project));
    write_restore_previous_topology(&state_dir, &project);
    write_restore_previous_offer_and_gate(&aimux_home, &state_dir, &project);
    // codex-stale still holds a live window, so it is genuinely running and
    // must not be offered back; the other two are restorable.
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_live_window_ids(["@stale"]);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RESTORE_PREVIOUS,
        Some(&json!({})),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["accepted"], true);
    assert_eq!(response.body["total"], 2);
    assert_eq!(response.body["restored"][0]["sessionId"], "codex-ready");
    assert_eq!(response.body["restored"][0]["status"], "running");
    assert_eq!(response.body["failed"][0]["sessionId"], "codex-blocked");
    assert!(
        response.body["failed"][0]["error"]
            .as_str()
            .unwrap()
            .contains("without an exact resumable backend session id")
    );
    assert_eq!(response.body["transitions"].as_array().unwrap().len(), 2);
    assert!(
        response.body["transitions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|transition| transition["operation"] == "agent.restore"
                && transition["phase"] == "queued")
    );
    assert_eq!(runtime.created.len(), 1);
    assert_eq!(runtime.created[0].name, "codex");
    let ack: Value = serde_json::from_str(
        &std::fs::read_to_string(state_dir.join("agent-restore-offer-ack.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(ack["snapshotId"], "snapshot-old");
    let retry: Value = serde_json::from_str(
        &std::fs::read_to_string(state_dir.join("agent-restore-offer.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(retry["sessionIds"], json!(["codex-blocked"]));
    assert_eq!(
        retry["worktreeGroups"],
        json!([{ "name": "Main Checkout", "count": 1 }])
    );
    cleanup(project);
}

#[test]
fn agent_restore_previous_dismiss_acknowledges_and_removes_offer() {
    let project = temp_project("restore-previous-dismiss");
    let state_dir = project.join("state");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("agent-restore-offer.json"),
        json!({
            "version": 1,
            "id": "restore-snapshot-old",
            "snapshotId": "snapshot-old",
            "snapshotUpdatedAt": "2026-01-01T00:00:00.000Z",
            "createdAt": "2026-01-01T00:00:01.000Z",
            "updatedAt": "2026-01-01T00:00:01.000Z",
            "sessions": [{ "id": "codex-ready", "command": "codex" }]
        })
        .to_string(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::DISMISS_RESTORE_PREVIOUS,
        Some(&json!({})),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true }));
    assert!(!state_dir.join("agent-restore-offer.json").exists());
    let ack: Value = serde_json::from_str(
        &std::fs::read_to_string(state_dir.join("agent-restore-offer-ack.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(ack["snapshotId"], "snapshot-old");
    cleanup(project);
}

#[test]
fn worktree_graveyard_stops_services_and_moves_topology_entry() {
    let project = temp_project("worktree-graveyard");
    let state_dir = project.join("state");
    let worktree = project.join("wt");
    write_active_worktree_topology(&state_dir, &worktree, false);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::GRAVEYARD,
        Some(&json!({ "path": worktree })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "graveyarded");
    assert_eq!(
        response.body["transition"]["operation"],
        "worktree.graveyard"
    );
    assert_eq!(runtime.killed, vec!["@service"]);
    let topology = read_topology(&state_dir);
    assert_eq!(topology["worktrees"][0]["status"], "graveyard");
    assert!(topology["worktrees"][0]["removedAt"].as_str().is_some());
    assert_eq!(topology["worktreeGraveyard"][0]["reason"], "user-requested");
    assert_eq!(topology["services"][0]["status"], "stopped");
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "service:svc-web")
    );
    cleanup(project);
}

#[test]
fn worktree_graveyard_rejects_attached_live_agent() {
    let project = temp_project("worktree-graveyard-attached");
    let state_dir = project.join("state");
    let worktree = project.join("wt");
    write_active_worktree_topology(&state_dir, &worktree, true);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::GRAVEYARD,
        Some(&json!({ "path": worktree })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert!(
        response.body["error"]
            .as_str()
            .unwrap()
            .contains("while agent \"active agent\" is attached")
    );
    assert!(runtime.killed.is_empty());
    assert_eq!(
        read_topology(&state_dir)["worktrees"][0]["status"],
        "active"
    );
    cleanup(project);
}

#[test]
fn worktree_remove_in_non_git_project_returns_shared_checkout_message() {
    let project = temp_plain_project("worktree-remove-non-git");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();
    let path = project.join(".aimux/worktrees/demo");
    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::REMOVE,
        Some(&json!({ "path": path })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert_eq!(
        response.body["error"],
        format!(
            "{} is not a git repository. Run `git init` first, or cd into a repo.",
            project.display()
        )
    );
    assert!(runtime.killed.is_empty());
    cleanup(project);
}

#[test]
fn worktree_remove_missing_checkout_removes_topology_and_stops_services() {
    let project = temp_project("worktree-remove");
    let state_dir = project.join("state");
    let worktree = project.join("missing");
    write_active_worktree_topology(&state_dir, &worktree, false);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::REMOVE,
        Some(&json!({ "path": worktree })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "removed");
    assert_eq!(response.body["transition"]["operation"], "worktree.remove");
    assert_eq!(runtime.killed, vec!["@service"]);
    let topology = read_topology(&state_dir);
    assert_eq!(topology["worktrees"], json!([]));
    assert_eq!(topology["services"], json!([]));
    assert_eq!(topology["nodes"], json!([]));
    cleanup(project);
}

#[test]
fn worktree_remove_rejects_attached_live_agent() {
    let project = temp_project("worktree-remove-attached");
    let state_dir = project.join("state");
    let worktree = project.join("wt");
    write_active_worktree_topology(&state_dir, &worktree, true);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::worktree_actions::REMOVE,
        Some(&json!({ "path": worktree })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert!(
        response.body["error"]
            .as_str()
            .unwrap()
            .contains("while agent \"active agent\" is attached")
    );
    assert!(runtime.killed.is_empty());
    assert_eq!(
        read_topology(&state_dir)["worktrees"][0]["status"],
        "active"
    );
    cleanup(project);
}

#[test]
fn graveyard_worktree_resurrect_restores_active_topology_entry() {
    let project = temp_project("worktree-resurrect");
    let state_dir = project.join("state");
    let worktree = project.join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    write_graveyard_worktree_topology(&state_dir, &worktree);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::RESURRECT_WORKTREE,
        Some(&json!({ "path": worktree })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "active");
    assert_eq!(
        response.body["transition"]["operation"],
        "graveyard.worktree.resurrect"
    );
    let topology = read_topology(&state_dir);
    assert_eq!(topology["worktrees"][0]["status"], "active");
    assert!(topology["worktrees"][0].get("removedAt").is_none());
    assert_eq!(topology["worktreeGraveyard"], json!([]));
    cleanup(project);
}

#[test]
fn graveyard_worktree_resurrect_rejects_missing_checkout() {
    let project = temp_project("worktree-resurrect-missing");
    let state_dir = project.join("state");
    let worktree = project.join("missing");
    write_graveyard_worktree_topology(&state_dir, &worktree);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::RESURRECT_WORKTREE,
        Some(&json!({ "path": worktree })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 500);
    assert!(
        response.body["error"]
            .as_str()
            .unwrap()
            .contains("checkout is missing")
    );
    cleanup(project);
}

#[test]
fn graveyard_worktree_delete_removes_dependents_assets_and_marks_entry_deleted() {
    let project = temp_project("worktree-delete");
    let state_dir = project.join("state");
    let worktree = project.join("missing");
    write_graveyard_worktree_with_dependents_topology(&state_dir, &worktree);
    let context_dir = project.join(".aimux/context/codex-old");
    std::fs::create_dir_all(&context_dir).unwrap();
    std::fs::create_dir_all(project.join(".aimux/recordings")).unwrap();
    std::fs::create_dir_all(project.join(".aimux/history")).unwrap();
    std::fs::create_dir_all(project.join(".aimux/plans")).unwrap();
    std::fs::create_dir_all(project.join(".aimux/status")).unwrap();
    std::fs::create_dir_all(state_dir.join("claude-settings")).unwrap();
    std::fs::write(context_dir.join("live.md"), "live\n").unwrap();
    std::fs::write(project.join(".aimux/recordings/codex-old.log"), "raw\n").unwrap();
    std::fs::write(project.join(".aimux/recordings/codex-old.txt"), "text\n").unwrap();
    std::fs::write(project.join(".aimux/history/codex-old.jsonl"), "{}\n").unwrap();
    std::fs::write(project.join(".aimux/plans/codex-old.md"), "# plan\n").unwrap();
    std::fs::write(project.join(".aimux/status/codex-old.md"), "status\n").unwrap();
    std::fs::write(state_dir.join("claude-settings/codex-old.json"), "{}\n").unwrap();
    std::fs::write(
        state_dir.join("metadata.json"),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "sessions": {
                "codex-old": { "updatedAt": "2026-01-01T00:00:00.000Z" }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::DELETE_WORKTREE,
        Some(&json!({ "path": worktree })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "removed");
    assert_eq!(
        response.body["transition"]["operation"],
        "graveyard.worktree.delete"
    );
    let topology = read_topology(&state_dir);
    assert_eq!(topology["worktrees"], json!([]));
    assert_eq!(topology["sessions"], json!([]));
    assert_eq!(topology["services"], json!([]));
    assert_eq!(topology["nodes"], json!([]));
    assert!(
        topology["worktreeGraveyard"][0]["deletedAt"]
            .as_str()
            .is_some()
    );
    assert!(
        !load_metadata_state(&state_dir)
            .sessions
            .contains_key("codex-old")
    );
    assert!(!context_dir.exists());
    assert!(!project.join(".aimux/recordings/codex-old.log").exists());
    assert!(!project.join(".aimux/recordings/codex-old.txt").exists());
    assert!(!project.join(".aimux/history/codex-old.jsonl").exists());
    assert!(!project.join(".aimux/plans/codex-old.md").exists());
    assert!(!project.join(".aimux/status/codex-old.md").exists());
    assert!(!state_dir.join("claude-settings/codex-old.json").exists());
    cleanup(project);
}

#[test]
fn graveyard_worktree_delete_rejects_missing_graveyard_entry() {
    let project = temp_project("worktree-delete-missing");
    let state_dir = project.join("state");
    let worktree = project.join("missing");
    write_active_worktree_topology(&state_dir, &worktree, false);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::DELETE_WORKTREE,
        Some(&json!({ "path": worktree })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 404);
    assert!(
        response.body["error"]
            .as_str()
            .unwrap()
            .contains("Graveyard worktree")
    );
    cleanup(project);
}

fn write_graveyard_agent_topology(
    state_dir: &PathBuf,
    worktree_path: &Path,
    include_worktree_graveyard: bool,
) {
    let worktree_path = worktree_path.to_string_lossy();
    let worktree_graveyard = if include_worktree_graveyard {
        json!([{
            "id": "graveyard-wt",
            "rigId": "rig-1",
            "worktreeId": "wt-old",
            "path": worktree_path.as_ref(),
            "name": "wt",
            "branch": "feature/wt",
            "graveyardedAt": "2026-01-01T00:00:00.000Z"
        }])
    } else {
        json!([])
    };
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": [{
            "id": "node-old",
            "rigId": "rig-1",
            "logicalId": "codex-old",
            "toolConfigKey": "codex",
            "cwd": worktree_path.as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z"
        }],
        "edges": [],
        "bindings": [{
            "id": "tmux:codex-old",
            "nodeId": "node-old",
            "tmuxSession": "aimux",
            "tmuxWindowId": "@old",
            "tmuxWindowIndex": 1,
            "tmuxWindowName": "codex",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "sessions": [{
            "id": "codex-old",
            "nodeId": "node-old",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "args": [],
            "status": "graveyard",
            "worktreePath": worktree_path.as_ref(),
            "graveyardedAt": "2026-01-01T00:00:00.000Z",
            "graveyardReason": "done",
            "restoreBlockedReason": "old",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": worktree_graveyard,
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_worktree_create_topology(state_dir: &PathBuf, worktrees: Value) {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "aimux",
            "projectRoot": "/repo",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "nodes": [],
        "edges": [],
        "bindings": [],
        "sessions": [],
        "services": [],
        "worktrees": worktrees,
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_cache_cleanup_topology(
    state_dir: &PathBuf,
    project: &Path,
    cold: &Path,
    active: &Path,
    outside: &Path,
) {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "aimux",
            "projectRoot": project.to_string_lossy().as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "nodes": [
            { "id": "node-active", "rigId": "rig-1", "logicalId": "agent-active", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "service-active", "rigId": "rig-1", "logicalId": "svc-active", "role": "service", "runtime": "service", "toolConfigKey": "service", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [],
        "sessions": [{
            "id": "agent-active",
            "nodeId": "node-active",
            "tool": "codex",
            "command": "codex",
            "args": [],
            "status": "running",
            "worktreePath": active.to_string_lossy().as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "services": [{
            "id": "svc-active",
            "rigId": "rig-1",
            "nodeId": "service-active",
            "status": "running",
            "command": "zsh",
            "args": ["-lc", "yarn dev"],
            "worktreePath": active.to_string_lossy().as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": project.to_string_lossy().as_ref(), "name": "main", "status": "active", "branch": "master", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "cold", "rigId": "rig-1", "path": cold.to_string_lossy().as_ref(), "name": "cold", "status": "active", "branch": "cold", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "active", "rigId": "rig-1", "path": active.to_string_lossy().as_ref(), "name": "active", "status": "active", "branch": "active", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "outside", "rigId": "rig-1", "path": outside.to_string_lossy().as_ref(), "name": "outside", "status": "active", "branch": "outside", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_cache_cleanup_single_worktree_topology(state_dir: &PathBuf, project: &Path, cold: &Path) {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "aimux",
            "projectRoot": project.to_string_lossy().as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "nodes": [],
        "edges": [],
        "bindings": [],
        "sessions": [],
        "services": [],
        "worktrees": [
            { "id": "cold", "rigId": "rig-1", "path": cold.to_string_lossy().as_ref(), "name": "cold", "status": "active", "branch": "cold", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_restore_previous_topology(state_dir: &PathBuf, project: &Path) {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "aimux",
            "projectRoot": project.to_string_lossy().as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "nodes": [
            { "id": "node-ready", "rigId": "rig-1", "logicalId": "codex-ready", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-blocked", "rigId": "rig-1", "logicalId": "codex-blocked", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-stale", "rigId": "rig-1", "logicalId": "codex-stale", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "tmux:codex-stale", "nodeId": "node-stale", "tmuxSession": "aimux", "tmuxWindowId": "@stale", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-ready", "nodeId": "node-ready", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "backendSessionId": "backend-ready", "status": "offline", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "codex-blocked", "nodeId": "node-blocked", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "status": "offline", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "codex-stale", "nodeId": "node-stale", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "backendSessionId": "backend-stale", "status": "running", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_restore_previous_offer_and_gate(aimux_home: &Path, state_dir: &Path, project: &Path) {
    std::fs::create_dir_all(state_dir).unwrap();
    std::fs::write(
        state_dir.join("agent-restore-offer.json"),
        json!({
            "version": 1,
            "id": "restore-snapshot-old",
            "snapshotId": "snapshot-old",
            "snapshotUpdatedAt": "2026-01-01T00:00:00.000Z",
            "createdAt": "2026-01-01T00:00:01.000Z",
            "updatedAt": "2026-01-01T00:00:01.000Z",
            "sessions": [
                { "id": "codex-ready", "command": "codex" },
                { "id": "codex-blocked", "command": "codex" },
                { "id": "codex-stale", "command": "codex" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        aimux_home.join("restore-prompt-gates.json"),
        json!({
            "version": 1,
            "daemonBootId": "boot-1",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "projects": {
                aimux::paths::compute_project_id(project): {
                    "version": 1,
                    "projectId": aimux::paths::compute_project_id(project),
                    "projectRoot": project.to_string_lossy().as_ref(),
                    "daemonBootId": "boot-1",
                    "snapshotId": "snapshot-old",
                    "snapshotUpdatedAt": "2026-01-01T00:00:00.000Z",
                    "createdAt": "2026-01-01T00:00:00.000Z"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
}

fn write_teammate_parent_topology(state_dir: &PathBuf) {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": [
            { "id": "node-parent", "rigId": "rig-1", "logicalId": "codex-parent", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-child", "rigId": "rig-1", "logicalId": "codex-child", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [],
        "sessions": [
            { "id": "codex-parent", "nodeId": "node-parent", "tool": "codex", "command": "codex", "status": "running", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "codex-child", "nodeId": "node-child", "tool": "codex", "command": "codex", "status": "running", "team": { "teamId": "team-codex-parent", "parentSessionId": "codex-parent" }, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_teammate_lifecycle_topology(
    state_dir: &PathBuf,
    teammate_status: &str,
    backend_session_id: Option<&str>,
) {
    let mut teammate = json!({
        "id": "codex-child",
        "nodeId": "node-child",
        "tool": "codex",
        "toolConfigKey": "codex",
        "command": "codex",
        "args": [],
        "status": teammate_status,
        "team": {
            "teamId": "team-codex-parent",
            "parentSessionId": "codex-parent",
            "role": "reviewer"
        },
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    });
    if let Some(backend_session_id) = backend_session_id {
        teammate["backendSessionId"] = json!(backend_session_id);
    }
    let bindings = if teammate_status == "running" {
        json!([{
            "id": "tmux:codex-child",
            "nodeId": "node-child",
            "tmuxSession": "aimux",
            "tmuxWindowId": "@child",
            "tmuxWindowIndex": 3,
            "tmuxWindowName": "codex",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }])
    } else {
        json!([])
    };
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": [
            { "id": "node-parent", "rigId": "rig-1", "logicalId": "codex-parent", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-child", "rigId": "rig-1", "logicalId": "codex-child", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": bindings,
        "sessions": [
            { "id": "codex-parent", "nodeId": "node-parent", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "status": "running", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            teammate
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_active_worktree_topology(state_dir: &PathBuf, worktree_path: &Path, include_agent: bool) {
    let worktree_path = worktree_path.to_string_lossy();
    let sessions = if include_agent {
        json!([{
            "id": "codex-live",
            "nodeId": "agent:codex-live",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "args": [],
            "status": "running",
            "label": "active agent",
            "worktreePath": worktree_path.as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }])
    } else {
        json!([])
    };
    let nodes = if include_agent {
        json!([
            { "id": "agent:codex-live", "rigId": "rig-1", "logicalId": "codex-live", "toolConfigKey": "codex", "cwd": worktree_path.as_ref(), "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "service:svc-web", "rigId": "rig-1", "logicalId": "svc-web", "role": "service", "runtime": "service", "toolConfigKey": "service", "cwd": worktree_path.as_ref(), "label": "web", "createdAt": "2026-01-01T00:00:00.000Z" }
        ])
    } else {
        json!([
            { "id": "service:svc-web", "rigId": "rig-1", "logicalId": "svc-web", "role": "service", "runtime": "service", "toolConfigKey": "service", "cwd": worktree_path.as_ref(), "label": "web", "createdAt": "2026-01-01T00:00:00.000Z" }
        ])
    };
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": nodes,
        "edges": [],
        "bindings": [{
            "id": "tmux:service:svc-web",
            "nodeId": "service:svc-web",
            "tmuxSession": "aimux",
            "tmuxWindowId": "@service",
            "tmuxWindowIndex": 2,
            "tmuxWindowName": "web",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "sessions": sessions,
        "services": [{
            "id": "svc-web",
            "rigId": "rig-1",
            "nodeId": "service:svc-web",
            "status": "running",
            "command": "zsh",
            "args": ["-lc", "yarn dev"],
            "launchCommandLine": "yarn dev",
            "worktreePath": worktree_path.as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "worktrees": [{
            "id": "wt-1",
            "rigId": "rig-1",
            "path": worktree_path.as_ref(),
            "name": "wt",
            "branch": "feature/wt",
            "status": "active",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_graveyard_worktree_topology(state_dir: &PathBuf, worktree_path: &Path) {
    let worktree_path = worktree_path.to_string_lossy();
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": [],
        "edges": [],
        "bindings": [],
        "sessions": [],
        "services": [],
        "worktrees": [{
            "id": "wt-1",
            "rigId": "rig-1",
            "path": worktree_path.as_ref(),
            "name": "wt",
            "branch": "feature/wt",
            "status": "graveyard",
            "removedAt": "2026-01-01T00:00:10.000Z",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:10.000Z"
        }],
        "worktreeGraveyard": [{
            "id": "graveyard-wt",
            "rigId": "rig-1",
            "worktreeId": "wt-1",
            "path": worktree_path.as_ref(),
            "name": "wt",
            "branch": "feature/wt",
            "graveyardedAt": "2026-01-01T00:00:10.000Z"
        }],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_graveyard_worktree_with_dependents_topology(state_dir: &PathBuf, worktree_path: &Path) {
    let worktree_path = worktree_path.to_string_lossy();
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": [
            { "id": "node-agent", "rigId": "rig-1", "logicalId": "codex-old", "toolConfigKey": "codex", "cwd": worktree_path.as_ref(), "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-service", "rigId": "rig-1", "logicalId": "svc-old", "role": "service", "runtime": "service", "toolConfigKey": "service", "cwd": worktree_path.as_ref(), "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [
            { "id": "edge-old", "rigId": "rig-1", "sourceNodeId": "node-agent", "targetNodeId": "node-service", "kind": "uses", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "bindings": [{
            "id": "tmux:codex-old",
            "nodeId": "node-agent",
            "tmuxSession": "aimux",
            "tmuxWindowId": "@old",
            "tmuxWindowIndex": 1,
            "tmuxWindowName": "codex",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "sessions": [{
            "id": "codex-old",
            "nodeId": "node-agent",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "args": [],
            "status": "graveyard",
            "worktreePath": worktree_path.as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "services": [{
            "id": "svc-old",
            "rigId": "rig-1",
            "nodeId": "node-service",
            "status": "stopped",
            "command": "zsh",
            "args": ["-lc", "yarn dev"],
            "launchCommandLine": "yarn dev",
            "worktreePath": worktree_path.as_ref(),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "worktrees": [{
            "id": "wt-1",
            "rigId": "rig-1",
            "path": worktree_path.as_ref(),
            "name": "missing",
            "branch": "feature/missing",
            "status": "graveyard",
            "removedAt": "2026-01-01T00:00:10.000Z",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:10.000Z"
        }],
        "worktreeGraveyard": [{
            "id": "graveyard-wt",
            "rigId": "rig-1",
            "worktreeId": "wt-1",
            "path": worktree_path.as_ref(),
            "name": "missing",
            "branch": "feature/missing",
            "graveyardedAt": "2026-01-01T00:00:10.000Z"
        }],
        "teamRoles": [{
            "id": "role-old",
            "rigId": "rig-1",
            "nodeId": "node-agent",
            "role": "reviewer",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "remoteClients": [{
            "id": "remote-old",
            "rigId": "rig-1",
            "label": "phone",
            "ownsSessionIds": ["codex-old"],
            "lastSeenAt": "2026-01-01T00:00:00.000Z",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "lifecycleOperations": [],
        "exchangeRefs": [{
            "id": "ref-old",
            "rigId": "rig-1",
            "nodeId": "node-agent",
            "sessionId": "codex-old",
            "kind": "task",
            "exchangeId": "task-1",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }]
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_lifecycle_topology(state_dir: &PathBuf) {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": [
            { "id": "node-agent", "rigId": "rig-1", "logicalId": "codex-live", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-service", "rigId": "rig-1", "logicalId": "svc-web", "role": "service", "runtime": "service", "toolConfigKey": "service", "cwd": "/repo", "label": "web", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "tmux:codex-live", "nodeId": "node-agent", "tmuxSession": "aimux", "tmuxWindowId": "@agent", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "tmux:svc-web", "nodeId": "node-service", "tmuxSession": "aimux", "tmuxWindowId": "@service", "tmuxWindowIndex": 2, "tmuxWindowName": "web", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [{
            "id": "codex-live",
            "nodeId": "node-agent",
            "tool": "codex",
            "command": "codex",
            "args": [],
            "status": "running",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "services": [{
            "id": "svc-web",
            "rigId": "rig-1",
            "nodeId": "node-service",
            "status": "running",
            "command": "zsh",
            "args": ["-lc", "yarn dev"],
            "launchCommandLine": "yarn dev",
            "worktreePath": "/repo",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "lastSeenAt": "2026-01-01T00:00:00.000Z"
        }],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn move_fixture_service_to_project_root(state_dir: &PathBuf, project: &Path) {
    let project_path = project.to_string_lossy();
    let mut topology = read_topology(state_dir);
    topology["rigs"][0]["projectRoot"] = json!(project_path.as_ref());
    topology["nodes"][0]["cwd"] = json!(project_path.as_ref());
    topology["nodes"][1]["cwd"] = json!(project_path.as_ref());
    topology["sessions"][0]["worktreePath"] = json!(project_path.as_ref());
    topology["services"][0]["worktreePath"] = json!(project_path.as_ref());
    topology["services"][0]["cwd"] = json!(project_path.as_ref());
    topology["worktrees"] = json!([{
        "id": "wt-main",
        "rigId": "rig-1",
        "path": project_path.as_ref(),
        "name": "Main Checkout",
        "status": "active",
        "branch": "master",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    }]);
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_agent_resume_topology(state_dir: &PathBuf, session: Value) {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": [{
            "id": session["nodeId"],
            "rigId": "rig-1",
            "logicalId": session["id"],
            "runtime": session["tool"],
            "toolConfigKey": session["tool"],
            "cwd": session["worktreePath"],
            "label": session["label"],
            "createdAt": "2026-01-01T00:00:00.000Z"
        }],
        "edges": [],
        "bindings": [],
        "sessions": [session],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn write_project_tool_config(project: &Path) {
    let aimux_dir = project.join(".aimux");
    std::fs::create_dir_all(&aimux_dir).unwrap();
    std::fs::write(
        aimux_dir.join("config.json"),
        serde_json::to_string_pretty(&json!({
            "tools": {
                "mock": {
                    "command": "/bin/mock",
                    "args": ["--base"],
                    "enabled": true,
                    "wrapperEnabled": true,
                    "resumeArgs": ["--resume", "{sessionId}"],
                    "forkArgs": ["--fork", "{sessionId}"],
                    "resumeByBackendSessionId": true
                },
                "mock2": {
                    "command": "/bin/mock2",
                    "args": ["--next"],
                    "enabled": true,
                    "wrapperEnabled": true,
                    "resumeArgs": ["--resume", "{sessionId}"],
                    "forkArgs": ["--fork", "{sessionId}"],
                    "resumeByBackendSessionId": true
                },
                "mockp": {
                    "command": "/bin/mockp",
                    "args": ["--base-p"],
                    "enabled": true,
                    "wrapperEnabled": true,
                    "preambleFlag": ["--prompt"],
                    "resumeArgs": ["--resume", "{sessionId}"],
                    "forkArgs": ["--fork", "{sessionId}"],
                    "resumeByBackendSessionId": true
                },
                "mock-unresumable": {
                    "command": "/bin/mock-unresumable",
                    "args": ["--base-unresumable"],
                    "enabled": true,
                    "wrapperEnabled": true,
                    "resumeFallback": ["--restore-chat-history"]
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

fn write_project_scribe_config(project: &Path) {
    let aimux_dir = project.join(".aimux");
    std::fs::create_dir_all(&aimux_dir).unwrap();
    std::fs::write(
        aimux_dir.join("config.json"),
        serde_json::to_string_pretty(&json!({
            "scribe": {
                "defaultAgent": {
                    "tool": "mock",
                    "extraArgs": ["--mode", "scribe"],
                    "env": { "AIMUX_TEST_SCRIBE": "1" }
                }
            },
            "tools": {
                "mock": {
                    "command": "/bin/mock",
                    "args": ["--base"],
                    "defaultEnv": { "AIMUX_TOOL_DEFAULT": "1" },
                    "enabled": true,
                    "wrapperEnabled": true
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

fn read_topology(state_dir: &PathBuf) -> Value {
    read_runtime_topology(runtime_topology_path(state_dir)).unwrap()
}

fn read_state(state_dir: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(state_dir.join("state.json")).unwrap()).unwrap()
}

fn session(topology: &Value, id: &str) -> Value {
    find(topology, "sessions", id).unwrap()
}

fn service(topology: &Value, id: &str) -> Value {
    find(topology, "services", id).unwrap()
}

fn assert_gui_service_status(
    context: &ProjectServiceRequestContext,
    service_id: &str,
    status: &str,
) {
    let desktop = route_project_service_request(context, "GET", routes::DESKTOP_STATE, None);
    assert_eq!(desktop.status, 200);
    let desktop_service = find_body_array_item(&desktop.body, "services", service_id);
    assert_eq!(desktop_service["status"], status);
    let group_service = desktop.body["worktreeGroups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["services"].as_array().into_iter().flatten())
        .find(|service| service["id"] == service_id)
        .expect("worktree group service");
    assert_eq!(group_service["status"], status);

    let topology = route_project_service_request(context, "GET", routes::TOPOLOGY, None);
    assert_eq!(topology.status, 200);
    assert_eq!(topology.body["topology"]["counts"]["services"], 1);
    let topology_row = topology.body["topology"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "service" && row["serviceId"] == service_id)
        .expect("service topology row");
    assert_eq!(topology_row["status"], status);

    let observability =
        route_project_service_request(context, "GET", routes::PROJECT_OBSERVABILITY, None);
    assert_eq!(observability.status, 200);
    assert_eq!(observability.body["project"]["summary"]["services"], 1);
}

fn assert_gui_service_absent(context: &ProjectServiceRequestContext, service_id: &str) {
    let desktop = route_project_service_request(context, "GET", routes::DESKTOP_STATE, None);
    assert_eq!(desktop.status, 200);
    assert!(
        desktop.body["services"]
            .as_array()
            .unwrap()
            .iter()
            .all(|service| service["id"] != service_id)
    );
    assert!(
        desktop.body["worktreeGroups"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|group| group["services"].as_array().into_iter().flatten())
            .all(|service| service["id"] != service_id)
    );

    let topology = route_project_service_request(context, "GET", routes::TOPOLOGY, None);
    assert_eq!(topology.status, 200);
    assert_eq!(topology.body["topology"]["counts"]["services"], 0);
    assert!(
        topology.body["topology"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["serviceId"] != service_id)
    );

    let observability =
        route_project_service_request(context, "GET", routes::PROJECT_OBSERVABILITY, None);
    assert_eq!(observability.status, 200);
    assert_eq!(observability.body["project"]["summary"]["services"], 0);
}

fn find_body_array_item(body: &Value, key: &str, id: &str) -> Value {
    body[key]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
        .cloned()
        .expect("body array item")
}

fn find(topology: &Value, key: &str, id: &str) -> Option<Value> {
    topology[key]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
        .cloned()
}

fn temp_project(label: &str) -> PathBuf {
    let path = temp_plain_project(label);
    fs::create_dir_all(path.join(".git")).expect("create git marker");
    path
}

fn temp_plain_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-lifecycle-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}

fn expected_shell_rc_path(state_dir: &Path) -> PathBuf {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "zsh".to_owned());
    let shell_base = Path::new(&shell)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&shell)
        .to_ascii_lowercase();
    let rc_name = if shell_base.contains("bash") {
        "aimux-bashrc"
    } else {
        ".zshrc"
    };
    state_dir.join("shell-integration").join(rc_name)
}
