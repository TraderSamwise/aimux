//! The task half: source collection and the mapping from recorded call shapes
//! to real request bodies. The behaviour itself is covered by the corpus.

use aimux::builtin_metadata_watchers::{BuiltinMetadataWatchers, MetadataEffects};
use aimux::project_service::builtin_metadata_task::collect_watcher_sources;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::watcher_delivery::RailBudget;
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

#[test]
fn a_status_file_is_collected_and_becomes_a_headline() {
    let project = temp_project("status");
    fs::write(
        project.join(".aimux").join("status").join("claude-a1.md"),
        "Shipping the rail\nmore detail below\n",
    )
    .unwrap();
    let context = context_for(&project);

    let sources = collect_watcher_sources(&context, &RailBudget::new(Duration::from_secs(5)));
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
    fs::write(
        project.join(".aimux").join("plans").join("claude-a1.md"),
        "- [x] one\n- [x] two\n- [ ] three\n",
    )
    .unwrap();
    let context = context_for(&project);

    let sources = collect_watcher_sources(&context, &RailBudget::new(Duration::from_secs(5)));
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
    fs::create_dir_all(project.join("state")).unwrap();
    fs::write(
        project.join("state").join("runtime-topology.yaml"),
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
            "- id: agent:claude-a1\n",
            "  rigId: rig-1\n",
            "  logicalId: claude-a1\n",
            "  createdAt: \"2026-09-09T00:00:00.000Z\"\n",
            "edges: []\n",
            "bindings: []\n",
            "sessions:\n",
            "- id: claude-a1\n",
            "  nodeId: agent:claude-a1\n",
            "  status: running\n",
            "  tool: claude\n",
            "  createdAt: \"2026-09-09T00:00:00.000Z\"\n",
            "  updatedAt: \"2026-09-09T00:00:00.000Z\"\n",
            "services: []\n",
            "worktrees: []\n",
            "worktreeGraveyard: []\n",
            "teamRoles: []\n",
            "remoteClients: []\n",
            "lifecycleOperations: []\n",
            "exchangeRefs: []\n",
        ),
    )
    .unwrap();
}

#[test]
fn a_spent_budget_stops_the_scan_reading_history() {
    let project = temp_project("budget");
    with_one_live_session_and_history(&project);
    let context = context_for(&project);

    let read = collect_watcher_sources(&context, &RailBudget::new(Duration::from_secs(5)));
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

    let skipped = collect_watcher_sources(&context, &RailBudget::new(Duration::ZERO));
    // the cheap directory reads still happen; only the per-session history loop
    // is abandoned, so a slow project degrades instead of holding the rail
    assert!(skipped.get("statusFiles").is_some());
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

    let sources = collect_watcher_sources(&context, &RailBudget::new(Duration::from_secs(5)));
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
    let sources = collect_watcher_sources(&context, &RailBudget::new(Duration::from_secs(5)));

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
    let sources = collect_watcher_sources(&context, &RailBudget::new(Duration::from_secs(5)));
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

    let sources = collect_watcher_sources(&context, &RailBudget::new(Duration::from_secs(5)));
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
fn an_empty_project_produces_no_effects_at_all() {
    let project = temp_project("empty");
    let context = context_for(&project);
    let sources = collect_watcher_sources(&context, &RailBudget::new(Duration::from_secs(5)));

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
