use crate::atomic_write::{atomic_write_with_mode, quarantine_corrupt_file};
use crate::hosted_lock::{HostedLockOptions, with_hosted_lock};
use crate::paths::PathResolver;
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, Metadata};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const HOSTED_TOKEN_PREFIX: &str = "amx_";
pub const HOSTED_HASH_PREFIX: &str = "sha256:";
const HOSTED_TOKEN_BYTES: usize = 32;
const PRINCIPAL_ID_BYTES: usize = 6;
const SEEN_THROTTLE_MS: u128 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedGrant {
    pub project_root: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedPrincipal {
    pub id: String,
    pub label: String,
    pub token_hash: String,
    pub role: String,
    pub grants: Vec<HostedGrant>,
    pub created_at: String,
    pub revoked_at: Option<String>,
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostedPrincipalsState {
    pub version: u8,
    pub principals: Vec<HostedPrincipal>,
}

#[derive(Debug, Clone)]
pub struct HostedPrincipalsStore {
    resolver: PathResolver,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PrincipalsCacheKey {
    path: PathBuf,
    mtime_ms: u128,
    size: u64,
    inode: Option<u64>,
}

#[derive(Debug, Clone)]
struct PrincipalsCacheEntry {
    key: PrincipalsCacheKey,
    state: HostedPrincipalsState,
}

static PRINCIPALS_CACHE: LazyLock<Mutex<Option<PrincipalsCacheEntry>>> =
    LazyLock::new(|| Mutex::new(None));

impl HostedPrincipalsStore {
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

    pub fn principals_path(&self) -> PathBuf {
        self.resolver.hosted_principals_path()
    }

    pub fn load(&self) -> Result<HostedPrincipalsState> {
        load_hosted_principals_from_path(&self.principals_path())
    }

    pub fn save(&self, state: &HostedPrincipalsState) -> Result<()> {
        ensure_private_hosted_dir(&self.hosted_dir())?;
        let data = serde_json::to_string_pretty(&normalized_state(state))? + "\n";
        atomic_write_with_mode(self.principals_path(), data, Some(0o600))?;
        clear_hosted_principals_cache();
        Ok(())
    }

    pub fn mutate<T>(
        &self,
        mutator: impl FnOnce(&mut HostedPrincipalsState) -> Result<T>,
        options: HostedLockOptions,
    ) -> Result<Option<T>> {
        let path = self.principals_path();
        let locked = with_hosted_lock(
            &path,
            || {
                let mut state = self.load()?;
                let result = mutator(&mut state)?;
                self.save(&state)?;
                Ok(result)
            },
            options,
        )
        .map_err(|message| anyhow!(message))?;
        locked.transpose()
    }

    pub fn mutate_or_false(
        &self,
        mutator: impl FnOnce(&mut HostedPrincipalsState) -> Result<bool>,
    ) -> Result<bool> {
        Ok(self
            .mutate(mutator, HostedLockOptions::default())?
            .unwrap_or(false))
    }

    pub fn list(&self) -> Result<Vec<HostedPrincipal>> {
        Ok(self.load()?.principals)
    }

    pub fn create_principal(&self, label: &str) -> Result<(HostedPrincipal, String)> {
        let token = format!(
            "{}{}",
            HOSTED_TOKEN_PREFIX,
            random_base64url(HOSTED_TOKEN_BYTES)?
        );
        let principal = HostedPrincipal {
            id: format!("prn_{}", random_hex(PRINCIPAL_ID_BYTES)?),
            label: {
                let trimmed = label.trim();
                if trimmed.is_empty() {
                    "unlabelled".to_owned()
                } else {
                    trimmed.to_owned()
                }
            },
            token_hash: hash_hosted_token(&token),
            role: "operator".to_owned(),
            grants: Vec::new(),
            created_at: now_iso(),
            revoked_at: None,
            last_seen_at: None,
        };
        let cloned = principal.clone();
        self.mutate(
            |state| {
                state.principals.push(cloned);
                Ok(())
            },
            HostedLockOptions::default(),
        )?;
        Ok((principal, token))
    }

    pub fn revoke_principal(&self, principal_id: &str) -> Result<bool> {
        self.mutate_or_false(|state| {
            let Some(principal) = state
                .principals
                .iter_mut()
                .find(|entry| entry.id == principal_id)
            else {
                return Ok(false);
            };
            if principal.revoked_at.is_some() {
                return Ok(false);
            }
            principal.revoked_at = Some(now_iso());
            Ok(true)
        })
    }

    pub fn grant_session(&self, principal_id: &str, grant: HostedGrant) -> Result<bool> {
        let Some(normalized) = normalize_grant_value(&serde_json::to_value(grant)?) else {
            return Ok(false);
        };
        self.mutate_or_false(|state| {
            let Some(principal) = state
                .principals
                .iter_mut()
                .find(|entry| entry.id == principal_id && entry.revoked_at.is_none())
            else {
                return Ok(false);
            };
            if !principal.grants.iter().any(|entry| entry == &normalized) {
                principal.grants.push(normalized);
            }
            Ok(true)
        })
    }

    pub fn ungrant_session(&self, principal_id: &str, grant: &HostedGrant) -> Result<bool> {
        let Some(normalized) = normalize_grant_value(&serde_json::to_value(grant)?) else {
            return Ok(false);
        };
        self.mutate_or_false(|state| {
            let Some(principal) = state
                .principals
                .iter_mut()
                .find(|entry| entry.id == principal_id)
            else {
                return Ok(false);
            };
            let before = principal.grants.len();
            principal.grants.retain(|entry| entry != &normalized);
            Ok(principal.grants.len() != before)
        })
    }

    pub fn find_principal_by_token(&self, token: &str) -> Result<Option<HostedPrincipal>> {
        let token = token.trim();
        if token.is_empty() {
            return Ok(None);
        }
        let candidate = hash_hosted_token(token);
        for principal in self.load()?.principals {
            if principal.revoked_at.is_some() {
                continue;
            }
            if hashes_match(&principal.token_hash, &candidate) {
                return Ok(Some(principal));
            }
        }
        Ok(None)
    }

    pub fn find_principal_by_id(&self, principal_id: &str) -> Result<Option<HostedPrincipal>> {
        Ok(self
            .load()?
            .principals
            .into_iter()
            .find(|principal| principal.id == principal_id))
    }

    pub fn count_active_principals(&self) -> Result<usize> {
        Ok(self
            .load()?
            .principals
            .iter()
            .filter(|principal| principal.revoked_at.is_none())
            .count())
    }

    pub fn mark_principal_seen(&self, principal_id: &str) -> Result<()> {
        self.mark_principal_seen_at(principal_id, unix_millis(SystemTime::now()), now_iso())
    }

    pub fn mark_principal_seen_at(
        &self,
        principal_id: &str,
        now_ms: u128,
        seen_at: String,
    ) -> Result<()> {
        let current = self
            .load()?
            .principals
            .into_iter()
            .find(|principal| principal.id == principal_id);
        let Some(current) = current else {
            return Ok(());
        };
        if current
            .last_seen_at
            .as_deref()
            .and_then(parse_iso_millis)
            .is_some_and(|last_seen_ms| now_ms.saturating_sub(last_seen_ms) < SEEN_THROTTLE_MS)
        {
            return Ok(());
        }
        let principal_id = principal_id.to_owned();
        let _ = self.mutate(
            |state| {
                if let Some(principal) = state
                    .principals
                    .iter_mut()
                    .find(|entry| entry.id == principal_id)
                {
                    principal.last_seen_at = Some(seen_at);
                }
                Ok(())
            },
            HostedLockOptions {
                wait: false,
                timeout_ms: 0,
            },
        )?;
        Ok(())
    }
}

pub fn empty_hosted_principals_state() -> HostedPrincipalsState {
    HostedPrincipalsState {
        version: 1,
        principals: Vec::new(),
    }
}

pub fn load_hosted_principals_from_path(path: &Path) -> Result<HostedPrincipalsState> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            set_hosted_principals_cache(None);
            return Ok(empty_hosted_principals_state());
        }
        Err(error) => return Err(error.into()),
    };
    let key = cache_key_for(path, &metadata);
    if let Some(state) = cached_state(&key) {
        return Ok(state);
    }
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            set_hosted_principals_cache(None);
            return Ok(empty_hosted_principals_state());
        }
        Err(error) => return Err(error.into()),
    };
    let value = match serde_json::from_str::<Value>(&raw) {
        Ok(value) => value,
        Err(_) => {
            set_hosted_principals_cache(None);
            quarantine_corrupt_file(path);
            return Ok(empty_hosted_principals_state());
        }
    };
    let state = normalize_state_value(&value);
    set_hosted_principals_cache(Some(PrincipalsCacheEntry {
        key,
        state: state.clone(),
    }));
    Ok(state)
}

pub fn normalize_grant_value(value: &Value) -> Option<HostedGrant> {
    let project_root = value.get("projectRoot")?.as_str()?.trim();
    let session_id = value.get("sessionId")?.as_str()?.trim();
    if project_root.is_empty() || session_id.is_empty() || !Path::new(project_root).is_absolute() {
        return None;
    }
    Some(HostedGrant {
        project_root: resolve_absolute_path(project_root),
        session_id: session_id.to_owned(),
    })
}

pub fn normalize_principal_value(value: &Value) -> Option<HostedPrincipal> {
    let id = value.get("id")?.as_str()?.trim();
    let token_hash = value.get("tokenHash")?.as_str()?.trim();
    if id.is_empty() || !token_hash.starts_with(HOSTED_HASH_PREFIX) {
        return None;
    }
    Some(HostedPrincipal {
        id: id.to_owned(),
        label: value
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_owned(),
        token_hash: token_hash.to_owned(),
        role: "operator".to_owned(),
        grants: value
            .get("grants")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(normalize_grant_value)
            .collect(),
        created_at: value
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("1970-01-01T00:00:00.000Z")
            .to_owned(),
        revoked_at: value
            .get("revokedAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
        last_seen_at: value
            .get("lastSeenAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

pub fn principal_has_grant(principal: &HostedPrincipal, grant: &HostedGrant) -> bool {
    if principal.revoked_at.is_some() {
        return false;
    }
    let Ok(value) = serde_json::to_value(grant) else {
        return false;
    };
    let Some(normalized) = normalize_grant_value(&value) else {
        return false;
    };
    principal.grants.iter().any(|entry| entry == &normalized)
}

pub fn hash_hosted_token(token: &str) -> String {
    format!(
        "{}{}",
        HOSTED_HASH_PREFIX,
        hex(&Sha256::digest(token.as_bytes()))
    )
}

pub fn clear_hosted_principals_cache() {
    set_hosted_principals_cache(None);
}

fn normalize_state_value(value: &Value) -> HostedPrincipalsState {
    HostedPrincipalsState {
        version: 1,
        principals: value
            .get("principals")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(normalize_principal_value)
            .collect(),
    }
}

fn normalized_state(state: &HostedPrincipalsState) -> HostedPrincipalsState {
    HostedPrincipalsState {
        version: 1,
        principals: state.principals.clone(),
    }
}

fn ensure_private_hosted_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn cached_state(key: &PrincipalsCacheKey) -> Option<HostedPrincipalsState> {
    let cache = PRINCIPALS_CACHE.lock().ok()?;
    cache
        .as_ref()
        .filter(|entry| &entry.key == key)
        .map(|entry| entry.state.clone())
}

fn set_hosted_principals_cache(entry: Option<PrincipalsCacheEntry>) {
    if let Ok(mut cache) = PRINCIPALS_CACHE.lock() {
        *cache = entry;
    }
}

fn cache_key_for(path: &Path, metadata: &Metadata) -> PrincipalsCacheKey {
    PrincipalsCacheKey {
        path: path.to_path_buf(),
        mtime_ms: metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or_default(),
        size: metadata.len(),
        inode: inode_for(metadata),
    }
}

#[cfg(unix)]
fn inode_for(metadata: &Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(metadata.ino())
}

#[cfg(not(unix))]
fn inode_for(_metadata: &Metadata) -> Option<u64> {
    None
}

fn hashes_match(stored: &str, candidate: &str) -> bool {
    let Some(stored) = stored.strip_prefix(HOSTED_HASH_PREFIX) else {
        return false;
    };
    let Some(candidate) = candidate.strip_prefix(HOSTED_HASH_PREFIX) else {
        return false;
    };
    let Some(stored) = hex_to_bytes(stored) else {
        return false;
    };
    let Some(candidate) = hex_to_bytes(candidate) else {
        return false;
    };
    if stored.is_empty() || stored.len() != candidate.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (left, right) in stored.iter().zip(candidate.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

fn hex_to_bytes(input: &str) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }
    let mut bytes = Vec::with_capacity(input.len() / 2);
    for chunk in input.as_bytes().chunks_exact(2) {
        let high = hex_value(chunk[0])?;
        let low = hex_value(chunk[1])?;
        bytes.push((high << 4) | low);
    }
    Some(bytes)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn resolve_absolute_path(path: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let absolute = Path::new(path);
    for component in absolute.components() {
        match component {
            Component::RootDir | Component::Prefix(_) => {
                parts.clear();
            }
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
        }
    }
    if parts.is_empty() {
        "/".to_owned()
    } else {
        format!("/{}", parts.join("/"))
    }
}

fn random_hex(bytes: usize) -> Result<String> {
    Ok(hex(&random_bytes(bytes)?))
}

fn random_base64url(bytes: usize) -> Result<String> {
    Ok(base64_url_no_pad(&random_bytes(bytes)?))
}

fn random_bytes(bytes: usize) -> Result<Vec<u8>> {
    let mut output = vec![0_u8; bytes];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut output)?;
    Ok(output)
}

fn base64_url_no_pad(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | b2 as u32;
        output.push(TABLE[((n >> 18) & 63) as usize] as char);
        output.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(TABLE[(n & 63) as usize] as char);
        }
    }
    output
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

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
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
