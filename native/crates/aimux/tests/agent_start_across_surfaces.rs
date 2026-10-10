//! `aimux start` and Enter, compared against each other: they answer one
//! question about one agent, and a test per surface passes happily while the
//! two disagree, which is how this class of bug survives.

mod support;

use aimux::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl};
use aimux::daemon::text::agents::{
    DaemonAgentTextRuntime, ProjectServicePostOptions, lifecycle_start_text_route,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::dashboard_actions::{DashboardActionKind, DashboardActionPlan, plan_dashboard_action};
use aimux::dashboard_model::{DesktopStateSnapshot, SessionStatus};
use aimux::dashboard_navigation::DashboardEntryRef;
use aimux::project_api_contract::routes;
use aimux::project_service::agents::LiveWindowIdsProjection;
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
    build_desktop_state_with_live_window_projection,
};
use aimux::runtime_topology::{
    coerce_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Only `@1` is live, so `windowed` is focusable and `windowless` is the stale
/// record resume exists for.
const LIVE_WINDOW: &str = "@1";

/// Every agent the comparison walks. One list, so a loop cannot quietly stop
/// covering a case the other loop still claims.
const COMPARED: &[&str] = &["windowed", "windowless", "resumable", "orphan", "teammate"];

struct Project {
    root: PathBuf,
    state_dir: PathBuf,
}

impl Project {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-agent-start-surfaces-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let state_dir = root.join("state");
        fs::create_dir_all(&state_dir).expect("state dir");
        let project = Self { root, state_dir };
        project.write_topology();
        save_metadata_state(
            &project.state_dir,
            &MetadataState {
                version: 1,
                sessions: BTreeMap::new(),
            },
        )
        .expect("write metadata");
        project
    }

    fn root_path(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    /// Every state the decision distinguishes, built from a real topology
    /// rather than a hand-written snapshot, so the fields are the ones the
    /// service actually publishes.
    fn write_topology(&self) {
        let sessions = vec![
            session_row("windowed", "running", json!({})),
            session_row("windowless", "running", json!({})),
            session_row(
                "resumable",
                "offline",
                json!({ "backendSessionId": "bk-1" }),
            ),
            session_row(
                "blocked",
                "offline",
                json!({ "restoreBlockedReason": "missing exact resumable backend session id" }),
            ),
            session_row("orphan", "running", json!({})),
            session_row(
                "teammate",
                "offline",
                json!({
                    "backendSessionId": "bk-2",
                    "team": { "parentSessionId": "windowed", "name": "helper" },
                }),
            ),
        ];
        let nodes = sessions
            .iter()
            .map(|session| {
                json!({
                    "id": format!("node-{}", session["id"].as_str().unwrap_or_default()),
                    "rigId": "rig-1",
                    "logicalId": session["id"],
                    "toolConfigKey": "claude",
                    "cwd": self.root_path(),
                    "createdAt": "2026-01-01T00:00:00.000Z",
                })
            })
            .collect::<Vec<_>>();
        // Only the first session is bound to the live window; the rest name
        // windows tmux does not have, which is what makes them not live.
        let bindings = sessions
            .iter()
            .enumerate()
            .filter(|(_, session)| session["id"] != "orphan")
            .map(|(index, session)| {
                json!({
                    "id": format!("tmux:{}", session["id"].as_str().unwrap_or_default()),
                    "nodeId": format!("node-{}", session["id"].as_str().unwrap_or_default()),
                    "tmuxSession": "aimux",
                    "tmuxWindowId": format!("@{}", index + 1),
                    "tmuxWindowIndex": index + 1,
                    "tmuxWindowName": session["id"],
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
                "projectRoot": self.root_path(),
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
    }

    /// The stale-record case needs a snapshot built when liveness could not be
    /// asked: with a live-window index, a running session whose window is gone
    /// is downgraded to offline, which is a different case entirely.
    fn desktop_state_with_liveness_unavailable(&self) -> Value {
        let topology =
            read_runtime_topology(runtime_topology_path(&self.state_dir)).expect("read topology");
        build_desktop_state_with_live_window_projection(
            DesktopStateInput {
                project_root: self.root_path(),
                topology: &topology,
                metadata_sessions: &BTreeMap::new(),
                exchange: &json!({}),
            },
            LiveWindowIdsProjection::Unavailable("tmux was not asked in this test"),
        )
    }

    fn desktop_state(&self) -> Value {
        let topology =
            read_runtime_topology(runtime_topology_path(&self.state_dir)).expect("read topology");
        build_desktop_state_with_live_window_ids(
            DesktopStateInput {
                project_root: self.root_path(),
                topology: &topology,
                metadata_sessions: &BTreeMap::new(),
                exchange: &json!({}),
            },
            Some(&support::live_windows("aimux", &[LIVE_WINDOW])),
        )
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn session_row(id: &str, status: &str, extra: Value) -> Value {
    let mut row = json!({
        "id": id,
        "nodeId": format!("node-{id}"),
        "tool": "claude",
        "toolConfigKey": "claude",
        "command": "claude",
        "args": [],
        "label": id,
        "status": status,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
    });
    if let (Some(row), Some(extra)) = (row.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            row.insert(key.clone(), value.clone());
        }
    }
    row
}

/// Serves one snapshot and records what the route posts, which is the CLI's
/// half of the comparison.
struct SnapshotRuntime {
    snapshot: Value,
    posted: Vec<(String, Value)>,
}

impl DaemonAgentTextRuntime for SnapshotRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.to_owned()
    }

    fn get_project_service_json(
        &mut self,
        _project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        if route_path == routes::DESKTOP_STATE {
            return ProjectServiceJsonResult::ok("/repo", self.snapshot.clone());
        }
        ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "not found\n"))
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        route_path: &str,
        body: Value,
        _options: ProjectServicePostOptions,
    ) -> ProjectServiceJsonResult {
        self.posted.push((route_path.to_owned(), body));
        ProjectServiceJsonResult::ok("/repo", json!({ "ok": true, "status": "running" }))
    }
}

/// What `aimux start <id>` asks the project service to do, or the refusal it
/// printed instead.
fn cli_outcome(snapshot: &Value, session_id: &str) -> Result<(String, Value), String> {
    let mut runtime = SnapshotRuntime {
        snapshot: snapshot.clone(),
        posted: Vec::new(),
    };
    let response = lifecycle_start_text_route(
        &mut runtime,
        &DaemonRouteUrl::parse("/core/lifecycle/start-text"),
        Some(&json!({ "project": "/repo", "sessionId": session_id })),
    );
    match runtime.posted.pop() {
        Some(call) => Ok(call),
        None => Err(match response.body {
            aimux::daemon::http::DaemonResponseBody::Text(value) => value,
            other => panic!("expected a text refusal, got {other:?}"),
        }),
    }
}

/// What pressing Enter on the same agent asks for, or the refusal the footer
/// shows instead.
fn dashboard_outcome(snapshot: &Value, session_id: &str) -> Result<(String, Value), String> {
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(snapshot.clone()).expect("parse snapshot");
    let session = snapshot
        .session(session_id)
        .unwrap_or_else(|| panic!("no session {session_id} in the snapshot"));
    match plan_dashboard_action(
        Some(DashboardEntryRef::Session(session)),
        DashboardActionKind::Enter,
    ) {
        DashboardActionPlan::Request(request) => {
            Ok((request.path.to_owned(), request.body.clone()))
        }
        DashboardActionPlan::Blocked(message) | DashboardActionPlan::Busy(message) => Err(message),
        DashboardActionPlan::Ignored => panic!("Enter ignored {session_id}"),
    }
}

/// One agent, two surfaces, one answer. The CLI's refusal adds the daemon's
/// `Error: ` prefix and a newline because it is an HTTP response; the sentence
/// inside has to be the dashboard's, character for character.
#[test]
fn start_and_enter_agree_on_every_agent_in_one_snapshot() {
    let project = Project::new();
    let snapshot = project.desktop_state();

    for session_id in COMPARED {
        let dashboard = dashboard_outcome(&snapshot, session_id);
        let cli = cli_outcome(&snapshot, session_id);
        assert_eq!(
            cli, dashboard,
            "`aimux start {session_id}` and Enter must ask for the same thing"
        );
    }

    let dashboard_refusal = dashboard_outcome(&snapshot, "blocked").expect_err("a refusal");
    let cli_refusal = cli_outcome(&snapshot, "blocked").expect_err("a refusal");
    assert_eq!(
        cli_refusal,
        format!("Error: {dashboard_refusal}\n"),
        "the CLI must refuse with the sentence the dashboard shows"
    );
}

/// The states the snapshot actually produced, so the test above cannot quietly
/// become a comparison of four identical resumes.
#[test]
fn the_snapshot_really_contains_a_focus_a_resume_and_a_refusal() {
    let project = Project::new();
    let snapshot = project.desktop_state();

    assert_eq!(
        dashboard_outcome(&snapshot, "windowed")
            .expect("a request")
            .0,
        routes::controls::FOCUS_WINDOW,
        "a live agent on the one live window is focused"
    );
    for session_id in COMPARED.iter().filter(|id| **id != "windowed") {
        assert_eq!(
            dashboard_outcome(&snapshot, session_id)
                .expect("a request")
                .0,
            routes::agents::RESUME,
            "{session_id} is resumed"
        );
    }
    assert!(
        dashboard_outcome(&snapshot, "blocked")
            .expect_err("a refusal")
            .contains("cannot be resumed"),
        "the blocked agent is refused"
    );
}

/// The case the first snapshot cannot hold: a record still reading `running`
/// whose window is gone. Enter resumes it rather than focusing a window that
/// 404s, and `aimux start` has to make the same call.
#[test]
fn start_and_enter_agree_on_a_live_record_whose_window_is_gone() {
    let project = Project::new();
    let snapshot = project.desktop_state_with_liveness_unavailable();

    let parsed: DesktopStateSnapshot =
        serde_json::from_value(snapshot.clone()).expect("parse snapshot");
    let stale = parsed.session("orphan").expect("the stale record");
    assert_eq!(
        stale.status,
        SessionStatus::Running,
        "liveness was not asked, so the record keeps the status it claims"
    );
    assert_eq!(
        stale.tmux_window_id, None,
        "and it has no window to focus, which is the whole case"
    );

    assert_eq!(
        cli_outcome(&snapshot, "orphan"),
        dashboard_outcome(&snapshot, "orphan"),
        "both surfaces resume a live record with no window"
    );
    assert_eq!(
        dashboard_outcome(&snapshot, "orphan").expect("a request").0,
        routes::agents::RESUME,
        "resumed, not focused"
    );
}

/// Work already in flight is the one answer neither surface can read from a
/// topology: `pendingAction` is published per request, so the snapshot both
/// surfaces share is where it has to be set.
fn with_pending_action(snapshot: &Value, session_id: &str, action: &str) -> Value {
    let mut snapshot = snapshot.clone();
    let sessions = snapshot
        .get_mut("sessions")
        .and_then(Value::as_array_mut)
        .expect("sessions array");
    let session = sessions
        .iter_mut()
        .find(|session| session["id"] == session_id)
        .unwrap_or_else(|| panic!("no session {session_id} to mark pending"));
    session
        .as_object_mut()
        .expect("session object")
        .insert("pendingAction".into(), Value::String(action.to_owned()));
    snapshot
}

/// Mid-flight is a refusal to wait on, not a verdict, and both surfaces have
/// to say so in the same words -- using the word the row shows, not the raw
/// action.
#[test]
fn start_and_enter_agree_that_work_in_flight_is_not_a_verdict() {
    let project = Project::new();
    let snapshot = with_pending_action(&project.desktop_state(), "resumable", "graveyarding");

    let dashboard = dashboard_outcome(&snapshot, "resumable").expect_err("busy, not a request");
    assert_eq!(
        dashboard, "Session resumable is removing",
        "the word the row shows for a graveyarding agent"
    );
    assert_eq!(
        cli_outcome(&snapshot, "resumable").expect_err("busy, not a request"),
        format!("Error: {dashboard}\n"),
        "`aimux start` must wait on the same work the dashboard waits on"
    );
}
