use crate::backlog_metrics::{
    BacklogMetricSnapshot, HOSTED_OUTBOX_BACKLOG, backlog_metric, record_backlog_error,
};
use crate::hosted_audit::{HostedAuditRecord, HostedAuditStore};
pub use crate::hosted_events::HostedEvent;
use crate::hosted_lock::{HostedLockOptions, with_hosted_lock};
use crate::paths::PathResolver;
use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_SPOOLED: usize = 500;
const MAX_SPOOL_BYTES: u64 = 1024 * 1024;

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
            label: Some("cli".to_owned()),
            session_id: None,
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
        let append = || append_jsonl(path.clone(), event);
        let result = match with_hosted_lock(
            &path,
            append,
            HostedLockOptions {
                wait: false,
                timeout_ms: 0,
            },
        ) {
            Ok(Some(result)) => {
                if let Err(error) = &result {
                    record_backlog_error(
                        HOSTED_OUTBOX_BACKLOG,
                        Some(MAX_SPOOLED),
                        error.to_string(),
                    );
                }
                result
            }
            Ok(None) | Err(_) => append(),
        };
        match result {
            Ok(()) => {
                let _ = self.outbox_backlog_snapshot();
            }
            Err(error) => {
                record_backlog_error(
                    HOSTED_OUTBOX_BACKLOG,
                    Some(MAX_SPOOLED),
                    format!("failed to append hosted outbox: {error}"),
                );
            }
        }
    }

    pub fn drain_outbox(&self) -> Vec<HostedEvent> {
        match self.try_drain_outbox() {
            Ok(events) => events,
            Err(error) => {
                crate::debug_logging::log_lifecycle_always(
                    "skipped hosted outbox drain",
                    "hosted-outbox",
                    Some(json!({ "error": error.to_string() })),
                );
                Vec::new()
            }
        }
    }

    pub fn try_drain_outbox(&self) -> Result<Vec<HostedEvent>> {
        let path = self.outbox_path();
        if !path.exists() {
            backlog_metric(HOSTED_OUTBOX_BACKLOG, Some(MAX_SPOOLED)).set_depth(0);
            return Ok(Vec::new());
        }
        match with_hosted_lock(
            &path,
            || {
                if !path.exists() {
                    backlog_metric(HOSTED_OUTBOX_BACKLOG, Some(MAX_SPOOLED)).set_depth(0);
                    return Ok(Vec::new());
                }
                let raw = fs::read_to_string(&path)
                    .with_context(|| format!("failed to read hosted outbox {}", path.display()))?;
                let events = parse_hosted_outbox(&raw, &path);
                fs::remove_file(&path).with_context(|| {
                    format!("failed to remove drained hosted outbox {}", path.display())
                })?;
                backlog_metric(HOSTED_OUTBOX_BACKLOG, Some(MAX_SPOOLED)).set_depth(0);
                Ok(events)
            },
            HostedLockOptions {
                wait: false,
                timeout_ms: 0,
            },
        ) {
            Ok(Some(result)) => result,
            Ok(None) => {
                record_backlog_error(
                    HOSTED_OUTBOX_BACKLOG,
                    Some(MAX_SPOOLED),
                    "hosted outbox is locked",
                );
                Err(anyhow!("hosted outbox is locked"))
            }
            Err(message) => {
                record_backlog_error(HOSTED_OUTBOX_BACKLOG, Some(MAX_SPOOLED), message.clone());
                Err(anyhow!(message))
            }
        }
    }

    pub fn outbox_backlog_snapshot(&self) -> BacklogMetricSnapshot {
        let metric = backlog_metric(HOSTED_OUTBOX_BACKLOG, Some(MAX_SPOOLED));
        let path = self.outbox_path();
        match hosted_outbox_depth(&path) {
            Ok(depth) => metric.set_depth(depth),
            Err(error) => metric.set_error(error),
        }
        metric.snapshot()
    }
}

pub fn hosted_outbox_backlog_snapshot_from_env() -> BacklogMetricSnapshot {
    HostedOutboxStore::from_env().outbox_backlog_snapshot()
}

fn hosted_outbox_depth(path: &Path) -> Result<usize, String> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(raw.lines().filter(|line| !line.trim().is_empty()).count()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!(
            "failed to read hosted outbox {}: {error}",
            path.display()
        )),
    }
}

fn parse_hosted_outbox(raw: &str, path: &Path) -> Vec<HostedEvent> {
    parse_hosted_outbox_with_skip_logger(raw, path, |line, error| {
        crate::debug_logging::log_at(
            crate::debug_logging::LogLevel::Debug,
            "skipped malformed hosted outbox line",
            "hosted-outbox",
            Some(json!({
                "path": path.to_string_lossy(),
                "line": line,
                "error": error,
            })),
        );
    })
}

fn parse_hosted_outbox_with_skip_logger(
    raw: &str,
    path: &Path,
    mut log_skip: impl FnMut(usize, String),
) -> Vec<HostedEvent> {
    let mut events = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .filter_map(
            |(index, line)| match serde_json::from_str::<HostedEvent>(line) {
                Ok(event) => Some(event),
                Err(error) => {
                    let line_number = index + 1;
                    log_skip(
                        line_number,
                        format!(
                            "failed to parse hosted outbox {} line {}: {}",
                            path.display(),
                            line_number,
                            error
                        ),
                    );
                    None
                }
            },
        )
        .collect::<Vec<_>>();
    if events.len() > MAX_SPOOLED {
        events = events[events.len() - MAX_SPOOLED..].to_vec();
    }
    events
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backlog_metrics::BacklogMetricStatus;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "aimux-hosted-outbox-{label}-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn store(&self) -> HostedOutboxStore {
            let home = self.0.join("home");
            let aimux_home = self.0.join("aimux-home");
            fs::create_dir_all(&home).expect("create home");
            HostedOutboxStore::with_resolver(PathResolver::new(
                &self.0,
                &home,
                Some(aimux_home.to_string_lossy().into_owned()),
            ))
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn try_drain_outbox_preserves_file_when_read_fails() {
        let temp = TestDir::new("read-fails");
        let store = temp.store();
        let path = store.outbox_path();
        fs::create_dir_all(path.parent().expect("outbox parent")).expect("create outbox parent");
        fs::write(&path, [0xff, 0xfe, 0xfd]).expect("write invalid utf8 outbox");

        let error = store.try_drain_outbox().expect_err("read should fail");

        assert!(
            error.to_string().contains("failed to read hosted outbox"),
            "{error}"
        );
        assert!(path.exists(), "failed reads must not delete the outbox");
    }

    #[test]
    fn try_drain_outbox_skips_malformed_lines_and_drains_valid_events() {
        let temp = TestDir::new("torn-line");
        let store = temp.store();
        let path = store.outbox_path();
        fs::create_dir_all(path.parent().expect("outbox parent")).expect("create outbox parent");
        let first = hosted_event("evt_1", "hosted_lockdown");
        let second = hosted_event("evt_2", "hosted_grant_changed");
        fs::write(
            &path,
            format!(
                "{}\n{{\"kind\":\"hosted_\n{}\n",
                serde_json::to_string(&first).expect("first event"),
                serde_json::to_string(&second).expect("second event")
            ),
        )
        .expect("write mixed outbox");

        let drained = store.try_drain_outbox().expect("torn lines are skipped");

        assert_eq!(
            drained
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["hosted_lockdown", "hosted_grant_changed"]
        );
        assert!(
            !path.exists(),
            "successfully drained valid events should delete the outbox"
        );
    }

    #[test]
    fn outbox_backlog_reports_current_depth_and_high_water() {
        let temp = TestDir::new("backlog-depth");
        let store = temp.store();

        store.spool_event(&hosted_event("evt_1", "hosted_token_revoked"));
        store.spool_event(&hosted_event("evt_2", "hosted_grant_changed"));

        let queued = store.outbox_backlog_snapshot();
        assert_eq!(queued.status, BacklogMetricStatus::Ok);
        assert_eq!(queued.current_depth, Some(2));
        assert!(
            queued
                .high_water_mark
                .is_some_and(|high_water| high_water >= 2)
        );
        assert_eq!(queued.capacity, Some(MAX_SPOOLED));

        let drained = store.try_drain_outbox().expect("drain outbox");
        assert_eq!(drained.len(), 2);
        let empty = store.outbox_backlog_snapshot();
        assert_eq!(empty.current_depth, Some(0));
        assert!(
            empty
                .high_water_mark
                .is_some_and(|high_water| high_water >= 2)
        );
    }

    #[test]
    fn outbox_backlog_read_failure_reports_unavailable_not_zero() {
        let temp = TestDir::new("backlog-error");
        let store = temp.store();
        let path = store.outbox_path();
        fs::create_dir_all(path.parent().expect("outbox parent")).expect("create outbox parent");
        fs::write(&path, [0xff, 0xfe, 0xfd]).expect("write invalid utf8 outbox");

        let snapshot = store.outbox_backlog_snapshot();

        assert_eq!(snapshot.status, BacklogMetricStatus::Unavailable);
        assert_eq!(snapshot.current_depth, None);
        assert!(
            snapshot
                .error
                .as_deref()
                .is_some_and(|error| error.contains("failed to read hosted outbox"))
        );
    }

    #[test]
    fn malformed_line_parser_reports_skipped_lines() {
        let temp = TestDir::new("parse-log");
        let path = temp.0.join("outbox.jsonl");
        let first = hosted_event("evt_1", "hosted_lockdown");
        let raw = format!(
            "{}\n{{\"kind\":\"hosted_\n",
            serde_json::to_string(&first).expect("first event")
        );
        let mut skipped = Vec::new();

        let drained = parse_hosted_outbox_with_skip_logger(&raw, &path, |line, error| {
            skipped.push((line, error));
        });

        assert_eq!(drained.len(), 1);
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].0, 2);
        assert!(
            skipped[0].1.contains("failed to parse hosted outbox"),
            "{:?}",
            skipped
        );
    }

    fn hosted_event(id: &str, kind: &str) -> HostedEvent {
        HostedEvent {
            id: id.to_owned(),
            kind: kind.to_owned(),
            ts: "2026-01-01T00:00:00.000Z".to_owned(),
            principal_id: Some("prn_a".to_owned()),
            label: Some("cli".to_owned()),
            session_id: None,
            fingerprint: None,
            address_known: false,
            user_agent: None,
            detail: None,
        }
    }
}
