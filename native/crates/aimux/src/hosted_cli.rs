use crate::hosted_audit::{HostedAuditRecord, HostedAuditStore};
use crate::hosted_config::{
    HostedConfig, load_hosted_config_with_resolver, validate_hosted_startup,
};
use crate::hosted_lockdown::{HostedLockdownState, HostedLockdownStore};
use crate::hosted_outbox::HostedOutboxStore;
use crate::hosted_principals::{
    HostedGrant, HostedPrincipal, HostedPrincipalsState, HostedPrincipalsStore,
};
use crate::paths::PathResolver;
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::path::Path;

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

    fn resolve_project_root(&mut self, project: &str) -> String {
        self.resolver
            .resolve_repo_root(Path::new(project))
            .to_string_lossy()
            .into_owned()
    }

    fn load_config(&self) -> HostedConfig {
        load_hosted_config_with_resolver(&self.resolver)
    }

    fn principal_store(&self) -> HostedPrincipalsStore {
        HostedPrincipalsStore::with_resolver(self.resolver.clone())
    }

    fn load_principals(&self) -> Result<HostedPrincipalsState> {
        self.principal_store().load()
    }

    fn create_principal(&self, label: &str) -> Result<(HostedPrincipal, String)> {
        self.principal_store().create_principal(label)
    }

    fn revoke_principal(&self, principal_id: &str) -> Result<bool> {
        self.principal_store().revoke_principal(principal_id)
    }

    fn grant_session(&self, principal_id: &str, grant: HostedGrant) -> Result<bool> {
        self.principal_store().grant_session(principal_id, grant)
    }

    fn ungrant_session(&self, principal_id: &str, grant: &HostedGrant) -> Result<bool> {
        self.principal_store().ungrant_session(principal_id, grant)
    }

    fn lockdown_store(&self) -> HostedLockdownStore {
        HostedLockdownStore::with_resolver(self.resolver.clone())
    }

    fn set_lockdown(&self, active: bool) -> Result<HostedLockdownState> {
        self.lockdown_store().set_lockdown(active)
    }

    fn lockdown_state(&self) -> HostedLockdownState {
        self.lockdown_store().lockdown_state()
    }

    fn outbox_store(&self) -> HostedOutboxStore {
        HostedOutboxStore::with_resolver(self.resolver.clone())
    }

    fn raise_cli_event(&self, kind: &str, principal_id: Option<&str>, detail: &str) -> Result<()> {
        self.outbox_store()
            .raise_cli_event(kind, principal_id, detail)
    }

    fn tail_audit(&self, count: usize) -> Vec<HostedAuditRecord> {
        HostedAuditStore::with_resolver(self.resolver.clone()).tail_audit(count)
    }
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
