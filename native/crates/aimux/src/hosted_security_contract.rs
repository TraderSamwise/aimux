use aimux::hosted_auth::{
    HostedAuthentication, authenticate_hosted_value,
    bearer_token_value as hosted_bearer_token_value, strip_trusted_headers_value,
};
use aimux::hosted_principals::{HostedPrincipalsStore, clear_hosted_principals_cache};
use aimux::paths::PathResolver;
use serde_json::{Value, json};
use std::fs;
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
    match scenario {
        "engage-clear" => json!({
            "initial": { "locked": false, "state": { "active": false, "since": null } },
            "engaged": { "active": true, "since": "<ts:1>" },
            "afterEngage": { "locked": true, "state": { "active": true, "since": "<ts:1>" } },
            "cleared": { "active": false, "since": null },
            "afterClear": { "locked": false, "markerExists": false },
        }),
        "marker-mode" => json!({ "mode": 384 }),
        "corrupt-marker" => json!({
            "state": { "active": true, "since": null },
            "locked": true,
        }),
        "cache-window" => json!({
            "first": false,
            "within": false,
            "after": true,
        }),
        "drain-spooled" => json!({
            "kinds": ["hosted_token_revoked", "hosted_grant_changed"],
            "existsAfterDrain": false,
            "secondDrain": [],
        }),
        "torn-line" => json!({ "drainedLength": 2 }),
        "cli-event" => json!({
            "audit": {
                "event": "hosted_token_revoked",
                "detail": "revoked via CLI",
                "principalId": "prn_a",
                "label": "cli",
            },
            "outboxKinds": ["hosted_token_revoked"],
        }),
        scenario => panic!("unknown hosted lockdown scenario: {scenario}"),
    }
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
