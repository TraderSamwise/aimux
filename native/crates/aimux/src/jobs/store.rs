use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CancelOutcome {
    Cancelled,
    CancelRequested,
    Noop,
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
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub idempotency_key: String,
    pub scope: JobScope,
    pub skill: String,
    pub tool: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub status: JobStatus,
    #[serde(default, rename = "tmuxTarget")]
    pub tmux_target: Option<JobTmuxTarget>,
    #[serde(default, rename = "outputTapPath")]
    pub output_tap_path: Option<String>,
    #[serde(default, rename = "outputOffset")]
    pub output_offset: u64,
    #[serde(default, rename = "exitCode")]
    pub exit_code: Option<i32>,
    #[serde(default, rename = "terminalReason")]
    pub terminal_reason: Option<String>,
    #[serde(default, rename = "cancelSignal")]
    pub cancel_signal: Option<String>,
    pub created_at_ms: u128,
    pub updated_at_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobTmuxTarget {
    pub session_name: String,
    pub window_id: String,
    pub window_index: i64,
    pub window_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobMaterial {
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
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
    pub removed_orphan_indexes: usize,
    pub truncated_event_logs: usize,
    pub removed_events: usize,
}

#[derive(Debug)]
pub enum JobStoreError {
    MissingJob {
        id: String,
    },
    EmptyEventLog {
        id: String,
    },
    InvalidStatusTransition {
        id: String,
        from: JobStatus,
        to: JobStatus,
    },
    InvalidSpec(String),
    StoreUnavailable {
        path: PathBuf,
        error: String,
    },
    CorruptStore {
        path: PathBuf,
        error: String,
    },
}

impl fmt::Display for JobStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingJob { id } => write!(formatter, "job not found: {id}"),
            Self::EmptyEventLog { id } => write!(formatter, "job event log is empty: {id}"),
            Self::InvalidStatusTransition { id, from, to } => write!(
                formatter,
                "invalid job status transition for {id}: {from:?} -> {to:?}"
            ),
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
        self.ensure_dirs()?;
        let entry_path = self.index_path(&key);
        for _ in 0..10 {
            let job_id = new_job_id(&key);
            let entry = JobIndexEntry {
                job_id: job_id.clone(),
                idempotency_key: key.clone(),
            };
            match create_index_entry(&entry_path, &entry) {
                Ok(()) => {
                    let now = now_ms();
                    let record = self.record_for_spec(spec, &key, &job_id, now);
                    if let Err(error) = self.write_material(&record.id, spec) {
                        let _ = fs::remove_file(&entry_path);
                        let _ = fs::remove_dir_all(self.record_dir(&record.id));
                        return Err(error);
                    }
                    if let Err(error) = self.write_record(&record) {
                        let _ = fs::remove_file(&entry_path);
                        let _ = fs::remove_dir_all(self.record_dir(&record.id));
                        return Err(error);
                    }
                    return Ok((record, CreateOrJoin::Created));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let entry = self.read_joined_index_entry(&entry_path)?;
                    match self.load_joined_record(&entry.job_id) {
                        Ok(record) if !record.status.is_terminal() => {
                            return Ok((record, CreateOrJoin::Joined));
                        }
                        Ok(_) | Err(JobStoreError::MissingJob { .. }) => {
                            self.reclaim_index_entry(&entry_path, &entry)?;
                            continue;
                        }
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => return Err(io_error(&entry_path, error)),
            }
        }
        Err(JobStoreError::StoreUnavailable {
            path: entry_path,
            error: "job index was repeatedly reclaimed while creating job".to_owned(),
        })
    }

    fn record_for_spec(&self, spec: &JobSpec, key: &str, job_id: &str, now: u128) -> JobRecord {
        JobRecord {
            id: job_id.to_owned(),
            idempotency_key: key.to_owned(),
            scope: spec.scope.clone(),
            skill: sanitize_log_string(&spec.skill),
            tool: spec.tool.as_deref().map(sanitize_log_string),
            args: spec
                .args
                .iter()
                .map(|arg| sanitize_log_string(arg))
                .collect(),
            cwd: spec.cwd.as_deref().map(sanitize_log_string),
            env: sanitize_env_map(&spec.env),
            status: JobStatus::Queued,
            tmux_target: None,
            output_tap_path: None,
            output_offset: 0,
            exit_code: None,
            terminal_reason: None,
            cancel_signal: None,
            created_at_ms: now,
            updated_at_ms: now,
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

    pub fn load_material(&self, id: &str) -> Result<JobMaterial> {
        self.load(id)?;
        let path = self.material_path(id);
        match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).map_err(|error| JobStoreError::CorruptStore {
                path,
                error: error.to_string(),
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Err(JobStoreError::CorruptStore {
                    path,
                    error: "job execution material is missing".to_owned(),
                })
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
        if !status_transition_allowed(&record.status, &status) {
            return Err(JobStoreError::InvalidStatusTransition {
                id: id.to_owned(),
                from: record.status,
                to: status,
            });
        }
        record.status = status;
        record.updated_at_ms = now_ms();
        self.write_record(&record)?;
        Ok(record)
    }

    pub fn mark_running(
        &self,
        id: &str,
        target: JobTmuxTarget,
        output_tap_path: impl Into<String>,
    ) -> Result<JobRecord> {
        let mut record = self.load(id)?;
        if !status_transition_allowed(&record.status, &JobStatus::Running) {
            return Err(JobStoreError::InvalidStatusTransition {
                id: id.to_owned(),
                from: record.status,
                to: JobStatus::Running,
            });
        }
        record.status = JobStatus::Running;
        record.tmux_target = Some(target);
        record.output_tap_path = Some(output_tap_path.into());
        record.output_offset = 0;
        record.updated_at_ms = now_ms();
        self.write_record(&record)?;
        Ok(record)
    }

    pub fn set_output_offset(&self, id: &str, output_offset: u64) -> Result<JobRecord> {
        let mut record = self.load(id)?;
        record.output_offset = output_offset;
        record.updated_at_ms = now_ms();
        self.write_record(&record)?;
        Ok(record)
    }

    pub fn finish(
        &self,
        id: &str,
        status: JobStatus,
        exit_code: Option<i32>,
        reason: impl Into<String>,
        cancel_signal: Option<String>,
    ) -> Result<JobRecord> {
        let mut record = self.load(id)?;
        if !status.is_terminal() {
            return Err(JobStoreError::InvalidSpec(
                "job finish requires a terminal status".to_owned(),
            ));
        }
        if record.status.is_terminal() {
            return Ok(record);
        }
        if !status_transition_allowed(&record.status, &status) {
            return Err(JobStoreError::InvalidStatusTransition {
                id: id.to_owned(),
                from: record.status,
                to: status,
            });
        }
        record.status = status;
        record.exit_code = exit_code;
        record.terminal_reason = Some(sanitize_log_string(&reason.into()));
        record.cancel_signal = cancel_signal.map(|signal| sanitize_log_string(&signal));
        record.updated_at_ms = now_ms();
        self.write_record(&record)?;
        Ok(record)
    }

    pub fn cancel(&self, id: &str) -> Result<(JobRecord, CancelOutcome)> {
        let record = self.load(id)?;
        match record.status {
            JobStatus::Queued => {
                let record = self.set_status(id, JobStatus::Cancelled)?;
                Ok((record, CancelOutcome::Cancelled))
            }
            JobStatus::Running => {
                self.append_event(
                    id,
                    JobEventInput {
                        kind: "cancel-requested".to_owned(),
                        data: json!({}),
                    },
                )?;
                Ok((self.load(id)?, CancelOutcome::CancelRequested))
            }
            JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled => {
                Ok((record, CancelOutcome::Noop))
            }
        }
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
                    let record = match self.load(&id) {
                        Ok(record) => record,
                        Err(JobStoreError::MissingJob { .. }) => continue,
                        Err(error) => return Err(error),
                    };
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
            if !record.status.is_terminal() {
                continue;
            }
            let (truncated, removed) = self.prune_events(record, retention.max_events_per_job)?;
            if truncated {
                report.truncated_event_logs += 1;
                report.removed_events += removed;
            }
        }
        report.removed_orphan_indexes += self.prune_orphan_index_entries()?;

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

    fn reclaim_index_entry(&self, path: &Path, expected: &JobIndexEntry) -> Result<()> {
        let _lock =
            acquire_state_update_lock(path).map_err(|error| JobStoreError::StoreUnavailable {
                path: path.to_path_buf(),
                error,
            })?;
        match self.read_index_entry(path) {
            Ok(current) if current.job_id == expected.job_id => fs::remove_file(path)
                .map_err(|error| io_error(path, error))
                .map(|_| ()),
            Ok(_) => Ok(()),
            Err(JobStoreError::StoreUnavailable { path: _, error })
                if error.contains("No such file") || error.contains("not found") =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
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
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(JobStoreError::EmptyEventLog { id: id.to_owned() });
            }
            Err(error) => return Err(io_error(&path, error)),
        };
        let mut reader = BufReader::new(file);
        let mut events = Vec::new();
        let mut saw_complete_event = false;
        let mut line_number = 0_usize;
        loop {
            let mut line = String::new();
            let bytes = reader
                .read_line(&mut line)
                .map_err(|error| io_error(&path, error))?;
            if bytes == 0 {
                break;
            }
            line_number += 1;
            if !line.ends_with('\n') {
                break;
            }
            if line.trim().is_empty() {
                continue;
            }
            saw_complete_event = true;
            let event = serde_json::from_str::<JobEvent>(&line).map_err(|error| {
                JobStoreError::CorruptStore {
                    path: path.clone(),
                    error: format!("line {line_number}: {error}"),
                }
            })?;
            if event.seq >= seq {
                events.push(event);
            }
        }
        if !saw_complete_event && seq == 0 {
            return Err(JobStoreError::EmptyEventLog { id: id.to_owned() });
        }
        Ok(events)
    }

    fn prune_events(&self, record: &JobRecord, max_events: usize) -> Result<(bool, usize)> {
        if !record.status.is_terminal() {
            return Ok((false, 0));
        }
        if max_events == 0 {
            return Ok((false, 0));
        }
        let events_path = self.events_path(&record.id);
        let _lock = acquire_state_update_lock(&events_path).map_err(|error| {
            JobStoreError::StoreUnavailable {
                path: events_path.clone(),
                error,
            }
        })?;
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
        atomic_write(&events_path, text).map_err(|error| io_error(&events_path, error))?;
        Ok((true, removed))
    }

    fn prune_orphan_index_entries(&self) -> Result<usize> {
        let index_dir = self.index_dir();
        let entries = match fs::read_dir(&index_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(io_error(&index_dir, error)),
        };
        let mut removed = 0;
        for entry in entries {
            let entry = entry.map_err(|error| io_error(&index_dir, error))?;
            if !entry
                .file_type()
                .map_err(|error| io_error(&entry.path(), error))?
                .is_file()
            {
                continue;
            }
            let path = entry.path();
            let index = self.read_index_entry(&path)?;
            if self.status_path(&index.job_id).exists() {
                continue;
            }
            self.reclaim_index_entry(&path, &index)?;
            removed += 1;
        }
        Ok(removed)
    }

    fn remove_record(&self, record: &JobRecord) -> Result<()> {
        let index_path = self.index_path(&record.idempotency_key);
        match fs::remove_file(&index_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(&index_path, error)),
        }
        let record_dir = self.record_dir(&record.id);
        match fs::remove_dir_all(&record_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(&record_dir, error)),
        }
        Ok(())
    }

    fn write_record(&self, record: &JobRecord) -> Result<()> {
        let path = self.status_path(&record.id);
        write_json_atomic(&path, record).map_err(|error| io_error(&path, error))
    }

    fn write_material(&self, id: &str, spec: &JobSpec) -> Result<()> {
        let path = self.material_path(id);
        let material = JobMaterial {
            args: spec.args.clone(),
            cwd: spec.cwd.clone(),
            env: spec.env.clone(),
        };
        write_json_atomic(&path, &material).map_err(|error| io_error(&path, error))
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

    fn material_path(&self, id: &str) -> PathBuf {
        self.record_dir(id).join("material.json")
    }

    fn events_path(&self, id: &str) -> PathBuf {
        self.record_dir(id).join("events.ndjson")
    }

    pub fn output_tap_path(&self, id: &str) -> PathBuf {
        self.record_dir(id).join("output.tap")
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
        "skill": &spec.skill,
        "tool": &spec.tool,
        "args": &spec.args,
        "cwd": &spec.cwd,
        "env": &spec.env,
    });
    let raw = serde_json::to_vec(&identity).map_err(|error| {
        JobStoreError::InvalidSpec(format!("could not encode idempotency identity: {error}"))
    })?;
    let mut hasher = Sha256::new();
    hasher.update(raw);
    Ok(format!("{:x}", hasher.finalize()))
}

static JOB_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn new_job_id(key: &str) -> String {
    let sequence = JOB_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let prefix = &key[..16];
    format!(
        "job-{prefix}-{}-{}-{sequence}",
        now_ms(),
        std::process::id()
    )
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

fn sanitize_env_map(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let sanitized = sanitize_log_value(&json!(env));
    let Value::Object(fields) = sanitized else {
        return BTreeMap::new();
    };
    fields
        .into_iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key, value.to_owned())))
        .collect()
}

fn status_transition_allowed(from: &JobStatus, to: &JobStatus) -> bool {
    if from == to {
        return true;
    }
    match from {
        JobStatus::Queued => true,
        JobStatus::Running => {
            matches!(
                to,
                JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled
            )
        }
        JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled => false,
    }
}

fn now_ms() -> u128 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis(),
        Err(error) => error.duration().as_millis(),
    }
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
    use std::sync::{
        Arc, Barrier,
        atomic::{AtomicBool, Ordering},
    };

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
            cwd: Some("/repo/main".to_owned()),
            env: BTreeMap::new(),
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
    fn idempotency_keys_use_scope_skill_tool_context_and_raw_args() {
        let same_a = spec_with_arg("token=alpha");
        let same_b = spec_with_arg("token=alpha");
        let different_arg = spec_with_arg("token=bravo");
        let different_scope = JobSpec {
            scope: JobScope::Global,
            ..same_a.clone()
        };
        let different_tool = JobSpec {
            tool: Some("claude".to_owned()),
            ..same_a.clone()
        };
        let absent_tool = JobSpec {
            tool: None,
            ..same_a.clone()
        };
        let different_cwd = JobSpec {
            cwd: Some("/repo/other".to_owned()),
            ..same_a.clone()
        };
        let different_env = JobSpec {
            env: BTreeMap::from([("AIMUX_PROFILE".to_owned(), "review".to_owned())]),
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
        assert_ne!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_tool).unwrap()
        );
        assert_ne!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&absent_tool).unwrap()
        );
        assert_ne!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_cwd).unwrap()
        );
        assert_ne!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_env).unwrap()
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
            cwd: Some(repo.to_string_lossy().into_owned()),
            env: BTreeMap::new(),
        };
        let spec_b = JobSpec {
            scope: dotted,
            skill: "build".to_owned(),
            tool: Some("codex".to_owned()),
            args: vec!["--fast".to_owned()],
            cwd: Some(repo.to_string_lossy().into_owned()),
            env: BTreeMap::new(),
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
    fn status_persists_sanitized_args_but_material_keeps_raw_execution_args() {
        let store = store("sanitized");
        let mut spec = spec_with_arg("apiToken=super-secret-token");
        spec.env.insert(
            "AIMUX_JOB_TOKEN".to_owned(),
            "secret-token-from-env".to_owned(),
        );
        let key = idempotency_key(&spec).expect("key");
        let (record, created) = store.create_or_join(&spec).expect("created");
        assert_eq!(created, CreateOrJoin::Created);
        let raw_status =
            fs::read_to_string(store.status_path(&record.id)).expect("status file readable");
        assert!(!raw_status.contains("super-secret-token"));
        assert!(!raw_status.contains("secret-token-from-env"));
        assert!(raw_status.contains("<redacted>"));
        let material = store.load_material(&record.id).expect("raw material");
        assert_eq!(material.args, vec!["apiToken=super-secret-token"]);
        assert_eq!(
            material.env.get("AIMUX_JOB_TOKEN").map(String::as_str),
            Some("secret-token-from-env")
        );
        let (joined, joined_outcome) = store.create_or_join(&spec).expect("joined");
        assert_eq!(joined_outcome, CreateOrJoin::Joined);
        assert_eq!(joined.id, record.id);
        assert_eq!(joined.idempotency_key, key);
    }

    #[test]
    fn terminal_job_is_not_rejoined_and_history_stays_addressable() {
        let store = store("terminal-recreate");
        let spec = spec_with_arg("--terminal");
        let (first, first_outcome) = store.create_or_join(&spec).expect("first");
        assert_eq!(first_outcome, CreateOrJoin::Created);
        store
            .set_status(&first.id, JobStatus::Succeeded)
            .expect("terminal");
        let (second, second_outcome) = store.create_or_join(&spec).expect("second");
        assert_eq!(second_outcome, CreateOrJoin::Created);
        assert_ne!(first.id, second.id);
        assert_eq!(
            store.load(&first.id).expect("old job history").status,
            JobStatus::Succeeded
        );
    }

    #[test]
    fn status_guard_refuses_terminal_rewrite_to_cancelled() {
        let store = store("terminal-status-guard");
        let spec = spec_with_arg("--pr=123");
        let (record, _) = store.create_or_join(&spec).expect("created");
        store
            .set_status(&record.id, JobStatus::Succeeded)
            .expect("succeeded");

        let error = store
            .set_status(&record.id, JobStatus::Cancelled)
            .expect_err("terminal rewrite refused");
        assert!(matches!(
            error,
            JobStoreError::InvalidStatusTransition {
                from: JobStatus::Succeeded,
                to: JobStatus::Cancelled,
                ..
            }
        ));
        assert_eq!(
            store.load(&record.id).expect("load").status,
            JobStatus::Succeeded
        );
    }

    #[test]
    fn cancel_is_noop_for_terminal_jobs_and_event_for_running_jobs() {
        let store = store("cancel-outcomes");
        let (queued, _) = store
            .create_or_join(&spec_with_arg("--queued"))
            .expect("queued created");
        let (queued, outcome) = store.cancel(&queued.id).expect("queued cancelled");
        assert_eq!(outcome, CancelOutcome::Cancelled);
        assert_eq!(queued.status, JobStatus::Cancelled);

        let (running, _) = store
            .create_or_join(&spec_with_arg("--running"))
            .expect("running created");
        store
            .set_status(&running.id, JobStatus::Running)
            .expect("running");
        let (running_after, outcome) = store.cancel(&running.id).expect("running cancel");
        assert_eq!(outcome, CancelOutcome::CancelRequested);
        assert_eq!(running_after.status, JobStatus::Running);
        let events = store
            .read_events_from(&running.id, 0)
            .expect("cancel event");
        assert_eq!(events[0].kind, "cancel-requested");

        let (terminal, _) = store
            .create_or_join(&spec_with_arg("--terminal"))
            .expect("terminal created");
        store
            .set_status(&terminal.id, JobStatus::Succeeded)
            .expect("succeeded");
        let (terminal_after, outcome) = store.cancel(&terminal.id).expect("terminal no-op");
        assert_eq!(outcome, CancelOutcome::Noop);
        assert_eq!(terminal_after.status, JobStatus::Succeeded);
    }

    #[test]
    fn stale_index_with_missing_record_is_reclaimed() {
        let store = store("stale-index");
        let spec = spec_with_arg("--stale");
        let key = idempotency_key(&spec).expect("key");
        let stale_entry = JobIndexEntry {
            job_id: "job-stale-missing".to_owned(),
            idempotency_key: key.clone(),
        };
        create_index_entry(&store.index_path(&key), &stale_entry).expect("stale index");
        let (record, outcome) = store.create_or_join(&spec).expect("reclaimed");
        assert_eq!(outcome, CreateOrJoin::Created);
        assert_ne!(record.id, stale_entry.job_id);
        let index = store
            .read_index_entry(&store.index_path(&key))
            .expect("current index");
        assert_eq!(index.job_id, record.id);
    }

    #[test]
    fn remove_record_deletes_index_before_record_dir_failure() {
        let store = store("remove-order");
        let (record, _) = store
            .create_or_join(&spec_with_arg("--remove-order"))
            .expect("created");
        let record_dir = store.record_dir(&record.id);
        fs::remove_dir_all(&record_dir).expect("remove record dir");
        fs::write(&record_dir, "not a directory").expect("record path file");
        let error = store
            .remove_record(&record)
            .expect_err("record dir removal should fail");
        assert!(matches!(error, JobStoreError::StoreUnavailable { .. }));
        assert!(
            !store.index_path(&record.idempotency_key).exists(),
            "index must be gone before record directory removal can fail"
        );
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
        let drained = store.read_events_from(&record.id, 2).expect("drained");
        assert!(drained.is_empty());
    }

    #[test]
    fn retention_truncates_only_terminal_event_logs_and_reaps_orphan_indexes() {
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
        let (running, _) = store
            .create_or_join(&spec_with_arg("--running-retention"))
            .expect("running");
        for index in 0..5 {
            store
                .append_event(
                    &running.id,
                    JobEventInput {
                        kind: "line".to_owned(),
                        data: json!({ "index": index }),
                    },
                )
                .expect("append running");
        }
        store
            .set_status(&record.id, JobStatus::Succeeded)
            .expect("terminal");
        let orphan_key = idempotency_key(&spec_with_arg("--orphan-index")).expect("orphan key");
        let orphan_entry = JobIndexEntry {
            job_id: "job-orphan-index".to_owned(),
            idempotency_key: orphan_key.clone(),
        };
        create_index_entry(&store.index_path(&orphan_key), &orphan_entry).expect("orphan index");
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
        assert_eq!(report.removed_orphan_indexes, 1);
        let events = store.read_events_from(&record.id, 0).expect("events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 3);
        assert_eq!(events[1].seq, 4);
        let running_events = store
            .read_events_from(&running.id, 0)
            .expect("running events");
        assert_eq!(running_events.len(), 5);
        assert!(!store.index_path(&orphan_key).exists());
    }

    #[test]
    fn prune_waits_for_event_log_lock_before_truncating_terminal_log() {
        let store = Arc::new(store("prune-lock"));
        let (record, _) = store
            .create_or_join(&spec_with_arg("--prune-lock"))
            .expect("created");
        for index in 0..3 {
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
        store
            .set_status(&record.id, JobStatus::Succeeded)
            .expect("terminal");
        let lock = acquire_state_update_lock(&store.events_path(&record.id)).expect("held lock");
        let finished = Arc::new(AtomicBool::new(false));
        let worker_store = store.clone();
        let worker_finished = finished.clone();
        let handle = thread::spawn(move || {
            let result = worker_store.prune(
                JobRetention {
                    max_jobs: 100,
                    max_events_per_job: 1,
                    terminal_job_retention_ms: DEFAULT_JOB_RETENTION.terminal_job_retention_ms,
                },
                now_ms(),
            );
            worker_finished.store(true, Ordering::SeqCst);
            result
        });
        thread::sleep(Duration::from_millis(50));
        assert!(
            !finished.load(Ordering::SeqCst),
            "prune must wait for the event-log lock"
        );
        drop(lock);
        let report = handle.join().expect("worker joined").expect("pruned");
        assert_eq!(report.truncated_event_logs, 1);
    }
}
