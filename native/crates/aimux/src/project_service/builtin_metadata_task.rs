//! The builtin metadata watchers as a scheduled task.
//!
//! Reads the four sources an agent writes to, hands them to
//! `crate::builtin_metadata_watchers`, and applies whatever comes back through
//! the same routes the CLI and hooks use — so a status still raises its alert
//! and a log still lands in the same place.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::builtin_metadata_watchers::{BuiltinMetadataWatchers, MetadataEffects};
use crate::context_compactor::{HistoryReadOptions, read_history};
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::session_bootstrap::status_dir;

use super::metadata::route_runtime_metadata_request;
use super::plans::{plan_authority_dir_for_project_root, validate_plan_session_id};
use super::router::ProjectServiceRequestContext;
use super::runtime_events::route_runtime_event_with_context;
use super::runtime_exchange::{
    empty_runtime_exchange, read_runtime_exchange, runtime_exchange_path,
};
use super::scheduler::PeriodicTask;
use super::watcher_delivery::RailBudget;

/// Node polled every 2s. That is a floor here, not a promise: the rail is
/// shared, and a watcher ahead of this one may hold it for its whole budget.
const SCAN_INTERVAL_MS: i64 = 5_000;
/// This task is pure file reads, so it should never be the reason another
/// task waits. It gives up rather than running long.
const SCAN_BUDGET: Duration = Duration::from_secs(2);
/// Sessions whose history is worth reading — matching what the dashboard shows.
const LIVE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
const MAX_PLAN_STATUS_FILES_PER_TICK: usize = 32;
const MAX_PLAN_STATUS_FILE_BYTES: u64 = 16 * 1024;
const MAX_EXCHANGE_BYTES_PER_TICK: u64 = 64 * 1024;
const HISTORY_TAIL_BYTES: usize = 16 * 1024;

pub struct BuiltinMetadataTask {
    context: Arc<ProjectServiceRequestContext>,
    watchers: BuiltinMetadataWatchers,
}

impl BuiltinMetadataTask {
    pub fn new(context: Arc<ProjectServiceRequestContext>) -> Self {
        Self {
            context,
            watchers: BuiltinMetadataWatchers::new(),
        }
    }
}

impl PeriodicTask for BuiltinMetadataTask {
    fn name(&self) -> &str {
        "builtin-metadata-watchers"
    }

    fn interval_ms(&self) -> i64 {
        SCAN_INTERVAL_MS
    }

    fn timeout(&self) -> Duration {
        SCAN_BUDGET + Duration::from_secs(1)
    }

    fn run(&mut self, context: &ProjectServiceRequestContext) {
        let budget = RailBudget::new(SCAN_BUDGET);
        let input = collect_watcher_sources(context, &budget);
        let effects = self.watchers.scan(&input);
        apply_effects(&self.context, &effects);
    }
}

/// Read every source the watchers look at, giving up early if the rail budget
/// runs out — a partial read simply means those watchers see no change.
pub fn collect_watcher_sources(
    context: &ProjectServiceRequestContext,
    budget: &RailBudget,
) -> Value {
    let project_root = context.project_root().to_path_buf();
    let project_state_dir = context.project_state_dir();

    // scan_history reads these as bare ids, not session objects.
    let session_ids = read_live_session_ids(&project_state_dir, budget);
    let live_sessions = session_ids.iter().cloned().collect::<BTreeSet<_>>();

    let plan_files = read_session_markdown_files(
        &plan_authority_dir_for_project_root(&project_root),
        &live_sessions,
        budget,
    );
    let status_files =
        read_session_markdown_files(&status_dir(&project_root), &live_sessions, budget);
    let exchange = read_exchange_with_budget(&project_state_dir, budget);

    let mut history = Map::new();
    for session_id in &session_ids {
        if budget.spent() {
            break;
        }
        let turns = read_history(
            &project_root,
            session_id,
            HistoryReadOptions {
                last_n: Some(1),
                max_bytes: Some(HISTORY_TAIL_BYTES),
                ..HistoryReadOptions::default()
            },
        );
        if !turns.is_empty() {
            // The watcher reads Node's `type`; the Rust turn calls it `kind`.
            let turns = turns
                .into_iter()
                .map(|turn| {
                    json!({
                        "ts": turn.ts,
                        "type": turn.kind,
                        "content": turn.content,
                    })
                })
                .collect::<Vec<_>>();
            history.insert(session_id.to_owned(), json!(turns));
        }
    }

    json!({
        "planFiles": plan_files,
        "statusFiles": status_files,
        "exchange": exchange,
        "sessions": session_ids,
        "history": history,
    })
}

fn read_live_session_ids(project_state_dir: &Path, budget: &RailBudget) -> Vec<String> {
    if budget.spent() {
        return Vec::new();
    }
    read_runtime_topology(runtime_topology_path(project_state_dir))
        .map(|topology| list_topology_session_states(&topology, Some(LIVE_SESSION_STATUSES)))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|session| {
            session
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect()
}

fn read_session_markdown_files(
    dir: &Path,
    live_sessions: &BTreeSet<String>,
    budget: &RailBudget,
) -> Map<String, Value> {
    let mut files = Map::new();
    if budget.spent() || live_sessions.is_empty() {
        return files;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return files;
    };
    let mut candidates = entries
        .flatten()
        .filter_map(|entry| markdown_session_file(entry.path(), live_sessions))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    for (session_id, path) in candidates.into_iter().take(MAX_PLAN_STATUS_FILES_PER_TICK) {
        if budget.spent() {
            break;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > MAX_PLAN_STATUS_FILE_BYTES {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            files.insert(session_id.to_owned(), Value::String(content));
        }
    }
    files
}

fn markdown_session_file(
    path: PathBuf,
    live_sessions: &BTreeSet<String>,
) -> Option<(String, PathBuf)> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
        return None;
    }
    // Keyed by session id, not filename: Node stripped the .md here.
    let session_id = path.file_stem().and_then(|stem| stem.to_str())?;
    // A stale note must not mint effects for a session that no longer exists.
    validate_plan_session_id(session_id)?;
    if !live_sessions.contains(session_id) {
        return None;
    }
    Some((session_id.to_owned(), path))
}

fn read_exchange_with_budget(project_state_dir: &Path, budget: &RailBudget) -> Value {
    if budget.spent() {
        return empty_runtime_exchange();
    }
    let path = runtime_exchange_path(project_state_dir);
    if fs::metadata(&path)
        .map(|metadata| metadata.len() > MAX_EXCHANGE_BYTES_PER_TICK)
        .unwrap_or(false)
    {
        return empty_runtime_exchange();
    }
    read_runtime_exchange(path)
}

/// Apply through the real routes rather than writing metadata directly: an
/// event carries a notification, and a hand-rolled write would drop it.
///
/// Effects arrive as the positional call shapes the recovered corpus records,
/// so the mapping to a request body lives here rather than in the watchers.
pub fn apply_effects(context: &ProjectServiceRequestContext, effects: &MetadataEffects) {
    let project_state_dir = context.project_state_dir();

    for status in &effects.statuses {
        // [session, text, tone]
        let Some(args) = status.as_array() else {
            continue;
        };
        post(
            context,
            routes::runtime::SET_STATUS,
            &json!({
                "session": arg(args, 0),
                "text": arg(args, 1),
                "tone": arg(args, 2),
            }),
        );
    }

    for progress in &effects.progresses {
        // [session, current, total, label]
        let Some(args) = progress.as_array() else {
            continue;
        };
        post(
            context,
            routes::runtime::SET_PROGRESS,
            &json!({
                "session": arg(args, 0),
                "current": arg(args, 1),
                "total": arg(args, 2),
                "label": arg(args, 3),
            }),
        );
    }

    for log in &effects.logs {
        // [session, message, source, tone]
        let Some(args) = log.as_array() else { continue };
        post(
            context,
            routes::runtime::LOG,
            &json!({
                "session": arg(args, 0),
                "message": arg(args, 1),
                "source": arg(args, 2),
                "tone": arg(args, 3),
            }),
        );
    }

    for event in &effects.events {
        // [session, kind, message, source, tone, ts]
        let Some(args) = event.as_array() else {
            continue;
        };
        let Some(session_id) = args.first().and_then(Value::as_str) else {
            continue;
        };
        let mut payload = Map::new();
        payload.insert("kind".into(), arg(args, 1));
        payload.insert("message".into(), arg(args, 2));
        payload.insert("source".into(), arg(args, 3));
        payload.insert("tone".into(), arg(args, 4));
        // Only when present: the event store stamps an ABSENT ts, but a null
        // one is written straight over derived.lastOutputAt.
        if let Some(ts) = args
            .get(5)
            .and_then(Value::as_str)
            .filter(|ts| !ts.is_empty())
        {
            payload.insert("ts".into(), Value::String(ts.to_owned()));
        }
        let payload = Value::Object(payload);
        route_runtime_event_with_context(context, &project_state_dir, session_id, payload);
    }
}

fn arg(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Null)
}

fn post(context: &ProjectServiceRequestContext, path: &str, body: &Value) {
    route_runtime_metadata_request(context, "POST", path, Some(body));
}

pub fn builtin_metadata_task(context: &Arc<ProjectServiceRequestContext>) -> Box<dyn PeriodicTask> {
    Box::new(BuiltinMetadataTask::new(Arc::clone(context)))
}
