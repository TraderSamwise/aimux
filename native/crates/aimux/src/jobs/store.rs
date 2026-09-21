use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::atomic_write::{atomic_write, write_json_atomic};
use crate::debug_logging::{sanitize_log_string, sanitize_log_value};
use crate::paths::PathResolver;
use crate::secure_permissions::{self, PRIVATE_FILE_MODE};
use crate::state_update_lock::acquire_state_update_lock;

use super::scope::JobScope;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateOrJoin {
    Created,
    Joined,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobStatus {
    fn is_terminal(&self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobSpec {
    pub scope: JobScope,
    pub skill: String,
    pub tool: Option<String>,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub idempotency_key: String,
    pub scope: JobScope,
    pub skill: String,
    pub tool: Option<String>,
    pub args: Vec<String>,
    pub status: JobStatus,
    pub created_at_ms: u128,
    pub updated_at_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobEventInput {
    pub kind: String,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobEvent {
    pub seq: u64,
    pub created_at_ms: u128,
    pub kind: String,
    pub data: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobListFilter {
    pub scope: Option<JobScope>,
    pub status: Option<JobStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobRetention {
    pub max_jobs: usize,
    pub max_events_per_job: usize,
    pub terminal_job_retention_ms: u128,
}

pub const DEFAULT_JOB_RETENTION: JobRetention = JobRetention {
    max_jobs: 1_000,
    max_events_per_job: 1_000,
    terminal_job_retention_ms: 14 * 24 * 60 * 60 * 1_000,
};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PruneReport {
    pub removed_jobs: usize,
    pub truncated_event_logs: usize,
    pub removed_events: usize,
}

#[derive(Debug)]
pub enum JobStoreError {
    MissingJob { id: String },
    EmptyEventLog { id: String },
    InvalidSpec(String),
    StoreUnavailable { path: PathBuf, error: String },
    CorruptStore { path: PathBuf, error: String },
}

impl fmt::Display for JobStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingJob { id } => write!(formatter, "job not found: {id}"),
            Self::EmptyEventLog { id } => write!(formatter, "job event log is empty: {id}"),
            Self::InvalidSpec(error) => write!(formatter, "invalid job spec: {error}"),
            Self::StoreUnavailable { path, error } => {
                write!(
                    formatter,
                    "job store unavailable at {}: {error}",
                    path.display()
                )
            }
            Self::CorruptStore { path, error } => {
                write!(
                    formatter,
                    "job store corrupt at {}: {error}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for JobStoreError {}

pub type Result<T> = std::result::Result<T, JobStoreError>;

#[derive(Debug, Clone)]
pub struct JobStore {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JobIndexEntry {
    job_id: String,
    idempotency_key: String,
}

impl JobStore {
    pub fn from_env() -> Self {
        Self::new(PathResolver::from_env().jobs_dir())
    }

    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn create_or_join(&self, spec: &JobSpec) -> Result<(JobRecord, CreateOrJoin)> {
        let key = idempotency_key(spec)?;
        let job_id = job_id_for_key(&key);
        self.ensure_dirs()?;
        let entry_path = self.index_path(&key);
        let entry = JobIndexEntry {
            job_id: job_id.clone(),
            idempotency_key: key.clone(),
        };
        match create_index_entry(&entry_path, &entry) {
            Ok(()) => {
                let now = now_ms();
                let record = JobRecord {
                    id: job_id,
                    idempotency_key: key,
                    scope: spec.scope.clone(),
                    skill: sanitize_log_string(&spec.skill),
                    tool: spec.tool.as_deref().map(sanitize_log_string),
                    args: spec
                        .args
                        .iter()
                        .map(|arg| sanitize_log_string(arg))
                        .collect(),
                    status: JobStatus::Queued,
                    created_at_ms: now,
                    updated_at_ms: now,
                };
                if let Err(error) = self.write_record(&record) {
                    let _ = fs::remove_file(&entry_path);
                    return Err(error);
                }
                Ok((record, CreateOrJoin::Created))
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let entry = self.read_joined_index_entry(&entry_path)?;
                let record = self.load_joined_record(&entry.job_id)?;
                Ok((record, CreateOrJoin::Joined))
            }
            Err(error) => Err(io_error(&entry_path, error)),
        }
    }

    pub fn load(&self, id: &str) -> Result<JobRecord> {
        let path = self.status_path(id);
        match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).map_err(|error| JobStoreError::CorruptStore {
                path,
                error: error.to_string(),
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Err(JobStoreError::MissingJob { id: id.to_owned() })
            }
            Err(error) => Err(io_error(&path, error)),
        }
    }

    pub fn append_event(&self, id: &str, event: JobEventInput) -> Result<JobEvent> {
        self.load(id)?;
        let events_path = self.events_path(id);
        let _lock = acquire_state_update_lock(&events_path).map_err(|error| {
            JobStoreError::StoreUnavailable {
                path: events_path.clone(),
                error,
            }
        })?;
        let seq = match self.read_events_from_unlocked(id, 0) {
            Ok(events) => events.last().map(|event| event.seq + 1).unwrap_or(0),
            Err(JobStoreError::EmptyEventLog { .. }) => 0,
            Err(error) => return Err(error),
        };
        let event = JobEvent {
            seq,
            created_at_ms: now_ms(),
            kind: sanitize_log_string(&event.kind),
            data: sanitize_log_value(&event.data),
        };
        append_jsonl(&events_path, &event)?;
        Ok(event)
    }

    pub fn read_events_from(&self, id: &str, seq: u64) -> Result<Vec<JobEvent>> {
        self.load(id)?;
        self.read_events_from_unlocked(id, seq)
    }

    pub fn set_status(&self, id: &str, status: JobStatus) -> Result<JobRecord> {
        let mut record = self.load(id)?;
        record.status = status;
        record.updated_at_ms = now_ms();
        self.write_record(&record)?;
        Ok(record)
    }

    pub fn list(&self, filter: JobListFilter) -> Result<Vec<JobRecord>> {
        let records_dir = self.records_dir();
        match fs::read_dir(&records_dir) {
            Ok(entries) => {
                let mut records = Vec::new();
                for entry in entries {
                    let entry = entry.map_err(|error| io_error(&records_dir, error))?;
                    if !entry
                        .file_type()
                        .map_err(|error| io_error(&entry.path(), error))?
                        .is_dir()
                    {
                        continue;
                    }
                    let id = entry.file_name().to_string_lossy().into_owned();
                    let record = self.load(&id)?;
                    if filter
                        .scope
                        .as_ref()
                        .is_some_and(|scope| scope != &record.scope)
                    {
                        continue;
                    }
                    if filter
                        .status
                        .as_ref()
                        .is_some_and(|status| status != &record.status)
                    {
                        continue;
                    }
                    records.push(record);
                }
                records.sort_by_key(|record| record.created_at_ms);
                Ok(records)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(io_error(&records_dir, error)),
        }
    }

    pub fn prune(&self, retention: JobRetention, now_ms: u128) -> Result<PruneReport> {
        let mut report = PruneReport::default();
        let records = self.list(JobListFilter::default())?;
        for record in &records {
            let (truncated, removed) = self.prune_events(record, retention.max_events_per_job)?;
            if truncated {
                report.truncated_event_logs += 1;
                report.removed_events += removed;
            }
        }

        let cutoff = now_ms.saturating_sub(retention.terminal_job_retention_ms);
        let mut removable = records
            .into_iter()
            .filter(|record| record.status.is_terminal())
            .collect::<Vec<_>>();
        removable.sort_by_key(|record| record.updated_at_ms);
        let protected_terminal_ids = removable
            .iter()
            .rev()
            .take(retention.max_jobs)
            .map(|record| record.id.clone())
            .collect::<BTreeSet<_>>();
        for record in removable {
            if record.updated_at_ms >= cutoff && protected_terminal_ids.contains(&record.id) {
                continue;
            }
            self.remove_record(&record)?;
            report.removed_jobs += 1;
        }
        Ok(report)
    }

    fn load_joined_record(&self, id: &str) -> Result<JobRecord> {
        let mut last_missing = None;
        for _ in 0..50 {
            match self.load(id) {
                Ok(record) => return Ok(record),
                Err(JobStoreError::MissingJob { .. }) => {
                    last_missing = Some(id.to_owned());
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        }
        Err(JobStoreError::MissingJob {
            id: last_missing.unwrap_or_else(|| id.to_owned()),
        })
    }

    fn read_joined_index_entry(&self, path: &Path) -> Result<JobIndexEntry> {
        let mut last_error = None;
        for _ in 0..50 {
            match self.read_index_entry(path) {
                Ok(entry) => return Ok(entry),
                Err(JobStoreError::CorruptStore { error, .. })
                    if error.contains("EOF while parsing a value") =>
                {
                    last_error = Some(error);
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        }
        Err(JobStoreError::CorruptStore {
            path: path.to_path_buf(),
            error: last_error.unwrap_or_else(|| "index entry was not readable".to_owned()),
        })
    }

    fn read_events_from_unlocked(&self, id: &str, seq: u64) -> Result<Vec<JobEvent>> {
        let path = self.events_path(id);
        let mut raw = String::new();
        match fs::File::open(&path) {
            Ok(mut file) => {
                file.read_to_string(&mut raw)
                    .map_err(|error| io_error(&path, error))?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(JobStoreError::EmptyEventLog { id: id.to_owned() });
            }
            Err(error) => return Err(io_error(&path, error)),
        }
        let mut events = Vec::new();
        for (index, line) in raw.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let event = serde_json::from_str::<JobEvent>(line).map_err(|error| {
                JobStoreError::CorruptStore {
                    path: path.clone(),
                    error: format!("line {}: {error}", index + 1),
                }
            })?;
            if event.seq >= seq {
                events.push(event);
            }
        }
        if events.is_empty() {
            return Err(JobStoreError::EmptyEventLog { id: id.to_owned() });
        }
        Ok(events)
    }

    fn prune_events(&self, record: &JobRecord, max_events: usize) -> Result<(bool, usize)> {
        if max_events == 0 {
            return Ok((false, 0));
        }
        let all_events = match self.read_events_from_unlocked(&record.id, 0) {
            Ok(events) => events,
            Err(JobStoreError::EmptyEventLog { .. }) => return Ok((false, 0)),
            Err(error) => return Err(error),
        };
        if all_events.len() <= max_events {
            return Ok((false, 0));
        }
        let removed = all_events.len() - max_events;
        let retained = &all_events[removed..];
        let mut text = String::new();
        for event in retained {
            let line =
                serde_json::to_string(event).map_err(|error| JobStoreError::CorruptStore {
                    path: self.events_path(&record.id),
                    error: error.to_string(),
                })?;
            text.push_str(&line);
            text.push('\n');
        }
        atomic_write(self.events_path(&record.id), text)
            .map_err(|error| io_error(&self.events_path(&record.id), error))?;
        Ok((true, removed))
    }

    fn remove_record(&self, record: &JobRecord) -> Result<()> {
        let record_dir = self.record_dir(&record.id);
        match fs::remove_dir_all(&record_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(&record_dir, error)),
        }
        let index_path = self.index_path(&record.idempotency_key);
        match fs::remove_file(&index_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(&index_path, error)),
        }
        Ok(())
    }

    fn write_record(&self, record: &JobRecord) -> Result<()> {
        let path = self.status_path(&record.id);
        write_json_atomic(&path, record).map_err(|error| io_error(&path, error))
    }

    fn read_index_entry(&self, path: &Path) -> Result<JobIndexEntry> {
        let raw = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
        serde_json::from_str(&raw).map_err(|error| JobStoreError::CorruptStore {
            path: path.to_path_buf(),
            error: error.to_string(),
        })
    }

    fn ensure_dirs(&self) -> Result<()> {
        for path in [self.index_dir(), self.records_dir()] {
            secure_permissions::ensure_private_dir(&path)
                .map_err(|error| io_error(&path, error))?;
        }
        Ok(())
    }

    fn index_dir(&self) -> PathBuf {
        self.root.join("index")
    }

    fn records_dir(&self) -> PathBuf {
        self.root.join("records")
    }

    fn index_path(&self, key: &str) -> PathBuf {
        self.index_dir().join(format!("{key}.json"))
    }

    fn record_dir(&self, id: &str) -> PathBuf {
        self.records_dir().join(id)
    }

    fn status_path(&self, id: &str) -> PathBuf {
        self.record_dir(id).join("status.json")
    }

    fn events_path(&self, id: &str) -> PathBuf {
        self.record_dir(id).join("events.ndjson")
    }
}

pub fn prune_jobs(retention: JobRetention, now_ms: u128) -> Result<PruneReport> {
    JobStore::from_env().prune(retention, now_ms)
}

pub fn idempotency_key(spec: &JobSpec) -> Result<String> {
    if spec.skill.trim().is_empty() {
        return Err(JobStoreError::InvalidSpec(
            "skill must not be empty".to_owned(),
        ));
    }
    let identity = json!({
        "scope": spec.scope.identity_value(),
        "skill": spec.skill,
        "args": spec.args,
    });
    let raw = serde_json::to_vec(&identity).map_err(|error| {
        JobStoreError::InvalidSpec(format!("could not encode idempotency identity: {error}"))
    })?;
    let mut hasher = Sha256::new();
    hasher.update(raw);
    Ok(format!("{:x}", hasher.finalize()))
}

fn job_id_for_key(key: &str) -> String {
    format!("job-{key}")
}

fn create_index_entry(path: &Path, entry: &JobIndexEntry) -> io::Result<()> {
    secure_permissions::ensure_private_parent(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(PRIVATE_FILE_MODE);
    }
    let mut file = options.open(path)?;
    let mut data = serde_json::to_string_pretty(entry).map_err(io::Error::other)?;
    data.push('\n');
    file.write_all(data.as_bytes())?;
    file.sync_all()?;
    secure_permissions::set_private_file_mode(path)?;
    Ok(())
}

fn append_jsonl(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut line = serde_json::to_string(value).map_err(|error| JobStoreError::CorruptStore {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    line.push('\n');
    let mut file =
        secure_permissions::open_private_append(path).map_err(|error| io_error(path, error))?;
    file.write_all(line.as_bytes())
        .map_err(|error| io_error(path, error))?;
    file.sync_all().map_err(|error| io_error(path, error))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn io_error(path: &Path, error: io::Error) -> JobStoreError {
    JobStoreError::StoreUnavailable {
        path: path.to_path_buf(),
        error: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Arc, Barrier};

    fn store(label: &str) -> JobStore {
        let root = std::env::temp_dir().join(format!(
            "aimux-jobs-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        JobStore::new(root)
    }

    fn spec_with_arg(arg: &str) -> JobSpec {
        JobSpec {
            scope: JobScope::Project {
                project_id: "project-1".to_owned(),
            },
            skill: "review-pr".to_owned(),
            tool: Some("codex".to_owned()),
            args: vec![arg.to_owned()],
        }
    }

    #[test]
    fn concurrent_create_or_join_has_one_winner_and_one_joiner() {
        let store = Arc::new(store("race"));
        let spec = Arc::new(spec_with_arg("--pr=123"));
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let store = store.clone();
                let spec = spec.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    store.create_or_join(&spec)
                })
            })
            .collect::<Vec<_>>();
        let mut outcomes = Vec::new();
        for handle in handles {
            outcomes.push(handle.join().expect("thread joined").expect("job outcome"));
        }
        assert_eq!(outcomes[0].0.id, outcomes[1].0.id);
        let created = outcomes
            .iter()
            .filter(|(_, outcome)| *outcome == CreateOrJoin::Created)
            .count();
        let joined = outcomes
            .iter()
            .filter(|(_, outcome)| *outcome == CreateOrJoin::Joined)
            .count();
        assert_eq!(created, 1);
        assert_eq!(joined, 1);
    }

    #[test]
    fn idempotency_keys_use_scope_skill_and_raw_args() {
        let same_a = spec_with_arg("token=alpha");
        let same_b = spec_with_arg("token=alpha");
        let different_arg = spec_with_arg("token=bravo");
        let different_scope = JobSpec {
            scope: JobScope::Global,
            ..same_a.clone()
        };
        assert_eq!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&same_b).unwrap()
        );
        assert_ne!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_arg).unwrap()
        );
        assert_ne!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_scope).unwrap()
        );
    }

    #[test]
    fn project_scope_canonicalizes_equivalent_project_root_spellings() {
        let root = std::env::temp_dir().join(format!(
            "aimux-jobs-canonical-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let repo = root.join("repo");
        fs::create_dir_all(repo.join(".git")).expect("git marker");
        let mut resolver = PathResolver::new(&repo, root.join("home"), None);
        let direct = JobScope::project_for(&mut resolver, &repo);
        let dotted = JobScope::project_for(&mut resolver, repo.join("."));
        let spec_a = JobSpec {
            scope: direct,
            skill: "build".to_owned(),
            tool: Some("codex".to_owned()),
            args: vec!["--fast".to_owned()],
        };
        let spec_b = JobSpec {
            scope: dotted,
            skill: "build".to_owned(),
            tool: Some("codex".to_owned()),
            args: vec!["--fast".to_owned()],
        };
        assert_eq!(
            idempotency_key(&spec_a).unwrap(),
            idempotency_key(&spec_b).unwrap()
        );
    }

    #[test]
    fn missing_job_empty_log_and_corrupt_store_are_distinct() {
        let store = store("errors");
        match store.load("missing") {
            Err(JobStoreError::MissingJob { id }) => assert_eq!(id, "missing"),
            other => panic!("expected missing job, got {other:?}"),
        }
        let (record, _) = store
            .create_or_join(&spec_with_arg("--empty-log"))
            .expect("created");
        match store.read_events_from(&record.id, 0) {
            Err(JobStoreError::EmptyEventLog { id }) => assert_eq!(id, record.id),
            other => panic!("expected empty event log, got {other:?}"),
        }
        fs::write(store.status_path(&record.id), "{not-json").expect("corrupt status");
        match store.load(&record.id) {
            Err(JobStoreError::CorruptStore { .. }) => {}
            other => panic!("expected corrupt store, got {other:?}"),
        }
    }

    #[test]
    fn status_persists_sanitized_args_but_key_uses_raw_args() {
        let store = store("sanitized");
        let spec = spec_with_arg("apiToken=super-secret-token");
        let key = idempotency_key(&spec).expect("key");
        let (record, created) = store.create_or_join(&spec).expect("created");
        assert_eq!(created, CreateOrJoin::Created);
        let raw_status =
            fs::read_to_string(store.status_path(&record.id)).expect("status file readable");
        assert!(!raw_status.contains("super-secret-token"));
        assert!(raw_status.contains("<redacted>"));
        let (joined, joined_outcome) = store.create_or_join(&spec).expect("joined");
        assert_eq!(joined_outcome, CreateOrJoin::Joined);
        assert_eq!(joined.id, record.id);
        assert_eq!(joined.idempotency_key, key);
    }

    #[test]
    fn event_log_assigns_seq_and_replays_from_seq() {
        let store = store("events");
        let (record, _) = store
            .create_or_join(&spec_with_arg("--events"))
            .expect("created");
        let first = store
            .append_event(
                &record.id,
                JobEventInput {
                    kind: "stdout".to_owned(),
                    data: json!({ "text": "one" }),
                },
            )
            .expect("first event");
        let second = store
            .append_event(
                &record.id,
                JobEventInput {
                    kind: "stdout".to_owned(),
                    data: json!({ "text": "two" }),
                },
            )
            .expect("second event");
        assert_eq!(first.seq, 0);
        assert_eq!(second.seq, 1);
        let replay = store.read_events_from(&record.id, 1).expect("replay");
        assert_eq!(replay, vec![second]);
    }

    #[test]
    fn retention_truncates_event_log_cap() {
        let store = store("retention");
        let (record, _) = store
            .create_or_join(&spec_with_arg("--retention"))
            .expect("created");
        for index in 0..5 {
            store
                .append_event(
                    &record.id,
                    JobEventInput {
                        kind: "line".to_owned(),
                        data: json!({ "index": index }),
                    },
                )
                .expect("append");
        }
        let report = store
            .prune(
                JobRetention {
                    max_jobs: 100,
                    max_events_per_job: 2,
                    terminal_job_retention_ms: DEFAULT_JOB_RETENTION.terminal_job_retention_ms,
                },
                now_ms(),
            )
            .expect("prune");
        assert_eq!(report.truncated_event_logs, 1);
        assert_eq!(report.removed_events, 3);
        let events = store.read_events_from(&record.id, 0).expect("events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 3);
        assert_eq!(events[1].seq, 4);
    }
}
