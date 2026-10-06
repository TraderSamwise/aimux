use crate::async_subprocess::AsyncCommand;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use crate::config::default_config;
use crate::daemon::process_inventory::read_daemon_process_control_plane_warning;
use crate::daemon_state::{load_daemon_info, load_daemon_info_async, load_metadata_state};
use crate::debug_logging::{LogLevel, log_at};
use crate::loop_watcher::loop_alert_state_summary;
use crate::paths::PathResolver;
use crate::project_api_contract::routes;
use crate::project_service_manifest::get_project_service_manifest;
use crate::runtime_topology::{
    list_topology_service_states, list_topology_worktree_states, read_runtime_topology,
    runtime_topology_path,
};
use crate::team_contract::{agent_lane, agent_role, agent_role_state};
use crate::tmux::TmuxTarget;

use super::agent_output::{AgentOutputCaptureRuntime, SystemAgentOutputCaptureRuntime};
use super::agents::{
    LiveWindowIdsProjection, live_services_with_window_projection,
    topology_desktop_session_list_with_live_window_projection,
    try_live_window_ids_for_session_projection, try_live_window_ids_for_session_projection_async,
};
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::query_params;
use super::lifecycle::read_displayable_agent_restore_offer;
use super::operation_failures::{
    list_dashboard_operation_failures, normalize_dashboard_operation_failure_record,
    with_derived_operation_failure_target,
};
use super::preview_snapshots::{
    DEFAULT_PREVIEW_CAPTURE_LINES, DEFAULT_PREVIEW_MAX_CHARS,
    capture_preview_snapshot_with_tap_async, capture_preview_snapshot_with_tap_result,
};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{runtime_exchange_path, try_read_runtime_exchange};
use super::session_semantics::{SessionSemanticsInput, derive_session_semantics};
use super::session_visibility::{
    AgentVisibilityInput, AgentVisibilityRule, session_is_in_supervisor_plane,
};
use super::usage::parse_recency_timestamp;
use super::visual_clients::VisualClientLeaseRoute;

const ACTIVE_WORKTREE_STATUSES: &[&str] = &[
    "planned", "creating", "active", "removing", "missing", "error",
];
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
        attach_control_plane_warnings(&mut body);
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

pub async fn route_desktop_state_request_async(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
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
        let mut body = Value::Object(body);
        if include_preview {
            attach_desktop_state_previews_async(context, &mut body).await;
        }
        return Some(ProjectServiceDispatchResponse::json(200, body));
    }
    let mut state = match desktop_state_for_context_async(context).await {
        Ok(state) => state,
        Err(error) => {
            return Some(ProjectServiceDispatchResponse::json(
                500,
                json!({ "ok": false, "error": error }),
            ));
        }
    };
    if include_preview {
        attach_desktop_state_previews_async(context, &mut state).await;
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
            remote_address: context.remote_address.as_deref(),
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
    let exchange = try_read_runtime_exchange(runtime_exchange_path(&project_state_dir))?;
    let live_window_ids_owned;
    let mut live_window_query_error = None;
    let live_window_projection = match context.live_window_ids_status() {
        Some(Ok(live_window_ids)) => LiveWindowIdsProjection::Known(live_window_ids),
        Some(Err(error)) => {
            live_window_query_error = Some(error.to_owned());
            LiveWindowIdsProjection::Unavailable(error)
        }
        None => match try_live_window_ids_for_session_projection("desktop-state") {
            Ok(live_window_ids) => {
                live_window_ids_owned = live_window_ids;
                LiveWindowIdsProjection::Known(&live_window_ids_owned)
            }
            Err(error) => {
                live_window_query_error = Some(error);
                LiveWindowIdsProjection::Unavailable(
                    live_window_query_error
                        .as_deref()
                        .expect("live window query error was just stored"),
                )
            }
        },
    };
    let mut state = build_desktop_state_with_live_window_projection(
        DesktopStateInput {
            project_root: context.project_root().to_string_lossy().into_owned(),
            topology: &topology,
            metadata_sessions: &metadata.sessions,
            exchange: &exchange,
        },
        live_window_projection,
    );
    if let Value::Object(object) = &mut state {
        let mut operation_failures = list_dashboard_operation_failures(&project_state_dir)
            .into_iter()
            .map(with_derived_operation_failure_target)
            .collect::<Vec<_>>();
        if let Some(error) = live_window_query_error {
            operation_failures.insert(0, tmux_live_window_query_failure(&error));
        }
        object.insert("operationFailures".into(), Value::Array(operation_failures));
        attach_control_plane_warnings(object);
        object.insert(
            "loopAlertState".into(),
            loop_alert_state_summary(&project_state_dir, super::scheduler::scheduler_now_ms()),
        );
        object.insert(
            "agentRestoreOffer".into(),
            read_displayable_agent_restore_offer(context, &project_state_dir)
                .unwrap_or(Value::Null),
        );
    }
    Ok(state)
}

pub async fn desktop_state_for_context_async(
    context: &ProjectServiceRequestContext,
) -> Result<Value, String> {
    if let Some(desktop_state) = context.desktop_state.as_ref() {
        return Ok(desktop_state.clone());
    }
    let project_state_dir = context.project_state_dir();
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))?;
    let metadata = load_metadata_state(&project_state_dir);
    let exchange = try_read_runtime_exchange(runtime_exchange_path(&project_state_dir))?;
    let live_window_ids_owned;
    let mut live_window_query_error = None;
    let live_window_projection = match context.live_window_ids_status() {
        Some(Ok(live_window_ids)) => LiveWindowIdsProjection::Known(live_window_ids),
        Some(Err(error)) => {
            live_window_query_error = Some(error.to_owned());
            LiveWindowIdsProjection::Unavailable(error)
        }
        None => match try_live_window_ids_for_session_projection_async("desktop-state").await {
            Ok(live_window_ids) => {
                live_window_ids_owned = live_window_ids;
                LiveWindowIdsProjection::Known(&live_window_ids_owned)
            }
            Err(error) => {
                live_window_query_error = Some(error);
                LiveWindowIdsProjection::Unavailable(
                    live_window_query_error
                        .as_deref()
                        .expect("live window query error was just stored"),
                )
            }
        },
    };
    let mut state = build_desktop_state_with_live_window_projection_async(
        DesktopStateInput {
            project_root: context.project_root().to_string_lossy().into_owned(),
            topology: &topology,
            metadata_sessions: &metadata.sessions,
            exchange: &exchange,
        },
        live_window_projection,
    )
    .await;
    if let Value::Object(object) = &mut state {
        let mut operation_failures = list_dashboard_operation_failures(&project_state_dir)
            .into_iter()
            .map(with_derived_operation_failure_target)
            .collect::<Vec<_>>();
        if let Some(error) = live_window_query_error {
            operation_failures.insert(0, tmux_live_window_query_failure(&error));
        }
        object.insert("operationFailures".into(), Value::Array(operation_failures));
        attach_control_plane_warnings(object);
        object.insert(
            "loopAlertState".into(),
            loop_alert_state_summary(&project_state_dir, super::scheduler::scheduler_now_ms()),
        );
        object.insert(
            "agentRestoreOffer".into(),
            read_displayable_agent_restore_offer(context, &project_state_dir)
                .unwrap_or(Value::Null),
        );
    }
    Ok(state)
}

pub struct DesktopStateInput<'a> {
    pub project_root: String,
    pub topology: &'a Value,
    pub metadata_sessions: &'a BTreeMap<String, Value>,
    pub exchange: &'a Value,
}

pub fn build_desktop_state(input: DesktopStateInput<'_>) -> Value {
    match try_live_window_ids_for_session_projection("desktop-state-builder") {
        Ok(live_window_ids) => build_desktop_state_with_live_window_projection(
            input,
            LiveWindowIdsProjection::Known(&live_window_ids),
        ),
        Err(error) => build_desktop_state_with_live_window_projection(
            input,
            LiveWindowIdsProjection::Unavailable(&error),
        ),
    }
}

pub fn build_desktop_state_with_live_window_ids(
    input: DesktopStateInput<'_>,
    live_window_ids: Option<&crate::tmux::LiveWindowIndex>,
) -> Value {
    match live_window_ids {
        Some(live_window_ids) => build_desktop_state_with_live_window_projection(
            input,
            LiveWindowIdsProjection::Known(live_window_ids),
        ),
        None => build_desktop_state(input),
    }
}

pub fn build_desktop_state_with_live_window_projection(
    input: DesktopStateInput<'_>,
    live_window_ids: LiveWindowIdsProjection<'_>,
) -> Value {
    let tools = default_config()
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let all_sessions = topology_desktop_session_list_with_live_window_projection(
        input.topology,
        input.metadata_sessions,
        &tools,
        live_window_ids,
    )
    .into_iter()
    .filter(dashboard_session_visibility_allows)
    .collect::<Vec<_>>();
    // One probe for the whole build, handed to each of the three places that
    // used to ask git the same question for itself.
    let main_branch_probe = main_branch_probe_for_topology(&input.project_root, input.topology);
    let worktrees = desktop_worktrees(
        &input.project_root,
        input.topology,
        main_branch_probe.as_ref(),
    );
    let worktree_by_path = worktree_lookup_by_identity(&worktrees);
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
    // The groups and the lane were ordered; this flat array was left in raw
    // topology order, and set_indexes numbers agents from it. A client reading
    // `sessions` -- older payloads, and the TUI snapshot -- saw a different
    // order from the one every other surface renders.
    sessions.sort_by(crate::team_contract::compare_agent_canonical_order);
    teammates.sort_by(crate::team_contract::compare_agent_canonical_order);
    set_indexes(&mut sessions);
    set_indexes(&mut teammates);
    let supervisor_lane = supervisor_lane_from_sessions(&sessions);
    let service_states = live_services_with_window_projection(
        list_topology_service_states(input.topology, Some(DASHBOARD_SERVICE_STATUSES)),
        live_window_ids,
    );
    let services = service_states
        .iter()
        .map(|service| dashboard_service(service, input.metadata_sessions, &worktree_by_path))
        .collect::<Vec<_>>();
    let retired_worktree_paths = retired_worktree_paths(input.topology);
    let worktree_groups = build_worktree_groups(
        &input.project_root,
        &worktrees,
        &sessions,
        &services,
        &retired_worktree_paths,
        main_branch_probe.as_ref(),
        &worktree_by_path,
    );
    let mut state = Map::new();
    state.insert("ok".into(), Value::Bool(true));
    state.insert("serviceInfo".into(), service_info());
    state.insert("pendingInteractions".into(), Value::Array(Vec::new()));
    state.insert("sessions".into(), Value::Array(sessions));
    if let Some(supervisor_lane) = supervisor_lane {
        state.insert("supervisorLane".into(), supervisor_lane);
    }
    state.insert("teammates".into(), Value::Array(teammates));
    state.insert("services".into(), Value::Array(services));
    state.insert("worktrees".into(), Value::Array(worktrees));
    state.insert("worktreeGroups".into(), Value::Array(worktree_groups));
    state.insert("operationFailures".into(), Value::Array(Vec::new()));
    state.insert("controlPlaneWarnings".into(), Value::Array(Vec::new()));
    state.insert("agentRestoreOffer".into(), Value::Null);
    state.insert(
        "mainCheckoutInfo".into(),
        json!({
            "name": "Main Checkout",
            "branch": main_checkout_branch(
                &input.project_root,
                state.get("worktrees"),
                main_branch_probe.as_ref(),
            ),
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

async fn build_desktop_state_with_live_window_projection_async(
    input: DesktopStateInput<'_>,
    live_window_ids: LiveWindowIdsProjection<'_>,
) -> Value {
    let tools = default_config()
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let all_sessions = topology_desktop_session_list_with_live_window_projection(
        input.topology,
        input.metadata_sessions,
        &tools,
        live_window_ids,
    )
    .into_iter()
    .filter(dashboard_session_visibility_allows)
    .collect::<Vec<_>>();
    let worktree_projection = desktop_worktrees_async(&input.project_root, input.topology).await;
    let worktrees = worktree_projection.worktrees;
    let worktree_by_path = worktree_lookup_by_identity(&worktrees);
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
    // The groups and the lane were ordered; this flat array was left in raw
    // topology order, and set_indexes numbers agents from it. A client reading
    // `sessions` -- older payloads, and the TUI snapshot -- saw a different
    // order from the one every other surface renders.
    sessions.sort_by(crate::team_contract::compare_agent_canonical_order);
    teammates.sort_by(crate::team_contract::compare_agent_canonical_order);
    set_indexes(&mut sessions);
    set_indexes(&mut teammates);
    let supervisor_lane = supervisor_lane_from_sessions(&sessions);
    let service_states = live_services_with_window_projection(
        list_topology_service_states(input.topology, Some(DASHBOARD_SERVICE_STATUSES)),
        live_window_ids,
    );
    let services = service_states
        .iter()
        .map(|service| dashboard_service(service, input.metadata_sessions, &worktree_by_path))
        .collect::<Vec<_>>();
    let retired_worktree_paths = retired_worktree_paths(input.topology);
    let worktree_groups = build_worktree_groups(
        &input.project_root,
        &worktrees,
        &sessions,
        &services,
        &retired_worktree_paths,
        worktree_projection.main_branch_probe.as_ref(),
        &worktree_by_path,
    );
    let mut state = Map::new();
    state.insert("ok".into(), Value::Bool(true));
    state.insert("serviceInfo".into(), service_info());
    state.insert("pendingInteractions".into(), Value::Array(Vec::new()));
    state.insert("sessions".into(), Value::Array(sessions));
    if let Some(supervisor_lane) = supervisor_lane {
        state.insert("supervisorLane".into(), supervisor_lane);
    }
    state.insert("teammates".into(), Value::Array(teammates));
    state.insert("services".into(), Value::Array(services));
    state.insert("worktrees".into(), Value::Array(worktrees));
    state.insert("worktreeGroups".into(), Value::Array(worktree_groups));
    state.insert("operationFailures".into(), Value::Array(Vec::new()));
    state.insert("controlPlaneWarnings".into(), Value::Array(Vec::new()));
    state.insert("agentRestoreOffer".into(), Value::Null);
    let mut main_checkout_info = json!({
        "name": "Main Checkout",
        "branch": main_checkout_branch(
            &input.project_root,
            state.get("worktrees"),
            worktree_projection.main_branch_probe.as_ref(),
        ),
    });
    if let Some(error) = worktree_projection.main_branch_error
        && let Value::Object(map) = &mut main_checkout_info
    {
        map.insert(
            "branchUnavailable".into(),
            json!({ "ok": false, "error": error }),
        );
    }
    state.insert("mainCheckoutInfo".into(), main_checkout_info);
    state.insert(
        "mainCheckoutPath".into(),
        Value::String(input.project_root.clone()),
    );
    state.insert("controlPlane".into(), control_plane_async().await);
    state.insert("tasks".into(), task_counts(input.exchange));
    Value::Object(state)
}

/// Synthesized rather than stored, but published down the same pipe, so it goes
/// through the same assembly as a stored row. It has nothing to name today; if
/// it ever gains one, the clients must not be the place that notices.
fn tmux_live_window_query_failure(error: &str) -> Value {
    with_derived_operation_failure_target(json!({
        "id": "tmux-live-window-query",
        "targetKind": "tmux",
        "operation": "live-window-query",
        "title": "Could not verify tmux windows",
        "message": format!(
            "tmux live window query failed; preserving session liveness until the next refresh: {error}"
        ),
        "createdAt": time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned()),
    }))
}

fn attach_control_plane_warnings(object: &mut Map<String, Value>) {
    let resolver = PathResolver::from_env();
    let warnings = read_daemon_process_control_plane_warning(&resolver)
        .into_iter()
        .collect::<Vec<_>>();
    object.insert("controlPlaneWarnings".into(), Value::Array(warnings));
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
        let target = TmuxTarget {
            session_name: String::new(),
            window_id: window_id.clone(),
            window_index: integer_field(session, "tmuxWindowIndex"),
            window_name: String::new(),
            pane_dead: None,
        };
        let tap_snapshot = context.osc_output_tap.track_and_read_snapshot(
            string_field(session, "id").unwrap_or_default(),
            target,
            DEFAULT_PREVIEW_MAX_CHARS,
        );
        let preview = match capture_preview_snapshot_with_tap_result(
            context,
            &window_id,
            tap_snapshot.as_ref(),
            runtime,
            DEFAULT_PREVIEW_CAPTURE_LINES,
            DEFAULT_PREVIEW_MAX_CHARS,
        ) {
            Ok(preview) => preview,
            Err(error) => {
                if let Some(object) = session.as_object_mut() {
                    object.insert(
                        "previewCapture".into(),
                        json!({ "ok": false, "error": error }),
                    );
                }
                continue;
            }
        };
        let Some(preview) = preview else {
            continue;
        };
        if let Some(object) = session.as_object_mut() {
            object.insert("previewSnapshot".into(), preview);
        }
    }
    state
}

async fn attach_desktop_state_previews_async(
    context: &ProjectServiceRequestContext,
    state: &mut Value,
) {
    let Some(sessions) = state.get_mut("sessions").and_then(Value::as_array_mut) else {
        return;
    };
    for session in sessions {
        if string_field(session, "id").is_none() {
            continue;
        }
        let Some(window_id) = string_field(session, "tmuxWindowId").map(str::to_owned) else {
            continue;
        };
        let preview = match capture_preview_snapshot_with_tap_async(
            context,
            &window_id,
            None,
            DEFAULT_PREVIEW_CAPTURE_LINES,
            DEFAULT_PREVIEW_MAX_CHARS,
        )
        .await
        {
            Ok(preview) => preview,
            Err(error) => {
                if let Some(object) = session.as_object_mut() {
                    object.insert(
                        "previewCapture".into(),
                        json!({ "ok": false, "error": error }),
                    );
                }
                continue;
            }
        };
        let Some(preview) = preview else {
            continue;
        };
        if let Some(object) = session.as_object_mut() {
            object.insert("previewSnapshot".into(), preview);
        }
    }
}

/// A checkout mid-create carries `status: "creating"` and nothing else, and the
/// window is up to 180s wide. Said once, here, so the TUI row, the app and the
/// statusline read one answer instead of each inferring from the request it
/// happened to send -- which is how the TUI came to paint the main checkout.
///
/// Derived rather than stored: the topology schema is a strict allowlist, and a
/// stored mark can be left behind by a service that dies mid-write.
fn insert_pending_marks_for_status(item: &mut Map<String, Value>, worktree: &Value) {
    let Some(action) =
        crate::transient_state::pending_action_for_status(string_field(worktree, "status"))
    else {
        return;
    };
    item.insert("pending".into(), Value::Bool(true));
    item.insert("pendingAction".into(), Value::String(action.to_owned()));
}

/// One worktree row, for both the sync and the async projection.
///
/// They were two copies differing only in how the branch is resolved, and a
/// test against one proved nothing about the other — which is the whole reason
/// the row carries derived state at all.
fn desktop_worktree_item(
    project_root: &str,
    missing: &BTreeSet<String>,
    worktree: &Value,
    branch: &str,
) -> Value {
    let mut item = Map::new();
    let path = string_field(worktree, "path").unwrap_or(project_root);
    insert_string(
        &mut item,
        "name",
        string_field(worktree, "name").unwrap_or_else(|| path_basename(path).unwrap_or(path)),
    );
    insert_string(&mut item, "path", path);
    insert_string(&mut item, "branch", branch);
    item.insert("isBare".into(), Value::Bool(false));
    insert_value(&mut item, "createdAt", worktree.get("createdAt").cloned());
    // `pending`, `removing` and `pendingAction` were copied here too, from a
    // record that cannot carry them: `topology_worktree_to_worktree_state`
    // keeps eleven named keys and `coerce_worktree` twelve, neither including
    // any of those three. The status is where the fact actually lives.
    insert_pending_marks_for_status(&mut item, worktree);
    // The same verdict the groups carry, on the row the CLI and the TUI
    // overlays read. Marking only the groups left `aimux worktree list` happily
    // printing thirteen checkouts that are not on disk.
    if missing.contains(path) {
        item.insert("pathMissing".into(), Value::Bool(true));
    }
    insert_operation_failure_value(&mut item, worktree.get("operationFailure").cloned());
    Value::Object(item)
}

fn desktop_worktrees(
    project_root: &str,
    topology: &Value,
    main_branch_probe: Option<&GitBranchProbe>,
) -> Vec<Value> {
    let topology_worktrees =
        list_topology_worktree_states(topology, Some(ACTIVE_WORKTREE_STATUSES));
    let missing = missing_worktree_paths(project_root, &topology_worktrees);
    // Hoisted, as the async lane already does: derived inside the loop this is
    // one `canonicalize` of the same path per worktree row, which is the repeat
    // this branch exists to remove.
    let root_identity = worktree_path_identity(project_root);
    let mut worktrees = topology_worktrees
        .into_iter()
        .map(|worktree| {
            desktop_worktree_item(
                project_root,
                &missing,
                &worktree,
                &worktree_branch_or_current_from_probe(
                    worktree_row_is_main_checkout(&worktree, &root_identity),
                    string_field(&worktree, "branch"),
                    main_branch_probe,
                ),
            )
        })
        .collect::<Vec<_>>();
    if !worktrees
        .iter()
        .any(|worktree| worktree_row_is_main_checkout(worktree, &root_identity))
    {
        worktrees.insert(
            0,
            json!({
                "name": "Main Checkout",
                "path": project_root,
                "branch": branch_from_probe(main_branch_probe).unwrap_or_default(),
                "isBare": false,
            }),
        );
    }
    sort_worktrees(&mut worktrees, &root_identity);
    worktrees
}

struct DesktopWorktreeProjection {
    worktrees: Vec<Value>,
    main_branch_error: Option<String>,
    main_branch_probe: Option<GitBranchProbe>,
}

async fn desktop_worktrees_async(
    project_root: &str,
    topology: &Value,
) -> DesktopWorktreeProjection {
    let topology_worktrees =
        list_topology_worktree_states(topology, Some(ACTIVE_WORKTREE_STATUSES));
    let root_identity = worktree_path_identity(project_root);
    let needs_main_branch_probe =
        main_branch_probe_needed(project_root, &topology_worktrees, &root_identity);
    let main_branch_probe = if needs_main_branch_probe {
        Some(current_git_branch_async(project_root).await)
    } else {
        None
    };
    // Off the reactor: this route is dispatched async, not through the blocking
    // pool the ordinary routes use, and a `stat` on a hung mount blocks until
    // the kernel answers.
    let missing = {
        let project_root = project_root.to_owned();
        let worktrees = topology_worktrees.clone();
        match crate::async_runtime::spawn_blocking_named(
            crate::async_runtime::scoped_task_name("desktop-state", "worktree-checkouts", "stat"),
            move || missing_worktree_paths(&project_root, &worktrees),
        )
        .await
        {
            Ok(missing) => missing,
            // Not knowing is not the same as nothing being missing, and
            // `unwrap_or_default()` here would have said the second while
            // meaning the first -- in a change whose whole subject is wrappers
            // that answer a question they did not ask. Nothing can be marked
            // without the answer, so the state is served unmarked, but the
            // reason is said out loud rather than swallowed.
            Err(error) => {
                log_at(
                    LogLevel::Warn,
                    "worktree checkout probe did not run; no checkout is marked missing",
                    "project-service",
                    Some(json!({ "error": error.to_string() })),
                );
                BTreeSet::new()
            }
        }
    };
    let mut worktrees = topology_worktrees
        .into_iter()
        .map(|worktree| {
            desktop_worktree_item(
                project_root,
                &missing,
                &worktree,
                &worktree_branch_or_current_from_probe(
                    worktree_row_is_main_checkout(&worktree, &root_identity),
                    string_field(&worktree, "branch"),
                    main_branch_probe.as_ref(),
                ),
            )
        })
        .collect::<Vec<_>>();
    if !worktrees
        .iter()
        .any(|worktree| worktree_row_is_main_checkout(worktree, &root_identity))
    {
        worktrees.insert(
            0,
            json!({
                "name": "Main Checkout",
                "path": project_root,
                "branch": branch_from_probe(main_branch_probe.as_ref()).unwrap_or_default(),
                "isBare": false,
            }),
        );
    }
    sort_worktrees(&mut worktrees, &root_identity);
    DesktopWorktreeProjection {
        worktrees,
        main_branch_error: main_branch_probe
            .as_ref()
            .and_then(|probe| probe.error.clone()),
        main_branch_probe,
    }
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
        // The plane is stored on the agent; without carrying it here the role
        // probe below re-derives it and the dashboard groups by the role flag.
        "lane",
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
    if let Some(worktree) = string_field(session, "worktreePath")
        .and_then(|path| worktree_by_path.get(&worktree_path_identity(path)))
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
        if !item.contains_key("backendSessionId") {
            insert_value(
                &mut item,
                "backendSessionId",
                metadata.get("backendSessionId").cloned(),
            );
        }
        if let Some(context) = metadata.get("context") {
            for key in ["cwd", "branch"] {
                insert_value(&mut item, key, context.get(key).cloned());
            }
            if let Some(repo) = context.get("repo") {
                insert_value(&mut item, "repoOwner", repo.get("owner").cloned());
                insert_value(&mut item, "repoName", repo.get("name").cloned());
                insert_value(&mut item, "repoRemote", repo.get("remote").cloned());
            }
            if let Some(pr) = context.get("pr") {
                insert_value(&mut item, "prNumber", pr.get("number").cloned());
                insert_value(&mut item, "prTitle", pr.get("title").cloned());
                insert_value(&mut item, "prUrl", pr.get("url").cloned());
            }
        }
        for key in [
            "loop",
            "loopLastAction",
            "lane",
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
                "threadId",
                "threadName",
            ] {
                insert_value(&mut item, key, derived.get(key).cloned());
            }
            activity = string_field(derived, "activity").map(str::to_owned);
            attention = string_field(derived, "attention").map(str::to_owned);
            unseen_count = integer_field(derived, "unseenCount");
        }
    }
    let role_probe = Value::Object(item.clone());
    let role = agent_role(Some(&role_probe));
    insert_string(&mut item, "role", role.as_str());
    item.insert("lane".into(), agent_lane(Some(&role_probe)));
    item.insert("roleState".into(), agent_role_state(Some(&role_probe)));
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
    if !item.contains_key("threadId") {
        insert_optional_owned(&mut item, "threadId", thread.latest_id.clone());
    }
    if !item.contains_key("threadName") {
        insert_optional_owned(&mut item, "threadName", thread.latest_title.clone());
    }
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

fn supervisor_lane_from_sessions(sessions: &[Value]) -> Option<Value> {
    let mut sessions = sessions
        .iter()
        .enumerate()
        .filter(|(_, session)| session_is_in_supervisor_plane(session))
        .map(|(index, session)| (index, session.clone()))
        .collect::<Vec<_>>();
    // Role order used to lead here. The plane decides membership and the tmux
    // window decides the sequence, so the arrival index is only the tiebreak.
    sessions.sort_by(|left, right| {
        crate::team_contract::compare_agent_canonical_order(&left.1, &right.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    let sessions = sessions
        .into_iter()
        .map(|(_, session)| session)
        .collect::<Vec<_>>();
    (!sessions.is_empty()).then(|| json!({ "sessions": sessions }))
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
    if let Some(worktree) = string_field(service, "worktreePath")
        .and_then(|path| worktree_by_path.get(&worktree_path_identity(path)))
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

/// Paths of worktrees the user has graveyarded or removed.
///
/// They are already absent from the active worktree list, but a session that
/// still names one would otherwise reintroduce the group, so a graveyarded
/// worktree holding an offline agent never left the dashboard.
fn retired_worktree_paths(topology: &Value) -> BTreeSet<String> {
    list_topology_worktree_states(topology, None)
        .iter()
        .filter(|worktree| {
            string_field(worktree, "status")
                .is_some_and(|status| !ACTIVE_WORKTREE_STATUSES.contains(&status))
        })
        .filter_map(|worktree| string_field(worktree, "path").map(worktree_path_identity))
        .collect()
}

/// Whether the main checkout's branch has to be asked of git at all.
///
/// Shared by both lanes, because it is one question: a row for the project root
/// that already names a branch answers it, and so does the absence of any root
/// row. What is left is a root row whose branch is empty -- what a detached
/// HEAD looks like -- and then git is asked, and answers with an empty branch
/// again. That is one subprocess per build for a detached checkout, which is
/// worth knowing about and is not worth caching a wrong answer to avoid.
fn main_branch_probe_needed(
    project_root: &str,
    topology_worktrees: &[Value],
    root_identity: &str,
) -> bool {
    topology_worktrees.iter().any(|worktree| {
        let path = string_field(worktree, "path").unwrap_or(project_root);
        is_worktree_path(path, root_identity)
            && string_field(worktree, "branch").is_none_or(|branch| branch.trim().is_empty())
    }) || !topology_worktrees
        .iter()
        .any(|worktree| worktree_row_is_main_checkout(worktree, root_identity))
}

/// The main checkout's branch, asked of git at most once per build.
///
/// The sync lane used to ask three times for the same fact: once inside
/// `desktop_worktrees` while resolving the root row's branch, once inside the
/// group builder, and once more as the fallback behind `mainCheckoutInfo`.
/// Three `git branch --show-current` subprocesses, about 55ms each, on every
/// dashboard refresh of every project. The async lane already derived it once
/// and handed it round; this is that shape, and the gate in
/// `desktop_state_scale.rs` counts the spawns so a fourth caller cannot quietly
/// appear.
fn main_branch_probe_for_topology(project_root: &str, topology: &Value) -> Option<GitBranchProbe> {
    let topology_worktrees =
        list_topology_worktree_states(topology, Some(ACTIVE_WORKTREE_STATUSES));
    let root_identity = worktree_path_identity(project_root);
    main_branch_probe_needed(project_root, &topology_worktrees, &root_identity).then(|| {
        GitBranchProbe {
            branch: current_git_branch(project_root),
            error: None,
        }
    })
}

fn build_worktree_groups(
    project_root: &str,
    worktrees: &[Value],
    sessions: &[Value],
    services: &[Value],
    retired_paths: &BTreeSet<String>,
    main_branch_probe: Option<&GitBranchProbe>,
    rows_by_identity: &BTreeMap<String, Value>,
) -> Vec<Value> {
    let by_group = BucketedItems::by_worktree(sessions, services);
    let context = WorktreeGroupContext {
        by_group: &by_group,
        main_branch_probe,
    };
    let main_path = project_root;
    let main_key = worktree_path_identity(main_path);
    let mut group_paths = BTreeMap::<String, String>::new();
    for path in worktrees
        .iter()
        .filter_map(|worktree| string_field(worktree, "path"))
    {
        group_paths
            .entry(worktree_path_identity(path))
            .or_insert_with(|| path.to_owned());
    }
    for item in sessions.iter().chain(services.iter()) {
        if let Some(path) = string_field(item, "worktreePath") {
            let key = worktree_path_identity(path);
            if retired_paths.contains(&key) {
                continue;
            }
            group_paths.entry(key).or_insert_with(|| path.to_owned());
        }
    }
    // The index the caller already built, not one scan per group: finding each
    // group's row by scanning all of them is worktrees-squared, and at a hundred
    // worktrees that is ten thousand string comparisons to answer a hundred
    // questions a map answers once. Passed in rather than rebuilt here, because
    // the caller needs the same map and building it twice deep-clones every row.

    let mut groups = Vec::new();
    groups.push(worktree_group(
        &context,
        rows_by_identity.get(&main_key),
        main_path,
        &main_key,
        true,
    ));
    let mut secondary = group_paths
        .into_iter()
        .filter(|(path_key, _)| path_key != &main_key)
        .map(|(path_key, path)| {
            worktree_group(
                &context,
                rows_by_identity.get(&path_key),
                &path,
                &path_key,
                false,
            )
        })
        .collect::<Vec<_>>();
    secondary.sort_by(|left, right| {
        dashboard_created_sort_key(right).cmp(&dashboard_created_sort_key(left))
    });
    groups.extend(secondary);
    groups
}

struct WorktreeGroupContext<'a> {
    /// Sessions and services already sorted into their groups.
    ///
    /// Each group used to scan EVERY session and service to find its own, so a
    /// build cost worktrees x agents comparisons -- 20,000 of them at the scale
    /// this is meant to carry, each one re-deriving a lane and canonicalising a
    /// path. The sort happens once instead, and a group takes its bucket.
    by_group: &'a BucketedItems<'a>,
    main_branch_probe: Option<&'a GitBranchProbe>,
}

/// Sessions and services keyed by the worktree identity they belong to.
///
/// Borrowed, not owned. Bucketing by value would copy every session once into
/// its bucket and once again out of it, and a dashboard session carries its
/// preview payload -- at the 100-worktree, 200-agent ceiling this branch is
/// for, that is 200 deep clones per build on top of the 200 the groups need.
/// The old pairing scan cloned once, so owning here would have handed back
/// part of what the bucketing won.
#[derive(Default)]
struct BucketedItems<'a> {
    sessions: BTreeMap<String, Vec<&'a Value>>,
    services: BTreeMap<String, Vec<&'a Value>>,
    /// The ones with no worktree of their own, which belong to the main group.
    main_sessions: Vec<&'a Value>,
    main_services: Vec<&'a Value>,
}

impl<'a> BucketedItems<'a> {
    /// Order within a bucket is the input's.
    ///
    /// That is safe only because `sorted_dashboard_items` ends in a total
    /// tiebreak on id, so the result does not depend on which order items
    /// arrived in. Said out loud because bucketing silently depends on it, and
    /// ordering agreeing across surfaces is a rule this repo has a section for.
    fn by_worktree(sessions: &'a [Value], services: &'a [Value]) -> Self {
        let mut bucketed = Self::default();
        for session in sessions {
            if session_is_in_supervisor_plane(session) {
                continue;
            }
            match item_worktree_group_key(session) {
                Some(key) => bucketed.sessions.entry(key).or_default().push(session),
                None => bucketed.main_sessions.push(session),
            }
        }
        for service in services {
            match item_worktree_group_key(service) {
                Some(key) => bucketed.services.entry(key).or_default().push(service),
                None => bucketed.main_services.push(service),
            }
        }
        bucketed
    }

    fn sessions_for(&self, path_key: &str, main: bool) -> Vec<&'a Value> {
        Self::bucket(&self.sessions, &self.main_sessions, path_key, main)
    }

    fn services_for(&self, path_key: &str, main: bool) -> Vec<&'a Value> {
        Self::bucket(&self.services, &self.main_services, path_key, main)
    }

    fn bucket(
        by_key: &BTreeMap<String, Vec<&'a Value>>,
        main_bucket: &[&'a Value],
        path_key: &str,
        main: bool,
    ) -> Vec<&'a Value> {
        let mut items = by_key.get(path_key).cloned().unwrap_or_default();
        if main {
            items.extend_from_slice(main_bucket);
        }
        items
    }
}

fn worktree_group(
    context: &WorktreeGroupContext<'_>,
    worktree: Option<&Value>,
    path: &str,
    path_key: &str,
    main: bool,
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
        &worktree_branch_or_current_from_probe(
            main,
            worktree.and_then(|worktree| string_field(worktree, "branch")),
            context.main_branch_probe,
        ),
    );
    if !main {
        insert_string(&mut group, "path", path);
        // Read from the row rather than stat'd again here: the verdict is taken
        // once per build, so the group and the row cannot disagree and the
        // filesystem is touched once per worktree instead of twice.
        //
        // What this does NOT cover, said rather than left to be discovered: a
        // group that exists only because a session still points at the path,
        // with no topology row behind it. The service has no record of that
        // worktree at all, so it has no verdict to give, and inventing one from
        // a stat here would be a different answer reached a different way --
        // which is the drift this change exists to remove. `dashboard_navigation`
        // carries the same `false` for the same reason.
        if worktree.and_then(|worktree| worktree.get("pathMissing")) == Some(&Value::Bool(true)) {
            group.insert("pathMissing".into(), Value::Bool(true));
        }
    }
    for key in ["createdAt", "pending", "removing", "pendingAction"] {
        insert_value(
            &mut group,
            key,
            worktree.and_then(|worktree| worktree.get(key)).cloned(),
        );
    }
    insert_operation_failure_value(
        &mut group,
        worktree
            .and_then(|worktree| worktree.get("operationFailure"))
            .cloned(),
    );
    let group_sessions = sorted_dashboard_items(context.by_group.sessions_for(path_key, main));
    let group_services = sorted_dashboard_items(context.by_group.services_for(path_key, main));
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

/// Sorted into canonical agent order, and cloned exactly once on the way out.
///
/// Takes references because the group is the only place an owned copy is
/// needed -- `Value::Array` wants one. Sorting the references first means the
/// sort moves pointers rather than JSON objects.
fn sorted_dashboard_items(mut items: Vec<&Value>) -> Vec<Value> {
    items.sort_by(|left, right| crate::team_contract::compare_agent_canonical_order(left, right));
    items.into_iter().cloned().collect()
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

fn sort_worktrees(worktrees: &mut [Value], root_identity: &str) {
    worktrees.sort_by(|left, right| {
        let left_main = worktree_row_is_main_checkout(left, root_identity);
        let right_main = worktree_row_is_main_checkout(right, root_identity);
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

fn dashboard_session_visibility_allows(session: &Value) -> bool {
    AgentVisibilityRule::dashboard().allows(AgentVisibilityInput {
        status: string_field(session, "status"),
        alive: true,
        metadata: session,
        kind: string_field(session, "kind"),
        worktree_path: string_field(session, "worktreePath"),
        window_name: None,
        window_id: None,
    })
}

/// The branch `mainCheckoutInfo` reports, for both lanes.
///
/// There were two of these, differing only in their fallback: the sync one ran
/// `git branch --show-current` itself, the async one returned `""`. So the same
/// field was derived two ways and the sync way spent a subprocess the lane had
/// already spent elsewhere. Now both read the probe the build already made --
/// which is `None` exactly when the rows could answer, so the fallback is
/// never needed and never silently empty either.
fn main_checkout_branch(
    project_root: &str,
    worktrees: Option<&Value>,
    main_branch_probe: Option<&GitBranchProbe>,
) -> String {
    let root_identity = worktree_path_identity(project_root);
    worktrees
        .and_then(Value::as_array)
        .and_then(|worktrees| {
            worktrees
                .iter()
                .find(|worktree| worktree_row_is_main_checkout(worktree, &root_identity))
        })
        .and_then(|worktree| string_field(worktree, "branch"))
        .filter(|branch| !branch.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| branch_from_probe(main_branch_probe))
        .unwrap_or_default()
}

/// The worktree paths whose directories have gone from disk.
///
/// A deleted worktree stays in the topology, so the dashboard kept rendering it
/// as a live group and `[n]` into one failed inside tmux. Measured on one real
/// project: 24 worktrees recorded, 13 with no directory, 5 of those still
/// `active`.
///
/// Taken once per build, as a set, rather than per row: the async desktop-state
/// route runs on a tokio worker, and a `stat` against a hung network mount
/// blocks in the kernel until it answers. One `spawn_blocking` for the whole
/// set keeps that off the reactor -- the sync path pays it directly, as it
/// already does for `git branch --show-current`.
///
/// Only a positive `NotFound` counts. A directory we cannot stat for any other
/// reason -- a permission error on a parent, a mount that is slow to answer --
/// is unknown, not absent, and marking it missing would tell the user to throw
/// away a worktree that is still there.
///
/// A worktree that is still being CREATED has no directory yet and must not be
/// marked: `ACTIVE_WORKTREE_STATUSES` includes `planned` and `creating`, and a
/// create is minutes of git work. Saying "checkout missing" in red there would
/// be the same class of lie this change exists to end.
fn missing_worktree_paths(project_root: &str, topology_worktrees: &[Value]) -> BTreeSet<String> {
    let root_identity = worktree_path_identity(project_root);
    topology_worktrees
        .iter()
        .filter(|worktree| !worktree_checkout_is_still_arriving(worktree))
        .filter_map(|worktree| string_field(worktree, "path"))
        .filter(|path| !is_worktree_path(path, &root_identity))
        .filter(|path| {
            matches!(
                std::fs::metadata(path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            )
        })
        .map(ToOwned::to_owned)
        .collect()
}

/// A worktree whose checkout has not been made yet, or is being unmade.
///
/// `status` is the topology's own record of the lifecycle, so this keys on that
/// rather than on whether a `pendingAction` happens to be set on the row.
fn worktree_checkout_is_still_arriving(worktree: &Value) -> bool {
    matches!(
        string_field(worktree, "status"),
        Some("planned" | "creating" | "removing")
    )
}

fn worktree_branch_or_current_from_probe(
    is_main_checkout: bool,
    branch: Option<&str>,
    main_branch_probe: Option<&GitBranchProbe>,
) -> String {
    branch
        .filter(|branch| !branch.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            if is_main_checkout {
                branch_from_probe(main_branch_probe)
            } else {
                None
            }
        })
        .unwrap_or_default()
}

fn current_git_branch(project_root: &str) -> Option<String> {
    GIT_BRANCH_PROBES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let output = AsyncCommand::new("git")
        .args(["-C", project_root, "branch", "--show-current"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8(output.stdout).ok()?;
    let branch = branch.trim();
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_owned())
    }
}

struct GitBranchProbe {
    branch: Option<String>,
    error: Option<String>,
}

fn branch_from_probe(probe: Option<&GitBranchProbe>) -> Option<String> {
    probe.and_then(|probe| probe.branch.clone())
}

async fn current_git_branch_async(project_root: &str) -> GitBranchProbe {
    GIT_BRANCH_PROBES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let output = AsyncCommand::new("git")
        .args(["-C", project_root, "branch", "--show-current"])
        .output_timeout_async(std::time::Duration::from_secs(2))
        .await;
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            return GitBranchProbe {
                branch: None,
                error: Some(error.to_string()),
            };
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return GitBranchProbe {
            branch: None,
            error: Some(if stderr.is_empty() {
                "git branch --show-current failed".to_owned()
            } else {
                stderr
            }),
        };
    }
    let branch = String::from_utf8(output.stdout)
        .ok()
        .map(|branch| branch.trim().to_owned())
        .filter(|branch| !branch.is_empty());
    GitBranchProbe {
        branch,
        error: None,
    }
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

async fn control_plane_async() -> Value {
    let resolver = PathResolver::from_env();
    json!({
        "daemonAlive": load_daemon_info_async(resolver.daemon_info_path()).await.is_some(),
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

fn worktree_lookup_by_identity(worktrees: &[Value]) -> BTreeMap<String, Value> {
    let mut lookup = BTreeMap::new();
    for worktree in worktrees {
        let Some(path) = string_field(worktree, "path") else {
            continue;
        };
        lookup
            .entry(worktree_path_identity(path))
            .or_insert_with(|| worktree.clone());
    }
    lookup
}

/// Which worktree group an item belongs to is its PLANE, and the plane falls
/// back to the working directory only when nothing assigned one. Reading
/// `worktreePath` directly made a stored worktree plane inert -- an agent
/// could be assigned to a worktree group and still render in the one its
/// checkout happened to be in.
/// Which group an item belongs to, or `None` for the main checkout.
///
/// The same rule `item_matches_worktree_group` applied, asked once per item
/// rather than once per item per group.
fn item_worktree_group_key(item: &Value) -> Option<String> {
    let lane = agent_lane(Some(item));
    let lane_path = lane
        .get("worktreePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned);
    let path = lane_path.or_else(|| string_field(item, "worktreePath").map(ToOwned::to_owned))?;
    Some(worktree_path_identity(&path))
}

/// Whether a path names the worktree whose identity is already in hand.
///
/// There was a `same_worktree_path(left, right)` that canonicalised both sides,
/// and every call inside a loop re-canonicalised the project root -- once per
/// worktree, in five separate loops. Half the filesystem calls a build made
/// were re-answering the same question about the same path.
fn is_worktree_path(path: &str, identity: &str) -> bool {
    worktree_path_identity(path) == identity
}

/// Whether a topology row names the project's main checkout.
///
/// One question with one answer. Five callers compared `path` to
/// `project_root` byte for byte while the worktree grouping beside them
/// compared identities, so a checkout reached by a second spelling -- `/tmp`
/// under `/private/tmp`, a symlinked repo, a home on an external volume -- put
/// the main row's branch and its sort position on one answer and its agents on
/// the other. The identity is passed in rather than derived here so no loop
/// re-canonicalises the root once per row.
fn worktree_row_is_main_checkout(worktree: &Value, root_identity: &str) -> bool {
    string_field(worktree, "path").is_some_and(|path| is_worktree_path(path, root_identity))
}

fn worktree_path_identity(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    canonical_worktree_path(trimmed)
}

/// How many times the filesystem has been asked to canonicalise a path.
///
/// The gate for this work is a COUNT, not a duration: a build that takes 45ms
/// here takes longer on a loaded runner and says nothing by it, and this repo
/// has already paid once for a test that asserted the machine was fast. The
/// count is the same on every machine, and it is the shape of the bug -- the
/// filesystem was asked once per worktree-and-agent PAIRING rather than once
/// per path.
///
/// Deliberately not a cache. Memoising these answers was measured at about four
/// percent, because the bucketing below removed the repeats that made it look
/// worth having, and the risk is not worth four percent: `canonicalize` fails
/// for a worktree that is still being created, so a cached answer would pin the
/// lexical fallback for the life of the process while `agent_controls.rs`
/// resolves the same path freshly -- two surfaces disagreeing about which
/// worktree an agent is in, which is the drift this file is full of warnings
/// about.
pub static CANONICALIZE_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// How many times git has been asked for the main checkout's branch.
///
/// The single largest fixed cost this branch removed -- `git branch
/// --show-current` ran on EVERY build, about 55ms of subprocess whatever the
/// project's size, on every dashboard refresh -- and a canonicalize count
/// cannot see a subprocess, so nothing gated it. Reverting the elision left
/// every count-based assertion in this repo green.
///
/// Counted at the two spawn sites rather than at the decision, so a second
/// caller that skipped `main_branch_probe_if_needed` would still be counted.
pub static GIT_BRANCH_PROBES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

fn canonical_worktree_path(trimmed: &str) -> String {
    CANONICALIZE_CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    fs::canonicalize(trimmed)
        .unwrap_or_else(|_| Path::new(trimmed).to_path_buf())
        .to_string_lossy()
        .trim_end_matches('/')
        .to_owned()
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

fn insert_operation_failure_value(map: &mut Map<String, Value>, value: Option<Value>) {
    let Some(value) = value else {
        return;
    };
    if value.is_null() {
        return;
    }
    map.insert(
        "operationFailure".into(),
        normalize_dashboard_operation_failure_record(
            "legacy-worktree-operation-failure".to_owned(),
            "invalid-worktree-operation-failure".to_owned(),
            &value,
        ),
    );
}
