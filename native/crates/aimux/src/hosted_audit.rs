use crate::atomic_write::atomic_write_with_mode;
use crate::hosted_lock::{HostedLockOptions, with_hosted_lock};
use crate::paths::PathResolver;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const HOSTED_AUDIT_MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const HOSTED_AUDIT_MAX_FILES: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedAuditRecord {
    pub ts: String,
    pub principal_id: String,
    pub label: String,
    pub method: String,
    pub path: String,
    pub session_id: Option<String>,
    pub status: i64,
    pub request_bytes: i64,
    pub response_bytes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedPromptRecord {
    pub ts: String,
    pub prompt_ref: String,
    pub principal_id: String,
    pub prompt_hash: String,
    pub prompt_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct HostedAuditStore {
    resolver: PathResolver,
}

impl HostedAuditStore {
    pub fn from_env() -> Self {
        Self {
            resolver: PathResolver::from_env(),
        }
    }

    pub fn with_resolver(resolver: PathResolver) -> Self {
        Self { resolver }
    }

    pub fn hosted_dir(&self) -> PathBuf {
        self.resolver.hosted_dir()
    }

    pub fn audit_path(&self) -> PathBuf {
        self.resolver.hosted_audit_path()
    }

    pub fn prompts_path(&self) -> PathBuf {
        self.resolver.hosted_audit_prompts_path()
    }

    pub fn append_audit(&self, record: &HostedAuditRecord) {
        self.append_jsonl(self.audit_path(), record);
    }

    pub fn append_prompt(&self, record: &HostedPromptRecord) {
        self.append_jsonl(self.prompts_path(), record);
    }

    pub fn tail_audit(&self, count: usize) -> Vec<HostedAuditRecord> {
        let path = self.audit_path();
        let mut records = read_jsonl::<HostedAuditRecord>(&path, Some(count));
        records.extend(read_jsonl::<HostedAuditRecord>(
            &pending_path_for(&path),
            Some(count),
        ));
        records.sort_by(|left, right| left.ts.cmp(&right.ts));
        records[records.len().saturating_sub(count)..].to_vec()
    }

    pub fn tail_prompts(
        &self,
        refs: impl IntoIterator<Item = String>,
    ) -> BTreeMap<String, HostedPromptRecord> {
        let wanted = refs.into_iter().collect::<Vec<_>>();
        if wanted.is_empty() {
            return BTreeMap::new();
        }
        let path = self.prompts_path();
        let mut found = BTreeMap::new();
        for record in read_jsonl::<HostedPromptRecord>(&path, None)
            .into_iter()
            .chain(read_jsonl::<HostedPromptRecord>(
                &pending_path_for(&path),
                None,
            ))
        {
            if wanted.iter().any(|value| value == &record.prompt_ref) {
                found.insert(record.prompt_ref.clone(), record);
            }
        }
        found
    }

    pub fn prune(&self, retention_days: i64, now_ms: u128) {
        let cutoff = now_ms.saturating_sub(retention_days.max(0) as u128 * 24 * 60 * 60 * 1_000);
        for path in [self.audit_path(), self.prompts_path()] {
            let _ = with_hosted_lock(
                &path,
                || prune_unlocked(&path, cutoff),
                HostedLockOptions {
                    wait: false,
                    timeout_ms: 0,
                },
            );
        }
    }

    fn append_jsonl(&self, path: PathBuf, record: &impl Serialize) {
        let result = (|| {
            ensure_private_hosted_dir(&self.hosted_dir())?;
            let line = serde_json::to_string(record).map_err(std::io::Error::other)? + "\n";
            let write = || {
                rotate_if_needed(&path);
                append_line(&path, &line)
            };
            match with_hosted_lock(
                &path,
                write,
                HostedLockOptions {
                    wait: false,
                    timeout_ms: 0,
                },
            ) {
                Ok(Some(Ok(()))) => Ok(()),
                Ok(Some(Err(error))) => Err(error),
                Ok(None) | Err(_) => append_line(&pending_path_for(&path), &line),
            }
        })();
        if result.is_err() {
            // Audit failure is deliberately non-fatal for the request being audited.
        }
    }
}

pub fn hash_prompt(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

pub fn pending_path_for(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.pending", path.to_string_lossy()))
}

pub fn pending_staged_path_for(path: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.merging",
        pending_path_for(path).to_string_lossy()
    ))
}

fn rotate_if_needed(path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() < HOSTED_AUDIT_MAX_BYTES {
        return;
    }
    let _ = fs::remove_file(format!(
        "{}.{}",
        path.to_string_lossy(),
        HOSTED_AUDIT_MAX_FILES
    ));
    for index in (1..HOSTED_AUDIT_MAX_FILES).rev() {
        let from = PathBuf::from(format!("{}.{}", path.to_string_lossy(), index));
        if from.exists() {
            let _ = fs::rename(from, format!("{}.{}", path.to_string_lossy(), index + 1));
        }
    }
    let _ = fs::rename(path, format!("{}.1", path.to_string_lossy()));
}

fn prune_unlocked(path: &Path, cutoff: u128) {
    for index in (1..=HOSTED_AUDIT_MAX_FILES).rev() {
        let rotated = PathBuf::from(format!("{}.{}", path.to_string_lossy(), index));
        if rotated
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(|modified| unix_millis(modified) < cutoff)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(rotated);
        }
    }

    let staged = stage_pending(path);
    let live_lines = if path.exists() {
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if live_lines.is_empty() && staged.is_none() {
        return;
    }
    let mut lines = live_lines.clone();
    if let Some(staged) = &staged {
        lines.extend(staged.lines.clone());
    }
    let kept = lines
        .into_iter()
        .filter(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|value| {
                    value
                        .get("ts")
                        .and_then(serde_json::Value::as_str)
                        .and_then(parse_iso_millis)
                })
                .map(|ts| ts >= cutoff)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    if kept.len() != live_lines.len() || staged.is_some() {
        let data = if kept.is_empty() {
            String::new()
        } else {
            format!("{}\n", kept.join("\n"))
        };
        if atomic_write_with_mode(path, data, Some(0o600)).is_ok()
            && let Some(staged) = staged
        {
            let _ = fs::remove_file(staged.path);
        }
    }
}

#[derive(Debug, Clone)]
struct StagedPending {
    path: PathBuf,
    lines: Vec<String>,
}

fn stage_pending(path: &Path) -> Option<StagedPending> {
    let pending = pending_path_for(path);
    let staged = pending_staged_path_for(path);
    if !staged.exists() {
        if !pending.exists() {
            return None;
        }
        if fs::rename(&pending, &staged).is_err() {
            return None;
        }
    }
    let lines = fs::read_to_string(&staged)
        .ok()?
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    Some(StagedPending {
        path: staged,
        lines,
    })
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path, limit: Option<usize>) -> Vec<T> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    if let Some(limit) = limit {
        lines = lines[lines.len().saturating_sub(limit)..].to_vec();
    }
    lines
        .into_iter()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn ensure_private_hosted_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode_if_unix(0o600)
        .open(path)?;
    file.write_all(line.as_bytes())
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let year = value.get(0..4)?.parse::<i64>().ok()?;
    if value.get(4..5)? != "-"
        || value.get(7..8)? != "-"
        || value.get(10..11)? != "T"
        || value.get(13..14)? != ":"
        || value.get(16..17)? != ":"
    {
        return None;
    }
    let month = value.get(5..7)?.parse::<i64>().ok()?;
    let day = value.get(8..10)?.parse::<i64>().ok()?;
    let hour = value.get(11..13)?.parse::<u128>().ok()?;
    let minute = value.get(14..16)?.parse::<u128>().ok()?;
    let second = value.get(17..19)?.parse::<u128>().ok()?;
    let millis = if value.get(19..20) == Some(".") {
        let digits = value
            .get(20..)?
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>();
        let padded = format!("{digits:0<3}");
        padded.get(0..3)?.parse::<u128>().ok()?
    } else {
        0
    };
    let days = days_from_civil(year, month, day)?;
    Some(
        u128::try_from(days).ok()? * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1_000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

trait OpenOptionsModeExt {
    fn mode_if_unix(&mut self, mode: u32) -> &mut Self;
}

impl OpenOptionsModeExt for OpenOptions {
    fn mode_if_unix(&mut self, mode: u32) -> &mut Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            self.mode(mode)
        }
        #[cfg(not(unix))]
        {
            let _ = mode;
            self
        }
    }
}
