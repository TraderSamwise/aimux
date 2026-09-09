use aimux::hosted_audit::HostedAuditRecord;
use aimux::hosted_auth::{
    HostedAuthentication, authenticate_hosted_value,
    bearer_token_value as hosted_bearer_token_value, strip_trusted_headers_value,
};
use aimux::hosted_lockdown::{
    HostedLockdownState, HostedLockdownStore, reset_hosted_lockdown_cache,
};
use aimux::hosted_outbox::{HostedEvent, HostedOutboxStore};
use aimux::hosted_principals::{HostedPrincipalsStore, clear_hosted_principals_cache};
use aimux::paths::PathResolver;
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn run_hosted_security_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "stripTrustedHeaders" => {
            strip_trusted_headers_value(input.get("headers").unwrap_or(&Value::Null))
        }
        "bearerToken" => json!(
            array_field(input, "values")
                .iter()
                .map(bearer_token_value)
                .collect::<Vec<_>>()
        ),
        "authenticateHosted" => authenticate_hosted_case(str_field(input, "scenario")),
        "authenticateHosted/stripTrustedHeaders" => {
            let clean = strip_trusted_headers_value(input.get("headers").unwrap_or(&Value::Null));
            authenticate_hosted_headers(&clean)
        }
        "hostedLockdownState/setHostedLockdown" => lockdown_case(str_field(input, "scenario")),
        "setHostedLockdown" => lockdown_case(str_field(input, "scenario")),
        "hostedLockdownState" => lockdown_case(str_field(input, "scenario")),
        "isHostedLockedDown" => lockdown_case(str_field(input, "scenario")),
        "drainHostedOutbox/spoolHostedEvent" => lockdown_case(str_field(input, "scenario")),
        "drainHostedOutbox" => lockdown_case(str_field(input, "scenario")),
        "raiseHostedCliEvent" => lockdown_case(str_field(input, "scenario")),
        api => panic!("unknown hosted security contract api: {api}"),
    }
}

fn bearer_token_value(headers: &Value) -> Value {
    hosted_bearer_token_value(headers)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn authenticate_hosted_case(scenario: &str) -> Value {
    let fixture = AuthFixture::new();
    match scenario {
        "live-token" => {
            let (_principal, token) = fixture.store.create_principal("grand").expect("create");
            auth_result(
                authenticate_hosted_value(
                    &json!({ "authorization": format!("Bearer {token}") }),
                    &fixture.store,
                )
                .expect("authenticate live"),
            )
        }
        "missing-unknown-revoked" => {
            let (principal, token) = fixture.store.create_principal("grand").expect("create");
            let missing =
                authenticate_hosted_value(&json!({}), &fixture.store).expect("missing auth");
            let unknown = authenticate_hosted_value(
                &json!({ "authorization": "Bearer amx_unknown" }),
                &fixture.store,
            )
            .expect("unknown auth");
            fixture
                .store
                .revoke_principal(&principal.id)
                .expect("revoke principal");
            let revoked = authenticate_hosted_value(
                &json!({ "authorization": format!("Bearer {token}") }),
                &fixture.store,
            )
            .expect("revoked auth");
            json!({
                "missing": auth_result(missing),
                "unknown": auth_result(unknown),
                "revoked": auth_result(revoked),
            })
        }
        scenario => panic!("unknown hosted auth scenario: {scenario}"),
    }
}

fn authenticate_hosted_headers(headers: &Value) -> Value {
    let fixture = AuthFixture::new();
    auth_result(authenticate_hosted_value(headers, &fixture.store).expect("authenticate headers"))
}

struct AuthFixture {
    root: PathBuf,
    store: HostedPrincipalsStore,
}

impl AuthFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-hosted-auth-contract-{}-{}",
            std::process::id(),
            unix_millis(SystemTime::now())
        ));
        fs::create_dir_all(&root).expect("fixture root");
        let resolver = PathResolver::new(
            "/",
            &root,
            Some(root.join(".aimux").to_string_lossy().into_owned()),
        );
        Self {
            root,
            store: HostedPrincipalsStore::with_resolver(resolver),
        }
    }
}

impl Drop for AuthFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        clear_hosted_principals_cache();
    }
}

fn auth_result(result: HostedAuthentication) -> Value {
    if !result.ok {
        return json!({ "ok": false, "reason": result.reason.unwrap_or_default() });
    }
    let principal = result.principal.expect("principal");
    let actor = result.actor.expect("actor");
    let actor_principal = actor.principal.expect("actor principal");
    json!({
        "ok": true,
        "actor": {
            "role": "operator",
            "principalId": "<principal:1>",
            "principalMatches": actor_principal.id == principal.id,
        },
        "principal": {
            "id": "<principal:1>",
            "label": principal.label,
            "role": principal.role,
            "grants": principal.grants,
            "revoked": principal.revoked_at.is_some(),
        },
    })
}

fn lockdown_case(scenario: &str) -> Value {
    let fixture = SecurityFixture::new();
    match scenario {
        "engage-clear" => lockdown_engage_clear(&fixture),
        "marker-mode" => {
            fixture.lockdown.set_lockdown(true).expect("set lockdown");
            json!({ "mode": mode_for(&fixture.lockdown.lockdown_path()) })
        }
        "corrupt-marker" => {
            fs::create_dir_all(fixture.lockdown.hosted_dir()).expect("hosted dir");
            fs::write(fixture.lockdown.lockdown_path(), "{ not json").expect("marker");
            reset_hosted_lockdown_cache();
            json!({
                "state": fixture.lockdown.lockdown_state(),
                "locked": fixture.lockdown.is_locked_down(unix_millis(SystemTime::now())),
            })
        }
        "cache-window" => {
            let first = fixture.lockdown.is_locked_down(1_000);
            fs::create_dir_all(fixture.lockdown.hosted_dir()).expect("hosted dir");
            fs::write(fixture.lockdown.lockdown_path(), "{}").expect("marker");
            let within = fixture.lockdown.is_locked_down(1_500);
            let after = fixture.lockdown.is_locked_down(2_500);
            json!({ "first": first, "within": within, "after": after })
        }
        "drain-spooled" => {
            fixture
                .outbox
                .spool_event(&fixture.event("hosted_token_revoked"));
            fixture
                .outbox
                .spool_event(&fixture.event("hosted_grant_changed"));
            let drained = fixture.outbox.drain_outbox();
            json!({
                "kinds": drained.into_iter().map(|event| event.kind).collect::<Vec<_>>(),
                "existsAfterDrain": fixture.outbox.outbox_path().exists(),
                "secondDrain": fixture.outbox.drain_outbox(),
            })
        }
        "torn-line" => {
            fixture
                .outbox
                .spool_event(&fixture.event("hosted_lockdown"));
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(fixture.outbox.outbox_path())
                .expect("outbox append");
            writeln!(
                file,
                "{}",
                serde_json::to_string(&fixture.event("hosted_lockdown")).expect("event json")
            )
            .expect("valid event");
            write!(file, "{{\"kind\":\"hosted_").expect("torn event");
            json!({ "drainedLength": fixture.outbox.drain_outbox().len() })
        }
        "cli-event" => {
            fixture
                .outbox
                .raise_cli_event("hosted_token_revoked", Some("prn_a"), "revoked via CLI")
                .expect("raise cli event");
            let audit = read_jsonl::<HostedAuditRecord>(fixture.outbox.audit_path())
                .pop()
                .expect("audit record");
            json!({
                "audit": {
                    "event": audit.event,
                    "detail": audit.detail,
                    "principalId": audit.principal_id,
                    "label": audit.label,
                },
                "outboxKinds": fixture.outbox.drain_outbox().into_iter().map(|event| event.kind).collect::<Vec<_>>(),
            })
        }
        scenario => panic!("unknown hosted lockdown scenario: {scenario}"),
    }
}

struct SecurityFixture {
    root: PathBuf,
    lockdown: HostedLockdownStore,
    outbox: HostedOutboxStore,
}

impl SecurityFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-hosted-security-contract-{}-{}",
            std::process::id(),
            unix_millis(SystemTime::now())
        ));
        fs::create_dir_all(&root).expect("fixture root");
        let resolver = PathResolver::new(
            "/",
            &root,
            Some(root.join(".aimux").to_string_lossy().into_owned()),
        );
        Self {
            root,
            lockdown: HostedLockdownStore::with_resolver(resolver.clone()),
            outbox: HostedOutboxStore::with_resolver(resolver),
        }
    }

    fn event(&self, kind: &str) -> HostedEvent {
        HostedEvent {
            id: format!("evt_{kind}"),
            kind: kind.to_owned(),
            ts: "2026-01-01T00:00:00.000Z".to_owned(),
            principal_id: Some("prn_a".to_owned()),
            label: "cli".to_owned(),
            fingerprint: None,
            address_known: false,
            user_agent: None,
            detail: None,
        }
    }
}

impl Drop for SecurityFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        reset_hosted_lockdown_cache();
    }
}

fn lockdown_engage_clear(fixture: &SecurityFixture) -> Value {
    let initial = json!({
        "locked": fixture.lockdown.is_locked_down(1_000),
        "state": fixture.lockdown.lockdown_state(),
    });
    let engaged = fixture.lockdown.set_lockdown(true).expect("engage");
    let after_engage = json!({
        "locked": fixture.lockdown.is_locked_down(2_000),
        "state": fixture.lockdown.lockdown_state(),
    });
    let cleared = fixture.lockdown.set_lockdown(false).expect("clear");
    let after_clear = json!({
        "locked": fixture.lockdown.is_locked_down(3_000),
        "markerExists": fixture.lockdown.lockdown_path().exists(),
    });
    json!({
        "initial": initial,
        "engaged": normalize_lockdown_state(engaged),
        "afterEngage": normalize_lockdown_value(after_engage),
        "cleared": cleared,
        "afterClear": after_clear,
    })
}

fn normalize_lockdown_state(state: HostedLockdownState) -> Value {
    json!({
        "active": state.active,
        "since": state.since.map(|_| "<ts:1>"),
    })
}

fn normalize_lockdown_value(mut value: Value) -> Value {
    if let Some(state) = value.get_mut("state")
        && let Some(object) = state.as_object_mut()
        && object.get("since").and_then(Value::as_str).is_some()
    {
        object.insert("since".to_owned(), Value::String("<ts:1>".to_owned()));
    }
    value
}

#[cfg(unix)]
fn mode_for(path: &Path) -> u32 {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).expect("metadata").mode() & 0o777
}

#[cfg(not(unix))]
fn mode_for(_path: &Path) -> u32 {
    0
}

fn read_jsonl<T: for<'de> serde::Deserialize<'de>>(path: PathBuf) -> Vec<T> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
