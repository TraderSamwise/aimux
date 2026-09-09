use serde_json::{Map, Value, json};
use std::path::Path;
use std::process::Command;

use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_service_states, list_topology_session_states, read_runtime_topology,
    runtime_topology_path,
};
use crate::tmux::{select_window_argv, switch_client_to_target_argv};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{query_params, trimmed_query};
use super::metadata::update_session_metadata;
use super::router::ProjectServiceRequestContext;
use super::switchable_agents::{
    AgentListScope, ManagedWindowEntry, SwitchableAgentItem, SwitchableContext,
    SwitchableListOptions, find_managed_window_item, list_switchable_agent_items,
    resolve_next_agent, resolve_prev_agent, serialize_fast_control_item,
    topology_switchable_entries,
};
use super::usage::{MarkLastUsedOptions, load_last_used_state, mark_last_used};

const LIVE_AGENT_STATUSES: &[&str] = &["starting", "running", "idle"];
const LIVE_SERVICE_STATUSES: &[&str] = &["starting", "running"];

pub trait ProjectControlRuntime {
    fn focus_target(&mut self, target: &Value, client_tty: Option<&str>) -> Result<(), String>;
}

pub struct SystemProjectControlRuntime;

impl ProjectControlRuntime for SystemProjectControlRuntime {
    fn focus_target(&mut self, target: &Value, client_tty: Option<&str>) -> Result<(), String> {
        let window_id = string_field(target, "windowId")
            .ok_or_else(|| "target window id is missing".to_owned())?;
        let argv = if let Some(client_tty) = client_tty {
            switch_client_to_target_argv(client_tty, window_id)
        } else {
            select_window_argv(window_id)
        };
        run_tmux_argv(argv, format!("failed to focus window {window_id}"))
    }
}

pub fn route_control_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemProjectControlRuntime;
    route_control_request_with_runtime(context, method, path, body, &mut runtime)
}

pub fn route_control_request_with_runtime<R: ProjectControlRuntime>(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
    runtime: &mut R,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET") && !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let pathname = project_service_pathname(path);
    let input = ControlInput::from_request(method, path, body.unwrap_or(&Value::Null));
    match pathname {
        routes::controls::OPEN_DASHBOARD => Some(route_open_dashboard(context, &input, runtime)),
        routes::controls::OPEN_NOTIFICATION_TARGET => {
            Some(route_open_notification_target(context, &input, runtime))
        }
        routes::controls::FOCUS_WINDOW => Some(route_focus_window(context, &input, runtime)),
        routes::controls::ACTIVE_WINDOW => Some(route_active_window(context, &input)),
        routes::controls::SWITCH_NEXT => Some(route_switch_agent(
            context,
            &input,
            runtime,
            SwitchDirection::Next,
        )),
        routes::controls::SWITCH_PREV => Some(route_switch_agent(
            context,
            &input,
            runtime,
            SwitchDirection::Prev,
        )),
        routes::controls::SWITCH_ATTENTION => Some(route_switch_agent(
            context,
            &input,
            runtime,
            SwitchDirection::Attention,
        )),
        _ => None,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ControlInput {
    current_client_session: Option<String>,
    client_tty: Option<String>,
    current_window: Option<String>,
    current_window_id: Option<String>,
    current_path: Option<String>,
    window_id: Option<String>,
    session_id: Option<String>,
    focus: bool,
    screen: Option<String>,
}

impl ControlInput {
    fn from_request(method: &str, path: &str, body: &Value) -> Self {
        if method.eq_ignore_ascii_case("GET") {
            let params = query_params(path);
            return Self {
                current_client_session: trimmed_query(&params, "currentClientSession"),
                client_tty: trimmed_query(&params, "clientTty"),
                current_window: trimmed_query(&params, "currentWindow"),
                current_window_id: trimmed_query(&params, "currentWindowId"),
                current_path: trimmed_query(&params, "currentPath"),
                window_id: trimmed_query(&params, "windowId"),
                session_id: trimmed_query(&params, "sessionId"),
                focus: query_bool(&params, "focus", true),
                screen: trimmed_query(&params, "screen"),
            };
        }
        Self {
            current_client_session: trimmed_string(body.get("currentClientSession")),
            client_tty: trimmed_string(body.get("clientTty")),
            current_window: trimmed_string(body.get("currentWindow")),
            current_window_id: trimmed_string(body.get("currentWindowId")),
            current_path: trimmed_string(body.get("currentPath")),
            window_id: trimmed_string(body.get("windowId")),
            session_id: trimmed_string(body.get("sessionId")),
            focus: body_bool(body, "focus", true),
            screen: trimmed_string(body.get("screen")),
        }
    }
}

enum SwitchDirection {
    Next,
    Prev,
    Attention,
}

fn route_open_dashboard<R: ProjectControlRuntime>(
    context: &ProjectServiceRequestContext,
    input: &ControlInput,
    runtime: &mut R,
) -> ProjectServiceDispatchResponse {
    let topology = match load_topology(context) {
        Ok(topology) => topology,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    let Some(target) = find_dashboard_target(&topology) else {
        return json_response(
            404,
            json!({ "ok": false, "error": "dashboard window not found" }),
        );
    };
    let focused = match maybe_focus_target(runtime, input, &target) {
        Ok(focused) => focused,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    json_response(
        200,
        json!({
            "ok": true,
            "action": "open-dashboard",
            "target": target,
            "focused": focused,
            "screen": input.screen,
        }),
    )
}

fn route_open_notification_target<R: ProjectControlRuntime>(
    context: &ProjectServiceRequestContext,
    input: &ControlInput,
    runtime: &mut R,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = input.session_id.as_deref() else {
        return json_response(
            400,
            json!({ "ok": false, "error": "sessionId is required" }),
        );
    };
    let model = match load_control_model(context) {
        Ok(model) => model,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    if let Some(item) = item_by_id(&model.items, session_id) {
        return open_control_item(
            context.project_state_dir(),
            runtime,
            input,
            item,
            "open-notification-target",
        );
    }
    if let Some(status) = service_status(&model.topology, session_id)
        && !LIVE_SERVICE_STATUSES.contains(&status.as_str())
    {
        return json_response(
            409,
            json!({ "ok": false, "error": "service is offline", "itemId": session_id }),
        );
    }
    if let Some(status) = session_status(&model.topology, session_id)
        && !LIVE_AGENT_STATUSES.contains(&status.as_str())
    {
        return json_response(
            409,
            json!({ "ok": false, "error": "agent is offline", "itemId": session_id }),
        );
    }
    json_response(
        404,
        json!({ "ok": false, "error": "notification target is no longer available" }),
    )
}

fn route_focus_window<R: ProjectControlRuntime>(
    context: &ProjectServiceRequestContext,
    input: &ControlInput,
    runtime: &mut R,
) -> ProjectServiceDispatchResponse {
    let Some(window_id) = input.window_id.as_deref() else {
        return json_response(400, json!({ "ok": false, "error": "windowId is required" }));
    };
    let model = match load_control_model(context) {
        Ok(model) => model,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    let Some(item) = model.find_window(context, window_id) else {
        return json_response(404, json!({ "ok": false, "error": "window not found" }));
    };
    open_control_item(
        context.project_state_dir(),
        runtime,
        input,
        &item,
        "focus-window",
    )
}

fn route_active_window(
    context: &ProjectServiceRequestContext,
    input: &ControlInput,
) -> ProjectServiceDispatchResponse {
    let Some(current_client_session) = input.current_client_session.as_deref() else {
        return json_response(
            400,
            json!({ "ok": false, "error": "currentClientSession is required" }),
        );
    };
    let Some(current_window_id) = input.current_window_id.as_deref() else {
        return json_response(
            400,
            json!({ "ok": false, "error": "currentWindowId is required" }),
        );
    };
    let model = match load_control_model(context) {
        Ok(model) => model,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    let Some(item) = model.find_window(context, current_window_id) else {
        return json_response(404, json!({ "ok": false, "error": "window not found" }));
    };
    let item = &item;
    mark_target_used(
        context.project_state_dir(),
        item,
        Some(current_client_session),
    );
    if !is_service_item(item) {
        mark_item_seen(context.project_state_dir(), &item.id);
    }
    json_response(
        200,
        json!({
            "ok": true,
            "action": "active-window",
            "focused": false,
            "target": item.target,
            "itemId": item.id,
        }),
    )
}

fn route_switch_agent<R: ProjectControlRuntime>(
    context: &ProjectServiceRequestContext,
    input: &ControlInput,
    runtime: &mut R,
    direction: SwitchDirection,
) -> ProjectServiceDispatchResponse {
    let model = match load_control_model(context) {
        Ok(model) => model,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    let switch_context = switch_context(context, input);
    let options = SwitchableListOptions {
        scope: AgentListScope::Worktree,
        include_overseer: false,
        raw_labels: true,
        display_order_ids: Vec::new(),
    };
    let resolved = match direction {
        SwitchDirection::Next => resolve_next_agent(
            &model.entries,
            &model.metadata.sessions,
            &switch_context,
            &options,
            &model.last_used,
        ),
        SwitchDirection::Prev => resolve_prev_agent(
            &model.entries,
            &model.metadata.sessions,
            &switch_context,
            &options,
            &model.last_used,
        ),
        SwitchDirection::Attention => resolve_attention_agent(
            &model.entries,
            &model.metadata.sessions,
            &switch_context,
            &options,
            &model.last_used,
        ),
    };
    let Some(item) = resolved else {
        let error = match direction {
            SwitchDirection::Attention => "no attention target found",
            SwitchDirection::Next | SwitchDirection::Prev => "no switchable agent found",
        };
        return json_response(404, json!({ "ok": false, "error": error }));
    };
    let action = match direction {
        SwitchDirection::Next => "switch-next",
        SwitchDirection::Prev => "switch-prev",
        SwitchDirection::Attention => "switch-attention",
    };
    open_control_item(context.project_state_dir(), runtime, input, &item, action)
}

struct ControlModel {
    topology: Value,
    metadata: crate::daemon_state::MetadataState,
    entries: Vec<ManagedWindowEntry>,
    items: Vec<SwitchableAgentItem>,
    last_used: Value,
}

impl ControlModel {
    /// Resolve a tmux window id against every live managed window.
    ///
    /// `items` is the switch-cycle list and deliberately omits scribes,
    /// overseers and teammates, so resolving an explicit window id through it
    /// made focusing those windows 404.
    fn find_window(
        &self,
        context: &ProjectServiceRequestContext,
        window_id: &str,
    ) -> Option<SwitchableAgentItem> {
        let switch_context = SwitchableContext {
            project_root: context.project_root().to_string_lossy().into_owned(),
            ..SwitchableContext::default()
        };
        find_managed_window_item(
            &self.entries,
            &self.metadata.sessions,
            &switch_context,
            &self.last_used,
            window_id,
        )
    }
}

fn load_control_model(context: &ProjectServiceRequestContext) -> Result<ControlModel, String> {
    let topology = load_topology(context)?;
    let project_state_dir = context.project_state_dir();
    let metadata = load_metadata_state(&project_state_dir);
    let entries = topology_switchable_entries(&topology, &metadata.sessions);
    let last_used = load_last_used_state(&project_state_dir);
    let switch_context = SwitchableContext {
        project_root: context.project_root().to_string_lossy().into_owned(),
        ..SwitchableContext::default()
    };
    let items = list_switchable_agent_items(
        &entries,
        &metadata.sessions,
        &switch_context,
        &SwitchableListOptions {
            scope: AgentListScope::All,
            raw_labels: true,
            ..SwitchableListOptions::default()
        },
        &last_used,
    );
    Ok(ControlModel {
        topology,
        metadata,
        entries,
        items,
        last_used,
    })
}

fn load_topology(context: &ProjectServiceRequestContext) -> Result<Value, String> {
    let path = runtime_topology_path(context.project_state_dir());
    read_runtime_topology(path)
}

fn open_control_item<R: ProjectControlRuntime>(
    project_state_dir: impl AsRef<Path>,
    runtime: &mut R,
    input: &ControlInput,
    item: &SwitchableAgentItem,
    action: &str,
) -> ProjectServiceDispatchResponse {
    let project_state_dir = project_state_dir.as_ref();
    let focused = match maybe_focus_target(runtime, input, &item.target) {
        Ok(focused) => focused,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    if focused {
        mark_target_used(
            project_state_dir,
            item,
            input.current_client_session.as_deref(),
        );
        if !is_service_item(item) {
            mark_item_seen(project_state_dir, &item.id);
        }
    }
    json_response(
        200,
        json!({
            "ok": true,
            "action": action,
            "target": item.target,
            "item": serialize_fast_control_item(item),
            "itemId": item.id,
            "focused": focused,
        }),
    )
}

fn maybe_focus_target<R: ProjectControlRuntime>(
    runtime: &mut R,
    input: &ControlInput,
    target: &Value,
) -> Result<bool, String> {
    if !input.focus {
        return Ok(false);
    }
    runtime
        .focus_target(target, input.client_tty.as_deref())
        .map(|_| true)
}

fn resolve_attention_agent(
    entries: &[ManagedWindowEntry],
    metadata_sessions: &std::collections::BTreeMap<String, Value>,
    context: &SwitchableContext,
    options: &SwitchableListOptions,
    last_used: &Value,
) -> Option<SwitchableAgentItem> {
    list_switchable_agent_items(entries, metadata_sessions, context, options, last_used)
        .into_iter()
        .filter(|item| item.urgency > 0)
        .max_by(|left, right| {
            left.urgency
                .cmp(&right.urgency)
                .then_with(|| right.recent_rank.cmp(&left.recent_rank))
                .then_with(|| right.activity.cmp(&left.activity))
        })
}

fn switch_context(
    context: &ProjectServiceRequestContext,
    input: &ControlInput,
) -> SwitchableContext {
    SwitchableContext {
        project_root: context.project_root().to_string_lossy().into_owned(),
        current_path: input.current_path.clone(),
        current_window: input.current_window.clone(),
        current_window_id: input.current_window_id.clone(),
        current_client_session: input.current_client_session.clone(),
    }
}

fn find_dashboard_target(topology: &Value) -> Option<Value> {
    topology
        .get("bindings")
        .and_then(Value::as_array)?
        .iter()
        .filter(|binding| {
            string_field(binding, "tmuxWindowName").is_some_and(is_dashboard_window_name)
        })
        .filter_map(|binding| {
            let session_name = string_field(binding, "tmuxSession")?;
            let window_id = string_field(binding, "tmuxWindowId")?;
            Some(json!({
                "sessionName": session_name,
                "windowId": window_id,
                "windowIndex": number_field(binding, "tmuxWindowIndex").unwrap_or(0),
                "windowName": string_field(binding, "tmuxWindowName").unwrap_or("dashboard"),
            }))
        })
        .next()
}

fn item_by_id<'a>(
    items: &'a [SwitchableAgentItem],
    session_id: &str,
) -> Option<&'a SwitchableAgentItem> {
    items.iter().find(|item| item.id == session_id)
}

fn session_status(topology: &Value, session_id: &str) -> Option<String> {
    list_topology_session_states(topology, None)
        .iter()
        .find(|session| string_field(session, "id") == Some(session_id))
        .and_then(|session| string_field(session, "status").map(str::to_owned))
}

fn service_status(topology: &Value, session_id: &str) -> Option<String> {
    list_topology_service_states(topology, None)
        .iter()
        .find(|service| string_field(service, "id") == Some(session_id))
        .and_then(|service| string_field(service, "status").map(str::to_owned))
}

fn mark_target_used(
    project_state_dir: impl AsRef<Path>,
    item: &SwitchableAgentItem,
    current_client_session: Option<&str>,
) {
    mark_last_used(
        project_state_dir,
        MarkLastUsedOptions {
            item_id: item.id.clone(),
            client_session: current_client_session.map(str::to_owned),
            used_at: None,
        },
    );
}

fn mark_item_seen(project_state_dir: impl AsRef<Path>, session_id: &str) {
    let _ = update_session_metadata(project_state_dir, session_id, |current| {
        let mut object = object_value(current);
        let mut derived = object
            .get("derived")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        derived.insert("unseenCount".into(), Value::Number(0.into()));
        object.insert("derived".into(), Value::Object(derived));
        Value::Object(object)
    });
}

fn is_service_item(item: &SwitchableAgentItem) -> bool {
    item.metadata.get("kind").and_then(Value::as_str) == Some("service")
}

fn string_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}


fn number_field(value: &Value, field: &str) -> Option<i64> {
    value.get(field).and_then(Value::as_i64)
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn body_bool(body: &Value, key: &str, default_value: bool) -> bool {
    match body.get(key) {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => parse_bool_text(value, default_value),
        _ => default_value,
    }
}

fn query_bool(
    params: &std::collections::BTreeMap<String, String>,
    key: &str,
    default_value: bool,
) -> bool {
    params
        .get(key)
        .map(|value| parse_bool_text(value, default_value))
        .unwrap_or(default_value)
}

fn parse_bool_text(value: &str, default_value: bool) -> bool {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => true,
        "0" | "false" | "no" => false,
        _ => default_value,
    }
}

fn is_dashboard_window_name(name: &str) -> bool {
    name == "dashboard" || name.starts_with("dashboard-")
}

fn object_value(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn run_tmux_argv(argv: Vec<String>, fallback_error: String) -> Result<(), String> {
    match Command::new("tmux").args(argv).output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if stderr.is_empty() {
                Err(fallback_error)
            } else {
                Err(stderr)
            }
        }
        Err(error) => Err(format!("{fallback_error}: {error}")),
    }
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
