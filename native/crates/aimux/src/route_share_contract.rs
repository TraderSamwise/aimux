use serde_json::{Value, json};

pub fn run_route_share_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "resolveRouteShare" => resolve_route_share(input.get("value").unwrap_or(&Value::Null)),
        "sharedChatHref" => shared_chat_href(input.get("share").unwrap_or(&Value::Null)),
        _ => panic!("unknown route share contract api: {api}"),
    }
}

fn resolve_route_share(input: &Value) -> Value {
    let pathname = str_field(input, "pathname");
    let is_share_route = input
        .get("isShareRoute")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| pathname == "/shares" || pathname.starts_with("/shares/"));
    let accepted_shares = array_field(input, "acceptedShares");
    let legacy_active_share = input.get("legacyActiveShare").unwrap_or(&Value::Null);
    let owner_user_id = str_field(input, "ownerUserId");
    let share_id = str_field(input, "shareId");
    let session_id = str_field(input, "sessionId");
    let route_project_path = str_field(input, "routeProjectPath");
    let current_user_id = str_field(input, "currentUserId");

    if is_share_route && !owner_user_id.is_empty() && !share_id.is_empty() {
        return find_matching_share(accepted_shares, owner_user_id, share_id, session_id)
            .or_else(|| {
                if legacy_active_share.is_null() {
                    None
                } else {
                    find_matching_share(
                        std::slice::from_ref(legacy_active_share),
                        owner_user_id,
                        share_id,
                        session_id,
                    )
                }
            })
            .cloned()
            .unwrap_or(Value::Null);
    }

    if is_share_route || !is_shared_legacy_candidate_path(pathname) || current_user_id.is_empty() {
        return Value::Null;
    }

    if let Some(legacy_match) =
        find_legacy_path_share(legacy_active_share, session_id, route_project_path)
    {
        if str_field(legacy_match, "ownerUserId") != current_user_id {
            return legacy_match.clone();
        }
    }

    accepted_shares
        .iter()
        .find(|share| {
            str_field(share, "ownerUserId") != current_user_id
                && (session_id.is_empty() || str_field(share, "sessionId") == session_id)
                && (route_project_path.is_empty()
                    || str_field(share, "projectRoot") == route_project_path)
        })
        .cloned()
        .unwrap_or(Value::Null)
}

fn shared_chat_href(share: &Value) -> Value {
    json!({
        "pathname": "/shares/[ownerUserId]/[shareId]/agent/[sessionId]/chat",
        "params": {
            "ownerUserId": str_field(share, "ownerUserId"),
            "shareId": str_field(share, "shareId"),
            "sessionId": str_field(share, "sessionId"),
        },
    })
}

fn find_matching_share<'a>(
    shares: &'a [Value],
    owner_user_id: &str,
    share_id: &str,
    session_id: &str,
) -> Option<&'a Value> {
    shares.iter().find(|share| {
        str_field(share, "ownerUserId") == owner_user_id
            && str_field(share, "shareId") == share_id
            && (session_id.is_empty() || str_field(share, "sessionId") == session_id)
    })
}

fn find_legacy_path_share<'a>(
    share: &'a Value,
    session_id: &str,
    route_project_path: &str,
) -> Option<&'a Value> {
    if share.is_null() {
        return None;
    }
    if !session_id.is_empty() && str_field(share, "sessionId") != session_id {
        return None;
    }
    if !route_project_path.is_empty() && str_field(share, "projectRoot") != route_project_path {
        return None;
    }
    if !session_id.is_empty() || !route_project_path.is_empty() {
        Some(share)
    } else {
        None
    }
}

fn is_shared_legacy_candidate_path(pathname: &str) -> bool {
    pathname == "/"
        || pathname.starts_with("/agent/")
        || pathname == "/project"
        || pathname.starts_with("/coordination")
        || pathname.starts_with("/topology")
        || pathname.starts_with("/library")
        || pathname.starts_with("/notifications")
        || pathname.starts_with("/threads")
        || pathname.starts_with("/expose")
        || pathname.starts_with("/loop")
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
