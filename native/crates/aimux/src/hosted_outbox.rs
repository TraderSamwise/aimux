use crate::hosted_audit::{HostedAuditRecord, HostedAuditStore};
use crate::hosted_lock::{HostedLockOptions, with_hosted_lock};
use crate::paths::PathResolver;
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_SPOOLED: usize = 500;
const MAX_SPOOL_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedEvent {
    pub id: String,
    pub kind: String,
    pub ts: String,
    pub principal_id: Option<String>,
    pub label: String,
    pub fingerprint: Option<String>,
    pub address_known: bool,
    pub user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HostedOutboxStore {
    resolver: PathResolver,
}

impl HostedOutboxStore {
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

    pub fn outbox_path(&self) -> PathBuf {
        self.resolver.hosted_outbox_path()
    }

    pub fn raise_cli_event(
        &self,
        kind: &str,
        principal_id: Option<&str>,
        detail: &str,
    ) -> Result<()> {
        let ts = now_iso();
        let audit = HostedAuditRecord {
            ts: ts.clone(),
            principal_id: principal_id.unwrap_or("-").to_owned(),
            label: "cli".to_owned(),
            method: "-".to_owned(),
            path: "-".to_owned(),
            session_id: None,
            status: 0,
            request_bytes: 0,
            response_bytes: 0,
            prompt_hash: None,
            prompt_ref: None,
            event: Some(kind.to_owned()),
            detail: Some(detail.to_owned()),
        };
        HostedAuditStore::with_resolver(self.resolver.clone()).append_audit(&audit);
        self.spool_event(&HostedEvent {
            id: random_uuid_like()?,
            kind: kind.to_owned(),
            ts,
            principal_id: principal_id.map(str::to_owned),
            label: "cli".to_owned(),
            fingerprint: None,
            address_known: false,
            user_agent: None,
            detail: Some(detail.to_owned()),
        });
        Ok(())
    }

    pub fn spool_event(&self, event: &HostedEvent) {
        if fs::create_dir_all(self.hosted_dir()).is_err() {
            return;
        }
        set_mode_if_unix(&self.hosted_dir(), 0o700);
        let path = self.outbox_path();
        if fs::metadata(&path)
            .map(|metadata| metadata.len() > MAX_SPOOL_BYTES)
            .unwrap_or(false)
        {
            return;
        }
        let append = || {
            let _ = append_jsonl(path.clone(), event);
        };
        match with_hosted_lock(
            &path,
            append,
            HostedLockOptions {
                wait: false,
                timeout_ms: 0,
            },
        ) {
            Ok(Some(())) => {}
            Ok(None) | Err(_) => append(),
        }
    }

    pub fn drain_outbox(&self) -> Vec<HostedEvent> {
        let path = self.outbox_path();
        if !path.exists() {
            return Vec::new();
        }
        with_hosted_lock(
            &path,
            || {
                if !path.exists() {
                    return Vec::new();
                }
                let raw = fs::read_to_string(&path).unwrap_or_default();
                let _ = fs::remove_file(&path);
                let mut events = raw
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .filter_map(|line| serde_json::from_str::<HostedEvent>(line).ok())
                    .collect::<Vec<_>>();
                if events.len() > MAX_SPOOLED {
                    events = events[events.len() - MAX_SPOOLED..].to_vec();
                }
                events
            },
            HostedLockOptions {
                wait: false,
                timeout_ms: 0,
            },
        )
        .map_err(|message| anyhow!(message))
        .ok()
        .flatten()
        .unwrap_or_default()
    }
}

fn append_jsonl(path: PathBuf, value: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        set_mode_if_unix(parent, 0o700);
    }
    let line = serde_json::to_string(value)? + "\n";
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode_if_unix(0o600)
        .open(path)?;
    file.write_all(line.as_bytes())?;
    Ok(())
}

fn random_uuid_like() -> Result<String> {
    let bytes = random_bytes(16)?;
    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex(&bytes[0..4]),
        hex(&bytes[4..6]),
        hex(&bytes[6..8]),
        hex(&bytes[8..10]),
        hex(&bytes[10..16])
    ))
}

fn random_bytes(bytes: usize) -> Result<Vec<u8>> {
    let mut output = vec![0_u8; bytes];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut output)?;
    Ok(output)
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn now_iso() -> String {
    iso_timestamp(SystemTime::now())
}

fn iso_timestamp(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_seconds = duration.as_secs();
    let days = (total_seconds / 86_400) as i64;
    let seconds_in_day = total_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        duration.subsec_millis()
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn set_mode_if_unix(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
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
