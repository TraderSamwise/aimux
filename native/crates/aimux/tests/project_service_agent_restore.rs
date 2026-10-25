//! Producer half of restore-previous-agents, driven through the real tick task.
//!
//! The behaviour under test is a difference between two shutdowns that look
//! identical from inside the process, so every case here runs the same task
//! against the same topology and changes only how the previous run ended.

use aimux::paths::{PathResolver, compute_project_id};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_restore_task::{AgentRestoreSnapshotTask, LiveWindowSource};
use aimux::project_service::lifecycle::{
    ProjectLifecycleRuntime, route_lifecycle_request_with_runtime,
    seed_agent_restore_prompt_gates_for_daemon_boot,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::PeriodicTask;
use aimux::runtime_topology::{
    coerce_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::tmux::{LiveWindowIndex, TmuxTarget};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const AGENT_IDS: [&str; 2] = ["claude-one", "codex-two"];
const AGENT_WINDOW_IDS: [&str; 2] = ["@0", "@1"];
const AGENT_TMUX_SESSION: &str = "aimux";

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

    // The topology still reads `running` — nothing has reconciled it yet — so
    // only the dead tmux windows say these agents are gone.
    project.run_task_with_no_live_windows();

    let offer = project
        .offer()
        .expect("offer derived from the previous run");
    assert_eq!(offer["snapshotId"], snapshot["id"]);
    assert_eq!(session_ids(&offer), AGENT_IDS);
}

/// A second restart of the same agents must ask again.
///
/// The snapshot id changes only when the SET of agents changes, so the same
/// agents killed twice carry the same id both times. The acknowledgement was
/// keyed on that id alone, so one accepted offer muted every restart that
/// followed -- twenty agents went offline with no prompt because the id had
/// been minted a day earlier and acknowledged by a restore that did not work.
///
/// Driven through the ack file rather than the restore route: the route also
/// writes a retry offer when a restore fails, and that short-circuits the
/// derive before it ever consults the acknowledgement.
#[test]
fn an_acknowledgement_is_spent_by_the_boot_that_made_it() {
    let project = TestProject::new("ack-per-boot");
    project.run_task();
    let snapshot = project.snapshot().expect("agents recorded while running");
    let snapshot_id = snapshot["id"].as_str().expect("snapshot id").to_owned();

    // An acknowledgement made during THIS boot still answers for it.
    project.simulate_process_death();
    project.seed_prompt_gates("boot-1");
    project.write_ack(&snapshot_id, Some("boot-1"));
    project.run_task_with_no_live_windows();
    assert!(
        project.offer().is_none(),
        "an offer acknowledged in this boot must not come back in it"
    );

    // The same agents, killed again. Same set, so the same snapshot id --
    // which is exactly the trap -- but a new boot, so a new occasion.
    project.simulate_process_death();
    let gate = project.seed_prompt_gates("boot-2");
    assert_eq!(
        gate["snapshotId"], snapshot["id"],
        "the same agents still carry the same snapshot id"
    );
    project.run_task_with_no_live_windows();
    let offer = project
        .offer()
        .expect("a second restart of the same agents must be offered again");
    assert_eq!(offer["snapshotId"], snapshot["id"]);
    assert_eq!(session_ids(&offer), AGENT_IDS);

    // And the shape found on a real machine: an ack written before the boot
    // was recorded cannot be attributed to one, so it is spent rather than
    // muting for ever.
    project.remove_offer();
    project.simulate_process_death();
    project.seed_prompt_gates("boot-3");
    project.write_ack(&snapshot_id, None);
    project.run_task_with_no_live_windows();
    assert!(
        project.offer().is_some(),
        "an undatable acknowledgement must not mute a restart for ever"
    );
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
    project.run_task_with_no_live_windows();

    assert!(
        project.offer().is_none(),
        "a deliberate teardown is never offered back"
    );
}

#[test]
fn stopped_supervisor_stays_restore_eligible_while_stopped_coder_prunes() {
    let project = TestProject::new("stopped-supervisor");
    project.mark_overseer("claude-one");
    project.move_session_to_worktree("codex-two", "coder-worktree");
    project.run_task();

    project.stop_agent("claude-one");
    project.stop_agent("codex-two");

    let snapshot = project
        .snapshot()
        .expect("stopped supervisor remains restore-eligible");
    assert_eq!(session_ids(&snapshot), vec!["claude-one".to_owned()]);
    assert_eq!(snapshot["sessions"][0]["overseer"], true);
    assert_eq!(snapshot["sessions"][0]["projectControl"], true);
}

#[test]
fn a_snapshot_from_this_same_run_is_never_offered_back() {
    let project = TestProject::new("same-run");
    project.run_task();
    let snapshot = project.snapshot().expect("snapshot recorded");

    // Everything the crash case has, except that this run wrote the snapshot.
    let gate = project.seed_prompt_gates("boot-same-run");
    assert_eq!(gate["snapshotId"], snapshot["id"]);

    project.run_task_with_no_live_windows();

    assert!(
        project.offer().is_none(),
        "a live run is never offered the agents it recorded itself"
    );
}

#[test]
fn a_crashed_agent_whose_row_still_reads_running_can_still_be_restored() {
    let project = TestProject::new("restore-stale-row");
    project.run_task();
    project.simulate_process_death();
    project.seed_prompt_gates("boot-after-crash");
    project.run_task_with_no_live_windows();
    assert!(project.offer().is_some(), "offer derived");

    // The topology still reads `running` for both agents. Refusing them here is
    // what made the offer undismissable and unrestorable in the live drive.
    let accepted = project.accept_restore_offer();

    assert_eq!(accepted["accepted"], true);
    assert_eq!(accepted["total"], AGENT_IDS.len());
}

#[test]
fn a_tmux_query_that_cannot_be_answered_records_nothing_and_offers_nothing() {
    let project = TestProject::new("tmux-unavailable");
    let error = project
        .run_task_with(FakeLiveWindows::unavailable())
        .expect_err("tmux unavailable should fail the task");
    assert!(error.contains("tmux live windows unavailable"), "{error}");
    assert!(
        project.snapshot().is_none(),
        "a failed liveness query is not an empty online set"
    );

    project.run_task();
    let snapshot = project.snapshot().expect("snapshot once tmux answers");
    project.simulate_process_death();
    project.seed_prompt_gates("boot-after-crash");

    let error = project
        .run_task_with(FakeLiveWindows::unavailable())
        .expect_err("tmux unavailable should fail the task");
    assert!(error.contains("tmux live windows unavailable"), "{error}");
    assert!(
        project.offer().is_none(),
        "a failed liveness query is not proof the agents are gone"
    );

    project.run_task_with_no_live_windows();
    let offer = project.offer().expect("offer once tmux answers");
    assert_eq!(offer["snapshotId"], snapshot["id"]);
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

    /// A tick with both agent windows alive in tmux.
    fn run_task(&self) {
        self.run_task_with(FakeLiveWindows::alive())
            .expect("agent restore task should run");
    }

    /// A tick after the windows are gone, which is what the service sees when
    /// it comes back up after a crash.
    fn run_task_with_no_live_windows(&self) {
        self.run_task_with(FakeLiveWindows::none())
            .expect("agent restore task should run");
    }

    fn run_task_with_only_live_windows(&self, window_ids: &[&str]) {
        self.run_task_with(FakeLiveWindows::only(window_ids))
            .expect("agent restore task should run");
    }

    fn run_task_with(&self, live_windows: FakeLiveWindows) -> Result<(), String> {
        aimux::async_runtime::init_process_runtime().expect("runtime initialized");
        let context = self.context();
        let mut task =
            AgentRestoreSnapshotTask::with_live_window_source(&context, Box::new(live_windows));
        // aimux-async-seam: test - restore task test drives async PeriodicTask body
        aimux::async_runtime::block_on_named("agent-restore-test", task.run(&context))
    }

    fn accept_restore_offer(&self) -> Value {
        let context = ProjectServiceRequestContext::with_project_state_dir(
            &self.project_root,
            &self.state_dir,
        )
        .with_live_windows(LiveWindowIndex::default());
        let mut runtime = StubLifecycleRuntime;
        route_lifecycle_request_with_runtime(
            &context,
            "POST",
            routes::agents::RESTORE_PREVIOUS,
            Some(&json!({})),
            &mut runtime,
        )
        .expect("restore route handled")
        .body
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
        self.simulate_process_death_as("previous-run-9999");
    }

    /// The acknowledgement as the product writes it, so the test drives the
    /// same file the derive reads.
    fn write_ack(&self, snapshot_id: &str, daemon_boot_id: Option<&str>) {
        let mut ack = json!({
            "version": 1,
            "snapshotId": snapshot_id,
            "source": "last-online",
            "acknowledgedAt": "2026-10-21T00:00:00.000Z",
        });
        if let Some(daemon_boot_id) = daemon_boot_id {
            ack["daemonBootId"] = json!(daemon_boot_id);
        }
        fs::write(
            self.state_dir.join("agent-restore-offer-ack.json"),
            serde_json::to_string_pretty(&ack).expect("serialize ack"),
        )
        .expect("write ack");
    }

    /// Freeze the offer at a subset of its sessions, which is what a partial
    /// restore and a decay both leave behind.
    fn shrink_offer_to(&self, session_ids: &[&str]) {
        let mut offer = self.offer().expect("offer to shrink");
        let sessions = offer["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .filter(|session| session_ids.contains(&session["id"].as_str().unwrap_or_default()))
            .cloned()
            .collect::<Vec<_>>();
        offer["sessionIds"] = json!(session_ids);
        offer["sessions"] = json!(sessions);
        self.write_offer(&offer);
    }

    /// The offer as it was written before it carried a boot stamp.
    fn strip_offer_boot_stamp(&self) {
        let mut offer = self.offer().expect("offer to strip");
        offer
            .as_object_mut()
            .expect("offer object")
            .remove("daemonBootId");
        self.write_offer(&offer);
    }

    fn write_offer(&self, offer: &Value) {
        fs::write(
            self.state_dir.join("agent-restore-offer.json"),
            serde_json::to_string_pretty(offer).expect("serialize offer"),
        )
        .expect("write offer");
    }

    /// What the file system looks like after a `kill -9` by a named run, so a
    /// test can give two deaths different observing runs -- the difference a
    /// lasting dismissal has to respect.
    fn simulate_process_death_as(&self, writer_instance_id: &str) {
        let mut snapshot = self.snapshot().expect("snapshot to inherit");
        snapshot["writerInstanceId"] = json!(writer_instance_id);
        fs::write(
            self.state_dir.join("last-online-agents.json"),
            serde_json::to_string_pretty(&snapshot).expect("serialize snapshot"),
        )
        .expect("write snapshot");
    }

    fn dismiss_restore_offer(&self) -> Value {
        let context = ProjectServiceRequestContext::with_project_state_dir(
            &self.project_root,
            &self.state_dir,
        );
        let mut runtime = StubLifecycleRuntime;
        route_lifecycle_request_with_runtime(
            &context,
            "POST",
            routes::agents::DISMISS_RESTORE_PREVIOUS,
            Some(&json!({})),
            &mut runtime,
        )
        .expect("dismiss route handled")
        .body
    }

    fn ack(&self) -> Option<Value> {
        read_json(&self.state_dir.join("agent-restore-offer-ack.json"))
    }

    /// One more agent, with its own node, binding and tmux window, which is how
    /// a newcomer changes the session SET and so mints a new snapshot
    /// generation on the next tick.
    ///
    /// It needs the binding, not just the session row: retention only keeps
    /// sessions the snapshot already holds, so a session enters it by being
    /// observed online -- which means tmux has to be backing a window the
    /// topology attributes to it.
    fn add_agent(&self, session_id: &str, window_id: &str) {
        let path = runtime_topology_path(&self.state_dir);
        let mut topology = read_runtime_topology(&path).expect("topology");
        let node_id = format!("node-{session_id}");

        let mut node = topology["nodes"].as_array().expect("nodes")[0].clone();
        node["id"] = json!(node_id);
        node["logicalId"] = json!(session_id);
        topology["nodes"].as_array_mut().expect("nodes").push(node);

        let mut binding = topology["bindings"].as_array().expect("bindings")[0].clone();
        binding["id"] = json!(format!("tmux:{session_id}"));
        binding["nodeId"] = json!(node_id);
        binding["tmuxWindowId"] = json!(window_id);
        binding["tmuxWindowName"] = json!(session_id);
        topology["bindings"]
            .as_array_mut()
            .expect("bindings")
            .push(binding);

        let mut session = topology["sessions"].as_array().expect("sessions")[0].clone();
        session["id"] = json!(session_id);
        session["nodeId"] = json!(node_id);
        session["label"] = json!(session_id);
        topology["sessions"]
            .as_array_mut()
            .expect("sessions")
            .push(session);

        write_runtime_topology(&path, &topology).expect("write topology");
    }

    fn remove_offer(&self) {
        let _ = fs::remove_file(self.state_dir.join("agent-restore-offer.json"));
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

    /// Move an agent's tmux window without touching the topology's session
    /// order, which is what a window swap or a restart looks like from here.
    fn set_window_index(&self, session_id: &str, window_index: u64) {
        let mut topology =
            read_runtime_topology(runtime_topology_path(&self.state_dir)).expect("read topology");
        let Some(bindings) = topology.get_mut("bindings").and_then(Value::as_array_mut) else {
            panic!("bindings array");
        };
        let Some(Value::Object(binding)) = bindings.iter_mut().find(|binding| {
            binding.get("id").and_then(Value::as_str) == Some(&format!("tmux:{session_id}"))
        }) else {
            panic!("binding for {session_id} exists");
        };
        binding.insert("tmuxWindowIndex".into(), Value::from(window_index));
        write_runtime_topology(runtime_topology_path(&self.state_dir), &topology)
            .expect("write topology");
    }

    fn mark_overseer(&self, session_id: &str) {
        let mut topology =
            read_runtime_topology(runtime_topology_path(&self.state_dir)).expect("read topology");
        let Some(sessions) = topology.get_mut("sessions").and_then(Value::as_array_mut) else {
            panic!("sessions array");
        };
        let Some(Value::Object(session)) = sessions
            .iter_mut()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        else {
            panic!("session {session_id} exists");
        };
        session.insert("overseer".into(), Value::Bool(true));
        session.insert("projectControl".into(), Value::Bool(true));
        session.insert(
            "team".into(),
            json!({
                "teamId": "overseer",
                "parentSessionId": "",
                "role": "overseer"
            }),
        );
        write_runtime_topology(runtime_topology_path(&self.state_dir), &topology)
            .expect("write topology");
    }

    /// Promote a session in METADATA only, which is where promotion actually
    /// writes: nothing puts `overseer`, `scribe` or `projectControl` into the
    /// topology file. `mark_overseer` writes the topology, which the snapshot
    /// could read without merging anything; this is the shape that catches a
    /// snapshot ordering agents off the raw row.
    fn mark_overseer_in_metadata_only(&self, session_id: &str) {
        let path = aimux::daemon_state::metadata_state_path(&self.state_dir);
        let mut state = if path.exists() {
            serde_json::from_str::<Value>(&fs::read_to_string(&path).expect("read metadata"))
                .expect("parse metadata")
        } else {
            json!({ "version": 1, "sessions": {} })
        };
        state["sessions"][session_id] = json!({
            "id": session_id,
            "overseer": true,
            "projectControl": true,
        });
        fs::write(
            &path,
            serde_json::to_vec_pretty(&state).expect("serialize metadata"),
        )
        .expect("write metadata");
    }

    /// Move a session to a terminal status without going through stop, which
    /// is how the graveyard sweep and worktree cleanup finish a session.
    fn set_session_status(&self, session_id: &str, status: &str) {
        let mut topology =
            read_runtime_topology(runtime_topology_path(&self.state_dir)).expect("read topology");
        let Some(sessions) = topology.get_mut("sessions").and_then(Value::as_array_mut) else {
            panic!("sessions array");
        };
        let Some(Value::Object(session)) = sessions
            .iter_mut()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        else {
            panic!("session {session_id} exists");
        };
        session.insert("status".into(), Value::String(status.to_owned()));
        write_runtime_topology(runtime_topology_path(&self.state_dir), &topology)
            .expect("write topology");
    }

    fn move_session_to_worktree(&self, session_id: &str, worktree_name: &str) {
        let worktree = self.project_root.join(worktree_name);
        fs::create_dir_all(&worktree).expect("worktree dir");
        let mut topology =
            read_runtime_topology(runtime_topology_path(&self.state_dir)).expect("read topology");
        let Some(sessions) = topology.get_mut("sessions").and_then(Value::as_array_mut) else {
            panic!("sessions array");
        };
        let Some(Value::Object(session)) = sessions
            .iter_mut()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        else {
            panic!("session {session_id} exists");
        };
        session.insert(
            "worktreePath".into(),
            Value::String(worktree.to_string_lossy().into_owned()),
        );
        write_runtime_topology(runtime_topology_path(&self.state_dir), &topology)
            .expect("write topology");
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

struct FakeLiveWindows(Result<LiveWindowIndex, String>);

impl FakeLiveWindows {
    fn alive() -> Self {
        Self(Ok(LiveWindowIndex::from_pairs(
            AGENT_WINDOW_IDS.iter().map(|id| (*id, AGENT_TMUX_SESSION)),
        )))
    }

    fn none() -> Self {
        Self(Ok(LiveWindowIndex::default()))
    }

    /// Some windows survived and some did not, which is what a partial tmux
    /// loss looks like from inside the tick.
    fn only(window_ids: &[&str]) -> Self {
        Self(Ok(LiveWindowIndex::from_pairs(
            window_ids.iter().map(|id| (*id, AGENT_TMUX_SESSION)),
        )))
    }

    fn unavailable() -> Self {
        Self(Err("tmux server not running".to_owned()))
    }
}

impl LiveWindowSource for FakeLiveWindows {
    fn live_window_ids<'a>(
        &'a mut self,
        _surface: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<LiveWindowIndex, String>> + Send + 'a>,
    > {
        Box::pin(async move { self.0.clone() })
    }
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
        _created_after_ms: Option<u128>,
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

/// The bug this file exists to prevent, in the shape that actually happened:
/// the snapshot was rebuilt from "who is backed by a live window right now", so
/// when a tmux server took every window with it, nine recorded sessions were
/// overwritten with the two whose ids happened to still match. The snapshot
/// must only shrink when a human stops an agent.
#[test]
fn a_session_that_lost_its_window_stays_in_the_snapshot() {
    let project = TestProject::new("window-loss-retention");
    project.run_task();
    assert_eq!(
        session_ids(&project.snapshot().expect("both agents recorded")),
        AGENT_IDS
    );

    // codex-two's window is gone; claude-one's survived. Nobody stopped
    // anything, and the topology still holds both sessions.
    project.run_task_with_only_live_windows(&[AGENT_WINDOW_IDS[0]]);

    let snapshot = project.snapshot().expect("snapshot survives the loss");
    assert_eq!(
        session_ids(&snapshot),
        AGENT_IDS,
        "an agent whose window vanished is still restorable and stays recorded"
    );
}

/// The other direction: the retention must not resurrect an agent a human
/// stopped. Stop is the one thing that removes a session from the record.
#[test]
fn a_stopped_session_is_not_retained_by_the_next_tick() {
    let project = TestProject::new("stop-beats-retention");
    project.run_task();
    project.stop_agent(AGENT_IDS[1]);

    project.run_task_with_only_live_windows(&[AGENT_WINDOW_IDS[0]]);

    let snapshot = project.snapshot().expect("the other agent is still there");
    assert_eq!(
        session_ids(&snapshot),
        vec![AGENT_IDS[0].to_owned()],
        "a deliberately stopped agent must not come back through retention"
    );
}

/// Retention keeps a session only while the project is still willing to
/// restore it. A session the graveyard finished is not restorable, so it must
/// fall out of the snapshot on the next tick rather than being carried forward
/// forever by a lost window.
#[test]
fn a_graveyarded_session_is_not_retained_by_the_next_tick() {
    let project = TestProject::new("graveyard-not-retained");
    project.run_task();
    project.set_session_status(AGENT_IDS[1], "graveyard");

    project.run_task_with_only_live_windows(&[AGENT_WINDOW_IDS[0]]);

    let snapshot = project.snapshot().expect("the other agent is still there");
    assert_eq!(
        session_ids(&snapshot),
        vec![AGENT_IDS[0].to_owned()],
        "a finished session must not be retained on the strength of a lost window"
    );
}

/// The regression Sam hit: ten agents were running the whole time, aimux
/// offered to restore them anyway, and the restore answered "this session has
/// nothing to restore" and dropped him out of the dashboard.
///
/// The snapshot had carried the previous run's writer id forward because the
/// session set was unchanged, so a live run's own record looked foreign
/// forever and the offer kept firing.
#[test]
fn agents_this_run_can_see_running_are_never_offered_back() {
    let project = TestProject::new("live-agents-not-offered");
    project.run_task();
    project.simulate_process_death();
    project.seed_prompt_gates("boot-with-agents-still-up");

    // The new run sees both agents alive — nothing went away.
    project.run_task();

    assert!(
        project.offer().is_none(),
        "a run that can see its agents running must not offer to restore them"
    );
}

/// The other direction, unchanged: a run that sees nothing alive is describing
/// the previous run's agents, and that is exactly when the offer belongs.
#[test]
fn agents_no_run_can_see_are_still_offered_back() {
    let project = TestProject::new("dead-agents-offered");
    project.run_task();
    project.simulate_process_death();
    project.seed_prompt_gates("boot-after-crash");

    project.run_task_with_no_live_windows();

    assert!(
        project.offer().is_some(),
        "agents that died with the previous run are what the offer exists for"
    );
}

/// The restore replays the snapshot array in order, creating one window per
/// entry, so the array has to hold tmux window order — not whatever order the
/// topology happens to list its sessions in. Otherwise every restart walks the
/// agents somewhere new.
#[test]
fn the_snapshot_records_agents_in_tmux_window_order() {
    let project = TestProject::new("snapshot-window-order");
    project.run_task();
    let first = project.snapshot().expect("snapshot recorded");
    assert_eq!(session_ids(&first), vec!["claude-one", "codex-two"]);

    // claude-one moves behind codex-two in tmux. The topology array does not move.
    project.set_window_index("claude-one", 5);
    project.run_task();
    let second = project.snapshot().expect("snapshot recorded");
    assert_eq!(session_ids(&second), vec!["codex-two", "claude-one"]);
    // Same agents, so the same generation: the prompt gate and the ack key on
    // this id, and reordering must not mint a new one.
    assert_eq!(second["id"], first["id"]);
    assert_eq!(second["createdAt"], first["createdAt"]);
}

/// The snapshot is the order the windows come back in, so it orders by class
/// first like every other surface -- and it has to merge the stored control
/// flags to see a class at all.
///
/// Nothing writes `overseer`, `scribe` or `projectControl` into the topology
/// file: `upsert_agent_topology` persists `role`, `lane`, `roleState` and
/// `team`, and promotion and demotion write metadata state. Ordering the raw
/// topology rows therefore read every agent as a coder, so the ladder was
/// inert here while every other surface had it.
#[test]
fn the_snapshot_orders_an_overseer_first_from_metadata_alone() {
    let project = TestProject::new("snapshot-class-order");
    project.run_task();
    assert_eq!(
        session_ids(&project.snapshot().expect("snapshot recorded")),
        vec!["claude-one", "codex-two"],
        "two coders, so the window order decides"
    );

    // codex-two holds the later window and is promoted in metadata only.
    project.mark_overseer_in_metadata_only("codex-two");
    project.run_task();

    assert_eq!(
        session_ids(&project.snapshot().expect("snapshot recorded")),
        vec!["codex-two", "claude-one"],
        "the overseer leads although its window is still the later one"
    );
}

/// An offer nobody answered must not outlive the boot that asked.
///
/// The snapshot is deliberately retentive, so its id changes only when the SET
/// of agents changes, and the boot gate is re-seeded from whatever snapshot is
/// on disk. An offer keyed on the snapshot id alone therefore matched every
/// later boot's gate for ever: `~/.aimux/projects` held eight live offer files
/// written between 2026-09-09 and 2026-10-23, every one still displayable, each
/// frozen at whatever subset the last partial restore or decay had left it.
/// Because the dashboard's dismissal is only in memory, every new TUI process
/// asked again.
///
/// What this asserts is the file: which boot it belongs to, and that the set is
/// re-derived whole rather than served frozen. The dangerous half -- pressing
/// Enter on a six-week-old offer and launching six-week-old agents -- is
/// asserted through the real restore route by the two tests below.
#[test]
fn an_unanswered_offer_does_not_outlive_its_daemon_boot() {
    let project = TestProject::new("offer-per-boot");
    project.run_task();
    let snapshot = project.snapshot().expect("agents recorded while running");

    project.simulate_process_death();
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();
    let offered = project
        .offer()
        .expect("the crash is offered in its own boot");
    assert_eq!(
        offered["daemonBootId"], "boot-1",
        "the offer records the boot that authorized it: {offered}"
    );

    // Frozen at a subset, which is what a partial restore or a decay leaves and
    // what every stale file on the real machine looked like.
    project.shrink_offer_to(&[AGENT_IDS[0]]);

    // A new daemon boot. Same agents, so the same snapshot id -- that is the
    // trap -- but a different occasion.
    let gate = project.seed_prompt_gates("boot-2");
    assert_eq!(
        gate["snapshotId"], snapshot["id"],
        "the same agents still carry the same snapshot id"
    );
    project.run_task_with_no_live_windows();

    let offer = project
        .offer()
        .expect("the crash is still unanswered, so it is still offered");
    assert_eq!(
        offer["daemonBootId"], "boot-2",
        "a boot-1 offer must not be served in boot-2: {offer}"
    );
    assert_eq!(
        session_ids(&offer),
        AGENT_IDS,
        "re-deriving must offer the whole snapshot, not the subset the stale \
         file was frozen at: {offer}"
    );
}

/// The inverse: scoping an offer to a boot must not break the boot it belongs
/// to. A guard that refuses the real case is not a guard.
///
/// `accepted` is what proves it was served, not merely stored: the restore
/// route's first act is the same read surface `/desktop-state` renders from, and
/// an offer that read surface refuses answers `accepted: false`.
#[test]
fn an_offer_from_this_boot_is_still_served_and_restorable() {
    let project = TestProject::new("offer-this-boot");
    project.run_task();
    project.simulate_process_death();
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();
    assert!(project.offer().is_some(), "the offer exists to be answered");

    let outcome = project.accept_restore_offer();
    assert_eq!(
        outcome["accepted"], true,
        "an offer from this boot must still restore: {outcome}"
    );
    assert_eq!(outcome["total"], AGENT_IDS.len());
}

/// The shape every offer file on the real machine had: no boot stamp at all,
/// because the field did not exist when they were written. An offer that cannot
/// be attributed to an occasion is foreign -- the same reasoning an undatable
/// acknowledgement gets -- so it is dropped rather than trusted for ever.
#[test]
fn an_offer_with_no_boot_stamp_is_not_shown_and_cannot_be_restored() {
    let project = TestProject::new("offer-unstamped");
    project.run_task();
    project.simulate_process_death();
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();
    project.strip_offer_boot_stamp();

    // The read surface: pressing Enter on it must restore nothing.
    let outcome = project.accept_restore_offer();
    assert_eq!(
        outcome["accepted"], false,
        "an unattributable offer must not launch agents: {outcome}"
    );
    assert_eq!(outcome["offer"], Value::Null);
}

/// Two surfaces decide whether an offer may be shown -- the read path that
/// `/desktop-state` and the restore route share, and the derive on the tick
/// loop -- and they must answer the same way about the same file. Each had its
/// own copy of the rule, so keeping them in step was luck rather than
/// construction.
///
/// Compared against each other on one fixture rather than asserted once per
/// surface, because a per-surface test passes happily while the surfaces
/// disagree. Whichever looks first must refuse the stale offer AND clear it.
#[test]
fn a_stale_offer_is_refused_and_cleared_by_whichever_surface_sees_it_first() {
    let stale_offer_in_a_later_boot = |name: &str| {
        let project = TestProject::new(name);
        project.run_task();
        project.simulate_process_death();
        project.seed_prompt_gates("boot-1");
        project.run_task_with_no_live_windows();
        let offered = project.offer().expect("an offer to go stale");
        assert_eq!(offered["daemonBootId"], "boot-1");
        // A new boot, with the boot-1 file left exactly as it is.
        project.seed_prompt_gates("boot-2");
        project
    };

    // The read surface, with no derive in between.
    let read_first = stale_offer_in_a_later_boot("offer-read-first");
    let outcome = read_first.accept_restore_offer();
    assert_eq!(
        outcome["accepted"], false,
        "the read surface must refuse a stale offer: {outcome}"
    );
    assert!(
        read_first.offer().is_none(),
        "the read surface must clear what it refused: {:?}",
        read_first.offer()
    );

    // The derive surface, on the identical state.
    let derive_first = stale_offer_in_a_later_boot("offer-derive-first");
    derive_first.run_task_with_no_live_windows();
    let rederived = derive_first
        .offer()
        .expect("the crash is unanswered, so it is offered again");
    assert_eq!(
        rederived["daemonBootId"], "boot-2",
        "the derive surface must clear the stale file rather than serve it: {rederived}"
    );
}

/// Saying no has to stick.
///
/// The acknowledgement is scoped to the boot that made it, because accepting a
/// restore that did not work once muted twenty agents across every later
/// restart. Dismissing was scoped the same way -- and dismissing is an answer
/// about this fleet, not about this occasion, so it did not stick at all. That
/// is why a reinstall re-offered agents that died six weeks earlier and had
/// already been turned down: eight such offers were live on this machine.
#[test]
fn a_dismissal_lasts_past_the_boot_that_made_it() {
    let project = TestProject::new("dismiss-lasts");
    project.run_task();
    project.simulate_process_death_as("run-that-died");
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();
    assert!(project.offer().is_some(), "the crash is offered once");

    project.dismiss_restore_offer();
    let ack = project.ack().expect("the dismissal is recorded");
    assert_eq!(ack["answer"], "dismissed", "{ack}");
    assert_eq!(
        ack["writerInstanceId"], "run-that-died",
        "the dismissal names the fleet it answered: {ack}"
    );

    // Two more boots. Same agents, still dead, still unwanted.
    for boot in ["boot-2", "boot-3"] {
        project.seed_prompt_gates(boot);
        project.run_task_with_no_live_windows();
        assert!(
            project.offer().is_none(),
            "a dismissed fleet must not be offered again in {boot}: {:?}",
            project.offer()
        );
    }
}

/// And it must not stick too far. Agents that have been alive again are a new
/// fleet, however the set compares -- the snapshot id is reused whenever the
/// SET is unchanged, so a lasting answer keyed on it would be exactly the
/// "twenty agents went offline with no prompt" failure in the other direction.
#[test]
fn a_dismissal_does_not_mute_agents_that_have_been_alive_again() {
    let project = TestProject::new("dismiss-not-forever");
    project.run_task();
    project.simulate_process_death_as("first-run");
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();
    project.dismiss_restore_offer();

    // The same agents, up again and then killed again, which is a different
    // run's observation even though the set -- and so the snapshot id -- is
    // identical.
    let snapshot_id = project
        .snapshot()
        .expect("snapshot")
        .get("id")
        .and_then(Value::as_str)
        .expect("snapshot id")
        .to_owned();
    project.run_task();
    project.simulate_process_death_as("second-run");
    assert_eq!(
        project.snapshot().expect("snapshot")["id"],
        snapshot_id,
        "the set is unchanged, so the snapshot id is the same one -- that is \
         the trap this test exists for"
    );

    project.seed_prompt_gates("boot-2");
    project.run_task_with_no_live_windows();
    let offer = project
        .offer()
        .expect("a second death of the same agents must be offered again");
    assert_eq!(session_ids(&offer), AGENT_IDS);
}

/// An accepted restore keeps the old rule, and must: the restore that mutes
/// everything after it is the one that did not work.
#[test]
fn accepting_a_restore_is_still_spent_by_its_own_boot() {
    let project = TestProject::new("accept-per-boot");
    project.run_task();
    project.simulate_process_death_as("run-that-died");
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();

    let outcome = project.accept_restore_offer();
    assert_eq!(outcome["accepted"], true, "{outcome}");
    let ack = project.ack().expect("the acceptance is recorded");
    assert_eq!(ack["answer"], "restored", "{ack}");

    // The stub runtime cannot create windows, so nothing actually came back.
    // Within this boot the acceptance answers for it; the next boot must ask.
    //
    // Re-seeded on the SAME boot before asserting, because accepting also
    // stamps the gate's `askedAt` and the fresh derive bails on that before it
    // ever reads the acknowledgement. Without the re-seed this half of the test
    // passes whatever the ack says, which is exactly how it was wrong.
    project.remove_offer();
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();
    assert!(
        project.offer().is_none(),
        "an acceptance answers for its own boot: {:?}",
        project.offer()
    );
    project.seed_prompt_gates("boot-2");
    project.run_task_with_no_live_windows();
    assert!(
        project.offer().is_some(),
        "a restore that did not work must be asked about again next boot"
    );
}

/// A restore that stopped short has to say so, and the saying has to survive
/// the trip through disk.
///
/// Restoring resumes every agent's task and those tasks run test suites, so the
/// route asks the host for capacity between launches and stops while it can
/// still say no -- restoring a whole fleet at once once emptied 61GB of RAM on
/// sam-strix. The leftovers come back as a retry offer, and that offer was
/// rendered with the same wording as a first one, so the reason appeared once in
/// the footer and was unreachable after that. It read as aimux asking the same
/// question again.
///
/// Asserted through the real route and then through the read surface the
/// dashboard renders from, because the field is only useful if it survives
/// `normalize_agent_restore_offer`, which rebuilds the offer from scratch.
#[test]
fn a_retry_offer_carries_what_stopped_the_restore() {
    let project = TestProject::new("retry-says-why");
    project.run_task();
    project.simulate_process_death();
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();

    // The stub runtime refuses every window, so every offered agent fails.
    let outcome = project.accept_restore_offer();
    let failed = outcome["failed"].as_array().expect("failures");
    assert_eq!(failed.len(), AGENT_IDS.len(), "{outcome}");

    assert!(project.offer().is_some(), "the leftovers are offered back");

    // Read back through the surface the dashboard renders from rather than off
    // disk: `normalize_agent_restore_offer` rebuilds the offer from scratch, so
    // a field it does not list is dropped on the way out and the prompt would
    // never see it. The restore route's own first act is that read, and it
    // returns what it read.
    let served = project.accept_restore_offer();
    let retry = &served["offer"];
    let recorded = retry["restoreFailures"]
        .as_array()
        .expect("the retry offer records what failed");
    assert_eq!(recorded.len(), AGENT_IDS.len(), "{retry}");
    assert_eq!(
        recorded[0]["error"], failed[0]["error"],
        "the reason travels with the leftovers, not just the response: {retry}"
    );
}

/// And it stops saying so once the agent it names is no longer offered. Every
/// writer clones the offer forward, so an agent that came back on its own would
/// otherwise stay named as a failure in the prompt for the rest of the boot.
#[test]
fn a_failure_stops_being_reported_once_that_agent_is_no_longer_offered() {
    let project = TestProject::new("retry-decays");
    project.run_task();
    project.simulate_process_death();
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();
    project.accept_restore_offer();
    assert!(
        project.offer().expect("retry offer")["restoreFailures"]
            .as_array()
            .is_some_and(|failures| failures.len() == AGENT_IDS.len())
    );

    // One of them comes back on its own, which is what decay is for.
    project.run_task_with_only_live_windows(&AGENT_WINDOW_IDS[..1]);
    let decayed = project.offer().expect("the other is still offered");
    assert_eq!(
        session_ids(&decayed),
        [AGENT_IDS[1]],
        "decay drops the agent that came back: {decayed}"
    );
    let recorded = decayed["restoreFailures"]
        .as_array()
        .expect("the remaining failure is still reported");
    assert_eq!(recorded.len(), 1, "{decayed}");
    assert_eq!(recorded[0]["sessionId"], AGENT_IDS[1], "{decayed}");
}

/// An offer that stopped being restorable was not answered by anyone, and some
/// of the paths that notice run on their own.
///
/// `prune_restore_eligibility` is reached from `aimux agent stop` and `kill`,
/// but also from the retired-worktree reaper and the dead-agent reap. Recording
/// those as a dismissal would let an automatic sweep write a lasting "no"
/// nobody said -- the one answer that outlives its boot.
#[test]
fn an_offer_that_lapsed_is_not_recorded_as_a_dismissal() {
    let project = TestProject::new("offer-lapsed");
    project.run_task();
    project.simulate_process_death_as("run-that-died");
    project.seed_prompt_gates("boot-1");
    project.run_task_with_no_live_windows();
    assert_eq!(session_ids(&project.offer().expect("offer")), AGENT_IDS);

    // Stop every agent the offer named, which empties it.
    for session_id in AGENT_IDS {
        project.stop_agent(session_id);
    }
    assert!(
        project.offer().is_none(),
        "an emptied offer is not an offer: {:?}",
        project.offer()
    );
    let ack = project.ack().expect("the lapse is recorded");
    assert_eq!(
        ack["answer"], "lapsed",
        "an automatic prune must not read as a human saying no: {ack}"
    );
    assert_ne!(ack["answer"], "dismissed", "{ack}");
}

/// A fleet that dies after the boot is still offered.
///
/// The gate records the snapshot generation that was on disk at daemon boot,
/// and nothing moved it afterwards -- while the snapshot id rolls whenever the
/// SET of agents changes. So starting one agent after boot left the gate naming
/// a generation that no longer existed, and when the whole fleet died later
/// that boot there was no prompt at all. Which is the shape of the failure the
/// acknowledgement rules were written for, arriving by a different route.
#[test]
fn a_fleet_that_dies_after_an_agent_started_is_still_offered() {
    let project = TestProject::new("gate-follows-snapshot");
    project.run_task();
    let boot_snapshot_id = project
        .snapshot()
        .expect("snapshot")
        .get("id")
        .and_then(Value::as_str)
        .expect("snapshot id")
        .to_owned();
    let gate = project.seed_prompt_gates("boot-1");
    assert_eq!(gate["snapshotId"], boot_snapshot_id);

    // One more agent joins, which changes the SET and so mints a new snapshot
    // generation. The gate still names the one it was seeded with.
    project.add_agent("claude-three", "@2");
    project.run_task_with_only_live_windows(&["@0", "@1", "@2"]);
    let rolled = project.snapshot().expect("snapshot");
    assert_ne!(
        rolled["id"], boot_snapshot_id,
        "a changed set must mint a new generation, or this test proves nothing: {rolled}"
    );

    // Now everything dies.
    project.simulate_process_death_as("run-that-died");
    project.run_task_with_no_live_windows();

    let offer = project
        .offer()
        .expect("a fleet that died after the boot must still be offered");
    assert_eq!(
        offer["snapshotId"], rolled["id"],
        "the offer names the generation that actually died: {offer}"
    );
    assert_eq!(offer["daemonBootId"], "boot-1", "{offer}");
    assert_eq!(
        session_ids(&offer),
        // Canonical order, which is what the restore replays.
        ["claude-one", "claude-three", "codex-two"],
        "every agent that died is offered, including the one that joined: {offer}"
    );

    // And the next tick leaves it alone. The offer names a generation the gate
    // does not, so a currency rule that compared generations as well as boots
    // would reject the offer the derive had just written, delete it, and derive
    // it again -- on every tick, for ever. The contents would look right the
    // whole time, so what is asserted is that the file was not rewritten.
    std::thread::sleep(Duration::from_millis(5));
    project.run_task_with_no_live_windows();
    let still = project
        .offer()
        .expect("the offer must survive the tick after the one that wrote it");
    assert_eq!(
        still["createdAt"], offer["createdAt"],
        "the offer was rewritten rather than served: {still}"
    );
    assert_eq!(still["snapshotId"], rolled["id"], "{still}");
    assert_eq!(
        session_ids(&still),
        ["claude-one", "claude-three", "codex-two"],
        "{still}"
    );
}
