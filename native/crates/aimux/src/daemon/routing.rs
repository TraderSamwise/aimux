use crate::daemon::http::DaemonResponseBody;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonRouteResponse {
    pub status: u16,
    pub body: DaemonResponseBody,
    pub content_type: Option<String>,
}

impl DaemonRouteResponse {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body: DaemonResponseBody::Json(body),
            content_type: None,
        }
    }

    pub fn text(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            body: DaemonResponseBody::Text(body.into()),
            content_type: Some("text/plain; charset=utf-8".to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonRouteUrl {
    path: String,
    search: String,
    query: BTreeMap<String, Vec<String>>,
}

impl DaemonRouteUrl {
    pub fn parse(path: &str) -> Self {
        let (pathname, query) = path.split_once('?').unwrap_or((path, ""));
        let mut params: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for pair in query.split('&').filter(|pair| !pair.is_empty()) {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            params
                .entry(percent_decode_lossy(key))
                .or_default()
                .push(percent_decode_lossy(value));
        }
        Self {
            path: pathname.to_owned(),
            search: if query.is_empty() {
                String::new()
            } else {
                format!("?{query}")
            },
            query: params,
        }
    }

    pub fn pathname(&self) -> &str {
        &self.path
    }

    pub fn search(&self) -> &str {
        &self.search
    }

    pub fn search_param(&self, name: &str) -> Option<&str> {
        self.query
            .get(name)
            .and_then(|values| values.first())
            .map(String::as_str)
    }

    pub fn search_params(&self, name: &str) -> Vec<&str> {
        self.query
            .get(name)
            .map(|values| values.iter().map(String::as_str).collect())
            .unwrap_or_default()
    }

    pub fn has_search_param(&self, name: &str) -> bool {
        self.query.contains_key(name)
    }
}

pub fn text_or_json_lines(
    route_url: &DaemonRouteUrl,
    json_body: Value,
    lines: &[String],
) -> DaemonRouteResponse {
    if route_url.search_param("json") == Some("1") {
        let mut body = serde_json::to_string_pretty(&json_body).expect("route JSON must serialize");
        body.push('\n');
        return DaemonRouteResponse::text(200, body);
    }
    DaemonRouteResponse::text(200, format!("{}\n", lines.join("\n")))
}

pub fn text_error(status: u16, message: impl AsRef<str>) -> DaemonRouteResponse {
    DaemonRouteResponse::text(status, format!("{}\n", message.as_ref()))
}

pub fn string_param(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    name: &str,
) -> Option<String> {
    body.and_then(|body| body.get(name))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| route_url.search_param(name).map(str::to_owned))
}

pub fn required_param(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    name: &str,
) -> Result<String, DaemonRouteResponse> {
    let value = string_param(route_url, body, name);
    match value {
        Some(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(text_error(400, format!("{name} is required"))),
    }
}

pub fn boolean_param(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    name: &str,
    default_value: bool,
) -> bool {
    if let Some(value) = body.and_then(|body| body.get(name)) {
        if let Some(value) = value.as_bool() {
            return value;
        }
        if let Some(value) = value.as_i64() {
            return value != 0;
        }
    }
    let Some(value) = string_param(route_url, body, name) else {
        return default_value;
    };
    value != "0" && value != "false"
}

pub fn integer_param(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    name: &str,
    default_value: i64,
    flag_name: Option<&str>,
) -> Result<i64, DaemonRouteResponse> {
    let Some(raw) = string_param(route_url, body, name) else {
        return Ok(default_value);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(default_value);
    }
    let flag_name = flag_name.unwrap_or(name);
    if !is_integer_text(trimmed) {
        return Err(text_error(
            400,
            format!("Error: --{flag_name} must be an integer"),
        ));
    }
    let value = trimmed
        .parse::<i64>()
        .map_err(|_| text_error(400, format!("Error: --{flag_name} must be a safe integer")))?;
    if value.unsigned_abs() > 9_007_199_254_740_991 {
        return Err(text_error(
            400,
            format!("Error: --{flag_name} must be a safe integer"),
        ));
    }
    Ok(value)
}

pub fn csv_param(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    name: &str,
) -> Option<Vec<String>> {
    let value = string_param(route_url, body, name)?;
    Some(
        value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

pub fn notification_ids_param(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Result<Option<Vec<String>>, DaemonRouteResponse> {
    if let Some(body) = body
        && let Some(value) = body.get("ids")
    {
        if let Some(values) = value.as_array()
            && values.iter().all(Value::is_string)
        {
            return Ok(Some(
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect(),
            ));
        }
        if let Some(value) = value.as_str() {
            return Ok(Some(split_csv(value)));
        }
        return Err(text_error(400, "ids must be an array of strings"));
    }
    let values = route_url.search_params("ids");
    if values.is_empty() {
        return Ok(None);
    }
    Ok(Some(values.into_iter().flat_map(split_csv).collect()))
}

pub fn notification_mutation_payload(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Result<Value, DaemonRouteResponse> {
    let mut payload = serde_json::Map::new();
    if let Some(id) = string_param(route_url, body, "id").map(|value| value.trim().to_owned())
        && !id.is_empty()
    {
        payload.insert("id".to_owned(), Value::String(id));
    }
    if let Some(ids) = notification_ids_param(route_url, body)? {
        payload.insert("ids".to_owned(), json!(ids));
    }
    if let Some(session_id) =
        string_param(route_url, body, "sessionId").map(|value| value.trim().to_owned())
        && !session_id.is_empty()
    {
        payload.insert("sessionId".to_owned(), Value::String(session_id));
    }
    Ok(Value::Object(payload))
}

pub fn local_cli_text_routes() -> &'static [&'static str] {
    LOCAL_CLI_TEXT_ROUTES
}

pub fn local_auth_routes() -> &'static [&'static str] {
    LOCAL_AUTH_ROUTES
}

const LOCAL_AUTH_ROUTES: &[&str] = &[
    crate::core_command_contract::CORE_API_ROUTES.login_start_text,
    crate::core_command_contract::CORE_API_ROUTES.login_wait_text,
    crate::core_command_contract::CORE_API_ROUTES.login_text,
    crate::core_command_contract::CORE_API_ROUTES.security_unlock_start_text,
    crate::core_command_contract::CORE_API_ROUTES.security_unlock_wait_text,
    crate::core_command_contract::CORE_API_ROUTES.security_unlock_text,
];

const LOCAL_CLI_TEXT_ROUTES: &[&str] = &[
    crate::core_command_contract::CORE_API_ROUTES.doctor_disk_text,
    crate::core_command_contract::CORE_API_ROUTES.doctor_exchange_text,
    crate::core_command_contract::CORE_API_ROUTES.doctor_lifecycle_text,
    crate::core_command_contract::CORE_API_ROUTES.doctor_tmux_text,
    crate::core_command_contract::CORE_API_ROUTES.doctor_versions_text,
    crate::core_command_contract::CORE_API_ROUTES.graveyard_cleanup_text,
    crate::core_command_contract::CORE_API_ROUTES.graveyard_list_text,
    crate::core_command_contract::CORE_API_ROUTES.graveyard_resurrect_text,
    crate::core_command_contract::CORE_API_ROUTES.graveyard_send_text,
    crate::core_command_contract::CORE_API_ROUTES.handoff_accept_text,
    crate::core_command_contract::CORE_API_ROUTES.handoff_complete_text,
    crate::core_command_contract::CORE_API_ROUTES.handoff_send_text,
    crate::core_command_contract::CORE_API_ROUTES.agent_input_text,
    crate::core_command_contract::CORE_API_ROUTES.agent_migrate_text,
    crate::core_command_contract::CORE_API_ROUTES.agent_ps_text,
    crate::core_command_contract::CORE_API_ROUTES.agent_rename_text,
    crate::core_command_contract::CORE_API_ROUTES.attachment_publish_text,
    crate::core_command_contract::CORE_API_ROUTES.host_agent_read_text,
    crate::core_command_contract::CORE_API_ROUTES.host_agent_stream_text,
    crate::core_command_contract::CORE_API_ROUTES.lifecycle_fork_text,
    crate::core_command_contract::CORE_API_ROUTES.lifecycle_kill_text,
    crate::core_command_contract::CORE_API_ROUTES.lifecycle_spawn_text,
    crate::core_command_contract::CORE_API_ROUTES.lifecycle_stop_text,
    crate::core_command_contract::CORE_API_ROUTES.logs_clear_text,
    crate::core_command_contract::CORE_API_ROUTES.logs_path_text,
    crate::core_command_contract::CORE_API_ROUTES.logs_tail_text,
    crate::core_command_contract::CORE_API_ROUTES.dashboard_reload_text,
    crate::core_command_contract::CORE_API_ROUTES.metadata_text,
    crate::core_command_contract::CORE_API_ROUTES.loop_add_text,
    crate::core_command_contract::CORE_API_ROUTES.loop_block_text,
    crate::core_command_contract::CORE_API_ROUTES.loop_done_text,
    crate::core_command_contract::CORE_API_ROUTES.loop_remove_text,
    crate::core_command_contract::CORE_API_ROUTES.message_send_text,
    crate::core_command_contract::CORE_API_ROUTES.notification_clear_text,
    crate::core_command_contract::CORE_API_ROUTES.notification_list_text,
    crate::core_command_contract::CORE_API_ROUTES.notification_read_text,
    crate::core_command_contract::CORE_API_ROUTES.notification_send_text,
    crate::core_command_contract::CORE_API_ROUTES.outline_list_text,
    crate::core_command_contract::CORE_API_ROUTES.outline_update_text,
    crate::core_command_contract::CORE_API_ROUTES.overseer_clear_text,
    crate::core_command_contract::CORE_API_ROUTES.overseer_start_text,
    crate::core_command_contract::CORE_API_ROUTES.project_ensure_text,
    crate::core_command_contract::CORE_API_ROUTES.team_add_text,
    crate::core_command_contract::CORE_API_ROUTES.team_default_text,
    crate::core_command_contract::CORE_API_ROUTES.team_init_text,
    crate::core_command_contract::CORE_API_ROUTES.team_remove_text,
    crate::core_command_contract::CORE_API_ROUTES.team_show_text,
    crate::core_command_contract::CORE_API_ROUTES.project_kill_text,
    crate::core_command_contract::CORE_API_ROUTES.project_restart_text,
    crate::core_command_contract::CORE_API_ROUTES.project_serve_text,
    crate::core_command_contract::CORE_API_ROUTES.project_stop_text,
    crate::core_command_contract::CORE_API_ROUTES.repair_exchange_text,
    crate::core_command_contract::CORE_API_ROUTES.repair_text,
    crate::core_command_contract::CORE_API_ROUTES.restart_text,
    crate::core_command_contract::CORE_API_ROUTES.runtime_restart_text,
    crate::core_command_contract::CORE_API_ROUTES.review_approve_text,
    crate::core_command_contract::CORE_API_ROUTES.review_request_changes_text,
    crate::core_command_contract::CORE_API_ROUTES.task_accept_text,
    crate::core_command_contract::CORE_API_ROUTES.task_assign_text,
    crate::core_command_contract::CORE_API_ROUTES.task_block_text,
    crate::core_command_contract::CORE_API_ROUTES.task_complete_text,
    crate::core_command_contract::CORE_API_ROUTES.task_list_text,
    crate::core_command_contract::CORE_API_ROUTES.task_reopen_text,
    crate::core_command_contract::CORE_API_ROUTES.task_show_text,
    crate::core_command_contract::CORE_API_ROUTES.thread_list_text,
    crate::core_command_contract::CORE_API_ROUTES.thread_mark_seen_text,
    crate::core_command_contract::CORE_API_ROUTES.thread_open_text,
    crate::core_command_contract::CORE_API_ROUTES.thread_send_text,
    crate::core_command_contract::CORE_API_ROUTES.thread_show_text,
    crate::core_command_contract::CORE_API_ROUTES.thread_status_text,
    crate::core_command_contract::CORE_API_ROUTES.threads_list_text,
    crate::core_command_contract::CORE_API_ROUTES.worktree_create_text,
    crate::core_command_contract::CORE_API_ROUTES.worktree_cache_cleanup_text,
    crate::core_command_contract::CORE_API_ROUTES.worktree_delete_graveyard_text,
    crate::core_command_contract::CORE_API_ROUTES.worktree_graveyard_text,
    crate::core_command_contract::CORE_API_ROUTES.worktree_list_text,
    crate::core_command_contract::CORE_API_ROUTES.worktree_remove_text,
    crate::core_command_contract::CORE_API_ROUTES.worktree_resurrect_text,
];

fn split_csv(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn is_integer_text(input: &str) -> bool {
    input
        .strip_prefix('-')
        .unwrap_or(input)
        .chars()
        .all(|char| char.is_ascii_digit())
        && input != "-"
}

fn percent_decode_lossy(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'+' => {
                bytes.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < raw.len() => {
                let hex = std::str::from_utf8(&raw[index + 1..index + 3]);
                if let Ok(hex) = hex
                    && let Ok(value) = u8::from_str_radix(hex, 16)
                {
                    bytes.push(value);
                    index += 3;
                    continue;
                }
                bytes.push(raw[index]);
                index += 1;
            }
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}
