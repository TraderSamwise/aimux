use aimux::project_service::runtime_topology_reconciler_task::{
    RuntimeTopologySessionReconcileDeps, reconcile_project_runtime_topology_sessions_with_deps,
};
use aimux::runtime_topology::{
    empty_runtime_topology, list_topology_session_states, runtime_topology_path,
    write_runtime_topology,
};
use aimux::runtime_topology_sessions::save_runtime_topology_sessions;
use aimux::tmux::{TmuxManagedWindow, TmuxTarget};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TempProject(PathBuf);

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl TempProject {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "aimux-runtime-topology-reconciler-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(path.join("state")).unwrap();
        Self(path)
    }

    fn root(&self) -> &Path {
        &self.0
    }

    fn state_dir(&self) -> PathBuf {
        self.0.join("state")
    }
}

#[derive(Default)]
struct FakeDeps {
    now: String,
    windows: Vec<TmuxManagedWindow>,
}

impl RuntimeTopologySessionReconcileDeps for FakeDeps {
    fn list_project_managed_windows(&mut self, _project_root: &Path) -> Vec<TmuxManagedWindow> {
        self.windows.clone()
    }

    fn now_iso(&mut self) -> String {
        self.now.clone()
    }
}

#[test]
fn reconciler_writes_live_windows_and_consumes_removed_dead_session_ids() {
    let project = TempProject::new("removed");
    let root = project.root().to_string_lossy().into_owned();
    let mut topology = empty_runtime_topology();
    let topology = save_runtime_topology_sessions(
        &mut topology,
        &[
            session_seed("quick-dead", "codex", None, "2026-09-10T00:00:04Z"),
            session_seed(
                "restorable-dead",
                "claude",
                Some("be-1"),
                "2026-09-10T00:00:01Z",
            ),
            session_seed(
                "stale-offline",
                "codex",
                Some("be-offline"),
                "2026-09-10T00:00:00Z",
            ),
        ],
        &root,
        "2026-09-10T00:00:00Z",
    );
    write_runtime_topology(runtime_topology_path(project.state_dir()), &topology).unwrap();
    let mut deps = FakeDeps {
        now: "2026-09-10T00:00:05Z".to_owned(),
        windows: vec![
            managed_window("live-1", "codex", None, false, "2026-09-10T00:00:02Z"),
            managed_window("quick-dead", "codex", None, true, "2026-09-10T00:00:04Z"),
            managed_window(
                "restorable-dead",
                "claude",
                Some("be-1"),
                true,
                "2026-09-10T00:00:01Z",
            ),
        ],
    };

    let topology = reconcile_project_runtime_topology_sessions_with_deps(
        project.root(),
        &project.state_dir(),
        &mut deps,
    )
    .expect("reconcile topology");
    let sessions = list_topology_session_states(&topology, None);

    assert_eq!(
        session_status(&sessions, "live-1").as_deref(),
        Some("running")
    );
    assert_eq!(
        session_status(&sessions, "restorable-dead").as_deref(),
        Some("offline")
    );
    assert_eq!(
        session_status(&sessions, "stale-offline").as_deref(),
        Some("offline")
    );
    assert!(session_status(&sessions, "quick-dead").is_none());
}

fn session_seed(id: &str, tool: &str, backend: Option<&str>, created_at: &str) -> Value {
    let mut session = json!({
        "id": id,
        "tool": tool,
        "toolConfigKey": tool,
        "command": tool,
        "args": [],
        "lifecycle": "offline",
        "createdAt": created_at,
    });
    if let Some(backend) = backend {
        session["backendSessionId"] = Value::String(backend.to_owned());
    }
    session
}

fn managed_window(
    session_id: &str,
    tool: &str,
    backend: Option<&str>,
    pane_dead: bool,
    created_at: &str,
) -> TmuxManagedWindow {
    let mut metadata = json!({
        "kind": "agent",
        "sessionId": session_id,
        "toolConfigKey": tool,
        "command": tool,
        "args": [],
        "createdAt": created_at,
    });
    if let Some(backend) = backend {
        metadata["backendSessionId"] = Value::String(backend.to_owned());
    }
    TmuxManagedWindow {
        target: TmuxTarget {
            session_name: "aimux-test".to_owned(),
            window_id: format!("%{session_id}"),
            window_index: 1,
            window_name: session_id.to_owned(),
            pane_dead: Some(pane_dead),
        },
        metadata,
    }
}

fn session_status(sessions: &[Value], session_id: &str) -> Option<String> {
    sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        .and_then(|session| session.get("status").and_then(Value::as_str))
        .map(str::to_owned)
}
