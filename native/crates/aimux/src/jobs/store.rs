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

use super::scope::{JobAddress, JobScope};

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
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobSpec {
    pub address: JobAddress,
    pub scope: JobScope,
    pub skill: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub tool: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
}

impl JobSpec {
    pub fn validate_payload(&self) -> Result<()> {
        let has_skill = !self.skill.trim().is_empty();
        let has_prompt = self
            .prompt
            .as_ref()
            .is_some_and(|prompt| !prompt.trim().is_empty());
        match (has_skill, has_prompt) {
            (true, false) | (false, true) => Ok(()),
            (true, true) => Err(JobStoreError::InvalidSpec(
                "supply exactly one job payload: --skill <name> or --prompt <text>".to_owned(),
            )),
            (false, false) => Err(JobStoreError::InvalidSpec(
                "job payload is required: supply --skill <name> or --prompt <text>".to_owned(),
            )),
        }
    }

    pub fn payload_kind(&self) -> &'static str {
        if self.prompt.is_some() {
            "prompt"
        } else {
            "skill"
        }
    }

    pub fn payload_display_label(&self) -> String {
        if let Some(prompt) = self.prompt.as_deref() {
            summarize_for_conflict(prompt)
        } else {
            self.skill.clone()
        }
    }

    pub fn conflict_summary(&self) -> String {
        format!(
            "tool={}, payload={}:{}, args={}, cwd={}, envKeys={}",
            self.tool.as_deref().unwrap_or("<none>"),
            self.payload_kind(),
            self.payload_display_label(),
            summarize_vec(&self.args),
            self.cwd.as_deref().unwrap_or("<none>"),
            summarize_keys(&self.env),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub idempotency_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<JobAddress>,
    pub scope: JobScope,
    pub skill: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "payloadKind"
    )]
    pub payload_kind: Option<String>,
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
    #[serde(default)]
    pub skill: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
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
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub seq: u64,
    #[serde(alias = "created_at_ms")]
    pub created_at_ms: u128,
    pub kind: String,
    pub data: Value,
}

pub const JOB_TERMINAL_EVENT_KIND: &str = "terminal-status";
pub const JOB_CALLBACK_MAX_ATTEMPTS: u32 = 5;
pub const JOB_CALLBACK_RETRY_DELAY_MS: u128 = 60_000;
pub const JOB_CALLBACK_PENDING_GIVE_UP_MS: u128 =
    JOB_CALLBACK_RETRY_DELAY_MS * JOB_CALLBACK_MAX_ATTEMPTS as u128 * 3;
const JOB_CALLBACK_NEVER_RETRY_MS: u128 = u64::MAX as u128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobCallbackKind {
    DesktopNotification,
    Fifo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCallbackRecord {
    pub job_id: String,
    pub watcher_id: String,
    pub kind: JobCallbackKind,
    pub attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub next_attempt_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppressed_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "fifoPath")]
    pub fifo_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abandoned_at_ms: Option<u128>,
    pub created_at_ms: u128,
    pub updated_at_ms: u128,
}

impl JobCallbackRecord {
    pub fn is_pending(&self) -> bool {
        self.delivered_seq.is_none()
            && self.suppressed_reason.is_none()
            && self.abandoned_at_ms.is_none()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCallbacks {
    #[serde(default)]
    pub watchers: BTreeMap<String, JobCallbackRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobCallbackRegistrationOutcome {
    Created,
    Existing,
    Rearmed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobCallbackRegistration {
    pub callback: JobCallbackRecord,
    pub outcome: JobCallbackRegistrationOutcome,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DueJobCallback {
    pub record: JobRecord,
    pub callback: JobCallbackRecord,
    pub terminal_event: JobEvent,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobListFilter {
    pub scope: Option<JobScope>,
    pub address_prefix: Option<JobAddress>,
    pub depth: Option<usize>,
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
    pub protected_pending_callbacks: usize,
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
    JobAddressConflict {
        address: String,
        job_id: String,
        running: String,
        requested: String,
        differing_fields: Vec<String>,
    },
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
            Self::JobAddressConflict {
                address,
                job_id,
                running,
                requested,
                differing_fields,
            } => write!(
                formatter,
                "a different job is already running at {address}: job {job_id} is running {running}; requested {requested}; differing fields: {}; watch it with `aimux job tail {address}` or `aimux job wait {address}`, or stop it with `aimux job cancel {address}`",
                differing_fields.join(", ")
            ),
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
                            self.ensure_live_record_matches_spec(&record, spec)?;
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
            address: Some(spec.address.clone()),
            scope: spec.scope.clone(),
            skill: sanitize_log_string(&spec.payload_display_label()),
            payload_kind: Some(spec.payload_kind().to_owned()),
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
        validate_job_id(id)?;
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
        validate_job_id(id)?;
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
        let record = self.load(id)?;
        if record.status.is_terminal() {
            self.ensure_terminal_event_for_record(&record)?;
        }
        self.read_events_from_unlocked(id, seq)
    }

    pub fn set_status(&self, id: &str, status: JobStatus) -> Result<JobRecord> {
        if status.is_terminal() {
            return self.finish(
                id,
                status.clone(),
                None,
                format!("job marked {status:?}"),
                None,
            );
        }
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
            return Err(JobStoreError::InvalidStatusTransition {
                id: id.to_owned(),
                from: record.status,
                to: status,
            });
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
        self.ensure_terminal_event_for_record(&record)?;
        self.write_record(&record)?;
        Ok(record)
    }

    pub fn cancel(&self, id: &str) -> Result<(JobRecord, CancelOutcome)> {
        let record = self.load(id)?;
        match record.status {
            JobStatus::Queued => {
                let record = self.finish(
                    id,
                    JobStatus::Cancelled,
                    None,
                    "cancelled before start",
                    None,
                )?;
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

    pub fn register_desktop_callback(
        &self,
        id: &str,
        watcher_id: &str,
    ) -> Result<JobCallbackRegistration> {
        self.load(id)?;
        let watcher_id = normalize_watcher_id(watcher_id)?;
        let path = self.callbacks_path(id);
        let _lock =
            acquire_state_update_lock(&path).map_err(|error| JobStoreError::StoreUnavailable {
                path: path.clone(),
                error,
            })?;
        let mut callbacks = self.read_callbacks_unlocked(id)?;
        if let Some(callback) = callbacks.watchers.get_mut(&watcher_id) {
            if callback.is_pending() {
                return Ok(JobCallbackRegistration {
                    callback: callback.clone(),
                    outcome: JobCallbackRegistrationOutcome::Existing,
                });
            }
            let now = now_ms();
            callback.attempts = 0;
            callback.last_error = None;
            callback.next_attempt_ms = now;
            callback.delivered_seq = None;
            callback.delivered_at_ms = None;
            callback.suppressed_reason = None;
            callback.fifo_path = None;
            callback.abandoned_at_ms = None;
            callback.created_at_ms = now;
            callback.updated_at_ms = now;
            let callback = callback.clone();
            self.write_callbacks_unlocked(id, &callbacks)?;
            return Ok(JobCallbackRegistration {
                callback,
                outcome: JobCallbackRegistrationOutcome::Rearmed,
            });
        }
        let now = now_ms();
        let callback = JobCallbackRecord {
            job_id: id.to_owned(),
            watcher_id: watcher_id.clone(),
            kind: JobCallbackKind::DesktopNotification,
            attempts: 0,
            last_error: None,
            next_attempt_ms: now,
            delivered_seq: None,
            delivered_at_ms: None,
            suppressed_reason: None,
            fifo_path: None,
            abandoned_at_ms: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        callbacks
            .watchers
            .insert(watcher_id.to_owned(), callback.clone());
        self.write_callbacks_unlocked(id, &callbacks)?;
        Ok(JobCallbackRegistration {
            callback,
            outcome: JobCallbackRegistrationOutcome::Created,
        })
    }

    pub fn register_fifo_callback(
        &self,
        id: &str,
        watcher_id: &str,
        fifo_path: &str,
    ) -> Result<JobCallbackRegistration> {
        self.load(id)?;
        let watcher_id = normalize_watcher_id(watcher_id)?;
        let fifo_path = sanitize_log_string(fifo_path);
        let path = self.callbacks_path(id);
        let _lock =
            acquire_state_update_lock(&path).map_err(|error| JobStoreError::StoreUnavailable {
                path: path.clone(),
                error,
            })?;
        let mut callbacks = self.read_callbacks_unlocked(id)?;
        if let Some(callback) = callbacks.watchers.get_mut(&watcher_id) {
            let now = now_ms();
            let was_pending = callback.is_pending();
            callback.kind = JobCallbackKind::Fifo;
            callback.attempts = 0;
            callback.last_error = None;
            callback.next_attempt_ms = now;
            callback.delivered_seq = None;
            callback.delivered_at_ms = None;
            callback.suppressed_reason = None;
            callback.fifo_path = Some(fifo_path);
            callback.abandoned_at_ms = None;
            callback.created_at_ms = now;
            callback.updated_at_ms = now;
            let callback = callback.clone();
            self.write_callbacks_unlocked(id, &callbacks)?;
            return Ok(JobCallbackRegistration {
                callback,
                outcome: if was_pending {
                    JobCallbackRegistrationOutcome::Existing
                } else {
                    JobCallbackRegistrationOutcome::Rearmed
                },
            });
        }
        let now = now_ms();
        let callback = JobCallbackRecord {
            job_id: id.to_owned(),
            watcher_id: watcher_id.clone(),
            kind: JobCallbackKind::Fifo,
            attempts: 0,
            last_error: None,
            next_attempt_ms: now,
            delivered_seq: None,
            delivered_at_ms: None,
            suppressed_reason: None,
            fifo_path: Some(fifo_path),
            abandoned_at_ms: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        callbacks
            .watchers
            .insert(watcher_id.to_owned(), callback.clone());
        self.write_callbacks_unlocked(id, &callbacks)?;
        Ok(JobCallbackRegistration {
            callback,
            outcome: JobCallbackRegistrationOutcome::Created,
        })
    }

    pub fn load_callbacks(&self, id: &str) -> Result<JobCallbacks> {
        self.load(id)?;
        self.read_callbacks_unlocked(id)
    }

    pub fn due_callbacks(&self, now_ms: u128) -> Result<Vec<DueJobCallback>> {
        let mut due = Vec::new();
        for record in self.maintenance_records()? {
            if !record.status.is_terminal() {
                continue;
            }
            let terminal_event = match self.ensure_terminal_event_for_record(&record) {
                Ok(event) => event,
                Err(_) => {
                    let _ = self.abandon_stale_pending_callbacks(
                        &record.id,
                        now_ms,
                        "terminal event was unavailable before the callback give-up window elapsed",
                    );
                    continue;
                }
            };
            let callbacks = match self.read_callbacks_unlocked(&record.id) {
                Ok(callbacks) => callbacks,
                Err(_) => continue,
            };
            due.extend(
                callbacks
                    .watchers
                    .values()
                    .filter(|callback| callback.is_pending())
                    .filter(|callback| callback.next_attempt_ms <= now_ms)
                    .cloned()
                    .map(|callback| DueJobCallback {
                        record: record.clone(),
                        callback,
                        terminal_event: terminal_event.clone(),
                    }),
            );
        }
        Ok(due)
    }

    pub fn record_callback_delivered(
        &self,
        id: &str,
        watcher_id: &str,
        delivered_seq: u64,
        now_ms: u128,
    ) -> Result<JobCallbackRecord> {
        self.update_callback(id, watcher_id, |callback| {
            callback.delivered_seq = Some(delivered_seq);
            callback.delivered_at_ms = Some(now_ms);
            callback.next_attempt_ms = JOB_CALLBACK_NEVER_RETRY_MS;
            callback.last_error = None;
            callback.updated_at_ms = now_ms;
        })
    }

    pub fn record_callback_suppressed(
        &self,
        id: &str,
        watcher_id: &str,
        delivered_seq: u64,
        reason: impl Into<String>,
        now_ms: u128,
    ) -> Result<JobCallbackRecord> {
        let reason = sanitize_log_string(&reason.into());
        self.update_callback(id, watcher_id, |callback| {
            callback.delivered_seq = Some(delivered_seq);
            callback.delivered_at_ms = Some(now_ms);
            callback.next_attempt_ms = JOB_CALLBACK_NEVER_RETRY_MS;
            callback.suppressed_reason = Some(reason.clone());
            callback.last_error = None;
            callback.updated_at_ms = now_ms;
        })
    }

    pub fn record_callback_unavailable(
        &self,
        id: &str,
        watcher_id: &str,
        reason: impl Into<String>,
    ) -> Result<JobCallbackRecord> {
        let now = now_ms();
        let reason = sanitize_log_string(&reason.into());
        self.update_callback(id, watcher_id, |callback| {
            callback.delivered_seq = None;
            callback.delivered_at_ms = Some(now);
            callback.next_attempt_ms = JOB_CALLBACK_NEVER_RETRY_MS;
            callback.suppressed_reason = Some(reason.clone());
            callback.last_error = None;
            callback.updated_at_ms = now;
        })
    }

    pub fn record_callback_failed(
        &self,
        id: &str,
        watcher_id: &str,
        error: impl Into<String>,
        now_ms: u128,
    ) -> Result<JobCallbackRecord> {
        let error = sanitize_log_string(&error.into());
        self.update_callback(id, watcher_id, |callback| {
            callback.attempts = callback.attempts.saturating_add(1);
            callback.last_error = Some(error.clone());
            callback.updated_at_ms = now_ms;
            if callback.attempts >= JOB_CALLBACK_MAX_ATTEMPTS {
                callback.abandoned_at_ms = Some(now_ms);
                callback.next_attempt_ms = JOB_CALLBACK_NEVER_RETRY_MS;
            } else {
                callback.next_attempt_ms = now_ms.saturating_add(
                    JOB_CALLBACK_RETRY_DELAY_MS.saturating_mul(callback.attempts as u128),
                );
            }
        })
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
                    if filter.address_prefix.as_ref().is_some_and(|prefix| {
                        !record
                            .address
                            .as_ref()
                            .is_some_and(|address| address.matches_prefix(prefix, filter.depth))
                    }) {
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
        let records = self.maintenance_records()?;
        for record in &records {
            if !record.status.is_terminal() {
                continue;
            }
            self.abandon_stale_pending_callbacks(
                &record.id,
                now_ms,
                "callback give-up window elapsed before pruning",
            )?;
            if self.has_pending_callbacks_lenient(&record.id) {
                report.protected_pending_callbacks += 1;
                continue;
            }
            if let Ok((true, removed)) = self.prune_events(record, retention.max_events_per_job) {
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
            self.abandon_stale_pending_callbacks(
                &record.id,
                now_ms,
                "callback give-up window elapsed before pruning",
            )?;
            if self.has_pending_callbacks_lenient(&record.id) {
                report.protected_pending_callbacks += 1;
                continue;
            }
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

    fn ensure_live_record_matches_spec(&self, record: &JobRecord, spec: &JobSpec) -> Result<()> {
        let material = self.load_material(&record.id)?;
        let mut differing_fields = Vec::new();
        if record.address.as_ref() != Some(&spec.address) {
            differing_fields.push("address".to_owned());
        }
        if record.scope != spec.scope {
            differing_fields.push("scope".to_owned());
        }
        if material.skill != spec.skill || material.prompt != spec.prompt {
            differing_fields.push("payload".to_owned());
        }
        if record.tool != spec.tool {
            differing_fields.push("tool".to_owned());
        }
        if material.args != spec.args {
            differing_fields.push("args".to_owned());
        }
        if material.cwd != spec.cwd {
            differing_fields.push("cwd".to_owned());
        }
        if material.env != spec.env {
            differing_fields.push("env".to_owned());
        }
        if differing_fields.is_empty() {
            return Ok(());
        }
        Err(JobStoreError::JobAddressConflict {
            address: spec.address.display(),
            job_id: record.id.clone(),
            running: record_conflict_summary(record, Some(&material)),
            requested: spec.conflict_summary(),
            differing_fields,
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
        if self.has_pending_callbacks_lenient(&record.id) {
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
            skill: spec.skill.clone(),
            prompt: spec.prompt.clone(),
            args: spec.args.clone(),
            cwd: spec.cwd.clone(),
            env: spec.env.clone(),
        };
        write_json_atomic(&path, &material).map_err(|error| io_error(&path, error))
    }

    fn has_pending_callbacks(&self, id: &str) -> Result<bool> {
        Ok(self
            .read_callbacks_unlocked(id)?
            .watchers
            .values()
            .any(JobCallbackRecord::is_pending))
    }

    fn has_pending_callbacks_lenient(&self, id: &str) -> bool {
        self.has_pending_callbacks(id).unwrap_or(true)
    }

    fn abandon_stale_pending_callbacks(
        &self,
        id: &str,
        now_ms: u128,
        reason: &str,
    ) -> Result<usize> {
        let path = self.callbacks_path(id);
        let _lock =
            acquire_state_update_lock(&path).map_err(|error| JobStoreError::StoreUnavailable {
                path: path.clone(),
                error,
            })?;
        let mut callbacks = self.read_callbacks_unlocked(id)?;
        let mut abandoned = 0_usize;
        for callback in callbacks.watchers.values_mut() {
            if !callback.is_pending() {
                continue;
            }
            let give_up_at = callback
                .created_at_ms
                .saturating_add(JOB_CALLBACK_PENDING_GIVE_UP_MS);
            if now_ms < give_up_at {
                continue;
            }
            callback.abandoned_at_ms = Some(now_ms);
            callback.next_attempt_ms = JOB_CALLBACK_NEVER_RETRY_MS;
            callback.last_error = Some(sanitize_log_string(reason));
            callback.updated_at_ms = now_ms;
            abandoned += 1;
        }
        if abandoned > 0 {
            self.write_callbacks_unlocked(id, &callbacks)?;
        }
        Ok(abandoned)
    }

    fn ensure_terminal_event_for_record(&self, record: &JobRecord) -> Result<JobEvent> {
        if !record.status.is_terminal() {
            return Err(JobStoreError::InvalidSpec(
                "terminal event requires a terminal job".to_owned(),
            ));
        }
        let events_path = self.events_path(&record.id);
        let _lock = acquire_state_update_lock(&events_path).map_err(|error| {
            JobStoreError::StoreUnavailable {
                path: events_path.clone(),
                error,
            }
        })?;
        let events = match self.read_events_from_unlocked(&record.id, 0) {
            Ok(events) => events,
            Err(JobStoreError::EmptyEventLog { .. }) => Vec::new(),
            Err(error) => return Err(error),
        };
        if let Some(event) = events
            .iter()
            .rev()
            .find(|event| event.kind == JOB_TERMINAL_EVENT_KIND)
        {
            return Ok(event.clone());
        }
        let seq = events.last().map(|event| event.seq + 1).unwrap_or(0);
        let event = JobEvent {
            seq,
            created_at_ms: now_ms(),
            kind: JOB_TERMINAL_EVENT_KIND.to_owned(),
            data: terminal_event_data(record),
        };
        append_jsonl(&events_path, &event)?;
        Ok(event)
    }

    fn maintenance_records(&self) -> Result<Vec<JobRecord>> {
        let records_dir = self.records_dir();
        let entries = match fs::read_dir(&records_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_error(&records_dir, error)),
        };
        let mut records = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if let Ok(record) = self.load(&id) {
                records.push(record);
            }
        }
        records.sort_by_key(|record| record.created_at_ms);
        Ok(records)
    }

    fn update_callback(
        &self,
        id: &str,
        watcher_id: &str,
        update: impl FnOnce(&mut JobCallbackRecord),
    ) -> Result<JobCallbackRecord> {
        self.load(id)?;
        let watcher_id = normalize_watcher_id(watcher_id)?;
        let path = self.callbacks_path(id);
        let _lock =
            acquire_state_update_lock(&path).map_err(|error| JobStoreError::StoreUnavailable {
                path: path.clone(),
                error,
            })?;
        let mut callbacks = self.read_callbacks_unlocked(id)?;
        let callback =
            callbacks
                .watchers
                .get_mut(&watcher_id)
                .ok_or_else(|| JobStoreError::MissingJob {
                    id: format!("{id}:{watcher_id}"),
                })?;
        update(callback);
        let callback = callback.clone();
        self.write_callbacks_unlocked(id, &callbacks)?;
        Ok(callback)
    }

    fn read_callbacks_unlocked(&self, id: &str) -> Result<JobCallbacks> {
        validate_job_id(id)?;
        let path = self.callbacks_path(id);
        match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).map_err(|error| JobStoreError::CorruptStore {
                path,
                error: error.to_string(),
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(JobCallbacks::default()),
            Err(error) => Err(io_error(&path, error)),
        }
    }

    fn write_callbacks_unlocked(&self, id: &str, callbacks: &JobCallbacks) -> Result<()> {
        let path = self.callbacks_path(id);
        write_json_atomic(&path, callbacks).map_err(|error| io_error(&path, error))
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

    fn callbacks_path(&self, id: &str) -> PathBuf {
        self.record_dir(id).join("callbacks.json")
    }

    pub fn output_tap_path(&self, id: &str) -> PathBuf {
        self.record_dir(id).join("output.tap")
    }
}

pub fn validate_job_id(id: &str) -> Result<()> {
    let valid = id.strip_prefix("job-").is_some_and(|rest| !rest.is_empty())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(JobStoreError::InvalidSpec(
            "job id contains invalid characters".to_owned(),
        ))
    }
}

pub fn prune_jobs(retention: JobRetention, now_ms: u128) -> Result<PruneReport> {
    JobStore::from_env().prune(retention, now_ms)
}

pub fn idempotency_key(spec: &JobSpec) -> Result<String> {
    spec.validate_payload()?;
    let identity = json!({
        "address": spec.address.identity_value(),
    });
    let raw = serde_json::to_vec(&identity).map_err(|error| {
        JobStoreError::InvalidSpec(format!("could not encode idempotency identity: {error}"))
    })?;
    let mut hasher = Sha256::new();
    hasher.update(raw);
    Ok(format!("{:x}", hasher.finalize()))
}

fn record_conflict_summary(record: &JobRecord, material: Option<&JobMaterial>) -> String {
    let payload_kind = record.payload_kind.as_deref().unwrap_or(
        if material
            .and_then(|material| material.prompt.as_ref())
            .is_some()
        {
            "prompt"
        } else {
            "skill"
        },
    );
    let payload_label = material
        .and_then(|material| {
            material
                .prompt
                .as_deref()
                .map(summarize_for_conflict)
                .or_else(|| Some(material.skill.clone()))
        })
        .unwrap_or_else(|| record.skill.clone());
    let args = material
        .map(|material| summarize_vec(&material.args))
        .unwrap_or_else(|| summarize_vec(&record.args));
    let cwd = material
        .and_then(|material| material.cwd.as_deref())
        .or(record.cwd.as_deref())
        .unwrap_or("<none>");
    let env_keys = material
        .map(|material| summarize_keys(&material.env))
        .unwrap_or_else(|| summarize_keys(&record.env));
    format!(
        "tool={}, payload={payload_kind}:{payload_label}, args={args}, cwd={cwd}, envKeys={env_keys}, startedAtMs={}",
        record.tool.as_deref().unwrap_or("<none>"),
        record.created_at_ms,
    )
}

fn summarize_for_conflict(value: &str) -> String {
    let sanitized = sanitize_log_string(value).replace('\n', "\\n");
    const MAX: usize = 80;
    if sanitized.chars().count() <= MAX {
        sanitized
    } else {
        let mut summary = sanitized.chars().take(MAX).collect::<String>();
        summary.push_str("...");
        summary
    }
}

fn summarize_vec(values: &[String]) -> String {
    if values.is_empty() {
        "[]".to_owned()
    } else {
        format!(
            "[{}]",
            values
                .iter()
                .map(|value| summarize_for_conflict(value))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

fn summarize_keys(values: &BTreeMap<String, String>) -> String {
    if values.is_empty() {
        "[]".to_owned()
    } else {
        format!(
            "[{}]",
            values.keys().cloned().collect::<Vec<_>>().join(", ")
        )
    }
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

fn terminal_event_data(record: &JobRecord) -> Value {
    json!({
        "status": record.status,
        "exitCode": record.exit_code,
        "terminalReason": record.terminal_reason,
        "cancelSignal": record.cancel_signal,
    })
}

fn normalize_watcher_id(watcher_id: &str) -> Result<String> {
    let watcher_id = watcher_id.trim();
    if watcher_id.is_empty() {
        return Err(JobStoreError::InvalidSpec(
            "watcher id must not be empty".to_owned(),
        ));
    }
    Ok(sanitize_log_string(watcher_id))
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
        spec_with_arg_at(arg, "main")
    }

    fn spec_with_arg_at(arg: &str, slot: &str) -> JobSpec {
        let scope = JobScope::Project {
            project_id: "project-1".to_owned(),
        };
        JobSpec {
            address: JobAddress {
                scope: scope.clone(),
                slot: vec![slot.to_owned()],
            },
            scope,
            skill: "review-pr".to_owned(),
            prompt: None,
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
    fn idempotency_keys_use_address_only() {
        let same_a = spec_with_arg("token=alpha");
        let same_b = spec_with_arg("token=alpha");
        let different_arg = spec_with_arg("token=bravo");
        let different_address = JobSpec {
            address: JobAddress {
                scope: same_a.scope.clone(),
                slot: vec!["other".to_owned()],
            },
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
        assert_eq!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_arg).unwrap()
        );
        assert_ne!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_address).unwrap()
        );
        assert_eq!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_tool).unwrap()
        );
        assert_eq!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&absent_tool).unwrap()
        );
        assert_eq!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_cwd).unwrap()
        );
        assert_eq!(
            idempotency_key(&same_a).unwrap(),
            idempotency_key(&different_env).unwrap()
        );
    }

    #[test]
    fn live_address_joins_only_when_full_spec_matches() {
        let store = store("conflict");
        let same_a = spec_with_arg("token=alpha");
        let same_b = spec_with_arg("token=alpha");
        let different = spec_with_arg("token=bravo");
        let (created, created_outcome) = store.create_or_join(&same_a).expect("created");
        assert_eq!(created_outcome, CreateOrJoin::Created);
        let (joined, joined_outcome) = store.create_or_join(&same_b).expect("joined");
        assert_eq!(joined.id, created.id);
        assert_eq!(joined_outcome, CreateOrJoin::Joined);
        match store.create_or_join(&different) {
            Err(JobStoreError::JobAddressConflict {
                address,
                job_id,
                differing_fields,
                ..
            }) => {
                assert_eq!(address, same_a.address.display());
                assert_eq!(job_id, created.id);
                assert_eq!(differing_fields, vec!["args"]);
            }
            other => panic!("expected address conflict, got {other:?}"),
        }
    }

    #[test]
    fn concurrent_different_specs_create_one_job_and_refuse_the_other() {
        let store = Arc::new(store("race-conflict"));
        let winner = Arc::new(spec_with_arg("token=alpha"));
        let loser = Arc::new(spec_with_arg("token=bravo"));
        let barrier = Arc::new(Barrier::new(2));
        let handles = [
            {
                let store = store.clone();
                let spec = winner.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    store.create_or_join(&spec)
                })
            },
            {
                let store = store.clone();
                let spec = loser.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    store.create_or_join(&spec)
                })
            },
        ];
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("thread joined"))
            .collect::<Vec<_>>();
        let created = results
            .iter()
            .filter(|result| matches!(result, Ok((_, CreateOrJoin::Created))))
            .count();
        let conflicts = results
            .iter()
            .filter(|result| matches!(result, Err(JobStoreError::JobAddressConflict { .. })))
            .count();
        assert_eq!(created, 1);
        assert_eq!(conflicts, 1);
        assert_eq!(
            store
                .list(JobListFilter {
                    scope: None,
                    address_prefix: None,
                    depth: None,
                    status: None,
                })
                .expect("list")
                .len(),
            1
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
        let address_a = JobAddress {
            scope: direct.clone(),
            slot: Vec::new(),
        };
        let address_b = JobAddress {
            scope: dotted.clone(),
            slot: Vec::new(),
        };
        let spec_a = JobSpec {
            address: address_a,
            scope: direct,
            skill: "build".to_owned(),
            prompt: None,
            tool: Some("codex".to_owned()),
            args: vec!["--fast".to_owned()],
            cwd: Some(repo.to_string_lossy().into_owned()),
            env: BTreeMap::new(),
        };
        let spec_b = JobSpec {
            address: address_b,
            scope: dotted,
            skill: "build".to_owned(),
            prompt: None,
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
        match store.load("job-missing") {
            Err(JobStoreError::MissingJob { id }) => assert_eq!(id, "job-missing"),
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
    fn finish_refuses_terminal_noop_so_late_writers_are_visible() {
        let store = store("terminal-finish-guard");
        let spec = spec_with_arg("--terminal");
        let (record, _) = store.create_or_join(&spec).expect("created");
        store
            .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
            .expect("first finish");
        let error = store
            .finish(&record.id, JobStatus::Failed, Some(1), "late", None)
            .expect_err("second finish must be visible");
        assert!(matches!(
            error,
            JobStoreError::InvalidStatusTransition {
                from: JobStatus::Succeeded,
                to: JobStatus::Failed,
                ..
            }
        ));
    }

    #[test]
    fn finish_persists_terminal_event_for_late_readers() {
        let store = store("terminal-event");
        let (record, _) = store
            .create_or_join(&spec_with_arg("--terminal-event"))
            .expect("created");
        store
            .append_event(
                &record.id,
                JobEventInput {
                    kind: "output".to_owned(),
                    data: json!({ "text": "hello" }),
                },
            )
            .expect("output event");
        store
            .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
            .expect("finish");
        let events = store.read_events_from(&record.id, 0).expect("events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].kind, JOB_TERMINAL_EVENT_KIND);
        assert_eq!(events[1].data["status"], "succeeded");
        assert_eq!(events[1].data["exitCode"], 0);
    }

    #[test]
    fn callback_registration_survives_store_restart_and_tracks_delivery() {
        let store = store("callback-restart");
        let root = store.root().to_path_buf();
        let (record, _) = store
            .create_or_join(&spec_with_arg("--callback"))
            .expect("created");
        store
            .register_desktop_callback(&record.id, "sam")
            .expect("callback");
        store
            .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
            .expect("finish");

        let restarted = JobStore::new(root);
        let due = restarted.due_callbacks(u128::MAX).expect("due callbacks");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].callback.watcher_id, "sam");
        assert_eq!(due[0].terminal_event.kind, JOB_TERMINAL_EVENT_KIND);

        restarted
            .record_callback_delivered(&record.id, "sam", due[0].terminal_event.seq, 10)
            .expect("delivered");
        assert!(
            restarted
                .due_callbacks(u128::MAX)
                .expect("due again")
                .is_empty()
        );
        let callbacks = restarted.load_callbacks(&record.id).expect("callbacks");
        assert_eq!(
            callbacks.watchers["sam"].delivered_seq,
            Some(due[0].terminal_event.seq)
        );
    }

    #[test]
    fn terminal_record_without_terminal_event_is_healed_for_callbacks_and_late_readers() {
        let store = store("callback-terminal-heal");
        let (record, _) = store
            .create_or_join(&spec_with_arg("--callback-terminal-heal"))
            .expect("created");
        store
            .register_desktop_callback(&record.id, "sam")
            .expect("callback");
        let mut terminal = record.clone();
        terminal.status = JobStatus::Succeeded;
        terminal.exit_code = Some(0);
        terminal.terminal_reason = Some("legacy terminal record".to_owned());
        terminal.updated_at_ms = terminal.updated_at_ms.saturating_add(1);
        store
            .write_record(&terminal)
            .expect("legacy terminal status write");

        let due = store.due_callbacks(u128::MAX).expect("due");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].terminal_event.kind, JOB_TERMINAL_EVENT_KIND);
        let events = store.read_events_from(&record.id, 0).expect("events");
        assert!(
            events
                .iter()
                .any(|event| event.kind == JOB_TERMINAL_EVENT_KIND)
        );
    }

    #[test]
    fn corrupt_missing_terminal_event_cannot_pin_callback_forever() {
        let store = store("callback-corrupt-terminal");
        let (record, _) = store
            .create_or_join(&spec_with_arg("--callback-corrupt-terminal"))
            .expect("created");
        store
            .register_desktop_callback(&record.id, "sam")
            .expect("callback");
        let mut terminal = record.clone();
        terminal.status = JobStatus::Succeeded;
        terminal.exit_code = Some(0);
        terminal.terminal_reason = Some("legacy terminal record".to_owned());
        terminal.updated_at_ms = terminal.updated_at_ms.saturating_add(1);
        store
            .write_record(&terminal)
            .expect("legacy terminal status write");
        fs::write(store.events_path(&record.id), "{not-json}\n").expect("corrupt events log");

        let due = store
            .due_callbacks(u128::MAX)
            .expect("corrupt terminal scan keeps going");
        assert!(due.is_empty());
        let callbacks = store.load_callbacks(&record.id).expect("callbacks");
        assert!(
            callbacks.watchers["sam"].abandoned_at_ms.is_some(),
            "undeliverable callback must be abandoned rather than pinning the job forever"
        );
        let report = store
            .prune(
                JobRetention {
                    max_jobs: 0,
                    max_events_per_job: 1,
                    terminal_job_retention_ms: 0,
                },
                u128::MAX,
            )
            .expect("prune with corrupt events");
        assert_eq!(report.removed_jobs, 1);
    }

    #[test]
    fn prune_protects_pending_callbacks_until_give_up_bound() {
        let store = store("callback-prune");
        let (record, _) = store
            .create_or_join(&spec_with_arg("--callback-prune"))
            .expect("created");
        store
            .register_desktop_callback(&record.id, "sam")
            .expect("callback");
        store
            .finish(&record.id, JobStatus::Succeeded, Some(0), "done", None)
            .expect("finish");
        let retention = JobRetention {
            max_jobs: 0,
            max_events_per_job: 1,
            terminal_job_retention_ms: 0,
        };
        let report = store.prune(retention, 0).expect("protected prune");
        assert_eq!(report.removed_jobs, 0);
        assert_eq!(report.protected_pending_callbacks, 2);
        assert!(store.load(&record.id).is_ok());

        for attempt in 0..JOB_CALLBACK_MAX_ATTEMPTS {
            store
                .record_callback_failed(
                    &record.id,
                    "sam",
                    format!("delivery failed {attempt}"),
                    attempt as u128,
                )
                .expect("failure recorded");
        }
        let report = store.prune(retention, u128::MAX).expect("released prune");
        assert_eq!(report.removed_jobs, 1);
        assert!(matches!(
            store.load(&record.id),
            Err(JobStoreError::MissingJob { .. })
        ));
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
            .create_or_join(&spec_with_arg_at("--terminal", "terminal"))
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
            .create_or_join(&spec_with_arg_at(
                "--running-retention",
                "running-retention",
            ))
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
        let orphan_key = idempotency_key(&spec_with_arg_at("--orphan-index", "orphan-index"))
            .expect("orphan key");
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
        assert_eq!(report.removed_events, 4);
        assert_eq!(report.removed_orphan_indexes, 1);
        let events = store.read_events_from(&record.id, 0).expect("events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 4);
        assert_eq!(events[1].seq, 5);
        assert_eq!(events[1].kind, JOB_TERMINAL_EVENT_KIND);
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
