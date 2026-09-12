//! The task half: real topology + metadata + on-disk transcript, driven through
//! the same routes a CLI call would take, ending in changed metadata on disk.
//!
//! Every negative here carries a positive control on the same task instance —
//! otherwise "still running" is just what the fixture was written as, and a task
//! whose `run` did nothing at all would pass.

use aimux::daemon_state::{load_metadata_state, metadata_state_path};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::PeriodicTask;
use aimux::project_service::transcript_reconciler_task::TranscriptReconcilerTask;
use aimux::runtime_topology::{
    empty_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::runtime_topology_sessions::save_runtime_topology_sessions;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Removes the directory even when an assertion unwinds past it.
struct TempProject(PathBuf);

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl TempProject {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "aimux-transcript-reconciler-{label}-{}-{}",
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

    /// Built through the production writer so the record satisfies the same
    /// coercion the service applies on read — a hand-rolled one is rejected and
    /// the task then silently sees no sessions at all.
    fn write_topology(&self, status: &str) {
        let mut topology = empty_runtime_topology();
        let root = self.0.to_string_lossy().into_owned();
        let saved = save_runtime_topology_sessions(
            &mut topology,
            &[json!({
                "id": "s1",
                "status": status,
                "toolConfigKey": "claude",
                "backendSessionId": "be-1",
                "worktreePath": root,
                "createdAt": "2026-01-01T00:00:00.000Z",
            })],
            &root,
            "2026-01-01T00:00:00.000Z",
        );
        write_runtime_topology(runtime_topology_path(self.state_dir()), &saved).unwrap();
    }

    fn write_transcript(&self, stop_reason: &str) -> PathBuf {
        let path = self.0.join("be-1.jsonl");
        fs::write(
            &path,
            format!(
                "{{\"type\":\"assistant\",\"message\":{{\"stop_reason\":\"{stop_reason}\"}}}}\n"
            ),
        )
        .unwrap();
        path
    }

    fn write_metadata(&self, derived: Value, transcript: &Path) {
        fs::write(
            metadata_state_path(self.state_dir()),
            serde_json::to_string(&json!({
                "version": 1,
                "sessions": {
                    "s1": {
                        "derived": derived,
                        "context": { "transcriptPath": transcript.to_string_lossy() },
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn derived(&self, field: &str) -> Option<String> {
        load_metadata_state(self.state_dir())
            .sessions
            .get("s1")
            .and_then(|session| session.get("derived"))
            .and_then(|derived| derived.get(field))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    }
}

/// The two-tick confirmation lives in the task instance, so every tick in one
/// test has to come from one task — a fresh one starts over.
struct TickLoop {
    context: Arc<ProjectServiceRequestContext>,
    task: TranscriptReconcilerTask,
}

impl TickLoop {
    fn new(project: &TempProject) -> Self {
        let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            project.root(),
            project.state_dir(),
        ));
        let task = TranscriptReconcilerTask::new(Arc::clone(&context));
        Self { context, task }
    }

    fn tick(&mut self, times: usize) {
        for _ in 0..times {
            aimux::async_runtime::block_on_named(
                "transcript-reconciler-task-test",
                self.task.run(&self.context),
            );
        }
    }
}

fn running() -> Value {
    json!({ "activity": "running", "attention": "normal" })
}

#[test]
fn a_stranded_running_session_is_settled_once_the_transcript_is_quiescent() {
    let project = TempProject::new("settle");
    let transcript = project.write_transcript("end_turn");
    project.write_topology("running");
    project.write_metadata(running(), &transcript);
    let mut tick_loop = TickLoop::new(&project);

    tick_loop.tick(1);
    assert_eq!(
        project.derived("activity").as_deref(),
        Some("running"),
        "settled on the first look, before confirming the file went quiet"
    );

    tick_loop.tick(1);
    assert_eq!(
        project.derived("activity").as_deref(),
        Some("idle"),
        "a complete, quiescent transcript did not settle the session"
    );
}

#[test]
fn a_mid_turn_transcript_is_never_settled() {
    let project = TempProject::new("midturn");
    let transcript = project.write_transcript("tool_use");
    project.write_topology("running");
    project.write_metadata(running(), &transcript);
    let mut tick_loop = TickLoop::new(&project);

    tick_loop.tick(4);
    assert_eq!(
        project.derived("activity").as_deref(),
        Some("running"),
        "settled a session whose transcript is still mid-turn"
    );

    // Positive control: the same fixture settles the moment the turn ends, so
    // the four ticks above really did reach it.
    project.write_transcript("end_turn");
    tick_loop.tick(2);
    assert_eq!(
        project.derived("activity").as_deref(),
        Some("idle"),
        "the fixture was never settle-able, so the negative above proves nothing"
    );
}

#[test]
fn an_offline_session_is_never_probed() {
    let project = TempProject::new("offline");
    let transcript = project.write_transcript("end_turn");
    project.write_topology("offline");
    project.write_metadata(running(), &transcript);
    let mut tick_loop = TickLoop::new(&project);

    tick_loop.tick(4);
    assert_eq!(
        project.derived("activity").as_deref(),
        Some("running"),
        "settled a session with no live window"
    );

    // Positive control: only the status was holding it back.
    project.write_topology("running");
    tick_loop.tick(2);
    assert_eq!(
        project.derived("activity").as_deref(),
        Some("idle"),
        "the fixture was never settle-able, so the negative above proves nothing"
    );
}

#[test]
fn a_stranded_needs_response_is_cleared_after_a_second_unbacked_tick() {
    let project = TempProject::new("clear");
    let transcript = project.write_transcript("end_turn");
    project.write_topology("running");
    project.write_metadata(
        json!({ "activity": "idle", "attention": "needs_response" }),
        &transcript,
    );
    let mut tick_loop = TickLoop::new(&project);

    tick_loop.tick(1);
    assert_eq!(
        project.derived("attention").as_deref(),
        Some("needs_response"),
        "cleared on the first look, with no second confirmation"
    );

    tick_loop.tick(1);
    assert_eq!(
        project.derived("attention").as_deref(),
        Some("normal"),
        "an unbacked needs_response was never cleared"
    );
}
