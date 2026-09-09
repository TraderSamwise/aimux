use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::runtime_events::route_runtime_event_with_context;
use aimux::runtime_topology::{
    list_topology_session_states, runtime_topology_path, write_runtime_topology,
};
use aimux::runtime_topology_services::upsert_topology_service;
use aimux::runtime_topology_sessions::upsert_topology_session;
use aimux::runtime_topology_state_save::reconcile_runtime_topology_sessions_on_state_save_at;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

const NOW: &str = "2026-05-30T00:00:00.000Z";
const LATER: &str = "2026-05-30T00:01:00.000Z";

#[test]
fn state_save_reconciles_sessions_with_removed_session_ids_without_tmux_polling() {
    let temp = TempDir::new("aimux-runtime-topology-state-save");
    let project_root = temp.path().join("repo");
    let project_state_dir = temp.path().join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&project_state_dir).expect("project state");

    let mut topology = aimux::runtime_topology::empty_runtime_topology();
    upsert_topology_session(
        &mut topology,
        &json!({
            "id": "quick-dead",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "args": [],
            "lifecycle": "offline",
            "createdAt": NOW,
        }),
        "offline",
        &project_root.to_string_lossy(),
        NOW,
    );
    upsert_topology_session(
        &mut topology,
        &json!({
            "id": "stale-offline",
            "tool": "claude",
            "toolConfigKey": "claude",
            "command": "claude",
            "args": [],
            "lifecycle": "offline",
            "backendSessionId": "backend-stale",
            "createdAt": NOW,
        }),
        "offline",
        &project_root.to_string_lossy(),
        NOW,
    );
    upsert_topology_service(
        &mut topology,
        &json!({
            "id": "svc-web",
            "label": "web",
            "launchCommandLine": "yarn web",
            "cwd": project_root.to_string_lossy(),
        }),
        "running",
        &project_root.to_string_lossy(),
        NOW,
    );
    write_runtime_topology(runtime_topology_path(&project_state_dir), &topology)
        .expect("write topology");

    let sessions = vec![
        json!({
            "id": "live-1",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "args": ["--resume"],
            "lifecycle": "live",
            "backendSessionId": "backend-live",
            "createdAt": LATER,
            "tmuxTarget": {
                "sessionName": "aimux-repo",
                "windowId": "@1",
                "windowIndex": 1,
                "windowName": "codex"
            },
        }),
        json!({
            "id": "restorable-dead",
            "tool": "claude",
            "toolConfigKey": "claude",
            "command": "claude",
            "args": [],
            "lifecycle": "offline",
            "backendSessionId": "backend-restorable",
            "createdAt": NOW,
        }),
    ];
    let removed_session_ids = vec!["quick-dead".to_owned()];

    let topology = reconcile_runtime_topology_sessions_on_state_save_at(
        &project_root,
        &project_state_dir,
        &sessions,
        &removed_session_ids,
        LATER,
    )
    .expect("reconcile state-save sessions");

    assert_eq!(status(&topology, "live-1"), Some("running"));
    assert_eq!(status(&topology, "restorable-dead"), Some("offline"));
    assert_eq!(status(&topology, "stale-offline"), Some("offline"));
    assert_eq!(
        status(&topology, "quick-dead"),
        None,
        "removedSessionIds from state save must prune unpreserved exits"
    );
    assert_eq!(
        topology["services"][0]["id"], "svc-web",
        "state-save session reconciliation must preserve service topology"
    );
}

#[test]
fn runtime_event_state_save_reconciles_removed_session_ids() {
    let temp = TempDir::new("aimux-runtime-topology-state-save-event");
    let project_root = temp.path().join("repo");
    let project_state_dir = temp.path().join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&project_state_dir).expect("project state");

    let mut topology = aimux::runtime_topology::empty_runtime_topology();
    upsert_topology_session(
        &mut topology,
        &json!({
            "id": "quick-dead",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "args": [],
            "lifecycle": "offline",
            "createdAt": NOW,
        }),
        "offline",
        &project_root.to_string_lossy(),
        NOW,
    );
    upsert_topology_session(
        &mut topology,
        &json!({
            "id": "live-1",
            "tool": "claude",
            "toolConfigKey": "claude",
            "command": "claude",
            "args": [],
            "lifecycle": "live",
            "createdAt": NOW,
        }),
        "running",
        &project_root.to_string_lossy(),
        NOW,
    );
    write_runtime_topology(runtime_topology_path(&project_state_dir), &topology)
        .expect("write topology");

    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &project_state_dir);
    let response = route_runtime_event_with_context(
        &context,
        &project_state_dir,
        "quick-dead",
        json!({
            "kind": "exit",
            "code": 1,
            "removedSessionIds": ["quick-dead"],
            "ts": LATER
        }),
    )
    .expect("runtime event response");

    assert_eq!(response.status, 200);
    let topology =
        aimux::runtime_topology::read_runtime_topology(runtime_topology_path(&project_state_dir))
            .expect("read topology");
    assert_eq!(
        status(&topology, "quick-dead"),
        None,
        "runtime event state-save removedSessionIds must prune the dead session"
    );
    assert_eq!(status(&topology, "live-1"), Some("running"));
}

fn status(topology: &Value, session_id: &str) -> Option<&'static str> {
    list_topology_session_states(topology, None)
        .into_iter()
        .find(|session| session["id"].as_str() == Some(session_id))
        .and_then(|session| match session["status"].as_str() {
            Some("running") => Some("running"),
            Some("offline") => Some("offline"),
            Some("graveyard") => Some("graveyard"),
            _ => None,
        })
}

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            NEXT_TEMP_ID.with(|next| {
                let mut next = next.borrow_mut();
                *next += 1;
                *next
            })
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

thread_local! {
    static NEXT_TEMP_ID: RefCell<u64> = const { RefCell::new(0) };
}
