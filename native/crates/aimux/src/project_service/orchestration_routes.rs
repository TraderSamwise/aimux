use serde_json::{Value, json};
use std::cmp::Ordering;

use crate::config::load_config_for_project;
use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::project_service_manifest::get_project_service_manifest;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};

use super::desktop_state::{DesktopStateInput, build_desktop_state};
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{query_params, trimmed_query};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{read_runtime_exchange, runtime_exchange_path};
use super::team::load_team_config;

#[derive(Debug, Clone, PartialEq)]
struct RoutingCandidate {
    id: String,
    tool: Option<String>,
    role: Option<String>,
    worktree_path: Option<String>,
    status: Option<String>,
    can_receive_input: bool,
    is_alive: bool,
    workflow_pressure: f64,
    exited: bool,
}

pub fn route_orchestration_routes_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET")
        || project_service_pathname(path) != routes::orchestration::ROUTES
    {
        return None;
    }
    let params = query_params(path);
    let selected_session_id = trimmed_query(&params, "selectedSessionId");
    let worktree_path = trimmed_query(&params, "worktreePath");
    let state = match orchestration_desktop_state(context) {
        Ok(state) => state,
        Err(error) => {
            return Some(ProjectServiceDispatchResponse::json(
                500,
                json!({ "ok": false, "error": error }),
            ));
        }
    };
    Some(ProjectServiceDispatchResponse::json(
        200,
        json!({
            "ok": true,
            "serviceInfo": service_info(),
            "options": build_orchestration_route_options(context, &state, selected_session_id.as_deref(), worktree_path.as_deref()),
        }),
    ))
}

fn orchestration_desktop_state(context: &ProjectServiceRequestContext) -> Result<Value, String> {
    if let Some(state) = context.desktop_state.as_ref() {
        return Ok(state.clone());
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

fn build_orchestration_route_options(
    context: &ProjectServiceRequestContext,
    state: &Value,
    selected_session_id: Option<&str>,
    worktree_path: Option<&str>,
) -> Vec<Value> {
    let sessions = route_sessions(state);
    let candidates = sessions
        .iter()
        .filter_map(orchestration_candidate_from_session)
        .collect::<Vec<_>>();
    let selected = selected_session_id.and_then(|id| {
        sessions
            .iter()
            .find(|session| string_field(session, "id") == Some(id))
    });
    let mut options = Vec::new();
    if let Some(selected) = selected {
        let id = string_field(selected, "id").unwrap_or_default();
        let label = string_field(selected, "label")
            .or_else(|| string_field(selected, "command"))
            .unwrap_or(id);
        options.push(json!({
            "label": format!("{label} ({id})"),
            "sessionId": id,
        }));
    }

    let team = load_team_config(context.project_root());
    if let Some(roles) = team.get("roles").and_then(Value::as_object) {
        for (role, cfg) in roles {
            let recipient_ids = route_recipient_ids_from_source(
                selected.and_then(|session| string_field(session, "id")),
                resolve_orchestration_recipients(
                    &candidates,
                    RouteTargetInput {
                        assignee: Some(role.as_str()),
                        tool: None,
                        worktree_path,
                    },
                ),
            );
            if recipient_ids.is_empty() {
                continue;
            }
            let description = string_field(cfg, "description")
                .map(|description| format!(" - {description}"))
                .unwrap_or_default();
            options.push(json!({
                "label": format!("Role: {role}{description}{}", format_route_preview(&recipient_ids)),
                "sourceSessionId": route_source_session_id(selected.and_then(|session| string_field(session, "id")), &recipient_ids),
                "assignee": role,
                "worktreePath": worktree_path,
                "recipientIds": recipient_ids,
            }));
        }
    }

    let config = load_config_for_project(context.project_root());
    if let Some(tools) = config.get("tools").and_then(Value::as_object) {
        for (tool_key, tool_cfg) in tools {
            if tool_cfg.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let recipient_ids = route_recipient_ids_from_source(
                selected.and_then(|session| string_field(session, "id")),
                resolve_orchestration_recipients(
                    &candidates,
                    RouteTargetInput {
                        assignee: None,
                        tool: Some(tool_key.as_str()),
                        worktree_path,
                    },
                ),
            );
            if recipient_ids.is_empty() {
                continue;
            }
            options.push(json!({
                "label": format!("Tool: {tool_key}{}", format_route_preview(&recipient_ids)),
                "sourceSessionId": route_source_session_id(selected.and_then(|session| string_field(session, "id")), &recipient_ids),
                "tool": tool_key,
                "worktreePath": worktree_path,
                "recipientIds": recipient_ids,
            }));
        }
    }
    options
}

struct RouteTargetInput<'a> {
    assignee: Option<&'a str>,
    tool: Option<&'a str>,
    worktree_path: Option<&'a str>,
}

fn resolve_orchestration_recipients(
    candidates: &[RoutingCandidate],
    input: RouteTargetInput<'_>,
) -> Vec<String> {
    let mut filtered = candidates
        .iter()
        .filter(|candidate| {
            if candidate.exited || !candidate.can_receive_input || !candidate.is_alive {
                return false;
            }
            if input.assignee.is_some() && candidate.role.as_deref() != input.assignee {
                return false;
            }
            if input.tool.is_some() && candidate.tool.as_deref() != input.tool {
                return false;
            }
            if input.worktree_path.is_some()
                && candidate.worktree_path.as_deref() != input.worktree_path
            {
                return false;
            }
            true
        })
        .collect::<Vec<_>>();
    filtered.sort_by(|left, right| {
        score_candidate(right, &input)
            .partial_cmp(&score_candidate(left, &input))
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    filtered
        .into_iter()
        .map(|candidate| candidate.id.clone())
        .collect()
}

fn score_candidate(candidate: &RoutingCandidate, input: &RouteTargetInput<'_>) -> f64 {
    let mut score = 0.0;
    if input.worktree_path.is_some() && candidate.worktree_path.as_deref() == input.worktree_path {
        score += 10.0;
    }
    if input.assignee.is_some() && candidate.role.as_deref() == input.assignee {
        score += 8.0;
    }
    if input.tool.is_some() && candidate.tool.as_deref() == input.tool {
        score += 6.0;
    }
    if candidate.can_receive_input {
        score += 5.0;
    }
    match candidate.status.as_deref() {
        Some("idle") => score += 3.0,
        Some("waiting") => score += 2.0,
        Some("running") => score += 1.0,
        _ => {}
    }
    score - candidate.workflow_pressure.min(20.0)
}

fn orchestration_candidate_from_session(session: &Value) -> Option<RoutingCandidate> {
    let id = string_field(session, "id")?.to_owned();
    let status = session
        .get("semantic")
        .and_then(|semantic| semantic.get("user"))
        .and_then(|user| string_field(user, "label"))
        .or_else(|| string_field(session, "status"))
        .map(str::to_owned);
    let runtime = session
        .get("semantic")
        .and_then(|semantic| semantic.get("runtime"));
    let can_receive_input = runtime
        .and_then(|runtime| runtime.get("canReceiveInput"))
        .and_then(Value::as_bool)
        .unwrap_or(matches!(
            status.as_deref(),
            Some("running" | "idle" | "waiting")
        ));
    let is_alive = runtime
        .and_then(|runtime| runtime.get("isAlive"))
        .and_then(Value::as_bool)
        .unwrap_or(!matches!(status.as_deref(), Some("exited" | "offline")));
    Some(RoutingCandidate {
        id,
        tool: string_field(session, "tool")
            .or_else(|| string_field(session, "toolConfigKey"))
            .or_else(|| string_field(session, "command"))
            .map(str::to_owned),
        role: string_field(session, "role")
            .or_else(|| {
                session
                    .get("team")
                    .and_then(|team| string_field(team, "role"))
            })
            .map(str::to_owned),
        worktree_path: string_field(session, "worktreePath").map(str::to_owned),
        status: status.clone(),
        can_receive_input,
        is_alive,
        workflow_pressure: number_field(session, "workflowOnMeCount") * 5.0
            + number_field(session, "workflowBlockedCount") * 6.0
            + number_field(session, "threadPendingCount") * 3.0
            + number_field(session, "notificationUnreadCount") * 2.0
            + number_field(session, "threadWaitingOnThemCount"),
        exited: session.get("exited").and_then(Value::as_bool) == Some(true)
            || status.as_deref() == Some("exited"),
    })
}

fn route_sessions(state: &Value) -> Vec<Value> {
    let mut sessions = Vec::new();
    for key in ["sessions", "teammates"] {
        if let Some(items) = state.get(key).and_then(Value::as_array) {
            sessions.extend(items.iter().cloned());
        }
    }
    sessions
}

fn route_source_session_id(
    selected_session_id: Option<&str>,
    recipient_ids: &[String],
) -> Option<String> {
    let selected = selected_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    (!recipient_ids.is_empty()).then(|| selected.to_owned())
}

fn route_recipient_ids_from_source(
    selected_session_id: Option<&str>,
    recipient_ids: Vec<String>,
) -> Vec<String> {
    let selected = selected_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    recipient_ids
        .into_iter()
        .filter(|recipient| Some(recipient.as_str()) != selected)
        .collect()
}

fn format_route_preview(recipient_ids: &[String]) -> String {
    if recipient_ids.is_empty() {
        return String::new();
    }
    let preview = recipient_ids
        .iter()
        .take(2)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let remainder = if recipient_ids.len() > 2 {
        format!(", +{}", recipient_ids.len() - 2)
    } else {
        String::new()
    };
    format!(" [{}: {preview}{remainder}]", recipient_ids.len())
}

fn service_info() -> Value {
    get_project_service_manifest()
        .ok()
        .and_then(|manifest| serde_json::to_value(manifest).ok())
        .unwrap_or_else(|| json!({}))
}

fn string_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn number_field(value: &Value, field: &str) -> f64 {
    value.get(field).and_then(Value::as_f64).unwrap_or(0.0)
}
