use serde_json::{Value, json};
use std::collections::HashMap;

pub fn run_app_state_helpers_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "paneOutputSnapshotHasVisibleTranscript" => json!(
            pane_output_snapshot_has_visible_transcript(input.get("value").unwrap_or(&Value::Null))
        ),
        "shouldForceNativePinnedChatOffset" => json!(
            bool_field(input.get("value").unwrap_or(&Value::Null), "pinnedToEnd")
                && !bool_field(
                    input.get("value").unwrap_or(&Value::Null),
                    "keyboardVisible"
                )
        ),
        "shouldHydrateTerminalOutput" => json!(
            bool_field(
                input.get("value").unwrap_or(&Value::Null),
                "terminalViewVisible"
            ) && bool_field(
                input.get("value").unwrap_or(&Value::Null),
                "outputAvailable"
            )
        ),
        "agentOutputModeForVisiblePane" => {
            if bool_field(
                input.get("value").unwrap_or(&Value::Null),
                "terminalViewVisible",
            ) {
                json!("full")
            } else {
                json!("chat")
            }
        }
        "activeSessionsFromShareSummaries" => {
            active_sessions_from_share_summaries(array_field(input, "shares"))
        }
        "sharedSessionsEqual" => json!(shared_sessions_equal(
            array_field(input, "left"),
            array_field(input, "right")
        )),
        "mergeActiveSharedSessions" => merge_active_shared_sessions(
            array_field(input, "shares"),
            input.get("activeShare").unwrap_or(&Value::Null),
        ),
        "shouldApplySharedSessionHydrate" => json!(should_apply_shared_session_hydrate(input)),
        _ => panic!("unknown app state helpers contract api: {api}"),
    }
}

fn pane_output_snapshot_has_visible_transcript(value: &Value) -> bool {
    value
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| !messages.is_empty())
        || value
            .get("output")
            .and_then(Value::as_str)
            .is_some_and(|output| !output.is_empty())
        || value
            .get("outputAnsi")
            .and_then(Value::as_str)
            .is_some_and(|output| !output.is_empty())
        || bool_field(value, "outputAvailable")
}

fn active_sessions_from_share_summaries(shares: &[Value]) -> Value {
    json!(
        shares
            .iter()
            .filter(|share| share.get("serviceEndpoint").is_some())
            .map(|share| {
                json!({
                    "shareId": str_field(share, "id"),
                    "ownerUserId": str_field(share, "ownerUserId"),
                    "projectRoot": str_field(share, "projectRoot"),
                    "sessionId": str_field(share, "sessionId"),
                    "serviceEndpoint": share["serviceEndpoint"].clone(),
                    "acceptedAt": share
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| str_field(share, "createdAt")),
                })
            })
            .collect::<Vec<_>>()
    )
}

fn shared_sessions_equal(left: &[Value], right: &[Value]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(left, right)| {
            str_field(left, "shareId") == str_field(right, "shareId")
                && str_field(left, "ownerUserId") == str_field(right, "ownerUserId")
                && str_field(left, "projectRoot") == str_field(right, "projectRoot")
                && str_field(left, "sessionId") == str_field(right, "sessionId")
                && str_field(left, "acceptedAt") == str_field(right, "acceptedAt")
                && str_field(&left["serviceEndpoint"], "host")
                    == str_field(&right["serviceEndpoint"], "host")
                && number_field(&left["serviceEndpoint"], "port")
                    == number_field(&right["serviceEndpoint"], "port")
        })
}

fn merge_active_shared_sessions(shares: &[Value], active_share: &Value) -> Value {
    if active_share.is_null() {
        return json!(shares);
    }
    let mut by_key = HashMap::<String, Value>::new();
    let mut order = Vec::<String>::new();
    for share in shares {
        let key = shared_session_key(share);
        if !by_key.contains_key(&key) {
            order.push(key.clone());
        }
        by_key.insert(key, share.clone());
    }
    let active_key = shared_session_key(active_share);
    if !by_key.contains_key(&active_key) {
        order.push(active_key.clone());
    }
    by_key.insert(active_key, active_share.clone());
    let mut merged = order
        .into_iter()
        .filter_map(|key| by_key.remove(&key))
        .collect::<Vec<_>>();
    merged.sort_by(|left, right| str_field(right, "acceptedAt").cmp(str_field(left, "acceptedAt")));
    json!(merged)
}

fn should_apply_shared_session_hydrate(input: &Value) -> bool {
    let preserve_empty_once = input
        .get("options")
        .and_then(|options| options.get("preserveEmptyOnce"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    !(preserve_empty_once
        && array_field(input, "next").is_empty()
        && !array_field(input, "current").is_empty())
}

fn shared_session_key(share: &Value) -> String {
    format!(
        "{}:{}",
        str_field(share, "ownerUserId"),
        str_field(share, "shareId")
    )
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

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}
