use crate::atomic_write::atomic_write_with_mode;
use crate::hosted_config::HostedConfig;
use crate::hosted_lock::{HostedLockOptions, with_hosted_lock};
use crate::paths::PathResolver;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEVICE_SIGHTING_TIMEOUT_MS: u64 = 200;
const LAST_SEEN_THROTTLE_MS: u128 = 60_000;
const MAX_QUEUE: usize = 100;
const RETRY_DELAYS_MS: [u64; 3] = [1_000, 5_000, 30_000];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedEvent {
    pub id: String,
    pub kind: String,
    pub ts: String,
    pub principal_id: Option<String>,
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub fingerprint: Option<String>,
    pub address_known: bool,
    pub user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub principal_id: String,
    pub fingerprint: String,
    pub first_seen: String,
    pub last_seen: String,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevicesState {
    pub version: u8,
    pub salt: String,
    pub devices: Vec<DeviceRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenDeviceInput {
    pub principal_id: String,
    pub label: String,
    pub address: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HostedDevicesStore {
    resolver: PathResolver,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedEventDeliveryConfig {
    pub webhook_url: Option<String>,
    pub webhook_secret: Option<String>,
}

pub trait HostedEventSender {
    fn post(&mut self, url: &str, headers: &[(String, String)], body: &str) -> Result<u16>;
}

pub struct HostedEventDelivery<S: HostedEventSender = UreqHostedEventSender> {
    config: HostedEventDeliveryConfig,
    sender: S,
    queue: VecDeque<HostedEvent>,
    stopped: bool,
    retry_delays_ms: Vec<u64>,
}

#[derive(Debug, Default, Clone)]
pub struct UreqHostedEventSender;

impl HostedDevicesStore {
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

    pub fn devices_path(&self) -> PathBuf {
        self.resolver.hosted_devices_path()
    }

    pub fn load_devices(&self) -> DevicesState {
        load_devices_from_path(self.devices_path())
    }

    pub fn save_devices(&self, state: &DevicesState) -> Result<()> {
        fs::create_dir_all(self.hosted_dir())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(self.hosted_dir(), fs::Permissions::from_mode(0o700))?;
        }
        atomic_write_with_mode(
            self.devices_path(),
            serde_json::to_string_pretty(state)? + "\n",
            Some(0o600),
        )?;
        Ok(())
    }

    pub fn record_device_sighting(&self, input: SeenDeviceInput) -> Option<HostedEvent> {
        self.record_device_sighting_with(input, unix_millis(SystemTime::now()), now_iso(), || {
            random_uuid_like().unwrap_or_else(|_| "00000000-0000-4000-8000-000000000000".to_owned())
        })
    }

    pub fn record_device_sighting_with(
        &self,
        input: SeenDeviceInput,
        now_ms: u128,
        now_iso: String,
        next_id: impl FnOnce() -> String,
    ) -> Option<HostedEvent> {
        let path = self.devices_path();
        with_hosted_lock(
            &path,
            || {
                let mut state = self.load_devices();
                let fingerprint = device_fingerprint(
                    &state.salt,
                    input.address.as_deref(),
                    input.user_agent.as_deref(),
                );

                if let Some(known) = state.devices.iter_mut().find(|device| {
                    device.principal_id == input.principal_id && device.fingerprint == fingerprint
                }) {
                    if parse_iso_millis(&known.last_seen).is_some_and(|last_seen_ms| {
                        now_ms.saturating_sub(last_seen_ms) >= LAST_SEEN_THROTTLE_MS
                    }) {
                        known.last_seen = now_iso;
                        known.user_agent = input.user_agent;
                        let _ = self.save_devices(&state);
                    }
                    return None;
                }

                let principal_seen_before = state
                    .devices
                    .iter()
                    .any(|device| device.principal_id == input.principal_id);
                state.devices.push(DeviceRecord {
                    principal_id: input.principal_id.clone(),
                    fingerprint: fingerprint.clone(),
                    first_seen: now_iso.clone(),
                    last_seen: now_iso.clone(),
                    user_agent: input.user_agent.clone(),
                });
                let _ = self.save_devices(&state);

                Some(HostedEvent {
                    id: next_id(),
                    kind: if principal_seen_before {
                        "hosted_new_device"
                    } else {
                        "hosted_token_first_use"
                    }
                    .to_owned(),
                    ts: now_iso,
                    principal_id: Some(input.principal_id),
                    label: Some(input.label),
                    session_id: None,
                    fingerprint: Some(fingerprint),
                    address_known: input.address.is_some(),
                    user_agent: input.user_agent,
                    detail: None,
                })
            },
            HostedLockOptions {
                wait: true,
                timeout_ms: DEVICE_SIGHTING_TIMEOUT_MS,
            },
        )
        .ok()
        .flatten()
        .flatten()
    }

    pub fn prune_devices(&self, retention_days: i64, now_ms: u128) {
        let path = self.devices_path();
        let cutoff = now_ms.saturating_sub(retention_days.max(0) as u128 * 24 * 60 * 60 * 1_000);
        let _ = with_hosted_lock(
            &path,
            || {
                let mut state = self.load_devices();
                let before = state.devices.len();
                state.devices.retain(|device| {
                    parse_iso_millis(&device.last_seen)
                        .map(|last_seen| last_seen >= cutoff)
                        .unwrap_or(true)
                });
                if state.devices.len() != before {
                    let _ = self.save_devices(&state);
                }
            },
            HostedLockOptions {
                wait: true,
                timeout_ms: DEVICE_SIGHTING_TIMEOUT_MS,
            },
        );
    }
}

impl HostedEventDelivery<UreqHostedEventSender> {
    pub fn new_from_hosted_config(config: &HostedConfig) -> Self {
        Self::new(HostedEventDeliveryConfig {
            webhook_url: config.webhook_url.clone(),
            webhook_secret: std::env::var(&config.webhook_secret_env)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
        })
    }

    pub fn new(config: HostedEventDeliveryConfig) -> Self {
        Self::with_sender(config, UreqHostedEventSender)
    }
}

impl<S: HostedEventSender> HostedEventDelivery<S> {
    pub fn with_sender(config: HostedEventDeliveryConfig, sender: S) -> Self {
        Self {
            config,
            sender,
            queue: VecDeque::new(),
            stopped: false,
            retry_delays_ms: RETRY_DELAYS_MS.to_vec(),
        }
    }

    pub fn with_sender_and_delays(
        config: HostedEventDeliveryConfig,
        sender: S,
        retry_delays_ms: Vec<u64>,
    ) -> Self {
        Self {
            config,
            sender,
            queue: VecDeque::new(),
            stopped: false,
            retry_delays_ms,
        }
    }

    pub fn enqueue(&mut self, event: HostedEvent) {
        if self.stopped || self.config.webhook_url.is_none() || self.config.webhook_secret.is_none()
        {
            return;
        }
        if self.queue.len() >= MAX_QUEUE {
            self.queue.pop_front();
        }
        self.queue.push_back(event);
        self.drain();
    }

    pub fn stop(&mut self) {
        self.stopped = true;
        self.queue.clear();
    }

    fn drain(&mut self) {
        while !self.stopped {
            let Some(event) = self.queue.pop_front() else {
                return;
            };
            let _ = self.attempt(&event);
        }
    }

    fn attempt(&mut self, event: &HostedEvent) -> bool {
        for index in 0..=self.retry_delays_ms.len() {
            if self.stopped {
                return false;
            }
            if self.post(event).is_ok() {
                return true;
            }
            let Some(delay) = self.retry_delays_ms.get(index).copied() else {
                return false;
            };
            if delay > 0 {
                thread::sleep(Duration::from_millis(delay));
            }
        }
        false
    }

    fn post(&mut self, event: &HostedEvent) -> Result<()> {
        let Some(secret) = self.config.webhook_secret.as_deref() else {
            return Ok(());
        };
        let Some(url) = self.config.webhook_url.as_deref() else {
            return Ok(());
        };
        let body = serde_json::to_string(event)?;
        let timestamp = (unix_millis(SystemTime::now()) / 1_000).to_string();
        let headers = vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("content-length".to_owned(), body.len().to_string()),
            ("x-aimux-timestamp".to_owned(), timestamp.clone()),
            (
                "x-aimux-signature".to_owned(),
                sign_hosted_event(secret, &timestamp, &body),
            ),
        ];
        let status = self.sender.post(url, &headers, &body)?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            bail!("webhook responded with non-success status")
        }
    }
}

impl HostedEventSender for UreqHostedEventSender {
    fn post(&mut self, url: &str, headers: &[(String, String)], body: &str) -> Result<u16> {
        let mut request = ureq::post(url).timeout(Duration::from_secs(10));
        for (key, value) in headers {
            request = request.set(key, value);
        }
        let response = request.send_string(body)?;
        Ok(response.status())
    }
}

pub fn client_address(
    peer_address: Option<&str>,
    headers: &std::collections::BTreeMap<String, String>,
    trusted_forwarded_header: Option<&str>,
) -> Option<String> {
    let peer = peer_address
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let Some(header) = trusted_forwarded_header.filter(|value| !value.is_empty()) else {
        return peer;
    };
    let peer = peer?;
    if !is_loopback_peer(&peer) {
        return Some(peer);
    }
    let forwarded = headers.get(header).and_then(|value| {
        value
            .split(',')
            .map(str::trim)
            .rfind(|entry| !entry.is_empty())
            .map(str::to_owned)
    });
    Some(forwarded.unwrap_or(peer))
}

pub fn is_loopback_peer(peer: &str) -> bool {
    peer == "::1" || peer.starts_with("::ffff:127.") || peer.starts_with("127.")
}

pub fn device_fingerprint(salt: &str, address: Option<&str>, user_agent: Option<&str>) -> String {
    let text = format!(
        "{}:{}:{}",
        salt,
        address.unwrap_or("unknown"),
        user_agent.unwrap_or("unknown")
    );
    hex(&Sha256::digest(text.as_bytes()))[..32].to_owned()
}

pub fn sign_hosted_event(secret: &str, timestamp: &str, body: &str) -> String {
    let message = format!("{timestamp}.{body}");
    format!(
        "sha256={}",
        hmac_sha256_hex(secret.as_bytes(), message.as_bytes())
    )
}

fn empty_devices() -> DevicesState {
    DevicesState {
        version: 1,
        salt: random_hex(32).unwrap_or_else(|_| {
            "0000000000000000000000000000000000000000000000000000000000000000".to_owned()
        }),
        devices: Vec::new(),
    }
}

fn load_devices_from_path(path: PathBuf) -> DevicesState {
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                crate::atomic_write::quarantine_corrupt_file(&path);
            }
            return empty_devices();
        }
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        crate::atomic_write::quarantine_corrupt_file(&path);
        return empty_devices();
    };
    let Some(salt) = value
        .get("salt")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return empty_devices();
    };
    DevicesState {
        version: 1,
        salt: salt.to_owned(),
        devices: value
            .get("devices")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|device| serde_json::from_value::<DeviceRecord>(device.clone()).ok())
            .collect(),
    }
}

fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    let mut normalized_key = if key.len() > 64 {
        Sha256::digest(key).to_vec()
    } else {
        key.to_vec()
    };
    normalized_key.resize(64, 0);

    let mut outer = vec![0x5c; 64];
    let mut inner = vec![0x36; 64];
    for (index, byte) in normalized_key.iter().enumerate() {
        outer[index] ^= byte;
        inner[index] ^= byte;
    }

    let mut inner_hash = Sha256::new();
    inner_hash.update(&inner);
    inner_hash.update(message);
    let inner_digest = inner_hash.finalize();

    let mut outer_hash = Sha256::new();
    outer_hash.update(&outer);
    outer_hash.update(inner_digest);
    hex(&outer_hash.finalize())
}

fn random_hex(bytes: usize) -> Result<String> {
    Ok(hex(&random_bytes(bytes)?))
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

fn parse_iso_millis(value: &str) -> Option<u128> {
    let year = value.get(0..4)?.parse::<i64>().ok()?;
    let month = value.get(5..7)?.parse::<i64>().ok()?;
    let day = value.get(8..10)?.parse::<i64>().ok()?;
    let hour = value.get(11..13)?.parse::<u128>().ok()?;
    let minute = value.get(14..16)?.parse::<u128>().ok()?;
    let second = value.get(17..19)?.parse::<u128>().ok()?;
    let millis = value.get(20..23)?.parse::<u128>().ok()?;
    let days = days_from_civil(year, month, day)?;
    Some(
        u128::try_from(days).ok()? * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1_000
            + millis,
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
