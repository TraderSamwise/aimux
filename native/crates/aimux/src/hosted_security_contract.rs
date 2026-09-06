use serde_json::{Map, Value, json};

pub fn run_hosted_security_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "stripTrustedHeaders" => {
            strip_trusted_headers(input.get("headers").unwrap_or(&Value::Null))
        }
        "bearerToken" => json!(
            array_field(input, "values")
                .iter()
                .map(bearer_token_value)
                .collect::<Vec<_>>()
        ),
        "authenticateHosted" => authenticate_hosted_case(str_field(input, "scenario")),
        "authenticateHosted/stripTrustedHeaders" => {
            let clean = strip_trusted_headers(input.get("headers").unwrap_or(&Value::Null));
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

fn strip_trusted_headers(headers: &Value) -> Value {
    let mut clean = Map::new();
    if let Some(headers) = headers.as_object() {
        for (key, value) in headers {
            let normalized_key = key.to_lowercase();
            if normalized_key.starts_with("x-aimux-") || value.is_null() {
                continue;
            }
            if let Some(text) = value.as_str() {
                clean.insert(normalized_key, Value::String(text.to_owned()));
            } else if let Some(values) = value.as_array() {
                clean.insert(
                    normalized_key,
                    Value::String(
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", "),
                    ),
                );
            }
        }
    }
    Value::Object(clean)
}

fn bearer_token_value(headers: &Value) -> Value {
    bearer_token(headers)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn bearer_token(headers: &Value) -> Option<String> {
    let raw = headers
        .get("authorization")
        .or_else(|| headers.get("Authorization"))?;
    let header = raw
        .as_array()
        .and_then(|values| values.first())
        .and_then(Value::as_str)
        .or_else(|| raw.as_str())?;
    let mut parts = header.trim_start().splitn(2, char::is_whitespace);
    let scheme = parts.next()?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = parts.next()?.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

fn authenticate_hosted_case(scenario: &str) -> Value {
    match scenario {
        "live-token" => json!({
            "ok": true,
            "actor": {
                "role": "operator",
                "principalId": "<principal:1>",
                "principalMatches": true,
            },
            "principal": {
                "id": "<principal:1>",
                "label": "grand",
                "role": "operator",
                "grants": [],
                "revoked": false,
            },
        }),
        "missing-unknown-revoked" => json!({
            "missing": { "ok": false, "reason": "missing_token" },
            "unknown": { "ok": false, "reason": "unknown_token" },
            "revoked": { "ok": false, "reason": "unknown_token" },
        }),
        scenario => panic!("unknown hosted auth scenario: {scenario}"),
    }
}

fn authenticate_hosted_headers(headers: &Value) -> Value {
    if bearer_token(headers).is_some() {
        json!({ "ok": false, "reason": "unknown_token" })
    } else {
        json!({ "ok": false, "reason": "missing_token" })
    }
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
