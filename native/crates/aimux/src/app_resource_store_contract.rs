use serde_json::{Map, Value, json};
use std::collections::HashMap;

const FIXED_NOW: i64 = 1_788_523_200_000;
const FIXED_ISO: &str = "2026-09-04T12:00:00.000Z";
const MAIN_CHECKOUT_KEY: &str = "__main_checkout__";

pub fn run_app_coordination_store_contract_case(input: &Value) -> Value {
    run_resource_case(
        input,
        ResourceOptions {
            clear_error_on_begin: false,
            settle: false,
            unread_count: false,
            request_checks: true,
        },
    )
}

pub fn run_app_desktop_state_store_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "groupByWorktree" => group_by_worktree(input.get("state").unwrap_or(&Value::Null)),
        "activeWorktreeBuckets" => json!(
            group_by_worktree(input.get("state").unwrap_or(&Value::Null))
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(filter_worktree_bucket_to_active_entries)
                .collect::<Vec<_>>()
        ),
        _ => run_resource_case(
            input,
            ResourceOptions {
                clear_error_on_begin: true,
                settle: false,
                unread_count: false,
                request_checks: false,
            },
        ),
    }
}

pub fn run_app_library_store_contract_case(input: &Value) -> Value {
    run_resource_case(
        input,
        ResourceOptions {
            clear_error_on_begin: false,
            settle: false,
            unread_count: false,
            request_checks: true,
        },
    )
}

pub fn run_app_notification_feed_store_contract_case(input: &Value) -> Value {
    run_resource_case(
        input,
        ResourceOptions {
            clear_error_on_begin: true,
            settle: false,
            unread_count: true,
            request_checks: false,
        },
    )
}

pub fn run_app_security_store_contract_case(input: &Value) -> Value {
    let mut events = Vec::<Value>::new();
    for action in array_field(input, "actions") {
        match str_field(action, "kind") {
            "add" => add_security_event(&mut events, action.get("event").unwrap_or(&Value::Null)),
            "markRead" => mark_security_events_read(&mut events),
            "clear" => events.clear(),
            kind => panic!("unknown security action: {kind}"),
        }
    }
    json!({
        "events": events,
        "unreadCount": events
            .iter()
            .filter(|event| event.get("readAt").is_none())
            .count(),
        "storage": {
            "aimux-security-events": events,
        },
    })
}

pub fn run_app_topology_store_contract_case(input: &Value) -> Value {
    run_resource_case(
        input,
        ResourceOptions {
            clear_error_on_begin: false,
            settle: true,
            unread_count: false,
            request_checks: true,
        },
    )
}

#[derive(Clone, Copy)]
struct ResourceOptions {
    clear_error_on_begin: bool,
    settle: bool,
    unread_count: bool,
    request_checks: bool,
}

#[derive(Clone)]
struct ResourceState {
    value: Value,
    error: Value,
    pending: bool,
    stale: bool,
    updated_at: Value,
}

impl Default for ResourceState {
    fn default() -> Self {
        Self {
            value: Value::Null,
            error: Value::Null,
            pending: false,
            stale: false,
            updated_at: Value::Null,
        }
    }
}

fn run_resource_case(input: &Value, options: ResourceOptions) -> Value {
    let mut state = ResourceState::default();
    for action in array_field(input, "actions") {
        match str_field(action, "kind") {
            "success" => {
                state.value = action.get("value").cloned().unwrap_or(Value::Null);
                state.error = Value::Null;
                state.pending = false;
                state.stale = false;
                state.updated_at = action
                    .get("updatedAt")
                    .cloned()
                    .unwrap_or_else(|| Value::from(FIXED_NOW));
            }
            "begin" => {
                if options.clear_error_on_begin {
                    state.error = Value::Null;
                }
                state.pending = true;
                state.stale = !state.value.is_null();
            }
            "failure" => {
                state.error = Value::from(str_field(action, "error"));
                state.pending = false;
                state.stale = !state.value.is_null();
            }
            "settle" if options.settle => {
                state.pending = false;
                state.stale = !state.value.is_null() && state.stale;
            }
            "clear" => state = ResourceState::default(),
            kind => panic!("unknown resource action: {kind}"),
        }
    }

    let mut output = Map::new();
    output.insert("resource".to_owned(), state.to_value());
    output.insert("value".to_owned(), state.value.clone());
    output.insert("error".to_owned(), state.error.clone());
    if options.unread_count {
        output.insert(
            "unreadCount".to_owned(),
            state
                .value
                .get("unreadCount")
                .cloned()
                .unwrap_or(Value::from(0)),
        );
    }
    if options.request_checks && input.get("requestChecks").is_some() {
        output.insert(
            "requestChecks".to_owned(),
            json!(
                array_field(input, "requestChecks")
                    .iter()
                    .map(|check| is_current_request(
                        check.get("request").unwrap_or(&Value::Null),
                        check.get("current").unwrap_or(&Value::Null)
                    ))
                    .collect::<Vec<_>>()
            ),
        );
    }
    Value::Object(output)
}

impl ResourceState {
    fn to_value(&self) -> Value {
        json!({
            "value": self.value,
            "error": self.error,
            "pending": self.pending,
            "stale": self.stale,
            "updatedAt": self.updated_at,
        })
    }
}

fn is_current_request(request: &Value, current: &Value) -> bool {
    request.get("projectPath") == current.get("projectPath")
        && request.get("endpointKey") == current.get("endpointKey")
        && request.get("generation") == current.get("generation")
}

fn group_by_worktree(state: &Value) -> Value {
    if let Some(groups) = state.get("worktreeGroups").and_then(Value::as_array) {
        return json!(
            groups
                .iter()
                .map(bucket_from_server_group)
                .collect::<Vec<_>>()
        );
    }

    let main_path = state.get("mainCheckoutPath").and_then(Value::as_str);
    let mut buckets = Vec::<Value>::new();
    let mut index_by_key = HashMap::<String, usize>::new();

    let main_bucket = build_bucket(
        MAIN_CHECKOUT_KEY,
        state
            .get("mainCheckoutInfo")
            .and_then(|info| info.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Main Checkout"),
        state
            .get("mainCheckoutInfo")
            .and_then(|info| info.get("branch"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
        Value::Null,
        true,
        None,
        None,
    );
    index_by_key.insert(MAIN_CHECKOUT_KEY.to_owned(), buckets.len());
    buckets.push(main_bucket);

    for worktree in array_field(state, "worktrees") {
        let path = str_field(worktree, "path");
        if main_path == Some(path) {
            continue;
        }
        let bucket = build_bucket(
            path,
            str_field(worktree, "name"),
            str_field(worktree, "branch"),
            Value::from(path),
            false,
            worktree.get("pending").and_then(Value::as_bool),
            worktree.get("removing").and_then(Value::as_bool),
        );
        index_by_key.insert(path.to_owned(), buckets.len());
        buckets.push(bucket);
    }

    for session in array_field(state, "sessions") {
        if is_dashboard_hidden_session(session) {
            continue;
        }
        let index = bucket_index_for(
            &mut buckets,
            &mut index_by_key,
            session.get("worktreePath").and_then(Value::as_str),
            main_path,
        );
        push_to_bucket_array(&mut buckets[index], "sessions", session.clone());
    }
    for service in array_field(state, "services") {
        let index = bucket_index_for(
            &mut buckets,
            &mut index_by_key,
            service.get("worktreePath").and_then(Value::as_str),
            main_path,
        );
        push_to_bucket_array(&mut buckets[index], "services", service.clone());
    }

    json!(buckets)
}

fn bucket_from_server_group(group: &Value) -> Value {
    let path = group.get("path").and_then(Value::as_str);
    let mut bucket = build_bucket(
        path.unwrap_or(MAIN_CHECKOUT_KEY),
        str_field(group, "name"),
        str_field(group, "branch"),
        path.map(Value::from).unwrap_or(Value::Null),
        path.is_none(),
        group.get("pending").and_then(Value::as_bool),
        group.get("removing").and_then(Value::as_bool),
    );
    bucket["sessions"] = json!(
        array_field(group, "sessions")
            .iter()
            .filter(|session| !is_dashboard_hidden_session(session))
            .cloned()
            .collect::<Vec<_>>()
    );
    bucket["services"] = group.get("services").cloned().unwrap_or_else(|| json!([]));
    bucket
}

fn build_bucket(
    key: &str,
    name: &str,
    branch: &str,
    path: Value,
    is_main_checkout: bool,
    pending: Option<bool>,
    removing: Option<bool>,
) -> Value {
    let mut object = Map::new();
    object.insert("key".to_owned(), Value::from(key));
    object.insert("name".to_owned(), Value::from(name));
    object.insert("branch".to_owned(), Value::from(branch));
    object.insert("path".to_owned(), path);
    object.insert("isMainCheckout".to_owned(), Value::from(is_main_checkout));
    if let Some(pending) = pending {
        object.insert("pending".to_owned(), Value::from(pending));
    }
    if let Some(removing) = removing {
        object.insert("removing".to_owned(), Value::from(removing));
    }
    object.insert("sessions".to_owned(), json!([]));
    object.insert("services".to_owned(), json!([]));
    Value::Object(object)
}

fn bucket_index_for(
    buckets: &mut Vec<Value>,
    index_by_key: &mut HashMap<String, usize>,
    worktree_path: Option<&str>,
    main_path: Option<&str>,
) -> usize {
    let Some(path) = worktree_path else {
        return 0;
    };
    if main_path == Some(path) {
        return 0;
    }
    if let Some(index) = index_by_key.get(path) {
        return *index;
    }
    let fallback_name = path
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(path);
    let bucket = build_bucket(
        path,
        fallback_name,
        "",
        Value::from(path),
        false,
        None,
        None,
    );
    index_by_key.insert(path.to_owned(), buckets.len());
    buckets.push(bucket);
    buckets.len() - 1
}

fn push_to_bucket_array(bucket: &mut Value, field: &str, value: Value) {
    if let Some(array) = bucket.get_mut(field).and_then(Value::as_array_mut) {
        array.push(value);
    }
}

fn filter_worktree_bucket_to_active_entries(bucket: &Value) -> Option<Value> {
    let sessions = array_field(bucket, "sessions")
        .iter()
        .filter(|session| !is_desktop_session_offline(session))
        .cloned()
        .collect::<Vec<_>>();
    let services = array_field(bucket, "services")
        .iter()
        .filter(|service| !is_desktop_service_offline(service))
        .cloned()
        .collect::<Vec<_>>();
    let keep_operational = bool_field(bucket, "pending").unwrap_or(false)
        || bool_field(bucket, "removing").unwrap_or(false);
    if sessions.is_empty() && services.is_empty() && !keep_operational {
        return None;
    }
    let mut next = bucket.as_object().cloned().unwrap_or_default();
    next.insert("sessions".to_owned(), json!(sessions));
    next.insert("services".to_owned(), json!(services));
    Some(Value::Object(next))
}

fn is_desktop_session_offline(session: &Value) -> bool {
    if session.get("pendingAction").is_some() {
        return false;
    }
    matches!(str_field(session, "status"), "offline" | "exited")
}

fn is_desktop_service_offline(service: &Value) -> bool {
    if service.get("pendingAction").is_some() {
        return false;
    }
    matches!(str_field(service, "status"), "offline" | "exited")
}

fn is_dashboard_hidden_session(session: &Value) -> bool {
    bool_field(session, "overseer") == Some(true)
        || bool_field(session, "scribe") == Some(true)
        || session
            .get("team")
            .and_then(|team| team.get("role"))
            .and_then(Value::as_str)
            == Some("overseer")
        || (bool_field(session, "scribe") != Some(false)
            && session
                .get("team")
                .and_then(|team| team.get("role"))
                .and_then(Value::as_str)
                == Some("scribe"))
}

fn add_security_event(events: &mut Vec<Value>, event: &Value) {
    let id = str_field(event, "id");
    let previous = events
        .iter()
        .find(|candidate| str_field(candidate, "id") == id)
        .cloned();
    let mut next = event.as_object().cloned().unwrap_or_default();
    next.insert(
        "receivedAt".to_owned(),
        previous
            .as_ref()
            .and_then(|value| value.get("receivedAt"))
            .cloned()
            .unwrap_or_else(|| Value::from(FIXED_ISO)),
    );
    if let Some(read_at) = previous
        .as_ref()
        .and_then(|value| value.get("readAt"))
        .cloned()
    {
        next.insert("readAt".to_owned(), read_at);
    }
    events.retain(|candidate| str_field(candidate, "id") != id);
    events.insert(0, Value::Object(next));
    events.truncate(100);
}

fn mark_security_events_read(events: &mut [Value]) {
    for event in events {
        if event.get("readAt").is_none()
            && let Some(object) = event.as_object_mut()
        {
            object.insert("readAt".to_owned(), Value::from(FIXED_ISO));
        }
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

fn bool_field(value: &Value, field: &str) -> Option<bool> {
    value.get(field).and_then(Value::as_bool)
}
