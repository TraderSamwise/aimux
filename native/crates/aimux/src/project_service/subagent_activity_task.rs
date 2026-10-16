//! Scheduled sub-agent discovery; clients render the published metadata.
use super::metadata::update_session_metadata;
use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture};
use super::session_visibility::LIVE_SESSION_STATUSES;
use super::watcher_delivery::TickLoopBudget;
use crate::backend_session_ids::claude_transcript_path;
use crate::daemon_state::try_load_metadata_state;
use crate::debug_logging::{LogLevel, log_at};
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::subagent_activity::{
    CodexSubagentScan, SubagentPublish, SubagentRun, claude_subagent_key,
    claude_subagent_meta_path, claude_subagent_run, claude_subagent_running, claude_subagents_dir,
    subagent_publish,
};
use crate::transcript_turn_state::{default_codex_sessions_dir, probe_transcript};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SCAN_BUDGET: Duration = Duration::from_secs(2);
const CODEX_CHUNK: usize = 256 * 1024;
const MAX_RECORD_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct ClaudeSubagentCache {
    finished: HashMap<PathBuf, FileStamp>,
}
impl ClaudeSubagentCache {
    pub fn is_empty(&self) -> bool {
        self.finished.is_empty()
    }
    pub fn contains(&self, key: &str) -> bool {
        self.finished
            .keys()
            .any(|path| path.file_stem().and_then(|s| s.to_str()) == Some(key))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: SystemTime,
    device: u64,
    inode: u64,
}
impl FileStamp {
    fn from_metadata(meta: &Metadata) -> Result<Self, String> {
        Ok(Self {
            len: meta.len(),
            modified: meta.modified().map_err(|e| e.to_string())?,
            device: meta.dev(),
            inode: meta.ino(),
        })
    }
    fn millis(&self) -> Result<u64, String> {
        self.modified
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .map_err(|e| e.to_string())
    }
}

#[derive(Default)]
struct CodexRolloutFold {
    backend: String,
    path: Option<PathBuf>,
    retry_after: Option<Instant>,
    stamp: Option<FileStamp>,
    offset: u64,
    partial: Vec<u8>,
    prefix: Vec<u8>,
    checkpoint: Vec<u8>,
    skipping: bool,
    incomplete_reported: bool,
    scan: CodexSubagentScan,
}
impl CodexRolloutFold {
    fn save_checkpoint(&mut self, file: &mut File) -> Result<(), String> {
        let length = self.offset.min(1024) as usize;
        self.checkpoint = read_range(file, self.offset - length as u64, length)?;
        Ok(())
    }
    fn read(&mut self, path: &Path, now: u64, budget: &TickLoopBudget) -> ScanOutcome {
        if budget.spent() {
            return ScanOutcome::BudgetSpent;
        }
        match self.read_inner(path, now, budget) {
            Ok(result) => result,
            Err(error) => ScanOutcome::Unreadable(format!("{}: {error}", path.display())),
        }
    }
    fn read_inner(
        &mut self,
        path: &Path,
        now: u64,
        budget: &TickLoopBudget,
    ) -> Result<ScanOutcome, String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let stamp = FileStamp::from_metadata(&file.metadata().map_err(|e| e.to_string())?)?;
        let mut replaced = self.stamp.as_ref().is_none_or(|old| {
            old.device != stamp.device
                || old.inode != stamp.inode
                || stamp.len < old.len
                || stamp.len < self.offset
                || (old.len == stamp.len && old.modified != stamp.modified)
        });
        if !replaced {
            let prefix = read_range(&mut file, 0, self.prefix.len())?;
            let checkpoint = read_range(
                &mut file,
                self.offset.saturating_sub(self.checkpoint.len() as u64),
                self.checkpoint.len(),
            )?;
            replaced = prefix != self.prefix || checkpoint != self.checkpoint;
        }
        if replaced {
            self.offset = 0;
            self.checkpoint.clear();
            self.prefix.clear();
            self.incomplete_reported = false;
            self.partial.clear();
            self.skipping = false;
            self.scan = CodexSubagentScan::default();
        }
        self.stamp = Some(stamp.clone());
        if self.prefix.len() < stamp.len.min(1024) as usize {
            self.prefix = read_range(&mut file, 0, stamp.len.min(1024) as usize)?;
        }
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![0; (stamp.len.saturating_sub(self.offset) as usize).min(CODEX_CHUNK)];
        file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        for chunk in bytes.split_inclusive(|byte| *byte == b'\n') {
            if budget.spent() {
                self.save_checkpoint(&mut file)?;
                return Ok(ScanOutcome::BudgetSpent);
            }
            self.offset += chunk.len() as u64;
            let ends_line = chunk.last() == Some(&b'\n');
            if !self.skipping {
                if self.partial.len() + chunk.len() <= MAX_RECORD_BYTES {
                    self.partial.extend_from_slice(chunk);
                    if ends_line {
                        self.scan.fold(&String::from_utf8_lossy(&self.partial), now);
                        self.partial.clear();
                    }
                } else {
                    self.partial.clear();
                    self.skipping = true;
                    log_at(
                        LogLevel::Warn,
                        "skipping oversized Codex rollout record",
                        "subagent-activity",
                        Some(json!({ "path": path, "maxBytes": MAX_RECORD_BYTES })),
                    );
                }
            }
            if ends_line {
                self.skipping = false;
            }
        }
        self.save_checkpoint(&mut file)?;
        // No empty summary during replay: unseen history may still name live agents.
        if self.offset < stamp.len {
            return Ok(ScanOutcome::CatchingUp);
        }
        // Buffered EOF is not unread history. Keep its bytes, but still age
        // confirmed work so a crashed writer cannot pin a running badge.
        if self.partial.is_empty() && !self.skipping {
            self.incomplete_reported = false;
        } else if !self.incomplete_reported
            && now.saturating_sub(stamp.millis()?)
                >= crate::subagent_activity::SUBAGENT_STALE_AFTER_MS
        {
            log_at(
                LogLevel::Warn,
                "Codex rollout ends with an incomplete record",
                "subagent-activity",
                Some(json!({ "path": path, "offset": self.offset })),
            );
            self.incomplete_reported = true;
        }
        Ok(ScanOutcome::Read(self.scan.runs(now)))
    }
}

pub struct SubagentActivityTask {
    terminal: HashMap<String, ClaudeSubagentCache>,
    codex: HashMap<String, CodexRolloutFold>,
    codex_sessions_dir: PathBuf,
    cursor: u64,
}
impl SubagentActivityTask {
    pub fn new(_context: Arc<ProjectServiceRequestContext>) -> Self {
        Self {
            terminal: HashMap::new(),
            codex: HashMap::new(),
            codex_sessions_dir: default_codex_sessions_dir(),
            cursor: 0,
        }
    }
    fn publish(
        context: &ProjectServiceRequestContext,
        id: &str,
        outcome: SubagentPublish,
    ) -> Result<(), String> {
        let value = match outcome {
            SubagentPublish::Leave => return Ok(()),
            SubagentPublish::Clear => None,
            SubagentPublish::Set(value) => Some(value),
        };
        update_session_metadata(context.project_state_dir(), id, |mut current| {
            if let Some(map) = current.as_object_mut() {
                if let Some(value) = value {
                    map.insert("subagents".into(), value);
                } else {
                    map.remove("subagents");
                }
            }
            current
        })
        .map(|_| ())
        .map_err(|error| format!("sub-agent metadata for {id}: {error}"))
    }
    fn scan_sessions(
        &mut self,
        sessions: &[Value],
        metadata: &Value,
        now: u64,
        budget: &TickLoopBudget,
        publish_result: &mut dyn FnMut(&str, SubagentPublish) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut failures = Vec::new();
        let order = scan_order(sessions.len(), self.cursor);
        self.cursor = self.cursor.wrapping_add(1);
        let mut live = HashSet::new();
        let mut codex_live = HashSet::new();
        for index in order {
            let session = &sessions[index];
            let Some(id) = session
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            if !session_is_live(session) {
                record_publish(
                    id,
                    SubagentPublish::Clear,
                    budget,
                    publish_result,
                    &mut failures,
                );
                continue;
            }
            live.insert(id.to_owned());
            let outcome = if session.get("toolConfigKey").and_then(Value::as_str) == Some("codex") {
                codex_live.insert(id.to_owned());
                self.scan_codex(id, session, metadata, now, budget)
            } else if let Some(path) =
                session_transcript_path(session, metadata).and_then(claude_subagents_dir)
            {
                scan_subagents_dir(
                    &path,
                    now,
                    self.terminal.entry(id.to_owned()).or_default(),
                    budget,
                )
            } else {
                ScanOutcome::CatchingUp
            };
            let publish = match outcome {
                ScanOutcome::Read(runs) => subagent_publish(Some(&runs)),
                ScanOutcome::CatchingUp => SubagentPublish::Leave,
                ScanOutcome::BudgetSpent => {
                    log_at(
                        LogLevel::Warn,
                        "sub-agent scan budget exhausted",
                        "subagent-activity",
                        Some(json!({"sessionId":id})),
                    );
                    SubagentPublish::Leave
                }
                ScanOutcome::Unreadable(error) => {
                    log_at(
                        LogLevel::Warn,
                        "sub-agent scan failed",
                        "subagent-activity",
                        Some(json!({"sessionId":id,"error":error})),
                    );
                    SubagentPublish::Leave
                }
            };
            record_publish(id, publish, budget, publish_result, &mut failures);
        }
        self.terminal
            .retain(|id, _| live.contains(id) && !codex_live.contains(id));
        self.codex.retain(|id, _| codex_live.contains(id));
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
    fn scan_codex(
        &mut self,
        id: &str,
        session: &Value,
        metadata: &Value,
        now: u64,
        budget: &TickLoopBudget,
    ) -> ScanOutcome {
        if budget.spent() {
            return ScanOutcome::BudgetSpent;
        }
        let Some(backend) = backend_session_id(id, session, metadata) else {
            return ScanOutcome::CatchingUp;
        };
        let fold = self.codex.entry(id.to_owned()).or_default();
        if fold.backend != backend {
            *fold = CodexRolloutFold {
                backend: backend.clone(),
                ..Default::default()
            };
        }
        if let Some(path) = fold.path.as_ref() {
            match fs::metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fold.path = None;
                    fold.stamp = None;
                }
                Err(error) => return ScanOutcome::Unreadable(error.to_string()),
                Ok(_) => {}
            }
        }
        let stored = match stored_transcript_path(id, session, metadata) {
            Some(path) => match fs::metadata(&path) {
                Ok(_) => Some(path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return ScanOutcome::Unreadable(error.to_string()),
            },
            None => None,
        };
        if stored
            .as_ref()
            .is_some_and(|path| fold.path.as_ref() != Some(path))
        {
            fold.stamp = None;
            fold.path = stored;
        }
        if fold.path.is_none() {
            if fold.retry_after.is_some_and(|retry| Instant::now() < retry) {
                return ScanOutcome::CatchingUp;
            }
            match find_codex_path(&self.codex_sessions_dir, &backend, budget, 0) {
                Ok(Some(path)) => fold.path = Some(path),
                Ok(None) => {
                    fold.retry_after = Some(Instant::now() + Duration::from_secs(32));
                    return ScanOutcome::CatchingUp;
                }
                Err(error) => return ScanOutcome::Unreadable(error),
            }
        }
        let path = fold.path.clone().expect("resolved above");
        let slice = TickLoopBudget::new(budget.remaining().min(Duration::from_millis(250)));
        loop {
            let before = fold.offset;
            let outcome = fold.read(&path, now, &slice);
            if outcome != ScanOutcome::CatchingUp || fold.offset == before {
                return outcome;
            }
            if slice.spent() || budget.spent() {
                return ScanOutcome::BudgetSpent;
            }
        }
    }
}

impl PeriodicTask for SubagentActivityTask {
    fn name(&self) -> &str {
        "subagent-activity"
    }
    fn interval_ms(&self) -> i64 {
        8_000
    }
    fn timeout(&self) -> Duration {
        SCAN_BUDGET + Duration::from_secs(10)
    }
    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let dir = context.project_state_dir();
            let topology = read_runtime_topology(runtime_topology_path(&dir))
                .map_err(|e| format!("sub-agent topology: {e}"))?;
            let sessions = list_topology_session_states(&topology, None);
            let metadata = serde_json::to_value(
                try_load_metadata_state(&dir).map_err(|e| format!("sub-agent metadata: {e}"))?,
            )
            .map_err(|e| e.to_string())?;
            let now = now_millis().ok_or("sub-agent scan clock is before epoch")?;
            let budget = TickLoopBudget::new(SCAN_BUDGET);
            self.scan_sessions(&sessions, &metadata, now, &budget, &mut |id, outcome| {
                Self::publish(context, id, outcome)
            })
        })
    }
}

fn find_codex_path(
    dir: &Path,
    backend: &str,
    budget: &TickLoopBudget,
    depth: usize,
) -> Result<Option<PathBuf>, String> {
    if depth > 6 {
        return Ok(None);
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    for entry in entries {
        if budget.spent() {
            return Err("Codex transcript discovery budget exhausted".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            if let Some(path) = find_codex_path(&entry.path(), backend, budget, depth + 1)? {
                return Ok(Some(path));
            }
        } else if kind.is_file()
            && entry.file_name().to_str().is_some_and(|name| {
                name.starts_with("rollout-") && name.ends_with(&format!("-{backend}.jsonl"))
            })
        {
            return Ok(Some(entry.path()));
        }
    }
    Ok(None)
}
pub fn session_transcript_path(session: &Value, metadata: &Value) -> Option<PathBuf> {
    let id = session.get("id").and_then(Value::as_str)?;
    if session.get("toolConfigKey").and_then(Value::as_str) != Some("claude") {
        return None;
    }
    let record = metadata
        .get("sessions")
        .and_then(|sessions| sessions.get(id))?;
    let backend = backend_session_id(id, session, metadata)?;
    // The stored path first, validated against the backend id the way the
    // transcript reconciler validates it: it is both the cheap answer and the
    // only seam a test has, because the computed path always lands under the
    if let Some(stored) = stored_transcript_path(id, session, metadata) {
        return Some(stored);
    }
    let cwd = session
        .get("worktreePath")
        .and_then(Value::as_str)
        .or_else(|| {
            record
                .get("context")
                .and_then(|context| context.get("worktreePath"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())?;
    Some(claude_transcript_path(cwd, &backend, None))
}

/// The backend session id, from the topology or the metadata record.
fn backend_session_id(session_id: &str, session: &Value, metadata: &Value) -> Option<String> {
    let record = metadata
        .get("sessions")
        .and_then(|sessions| sessions.get(session_id));
    session
        .get("backendSessionId")
        .and_then(Value::as_str)
        .or_else(|| {
            record?
                .get("context")
                .and_then(|context| context.get("backendSessionId"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|backend| !backend.is_empty())
        .map(ToOwned::to_owned)
}

/// The transcript path the service recorded, if it still names this session.
///
/// A resumed session mints a new backend id and a new file, so a stored path
fn stored_transcript_path(session_id: &str, session: &Value, metadata: &Value) -> Option<PathBuf> {
    let backend = backend_session_id(session_id, session, metadata)?;
    metadata
        .get("sessions")
        .and_then(|sessions| sessions.get(session_id))?
        .get("context")
        .and_then(|context| context.get("transcriptPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .filter(|path| {
            crate::transcript_reconciler::stored_transcript_path_matches_backend(
                path,
                Some(&backend),
            ) || Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("rollout-") && name.ends_with(&format!("-{backend}.jsonl"))
                })
        })
        .map(PathBuf::from)
}

#[derive(Debug, PartialEq)]
pub enum ScanOutcome {
    Read(Vec<SubagentRun>),
    CatchingUp,
    BudgetSpent,
    Unreadable(String),
}

pub fn scan_subagents_dir(
    dir: &Path,
    now: u64,
    cache: &mut ClaudeSubagentCache,
    budget: &TickLoopBudget,
) -> ScanOutcome {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ScanOutcome::Read(Vec::new()),
        Err(e) => return ScanOutcome::Unreadable(format!("{}: {e}", dir.display())),
    };
    scan_subagent_entries(entries, dir, now, cache, budget)
}

fn scan_subagent_entries(
    entries: impl IntoIterator<Item = std::io::Result<fs::DirEntry>>,
    dir: &Path,
    now: u64,
    cache: &mut ClaudeSubagentCache,
    budget: &TickLoopBudget,
) -> ScanOutcome {
    cache.finished.retain(|path, _| path.parent() == Some(dir));
    let mut runs = Vec::new();
    for entry in entries {
        if budget.spent() {
            return ScanOutcome::BudgetSpent;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => return ScanOutcome::Unreadable(e.to_string()),
        };
        let name = entry.file_name();
        let Some(key) = name.to_str().and_then(claude_subagent_key) else {
            continue;
        };
        let path = entry.path();
        let stamp = match fs::metadata(&path)
            .map_err(|e| e.to_string())
            .and_then(|m| FileStamp::from_metadata(&m))
        {
            Ok(stamp) => stamp,
            Err(e) => return ScanOutcome::Unreadable(format!("{}: {e}", path.display())),
        };
        if cache.finished.get(&path) == Some(&stamp) {
            continue;
        }
        let updated = match stamp.millis() {
            Ok(ms) => ms,
            Err(e) => return ScanOutcome::Unreadable(e),
        };
        if !claude_subagent_running("unknown", updated, now) {
            continue;
        }
        let Some(probe) = probe_transcript("claude", &path) else {
            return ScanOutcome::Unreadable(format!("{} could not be probed", path.display()));
        };
        if probe.turn == "complete" {
            cache.finished.insert(path, stamp);
            continue;
        }
        cache.finished.remove(&path);
        let meta_path = claude_subagent_meta_path(&path);
        let started = meta_path
            .as_ref()
            .and_then(|p| fs::metadata(p).ok())
            .and_then(|m| FileStamp::from_metadata(&m).ok())
            .and_then(|m| m.millis().ok());
        let meta = meta_path
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok());
        runs.push(claude_subagent_run(key, meta.as_ref(), started, updated));
    }
    ScanOutcome::Read(runs)
}
pub fn scan_order(len: usize, cursor: u64) -> Vec<usize> {
    if len == 0 {
        return Vec::new();
    }
    let start = (cursor % len as u64) as usize;
    (0..len).map(|offset| (start + offset) % len).collect()
}

fn now_millis() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|since| since.as_millis() as u64)
}

/// Whether a session could have a sub-agent running inside it.
pub fn session_is_live(session: &Value) -> bool {
    session
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| LIVE_SESSION_STATUSES.contains(&status))
}

pub fn subagent_activity_task(
    context: &Arc<ProjectServiceRequestContext>,
) -> Box<dyn PeriodicTask> {
    Box::new(SubagentActivityTask::new(Arc::clone(context)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Rollout(PathBuf);
    impl Rollout {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "aimux-subagents-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("mkdir");
            Self(path.join("rollout.jsonl"))
        }
    }
    impl Drop for Rollout {
        fn drop(&mut self) {
            fs::remove_dir_all(self.0.parent().unwrap()).expect("cleanup");
        }
    }
    fn spawn(name: &str) -> Vec<u8> {
        format!(
            "{}\n{}\n",
            json!({"type":"response_item","payload":{
            "type":"function_call","name":"spawn_agent","call_id":name,"arguments":"{}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":name,
            "output":json!({"task_name":format!("/root/{name}")}).to_string()}})
        )
        .into_bytes()
    }
    fn read(fold: &mut CodexRolloutFold, path: &Path) -> ScanOutcome {
        fold.read(path, 1_000, &TickLoopBudget::new(Duration::from_secs(2)))
    }
    fn count(outcome: ScanOutcome) -> usize {
        match outcome {
            ScanOutcome::Read(runs) => runs.len(),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn codex_replays_existing_spawns_on_first_look() {
        let rollout = Rollout::new();
        fs::write(&rollout.0, spawn("before-start")).unwrap();
        assert_eq!(count(read(&mut CodexRolloutFold::default(), &rollout.0)), 1);
    }
    #[test]
    fn codex_truncation_rebuilds_and_replacement_changes_file_identity() {
        let rollout = Rollout::new();
        let mut original = spawn("old-one");
        original.extend(spawn("old-two"));
        fs::write(&rollout.0, original).unwrap();
        let mut fold = CodexRolloutFold::default();
        assert_eq!(count(read(&mut fold, &rollout.0)), 2);
        fs::write(&rollout.0, spawn("new")).unwrap();
        assert_eq!(count(read(&mut fold, &rollout.0)), 1);
        fs::write(rollout.0.with_extension("swap"), spawn("replacement")).unwrap();
        fs::rename(rollout.0.with_extension("swap"), &rollout.0).unwrap();
        match read(&mut fold, &rollout.0) {
            ScanOutcome::Read(runs) => assert_eq!(runs[0].name, "replacement"),
            other => panic!("{other:?}"),
        }
    }
    #[test]
    fn codex_shrink_during_replay_restarts_from_the_beginning() {
        let rollout = Rollout::new();
        let mut old = spawn("old");
        old.extend(vec![b' '; CODEX_CHUNK * 4]);
        fs::write(&rollout.0, old).unwrap();
        let mut fold = CodexRolloutFold::default();
        assert_eq!(read(&mut fold, &rollout.0), ScanOutcome::CatchingUp);
        let mut replacement = spawn("new");
        replacement.extend(vec![b' '; CODEX_CHUNK + 100]);
        replacement.push(b'\n');
        fs::write(&rollout.0, replacement).unwrap();
        assert_eq!(read(&mut fold, &rollout.0), ScanOutcome::CatchingUp);
        match read(&mut fold, &rollout.0) {
            ScanOutcome::Read(runs) => {
                assert_eq!(runs.len(), 1);
                assert_eq!(runs[0].name, "new");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn codex_cursor_counts_raw_bytes_across_multibyte_boundaries() {
        let rollout = Rollout::new();
        let mut bytes = vec![b' '; CODEX_CHUNK - 1];
        bytes.extend_from_slice("é\n".as_bytes());
        bytes.extend(spawn("unicode"));
        fs::write(&rollout.0, &bytes).unwrap();
        let mut fold = CodexRolloutFold::default();
        assert_eq!(read(&mut fold, &rollout.0), ScanOutcome::CatchingUp);
        assert_eq!(fold.offset, CODEX_CHUNK as u64);
        assert_eq!(count(read(&mut fold, &rollout.0)), 1);
        assert_eq!(fold.offset, bytes.len() as u64);
    }
    #[test]
    fn incomplete_eof_does_not_prevent_confirmed_work_expiring() {
        let rollout = Rollout::new();
        let mut bytes = spawn("live");
        bytes.extend_from_slice(b"{\"type\":");
        fs::write(&rollout.0, bytes).unwrap();
        let mut fold = CodexRolloutFold::default();
        assert_eq!(count(read(&mut fold, &rollout.0)), 1);
        assert!(!fold.partial.is_empty());
        let expired = fold.read(
            &rollout.0,
            1_000 + crate::subagent_activity::SUBAGENT_STALE_AFTER_MS,
            &TickLoopBudget::new(Duration::from_secs(1)),
        );
        assert_eq!(count(expired), 0);
        assert!(
            !fold.partial.is_empty(),
            "preserve bytes until the writer completes them"
        );
    }

    #[test]
    fn codex_does_no_read_when_budget_is_spent() {
        let rollout = Rollout::new();
        fs::write(&rollout.0, spawn("live")).unwrap();
        let mut fold = CodexRolloutFold::default();
        assert_eq!(
            fold.read(&rollout.0, 1_000, &TickLoopBudget::new(Duration::ZERO)),
            ScanOutcome::BudgetSpent
        );
        assert_eq!(fold.offset, 0);
        assert_eq!(count(read(&mut fold, &rollout.0)), 1);
    }
    #[test]
    fn codex_replays_multiple_chunks_and_recovers_a_moved_rollout() {
        let rollout = Rollout::new();
        let root = rollout.0.parent().unwrap();
        let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
            root,
            root.join("state"),
        ));
        let mut task = SubagentActivityTask::new(context);
        task.codex_sessions_dir = root.to_path_buf();
        let old_path = root.join("rollout-old-be-1.jsonl");
        let mut contents = vec![b' '; CODEX_CHUNK * 2];
        contents.push(b'\n');
        contents.extend(spawn("moving"));
        fs::write(&old_path, contents).unwrap();
        let session = json!({"id":"s1","toolConfigKey":"codex","backendSessionId":"be-1"});
        let metadata = json!({"sessions":{"s1":{"context":{"transcriptPath":old_path}}}});
        let budget = TickLoopBudget::new(Duration::from_secs(2));
        assert_eq!(
            count(task.scan_codex("s1", &session, &metadata, 1_000, &budget)),
            1
        );
        let moved = root.join("rollout-moved-be-1.jsonl");
        fs::rename(&old_path, &moved).unwrap();
        assert_eq!(
            count(task.scan_codex("s1", &session, &metadata, 1_000, &budget)),
            1
        );
        assert_eq!(task.codex["s1"].path.as_ref(), Some(&moved));
    }

    #[test]
    fn unrelated_outputs_and_failed_spawns_cannot_invent_or_retire_agents() {
        let mut scan = CodexSubagentScan::default();
        scan.fold(std::str::from_utf8(&spawn("real")).unwrap(), 1_000);
        let fake = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"unrelated",
            "output":"{\"task_name\":\"/root/fake\"}"}});
        let empty = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"unrelated",
            "output":"{\"agents\":[]}"}});
        scan.fold(&format!("{fake}\n{empty}\n"), 1_000);
        let failed = json!({"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"fail"}});
        let error = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"fail","output":"error"}});
        scan.fold(&format!("{failed}\n{error}\n"), 1_000);
        let runs = scan.runs(1_000);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].name, "real");
    }
}

#[cfg(test)]
mod directory_errors {
    use super::*;
    #[test]
    fn entry_error_is_not_an_empty_directory() {
        let entries = std::iter::once(Err(std::io::Error::other("directory read failed")));
        let result = scan_subagent_entries(
            entries,
            Path::new("/unused"),
            0,
            &mut ClaudeSubagentCache::default(),
            &TickLoopBudget::new(Duration::from_secs(1)),
        );
        assert!(
            matches!(result, ScanOutcome::Unreadable(reason) if reason.contains("directory read failed"))
        );
    }
}

fn record_publish(
    id: &str,
    outcome: SubagentPublish,
    budget: &TickLoopBudget,
    publish: &mut dyn FnMut(&str, SubagentPublish) -> Result<(), String>,
    failures: &mut Vec<String>,
) {
    let result = if budget.spent() && !matches!(outcome, SubagentPublish::Leave) {
        Err(format!(
            "sub-agent metadata for {id} deferred: scan budget exhausted"
        ))
    } else {
        publish(id, outcome)
    };
    if let Err(error) = result {
        log_at(
            LogLevel::Warn,
            "sub-agent metadata publish failed",
            "subagent-activity",
            Some(json!({"sessionId": id, "error": error})),
        );
        failures.push(error);
    }
}

#[cfg(test)]
mod publish_failures {
    use super::*;
    #[test]
    fn failed_publish_does_not_skip_later_sessions_or_cache_cleanup() {
        let mut task = SubagentActivityTask::new(Arc::new(
            ProjectServiceRequestContext::with_project_state_dir(
                Path::new("/unused"),
                Path::new("/unused/state"),
            ),
        ));
        task.terminal
            .insert("gone".into(), ClaudeSubagentCache::default());
        task.codex
            .insert("gone".into(), CodexRolloutFold::default());
        let sessions = vec![
            json!({"id":"first", "status":"offline"}),
            json!({"id":"second","status":"offline"}),
        ];
        let mut attempted = Vec::new();
        let result = task.scan_sessions(
            &sessions,
            &json!({}),
            0,
            &TickLoopBudget::new(Duration::from_secs(2)),
            &mut |id, outcome| {
                assert_eq!(outcome, SubagentPublish::Clear);
                attempted.push(id.to_owned());
                if id == "first" {
                    Err("simulated publish failure".into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.unwrap_err().contains("simulated publish failure"));
        assert_eq!(attempted, vec!["first", "second"]);
        assert!(task.terminal.is_empty());
        assert!(task.codex.is_empty());
    }
}

fn read_range(file: &mut File, start: u64, length: usize) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod longer_rewrites {
    use super::*;
    #[test]
    fn rewrite_to_longer_contents_rebuilds_old_cursor() {
        let root =
            std::env::temp_dir().join(format!("aimux-longer-rewrite-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        fn events(name: &str) -> String {
            format!(
                "{}\n{}\n",
                json!({"type":"response_item","payload":{
                "type":"function_call","name":"spawn_agent","call_id":name}}),
                json!({"type":"response_item","payload":{"type":"function_call_output","call_id":name,
                "output":json!({"task_name":format!("/root/{name}")}).to_string()}})
            )
        }
        fs::write(&path, events("old")).unwrap();
        let mut fold = CodexRolloutFold::default();
        let budget = TickLoopBudget::new(Duration::from_secs(2));
        assert!(
            matches!(fold.read(&path, 1_000, &budget), ScanOutcome::Read(runs) if runs[0].name == "old")
        );
        fs::write(&path, events("replacement-with-a-longer-description")).unwrap();
        assert!(
            matches!(fold.read(&path, 1_000, &budget), ScanOutcome::Read(runs)
            if runs.len()==1 && runs[0].name=="replacement-with-a-longer-description")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
