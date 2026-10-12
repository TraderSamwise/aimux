//! A replaced token goal counts from itself, not from the one before it.
//!
//! Its own test target because it points `CLAUDE_CONFIG_DIR` at a fixture, and
//! that is process-wide: in a shared binary it would change where every other
//! test in that binary looks for a transcript.

use aimux::async_runtime::init_process_runtime;
use aimux::backend_session_ids::claude_transcript_path;
use aimux::daemon_state::metadata_state_path;
use aimux::project_service::loop_watcher_task::LoopWatcherTask;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::{PeriodicScheduler, ProjectSchedulerHandle};
use aimux::runtime_topology::{runtime_topology_path, write_runtime_topology};
use serde_json::{Value, json};
use std::fs;
use std::sync::Arc;

const WORKTREE: &str = "/repo";
const BACKEND: &str = "11111111-2222-3333-4444-555555555555";

fn claude_usage_line(id: &str, input: u64, output: u64) -> String {
    format!(
        r#"{{"type":"assistant","message":{{"id":"{id}","usage":{{"input_tokens":{input},"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":{output}}}}}}}"#
    ) + "\n"
}

fn topology() -> Value {
    json!({
        "version": 1,
        "generatedAt": "2026-10-12T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "local",
            "projectRoot": WORKTREE,
            "createdAt": "2026-10-12T00:00:00.000Z",
            "updatedAt": "2026-10-12T00:00:00.000Z",
        }],
        "nodes": [{
            "id": "agent:worker",
            "rigId": "rig-1",
            "logicalId": "worker",
            "createdAt": "2026-10-12T00:00:00.000Z",
        }],
        "edges": [],
        "bindings": [{
            "id": "binding-worker",
            "nodeId": "agent:worker",
            "tmuxSession": "aimux-test",
            "tmuxWindowId": "@1",
            "tmuxWindowIndex": 1,
            "tmuxWindowName": "worker",
            "updatedAt": "2026-10-12T00:00:00.000Z",
        }],
        "sessions": [{
            "id": "worker",
            "nodeId": "agent:worker",
            "status": "running",
            "tool": "claude",
            "worktreePath": WORKTREE,
            "createdAt": "2026-10-12T00:00:00.000Z",
            "updatedAt": "2026-10-12T00:00:00.000Z",
        }],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
    })
}

fn metadata(since: &str, budget: u64) -> String {
    serde_json::to_string(&json!({
        "version": 1,
        "sessions": {
            "worker": {
                "loop": {
                    "active": true,
                    "goal": "spend down",
                    "goalKind": "tokens",
                    "tokenBudget": budget,
                    "since": since,
                },
                "context": { "backendSessionId": BACKEND, "cwd": WORKTREE },
                "derived": { "activity": "running", "attention": "normal" }
            }
        }
    }))
    .expect("metadata json")
}

fn stored_spend(state_dir: &std::path::Path) -> Value {
    let state: Value =
        serde_json::from_str(&fs::read_to_string(metadata_state_path(state_dir)).expect("read"))
            .expect("metadata json");
    state["sessions"]["worker"]["tokenSpend"].clone()
}

/// Replacing a goal on a session whose loop never went inactive used to
/// inherit the previous goal's count, so a fresh 50,000 budget on a session
/// that had already spent more read as met the moment it was set and the
/// reminders never fired. Found by review of the original commit.
#[test]
fn a_replaced_token_goal_does_not_inherit_the_previous_goals_spend() {
    let root = std::env::temp_dir().join(format!("aimux-goal-episode-{}", std::process::id()));
    let project_root = root.join("project");
    let state_dir = root.join("state");
    let claude_home = root.join("claude");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    // Set before anything resolves a transcript path, and this target holds
    // only this test so nothing else in the binary can be looking.
    unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", &claude_home) };
    let transcript = claude_transcript_path(WORKTREE, BACKEND, Some(&claude_home.join("projects")));
    fs::create_dir_all(transcript.parent().expect("transcript dir")).expect("transcript dir");
    fs::write(&transcript, claude_usage_line("msg-0", 1, 1)).expect("seed transcript");

    write_runtime_topology(runtime_topology_path(&state_dir), &topology()).expect("topology");
    fs::write(
        metadata_state_path(&state_dir),
        metadata("2026-10-12T00:00:00.000Z", 250_000),
    )
    .expect("metadata");

    init_process_runtime().expect("runtime");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );
    let run_at = |scheduler: &mut PeriodicScheduler, now_ms: i64| {
        // aimux-async-seam: test - scheduler test drives async PeriodicTask method
        aimux::async_runtime::block_on_named("test:loop-watcher-episode", async {
            scheduler.run_due_at(&context, now_ms).await
        });
    };

    // First tick only takes the baseline; nothing written before the goal is
    // this goal's spend.
    run_at(&mut scheduler, 15_000);
    // Then spend arrives under the FIRST goal.
    fs::write(
        &transcript,
        format!(
            "{}{}",
            claude_usage_line("msg-0", 1, 1),
            claude_usage_line("msg-1", 90_000, 30_000)
        ),
    )
    .expect("append spend");
    run_at(&mut scheduler, 45_000);
    assert_eq!(
        stored_spend(&state_dir)["billed"],
        120_000,
        "the first goal's spend is measured"
    );

    // Now the goal is REPLACED: a new start and a smaller budget, with the
    // loop never going inactive.
    let mut replaced: Value = serde_json::from_str(
        &fs::read_to_string(metadata_state_path(&state_dir)).expect("read metadata"),
    )
    .expect("metadata json");
    replaced["sessions"]["worker"]["loop"]["since"] = json!("2026-10-12T09:00:00.000Z");
    replaced["sessions"]["worker"]["loop"]["tokenBudget"] = json!(50_000);
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&replaced).expect("metadata json"),
    )
    .expect("replace goal");

    run_at(&mut scheduler, 75_000);
    let spend = stored_spend(&state_dir);
    assert!(
        spend.get("billed").is_none(),
        "the new goal must not start out holding the old one's 120,000, which \
         is already over its 50,000 budget: {spend}"
    );
    assert_eq!(
        spend["unmeasured"], "measuring from now",
        "it says it is starting again rather than reporting a number nobody \
         spent against this goal: {spend}"
    );

    // And from there it counts its own.
    fs::write(
        &transcript,
        format!(
            "{}{}{}",
            claude_usage_line("msg-0", 1, 1),
            claude_usage_line("msg-1", 90_000, 30_000),
            claude_usage_line("msg-2", 700, 300)
        ),
    )
    .expect("append more spend");
    run_at(&mut scheduler, 105_000);
    assert_eq!(
        stored_spend(&state_dir)["billed"],
        1_000,
        "only what was spent since the new goal started"
    );

    fs::remove_dir_all(&root).ok();
}
