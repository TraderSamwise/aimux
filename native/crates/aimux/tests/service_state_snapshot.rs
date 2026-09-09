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

    let killed =
        stop_project_tmux_runtime_with_service_snapshots_using(&mut tmux, &repo_root, &state_dir)
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

    fn list_session_names(&mut self) -> Vec<String> {
        self.calls.push("listSessionNames".into());
        self.sessions.clone()
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
    fn list_project_managed_windows(&mut self, project_root: &Path) -> Vec<TmuxManagedWindow> {
        self.calls.push(format!(
            "listProjectManagedWindows:{}",
            project_root.display()
        ));
        self.windows.clone()
    }

    fn display_message(&mut self, format: &str, target: &str) -> Option<String> {
        self.calls.push(format!("displayMessage:{format}:{target}"));
        Some(self.repo_root.to_string_lossy().into_owned())
    }

    fn is_window_alive(&mut self, target: &TmuxTarget) -> bool {
        self.calls
            .push(format!("isWindowAlive:{}", target.window_id));
        true
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
