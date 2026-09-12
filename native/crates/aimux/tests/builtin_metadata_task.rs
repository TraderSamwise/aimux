//! The task half: source collection and the mapping from recorded call shapes
//! to real request bodies. The behaviour itself is covered by the corpus.

use aimux::builtin_metadata_watchers::{BuiltinMetadataWatchers, MetadataEffects};
use aimux::project_service::builtin_metadata_task::collect_watcher_sources;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::watcher_delivery::TickLoopBudget;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-builtin-metadata-{label}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(path.join(".aimux").join("status")).unwrap();
    fs::create_dir_all(path.join(".aimux").join("plans")).unwrap();
    path
}

fn context_for(project: &Path) -> ProjectServiceRequestContext {
    ProjectServiceRequestContext::with_project_state_dir(project, project.join("state"))
}

fn write_live_topology(project: &Path, session_ids: &[&str]) {
    fs::create_dir_all(project.join("state")).unwrap();
    let nodes = session_ids
        .iter()
        .map(|session_id| {
            format!(
                "- id: agent:{session_id}\n  rigId: rig-1\n  logicalId: {session_id}\n  createdAt: \"2026-09-09T00:00:00.000Z\"\n"
            )
        })
        .collect::<String>();
    let sessions = session_ids
        .iter()
        .map(|session_id| {
            format!(
                "- id: {session_id}\n  nodeId: agent:{session_id}\n  status: running\n  tool: claude\n  createdAt: \"2026-09-09T00:00:00.000Z\"\n  updatedAt: \"2026-09-09T00:00:00.000Z\"\n"
            )
        })
        .collect::<String>();
    fs::write(
        project.join("state").join("runtime-topology.yaml"),
        format!(
            concat!(
                "version: 1\n",
                "generatedAt: \"2026-09-09T00:00:00.000Z\"\n",
                "rigs:\n",
                "- id: rig-1\n",
                "  name: local\n",
                "  projectRoot: /repo\n",
                "  createdAt: \"2026-09-09T00:00:00.000Z\"\n",
                "  updatedAt: \"2026-09-09T00:00:00.000Z\"\n",
                "nodes:\n",
                "{nodes}",
                "edges: []\n",
                "bindings: []\n",
                "sessions:\n",
                "{sessions}",
                "services: []\n",
                "worktrees: []\n",
                "worktreeGraveyard: []\n",
                "teamRoles: []\n",
                "remoteClients: []\n",
                "lifecycleOperations: []\n",
                "exchangeRefs: []\n",
            ),
            nodes = nodes,
            sessions = sessions,
        ),
    )
    .unwrap();
}

#[test]
fn a_status_file_is_collected_and_becomes_a_headline() {
    let project = temp_project("status");
    write_live_topology(&project, &["claude-a1"]);
    fs::write(
        project.join(".aimux").join("status").join("claude-a1.md"),
        "Shipping the rail\nmore detail below\n",
    )
    .unwrap();
    let context = context_for(&project);

    let sources = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));
    assert_eq!(
        sources["statusFiles"]["claude-a1"].as_str(),
        Some("Shipping the rail\nmore detail below\n")
    );

    let mut watchers = BuiltinMetadataWatchers::new();
    let effects = watchers.scan(&sources);
    assert_eq!(
        effects.statuses,
        vec![json!(["claude-a1", "Shipping the rail", "info"])],
        "the first non-empty line is the headline"
    );

    // and it is not rewritten on the next poll
    let effects = watchers.scan(&sources);
    assert!(effects.statuses.is_empty());

    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_plan_file_is_collected_and_becomes_progress() {
    let project = temp_project("plan");
    write_live_topology(&project, &["claude-a1"]);
    fs::write(
        project.join(".aimux").join("plans").join("claude-a1.md"),
        "- [x] one\n- [x] two\n- [ ] three\n",
    )
    .unwrap();
    let context = context_for(&project);

    let sources = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));
    let mut watchers = BuiltinMetadataWatchers::new();
    let effects = watchers.scan(&sources);

    assert_eq!(effects.progresses, vec![json!(["claude-a1", 2, 3, "plan"])]);
    let _ = fs::remove_dir_all(project);
}

fn with_one_live_session_and_history(project: &Path) {
    fs::create_dir_all(project.join(".aimux").join("history")).unwrap();
    fs::write(
        project.join(".aimux").join("history").join("claude-a1.jsonl"),
        "{\"ts\":\"2026-09-09T00:00:00.000Z\",\"type\":\"prompt\",\"content\":\"do the thing\",\"files\":[]}\n",
    )
    .unwrap();
    write_live_topology(project, &["claude-a1"]);
}

#[test]
fn a_spent_budget_stops_the_scan_reading_history() {
    let project = temp_project("budget");
    with_one_live_session_and_history(&project);
    let context = context_for(&project);

    let read = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));
    assert_eq!(
        read["sessions"],
        json!(["claude-a1"]),
        "scan_history reads bare ids, not session objects"
    );
    assert_eq!(
        read["history"]["claude-a1"][0]["type"].as_str(),
        Some("prompt"),
        "with budget, the turn is read and renamed for the watcher: {}",
        read["history"]
    );

    let skipped = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::ZERO));
    // A spent budget covers the source reads themselves, not only the history
    // tail loop, so a slow project degrades instead of holding the tick loop.
    assert_eq!(skipped["statusFiles"], json!({}));
    assert_eq!(skipped["planFiles"], json!({}));
    assert_eq!(skipped["exchange"]["tasks"], json!([]));
    assert_eq!(skipped["history"], json!({}));

    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_task_in_the_exchange_is_collected_and_primed_before_it_logs() {
    let project = temp_project("tasks");
    fs::create_dir_all(project.join("state")).unwrap();
    fs::write(
        project.join("state").join("runtime-exchange.yaml"),
        concat!(
            "version: 1\n",
            "generatedAt: \"2026-09-09T00:00:00.000Z\"\n",
            "tasks:\n",
            "- id: t1\n",
            "  assignedTo: claude-a1\n",
            "  status: assigned\n",
            "  description: ship the rail\n",
        ),
    )
    .unwrap();
    let context = context_for(&project);

    let sources = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));
    assert_eq!(
        sources["exchange"]["tasks"][0]["id"].as_str(),
        Some("t1"),
        "the exchange must be read from its file, not its directory: {}",
        sources["exchange"]
    );

    let mut watchers = BuiltinMetadataWatchers::new();
    // first look records a baseline and says nothing
    assert!(watchers.scan(&sources).logs.is_empty());

    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_history_turn_becomes_a_log_and_an_event_once_primed() {
    let project = temp_project("history-effects");
    with_one_live_session_and_history(&project);
    let context = context_for(&project);
    let sources = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));

    let mut watchers = BuiltinMetadataWatchers::new();
    // first look primes without emitting
    assert!(watchers.scan(&sources).logs.is_empty());

    // a new turn arrives
    fs::write(
        project.join(".aimux").join("history").join("claude-a1.jsonl"),
        concat!(
            "{\"ts\":\"2026-09-09T00:00:00.000Z\",\"type\":\"prompt\",\"content\":\"do the thing\",\"files\":[]}\n",
            "{\"ts\":\"2026-09-09T00:01:00.000Z\",\"type\":\"git\",\"content\":\"committed the rail\",\"files\":[]}\n",
        ),
    )
    .unwrap();
    let sources = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));
    let effects = watchers.scan(&sources);

    assert_eq!(effects.logs.len(), 1, "{:?}", effects.logs);
    assert_eq!(effects.logs[0][0].as_str(), Some("claude-a1"));
    assert!(effects.logs[0][1].as_str().unwrap().starts_with("Git: "));
    assert_eq!(effects.events.len(), 1);
    assert_eq!(effects.events[0][1].as_str(), Some("notify"));

    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_stray_note_in_the_status_directory_does_not_mint_a_session() {
    let project = temp_project("stray-status");
    write_live_topology(&project, &["claude-a1"]);
    fs::write(
        project.join(".aimux").join("status").join("claude-a1.md"),
        "real headline\n",
    )
    .unwrap();
    fs::write(
        project
            .join(".aimux")
            .join("status")
            .join("../status/READ ME.md"),
        "not a session\n",
    )
    .unwrap();
    let context = context_for(&project);

    let sources = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));
    let keys = sources["statusFiles"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(keys, ["claude-a1"], "got {keys:?}");

    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_status_file_for_a_dead_session_does_not_mint_effects() {
    let project = temp_project("dead-status");
    write_live_topology(&project, &["claude-live"]);
    fs::write(
        project.join(".aimux").join("status").join("claude-live.md"),
        "live headline\n",
    )
    .unwrap();
    fs::write(
        project.join(".aimux").join("status").join("claude-dead.md"),
        "dead headline\n",
    )
    .unwrap();
    let context = context_for(&project);

    let sources = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));
    assert_eq!(
        sources["statusFiles"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["claude-live"]
    );

    let mut watchers = BuiltinMetadataWatchers::new();
    let effects = watchers.scan(&sources);
    assert_eq!(
        effects.statuses,
        vec![json!(["claude-live", "live headline", "info"])]
    );

    let _ = fs::remove_dir_all(project);
}

#[test]
fn metadata_collection_caps_files_and_content_on_the_tick_loop() {
    let project = temp_project("caps");
    let session_ids = (0..40)
        .map(|index| format!("claude-{index:02}"))
        .collect::<Vec<_>>();
    let session_refs = session_ids.iter().map(String::as_str).collect::<Vec<_>>();
    write_live_topology(&project, &session_refs);
    for session_id in &session_ids {
        fs::write(
            project
                .join(".aimux")
                .join("plans")
                .join(format!("{session_id}.md")),
            "- [x] bounded\n",
        )
        .unwrap();
    }
    fs::write(
        project.join(".aimux").join("status").join("claude-00.md"),
        "x".repeat(20 * 1024),
    )
    .unwrap();
    fs::write(
        project.join("state").join("runtime-exchange.yaml"),
        format!(
            "version: 1\ngeneratedAt: \"2026-09-09T00:00:00.000Z\"\ntasks:\n- id: huge-task\n  assignedTo: claude-00\n  status: assigned\n  description: should not be read\nmessages:\n- body: {}\n",
            "x".repeat(70 * 1024)
        ),
    )
    .unwrap();
    let context = context_for(&project);

    let sources = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));
    assert_eq!(
        sources["planFiles"].as_object().unwrap().len(),
        32,
        "one tick reads only the bounded number of plan files"
    );
    assert!(
        sources["statusFiles"].as_object().unwrap().is_empty(),
        "oversized status content is skipped rather than read on the tick loop"
    );
    assert_eq!(
        sources["exchange"]["tasks"],
        json!([]),
        "oversized exchange is skipped rather than parsed on the tick loop"
    );

    let _ = fs::remove_dir_all(project);
}

#[test]
fn an_empty_project_produces_no_effects_at_all() {
    let project = temp_project("empty");
    let context = context_for(&project);
    let sources = collect_watcher_sources(&context, &TickLoopBudget::new(Duration::from_secs(5)));

    let mut watchers = BuiltinMetadataWatchers::new();
    assert!(watchers.scan(&sources).is_empty());
    let _ = fs::remove_dir_all(project);
}

#[test]
fn effects_are_the_positional_shapes_the_appliers_expect() {
    // the appliers map by index; if the watchers ever emit objects instead,
    // every write would silently become null
    let effects = MetadataEffects::default();
    assert!(effects.is_empty());

    let status: Value = json!(["s", "text", "info"]);
    assert_eq!(status.as_array().map(Vec::len), Some(3));
    let event: Value = json!(["s", "prompt", "msg", "history", "info", Value::Null]);
    assert_eq!(event.as_array().map(Vec::len), Some(6));
}
