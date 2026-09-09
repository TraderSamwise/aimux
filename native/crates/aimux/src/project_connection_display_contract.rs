use serde_json::{Value, json};

pub fn run_project_connection_display_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "formatProjectEndpointLabel" => json!(format_project_endpoint_label(
            input.get("endpoint"),
            input
                .get("connectionMode")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "getProjectServiceEndpoint" => get_project_service_endpoint(input.get("project")),
        "projectStateErrorCopy" => json!(project_state_error_copy(
            input
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "isRelayUnavailableForProjectDiscovery" => {
            json!(is_relay_unavailable_for_project_discovery(
                input
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ))
        }
        "relayUnavailableProjectCopy" => json!(relay_unavailable_project_copy(
            input
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "isDevicePendingApprovalError" => json!(is_device_pending_approval_error(
            input
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "isProjectHostOfflineError" => json!(is_project_host_offline_error(
            input
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        _ => panic!("unknown project connection display contract api: {api}"),
    }
}

fn format_project_endpoint_label(endpoint: Option<&Value>, connection_mode: &str) -> String {
    let Some(endpoint) = endpoint.filter(|endpoint| !endpoint.is_null()) else {
        return "host offline".to_owned();
    };
    if connection_mode == "relay" {
        return "via relay".to_owned();
    }
    format!(
        "{}:{}",
        endpoint
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        endpoint
            .get("port")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    )
}

fn get_project_service_endpoint(project: Option<&Value>) -> Value {
    let Some(project) = project else {
        return Value::Null;
    };
    if !project
        .get("serviceAlive")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Value::Null;
    }
    project
        .get("serviceEndpoint")
        .cloned()
        .unwrap_or(Value::Null)
}

fn project_state_error_copy(error: &str) -> Value {
    if is_project_host_offline_error(error) {
        return json!({
            "title": "Project host not running.",
            "detail": "Start the host to see worktrees, agents, and services for this project.",
        });
    }
    if is_device_pending_approval_error(error) {
        let approval_code = pending_approval_code(error);
        return json!({
            "title": "Remote client pending approval.",
            "detail": approval_code
                .map(|code| format!("Run `aimux security device approve`, match code {code}, then refresh project state."))
                .unwrap_or_else(|| "Run `aimux security device approve`, match the code, then refresh project state.".to_owned()),
        });
    }
    if error.to_ascii_lowercase().contains("relay not connected") {
        return json!({
            "title": "Remote unavailable.",
            "detail": "Aimux could not reach the remote control plane. Try again after it reconnects.",
        });
    }
    json!({
        "title": "Could not load project state.",
        "detail": error,
    })
}

fn is_device_pending_approval_error(error: &str) -> bool {
    error
        .to_ascii_lowercase()
        .contains("pending security approval")
}

fn is_project_host_offline_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    [
        "econnrefused",
        "failed to fetch",
        "network request failed",
        "load failed",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn is_relay_unavailable_for_project_discovery(status: &str) -> bool {
    matches!(
        status,
        "device_pending" | "daemon_offline" | "relay_unavailable" | "auth_failed"
    )
}

fn relay_unavailable_project_copy(status: &str) -> Value {
    match status {
        "device_pending" => json!({
            "title": "Remote approval required.",
            "detail": "Run `aimux security device approve`, match the code, then refresh.",
        }),
        "daemon_offline" => json!({
            "title": "Host offline.",
            "detail": "Start the Aimux host to see projects and sessions.",
        }),
        "auth_failed" => json!({
            "title": "Remote access blocked.",
            "detail": "Open Inbox and approve this device, then refresh.",
        }),
        _ => json!({
            "title": "Remote unavailable.",
            "detail": "Aimux could not reach the remote control plane. Try again after it reconnects.",
        }),
    }
}

fn pending_approval_code(error: &str) -> Option<String> {
    let words: Vec<&str> = error
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '-'))
        .filter(|word| !word.is_empty())
        .collect();
    words
        .windows(2)
        .find(|window| window[0].eq_ignore_ascii_case("code") && is_valid_approval_code(window[1]))
        .map(|window| window[1].to_ascii_uppercase())
}

fn is_valid_approval_code(value: &str) -> bool {
    let mut parts = value.split('-');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(first), Some(second), None)
            if valid_approval_code_part(first) && valid_approval_code_part(second)
    )
}

fn valid_approval_code_part(value: &str) -> bool {
    value.len() == 3
        && value.chars().all(|ch| {
            matches!(
                ch.to_ascii_uppercase(),
                '2'..='9' | 'A'..='H' | 'J'..='N' | 'P'..='Z'
            )
        })
}
