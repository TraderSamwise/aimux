use aimux::daemon::routing::DaemonRouteUrl;
use aimux::remote_access::{
    RemoteAccessContext, RemoteAccessDecision, RemoteActor, RemoteActorRole, RemoteOperatorGrant,
    RemoteOperatorPrincipal, assert_operator_stream_allowed, assert_remote_access_allowed,
    parse_remote_actor,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/remote-access/access.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn remote_access_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("remote access fixture parses");
    assert_eq!(contract.cases.len(), 18);
    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = Value::Array(
            case.input
                .get("checks")
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("{} has checks array", case.id))
                .iter()
                .map(run_check)
                .collect(),
        );
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "remote access parity failures:\n{}",
        failures.join("\n\n")
    );
}

fn run_check(check: &Value) -> Value {
    if str_field(check, "mode") == "parseActor" {
        let headers = check
            .get("headers")
            .and_then(Value::as_object)
            .map(headers_from_json)
            .unwrap_or_default();
        return actor_to_json(parse_remote_actor(&headers));
    }

    let method = str_field(check, "method");
    if has_unknown_actor_role(check) {
        return decision_to_json(RemoteAccessDecision::deny(
            403,
            "remote actor role is not allowed",
        ));
    }
    let full_path = format!(
        "{}{}",
        ts_url_pathname(str_field(check, "path")),
        str_field(check, "query")
    );
    let route_url = DaemonRouteUrl::parse(&full_path);
    let actor = check.get("actor").and_then(actor_from_json);
    let project_root = match check.get("projectRoot") {
        Some(Value::String(value)) => Some(value.as_str()),
        _ => None,
    };
    let body = check.get("body");
    let context = RemoteAccessContext { body, project_root };
    let decision = if str_field(check, "mode") == "stream" {
        assert_operator_stream_allowed(
            actor.as_ref(),
            method,
            route_url.pathname(),
            &route_url,
            context,
        )
    } else {
        assert_remote_access_allowed(
            actor.as_ref(),
            method,
            route_url.pathname(),
            &route_url,
            context,
        )
    };
    decision_to_json(decision)
}

fn decision_to_json(decision: RemoteAccessDecision) -> Value {
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(decision.ok));
    if let Some(status) = decision.status {
        object.insert("status".into(), json!(status));
    }
    if let Some(error) = decision.error {
        object.insert("error".into(), Value::String(error));
    }
    Value::Object(object)
}

fn actor_to_json(actor: Option<RemoteActor>) -> Value {
    let Some(actor) = actor else {
        return Value::Null;
    };
    let mut object = Map::new();
    object.insert(
        "role".into(),
        Value::String(
            match actor.role {
                RemoteActorRole::Owner => "owner",
                RemoteActorRole::Guest => "guest",
                RemoteActorRole::Operator => "operator",
            }
            .into(),
        ),
    );
    insert_optional(&mut object, "userId", actor.user_id);
    insert_optional(&mut object, "displayName", actor.display_name);
    insert_optional(&mut object, "email", actor.email);
    insert_optional(&mut object, "shareId", actor.share_id);
    insert_optional(&mut object, "shareSessionId", actor.share_session_id);
    Value::Object(object)
}

fn actor_from_json(value: &Value) -> Option<RemoteActor> {
    if value.is_null() {
        return None;
    }
    let role = match str_field(value, "role") {
        "owner" => RemoteActorRole::Owner,
        "operator" => RemoteActorRole::Operator,
        _ => RemoteActorRole::Guest,
    };
    Some(RemoteActor {
        role,
        user_id: string_field(value, "userId"),
        display_name: string_field(value, "displayName"),
        email: string_field(value, "email"),
        share_id: string_field(value, "shareId"),
        share_session_id: string_field(value, "shareSessionId"),
        principal: value.get("principal").and_then(principal_from_json),
    })
}

fn has_unknown_actor_role(check: &Value) -> bool {
    check
        .get("actor")
        .and_then(|actor| actor.get("role"))
        .and_then(Value::as_str)
        .is_some_and(|role| !matches!(role, "owner" | "operator" | "guest"))
}

fn ts_url_pathname(path: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    for (index, segment) in path.split('/').enumerate() {
        let lower = segment.to_ascii_lowercase();
        match (index, lower.as_str()) {
            (0, "") | (_, ".") | (_, "%2e") => {}
            (_, "..") | (_, "%2e%2e") => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    format!("/{}", segments.join("/"))
}

fn principal_from_json(value: &Value) -> Option<RemoteOperatorPrincipal> {
    if value.is_null() {
        return None;
    }
    Some(RemoteOperatorPrincipal {
        id: str_field(value, "id").into(),
        label: str_field(value, "label").into(),
        role: str_field(value, "role").into(),
        grants: value
            .get("grants")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|grant| RemoteOperatorGrant {
                project_root: str_field(grant, "projectRoot").into(),
                session_id: str_field(grant, "sessionId").into(),
            })
            .collect(),
        revoked_at: string_field(value, "revokedAt"),
    })
}

fn headers_from_json(object: &Map<String, Value>) -> BTreeMap<String, String> {
    object
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect()
}

fn insert_optional(object: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        object.insert(key.into(), Value::String(value));
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
