use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_service_states, list_topology_session_states, read_runtime_topology,
    runtime_topology_path,
};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{query_params, trimmed_query};
use super::router::ProjectServiceRequestContext;
use super::usage::{load_last_used_state, parse_recency_timestamp};

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
}

pub fn route_switchable_agent_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
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
    let metadata = load_metadata_state(&project_state_dir);
    let entries = topology_switchable_entries(&topology, &metadata.sessions);
    let last_used = load_last_used_state(&project_state_dir);
    let items = list_switchable_agent_items(
        &entries,
        &metadata.sessions,
        &switch_context,
        &options,
        &last_used,
    )
    .into_iter()
    .map(|item| serialize_route_item(&item, options.raw_labels, expose))
    .collect::<Vec<_>>();
    Some(ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "items": items }),
    ))
}

pub fn topology_switchable_entries(
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
) -> Vec<ManagedWindowEntry> {
    let mut entries = Vec::new();
    for session in list_topology_session_states(topology, Some(LIVE_SESSION_STATUSES)) {
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
    let teammate_parent_session_id = current_managed_window
        .and_then(|entry| team_string_field(&entry.metadata, "parentSessionId"))
        .map(str::to_owned);
    let scoped_worktree_path = resolve_context_worktree_path(context, current_managed_window);
    let mut managed = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
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
            if is_scribe_window(metadata_sessions, &entry.metadata) {
                return false;
            }
            let overseer = is_overseer_window(metadata_sessions, &entry.metadata);
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
                return string_field(&entry.metadata, "kind") != Some("service")
                    && team_string_field(&entry.metadata, "parentSessionId")
                        == Some(teammate_parent_session_id);
            }
            if entry.metadata.get("team").is_some() {
                return false;
            }
            if options.scope == AgentListScope::All {
                return true;
            }
            clean_path_string(
                string_field(&entry.metadata, "worktreePath").unwrap_or(&context.project_root),
            ) == scoped_worktree_path
        })
        .collect::<Vec<_>>();
    managed.sort_by(|(_, left), (_, right)| {
        compare_switchable_windows(left, right, teammate_parent_session_id.as_deref())
    });
    order_managed_entries_by_display_order(managed, &options.display_order_ids)
        .into_iter()
        .map(|(_, entry)| {
            let id = string_field(&entry.metadata, "sessionId")
                .unwrap_or("")
                .to_owned();
            let last_used_at = last_used_at(last_used, &id).map(str::to_owned);
            let recent_rank =
                recent_rank(last_used, context.current_client_session.as_deref(), &id);
            SwitchableAgentItem {
                id: id.clone(),
                target: entry.target.clone(),
                metadata: entry.metadata.clone(),
                label: compact_session_title(&entry.metadata),
                urgency: urgency_for(metadata_sessions, &id),
                activity: entry.activity,
                last_used_at,
                recent_rank,
                overseer: is_overseer_window(metadata_sessions, &entry.metadata),
                scribe: is_scribe_window(metadata_sessions, &entry.metadata),
                alive: entry.alive,
            }
        })
        .collect()
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
    if let Some(role) = team_string_field(session, "role") {
        insert_string(&mut metadata, "role", role);
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

fn serialize_route_item(item: &SwitchableAgentItem, raw_labels: bool, expose: bool) -> Value {
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
    if expose
        && let Some(chip) = agent_status_chip(&item.metadata)
        && let Value::Object(map) = &mut serialized
    {
        map.insert("exposeStatus".into(), chip);
    }
    serialized
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
    let session_id = string_field(metadata, "sessionId").unwrap_or("");
    let session_metadata = metadata_sessions.get(session_id);
    if session_metadata.and_then(|value| value.get("overseer")) == Some(&Value::Bool(true))
        || session_metadata.and_then(|value| value.get("scribe")) == Some(&Value::Bool(true))
    {
        return true;
    }
    if session_metadata.and_then(|value| value.get("scribe")) == Some(&Value::Bool(false)) {
        return is_project_control_session(
            metadata.get("team"),
            session_metadata
                .and_then(|value| value.get("overseer"))
                .and_then(Value::as_bool)
                .or_else(|| metadata.get("overseer").and_then(Value::as_bool)),
            Some(false),
            metadata.get("projectControl").and_then(Value::as_bool),
        );
    }
    if let Some(project_control) = metadata.get("projectControl").and_then(Value::as_bool) {
        return project_control;
    }
    is_project_control_session(
        metadata.get("team"),
        session_metadata
            .and_then(|value| value.get("overseer"))
            .and_then(Value::as_bool)
            .or_else(|| metadata.get("overseer").and_then(Value::as_bool)),
        session_metadata
            .and_then(|value| value.get("scribe"))
            .and_then(Value::as_bool)
            .or_else(|| metadata.get("scribe").and_then(Value::as_bool)),
        metadata.get("projectControl").and_then(Value::as_bool),
    )
}

fn is_project_control_session(
    team: Option<&Value>,
    overseer: Option<bool>,
    scribe: Option<bool>,
    project_control: Option<bool>,
) -> bool {
    project_control == Some(true)
        || overseer == Some(true)
        || team_role(team) == Some("overseer")
        || is_scribe_session(team, scribe)
}

fn is_overseer_window(metadata_sessions: &BTreeMap<String, Value>, metadata: &Value) -> bool {
    let session_id = string_field(metadata, "sessionId").unwrap_or("");
    metadata_sessions
        .get(session_id)
        .and_then(|value| value.get("overseer"))
        .and_then(Value::as_bool)
        == Some(true)
        || metadata.get("overseer").and_then(Value::as_bool) == Some(true)
        || team_role(metadata.get("team")) == Some("overseer")
}

fn is_scribe_window(metadata_sessions: &BTreeMap<String, Value>, metadata: &Value) -> bool {
    let session_id = string_field(metadata, "sessionId").unwrap_or("");
    let session_metadata = metadata_sessions.get(session_id);
    if session_metadata
        .and_then(|value| value.get("scribe"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    if session_metadata
        .and_then(|value| value.get("scribe"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return false;
    }
    if metadata.get("projectControl").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    is_scribe_session(
        metadata.get("team"),
        session_metadata
            .and_then(|value| value.get("scribe"))
            .and_then(Value::as_bool)
            .or_else(|| metadata.get("scribe").and_then(Value::as_bool)),
    )
}

fn is_scribe_session(team: Option<&Value>, scribe: Option<bool>) -> bool {
    if scribe == Some(false) {
        return false;
    }
    scribe == Some(true) || team_role(team) == Some("scribe")
}

fn compact_session_title(metadata: &Value) -> String {
    if string_field(metadata, "kind") == Some("service")
        && let Some(command) = string_field(metadata, "launchCommandLine")
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return command.to_owned();
    }
    let tool = string_field(metadata, "command").unwrap_or("");
    let id = string_field(metadata, "sessionId").unwrap_or("");
    let base = if string_field(metadata, "kind") == Some("service") {
        string_field(metadata, "label")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(if tool.is_empty() { "service" } else { tool })
            .to_owned()
    } else if !is_autogenerated_session_label(metadata) {
        string_field(metadata, "label")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(if tool.is_empty() { id } else { tool })
            .to_owned()
    } else if tool.is_empty() {
        id.to_owned()
    } else {
        tool.to_owned()
    };
    if string_field(metadata, "kind") == Some("service") {
        return format!("{base}[svc]");
    }
    if let Some(role) = string_field(metadata, "role") {
        return format!("{base}({role})");
    }
    base
}

fn is_autogenerated_session_label(metadata: &Value) -> bool {
    let label = string_field(metadata, "label")
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    let tool = string_field(metadata, "command")
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    match (label, tool) {
        (Some(label), Some(tool)) if !label.is_empty() && !tool.is_empty() => {
            label == tool || label.starts_with(&format!("{tool}-"))
        }
        _ => false,
    }
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

fn team_role(team: Option<&Value>) -> Option<&str> {
    team.and_then(|team| team.get("role"))
        .and_then(Value::as_str)
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
