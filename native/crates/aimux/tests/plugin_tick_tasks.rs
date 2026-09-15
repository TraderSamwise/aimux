use aimux::native_plugin_transcript_length::TranscriptLengthPlugin;
use aimux::plugin_api::{NativePluginApiRequest, NativePluginHost};
use aimux::plugin_project_service_host::{
    PluginMetadataCache, PluginTickTask, ProjectServicePluginHost, TranscriptSourceCache,
    builtin_plugin_tick_tasks,
};
use aimux::plugin_registry::builtin_native_plugins;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::PeriodicTask;
use serde_json::{Value, json};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn every_builtin_plugin_gets_a_tick_task() {
    let registered = builtin_native_plugins()
        .into_iter()
        .map(|(_, plugin)| plugin.manifest().name)
        .collect::<Vec<_>>();
    let mut ticked = builtin_plugin_tick_tasks()
        .iter()
        .map(|task| task.name().to_owned())
        .collect::<Vec<_>>();
    let mut registered = registered;
    registered.sort();
    ticked.sort();

    assert_eq!(
        registered, ticked,
        "a plugin with a startup status but no tick would silently never run"
    );
}

#[test]
fn the_gh_plugin_polls_far_less_often_than_the_transcript_plugin() {
    let intervals = builtin_native_plugins()
        .into_iter()
        .map(|(interval_ms, plugin)| (plugin.manifest().name, interval_ms))
        .collect::<std::collections::BTreeMap<_, _>>();

    let gh = intervals
        .iter()
        .find(|(name, _)| name.contains("pr"))
        .map(|(_, interval)| *interval)
        .expect("gh pr context plugin");
    let transcript = intervals
        .iter()
        .find(|(name, _)| name.contains("transcript"))
        .map(|(_, interval)| *interval)
        .expect("transcript length plugin");

    // it shells out to `gh` per session; ticking it at the transcript cadence
    // would spawn processes continuously
    assert!(gh >= transcript * 10, "gh={gh} transcript={transcript}");
}

#[test]
fn plugin_host_reuses_one_metadata_parse_for_large_metadata_access_pattern() {
    let project = temp_project("large-metadata-host-cache");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("create state dir");
    let session_count = 1_000usize;
    write_metadata_with_sessions(&state_dir, session_count, |index| {
        json!({
            "updatedAt": "2026-09-15T00:00:00.000Z",
            "context": {
                "transcriptPath": project.join(format!("transcripts/session-{index}.jsonl")).to_string_lossy()
            }
        })
    });

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let cache = PluginMetadataCache::default();
    let mut host = ProjectServicePluginHost::new_with_metadata_cache(&context, cache.clone());

    let sessions = host
        .execute("transcript-length", NativePluginApiRequest::ListSessions)
        .expect("list sessions");
    for entry in sessions.as_array().expect("session array") {
        let session_id = entry.get("id").and_then(Value::as_str).expect("session id");
        host.execute(
            "transcript-length",
            NativePluginApiRequest::ReadSessionContext {
                session_id: session_id.to_owned(),
            },
        )
        .expect("read session context");
    }

    let cached_loads = cache.load_count_for_tests();
    let legacy_loads = session_count + 1;
    println!(
        "large metadata measurement: sessions={session_count} legacy_full_parse_count={legacy_loads} cached_full_parse_count={cached_loads}"
    );
    assert_eq!(cached_loads, 1);
}

#[test]
fn transcript_plugin_does_not_reparse_unchanged_metadata_on_each_tick() {
    let project = temp_project("transcript-tick-cache");
    let state_dir = project.join("state");
    let transcript_dir = project.join("transcripts");
    create_dir_all(&state_dir).expect("create state dir");
    create_dir_all(&transcript_dir).expect("create transcript dir");
    write(transcript_dir.join("codex-1.jsonl"), "hello world").expect("write transcript");
    write_metadata(&state_dir, "codex-1", &transcript_dir.join("codex-1.jsonl"));

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut task = PluginTickTask::new(2_000, Box::new(TranscriptLengthPlugin::new("top")));

    run_task(&mut task, &context);
    assert_eq!(task.metadata_load_count_for_tests(), 0);
    assert_eq!(task.transcript_source_load_count_for_tests(), 1);
    run_task(&mut task, &context);
    let after_own_statusline_write = task.transcript_source_load_count_for_tests();
    run_task(&mut task, &context);
    assert_eq!(
        task.transcript_source_load_count_for_tests(),
        after_own_statusline_write,
        "unchanged metadata must not be scanned again on every tick"
    );
    assert!(
        after_own_statusline_write <= 2,
        "expected at most initial scan plus one reload for the plugin's own statusline write, got {after_own_statusline_write}"
    );
    assert_eq!(
        task.metadata_load_count_for_tests(),
        0,
        "transcript length ticks must not load full metadata"
    );
}

#[test]
fn transcript_plugin_observes_metadata_change_on_next_tick() {
    let project = temp_project("transcript-tick-change");
    let state_dir = project.join("state");
    let transcript_dir = project.join("transcripts");
    create_dir_all(&state_dir).expect("create state dir");
    create_dir_all(&transcript_dir).expect("create transcript dir");
    let initial_path = transcript_dir.join("codex-1-initial.jsonl");
    let updated_path = transcript_dir.join("codex-1-updated.jsonl");
    write(&initial_path, "small").expect("write initial transcript");
    write(&updated_path, "x".repeat(2048)).expect("write updated transcript");
    write_metadata(&state_dir, "codex-1", &initial_path);

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut task = PluginTickTask::new(2_000, Box::new(TranscriptLengthPlugin::new("top")));
    run_task(&mut task, &context);
    run_task(&mut task, &context);
    let stable_loads = task.transcript_source_load_count_for_tests();

    write_metadata(&state_dir, "codex-1", &updated_path);
    run_task(&mut task, &context);

    assert!(
        task.transcript_source_load_count_for_tests() > stable_loads,
        "metadata signature change must trigger a fresh transcript-source scan on the next tick"
    );
    assert_eq!(
        task.metadata_load_count_for_tests(),
        0,
        "transcript path changes must be observed without loading full metadata"
    );
    let metadata = read_json(state_dir.join("metadata.json"));
    assert_eq!(
        metadata["sessions"]["codex-1"]["statusline"]["top"][0]["text"],
        "2kb"
    );
}

#[test]
fn transcript_plugin_active_metadata_changes_do_not_reload_full_metadata() {
    let project = temp_project("transcript-active-metadata");
    let state_dir = project.join("state");
    let transcript_dir = project.join("transcripts");
    create_dir_all(&state_dir).expect("create state dir");
    create_dir_all(&transcript_dir).expect("create transcript dir");
    let transcript_path = transcript_dir.join("shared.jsonl");
    write(&transcript_path, "x".repeat(4096)).expect("write transcript");
    let session_count = 40usize;
    write_metadata_with_sessions(&state_dir, session_count, |_| {
        json!({
            "updatedAt": "2026-09-15T00:00:00.000Z",
            "context": {
                "transcriptPath": transcript_path.to_string_lossy()
            }
        })
    });

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut task = PluginTickTask::new(2_000, Box::new(TranscriptLengthPlugin::new("top")));
    run_task(&mut task, &context);
    let warm_sources = task.transcript_source_load_count_for_tests();
    let warm_full_metadata = task.metadata_load_count_for_tests();
    let tick_count = 5usize;
    let started = Instant::now();
    for tick in 0..tick_count {
        write_busy_metadata(&state_dir, session_count, &transcript_path, tick);
        run_task(&mut task, &context);
    }
    let elapsed = started.elapsed();
    let source_scans = task.transcript_source_load_count_for_tests() - warm_sources;
    let full_metadata_loads = task.metadata_load_count_for_tests() - warm_full_metadata;
    println!(
        "busy metadata measurement: sessions={session_count} ticks={tick_count} legacy_full_parse_count={tick_count} cached_full_parse_count={full_metadata_loads} transcript_source_scan_count={source_scans} wall_us_per_tick={}",
        elapsed.as_micros() / tick_count as u128
    );
    assert_eq!(
        full_metadata_loads, 0,
        "active unrelated metadata writes must not make transcript-length load full metadata"
    );
    assert_eq!(
        source_scans, tick_count,
        "active metadata changes should cause exactly one narrow transcript-source scan per tick"
    );
}

#[test]
fn transcript_source_snapshot_is_shared_for_many_sessions_inside_one_tick() {
    let project = temp_project("transcript-source-host-cache");
    let state_dir = project.join("state");
    let transcript_dir = project.join("transcripts");
    create_dir_all(&state_dir).expect("create state dir");
    create_dir_all(&transcript_dir).expect("create transcript dir");
    let transcript_path = transcript_dir.join("shared.jsonl");
    write(&transcript_path, "x".repeat(2048)).expect("write transcript");
    let session_count = 1_000usize;
    write_metadata_with_sessions(&state_dir, session_count, |_| {
        json!({
            "updatedAt": "2026-09-15T00:00:00.000Z",
            "context": {
                "transcriptPath": transcript_path.to_string_lossy()
            },
            "logs": ["this field should be skipped by the narrow transcript-source decoder"],
            "statusline": {
                "top": [{"id": "noise", "text": "unchanged"}]
            }
        })
    });

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let metadata_cache = PluginMetadataCache::default();
    let transcript_source_cache = TranscriptSourceCache::default();
    let mut host = ProjectServicePluginHost::new_with_caches(
        &context,
        metadata_cache.clone(),
        transcript_source_cache.clone(),
    );
    let sources = host
        .execute(
            "transcript-length",
            NativePluginApiRequest::ListTranscriptSources,
        )
        .expect("list transcript sources");
    assert_eq!(
        sources.as_array().map(Vec::len),
        Some(session_count),
        "all sessions should be visible through the narrow transcript source API"
    );
    let _second = host
        .execute(
            "transcript-length",
            NativePluginApiRequest::ListTranscriptSources,
        )
        .expect("list transcript sources again");
    let source_scans = transcript_source_cache.load_count_for_tests();
    let full_metadata_loads = metadata_cache.load_count_for_tests();
    println!(
        "many session transcript-source measurement: sessions={session_count} source_scans={source_scans} full_metadata_loads={}",
        full_metadata_loads
    );
    assert_eq!(
        full_metadata_loads, 0,
        "many transcript sessions must not route through load_metadata_state"
    );
    assert_eq!(
        source_scans, 1,
        "many sessions must share exactly one transcript-source scan in one tick"
    );
}

fn run_task(task: &mut PluginTickTask, context: &ProjectServiceRequestContext) {
    aimux::async_runtime::block_on_named("test:plugin-tick-task", task.run(context))
        .expect("plugin tick");
}

fn write_metadata(state_dir: &Path, session_id: &str, transcript_path: &Path) {
    write(
        state_dir.join("metadata.json"),
        json!({
            "version": 1,
            "sessions": {
                session_id: {
                    "updatedAt": "2026-09-15T00:00:00.000Z",
                    "context": {
                        "transcriptPath": transcript_path.to_string_lossy()
                    }
                }
            }
        })
        .to_string(),
    )
    .expect("write metadata");
}

fn write_metadata_with_sessions(
    state_dir: &Path,
    session_count: usize,
    mut session_value: impl FnMut(usize) -> Value,
) {
    let sessions = (0..session_count)
        .map(|index| (format!("codex-{index}"), session_value(index)))
        .collect::<serde_json::Map<_, _>>();
    write(
        state_dir.join("metadata.json"),
        json!({
            "version": 1,
            "sessions": sessions,
        })
        .to_string(),
    )
    .expect("write metadata");
}

fn write_busy_metadata(
    state_dir: &Path,
    session_count: usize,
    transcript_path: &Path,
    tick: usize,
) {
    write_metadata_with_sessions(state_dir, session_count, |index| {
        json!({
            "updatedAt": "2026-09-15T00:00:00.000Z",
            "context": {
                "transcriptPath": transcript_path.to_string_lossy()
            },
            "logs": [
                {
                    "message": format!("unrelated active metadata tick {tick} session {index}"),
                    "padding": "x".repeat((tick + index) % 17)
                }
            ]
        })
    });
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-plugin-tick-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = remove_dir_all(&path);
    create_dir_all(&path).expect("create temp project");
    path
}

fn read_json(path: PathBuf) -> Value {
    let raw = std::fs::read_to_string(path).expect("read json");
    serde_json::from_str(&raw).expect("parse json")
}
