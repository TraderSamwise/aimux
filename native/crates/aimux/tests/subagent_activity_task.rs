//! The sub-agent scan, driven against real files.
//!
//! The entry shapes here are the real ones, read off this machine: a
//! `.meta.json` carrying `agentType` / `description` / `model`, a transcript
//! whose last assistant entry stops on `tool_use` while it works and on
//! `end_turn` when it is done.
//!
//! The clock is a parameter rather than the filesystem's, so staleness is
//! driven by moving `now` instead of back-dating a file.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aimux::project_service::subagent_activity_task::{
    ScanOutcome, scan_order, scan_subagents_dir, session_transcript_path,
};
use aimux::project_service::watcher_delivery::TickLoopBudget;
use aimux::subagent_activity::SUBAGENT_STALE_AFTER_MS;
use serde_json::json;

const WORKING: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"go"}]}}
{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}]}}
"#;

const FINISHED: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"go"}]}}
{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}
{"type":"attachment","attachment":{"type":"todo"}}
"#;

const META: &str = r#"{"agentType":"Explore","description":"Adversarial review of PR 451","toolUseId":"toolu_015PxBxu1VviiYrdkoRanmbn","spawnDepth":1,"requestShape":"background","requestNonInteractive":true,"model":"opus"}"#;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "aimux-subagent-activity-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir temp");
    dir
}

fn write_subagent(dir: &Path, key: &str, transcript: &str, meta: Option<&str>) {
    fs::write(dir.join(format!("{key}.jsonl")), transcript).expect("write transcript");
    if let Some(meta) = meta {
        fs::write(dir.join(format!("{key}.meta.json")), meta).expect("write meta");
    }
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .expect("stat")
        .modified()
        .expect("mtime")
        .duration_since(UNIX_EPOCH)
        .expect("epoch")
        .as_millis() as u64
}

fn budget() -> TickLoopBudget {
    TickLoopBudget::new(Duration::from_secs(30))
}

/// The runs a completed scan found, failing the test if the scan did not
/// complete.
fn read(outcome: ScanOutcome) -> Vec<aimux::subagent_activity::SubagentRun> {
    match outcome {
        ScanOutcome::Read(runs) => runs,
        other => panic!("the directory should have been read: {other:?}"),
    }
}

/// `now`, just after the newest file in the directory was written.
fn just_after(dir: &Path, key: &str) -> u64 {
    modified_ms(&dir.join(format!("{key}.jsonl"))) + 1_000
}

#[test]
fn a_working_subagent_is_found_with_what_it_was_asked_to_do() {
    let dir = temp_dir("working");
    write_subagent(&dir, "agent-aee1cddaa7c9690af", WORKING, Some(META));
    let mut terminal = HashSet::new();
    let runs = read(scan_subagents_dir(
        &dir,
        just_after(&dir, "agent-aee1cddaa7c9690af"),
        &mut terminal,
        &budget(),
    ));
    assert_eq!(runs.len(), 1, "the one working sub-agent is reported");
    assert_eq!(runs[0].name, "Adversarial review of PR 451");
    assert_eq!(runs[0].kind.as_deref(), Some("Explore"));
    assert_eq!(runs[0].model.as_deref(), Some("opus"));
    assert!(
        runs[0].started_at_ms.is_some(),
        "the meta file's mtime is when it was launched"
    );
    assert!(terminal.is_empty(), "a working sub-agent is not terminal");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_finished_subagent_is_not_working_and_is_never_read_again() {
    let dir = temp_dir("finished");
    write_subagent(&dir, "agent-done", FINISHED, Some(META));
    let mut terminal = HashSet::new();
    let runs = read(scan_subagents_dir(
        &dir,
        just_after(&dir, "agent-done"),
        &mut terminal,
        &budget(),
    ));
    assert!(runs.is_empty(), "a finished sub-agent is not working");
    assert!(
        terminal.contains("agent-done"),
        "and it is remembered, which is what keeps 840 of them off the next tick"
    );

    // The cache is load-bearing, not an optimisation: rewrite the same file as
    // a working transcript and it stays off the answer, because a sub-agent id
    // is minted per launch and its transcript is never reopened.
    write_subagent(&dir, "agent-done", WORKING, Some(META));
    let runs = read(scan_subagents_dir(
        &dir,
        just_after(&dir, "agent-done"),
        &mut terminal,
        &budget(),
    ));
    assert!(
        runs.is_empty(),
        "a key seen finished is not read again this process"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_transcript_that_went_quiet_is_not_working_and_is_not_cached() {
    let dir = temp_dir("quiet");
    write_subagent(&dir, "agent-killed", WORKING, Some(META));
    let mut terminal = HashSet::new();
    let quiet = modified_ms(&dir.join("agent-killed.jsonl")) + SUBAGENT_STALE_AFTER_MS;
    let runs = read(scan_subagents_dir(&dir, quiet, &mut terminal, &budget()));
    assert!(
        runs.is_empty(),
        "a sub-agent killed mid-turn stops being reported once it goes quiet"
    );
    // NOT cached as terminal: a sub-agent inside one long tool call is quiet
    // too, and caching it would silence it for the life of the process.
    assert!(terminal.is_empty());
    let runs = read(scan_subagents_dir(
        &dir,
        quiet - 1,
        &mut terminal,
        &budget(),
    ));
    assert_eq!(
        runs.len(),
        1,
        "one millisecond inside the window it is back"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn only_a_subagent_transcript_is_counted() {
    let dir = temp_dir("names");
    write_subagent(&dir, "agent-real", WORKING, Some(META));
    fs::write(dir.join("rollout-2026.jsonl"), WORKING).expect("write stray");
    fs::write(dir.join("notes.txt"), "hello").expect("write stray");
    let mut terminal = HashSet::new();
    let runs = read(scan_subagents_dir(
        &dir,
        just_after(&dir, "agent-real"),
        &mut terminal,
        &budget(),
    ));
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].key, "agent-real");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_missing_directory_is_no_subagents_rather_than_no_answer() {
    // The difference decides whether a stale summary is cleared or kept, so it
    // is not a detail: a session that never launched a sub-agent genuinely has
    // none, and that has to take the label off the row.
    let dir = temp_dir("missing");
    let absent = dir.join("subagents");
    let mut terminal = HashSet::new();
    assert_eq!(
        scan_subagents_dir(&absent, 0, &mut terminal, &budget()),
        ScanOutcome::Read(Vec::new())
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_scan_that_runs_out_of_budget_publishes_nothing_rather_than_a_short_list() {
    let dir = temp_dir("budget");
    write_subagent(&dir, "agent-one", WORKING, Some(META));
    write_subagent(&dir, "agent-two", WORKING, Some(META));
    let mut terminal = HashSet::new();
    // Zero allowance is spent before the first entry, so the whole scan is the
    // one that did not happen -- a half-read directory published as the answer
    // would take working sub-agents off the row.
    let spent = TickLoopBudget::new(Duration::from_secs(0));
    assert_eq!(
        scan_subagents_dir(&dir, just_after(&dir, "agent-one"), &mut terminal, &spent),
        ScanOutcome::BudgetSpent,
        "named, not folded into an empty answer -- it is the one outcome worth a log line"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_subagent_without_a_meta_file_is_still_reported() {
    let dir = temp_dir("nometa");
    write_subagent(&dir, "agent-bare", WORKING, None);
    let mut terminal = HashSet::new();
    let runs = read(scan_subagents_dir(
        &dir,
        just_after(&dir, "agent-bare"),
        &mut terminal,
        &budget(),
    ));
    assert_eq!(runs.len(), 1);
    assert_eq!(
        runs[0].name, "agent-bare",
        "reporting that something is working beats reporting nothing"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_transcript_that_cannot_be_probed_is_not_an_answer_about_it() {
    let dir = temp_dir("unreadable");
    write_subagent(&dir, "agent-gone", WORKING, Some(META));
    let mut terminal = HashSet::new();
    let now = just_after(&dir, "agent-gone");
    // A directory in place of the transcript: stat-able, inside the window,
    // and unreadable. Collapsing that into "not working" undercounts the row,
    // which is the one failure this feature exists to avoid.
    fs::remove_file(dir.join("agent-gone.jsonl")).expect("remove");
    fs::create_dir(dir.join("agent-gone.jsonl")).expect("mkdir in its place");
    assert!(matches!(
        scan_subagents_dir(&dir, now, &mut terminal, &budget()),
        ScanOutcome::Unreadable(_)
    ));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_launch_time_comes_from_the_meta_file_not_the_transcript() {
    let dir = temp_dir("started");
    // The meta is written at launch and never touched again; the transcript is
    // written to for as long as the sub-agent works. Ordering by the wrong one
    // puts the newest sub-agent first.
    fs::write(dir.join("agent-old.meta.json"), META).expect("write meta");
    std::thread::sleep(Duration::from_millis(30));
    fs::write(dir.join("agent-old.jsonl"), WORKING).expect("write transcript");
    let mut terminal = HashSet::new();
    let runs = read(scan_subagents_dir(
        &dir,
        just_after(&dir, "agent-old"),
        &mut terminal,
        &budget(),
    ));
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert!(
        run.started_at_ms.expect("a launch time") < run.updated_at_ms,
        "launched before it was last written to: {run:?}"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn every_session_gets_a_turn_at_the_front_of_the_scan() {
    // One budget is shared by every session, so a fixed order starves the same
    // tail sessions every tick -- permanently, and invisibly, because
    // starvation leaves the published answer alone.
    assert_eq!(scan_order(3, 0), vec![0, 1, 2]);
    assert_eq!(scan_order(3, 1), vec![1, 2, 0]);
    assert_eq!(scan_order(3, 4), vec![1, 2, 0]);
    assert_eq!(scan_order(0, 7), Vec::<usize>::new());
    // Every session is still scanned, exactly once, whatever the rotation.
    let mut seen = scan_order(5, 3);
    seen.sort_unstable();
    assert_eq!(seen, vec![0, 1, 2, 3, 4]);
}

#[test]
fn the_transcript_is_resolved_from_the_session_and_its_metadata() {
    let session = json!({
        "id": "claude-1",
        "toolConfigKey": "claude",
        "backendSessionId": "94760225-52eb-4f6d-973d-e1393fea8885",
        "worktreePath": "/Users/sam/cs/aimux",
    });
    let metadata = json!({ "sessions": { "claude-1": { "context": {} } } });
    let path = session_transcript_path(&session, &metadata).expect("a claude transcript");
    assert!(
        path.ends_with("94760225-52eb-4f6d-973d-e1393fea8885.jsonl"),
        "the backend session id names the transcript: {path:?}"
    );
}

#[test]
fn a_session_with_nothing_to_read_leaves_the_published_answer_alone() {
    let metadata = json!({ "sessions": { "claude-1": { "context": {} } } });
    let base = json!({
        "id": "claude-1",
        "toolConfigKey": "claude",
        "backendSessionId": "94760225-52eb-4f6d-973d-e1393fea8885",
        "worktreePath": "/Users/sam/cs/aimux",
    });
    let without = |key: &str| {
        let mut session = base.as_object().expect("object").clone();
        session.remove(key);
        serde_json::Value::Object(session)
    };
    // Each of these is "could not look", and each would clear a good summary
    // if it were answered as "no sub-agents".
    assert_eq!(
        session_transcript_path(&without("backendSessionId"), &metadata),
        None
    );
    assert_eq!(
        session_transcript_path(&without("worktreePath"), &metadata),
        None
    );
    let mut codex = base.as_object().expect("object").clone();
    codex.insert("toolConfigKey".into(), json!("codex"));
    assert_eq!(
        session_transcript_path(&serde_json::Value::Object(codex), &metadata),
        None,
        "codex sub-agents are read from the rollout, which this does not do yet"
    );
    // A session metadata record that does not exist at all is also not an
    // answer about its sub-agents.
    assert_eq!(session_transcript_path(&base, &json!({})), None);
}

/// The task end to end: a real topology, real metadata, a real sub-agent
/// directory on disk, ending in changed metadata.
mod end_to_end {
    use super::{FINISHED, META, WORKING};
    use aimux::daemon_state::{load_metadata_state, metadata_state_path};
    use aimux::project_service::router::ProjectServiceRequestContext;
    use aimux::project_service::scheduler::PeriodicTask;
    use aimux::project_service::subagent_activity_task::SubagentActivityTask;
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

    struct TempProject(PathBuf);

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl TempProject {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "aimux-subagent-task-{label}-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(path.join("state")).expect("mkdir state");
            Self(path)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }

        /// Through the production writer, so the record passes the same
        /// coercion the service applies on read.
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
            write_runtime_topology(runtime_topology_path(self.state_dir()), &saved)
                .expect("write topology");
        }

        /// The parent transcript, and the sub-agent directory beside it.
        fn write_transcripts(&self, subagents: &[(&str, &str)]) {
            fs::write(self.0.join("be-1.jsonl"), WORKING).expect("write parent transcript");
            let dir = self.0.join("be-1").join("subagents");
            fs::create_dir_all(&dir).expect("mkdir subagents");
            for (key, transcript) in subagents {
                fs::write(dir.join(format!("{key}.jsonl")), transcript).expect("write subagent");
                fs::write(dir.join(format!("{key}.meta.json")), META).expect("write meta");
            }
        }

        fn write_metadata(&self) {
            fs::write(
                metadata_state_path(self.state_dir()),
                serde_json::to_string(&json!({
                    "version": 1,
                    "sessions": {
                        "s1": {
                            "derived": { "activity": "running", "attention": "normal" },
                            "context": {
                                "backendSessionId": "be-1",
                                "transcriptPath": self.0.join("be-1.jsonl").to_string_lossy(),
                            },
                        }
                    }
                }))
                .expect("encode metadata"),
            )
            .expect("write metadata");
        }

        /// A topology this session is simply not in -- removed, migrated,
        /// graveyarded -- as opposed to one where it is listed as stopped.
        fn write_topology_without_the_session(&self) {
            let mut topology = empty_runtime_topology();
            let root = self.0.to_string_lossy().into_owned();
            let saved = save_runtime_topology_sessions(
                &mut topology,
                &[json!({
                    "id": "other",
                    "status": "running",
                    "toolConfigKey": "shell",
                    "worktreePath": root,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                })],
                &root,
                "2026-01-01T00:00:00.000Z",
            );
            write_runtime_topology(runtime_topology_path(self.state_dir()), &saved)
                .expect("write topology");
        }

        /// Drops the backend session id from both places it lives, keeping
        /// everything else -- including whatever is already published.
        fn forget_backend_session_id(&self) {
            let mut topology = empty_runtime_topology();
            let root = self.0.to_string_lossy().into_owned();
            let saved = save_runtime_topology_sessions(
                &mut topology,
                &[json!({
                    "id": "s1",
                    "status": "running",
                    "toolConfigKey": "claude",
                    "worktreePath": root,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                })],
                &root,
                "2026-01-01T00:00:00.000Z",
            );
            write_runtime_topology(runtime_topology_path(self.state_dir()), &saved)
                .expect("write topology");
            let path = metadata_state_path(self.state_dir());
            let mut state: Value =
                serde_json::from_str(&fs::read_to_string(&path).expect("read metadata"))
                    .expect("parse metadata");
            state["sessions"]["s1"]["context"] = json!({});
            fs::write(&path, serde_json::to_string(&state).expect("encode"))
                .expect("write metadata");
        }

        fn published(&self) -> Option<Value> {
            load_metadata_state(self.state_dir())
                .sessions
                .get("s1")
                .and_then(|session| session.get("subagents"))
                .cloned()
        }

        fn root(&self) -> &Path {
            &self.0
        }
    }

    fn tick(project: &TempProject, task: &mut SubagentActivityTask) {
        let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            project.root(),
            project.state_dir(),
        ));
        // aimux-async-seam: test - drives the async PeriodicTask body directly
        aimux::async_runtime::block_on_named("subagent-activity-task-test", async {
            task.run(&context).await
        })
        .expect("the task should run");
    }

    #[test]
    fn a_working_subagent_reaches_session_metadata() {
        let project = TempProject::new("publish");
        project.write_topology("running");
        project.write_transcripts(&[("agent-one", WORKING), ("agent-done", FINISHED)]);
        project.write_metadata();
        let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            project.root(),
            project.state_dir(),
        ));
        let mut task = SubagentActivityTask::new(context);

        tick(&project, &mut task);
        let published = project.published().expect("a summary is published");
        assert_eq!(published["running"], 1, "the finished one is not working");
        assert_eq!(published["label"], "1 sub-agent");
        assert_eq!(
            published["items"][0]["name"],
            "Adversarial review of PR 451"
        );

        // A stopped agent's sub-agents stopped with it, and this task is the
        // only thing that would ever say so -- the scan looks at live sessions
        // only, so without the clear a dead row keeps the label it died with.
        project.write_topology("stopped");
        tick(&project, &mut task);
        assert_eq!(
            project.published(),
            None,
            "a session that is no longer live publishes no sub-agents"
        );
    }

    #[test]
    fn a_session_whose_subagents_finish_stops_saying_otherwise() {
        let project = TempProject::new("finish");
        project.write_topology("running");
        project.write_transcripts(&[("agent-one", WORKING)]);
        project.write_metadata();
        let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            project.root(),
            project.state_dir(),
        ));
        let mut task = SubagentActivityTask::new(context);

        tick(&project, &mut task);
        assert_eq!(
            project.published().expect("published")["running"],
            1,
            "positive control: the task does something at all"
        );

        project.write_transcripts(&[("agent-one", FINISHED)]);
        tick(&project, &mut task);
        assert_eq!(
            project.published(),
            None,
            "the key is removed rather than left reporting a finished sub-agent"
        );
    }

    #[test]
    fn a_session_that_leaves_the_topology_is_forgotten() {
        let project = TempProject::new("forget");
        project.write_topology("running");
        project.write_transcripts(&[("agent-one", FINISHED)]);
        project.write_metadata();
        let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            project.root(),
            project.state_dir(),
        ));
        let mut task = SubagentActivityTask::new(context);

        tick(&project, &mut task);
        assert_eq!(project.published(), None, "it is finished");

        // The session leaves the topology, and comes back resumed -- the same
        // id, a fresh set of sub-agents. The finished-key cache has to go with
        // it, or the new work is hidden behind the old answer for the life of
        // the process.
        project.write_topology_without_the_session();
        tick(&project, &mut task);
        project.write_topology("running");
        project.write_transcripts(&[("agent-one", WORKING)]);
        tick(&project, &mut task);
        assert_eq!(
            project.published().expect("published")["running"],
            1,
            "a forgotten session is scanned from scratch"
        );
    }

    #[test]
    fn a_session_with_no_resolvable_transcript_leaves_the_summary_alone() {
        let project = TempProject::new("unresolvable");
        project.write_topology("running");
        project.write_transcripts(&[("agent-one", WORKING)]);
        project.write_metadata();
        let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            project.root(),
            project.state_dir(),
        ));
        let mut task = SubagentActivityTask::new(context);
        tick(&project, &mut task);
        assert_eq!(project.published().expect("published")["running"], 1);

        // The backend id goes away -- a session mid-rebind, or one whose id was
        // never recorded. The path is then unresolvable, and clearing on that
        // would flicker the label off a row whose sub-agents are still working.
        // Both halves have to go: the topology carries one too, and the
        // published summary is left in place because that is what is under
        // test.
        project.forget_backend_session_id();
        tick(&project, &mut task);
        assert_eq!(
            project.published().expect("still published")["running"],
            1,
            "could not look is not the same answer as nothing is working"
        );
    }
}
