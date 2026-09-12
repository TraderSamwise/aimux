//! Producer half of restore-previous-agents, driven through the real rail task.
//!
//! The behaviour under test is a difference between two shutdowns that look
//! identical from inside the process, so every case here runs the same task
//! against the same topology and changes only how the previous run ended.

use aimux::paths::{PathResolver, compute_project_id};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_restore_task::AgentRestoreSnapshotTask;
use aimux::project_service::lifecycle::{
    ProjectLifecycleRuntime, route_lifecycle_request_with_runtime,
    seed_agent_restore_prompt_gates_for_daemon_boot,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::PeriodicTask;
use aimux::runtime_topology::{
    coerce_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::tmux::TmuxTarget;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const AGENT_IDS: [&str; 2] = ["claude-one", "codex-two"];

#[test]
fn unsafe_exit_leaves_a_snapshot_that_becomes_a_restore_offer() {
    let project = TestProject::new("unsafe-exit");
    project.run_task();

    let snapshot = project
        .snapshot()
        .expect("snapshot recorded while agents ran");
    assert_eq!(
        session_ids(&snapshot),
        AGENT_IDS,
        "the running agents are recorded"
    );

    project.simulate_process_death();
    let gate = project.seed_prompt_gates("boot-after-crash");
    assert_eq!(
        gate["snapshotId"], snapshot["id"],
        "the boot gate opens on the snapshot the dead run left behind"
    );

    project.run_task();

    let offer = project
        .offer()
        .expect("offer derived from the previous run");
    assert_eq!(offer["snapshotId"], snapshot["id"]);
    assert_eq!(session_ids(&offer), AGENT_IDS);
}

#[test]
fn clean_exit_leaves_no_snapshot_and_no_restore_offer() {
    let project = TestProject::new("clean-exit");
    project.run_task();
    assert!(project.snapshot().is_some(), "agents were running");

    for agent_id in AGENT_IDS {
        project.stop_agent(agent_id);
    }

    assert!(
        project.snapshot().is_none(),
        "stopping the last agent deletes the snapshot"
    );

    project.seed_prompt_gates_expecting_none("boot-after-quit");
    project.run_task();

    assert!(
        project.offer().is_none(),
        "a deliberate teardown is never offered back"
    );
}

#[test]
fn a_snapshot_from_this_same_run_is_never_offered_back() {
    let project = TestProject::new("same-run");
    project.run_task();
    let snapshot = project.snapshot().expect("snapshot recorded");

    // Everything the crash case has, except that this run wrote the snapshot.
    project.mark_all_agents_offline();
    let gate = project.seed_prompt_gates("boot-same-run");
    assert_eq!(gate["snapshotId"], snapshot["id"]);

    project.run_task();

    assert!(
        project.offer().is_none(),
        "a live run is never offered the agents it recorded itself"
    );
}

struct TestProject {
    project_root: PathBuf,
    aimux_home: PathBuf,
    state_dir: PathBuf,
    project_id: String,
}

impl TestProject {
    fn new(label: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "aimux-agent-restore-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&base);
        let project_root = base.join("repo");
        let aimux_home = base.join("aimux-home");
        fs::create_dir_all(project_root.join(".git")).expect("git marker");
        let project_id = compute_project_id(&project_root);
        let state_dir = aimux_home.join("projects").join(&project_id);
        fs::create_dir_all(&state_dir).expect("state dir");
        let project = Self {
            project_root,
            aimux_home,
            state_dir,
            project_id,
        };
        project.write_registry();
        project.write_topology("running");
        project
    }

    fn context(&self) -> Arc<ProjectServiceRequestContext> {
        Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            &self.project_root,
            &self.state_dir,
        ))
    }

    fn run_task(&self) {
        let context = self.context();
        let mut task = AgentRestoreSnapshotTask::new(&context);
        task.run(&context);
    }

    fn stop_agent(&self, session_id: &str) {
        let context = self.context();
        let mut runtime = StubLifecycleRuntime;
        let response = route_lifecycle_request_with_runtime(
            &context,
            "POST",
            routes::agents::STOP,
            Some(&json!({ "sessionId": session_id })),
            &mut runtime,
        )
        .expect("stop route handled");
        assert_eq!(response.status, 200, "stop failed: {:?}", response.body);
    }

    /// What the file system looks like after a `kill -9`: the snapshot is still
    /// there, stamped by a run that no longer exists, and its agents are gone.
    fn simulate_process_death(&self) {
        let mut snapshot = self.snapshot().expect("snapshot to inherit");
        snapshot["writerInstanceId"] = json!("previous-run-9999");
        fs::write(
            self.state_dir.join("last-online-agents.json"),
            serde_json::to_string_pretty(&snapshot).expect("serialize snapshot"),
        )
        .expect("write snapshot");
        self.mark_all_agents_offline();
    }

    fn mark_all_agents_offline(&self) {
        self.write_topology("offline");
    }

    fn seed_prompt_gates(&self, daemon_boot_id: &str) -> Value {
        let state = self.seed(daemon_boot_id);
        state["projects"][&self.project_id].clone()
    }

    fn seed_prompt_gates_expecting_none(&self, daemon_boot_id: &str) {
        let state = self.seed(daemon_boot_id);
        assert!(
            state["projects"][&self.project_id].is_null(),
            "no snapshot means no gate: {state}"
        );
    }

    fn seed(&self, daemon_boot_id: &str) -> Value {
        seed_agent_restore_prompt_gates_for_daemon_boot(
            &self.resolver(),
            daemon_boot_id,
            "2026-01-01T00:00:00.000Z",
        )
        .expect("seed prompt gates")
    }

    fn resolver(&self) -> PathResolver {
        PathResolver::new(
            &self.project_root,
            self.project_root.join("home"),
            Some(self.aimux_home.to_string_lossy().into_owned()),
        )
    }

    fn snapshot(&self) -> Option<Value> {
        read_json(&self.state_dir.join("last-online-agents.json"))
    }

    fn offer(&self) -> Option<Value> {
        read_json(&self.state_dir.join("agent-restore-offer.json"))
    }

    fn write_registry(&self) {
        fs::create_dir_all(&self.aimux_home).expect("aimux home");
        fs::write(
            self.aimux_home.join("projects.json"),
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "projects": [{
                    "id": self.project_id,
                    "name": "repo",
                    "repoRoot": self.project_root.to_string_lossy(),
                    "lastSeen": "2026-01-01T00:00:00.000Z",
                }],
            }))
            .expect("serialize registry"),
        )
        .expect("write registry");
    }

    fn write_topology(&self, status: &str) {
        let project_path = self.project_root.to_string_lossy().into_owned();
        let sessions = AGENT_IDS
            .iter()
            .enumerate()
            .map(|(index, id)| {
                json!({
                    "id": id,
                    "nodeId": format!("node-{index}"),
                    "tool": "claude",
                    "toolConfigKey": "claude",
                    "command": "claude",
                    "backendSessionId": format!("backend-{index}"),
                    "args": [],
                    "label": format!("agent {index}"),
                    "worktreePath": project_path,
                    "status": status,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z",
                })
            })
            .collect::<Vec<_>>();
        let nodes = AGENT_IDS
            .iter()
            .enumerate()
            .map(|(index, id)| {
                json!({
                    "id": format!("node-{index}"),
                    "rigId": "rig-1",
                    "logicalId": id,
                    "toolConfigKey": "claude",
                    "cwd": project_path,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                })
            })
            .collect::<Vec<_>>();
        let bindings = AGENT_IDS
            .iter()
            .enumerate()
            .map(|(index, id)| {
                json!({
                    "id": format!("tmux:{id}"),
                    "nodeId": format!("node-{index}"),
                    "tmuxSession": "aimux",
                    "tmuxWindowId": format!("@{index}"),
                    "tmuxWindowIndex": index + 1,
                    "tmuxWindowName": id,
                    "updatedAt": "2026-01-01T00:00:00.000Z",
                })
            })
            .collect::<Vec<_>>();
        let topology = coerce_runtime_topology(&json!({
            "version": 1,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "rigs": [{
                "id": "rig-1",
                "name": "repo",
                "projectRoot": project_path,
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
            }],
            "nodes": nodes,
            "edges": [],
            "bindings": bindings,
            "sessions": sessions,
            "services": [],
            "worktrees": [],
            "worktreeGraveyard": [],
            "teamRoles": [],
            "remoteClients": [],
            "lifecycleOperations": [],
            "exchangeRefs": [],
        }))
        .expect("coerce topology");
        write_runtime_topology(runtime_topology_path(&self.state_dir), &topology)
            .expect("write topology");
        // A round trip keeps the fixture honest: the task reads the file, not
        // the value built above.
        read_runtime_topology(runtime_topology_path(&self.state_dir)).expect("topology readable");
    }
}

impl Drop for TestProject {
    fn drop(&mut self) {
        if let Some(base) = self.project_root.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn session_ids(value: &Value) -> Vec<String> {
    value["sessionIds"]
        .as_array()
        .expect("sessionIds array")
        .iter()
        .filter_map(|id| id.as_str().map(ToOwned::to_owned))
        .collect()
}

struct StubLifecycleRuntime;

impl ProjectLifecycleRuntime for StubLifecycleRuntime {
    fn repair_legacy_project_session_names(&mut self, _project_root: &Path) -> Result<(), String> {
        Ok(())
    }

    fn ensure_project_session(&mut self, _project_root: &Path) -> Result<(), String> {
        Ok(())
    }

    fn find_main_repo(&mut self, cwd: &str) -> Result<String, String> {
        Ok(cwd.to_owned())
    }

    fn create_worktree(
        &mut self,
        _main_repo: &str,
        _name: &str,
        _target_path: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    fn create_window(
        &mut self,
        _session_name: &str,
        _name: &str,
        _cwd: &str,
        _command: &str,
        _args: &[String],
        _detached: bool,
    ) -> Result<TmuxTarget, String> {
        Err("create_window is not used by these tests".into())
    }

    fn set_window_metadata(&mut self, _window_id: &str, _metadata: &Value) -> Result<(), String> {
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

    fn has_window(&mut self, _target: &TmuxTarget) -> bool {
        true
    }

    fn wait_for_window_after_launch(&mut self, _target: &TmuxTarget, _timeout: Duration) -> bool {
        true
    }

    fn codex_backend_session_ids_for_cwd(
        &mut self,
        _cwd: &str,
    ) -> Result<BTreeSet<String>, String> {
        Ok(BTreeSet::new())
    }

    fn kill_window(&mut self, _window_id: &str) -> Result<(), String> {
        Ok(())
    }

    fn rename_window(&mut self, _window_id: &str, _name: &str) -> Result<(), String> {
        Ok(())
    }
}
