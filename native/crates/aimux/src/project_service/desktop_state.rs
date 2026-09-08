use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::config::default_config;
use crate::daemon_state::{load_daemon_info, load_metadata_state};
use crate::paths::PathResolver;
use crate::project_api_contract::routes;
use crate::project_service_manifest::get_project_service_manifest;
use crate::runtime_topology::{
    list_topology_service_states, list_topology_worktree_states, read_runtime_topology,
    runtime_topology_path,
};

use super::agent_output::{AgentOutputCaptureRuntime, SystemAgentOutputCaptureRuntime};
use super::agents::topology_desktop_session_list;
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::query_params;
use super::preview_snapshots::{
    DEFAULT_PREVIEW_CAPTURE_LINES, DEFAULT_PREVIEW_MAX_CHARS, capture_preview_snapshot,
};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{read_runtime_exchange, runtime_exchange_path};
use super::session_semantics::{SessionSemanticsInput, derive_session_semantics};
use super::usage::parse_recency_timestamp;
use super::visual_clients::VisualClientLeaseRoute;

const ACTIVE_WORKTREE_STATUSES: &[&str] = &[
    "planned", "creating", "active", "removing", "missing", "error",
];
const DASHBOARD_SESSION_STATUSES: &[&str] = &["starting", "running", "idle", "offline"];
const DASHBOARD_SERVICE_STATUSES: &[&str] = &[
    "planned", "starting", "running", "stopped", "offline", "error",
];
const NOTIFICATION_TAG: &str = "notification";

#[derive(Debug, Clone, Default)]
struct ThreadStats {
    unread: i64,
    waiting: i64,
    waiting_on_me: i64,
    waiting_on_them: i64,
    pending: i64,
    latest_id: Option<String>,
    latest_title: Option<String>,
    latest_updated_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct WorkflowStats {
    on_me: i64,
    blocked: i64,
    families: BTreeSet<String>,
    top_urgency: i64,
    top_label: Option<String>,
    next_action: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct NotificationStats {
    unread_count: i64,
    needs_input_unread_count: i64,
    latest_unread: Option<Value>,
    latest_text: Option<String>,
    latest_updated_at: Option<String>,
}

pub fn route_desktop_state_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemAgentOutputCaptureRuntime;
    route_desktop_state_request_with_runtime(context, method, path, &mut runtime)
}

pub fn route_desktop_state_request_with_runtime(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET")
        || project_service_pathname(path) != routes::DESKTOP_STATE
    {
        return None;
    }
    let params = query_params(path);
    let include_preview = matches!(
        params.get("includePreview").map(String::as_str),
        Some("1" | "true")
    );
    let include_chat_preview = matches!(
        params.get("includeChatPreview").map(String::as_str),
        Some("1" | "true")
    );
    if include_preview || include_chat_preview {
        touch_desktop_preview_client(context, &params, include_preview, include_chat_preview);
    }
    if let Some(desktop_state) = context.desktop_state.as_ref() {
        let mut body = desktop_state.as_object().cloned().unwrap_or_default();
        body.insert("ok".into(), Value::Bool(true));
        body.insert("serviceInfo".into(), service_info());
        body.insert("pendingInteractions".into(), Value::Array(Vec::new()));
        let body = if include_preview {
            attach_desktop_state_previews(context, Value::Object(body), runtime)
        } else {
            Value::Object(body)
        };
        return Some(ProjectServiceDispatchResponse::json(200, body));
    }
    let mut state = match desktop_state_for_context(context) {
        Ok(state) => state,
        Err(error) => {
            return Some(ProjectServiceDispatchResponse::json(
                500,
                json!({ "ok": false, "error": error }),
            ));
        }
    };
    if include_preview {
        state = attach_desktop_state_previews(context, state, runtime);
    }
    Some(ProjectServiceDispatchResponse::json(200, state))
}

fn touch_desktop_preview_client(
    context: &ProjectServiceRequestContext,
    params: &BTreeMap<String, String>,
    requested_preview: bool,
    requested_chat_preview: bool,
) -> bool {
    context.visual_clients.touch_route_lease(
        params,
        VisualClientLeaseRoute {
            surface: "desktop-state",
            requested_preview,
            requested_chat_preview,
            default_kind: None,
        },
        context.project_root(),
        &context.project_state_dir(),
    )
}

pub fn desktop_state_for_context(context: &ProjectServiceRequestContext) -> Result<Value, String> {
    if let Some(desktop_state) = context.desktop_state.as_ref() {
        return Ok(desktop_state.clone());
    }
    let project_state_dir = context.project_state_dir();
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))?;
    let metadata = load_metadata_state(&project_state_dir);
    let exchange = read_runtime_exchange(runtime_exchange_path(&project_state_dir));
    Ok(build_desktop_state(DesktopStateInput {
        project_root: context.project_root().to_string_lossy().into_owned(),
        topology: &topology,
        metadata_sessions: &metadata.sessions,
        exchange: &exchange,
    }))
}

pub struct DesktopStateInput<'a> {
    pub project_root: String,
    pub topology: &'a Value,
    pub metadata_sessions: &'a BTreeMap<String, Value>,
    pub exchange: &'a Value,
}

pub fn build_desktop_state(input: DesktopStateInput<'_>) -> Value {
    let tools = default_config()
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let all_sessions =
        topology_desktop_session_list(input.topology, input.metadata_sessions, &tools)
            .into_iter()
            .filter(|session| {
                string_field(session, "status")
                    .is_some_and(|status| DASHBOARD_SESSION_STATUSES.contains(&status))
            })
            .collect::<Vec<_>>();
    let worktrees = desktop_worktrees(&input.project_root, input.topology);
    let worktree_by_path = worktrees
        .iter()
        .filter_map(|worktree| {
            string_field(worktree, "path").map(|path| (path.to_owned(), worktree.clone()))
        })
        .collect::<BTreeMap<_, _>>();
    let thread_stats = summarize_thread_stats(input.exchange);
    let workflow_stats = summarize_workflow_stats(input.exchange);
    let notification_stats = summarize_notification_stats(input.exchange);
    let active_tasks = summarize_active_tasks(input.exchange);
    let mut sessions = Vec::new();
    let mut teammates = Vec::new();
    for session in all_sessions {
        let dashboard_session = dashboard_session(
            &session,
            input.metadata_sessions,
            &worktree_by_path,
            &thread_stats,
            &workflow_stats,
            &notification_stats,
            &active_tasks,
        );
        if is_teammate_session(&dashboard_session) {
            teammates.push(dashboard_session);
        } else {
            sessions.push(dashboard_session);
        }
    }
    set_indexes(&mut sessions);
    set_indexes(&mut teammates);
    let services = list_topology_service_states(input.topology, Some(DASHBOARD_SERVICE_STATUSES))
        .iter()
        .map(|service| dashboard_service(service, input.metadata_sessions, &worktree_by_path))
        .collect::<Vec<_>>();
    let worktree_groups =
        build_worktree_groups(&input.project_root, &worktrees, &sessions, &services);
    let mut state = Map::new();
    state.insert("ok".into(), Value::Bool(true));
    state.insert("serviceInfo".into(), service_info());
    state.insert("pendingInteractions".into(), Value::Array(Vec::new()));
    state.insert("sessions".into(), Value::Array(sessions));
    state.insert("teammates".into(), Value::Array(teammates));
    state.insert("services".into(), Value::Array(services));
    state.insert("worktrees".into(), Value::Array(worktrees));
    state.insert("worktreeGroups".into(), Value::Array(worktree_groups));
    state.insert("operationFailures".into(), Value::Array(Vec::new()));
    state.insert("agentRestoreOffer".into(), Value::Null);
    state.insert(
        "mainCheckoutInfo".into(),
        json!({
            "name": "Main Checkout",
            "branch": main_checkout_branch(&input.project_root, state.get("worktrees")),
        }),
    );
    state.insert(
        "mainCheckoutPath".into(),
        Value::String(input.project_root.clone()),
    );
    state.insert("controlPlane".into(), control_plane());
    state.insert("tasks".into(), task_counts(input.exchange));
    Value::Object(state)
}

pub fn attach_desktop_state_previews(
    context: &ProjectServiceRequestContext,
    mut state: Value,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> Value {
    let Some(sessions) = state.get_mut("sessions").and_then(Value::as_array_mut) else {
        return state;
    };
    for session in sessions {
        if string_field(session, "id").is_none() {
            continue;
        }
        let Some(window_id) = string_field(session, "tmuxWindowId").map(str::to_owned) else {
            continue;
        };
        let Some(preview) = capture_preview_snapshot(
            context,
            &window_id,
            runtime,
            DEFAULT_PREVIEW_CAPTURE_LINES,
            DEFAULT_PREVIEW_MAX_CHARS,
        ) else {
            continue;
        };
        if let Some(object) = session.as_object_mut() {
            object.insert("previewSnapshot".into(), preview);
        }
    }
    state
}

fn desktop_worktrees(project_root: &str, topology: &Value) -> Vec<Value> {
    let mut worktrees = list_topology_worktree_states(topology, Some(ACTIVE_WORKTREE_STATUSES))
        .into_iter()
        .map(|worktree| {
            let mut item = Map::new();
            let path = string_field(&worktree, "path").unwrap_or(project_root);
            insert_string(
                &mut item,
                "name",
                string_field(&worktree, "name")
                    .unwrap_or_else(|| path_basename(path).unwrap_or(path)),
            );
            insert_string(&mut item, "path", path);
            insert_string(
                &mut item,
                "branch",
                string_field(&worktree, "branch").unwrap_or(""),
            );
            item.insert("isBare".into(), Value::Bool(false));
            for key in [
                "createdAt",
                "pending",
                "removing",
                "pendingAction",
                "operationFailure",
            ] {
                insert_value(&mut item, key, worktree.get(key).cloned());
            }
            Value::Object(item)
        })
        .collect::<Vec<_>>();
    if !worktrees
        .iter()
        .any(|worktree| string_field(worktree, "path") == Some(project_root))
    {
        worktrees.insert(
            0,
            json!({
                "name": "Main Checkout",
                "path": project_root,
                "branch": "",
                "isBare": false,
            }),
        );
    }
    sort_worktrees(&mut worktrees, project_root);
    worktrees
}

fn dashboard_session(
    session: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
    worktree_by_path: &BTreeMap<String, Value>,
    thread_stats: &BTreeMap<String, ThreadStats>,
    workflow_stats: &BTreeMap<String, WorkflowStats>,
    notification_stats: &BTreeMap<String, NotificationStats>,
    active_tasks: &BTreeSet<String>,
) -> Value {
    let id = string_field(session, "id").unwrap_or("");
    let metadata = metadata_sessions.get(id);
    let pending_action = string_field(session, "pendingAction").map(str::to_owned);
    let raw_status = dashboard_session_status(string_field(session, "status"));
    let mut item = Map::new();
    insert_string(&mut item, "id", id);
    insert_optional(&mut item, "command", string_field(session, "command"));
    insert_optional(&mut item, "tool", string_field(session, "tool"));
    insert_optional(
        &mut item,
        "toolConfigKey",
        string_field(session, "toolConfigKey"),
    );
    insert_optional(
        &mut item,
        "backendSessionId",
        string_field(session, "backendSessionId"),
    );
    insert_string(&mut item, "status", raw_status);
    item.insert(
        "active".into(),
        Value::Bool(matches!(
            string_field(session, "status"),
            Some("running" | "idle")
        )),
    );
    for key in [
        "createdAt",
        "headline",
        "restoreState",
        "restoreBlockedReason",
        "freshRelaunchAllowed",
        "team",
        "label",
        "worktreePath",
        "lastUsedAt",
        "pendingAction",
        "pendingStartedAt",
        "foregroundCommand",
        "pid",
        "previewLine",
    ] {
        insert_value(&mut item, key, session.get(key).cloned());
    }
    if let Some(cwd) = string_field(session, "worktreePath") {
        insert_string(&mut item, "cwd", cwd);
    }
    if let Some(target) = session.get("tmuxTarget") {
        insert_value(&mut item, "tmuxWindowId", target.get("windowId").cloned());
        insert_value(
            &mut item,
            "tmuxWindowIndex",
            target.get("windowIndex").cloned(),
        );
    }
    if let Some(role) = team_string_field(session, "role") {
        insert_string(&mut item, "role", role);
    }
    if let Some(worktree) =
        string_field(session, "worktreePath").and_then(|path| worktree_by_path.get(path))
    {
        insert_optional(&mut item, "worktreeName", string_field(worktree, "name"));
        insert_optional(
            &mut item,
            "worktreeBranch",
            string_field(worktree, "branch"),
        );
    }
    let mut activity = None;
    let mut attention = None;
    let mut unseen_count = 0;
    if let Some(metadata) = metadata {
        for key in [
            "loop",
            "loopLastAction",
            "overseer",
            "scribe",
            "projectControl",
        ] {
            insert_value(&mut item, key, metadata.get(key).cloned());
        }
        if let Some(derived) = metadata.get("derived") {
            for key in [
                "activity",
                "attention",
                "unseenCount",
                "lastOutputAt",
                "becameIdleAt",
                "lastEvent",
                "services",
                "shellCommand",
                "shellCommandState",
                "foregroundCommand",
                "pid",
                "previewLine",
            ] {
                insert_value(&mut item, key, derived.get(key).cloned());
            }
            activity = string_field(derived, "activity").map(str::to_owned);
            attention = string_field(derived, "attention").map(str::to_owned);
            unseen_count = integer_field(derived, "unseenCount");
        }
    }
    let thread = thread_stats.get(id).cloned().unwrap_or_default();
    let workflow = workflow_stats.get(id).cloned().unwrap_or_default();
    let notifications = notification_stats.get(id).cloned().unwrap_or_default();
    item.insert("threadUnreadCount".into(), Value::from(thread.unread));
    item.insert("threadWaitingCount".into(), Value::from(thread.waiting));
    item.insert(
        "threadWaitingOnMeCount".into(),
        Value::from(thread.waiting_on_me),
    );
    item.insert(
        "threadWaitingOnThemCount".into(),
        Value::from(thread.waiting_on_them),
    );
    item.insert("threadPendingCount".into(), Value::from(thread.pending));
    insert_optional_owned(&mut item, "threadId", thread.latest_id.clone());
    insert_optional_owned(&mut item, "threadName", thread.latest_title.clone());
    item.insert("workflowOnMeCount".into(), Value::from(workflow.on_me));
    item.insert("workflowBlockedCount".into(), Value::from(workflow.blocked));
    item.insert(
        "workflowFamilyCount".into(),
        Value::from(workflow.families.len() as i64),
    );
    insert_optional_owned(&mut item, "workflowTopLabel", workflow.top_label.clone());
    insert_optional_owned(
        &mut item,
        "workflowNextAction",
        workflow.next_action.clone(),
    );
    item.insert(
        "notificationUnreadCount".into(),
        Value::from(notifications.unread_count),
    );
    item.insert(
        "notificationNeedsInputUnreadCount".into(),
        Value::from(notifications.needs_input_unread_count),
    );
    if let Some(text) = notifications.latest_text.clone() {
        item.insert("latestNotificationText".into(), Value::String(text));
    }
    let semantic = derive_session_semantics(SessionSemanticsInput {
        status: raw_status.to_owned(),
        pending_action,
        activity,
        attention,
        unseen_count,
        notification_unread_count: notifications.unread_count,
        latest_notification: notifications.latest_unread.clone(),
        latest_notification_text: notifications.latest_text.clone(),
        thread_unread_count: thread.unread,
        thread_pending_count: thread.pending,
        thread_waiting_on_me_count: thread.waiting_on_me,
        thread_waiting_on_them_count: thread.waiting_on_them,
        workflow_on_me_count: workflow.on_me,
        workflow_blocked_count: workflow.blocked,
        workflow_family_count: workflow.families.len() as i64,
        has_active_task: active_tasks.contains(id),
    });
    let live_label = semantic
        .get("user")
        .and_then(|user| string_field(user, "label"))
        .unwrap_or("");
    let notification_stale = semantic
        .get("runtime")
        .and_then(|runtime| runtime.get("isAlive"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && is_notification_stale(live_label, notifications.needs_input_unread_count > 0);
    item.insert("notificationStale".into(), Value::Bool(notification_stale));
    item.insert("semantic".into(), semantic);
    if !item.contains_key("overseer") {
        item.insert("overseer".into(), Value::Bool(false));
    }
    if !item.contains_key("scribe") {
        item.insert("scribe".into(), Value::Bool(false));
    }
    Value::Object(item)
}

fn dashboard_service(
    service: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
    worktree_by_path: &BTreeMap<String, Value>,
) -> Value {
    let id = string_field(service, "id").unwrap_or("");
    let mut item = Map::new();
    insert_string(&mut item, "id", id);
    insert_optional(&mut item, "command", string_field(service, "command"));
    insert_value(&mut item, "args", service.get("args").cloned());
    insert_string(
        &mut item,
        "status",
        dashboard_service_status(string_field(service, "status")),
    );
    item.insert(
        "active".into(),
        Value::Bool(matches!(
            string_field(service, "status"),
            Some("running" | "starting")
        )),
    );
    for key in [
        "createdAt",
        "lastSeenAt",
        "lastUsedAt",
        "worktreePath",
        "label",
        "launchCommandLine",
        "foregroundCommand",
        "pid",
        "previewLine",
        "pendingAction",
        "pendingStartedAt",
    ] {
        insert_value(&mut item, key, service.get(key).cloned());
    }
    if let Some(target) = service.get("tmuxTarget") {
        insert_value(&mut item, "tmuxWindowId", target.get("windowId").cloned());
        insert_value(
            &mut item,
            "tmuxWindowIndex",
            target.get("windowIndex").cloned(),
        );
    }
    if let Some(worktree) =
        string_field(service, "worktreePath").and_then(|path| worktree_by_path.get(path))
    {
        insert_optional(&mut item, "worktreeName", string_field(worktree, "name"));
        insert_optional(
            &mut item,
            "worktreeBranch",
            string_field(worktree, "branch"),
        );
    }
    if let Some(derived) = metadata_sessions
        .get(id)
        .and_then(|metadata| metadata.get("derived"))
    {
        for key in [
            "shellCommand",
            "shellCommandState",
            "foregroundCommand",
            "pid",
            "previewLine",
        ] {
            insert_value(&mut item, key, derived.get(key).cloned());
        }
    }
    Value::Object(item)
}

fn build_worktree_groups(
    project_root: &str,
    worktrees: &[Value],
    sessions: &[Value],
    services: &[Value],
) -> Vec<Value> {
    let main_path = project_root;
    let mut group_paths = worktrees
        .iter()
        .filter_map(|worktree| string_field(worktree, "path").map(str::to_owned))
        .collect::<BTreeSet<_>>();
    for item in sessions.iter().chain(services.iter()) {
        if let Some(path) = string_field(item, "worktreePath") {
            group_paths.insert(path.to_owned());
        }
    }
    let mut groups = Vec::new();
    groups.push(worktree_group(
        worktrees
            .iter()
            .find(|worktree| string_field(worktree, "path") == Some(main_path)),
        main_path,
        true,
        sessions,
        services,
    ));
    let mut secondary = group_paths
        .into_iter()
        .filter(|path| path != main_path)
        .map(|path| {
            worktree_group(
                worktrees
                    .iter()
                    .find(|worktree| string_field(worktree, "path") == Some(path.as_str())),
                &path,
                false,
                sessions,
                services,
            )
        })
        .collect::<Vec<_>>();
    secondary.sort_by(|left, right| {
        dashboard_created_sort_key(right).cmp(&dashboard_created_sort_key(left))
    });
    groups.extend(secondary);
    groups
}

fn worktree_group(
    worktree: Option<&Value>,
    path: &str,
    main: bool,
    sessions: &[Value],
    services: &[Value],
) -> Value {
    let mut group = Map::new();
    insert_string(
        &mut group,
        "name",
        if main {
            "Main Checkout"
        } else {
            worktree
                .and_then(|worktree| string_field(worktree, "name"))
                .unwrap_or_else(|| path_basename(path).unwrap_or(path))
        },
    );
    insert_string(
        &mut group,
        "branch",
        worktree
            .and_then(|worktree| string_field(worktree, "branch"))
            .unwrap_or(""),
    );
    if !main {
        insert_string(&mut group, "path", path);
    }
    for key in [
        "createdAt",
        "pending",
        "removing",
        "pendingAction",
        "operationFailure",
    ] {
        insert_value(
            &mut group,
            key,
            worktree.and_then(|worktree| worktree.get(key)).cloned(),
        );
    }
    let group_sessions = sorted_dashboard_items(
        sessions
            .iter()
            .filter(|session| {
                !is_project_control_session(session)
                    && if main {
                        string_field(session, "worktreePath").is_none_or(|value| value == path)
                    } else {
                        string_field(session, "worktreePath") == Some(path)
                    }
            })
            .cloned()
            .collect(),
    );
    let group_services = sorted_dashboard_items(
        services
            .iter()
            .filter(|service| {
                if main {
                    string_field(service, "worktreePath").is_none_or(|value| value == path)
                } else {
                    string_field(service, "worktreePath") == Some(path)
                }
            })
            .cloned()
            .collect(),
    );
    let active = !group_sessions.is_empty() || !group_services.is_empty();
    group.insert(
        "status".into(),
        Value::String(if active { "active" } else { "offline" }.into()),
    );
    group.insert("sessions".into(), Value::Array(group_sessions));
    group.insert("services".into(), Value::Array(group_services));
    Value::Object(group)
}

fn set_indexes(items: &mut [Value]) {
    for (index, item) in items.iter_mut().enumerate() {
        if let Value::Object(map) = item {
            map.insert("index".into(), Value::from(index as i64));
        }
    }
}

fn sorted_dashboard_items(mut items: Vec<Value>) -> Vec<Value> {
    items.sort_by(|left, right| {
        dashboard_created_sort_key(right).cmp(&dashboard_created_sort_key(left))
    });
    items
}

fn summarize_thread_stats(exchange: &Value) -> BTreeMap<String, ThreadStats> {
    let mut stats: BTreeMap<String, ThreadStats> = BTreeMap::new();
    for thread in array_field(exchange, "threads") {
        if string_array_field(thread, "tags")
            .iter()
            .any(|tag| tag == NOTIFICATION_TAG)
        {
            continue;
        }
        let thread_id = string_field(thread, "id").unwrap_or("");
        let pending_by_participant = pending_deliveries_by_participant(exchange, thread_id);
        for participant in string_array_field(thread, "participants") {
            let current = stats.entry(participant.clone()).or_default();
            if string_array_field(thread, "unreadBy")
                .iter()
                .any(|value| value == &participant)
            {
                current.unread += 1;
            }
            let waits_on_participant = string_array_field(thread, "waitingOn")
                .iter()
                .any(|value| value == &participant);
            let owned_by_participant = string_field(thread, "owner") == Some(participant.as_str());
            if waits_on_participant || owned_by_participant {
                current.waiting += 1;
            }
            if waits_on_participant {
                current.waiting_on_me += 1;
            }
            if owned_by_participant && !string_array_field(thread, "waitingOn").is_empty() {
                current.waiting_on_them += 1;
            }
            current.pending += pending_by_participant
                .get(&participant)
                .copied()
                .unwrap_or_default();
            let updated_at = string_field(thread, "updatedAt").map(str::to_owned);
            if current.latest_id.is_none()
                || updated_at.as_deref() > current.latest_updated_at.as_deref()
            {
                current.latest_id = Some(thread_id.to_owned());
                current.latest_title = string_field(thread, "title").map(str::to_owned);
                current.latest_updated_at = updated_at;
            }
        }
    }
    stats
}

fn summarize_workflow_stats(exchange: &Value) -> BTreeMap<String, WorkflowStats> {
    let tasks = array_field(exchange, "tasks");
    let mut family_sizes = BTreeMap::<String, i64>::new();
    for task in tasks {
        let root = string_field(task, "reviewOf")
            .or_else(|| string_field(task, "id"))
            .unwrap_or("");
        if !root.is_empty() {
            *family_sizes.entry(root.to_owned()).or_default() += 1;
        }
    }
    let mut task_by_id = BTreeMap::<String, &Value>::new();
    for task in tasks {
        if let Some(id) = string_field(task, "id") {
            task_by_id.insert(id.to_owned(), task);
        }
    }

    let mut stats: BTreeMap<String, WorkflowStats> = BTreeMap::new();
    for thread in array_field(exchange, "threads") {
        if string_array_field(thread, "tags")
            .iter()
            .any(|tag| tag == NOTIFICATION_TAG)
        {
            continue;
        }
        let task =
            string_field(thread, "taskId").and_then(|task_id| task_by_id.get(task_id).copied());
        let family_key = task
            .and_then(|task| string_field(task, "reviewOf").or_else(|| string_field(task, "id")))
            .or_else(|| string_field(thread, "id"))
            .unwrap_or("");
        let blocked = string_field(thread, "status") == Some("blocked")
            || task.is_some_and(|task| string_field(task, "status") == Some("blocked"));
        let urgency = i64::from(blocked) * 8
            + string_array_field(thread, "waitingOn").len() as i64 * 10
            + pending_deliveries_for_thread(exchange, string_field(thread, "id").unwrap_or("")) * 4
            + string_array_field(thread, "unreadBy").len() as i64 * 3;
        let state_label = workflow_state_label(thread, task);
        let display_title = string_field(thread, "title").unwrap_or("");
        for participant in string_array_field(thread, "participants") {
            let current = stats.entry(participant.clone()).or_default();
            if string_array_field(thread, "waitingOn")
                .iter()
                .any(|value| value == &participant)
            {
                current.on_me += 1;
            }
            if blocked {
                current.blocked += 1;
            }
            if family_sizes.get(family_key).copied().unwrap_or_default() > 1 {
                current.families.insert(family_key.to_owned());
            }
            if current.top_label.is_none() || urgency > current.top_urgency {
                current.top_urgency = urgency;
                current.top_label = Some(format!("{display_title} ({state_label})"));
                current.next_action =
                    Some(describe_workflow_next_action(thread, task, &participant));
            }
        }
    }
    stats
}

fn summarize_notification_stats(exchange: &Value) -> BTreeMap<String, NotificationStats> {
    let mut stats: BTreeMap<String, NotificationStats> = BTreeMap::new();
    for thread in array_field(exchange, "threads") {
        if !string_array_field(thread, "tags")
            .iter()
            .any(|tag| tag == NOTIFICATION_TAG)
        {
            continue;
        }
        let participant = string_array_field(thread, "participants")
            .into_iter()
            .find(|participant| participant != "aimux")
            .unwrap_or_else(|| "project".to_owned());
        if !string_array_field(thread, "unreadBy")
            .iter()
            .any(|value| value == &participant)
        {
            continue;
        }
        let current = stats.entry(participant.clone()).or_default();
        current.unread_count += 1;
        let message = latest_message_for_thread(exchange, string_field(thread, "id").unwrap_or(""));
        let metadata = message.and_then(|message| message.get("metadata"));
        if metadata.and_then(|metadata| string_field(metadata, "kind")) == Some("needs_input") {
            current.needs_input_unread_count += 1;
        }
        let updated_at = string_field(thread, "updatedAt").map(str::to_owned);
        if current.latest_unread.is_none()
            || updated_at.as_deref() > current.latest_updated_at.as_deref()
        {
            current.latest_updated_at = updated_at;
            current.latest_text = message
                .and_then(|message| string_field(message, "body"))
                .or_else(|| string_field(thread, "title"))
                .map(str::to_owned);
            current.latest_unread = Some(notification_record(thread, message));
        }
    }
    stats
}

fn summarize_active_tasks(exchange: &Value) -> BTreeSet<String> {
    array_field(exchange, "tasks")
        .iter()
        .filter(|task| {
            matches!(
                string_field(task, "status"),
                Some("assigned" | "in_progress" | "blocked")
            )
        })
        .filter_map(|task| {
            string_field(task, "assignedTo")
                .or_else(|| string_field(task, "assignee"))
                .map(str::to_owned)
        })
        .collect()
}

fn pending_deliveries_by_participant(exchange: &Value, thread_id: &str) -> BTreeMap<String, i64> {
    let mut pending = BTreeMap::new();
    for message in messages_for_thread(exchange, thread_id) {
        let delivered_to = string_array_field(message, "deliveredTo");
        for recipient in string_array_field(message, "to") {
            if !delivered_to.iter().any(|delivered| delivered == &recipient) {
                *pending.entry(recipient).or_default() += 1;
            }
        }
    }
    pending
}

fn pending_deliveries_for_thread(exchange: &Value, thread_id: &str) -> i64 {
    pending_deliveries_by_participant(exchange, thread_id)
        .values()
        .sum()
}

fn messages_for_thread<'a>(exchange: &'a Value, thread_id: &str) -> Vec<&'a Value> {
    array_field(exchange, "messages")
        .iter()
        .filter(|message| string_field(message, "threadId") == Some(thread_id))
        .collect()
}

fn latest_message_for_thread<'a>(exchange: &'a Value, thread_id: &str) -> Option<&'a Value> {
    messages_for_thread(exchange, thread_id)
        .into_iter()
        .max_by(|left, right| string_field(left, "ts").cmp(&string_field(right, "ts")))
}

fn notification_record(thread: &Value, message: Option<&Value>) -> Value {
    let metadata = message
        .and_then(|message| message.get("metadata"))
        .unwrap_or(&Value::Null);
    json!({
        "id": metadata.get("notificationRecordId")
            .or_else(|| metadata.get("recordId"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| string_field(thread, "id").unwrap_or("")),
        "threadId": string_field(thread, "id").unwrap_or(""),
        "sessionId": metadata.get("sessionId").and_then(Value::as_str).unwrap_or(""),
        "kind": metadata.get("kind").and_then(Value::as_str).unwrap_or("notification"),
        "title": string_field(thread, "title").unwrap_or("aimux"),
        "body": message.and_then(|message| string_field(message, "body")).unwrap_or(""),
        "createdAt": message.and_then(|message| string_field(message, "ts"))
            .or_else(|| string_field(thread, "createdAt"))
            .unwrap_or(""),
    })
}

fn workflow_state_label(thread: &Value, task: Option<&Value>) -> String {
    if string_field(thread, "status") == Some("blocked") {
        "blocked".into()
    } else if !string_array_field(thread, "waitingOn").is_empty() {
        format!("on {}", string_array_field(thread, "waitingOn").join(", "))
    } else {
        task.and_then(|task| string_field(task, "status"))
            .or_else(|| string_field(thread, "status"))
            .unwrap_or("")
            .to_owned()
    }
}

fn describe_workflow_next_action(
    thread: &Value,
    task: Option<&Value>,
    participant: &str,
) -> String {
    if string_array_field(thread, "waitingOn")
        .iter()
        .any(|value| value == participant)
    {
        "reply".into()
    } else if task.is_some() {
        "open task".into()
    } else {
        "open thread".into()
    }
}

fn is_notification_stale(live_label: &str, has_unread_needs_input: bool) -> bool {
    has_unread_needs_input
        && !live_label.is_empty()
        && !matches!(
            live_label,
            "needs_input" | "needs_response" | "blocked" | "error"
        )
}

fn sort_worktrees(worktrees: &mut [Value], project_root: &str) {
    worktrees.sort_by(|left, right| {
        let left_main = string_field(left, "path") == Some(project_root);
        let right_main = string_field(right, "path") == Some(project_root);
        right_main
            .cmp(&left_main)
            .then_with(|| dashboard_created_sort_key(right).cmp(&dashboard_created_sort_key(left)))
    });
}

fn dashboard_session_status(status: Option<&str>) -> &'static str {
    match status {
        Some("running") => "running",
        Some("idle") => "idle",
        Some("starting") => "waiting",
        Some("offline") => "offline",
        _ => "offline",
    }
}

fn dashboard_service_status(status: Option<&str>) -> &'static str {
    match status {
        Some("running" | "starting") => "running",
        Some("stopped") => "exited",
        _ => "offline",
    }
}

fn is_teammate_session(session: &Value) -> bool {
    team_string_field(session, "parentSessionId").is_some()
}

fn is_project_control_session(session: &Value) -> bool {
    session.get("projectControl").and_then(Value::as_bool) == Some(true)
        || session.get("overseer").and_then(Value::as_bool) == Some(true)
        || team_string_field(session, "role") == Some("overseer")
        || is_scribe_session(session)
}

fn is_scribe_session(session: &Value) -> bool {
    if session.get("scribe").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    session.get("scribe").and_then(Value::as_bool) == Some(true)
        || team_string_field(session, "role") == Some("scribe")
}

fn main_checkout_branch(project_root: &str, worktrees: Option<&Value>) -> String {
    worktrees
        .and_then(Value::as_array)
        .and_then(|worktrees| {
            worktrees
                .iter()
                .find(|worktree| string_field(worktree, "path") == Some(project_root))
        })
        .and_then(|worktree| string_field(worktree, "branch"))
        .unwrap_or("")
        .to_owned()
}

fn task_counts(exchange: &Value) -> Value {
    let tasks = exchange
        .get("tasks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    json!({
        "pending": tasks.iter().filter(|task| string_field(task, "status") == Some("pending")).count(),
        "assigned": tasks.iter().filter(|task| matches!(string_field(task, "status"), Some("assigned" | "in_progress" | "blocked"))).count(),
    })
}

fn control_plane() -> Value {
    let resolver = PathResolver::from_env();
    json!({
        "daemonAlive": load_daemon_info(resolver.daemon_info_path()).is_some(),
        "projectServiceAlive": true,
    })
}

fn service_info() -> Value {
    get_project_service_manifest()
        .ok()
        .and_then(|manifest| serde_json::to_value(manifest).ok())
        .unwrap_or_else(|| json!({}))
}

fn dashboard_created_sort_key(entry: &Value) -> i128 {
    if let Some(created_at) = string_field(entry, "createdAt")
        && let Some(parsed) = parse_recency_timestamp(created_at)
    {
        return parsed as i128;
    }
    entry
        .get("tmuxWindowIndex")
        .or_else(|| entry.get("index"))
        .and_then(Value::as_i64)
        .map(i128::from)
        .unwrap_or_default()
}

fn path_basename(path: &str) -> Option<&str> {
    Path::new(path).file_name().and_then(|name| name.to_str())
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

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    array_field(value, key)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn integer_field(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.into(), Value::String(value.to_owned()));
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        insert_string(map, key, value);
    }
}

fn insert_optional_owned(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value
        && !value.is_null()
    {
        map.insert(key.into(), value);
    }
}
