use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_session_states, list_topology_worktree_states, list_worktree_graveyard_entries,
    read_runtime_topology, runtime_topology_path,
};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;
use super::usage::load_last_used_state;

const LIVE_WORKTREE_STATUSES: &[&str] = &[
    "planned", "creating", "active", "removing", "missing", "error",
];
const MAX_VISIBLE_ATTACHED_AGENTS_PER_WORKTREE: usize = 5;

pub fn route_worktree_read_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let pathname = project_service_pathname(path);
    if pathname != routes::WORKTREES && pathname != routes::GRAVEYARD {
        return None;
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return Some(json_response(500, json!({ "ok": false, "error": error }))),
    };
    if pathname == routes::WORKTREES {
        let worktrees = context
            .desktop_state
            .as_ref()
            .and_then(|state| state.get("worktrees"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                list_topology_worktree_states(&topology, Some(LIVE_WORKTREE_STATUSES))
            });
        return Some(json_response(
            200,
            json!({ "ok": true, "worktrees": worktrees }),
        ));
    }
    let entries = list_topology_session_states(&topology, Some(&["graveyard"]));
    let worktrees = list_worktree_graveyard_entries(&topology);
    let parent_sessions =
        list_topology_session_states(&topology, Some(&["starting", "running", "idle", "offline"]));
    let teammates = parent_sessions
        .iter()
        .filter(|session| is_teammate_session(session))
        .cloned()
        .collect::<Vec<_>>();
    let last_used = load_last_used_state(&project_state_dir);
    let last_used_by_id = last_used.get("items").cloned().unwrap_or_else(|| json!({}));
    Some(json_response(
        200,
        json!({
            "ok": true,
            "entries": entries,
            "worktrees": worktrees,
            "viewModel": build_graveyard_view_model(GraveyardViewModelInput {
                agents: entries,
                worktrees,
                parent_sessions,
                teammates,
                last_used_by_id,
            }),
        }),
    ))
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraveyardViewModelInput {
    pub agents: Vec<Value>,
    pub worktrees: Vec<Value>,
    pub parent_sessions: Vec<Value>,
    pub teammates: Vec<Value>,
    pub last_used_by_id: Value,
}

pub fn build_graveyard_view_model(input: GraveyardViewModelInput) -> Value {
    let mut rows = Vec::new();
    let mut selectable_rows = Vec::new();
    let mut flat_agents_claimed_by_worktree = BTreeSet::new();
    let mut rendered_agent_ids = BTreeSet::new();

    if !input.worktrees.is_empty() {
        rows.push(json!({ "kind": "section", "label": "Worktrees" }));
        for worktree in sort_worktrees(&input.worktrees, &input.agents, &input.last_used_by_id) {
            let attached_agents =
                collect_attached_agents(&worktree, &input.agents, &input.last_used_by_id);
            let attached_agent_ids = attached_agents
                .iter()
                .filter_map(|agent| {
                    agent
                        .get("entry")
                        .and_then(|entry| string_field(entry, "id"))
                })
                .collect::<BTreeSet<_>>();
            for agent in &input.agents {
                if string_field(agent, "worktreePath") == string_field(&worktree, "path")
                    && string_field(agent, "id").is_some_and(|id| attached_agent_ids.contains(id))
                {
                    flat_agents_claimed_by_worktree
                        .insert(string_field(agent, "id").unwrap_or("").to_owned());
                }
            }
            let attached_services = collect_attached_services(&worktree, &input.last_used_by_id);
            let visible_attached_agents = attached_agents
                .iter()
                .take(MAX_VISIBLE_ATTACHED_AGENTS_PER_WORKTREE)
                .cloned()
                .collect::<Vec<_>>();
            let hidden_attached_agent_count = attached_agents
                .len()
                .saturating_sub(visible_attached_agents.len());
            let mut worktree_row = json!({
                "kind": "worktree",
                "entry": worktree,
                "attachedAgents": attached_agents,
                "visibleAttachedAgents": visible_attached_agents,
                "hiddenAttachedAgentCount": hidden_attached_agent_count,
                "attachedServices": attached_services,
            });
            set_optional_string(
                &mut worktree_row,
                "lastUsedAt",
                max_last_used_at(attached_agents_and_services(
                    &attached_agents,
                    &attached_services,
                )),
            );
            set_optional_string(
                &mut worktree_row,
                "sortAt",
                worktree_sort_timestamp(&worktree, &attached_agents, &attached_services),
            );
            add_selectable(&mut worktree_row, &mut selectable_rows);
            rows.push(worktree_row.clone());
            for agent in &attached_agents {
                if let Some(id) = agent
                    .get("entry")
                    .and_then(|entry| string_field(entry, "id"))
                {
                    rendered_agent_ids.insert(id.to_owned());
                }
            }
            for agent in &visible_attached_agents {
                rows.push(json!({
                    "kind": "attached-agent-display",
                    "parentPath": string_field(&worktree, "path").unwrap_or(""),
                    "agent": agent,
                }));
            }
            if hidden_attached_agent_count > 0 {
                rows.push(json!({
                    "kind": "attached-more-display",
                    "parentPath": string_field(&worktree, "path").unwrap_or(""),
                    "hiddenAgentCount": hidden_attached_agent_count,
                }));
            }
            for service in &attached_services {
                rows.push(json!({
                    "kind": "attached-service-display",
                    "parentPath": string_field(&worktree, "path").unwrap_or(""),
                    "service": service,
                }));
            }
        }
    }

    let standalone_agents = input
        .agents
        .iter()
        .filter(|agent| {
            string_field(agent, "id").is_none_or(|id| !flat_agents_claimed_by_worktree.contains(id))
        })
        .cloned()
        .collect::<Vec<_>>();
    let agents_by_worktree =
        group_standalone_agents_by_worktree(&standalone_agents, &input.last_used_by_id);
    if !agents_by_worktree.is_empty() {
        rows.push(json!({ "kind": "section", "label": "Agents by Worktree" }));
        for (worktree_path, agents) in agents_by_worktree {
            rows.push(json!({
                "kind": "agent-worktree",
                "path": worktree_path,
                "name": path_basename(&worktree_path).unwrap_or(&worktree_path),
            }));
            for agent in agents {
                let mut row = json!({
                    "kind": "standalone-agent",
                    "entry": agent,
                });
                set_optional_string(
                    &mut row,
                    "lastUsedAt",
                    last_used_at(
                        &input.last_used_by_id,
                        string_field(&agent, "id").unwrap_or(""),
                    ),
                );
                add_selectable(&mut row, &mut selectable_rows);
                if let Some(id) = string_field(&agent, "id") {
                    rendered_agent_ids.insert(id.to_owned());
                }
                rows.push(row);
            }
        }
    }

    let orphan_agents = standalone_agents
        .iter()
        .filter(|agent| string_field(agent, "worktreePath").is_none())
        .cloned()
        .collect::<Vec<_>>();
    if !orphan_agents.is_empty() {
        rows.push(json!({ "kind": "section", "label": "Orphaned Agents" }));
        for agent in sort_agents(&orphan_agents, &input.last_used_by_id) {
            let mut row = json!({
                "kind": "orphan-agent",
                "entry": agent,
            });
            set_optional_string(
                &mut row,
                "lastUsedAt",
                last_used_at(
                    &input.last_used_by_id,
                    string_field(&agent, "id").unwrap_or(""),
                ),
            );
            add_selectable(&mut row, &mut selectable_rows);
            if let Some(id) = string_field(&agent, "id") {
                rendered_agent_ids.insert(id.to_owned());
            }
            rows.push(row);
        }
    }

    let orphan_teammates =
        select_orphan_teammates(&input.teammates, &collect_known_parent_ids(&input))
            .into_iter()
            .filter(|session| {
                string_field(session, "id").is_some_and(|id| {
                    !rendered_agent_ids.contains(id)
                        && !input
                            .agents
                            .iter()
                            .any(|agent| string_field(agent, "id") == Some(id))
                })
            })
            .collect::<Vec<_>>();
    if !orphan_teammates.is_empty() {
        rows.push(json!({ "kind": "section", "label": "Orphaned Teammates" }));
        for teammate in orphan_teammates {
            let Some(parent_session_id) = team_string_field(&teammate, "parentSessionId") else {
                continue;
            };
            let mut row = json!({
                "kind": "orphan-teammate",
                "entry": teammate,
                "parentSessionId": parent_session_id,
            });
            set_optional_string(
                &mut row,
                "lastUsedAt",
                last_used_at(
                    &input.last_used_by_id,
                    string_field(&teammate, "id").unwrap_or(""),
                ),
            );
            rows.push(row);
        }
    }

    json!({ "rows": rows, "selectableRows": selectable_rows })
}

fn add_selectable(row: &mut Value, selectable_rows: &mut Vec<Value>) {
    let action_index = selectable_rows.len();
    if let Value::Object(map) = row {
        map.insert("actionIndex".into(), Value::from(action_index));
        map.insert("actionNumber".into(), Value::from(action_index + 1));
    }
    selectable_rows.push(row.clone());
}

fn set_optional_string(target: &mut Value, key: &str, value: Option<String>) {
    if let Some(value) = value
        && let Value::Object(map) = target
    {
        map.insert(key.into(), Value::String(value));
    }
}

fn collect_known_parent_ids(input: &GraveyardViewModelInput) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for session in &input.parent_sessions {
        add_known_parent_id(&mut ids, session);
    }
    for agent in &input.agents {
        add_known_parent_id(&mut ids, agent);
    }
    for worktree in &input.worktrees {
        for agent in array_field(worktree, "agents") {
            add_known_parent_id(&mut ids, agent);
        }
    }
    ids
}

fn add_known_parent_id(ids: &mut BTreeSet<String>, session: &Value) {
    if is_teammate_session(session) {
        return;
    }
    if let Some(id) = string_field(session, "id") {
        ids.insert(id.to_owned());
    }
}

fn sort_worktrees(
    worktrees: &[Value],
    flat_agents: &[Value],
    last_used_by_id: &Value,
) -> Vec<Value> {
    let mut sorted = worktrees.to_vec();
    sorted.sort_by(|left, right| {
        let left_sort = worktree_sort_timestamp(
            left,
            &collect_attached_agents(left, flat_agents, last_used_by_id),
            &collect_attached_services(left, last_used_by_id),
        );
        let right_sort = worktree_sort_timestamp(
            right,
            &collect_attached_agents(right, flat_agents, last_used_by_id),
            &collect_attached_services(right, last_used_by_id),
        );
        compare_timestamp_desc(right_sort.as_deref(), left_sort.as_deref()).then_with(|| {
            string_field(left, "name")
                .unwrap_or("")
                .cmp(string_field(right, "name").unwrap_or(""))
        })
    });
    sorted
}

fn collect_attached_agents(
    worktree: &Value,
    flat_agents: &[Value],
    last_used_by_id: &Value,
) -> Vec<Value> {
    let mut by_id = Map::new();
    for agent in array_field(worktree, "agents") {
        if let Some(id) = string_field(agent, "id") {
            let mut view = json!({ "entry": agent, "source": "worktree" });
            set_optional_string(&mut view, "lastUsedAt", last_used_at(last_used_by_id, id));
            by_id.insert(id.to_owned(), view);
        }
    }
    for agent in flat_agents {
        if string_field(agent, "worktreePath") != string_field(worktree, "path") {
            continue;
        }
        let Some(id) = string_field(agent, "id") else {
            continue;
        };
        if by_id.contains_key(id) {
            continue;
        }
        let mut view = json!({ "entry": agent, "source": "standalone" });
        set_optional_string(&mut view, "lastUsedAt", last_used_at(last_used_by_id, id));
        by_id.insert(id.to_owned(), view);
    }
    let mut agents = by_id.into_values().collect::<Vec<_>>();
    agents.sort_by(compare_agent_or_service_view);
    agents
}

fn collect_attached_services(worktree: &Value, last_used_by_id: &Value) -> Vec<Value> {
    let mut services = array_field(worktree, "services")
        .iter()
        .map(|service| {
            let mut view = json!({ "entry": service });
            set_optional_string(
                &mut view,
                "lastUsedAt",
                last_used_at(last_used_by_id, string_field(service, "id").unwrap_or("")),
            );
            view
        })
        .collect::<Vec<_>>();
    services.sort_by(compare_agent_or_service_view);
    services
}

fn group_standalone_agents_by_worktree(
    agents: &[Value],
    last_used_by_id: &Value,
) -> Vec<(String, Vec<Value>)> {
    let mut paths = BTreeSet::new();
    for agent in agents {
        if let Some(path) = string_field(agent, "worktreePath") {
            paths.insert(path.to_owned());
        }
    }
    paths
        .into_iter()
        .map(|path| {
            let mut entries = agents
                .iter()
                .filter(|agent| string_field(agent, "worktreePath") == Some(path.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            entries.sort_by(|left, right| compare_recency_or_created(left, right, last_used_by_id));
            (path, entries)
        })
        .collect()
}

fn sort_agents(agents: &[Value], last_used_by_id: &Value) -> Vec<Value> {
    let mut sorted = agents.to_vec();
    sorted.sort_by(|left, right| compare_recency_or_created(left, right, last_used_by_id));
    sorted
}

fn select_orphan_teammates(teammates: &[Value], known_parent_ids: &BTreeSet<String>) -> Vec<Value> {
    let mut by_id = Map::new();
    for teammate in teammates {
        let Some(parent_session_id) = team_string_field(teammate, "parentSessionId") else {
            continue;
        };
        if known_parent_ids.contains(parent_session_id) {
            continue;
        }
        if let Some(id) = string_field(teammate, "id")
            && !by_id.contains_key(id)
        {
            by_id.insert(id.to_owned(), teammate.clone());
        }
    }
    let mut selected = by_id.into_values().collect::<Vec<_>>();
    selected.sort_by(compare_teammate_sessions);
    selected
}

fn attached_agents_and_services<'a>(agents: &'a [Value], services: &'a [Value]) -> Vec<&'a Value> {
    agents.iter().chain(services.iter()).collect()
}

fn max_last_used_at(items: Vec<&Value>) -> Option<String> {
    let mut best = None;
    for item in items {
        let current = string_field(item, "lastUsedAt");
        if compare_timestamp_desc(current, best.as_deref()) == std::cmp::Ordering::Less {
            best = current.map(str::to_owned);
        }
    }
    best
}

fn worktree_sort_timestamp(
    worktree: &Value,
    agents: &[Value],
    services: &[Value],
) -> Option<String> {
    let mut best = max_last_used_at(attached_agents_and_services(agents, services));
    for agent in agents {
        let created = agent
            .get("entry")
            .and_then(|entry| string_field(entry, "createdAt"));
        if compare_timestamp_desc(created, best.as_deref()) == std::cmp::Ordering::Less {
            best = created.map(str::to_owned);
        }
    }
    for service in services {
        let created = service
            .get("entry")
            .and_then(|entry| string_field(entry, "createdAt"));
        if compare_timestamp_desc(created, best.as_deref()) == std::cmp::Ordering::Less {
            best = created.map(str::to_owned);
        }
    }
    let graveyarded = string_field(worktree, "graveyardedAt");
    if compare_timestamp_desc(graveyarded, best.as_deref()) == std::cmp::Ordering::Less {
        best = graveyarded.map(str::to_owned);
    }
    best
}

fn compare_agent_or_service_view(left: &Value, right: &Value) -> std::cmp::Ordering {
    let left_entry = left.get("entry").unwrap_or(left);
    let right_entry = right.get("entry").unwrap_or(right);
    compare_timestamp_desc(
        string_field(left, "lastUsedAt"),
        string_field(right, "lastUsedAt"),
    )
    .then_with(|| {
        compare_timestamp_desc(
            string_field(left_entry, "createdAt"),
            string_field(right_entry, "createdAt"),
        )
    })
    .then_with(|| {
        string_field(left_entry, "id")
            .unwrap_or("")
            .cmp(string_field(right_entry, "id").unwrap_or(""))
    })
}

fn compare_recency_or_created(
    left: &Value,
    right: &Value,
    last_used_by_id: &Value,
) -> std::cmp::Ordering {
    compare_timestamp_desc(
        last_used_at(last_used_by_id, string_field(left, "id").unwrap_or("")).as_deref(),
        last_used_at(last_used_by_id, string_field(right, "id").unwrap_or("")).as_deref(),
    )
    .then_with(|| {
        compare_timestamp_desc(
            string_field(left, "createdAt"),
            string_field(right, "createdAt"),
        )
    })
    .then_with(|| {
        string_field(left, "id")
            .unwrap_or("")
            .cmp(string_field(right, "id").unwrap_or(""))
    })
}

fn compare_timestamp_desc(left: Option<&str>, right: Option<&str>) -> std::cmp::Ordering {
    timestamp_sort_value(right).cmp(timestamp_sort_value(left))
}

fn timestamp_sort_value(value: Option<&str>) -> &str {
    value.unwrap_or("").trim()
}

fn last_used_at(last_used_by_id: &Value, id: &str) -> Option<String> {
    last_used_by_id
        .get(id)
        .and_then(|item| item.get("lastUsedAt"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn is_teammate_session(session: &Value) -> bool {
    team_string_field(session, "parentSessionId").is_some()
}

fn compare_teammate_sessions(left: &Value, right: &Value) -> std::cmp::Ordering {
    let left_order = team_number_field(left, "order").unwrap_or(f64::INFINITY);
    let right_order = team_number_field(right, "order").unwrap_or(f64::INFINITY);
    if left_order != right_order {
        return left_order.total_cmp(&right_order);
    }
    compare_timestamp_asc(
        string_field(left, "createdAt"),
        string_field(right, "createdAt"),
    )
    .then_with(|| {
        string_field(left, "id")
            .unwrap_or("")
            .cmp(string_field(right, "id").unwrap_or(""))
    })
}

fn compare_timestamp_asc(left: Option<&str>, right: Option<&str>) -> std::cmp::Ordering {
    timestamp_sort_value(left).cmp(timestamp_sort_value(right))
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
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

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn path_basename(path: &str) -> Option<&str> {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
