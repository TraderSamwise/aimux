use aimux::runtime_topology::{
    empty_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::runtime_topology_services::list_topology_service_states;
use aimux::service_state_snapshot::{
    ServiceStateSnapshotRuntime, stop_project_tmux_runtime_with_service_snapshots_using,
};
use aimux::tmux::{TmuxManagedWindow, TmuxTarget};
use aimux::tmux_runtime_stop::TmuxRuntimeStopManager;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Stopping a runtime kills every pane in it, and the restore snapshot is the
/// only way back. On sam-strix on 2026-10-04 a teardown that checked nothing
/// took 37 live agents with it.
///
/// The snapshot is consulted, never rewritten: rewriting would mint a new
/// snapshot id that the boot-stamped prompt gate no longer matches, which
/// suppresses the very restore offer this protects.
fn seed_topology_with_sessions(state_dir: &Path, repo_root: &Path, ids: &[&str]) {
    let rows = ids.iter().map(|id| (*id, "running")).collect::<Vec<_>>();
    seed_topology_with_statuses(state_dir, repo_root, &rows);
}

fn seed_topology_with_statuses(state_dir: &Path, repo_root: &Path, rows: &[(&str, &str)]) {
    const AT: &str = "2026-10-04T00:00:00.000Z";
    // A session is only part of the topology if its node, and that node's rig,
    // are there too -- the reader prunes dangling ones, so a fixture without
    // them silently describes an empty runtime.
    let mut topology = empty_runtime_topology();
    topology["rigs"] = json!([{
        "id": "rig-1",
        "name": "repo",
        "projectRoot": repo_root.to_string_lossy(),
        "createdAt": AT,
        "updatedAt": AT,
    }]);
    topology["nodes"] = Value::Array(
        rows.iter()
            .map(|(id, _)| {
                json!({
                    "id": format!("node-{id}"),
                    "rigId": "rig-1",
                    "logicalId": id,
                    "createdAt": AT,
                })
            })
            .collect(),
    );
    topology["sessions"] = Value::Array(
        rows.iter()
            .map(|(id, status)| {
                json!({
                    "id": id,
                    "nodeId": format!("node-{id}"),
                    "status": status,
                    "createdAt": AT,
                    "updatedAt": AT,
                })
            })
            .collect(),
    );
    write_runtime_topology(runtime_topology_path(state_dir), &topology).expect("seed topology");
}

fn stop_fixture(label: &str) -> (PathBuf, PathBuf, FakeTmux) {
    let root = temp_root(label);
    let repo_root = root.join("repo");
    let state_dir = root.join("state");
    fs::create_dir_all(&repo_root).expect("repo root");
    fs::create_dir_all(&state_dir).expect("state dir");
    let tmux = FakeTmux {
        calls: Vec::new(),
        available: true,
        host_session: "aimux-repo".into(),
        sessions: vec!["aimux-repo".into()],
        repo_root: repo_root.clone(),
        windows: Vec::new(),
    };
    (repo_root, state_dir, tmux)
}

#[test]
fn stop_runtime_refuses_when_a_live_agent_is_in_no_restore_snapshot() {
    let (repo_root, state_dir, mut tmux) = stop_fixture("service-state-snapshot-unrecorded");
    seed_topology_with_sessions(&state_dir, &repo_root, &["codex-aaa", "codex-bbb"]);
    // The snapshot records one of the two. Killing would lose the other with
    // no record of how to bring it back.
    fs::write(
        state_dir.join("last-online-agents.json"),
        json!({
            "version": 1,
            "sessionIds": ["codex-aaa"],
            "sessions": [{ "id": "codex-aaa" }],
        })
        .to_string(),
    )
    .expect("seed snapshot");

    let error = stop_project_tmux_runtime_with_service_snapshots_using(
        &mut tmux, &repo_root, &state_dir, false,
    )
    .expect_err("an unrecorded live agent must stop the teardown");

    assert!(
        error.contains("codex-bbb"),
        "the refusal must name the agent that would be lost: {error}"
    );
    assert!(
        !error.contains("codex-aaa"),
        "an agent that IS recorded must not be reported as at risk: {error}"
    );
    assert!(
        !tmux
            .calls
            .iter()
            .any(|call| call.starts_with("killSession:")),
        "nothing may be killed once the check refused: {:?}",
        tmux.calls
    );
    assert!(
        !state_dir.join("state.json").exists(),
        "a refusal must leave nothing half-written"
    );
}

/// The guard has to let the ordinary case through, or it just bricks `stop`.
#[test]
fn stop_runtime_proceeds_when_every_live_agent_is_recorded() {
    let (repo_root, state_dir, mut tmux) = stop_fixture("service-state-snapshot-recorded");
    seed_topology_with_sessions(&state_dir, &repo_root, &["codex-aaa"]);
    fs::write(
        state_dir.join("last-online-agents.json"),
        json!({
            "version": 1,
            "sessionIds": ["codex-aaa"],
            "sessions": [{ "id": "codex-aaa" }],
        })
        .to_string(),
    )
    .expect("seed snapshot");

    let killed = stop_project_tmux_runtime_with_service_snapshots_using(
        &mut tmux, &repo_root, &state_dir, false,
    )
    .expect("a recorded runtime stops normally");

    assert_eq!(killed, vec!["aimux-repo"]);
}

/// A project with nothing running has nothing to lose, so an empty topology
/// and an absent snapshot must not block a stop.
#[test]
fn stop_runtime_proceeds_when_there_are_no_agents_to_lose() {
    let (repo_root, state_dir, mut tmux) = stop_fixture("service-state-snapshot-empty");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("seed topology");

    let killed = stop_project_tmux_runtime_with_service_snapshots_using(
        &mut tmux, &repo_root, &state_dir, false,
    )
    .expect("an empty runtime stops normally");

    assert_eq!(killed, vec!["aimux-repo"]);
}

/// `aimux agent stop` leaves the session `offline` in the topology and
/// deliberately prunes it from the restore snapshot. Comparing against
/// "everything not graveyard/exited" counted that as an agent at risk, so one
/// ordinary agent stop made every later `restart` and `daemon stop` refuse
/// forever, with no way past it. Only agents that are actually up can be lost.
#[test]
fn stop_runtime_ignores_an_agent_the_user_already_stopped() {
    let (repo_root, state_dir, mut tmux) = stop_fixture("service-state-snapshot-offline");
    seed_topology_with_statuses(
        &state_dir,
        &repo_root,
        &[("codex-aaa", "running"), ("codex-stopped", "offline")],
    );
    // The snapshot records only the running one, which is exactly what
    // `agent stop` leaves behind.
    fs::write(
        state_dir.join("last-online-agents.json"),
        json!({
            "version": 1,
            "sessionIds": ["codex-aaa"],
            "sessions": [{ "id": "codex-aaa" }],
        })
        .to_string(),
    )
    .expect("seed snapshot");

    let killed = stop_project_tmux_runtime_with_service_snapshots_using(
        &mut tmux, &repo_root, &state_dir, false,
    )
    .expect("a stopped agent is not an agent at risk");

    assert_eq!(killed, vec!["aimux-repo"]);
}

/// A guard on the only path that stops anything needs a way past it, or one
/// unrecordable project becomes a daemon that cannot be stopped at all.
#[test]
fn stop_runtime_can_be_forced_past_the_restore_check() {
    let (repo_root, state_dir, mut tmux) = stop_fixture("service-state-snapshot-forced");
    seed_topology_with_sessions(&state_dir, &repo_root, &["codex-aaa"]);

    let refused = stop_project_tmux_runtime_with_service_snapshots_using(
        &mut tmux, &repo_root, &state_dir, false,
    );
    assert!(refused.is_err(), "unrecorded agent must refuse by default");

    let killed = stop_project_tmux_runtime_with_service_snapshots_using(
        &mut tmux, &repo_root, &state_dir, true,
    );

    assert_eq!(killed.expect("forced stop proceeds"), vec!["aimux-repo"]);
}

/// The topology is the record of what would die. Unreadable is not empty.
#[test]
fn stop_runtime_refuses_when_the_topology_cannot_be_read() {
    let (repo_root, state_dir, mut tmux) = stop_fixture("service-state-snapshot-unreadable");
    fs::write(runtime_topology_path(&state_dir), b"{ not json").expect("corrupt topology");

    let error = stop_project_tmux_runtime_with_service_snapshots_using(
        &mut tmux, &repo_root, &state_dir, false,
    )
    .expect_err("an unreadable topology must not be treated as an empty one");

    assert!(error.contains("topology"), "{error}");
    assert!(
        !tmux
            .calls
            .iter()
            .any(|call| call.starts_with("killSession:")),
        "nothing may be killed once the check refused: {:?}",
        tmux.calls
    );
}

#[test]
fn stop_runtime_persists_service_snapshot_before_killing_tmux_sessions() {
    let root = temp_root("service-state-snapshot-stop");
    let repo_root = root.join("repo");
    let state_dir = root.join("state");
    fs::create_dir_all(&repo_root).expect("repo root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("seed topology");

    let host_session = "aimux-repo";
    let client_session = "aimux-repo-client-deadbeef";
    let mut tmux = FakeTmux {
        calls: Vec::new(),
        available: true,
        host_session: host_session.into(),
        sessions: vec![client_session.into(), host_session.into()],
        repo_root: repo_root.clone(),
        windows: vec![TmuxManagedWindow {
            target: TmuxTarget {
                session_name: host_session.into(),
                window_id: "@2".into(),
                window_index: 2,
                window_name: "web".into(),
                pane_dead: None,
            },
            metadata: json!({
                "kind": "service",
                "sessionId": "service-1",
                "launchCommandLine": "yarn web",
                "worktreePath": repo_root,
                "label": "web",
                "createdAt": "2026-05-01T00:00:00.000Z",
                "args": [],
            }),
        }],
    };

    let killed = stop_project_tmux_runtime_with_service_snapshots_using(
        &mut tmux, &repo_root, &state_dir, false,
    )
    .expect("stop runtime with snapshots");

    assert_eq!(killed, vec![client_session, host_session]);
    let snapshot_index = call_index(&tmux.calls, "listProjectManagedWindows");
    let first_kill_index = tmux
        .calls
        .iter()
        .position(|call| call.starts_with("killSession:"))
        .expect("kill call");
    assert!(
        snapshot_index < first_kill_index,
        "service windows must be snapshotted before killing tmux sessions: {:?}",
        tmux.calls
    );
    assert_eq!(tmux.calls.last().map(String::as_str), Some("refreshStatus"));

    let state: Value =
        serde_json::from_slice(&fs::read(state_dir.join("state.json")).expect("read state"))
            .expect("parse state");
    assert_eq!(
        state["services"][0]["launchCommandLine"],
        Value::String("yarn web".into())
    );
    assert!(
        state["services"][0].get("tmuxTarget").is_none(),
        "persisted compatibility state must not retain stale tmux targets"
    );

    let topology =
        read_runtime_topology(runtime_topology_path(&state_dir)).expect("read runtime topology");
    let stopped = list_topology_service_states(&topology, Some(&["stopped"]));
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0]["id"], Value::String("service-1".into()));
    assert_eq!(stopped[0]["status"], Value::String("stopped".into()));
    assert!(
        stopped[0].get("tmuxTarget").is_none(),
        "stopped topology services must not keep live tmux bindings"
    );
}

struct FakeTmux {
    calls: Vec<String>,
    available: bool,
    host_session: String,
    sessions: Vec<String>,
    repo_root: PathBuf,
    windows: Vec<TmuxManagedWindow>,
}

impl TmuxRuntimeStopManager for FakeTmux {
    fn is_available(&mut self) -> bool {
        self.calls.push("isAvailable".into());
        self.available
    }

    fn project_session_name(&mut self, project_root: &str) -> String {
        self.calls.push(format!("getProjectSession:{project_root}"));
        self.host_session.clone()
    }

    fn list_session_names(&mut self) -> Result<Vec<String>, String> {
        self.calls.push("listSessionNames".into());
        Ok(self.sessions.clone())
    }

    fn has_session(&mut self, session_name: &str) -> bool {
        self.calls.push(format!("hasSession:{session_name}"));
        true
    }

    fn kill_session(&mut self, session_name: &str) -> Result<(), String> {
        self.calls.push(format!("killSession:{session_name}"));
        Ok(())
    }
}

impl ServiceStateSnapshotRuntime for FakeTmux {
    fn list_project_managed_windows(
        &mut self,
        project_root: &Path,
    ) -> Result<Vec<TmuxManagedWindow>, String> {
        self.calls.push(format!(
            "listProjectManagedWindows:{}",
            project_root.display()
        ));
        Ok(self.windows.clone())
    }

    fn display_message(&mut self, format: &str, target: &str) -> Option<String> {
        self.calls.push(format!("displayMessage:{format}:{target}"));
        Some(self.repo_root.to_string_lossy().into_owned())
    }

    fn is_window_alive(&mut self, target: &TmuxTarget) -> Result<bool, String> {
        self.calls
            .push(format!("isWindowAlive:{}", target.window_id));
        Ok(true)
    }

    fn refresh_status(&mut self) {
        self.calls.push("refreshStatus".into());
    }

    fn path_exists(&mut self, path: &str) -> bool {
        path == self.repo_root.to_string_lossy()
    }
}

fn call_index(calls: &[String], prefix: &str) -> usize {
    calls
        .iter()
        .position(|call| call.starts_with(prefix))
        .unwrap_or_else(|| panic!("missing call with prefix {prefix}: {calls:?}"))
}

fn temp_root(prefix: &str) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    path
}
