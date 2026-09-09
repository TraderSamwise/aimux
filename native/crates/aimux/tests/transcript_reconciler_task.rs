//! The task half: real topology + metadata + on-disk transcript, driven through
//! the same routes a CLI call would take, ending in changed metadata on disk.

use aimux::daemon_state::{load_metadata_state, metadata_state_path};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::PeriodicTask;
use aimux::project_service::transcript_reconciler_task::TranscriptReconcilerTask;
use aimux::runtime_topology::{empty_runtime_topology, runtime_topology_path, write_runtime_topology};
use aimux::runtime_topology_sessions::save_runtime_topology_sessions;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-transcript-reconciler-{label}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(path.join("state")).unwrap();
    path
}

fn state_dir(project: &Path) -> PathBuf {
    project.join("state")
}

fn write_topology(project: &Path, status: &str) {
    // Built through the production writer so the record satisfies the same
    // coercion the service applies on read — a hand-rolled one is rejected and
    // the task then silently sees no sessions at all.
    let mut topology = empty_runtime_topology();
    let root = project.to_string_lossy().into_owned();
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
    write_runtime_topology(runtime_topology_path(state_dir(project)), &saved).unwrap();
}

fn write_metadata(project: &Path, derived: Value, transcript: &Path) {
    fs::write(
        metadata_state_path(state_dir(project)),
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

fn write_transcript(project: &Path, stop_reason: &str) -> PathBuf {
    let path = project.join("transcript.jsonl");
    fs::write(
        &path,
        format!("{{\"type\":\"assistant\",\"message\":{{\"stop_reason\":\"{stop_reason}\"}}}}\n"),
    )
    .unwrap();
    path
}

fn derived_of(project: &Path, field: &str) -> Option<String> {
    load_metadata_state(state_dir(project))
        .sessions
        .get("s1")
        .and_then(|session| session.get("derived"))
        .and_then(|derived| derived.get(field))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn run_ticks(project: &Path, ticks: usize) {
    let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
        project,
        state_dir(project),
    ));
    let mut task = TranscriptReconcilerTask::new(Arc::clone(&context));
    for _ in 0..ticks {
        task.run(&context);
    }
}

#[test]
fn a_stranded_running_session_is_settled_once_the_transcript_is_quiescent() {
    let project = temp_project("settle");
    let transcript = write_transcript(&project, "end_turn");
    write_topology(&project, "running");
    write_metadata(
        &project,
        json!({ "activity": "running", "attention": "normal" }),
        &transcript,
    );

    run_ticks(&project, 1);
    assert_eq!(
        derived_of(&project, "activity").as_deref(),
        Some("running"),
        "settled on the first look, before confirming the file went quiet"
    );

    run_ticks_reusing(&project);
    let _ = fs::remove_dir_all(project);
}

/// The reconciler's confirmation lives in the task instance, so the two ticks
/// have to come from one task — a fresh one would start over.
fn run_ticks_reusing(project: &Path) {
    let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
        project,
        state_dir(project),
    ));
    let mut task = TranscriptReconcilerTask::new(Arc::clone(&context));
    task.run(&context);
    assert_eq!(derived_of(project, "activity").as_deref(), Some("running"));
    task.run(&context);
    assert_eq!(
        derived_of(project, "activity").as_deref(),
        Some("idle"),
        "a complete, quiescent transcript did not settle the session"
    );
}

#[test]
fn a_mid_turn_transcript_is_never_settled() {
    let project = temp_project("midturn");
    let transcript = write_transcript(&project, "tool_use");
    write_topology(&project, "running");
    write_metadata(
        &project,
        json!({ "activity": "running", "attention": "normal" }),
        &transcript,
    );

    run_ticks(&project, 4);

    assert_eq!(
        derived_of(&project, "activity").as_deref(),
        Some("running"),
        "settled a session whose transcript is still mid-turn"
    );
    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_stranded_needs_response_is_cleared_after_a_second_unbacked_tick() {
    let project = temp_project("clear");
    let transcript = write_transcript(&project, "end_turn");
    write_topology(&project, "running");
    write_metadata(
        &project,
        json!({ "activity": "idle", "attention": "needs_response" }),
        &transcript,
    );

    let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
        &project,
        state_dir(&project),
    ));
    let mut task = TranscriptReconcilerTask::new(Arc::clone(&context));

    task.run(&context);
    assert_eq!(
        derived_of(&project, "attention").as_deref(),
        Some("needs_response"),
        "cleared on the first look, with no second confirmation"
    );

    task.run(&context);
    assert_eq!(
        derived_of(&project, "attention").as_deref(),
        Some("normal"),
        "an unbacked needs_response was never cleared"
    );
    let _ = fs::remove_dir_all(project);
}

#[test]
fn an_offline_session_is_never_probed() {
    let project = temp_project("offline");
    let transcript = write_transcript(&project, "end_turn");
    write_topology(&project, "offline");
    write_metadata(
        &project,
        json!({ "activity": "running", "attention": "normal" }),
        &transcript,
    );

    run_ticks(&project, 4);

    assert_eq!(
        derived_of(&project, "activity").as_deref(),
        Some("running"),
        "settled a session with no live window"
    );
    let _ = fs::remove_dir_all(project);
}
