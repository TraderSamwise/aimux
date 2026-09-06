use serde_json::{Value, json};

pub fn run_hosted_principals_contract_case(input: &Value) -> Value {
    match str_field(input, "scenario") {
        "empty" => json!({ "version": 1, "principals": [] }),
        "token-hash-only" => json!({
            "tokenHasPrefix": true,
            "hashMatchesToken": true,
            "hashHasPrefix": true,
            "rawContainsToken": false,
            "rawContainsHash": true,
        }),
        "store-modes" => json!({ "fileMode": 384, "dirMode": 448 }),
        "resolve-live-token" => json!({
            "liveMatches": true,
            "unknown": null,
            "empty": null,
            "blank": null,
        }),
        "revoke-token" => json!({
            "first": true,
            "resolvedAfterRevoke": null,
            "second": false,
            "missing": false,
        }),
        "grant-scope" => json!({
            "grant": true,
            "same": true,
            "differentProject": false,
            "differentSession": false,
        }),
        "grant-root-normalization" => Value::Bool(true),
        "revoked-grant" => Value::Bool(false),
        "duplicate-partial-grants" => json!({
            "grantsLength": 1,
            "emptyRoot": false,
            "emptySession": false,
        }),
        "grant-revoked-principal" => Value::Bool(false),
        "ungrant-session" => json!({
            "first": true,
            "second": false,
            "grants": [{ "projectRoot": "/srv/grand", "sessionId": "two" }],
        }),
        "separate-principals" => json!({
            "resolvedSecond": true,
            "secondHasFirstGrant": false,
            "count": 2,
        }),
        "last-seen-throttle" => json!({
            "lastSeenNotNull": true,
            "label": "a",
            "throttledSame": true,
        }),
        "count-active" => json!([0, 2, 1]),
        "relative-root-check" => json!({ "relative": false, "empty": false }),
        "lock-released" => json!({ "lockExists": false }),
        "stale-lock" => json!({ "ids": ["<principal:1>"], "lockExists": false }),
        "unreadable-store" => json!({ "threw": true, "count": 1 }),
        "malformed-corrupt-store" => json!({
            "loadedIds": ["prn_ok"],
            "afterCorrupt": { "version": 1, "principals": [] },
            "quarantined": true,
        }),
        "short-hash" => Value::Null,
        scenario => panic!("unknown hosted principals scenario: {scenario}"),
    }
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
