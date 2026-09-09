use crate::atomic_write::atomic_write_with_mode;
use crate::hosted_config::{
    HostedConfig, load_hosted_config_with_resolver, validate_hosted_startup,
};
use crate::paths::PathResolver;
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const TOKEN_PREFIX: &str = "amx_";
const HASH_PREFIX: &str = "sha256:";

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedLockdownState {
    pub active: bool,
    pub since: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedCliEvent {
    pub id: String,
    pub kind: String,
    pub ts: String,
    pub principal_id: Option<String>,
    pub label: String,
    pub fingerprint: Option<String>,
    pub address_known: bool,
    pub user_agent: Option<String>,
    pub detail: String,
}

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedCliOutput {
    pub code: u8,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

impl HostedCliOutput {
    fn ok(stdout: Vec<String>) -> Self {
        Self {
            code: 0,
            stdout,
            stderr: Vec::new(),
        }
    }

    fn err(code: u8, stderr: impl Into<String>) -> Self {
        Self {
            code,
            stdout: Vec::new(),
            stderr: vec![stderr.into()],
        }
    }
}

pub fn run_hosted_cli_command(args: &[String]) -> HostedCliOutput {
    match run_hosted_cli_command_result(args) {
        Ok(output) => output,
        Err(error) => HostedCliOutput::err(1, error.to_string()),
    }
}

fn run_hosted_cli_command_result(args: &[String]) -> Result<HostedCliOutput> {
    if args.first().map(String::as_str) != Some("hosted") {
        bail!("unsupported hosted command");
    }
    let mut store = HostedStore::from_env()?;
    match args.get(1).map(String::as_str) {
        Some("status") => hosted_status(&mut store, has_flag(args, "--json")),
        Some("token") => hosted_token(&mut store, args),
        Some("grant") => hosted_grant(&mut store, args, true),
        Some("ungrant") => hosted_grant(&mut store, args, false),
        Some("lockdown") => hosted_lockdown(&mut store, args),
        Some("audit") => hosted_audit(&mut store, args),
        _ => Ok(HostedCliOutput::err(
            2,
            "error: unsupported or invalid aimux command: ".to_owned() + &args.join(" "),
        )),
    }
}

fn hosted_status(store: &mut HostedStore, json_output: bool) -> Result<HostedCliOutput> {
    let config = store.load_config();
    let principals = store.load_principals()?.principals;
    let active = principals
        .iter()
        .filter(|principal| principal.revoked_at.is_none())
        .count();
    let lockdown = store.lockdown_state();
    let startup = validate_hosted_startup(&config, active);
    if json_output {
        return Ok(HostedCliOutput::ok(vec![serde_json::to_string_pretty(
            &json!({
                "enabled": config.enabled,
                "bindAddress": config.bind_address,
                "port": config.port,
                "webhookConfigured": config.webhook_url.is_some(),
                "trustedForwardedHeader": config.trusted_forwarded_header,
                "retentionDays": config.retention_days,
                "principals": { "total": principals.len(), "active": active },
                "lockdown": lockdown,
                "startup": startup,
            }),
        )?]));
    }
    let mut lines = vec![
        format!(
            "Hosted mode: {}",
            if config.enabled {
                "enabled"
            } else {
                "disabled"
            }
        ),
        format!("Listener:    {}:{}", config.bind_address, config.port),
        format!("Principals:  {active} active, {} total", principals.len()),
        format!(
            "Webhook:     {}",
            config
                .webhook_url
                .as_ref()
                .map(|_| format!("configured ({})", config.webhook_secret_env))
                .unwrap_or_else(|| "not configured".to_owned())
        ),
        format!(
            "Lockdown:    {}",
            if lockdown.active {
                format!(
                    "ON since {}",
                    lockdown.since.as_deref().unwrap_or("unknown")
                )
            } else {
                "off".to_owned()
            }
        ),
    ];
    if let Value::Object(startup) = startup
        && startup.get("ok").and_then(Value::as_bool) == Some(false)
        && let Some(error) = startup.get("error").and_then(Value::as_str)
    {
        lines.push(String::new());
        lines.push(format!("Will not start: {error}"));
    }
    Ok(HostedCliOutput::ok(lines))
}

fn hosted_token(store: &mut HostedStore, args: &[String]) -> Result<HostedCliOutput> {
    match args.get(2).map(String::as_str) {
        Some("create") => {
            let label = option_value(args, "--label")
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("error: required option '--label <label>' not specified"))?;
            let (principal, token) = store.create_principal(&label)?;
            Ok(HostedCliOutput::ok(vec![
                String::new(),
                format!("Principal: {}  ({})", principal.id, principal.label),
                format!("Token:     {token}"),
                String::new(),
                "Store it now -- only its hash is kept, so it cannot be shown again.".to_owned(),
                format!(
                    "Grant it a session with:\n  aimux hosted grant {} --project <root> --session <id>\n",
                    principal.id
                ),
            ]))
        }
        Some("list") => {
            let principals = store.load_principals()?.principals;
            if has_flag(args, "--json") {
                return Ok(HostedCliOutput::ok(vec![serde_json::to_string_pretty(
                    &principals,
                )?]));
            }
            if principals.is_empty() {
                return Ok(HostedCliOutput::ok(vec![
                    "No principals. Create one with: aimux hosted token create --label <label>"
                        .to_owned(),
                ]));
            }
            let mut lines = Vec::new();
            for principal in principals {
                let state = principal
                    .revoked_at
                    .as_ref()
                    .map(|revoked| format!("revoked {revoked}"))
                    .unwrap_or_else(|| "active".to_owned());
                lines.push(format!("{}  {}  [{state}]", principal.id, principal.label));
                if principal.grants.is_empty() {
                    lines.push("    (no grants)".to_owned());
                } else {
                    for grant in principal.grants {
                        lines.push(format!("    {}  {}", grant.session_id, grant.project_root));
                    }
                }
            }
            Ok(HostedCliOutput::ok(lines))
        }
        Some("revoke") => {
            let Some(principal_id) = args.get(3) else {
                return Ok(HostedCliOutput::err(
                    1,
                    "error: missing required argument 'principalId'",
                ));
            };
            if !store.revoke_principal(principal_id)? {
                return Ok(HostedCliOutput::err(
                    1,
                    format!("No active principal {principal_id}"),
                ));
            }
            store.raise_cli_event(
                "hosted_token_revoked",
                Some(principal_id),
                "revoked via CLI",
            )?;
            Ok(HostedCliOutput::ok(vec![format!("Revoked {principal_id}")]))
        }
        _ => Ok(HostedCliOutput::err(
            2,
            "error: unsupported or invalid aimux command: ".to_owned() + &args.join(" "),
        )),
    }
}

fn hosted_grant(
    store: &mut HostedStore,
    args: &[String],
    grant_operation: bool,
) -> Result<HostedCliOutput> {
    let Some(principal_id) = args.get(2) else {
        return Ok(HostedCliOutput::err(
            1,
            "error: missing required argument 'principalId'",
        ));
    };
    let Some(project) = option_value(args, "--project") else {
        return Ok(HostedCliOutput::err(
            1,
            "error: required option '--project <root>' not specified",
        ));
    };
    let Some(session_id) = option_value(args, "--session") else {
        return Ok(HostedCliOutput::err(
            1,
            "error: required option '--session <id>' not specified",
        ));
    };
    let project_root = store.resolve_project_root(project);
    let grant = HostedGrant {
        project_root,
        session_id: session_id.to_owned(),
    };
    let changed = if grant_operation {
        store.grant_session(principal_id, grant.clone())?
    } else {
        store.ungrant_session(principal_id, &grant)?
    };
    if !changed {
        return Ok(HostedCliOutput::err(
            1,
            if grant_operation {
                format!(
                    "Could not grant -- no active principal {principal_id}, or an invalid project/session"
                )
            } else {
                format!("No such grant on {principal_id}")
            },
        ));
    }
    if grant_operation {
        store.raise_cli_event(
            "hosted_grant_changed",
            Some(principal_id),
            &format!("granted {session_id}"),
        )?;
        Ok(HostedCliOutput::ok(vec![format!(
            "Granted {principal_id} -> {session_id} in {}",
            grant.project_root
        )]))
    } else {
        store.raise_cli_event(
            "hosted_grant_changed",
            Some(principal_id),
            &format!("ungranted {session_id}"),
        )?;
        Ok(HostedCliOutput::ok(vec![format!(
            "Removed {session_id} from {principal_id}"
        )]))
    }
}

fn hosted_lockdown(store: &mut HostedStore, args: &[String]) -> Result<HostedCliOutput> {
    match args.get(2).map(String::as_str) {
        Some("on") => {
            let state = store.set_lockdown(true)?;
            store.raise_cli_event("hosted_lockdown", None, "engaged")?;
            Ok(HostedCliOutput::ok(vec![format!(
                "Hosted mode locked down at {}",
                state.since.unwrap_or_else(|| "unknown".to_owned())
            )]))
        }
        Some("off") => {
            store.set_lockdown(false)?;
            store.raise_cli_event("hosted_lockdown", None, "cleared")?;
            Ok(HostedCliOutput::ok(vec![
                "Hosted lockdown cleared".to_owned(),
            ]))
        }
        _ => Ok(HostedCliOutput::err(
            1,
            "Usage: aimux hosted lockdown on|off",
        )),
    }
}

fn hosted_audit(store: &mut HostedStore, args: &[String]) -> Result<HostedCliOutput> {
    if args.get(2).map(String::as_str) != Some("tail") {
        return Ok(HostedCliOutput::err(
            2,
            "error: unsupported or invalid aimux command: ".to_owned() + &args.join(" "),
        ));
    }
    let count = option_value(args, "--lines")
        .or_else(|| option_value(args, "-n"))
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(20);
    let records = store.tail_audit(count);
    if has_flag(args, "--json") {
        return Ok(HostedCliOutput::ok(vec![serde_json::to_string_pretty(
            &records,
        )?]));
    }
    let lines = records
        .iter()
        .map(|record| {
            let what = record
                .event
                .as_ref()
                .map(|event| {
                    format!("{} {}", event, record.detail.as_deref().unwrap_or_default())
                        .trim()
                        .to_owned()
                })
                .unwrap_or_else(|| format!("{} {}", record.method, record.path));
            format!(
                "{}  {}  {}  {}  {}",
                record.ts,
                record.label,
                record.status,
                record.session_id.as_deref().unwrap_or("-"),
                what
            )
        })
        .collect();
    Ok(HostedCliOutput::ok(lines))
}

struct HostedStore {
    resolver: PathResolver,
}

impl HostedStore {
    fn from_env() -> Result<Self> {
        Ok(Self {
            resolver: PathResolver::from_env(),
        })
    }

    fn principals_path(&self) -> PathBuf {
        self.resolver.hosted_principals_path()
    }

    fn hosted_dir(&self) -> PathBuf {
        self.resolver.hosted_dir()
    }

    fn lockdown_path(&self) -> PathBuf {
        self.resolver.hosted_lockdown_path()
    }

    fn audit_path(&self) -> PathBuf {
        self.resolver.hosted_audit_path()
    }

    fn outbox_path(&self) -> PathBuf {
        self.resolver.hosted_outbox_path()
    }

    fn resolve_project_root(&mut self, project: &str) -> String {
        self.resolver
            .resolve_repo_root(Path::new(project))
            .to_string_lossy()
            .into_owned()
    }

    fn load_config(&self) -> HostedConfig {
        load_hosted_config_with_resolver(&self.resolver)
    }

    fn load_principals(&self) -> Result<HostedPrincipalsState> {
        let path = self.principals_path();
        let Ok(raw) = fs::read_to_string(path) else {
            return Ok(empty_state());
        };
        let value: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let principals = value
            .get("principals")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(normalize_principal)
            .collect::<Vec<_>>();
        Ok(HostedPrincipalsState {
            version: 1,
            principals,
        })
    }

    fn save_principals(&self, state: &HostedPrincipalsState) -> Result<()> {
        fs::create_dir_all(self.hosted_dir())?;
        let data = serde_json::to_string_pretty(state)? + "\n";
        atomic_write_with_mode(self.principals_path(), data, Some(0o600))?;
        Ok(())
    }

    fn create_principal(&self, label: &str) -> Result<(HostedPrincipal, String)> {
        let token = format!("{TOKEN_PREFIX}{}", random_base64url(32)?);
        let principal = HostedPrincipal {
            id: format!("prn_{}", random_hex(6)?),
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
        let mut state = self.load_principals()?;
        state.principals.push(principal.clone());
        self.save_principals(&state)?;
        Ok((principal, token))
    }

    fn revoke_principal(&self, principal_id: &str) -> Result<bool> {
        let mut state = self.load_principals()?;
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
        self.save_principals(&state)?;
        Ok(true)
    }

    fn grant_session(&self, principal_id: &str, grant: HostedGrant) -> Result<bool> {
        let Some(normalized) = normalize_grant_value(&json!(grant)) else {
            return Ok(false);
        };
        let mut state = self.load_principals()?;
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
        self.save_principals(&state)?;
        Ok(true)
    }

    fn ungrant_session(&self, principal_id: &str, grant: &HostedGrant) -> Result<bool> {
        let mut state = self.load_principals()?;
        let Some(principal) = state
            .principals
            .iter_mut()
            .find(|entry| entry.id == principal_id)
        else {
            return Ok(false);
        };
        let before = principal.grants.len();
        principal.grants.retain(|entry| entry != grant);
        if principal.grants.len() == before {
            return Ok(false);
        }
        self.save_principals(&state)?;
        Ok(true)
    }

    fn set_lockdown(&self, active: bool) -> Result<HostedLockdownState> {
        if !active {
            let _ = fs::remove_file(self.lockdown_path());
            return Ok(HostedLockdownState {
                active: false,
                since: None,
            });
        }
        fs::create_dir_all(self.hosted_dir())?;
        let state = HostedLockdownState {
            active: true,
            since: Some(now_iso()),
        };
        let data = serde_json::to_string(&state)? + "\n";
        atomic_write_with_mode(self.lockdown_path(), data, Some(0o600))?;
        Ok(state)
    }

    fn lockdown_state(&self) -> HostedLockdownState {
        let raw = match fs::read_to_string(self.lockdown_path()) {
            Ok(raw) => raw,
            Err(error) => {
                if error.kind() == std::io::ErrorKind::NotFound {
                    return HostedLockdownState {
                        active: false,
                        since: None,
                    };
                }
                return HostedLockdownState {
                    active: true,
                    since: None,
                };
            }
        };
        serde_json::from_str::<HostedLockdownState>(&raw).unwrap_or(HostedLockdownState {
            active: true,
            since: None,
        })
    }

    fn raise_cli_event(&self, kind: &str, principal_id: Option<&str>, detail: &str) -> Result<()> {
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
        append_jsonl(self.audit_path(), &audit)?;
        let event = HostedCliEvent {
            id: random_uuid_like()?,
            kind: kind.to_owned(),
            ts,
            principal_id: principal_id.map(str::to_owned),
            label: "cli".to_owned(),
            fingerprint: None,
            address_known: false,
            user_agent: None,
            detail: detail.to_owned(),
        };
        append_jsonl(self.outbox_path(), &event)?;
        Ok(())
    }

    fn tail_audit(&self, count: usize) -> Vec<HostedAuditRecord> {
        let mut records = read_jsonl::<HostedAuditRecord>(self.audit_path(), Some(count));
        records.extend(read_jsonl::<HostedAuditRecord>(
            pending_path_for(&self.audit_path()),
            Some(count),
        ));
        records.sort_by(|left, right| left.ts.cmp(&right.ts));
        let start = records.len().saturating_sub(count);
        records[start..].to_vec()
    }
}

fn empty_state() -> HostedPrincipalsState {
    HostedPrincipalsState {
        version: 1,
        principals: Vec::new(),
    }
}

fn normalize_principal(value: &Value) -> Option<HostedPrincipal> {
    let id = value.get("id")?.as_str()?.trim();
    let token_hash = value.get("tokenHash")?.as_str()?.trim();
    if id.is_empty() || !token_hash.starts_with(HASH_PREFIX) {
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

fn normalize_grant_value(value: &Value) -> Option<HostedGrant> {
    let project_root = value.get("projectRoot")?.as_str()?.trim();
    let session_id = value.get("sessionId")?.as_str()?.trim();
    if project_root.is_empty() || session_id.is_empty() || !Path::new(project_root).is_absolute() {
        return None;
    }
    Some(HostedGrant {
        project_root: Path::new(project_root).to_string_lossy().into_owned(),
        session_id: session_id.to_owned(),
    })
}

fn option_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    for index in 0..args.len() {
        let arg = args[index].as_str();
        if arg == name {
            return args.get(index + 1).map(String::as_str);
        }
        if let Some(value) = arg.strip_prefix(&(name.to_owned() + "=")) {
            return Some(value);
        }
    }
    None
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

fn hash_hosted_token(token: &str) -> String {
    format!("{}{}", HASH_PREFIX, hex(&Sha256::digest(token.as_bytes())))
}

fn append_jsonl(path: PathBuf, value: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
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

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: PathBuf, limit: Option<usize>) -> Vec<T> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    if let Some(limit) = limit {
        let start = lines.len().saturating_sub(limit);
        lines = lines[start..].to_vec();
    }
    lines
        .into_iter()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn pending_path_for(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.pending", path.to_string_lossy()))
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
