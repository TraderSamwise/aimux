use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent_display::{AgentDisplayInput, resolve_statusline_model};
use crate::config::default_config;
use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_service_states, read_runtime_topology, runtime_topology_path,
};
use crate::team_contract::{
    is_overseer_session, is_project_control_session as team_is_project_control_session,
    is_scribe_session, project_control_display_role, session_with_stored_control_flags,
};
use crate::tmux::TmuxTarget;

use super::agent_output::{AgentOutputCaptureRuntime, SystemAgentOutputCaptureRuntime};
use super::agents::{
    LiveWindowIdsProjection, topology_desktop_session_list,
    topology_desktop_session_list_for_context,
    topology_desktop_session_list_with_live_window_projection,
};
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::expose_ordering::{
    ExposeOrderingOptions, ExposeSublabel, assign_worktree_tones, dashboard_worktree_order_paths,
    expose_tile_context_for_item, order_expose_items,
};
use super::http::{query_params, trimmed_query};
use super::preview_snapshots::{
    DEFAULT_PREVIEW_CAPTURE_LINES, DEFAULT_PREVIEW_MAX_CHARS, capture_preview_snapshot_with_tap,
};
use super::router::ProjectServiceRequestContext;
use super::usage::{load_last_used_state, parse_recency_timestamp};
use super::visual_clients::VisualClientLeaseRoute;

const LIVE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
const LIVE_SERVICE_STATUSES: &[&str] = &["starting", "running"];
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentListScope {
    All,
    Worktree,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SwitchableContext {
    pub project_root: String,
    pub current_path: Option<String>,
    pub current_window: Option<String>,
    pub current_window_id: Option<String>,
    pub current_client_session: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchableListOptions {
    pub scope: AgentListScope,
    pub include_overseer: bool,
    pub raw_labels: bool,
    pub display_order_ids: Vec<String>,
}

impl Default for SwitchableListOptions {
    fn default() -> Self {
        Self {
            scope: AgentListScope::Worktree,
            include_overseer: false,
            raw_labels: false,
            display_order_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ManagedWindowEntry {
    pub target: Value,
    pub metadata: Value,
    pub alive: bool,
    pub activity: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SwitchableAgentItem {
    pub id: String,
    pub target: Value,
    pub metadata: Value,
    pub label: String,
    pub urgency: i64,
    pub activity: i64,
    pub last_used_at: Option<String>,
    pub recent_rank: i64,
    pub overseer: bool,
    pub scribe: bool,
    pub alive: bool,
    pub project_id: Option<String>,
    pub project_root: Option<String>,
    pub project_name: Option<String>,
}

pub fn route_switchable_agent_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemAgentOutputCaptureRuntime;
    route_switchable_agent_request_with_runtime(context, method, path, &mut runtime)
}

pub fn route_switchable_agent_request_with_runtime(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET")
        || project_service_pathname(path) != routes::controls::SWITCHABLE_AGENTS
    {
        return None;
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => {
            return Some(ProjectServiceDispatchResponse::json(
                500,
                json!({ "ok": false, "error": error }),
            ));
        }
    };
    let params = query_params(path);
    let switch_context = SwitchableContext {
        project_root: context.project_root().to_string_lossy().into_owned(),
        current_path: trimmed_query(&params, "currentPath"),
        current_window: trimmed_query(&params, "currentWindow"),
        current_window_id: trimmed_query(&params, "currentWindowId"),
        current_client_session: trimmed_query(&params, "currentClientSession"),
    };
    let options = SwitchableListOptions {
        scope: if params.get("scope").is_some_and(|value| value == "all") {
            AgentListScope::All
        } else {
            AgentListScope::Worktree
        },
        include_overseer: params
            .get("includeOverseer")
            .is_some_and(|value| value == "1"),
        raw_labels: params
            .get("labelFormat")
            .is_some_and(|value| value == "raw"),
        display_order_ids: dashboard_display_order_ids(context.desktop_state.as_ref()),
    };
    let expose = params.get("expose").is_some_and(|value| value == "1");
    let include_preview = matches!(
        params.get("includePreview").map(String::as_str),
        Some("1" | "true")
    );
    let include_chat_preview = params
        .get("includeChatPreview")
        .is_some_and(|value| value == "1");
    if include_preview || include_chat_preview {
        context.visual_clients.touch_route_lease(
            &params,
            VisualClientLeaseRoute {
                surface: if expose {
                    "expose"
                } else {
                    "switchable-agents"
                },
                requested_preview: include_preview,
                requested_chat_preview: include_chat_preview,
                default_kind: if expose { Some("expose") } else { None },
                remote_address: context.remote_address.as_deref(),
            },
            context.project_root(),
            &project_state_dir,
        );
    }
    let metadata = load_metadata_state(&project_state_dir);
    let entries = topology_switchable_entries_for_context(context, &topology, &metadata.sessions);
    let last_used = load_last_used_state(&project_state_dir);
    let mut items = list_switchable_agent_items(
        &entries,
        &metadata.sessions,
        &switch_context,
        &options,
        &last_used,
    );
    let sublabel = if expose && options.scope == AgentListScope::All {
        ExposeSublabel::Worktree
    } else {
        ExposeSublabel::None
    };
    let expose_tones = if expose {
        let expose_options = ExposeOrderingOptions {
            worktree_order_by_project_root: BTreeMap::from([(
                clean_path_string(&switch_context.project_root),
                dashboard_worktree_order_paths(&switch_context.project_root, &topology),
            )]),
            sort_mode_recent_output: params
                .get("sort")
                .is_some_and(|value| value == "recent-output"),
        };
        items = order_expose_items(
            &items,
            &switch_context.project_root,
            sublabel,
            &expose_options,
        );
        Some(assign_worktree_tones(&items, &switch_context.project_root))
    } else {
        None
    };
    let route_project_root = switch_context.project_root.clone();
    let items = items
        .into_iter()
        .map(|item| {
            let mut serialized = serialize_route_item(
                &item,
                options.raw_labels,
                sublabel,
                &route_project_root,
                expose_tones.as_ref(),
            );
            if include_preview {
                attach_expose_preview_snapshot(context, &mut serialized, runtime);
            }
            serialized
        })
        .collect::<Vec<_>>();
    Some(ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "items": items }),
    ))
}

pub fn topology_switchable_entries_for_context(
    context: &ProjectServiceRequestContext,
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
) -> Vec<ManagedWindowEntry> {
    let tools = default_tools_config();
    let sessions =
        topology_desktop_session_list_for_context(context, topology, metadata_sessions, &tools);
    topology_switchable_entries_from_sessions(sessions, topology, metadata_sessions)
}

pub fn topology_switchable_entries_with_live_window_normalization(
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
) -> Vec<ManagedWindowEntry> {
    let tools = default_tools_config();
    let sessions = topology_desktop_session_list(topology, metadata_sessions, &tools);
    topology_switchable_entries_from_sessions(sessions, topology, metadata_sessions)
}

pub fn topology_switchable_entries_with_live_window_projection(
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
    live_window_ids: LiveWindowIdsProjection<'_>,
) -> Vec<ManagedWindowEntry> {
    let tools = default_tools_config();
    let sessions = topology_desktop_session_list_with_live_window_projection(
        topology,
        metadata_sessions,
        &tools,
        live_window_ids,
    );
    topology_switchable_entries_from_sessions(sessions, topology, metadata_sessions)
}

fn topology_switchable_entries_from_sessions(
    sessions: Vec<Value>,
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
) -> Vec<ManagedWindowEntry> {
    let mut entries = Vec::new();
    for session in sessions
        .into_iter()
        .filter(|session| string_field(session, "status").is_some_and(is_live_session_status))
    {
        if let Some(entry) = session_switchable_entry(&session, metadata_sessions) {
            entries.push(entry);
        }
    }
    for service in list_topology_service_states(topology, Some(LIVE_SERVICE_STATUSES)) {
        if let Some(entry) = service_switchable_entry(&service) {
            entries.push(entry);
        }
    }
    entries
}

fn default_tools_config() -> Map<String, Value> {
    default_config()
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn is_live_session_status(status: &str) -> bool {
    LIVE_SESSION_STATUSES.contains(&status)
}

pub fn list_switchable_agent_items(
    entries: &[ManagedWindowEntry],
    metadata_sessions: &BTreeMap<String, Value>,
    context: &SwitchableContext,
    options: &SwitchableListOptions,
    last_used: &Value,
) -> Vec<SwitchableAgentItem> {
    build_switchable_agent_items(entries, metadata_sessions, context, options, last_used)
        .into_iter()
        .filter(|item| item.alive)
        .collect()
}

pub fn resolve_current_agent_index(
    items: &[SwitchableAgentItem],
    context: &SwitchableContext,
) -> Option<usize> {
    if let Some(current_window_id) = context.current_window_id.as_deref()
        && let Some(index) = items.iter().position(|item| {
            target_string_field(&item.target, "windowId") == Some(current_window_id)
        })
    {
        return Some(index);
    }
    let current_window = context.current_window.as_deref()?;
    items.iter().position(|item| {
        target_string_field(&item.target, "windowName") == Some(current_window)
            || string_field(&item.metadata, "label") == Some(current_window)
    })
}

pub fn resolve_next_agent(
    entries: &[ManagedWindowEntry],
    metadata_sessions: &BTreeMap<String, Value>,
    context: &SwitchableContext,
    options: &SwitchableListOptions,
    last_used: &Value,
) -> Option<SwitchableAgentItem> {
    if current_window_is_project_control(entries, metadata_sessions, context) {
        return None;
    }
    let items =
        build_switchable_agent_items(entries, metadata_sessions, context, options, last_used);
    if items.iter().all(|item| !item.alive) {
        return None;
    }
    let resolved_index = resolve_current_agent_index(&items, context).unwrap_or_default();
    for offset in 1..=items.len() {
        let item = items[(resolved_index + offset) % items.len()].clone();
        if item.alive {
            return Some(item);
        }
    }
    None
}

pub fn resolve_prev_agent(
    entries: &[ManagedWindowEntry],
    metadata_sessions: &BTreeMap<String, Value>,
    context: &SwitchableContext,
    options: &SwitchableListOptions,
    last_used: &Value,
) -> Option<SwitchableAgentItem> {
    if current_window_is_project_control(entries, metadata_sessions, context) {
        return None;
    }
    let items =
        build_switchable_agent_items(entries, metadata_sessions, context, options, last_used);
    if items.iter().all(|item| !item.alive) {
        return None;
    }
    let resolved_index = resolve_current_agent_index(&items, context).unwrap_or_default();
    for offset in 1..=items.len() {
        let item = items[(resolved_index + items.len() - offset) % items.len()].clone();
        if item.alive {
            return Some(item);
        }
    }
    None
}

pub fn serialize_fast_control_item(item: &SwitchableAgentItem) -> Value {
    let mut serialized = Map::new();
    serialized.insert("target".into(), item.target.clone());
    serialized.insert("id".into(), Value::String(item.id.clone()));
    serialized.insert("metadata".into(), item.metadata.clone());
    serialized.insert("label".into(), Value::String(item.label.clone()));
    serialized.insert("urgency".into(), Value::from(item.urgency));
    serialized.insert("activity".into(), Value::from(item.activity));
    insert_optional_string(&mut serialized, "lastUsedAt", item.last_used_at.as_deref());
    serialized.insert("recentRank".into(), Value::from(item.recent_rank));
    serialized.insert("overseer".into(), Value::Bool(item.overseer));
    serialized.insert("scribe".into(), Value::Bool(item.scribe));
    insert_optional_string(&mut serialized, "projectId", item.project_id.as_deref());
    insert_optional_string(&mut serialized, "projectRoot", item.project_root.as_deref());
    insert_optional_string(&mut serialized, "projectName", item.project_name.as_deref());
    Value::Object(serialized)
}

pub fn agent_status_chip(metadata: &Value) -> Option<Value> {
    if let Some(user_label) = string_field(metadata, "userLabel")
        && let Some((kind, label)) = user_label_chip(user_label)
    {
        return Some(json!({ "kind": kind, "label": label }));
    }
    if let Some(attention) = string_field(metadata, "attention")
        && let Some((kind, label)) = attention_chip(attention)
    {
        return Some(json!({ "kind": kind, "label": label }));
    }
    if let Some(activity) = string_field(metadata, "activity")
        && let Some((kind, label)) = activity_chip(activity)
    {
        return Some(json!({ "kind": kind, "label": label }));
    }
    None
}

fn build_switchable_agent_items(
    entries: &[ManagedWindowEntry],
    metadata_sessions: &BTreeMap<String, Value>,
    context: &SwitchableContext,
    options: &SwitchableListOptions,
    last_used: &Value,
) -> Vec<SwitchableAgentItem> {
    let current_managed_window = resolve_current_managed_window(entries, context);
    let current_metadata = current_managed_window
        .map(|entry| metadata_with_stored_control_flags(&entry.metadata, metadata_sessions));
    let teammate_parent_session_id = current_managed_window
        .and_then(|_| {
            current_metadata
                .as_ref()
                .and_then(|metadata| team_string_field(metadata, "parentSessionId"))
        })
        .map(str::to_owned);
    let scoped_worktree_path = resolve_context_worktree_path(context, current_managed_window);
    let mut managed = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            let metadata = metadata_with_stored_control_flags(&entry.metadata, metadata_sessions);
            if target_string_field(&entry.target, "windowName")
                .is_some_and(is_dashboard_window_name)
            {
                return false;
            }
            let current_window_id = current_managed_window
                .and_then(|entry| target_string_field(&entry.target, "windowId"));
            if !entry.alive && target_string_field(&entry.target, "windowId") != current_window_id {
                return false;
            }
            if is_scribe_session(Some(&metadata)) {
                return false;
            }
            let overseer = is_overseer_session(Some(&metadata));
            if !options.include_overseer && overseer {
                return false;
            }
            if options.include_overseer && overseer {
                if options.scope == AgentListScope::All {
                    return true;
                }
                return clean_path_string(
                    string_field(&entry.metadata, "worktreePath").unwrap_or(&context.project_root),
                ) == scoped_worktree_path;
            }
            if let Some(teammate_parent_session_id) = teammate_parent_session_id.as_deref()
                && options.scope != AgentListScope::All
            {
                return string_field(&metadata, "kind") != Some("service")
                    && team_string_field(&metadata, "parentSessionId")
                        == Some(teammate_parent_session_id);
            }
            if team_string_field(&metadata, "parentSessionId").is_some_and(|id| !id.is_empty()) {
                return false;
            }
            if options.scope == AgentListScope::All {
                return true;
            }
            clean_path_string(
                string_field(&metadata, "worktreePath").unwrap_or(&context.project_root),
            ) == scoped_worktree_path
        })
        .collect::<Vec<_>>();
    managed.sort_by(|(_, left), (_, right)| {
        compare_switchable_windows(left, right, teammate_parent_session_id.as_deref())
    });
    order_managed_entries_by_display_order(managed, &options.display_order_ids)
        .into_iter()
        .map(|(_, entry)| managed_window_item(entry, metadata_sessions, context, last_used))
        .collect()
}

/// Build one item from a managed window entry, with no switch-cycle filtering.
pub fn managed_window_item(
    entry: &ManagedWindowEntry,
    metadata_sessions: &BTreeMap<String, Value>,
    context: &SwitchableContext,
    last_used: &Value,
) -> SwitchableAgentItem {
    let id = string_field(&entry.metadata, "sessionId")
        .unwrap_or("")
        .to_owned();
    let last_used_at = last_used_at(last_used, &id).map(str::to_owned);
    let recent_rank = recent_rank(last_used, context.current_client_session.as_deref(), &id);
    let classification_metadata =
        metadata_with_stored_control_flags(&entry.metadata, metadata_sessions);
    SwitchableAgentItem {
        id: id.clone(),
        target: entry.target.clone(),
        metadata: entry.metadata.clone(),
        label: compact_session_title(&classification_metadata),
        urgency: urgency_for(metadata_sessions, &id),
        activity: entry.activity,
        last_used_at,
        recent_rank,
        overseer: is_overseer_session(Some(&classification_metadata)),
        scribe: is_scribe_session(Some(&classification_metadata)),
        alive: entry.alive,
        project_id: None,
        project_root: None,
        project_name: None,
    }
}

/// Find a managed window by tmux window id across every live entry.
///
/// Window-id-addressed routes must reach scribes, overseers and teammates that
/// `list_switchable_agent_items` hides from next/prev cycling; Node resolved
/// them from the live tmux window list, which applied none of those filters.
pub fn find_managed_window_item(
    entries: &[ManagedWindowEntry],
    metadata_sessions: &BTreeMap<String, Value>,
    context: &SwitchableContext,
    last_used: &Value,
    window_id: &str,
) -> Option<SwitchableAgentItem> {
    entries
        .iter()
        .find(|entry| target_string_field(&entry.target, "windowId") == Some(window_id))
        .map(|entry| managed_window_item(entry, metadata_sessions, context, last_used))
}

fn session_switchable_entry(
    session: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
) -> Option<ManagedWindowEntry> {
    let target = session.get("tmuxTarget")?.clone();
    let id = string_field(session, "id")?;
    let mut metadata = Map::new();
    metadata.insert("kind".into(), Value::String("agent".into()));
    metadata.insert("sessionId".into(), Value::String(id.to_owned()));
    insert_string(
        &mut metadata,
        "command",
        string_field(session, "command")
            .or_else(|| string_field(session, "tool"))
            .unwrap_or("unknown"),
    );
    metadata.insert(
        "args".into(),
        session
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into(),
    );
    insert_string(
        &mut metadata,
        "toolConfigKey",
        string_field(session, "toolConfigKey")
            .or_else(|| string_field(session, "tool"))
            .or_else(|| string_field(session, "command"))
            .unwrap_or("unknown"),
    );
    for key in [
        "createdAt",
        "backendSessionId",
        "team",
        "worktreePath",
        "label",
    ] {
        insert_value(&mut metadata, key, session.get(key).cloned());
    }
    if let Some(stored) = metadata_sessions.get(id) {
        for key in ["overseer", "scribe", "projectControl"] {
            insert_value(&mut metadata, key, stored.get(key).cloned());
        }
        if let Some(derived) = stored.get("derived") {
            for key in ["activity", "attention", "unseenCount"] {
                insert_value(&mut metadata, key, derived.get(key).cloned());
            }
        }
    }
    let control_probe = session_with_stored_control_flags(
        &Value::Object(metadata.clone()),
        metadata_sessions.get(id),
    );
    for key in ["role", "team"] {
        if control_probe.get(key).is_none_or(|value| value.is_null()) {
            metadata.remove(key);
        }
    }
    for key in ["overseer", "scribe", "projectControl"] {
        insert_value(
            &mut metadata,
            key,
            control_probe
                .get(key)
                .filter(|value| value.is_boolean())
                .cloned(),
        );
    }
    if let Some(role) = project_control_display_role(Some(&control_probe)) {
        insert_string(&mut metadata, "role", role);
    }
    Some(ManagedWindowEntry {
        activity: target_number_field(&target, "windowIndex").unwrap_or_default(),
        target,
        metadata: Value::Object(metadata),
        alive: true,
    })
}

fn service_switchable_entry(service: &Value) -> Option<ManagedWindowEntry> {
    let target = service.get("tmuxTarget")?.clone();
    let id = string_field(service, "id")?;
    let mut metadata = Map::new();
    metadata.insert("kind".into(), Value::String("service".into()));
    metadata.insert("sessionId".into(), Value::String(id.to_owned()));
    insert_string(
        &mut metadata,
        "command",
        string_field(service, "command").unwrap_or("service"),
    );
    metadata.insert(
        "args".into(),
        service
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into(),
    );
    insert_string(
        &mut metadata,
        "toolConfigKey",
        string_field(service, "command").unwrap_or("service"),
    );
    for key in [
        "createdAt",
        "worktreePath",
        "label",
        "launchCommandLine",
        "activity",
        "attention",
        "statusText",
        "userLabel",
        "recencyAt",
        "recencyLabel",
    ] {
        insert_value(&mut metadata, key, service.get(key).cloned());
    }
    Some(ManagedWindowEntry {
        activity: target_number_field(&target, "windowIndex").unwrap_or_default(),
        target,
        metadata: Value::Object(metadata),
        alive: true,
    })
}

fn serialize_route_item(
    item: &SwitchableAgentItem,
    raw_labels: bool,
    sublabel: ExposeSublabel,
    project_root: &str,
    expose_tones: Option<&BTreeMap<String, i64>>,
) -> Value {
    let mut serialized = serialize_fast_control_item(item);
    if !raw_labels
        && let Some(last_used_at) = item.last_used_at.as_deref()
        && let Some(relative) = format_relative_recency(last_used_at)
        && let Value::Object(map) = &mut serialized
    {
        map.insert(
            "label".into(),
            Value::String(format!("{} · {relative}", item.label)),
        );
    }
    if let Some(tones) = expose_tones
        && let Value::Object(map) = &mut serialized
    {
        map.insert(
            "exposeContext".into(),
            expose_tile_context_for_item(item, sublabel, project_root, tones),
        );
    }
    if expose_tones.is_some()
        && let Some(chip) = agent_status_chip(&item.metadata)
        && let Value::Object(map) = &mut serialized
    {
        map.insert("exposeStatus".into(), chip);
    }
    serialized
}

fn attach_expose_preview_snapshot(
    context: &ProjectServiceRequestContext,
    item: &mut Value,
    runtime: &mut impl AgentOutputCaptureRuntime,
) {
    let Some(window_id) = item
        .get("target")
        .and_then(|target| target.get("windowId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let target = item.get("target").and_then(tmux_target_from_value);
    let tap_snapshot = target.and_then(|target| {
        context.osc_output_tap.track_and_read_snapshot(
            string_field(item, "id").unwrap_or_default(),
            target,
            DEFAULT_PREVIEW_MAX_CHARS,
        )
    });
    let Some(preview) = capture_preview_snapshot_with_tap(
        context,
        &window_id,
        tap_snapshot.as_ref(),
        runtime,
        DEFAULT_PREVIEW_CAPTURE_LINES,
        DEFAULT_PREVIEW_MAX_CHARS,
    ) else {
        return;
    };
    let Some(map) = item.as_object_mut() else {
        return;
    };
    map.insert("previewSnapshot".into(), preview);
}

fn tmux_target_from_value(target: &Value) -> Option<TmuxTarget> {
    Some(TmuxTarget {
        session_name: target_string_field(target, "sessionName")
            .unwrap_or("")
            .to_owned(),
        window_id: target_string_field(target, "windowId")?.to_owned(),
        window_index: target_number_field(target, "windowIndex").unwrap_or(0),
        window_name: target_string_field(target, "windowName")
            .unwrap_or("")
            .to_owned(),
        pane_dead: target.get("paneDead").and_then(Value::as_bool),
    })
}

fn resolve_current_managed_window<'a>(
    entries: &'a [ManagedWindowEntry],
    context: &SwitchableContext,
) -> Option<&'a ManagedWindowEntry> {
    if let Some(current_window_id) = context.current_window_id.as_deref()
        && let Some(entry) = entries
            .iter()
            .find(|entry| target_string_field(&entry.target, "windowId") == Some(current_window_id))
    {
        return Some(entry);
    }
    let current_window = context.current_window.as_deref()?;
    entries.iter().find(|entry| {
        target_string_field(&entry.target, "windowName") == Some(current_window)
            || string_field(&entry.metadata, "label") == Some(current_window)
    })
}

fn resolve_context_worktree_path(
    context: &SwitchableContext,
    current_managed_window: Option<&ManagedWindowEntry>,
) -> String {
    if let Some(worktree_path) =
        current_managed_window.and_then(|entry| string_field(&entry.metadata, "worktreePath"))
    {
        return clean_path_string(worktree_path);
    }
    clean_path_string(
        context
            .current_path
            .as_deref()
            .unwrap_or(&context.project_root),
    )
}

fn current_window_is_project_control(
    entries: &[ManagedWindowEntry],
    metadata_sessions: &BTreeMap<String, Value>,
    context: &SwitchableContext,
) -> bool {
    resolve_current_managed_window(entries, context)
        .is_some_and(|entry| is_project_control_window(metadata_sessions, &entry.metadata))
}

fn compare_switchable_windows(
    left: &ManagedWindowEntry,
    right: &ManagedWindowEntry,
    teammate_parent_session_id: Option<&str>,
) -> std::cmp::Ordering {
    if teammate_parent_session_id.is_some() {
        let left_order = team_number_field(&left.metadata, "order").unwrap_or(f64::INFINITY);
        let right_order = team_number_field(&right.metadata, "order").unwrap_or(f64::INFINITY);
        if left_order != right_order {
            return left_order.total_cmp(&right_order);
        }
        return target_number_field(&left.target, "windowIndex")
            .cmp(&target_number_field(&right.target, "windowIndex"));
    }
    let left_kind_rank = if string_field(&left.metadata, "kind") == Some("service") {
        1
    } else {
        0
    };
    let right_kind_rank = if string_field(&right.metadata, "kind") == Some("service") {
        1
    } else {
        0
    };
    left_kind_rank.cmp(&right_kind_rank).then_with(|| {
        target_number_field(&left.target, "windowIndex")
            .cmp(&target_number_field(&right.target, "windowIndex"))
    })
}

fn order_managed_entries_by_display_order<'a>(
    entries: Vec<(usize, &'a ManagedWindowEntry)>,
    display_order_ids: &[String],
) -> Vec<(usize, &'a ManagedWindowEntry)> {
    if display_order_ids.is_empty() {
        return entries;
    }
    let rank_by_id = display_order_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    let mut sorted = entries;
    sorted.sort_by(|(left_fallback, left), (right_fallback, right)| {
        let left_rank = string_field(&left.metadata, "sessionId")
            .and_then(|id| rank_by_id.get(id).copied())
            .unwrap_or(usize::MAX);
        let right_rank = string_field(&right.metadata, "sessionId")
            .and_then(|id| rank_by_id.get(id).copied())
            .unwrap_or(usize::MAX);
        left_rank
            .cmp(&right_rank)
            .then_with(|| left_fallback.cmp(right_fallback))
    });
    sorted
}

fn is_project_control_window(
    metadata_sessions: &BTreeMap<String, Value>,
    metadata: &Value,
) -> bool {
    team_is_project_control_session(Some(&metadata_with_stored_control_flags(
        metadata,
        metadata_sessions,
    )))
}

fn metadata_with_stored_control_flags(
    metadata: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
) -> Value {
    let session_id = string_field(metadata, "sessionId").unwrap_or("");
    session_with_stored_control_flags(metadata, metadata_sessions.get(session_id))
}

fn compact_session_title(metadata: &Value) -> String {
    resolve_statusline_model(&AgentDisplayInput::from_value(metadata)).compact_title()
}

fn urgency_for(metadata_sessions: &BTreeMap<String, Value>, session_id: &str) -> i64 {
    let Some(derived) = metadata_sessions
        .get(session_id)
        .and_then(|metadata| metadata.get("derived"))
    else {
        return 0;
    };
    match string_field(derived, "attention") {
        Some("error") => 5,
        Some("needs_input" | "needs_response") => 4,
        Some("blocked") => 3,
        _ if derived
            .get("unseenCount")
            .and_then(Value::as_i64)
            .is_some_and(|count| count > 0) =>
        {
            1
        }
        _ => 0,
    }
}

fn last_used_at<'a>(last_used: &'a Value, id: &str) -> Option<&'a str> {
    last_used
        .get("items")
        .and_then(|items| items.get(id))
        .and_then(|item| item.get("lastUsedAt"))
        .and_then(Value::as_str)
}

fn recent_rank(last_used: &Value, client_session: Option<&str>, id: &str) -> i64 {
    recent_ids(last_used, client_session)
        .iter()
        .position(|entry| entry == id)
        .map(|index| index as i64)
        .unwrap_or(MAX_SAFE_INTEGER)
}

fn recent_ids(last_used: &Value, client_session: Option<&str>) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(client_session) = client_session
        && let Some(client_ids) = last_used
            .get("clients")
            .and_then(|clients| clients.get(client_session))
            .and_then(|client| client.get("recentIds"))
            .and_then(Value::as_array)
    {
        ids.extend(
            client_ids
                .iter()
                .filter_map(|id| id.as_str().map(str::to_owned)),
        );
    }
    if let Some(project_ids) = last_used.get("projectRecentIds").and_then(Value::as_array) {
        for id in project_ids.iter().filter_map(Value::as_str) {
            if !ids.iter().any(|entry| entry == id) {
                ids.push(id.to_owned());
            }
        }
    }
    ids
}

fn format_relative_recency(value: &str) -> Option<String> {
    let timestamp = parse_recency_timestamp(value)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let delta_seconds = now.saturating_sub(timestamp) / 1000;
    if delta_seconds < 15 {
        return Some("just now".into());
    }
    if delta_seconds < 60 {
        return Some(format!("{delta_seconds}s ago"));
    }
    let minutes = delta_seconds / 60;
    if minutes < 60 {
        return Some(format!("{minutes}m ago"));
    }
    let hours = minutes / 60;
    if hours < 24 {
        return Some(format!("{hours}h ago"));
    }
    let days = hours / 24;
    if days < 7 {
        return Some(format!("{days}d ago"));
    }
    let weeks = days / 7;
    if weeks < 5 {
        return Some(format!("{weeks}w ago"));
    }
    let months = days / 30;
    if months < 12 {
        return Some(format!("{months}mo ago"));
    }
    Some(format!("{}y ago", days / 365))
}

fn dashboard_display_order_ids(desktop_state: Option<&Value>) -> Vec<String> {
    let mut ids = Vec::new();
    let Some(state) = desktop_state else {
        return ids;
    };
    for group_key in ["worktreeGroups", "groups"] {
        let Some(groups) = state.get(group_key).and_then(Value::as_array) else {
            continue;
        };
        for group in groups {
            for list_key in ["agents", "sessions", "services"] {
                if let Some(items) = group.get(list_key).and_then(Value::as_array) {
                    ids.extend(items.iter().filter_map(item_id));
                }
            }
        }
    }
    ids
}

fn item_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| string_field(value, "id").map(str::to_owned))
}

fn clean_path_string(path: &str) -> String {
    path_clean(Path::new(path)).to_string_lossy().into_owned()
}

fn path_clean(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                output.push(component)
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                output.pop();
            }
            std::path::Component::Normal(part) => output.push(part),
        }
    }
    output
}

fn is_dashboard_window_name(name: &str) -> bool {
    name == "dashboard" || name.starts_with("dashboard-")
}

fn user_label_chip(value: &str) -> Option<(&'static str, &'static str)> {
    match value {
        "working" => Some(("working", "Working")),
        "ready" => Some(("ready", "Ready")),
        "needs_input" => Some(("needs", "Needs input")),
        "needs_response" => Some(("needs", "Needs reply")),
        "next_step" => Some(("needs", "Next step")),
        "blocked" => Some(("blocked", "Blocked")),
        "error" => Some(("error", "Error")),
        "idle" => Some(("idle", "Idle")),
        "offline" => Some(("offline", "Offline")),
        "done" => Some(("done", "Done")),
        "interrupted" => Some(("idle", "Interrupted")),
        "starting" => Some(("working", "Starting")),
        "stopping" => Some(("idle", "Stopping")),
        "graveyarding" => Some(("offline", "Removing")),
        _ => None,
    }
}

fn attention_chip(value: &str) -> Option<(&'static str, &'static str)> {
    match value {
        "error" => Some(("error", "Error")),
        "blocked" => Some(("blocked", "Blocked")),
        "needs_input" => Some(("needs", "Needs input")),
        "needs_response" => Some(("needs", "Needs reply")),
        _ => None,
    }
}

fn activity_chip(value: &str) -> Option<(&'static str, &'static str)> {
    match value {
        "running" => Some(("working", "Working")),
        "waiting" => Some(("needs", "Waiting")),
        "done" => Some(("done", "Done")),
        "idle" => Some(("idle", "Idle")),
        "error" => Some(("error", "Error")),
        "interrupted" => Some(("idle", "Interrupted")),
        _ => None,
    }
}

fn team_string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get("team")
        .and_then(Value::as_object)
        .and_then(|team| team.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn team_number_field(value: &Value, key: &str) -> Option<f64> {
    value
        .get("team")
        .and_then(Value::as_object)
        .and_then(|team| team.get(key))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn target_string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn target_number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.into(), Value::String(value.to_owned()));
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        insert_string(map, key, value);
    }
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value
        && !value.is_null()
    {
        map.insert(key.into(), value);
    }
}
