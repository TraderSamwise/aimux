use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

const MAX_VISIBLE_ATTACHED_AGENTS_PER_WORKTREE: usize = 5;

pub fn run_worktree_state_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "getWorktreeCreatePath" => get_worktree_create_path(input),
        "getWorktreeAddArgs" => get_worktree_add_args(input),
        "isToolInternalWorktree" => json!(is_tool_internal_worktree(
            input.get("worktree").unwrap_or(&Value::Null)
        )),
        "listWorktreeGraveyardEntries" => graveyard_projection(),
        "buildGraveyardViewModel" => {
            build_graveyard_view_model(input.get("value").unwrap_or(&Value::Null))
        }
        _ => panic!("unknown worktree state contract api: {api}"),
    }
}

fn get_worktree_create_path(input: &Value) -> Value {
    let name = str_field(input, "worktreeName");
    let base_dir = input
        .get("config")
        .and_then(|config| config.get("worktrees"))
        .and_then(|worktrees| worktrees.get("baseDir"))
        .and_then(Value::as_str)
        .unwrap_or(".aimux/worktrees");
    let target = if base_dir.starts_with('/') {
        format!("{base_dir}/{name}")
    } else {
        format!("<repo>/{base_dir}/{name}")
    };
    json!({ "target": target })
}

fn get_worktree_add_args(input: &Value) -> Value {
    let branch = str_field(input, "branch");
    let target_path = str_field(input, "targetPath");
    if bool_field(input, "branchExists") {
        json!({ "args": ["worktree", "add", target_path, branch] })
    } else {
        json!({ "args": ["worktree", "add", target_path, "-b", branch] })
    }
}

fn is_tool_internal_worktree(worktree: &Value) -> bool {
    let name = str_field(worktree, "name");
    let path = str_field(worktree, "path").replace('\\', "/");
    let branch = str_field(worktree, "branch");
    (name.starts_with("agent-") && branch.starts_with("worktree-agent-"))
        || path.contains("/.claude/worktrees/agent-")
            && path
                .rsplit('/')
                .next()
                .is_some_and(|leaf| leaf.starts_with("agent-"))
}

fn graveyard_projection() -> Value {
    json!([
      {
        "name": "demo",
        "path": "<repo>/.aimux/worktrees/demo",
        "branch": "demo",
        "graveyardedAt": "2026-05-01T00:00:03.000Z",
        "agents": [
          {
            "id": "codex-demo",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "args": [],
            "status": "offline",
            "lifecycle": "offline",
            "createdAt": "2026-05-01T00:00:01.000Z",
            "updatedAt": "2026-05-01T00:00:01.000Z",
            "worktreePath": "<repo>/.aimux/worktrees/demo"
          }
        ],
        "services": [
          {
            "id": "service-demo",
            "status": "stopped",
            "command": "zsh",
            "args": [],
            "launchCommandLine": "yarn web",
            "worktreePath": "<repo>/.aimux/worktrees/demo",
            "cwd": "<repo>/.aimux/worktrees/demo",
            "label": "shell",
            "createdAt": "2026-05-01T00:00:02.000Z"
          }
        ]
      }
    ])
}

fn build_graveyard_view_model(input: &Value) -> Value {
    let worktrees = array_field(input, "worktrees");
    let agents = array_field(input, "agents");
    let last_used = input.get("lastUsedById").unwrap_or(&Value::Null);
    let mut rows = Vec::new();
    let mut selectable_rows = Vec::new();
    let mut flat_agents_claimed_by_worktree = HashSet::new();
    let mut rendered_agent_ids = HashSet::new();

    if !worktrees.is_empty() {
        rows.push(json!({ "kind": "section", "label": "Worktrees" }));
        for worktree in sort_worktrees(worktrees, agents, last_used) {
            let attached_agents = collect_attached_agents(worktree, agents, last_used);
            let attached_agent_ids: HashSet<String> = attached_agents
                .iter()
                .filter_map(|agent| agent["entry"]["id"].as_str().map(ToOwned::to_owned))
                .collect();
            for agent in agents {
                if str_field(agent, "worktreePath") == str_field(worktree, "path")
                    && attached_agent_ids.contains(str_field(agent, "id"))
                {
                    flat_agents_claimed_by_worktree.insert(str_field(agent, "id").to_string());
                }
            }
            let attached_services = collect_attached_services(worktree, last_used);
            let visible_attached_agents = attached_agents
                .iter()
                .take(MAX_VISIBLE_ATTACHED_AGENTS_PER_WORKTREE)
                .cloned()
                .collect::<Vec<_>>();
            let hidden_attached_agent_count = attached_agents
                .len()
                .saturating_sub(visible_attached_agents.len());
            let mut row = object_value(vec![
                ("kind", json!("worktree")),
                ("entry", worktree.clone()),
                ("attachedAgents", json!(attached_agents)),
                ("visibleAttachedAgents", json!(visible_attached_agents)),
                (
                    "hiddenAttachedAgentCount",
                    json!(hidden_attached_agent_count),
                ),
                ("attachedServices", json!(attached_services)),
            ]);
            let last_used_at = max_last_used_at(
                row["attachedAgents"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .chain(row["attachedServices"].as_array().into_iter().flatten()),
            )
            .map(ToOwned::to_owned);
            if let Some(last_used_at) = last_used_at {
                row.as_object_mut()
                    .expect("worktree row object")
                    .insert("lastUsedAt".to_string(), json!(last_used_at));
            }
            if let Some(sort_at) = worktree_sort_timestamp(worktree, &row) {
                row.as_object_mut()
                    .expect("worktree row object")
                    .insert("sortAt".to_string(), json!(sort_at));
            }
            let worktree_row = add_selectable(row, &mut selectable_rows);
            rows.push(worktree_row.clone());
            for agent in worktree_row["attachedAgents"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if let Some(id) = agent["entry"]["id"].as_str() {
                    rendered_agent_ids.insert(id.to_string());
                }
            }
            for agent in worktree_row["visibleAttachedAgents"]
                .as_array()
                .into_iter()
                .flatten()
            {
                rows.push(json!({
                    "kind": "attached-agent-display",
                    "parentPath": str_field(worktree, "path"),
                    "agent": agent,
                }));
            }
            if hidden_attached_agent_count > 0 {
                rows.push(json!({
                    "kind": "attached-more-display",
                    "parentPath": str_field(worktree, "path"),
                    "hiddenAgentCount": hidden_attached_agent_count,
                }));
            }
            for service in worktree_row["attachedServices"]
                .as_array()
                .into_iter()
                .flatten()
            {
                rows.push(json!({
                    "kind": "attached-service-display",
                    "parentPath": str_field(worktree, "path"),
                    "service": service,
                }));
            }
        }
    }

    let standalone_agents = agents
        .iter()
        .filter(|agent| !flat_agents_claimed_by_worktree.contains(str_field(agent, "id")))
        .cloned()
        .collect::<Vec<_>>();
    let agents_by_worktree = group_standalone_agents_by_worktree(&standalone_agents, last_used);
    if !agents_by_worktree.is_empty() {
        rows.push(json!({ "kind": "section", "label": "Agents by Worktree" }));
        for (worktree_path, entries) in agents_by_worktree {
            rows.push(json!({
                "kind": "agent-worktree",
                "path": worktree_path,
                "name": basename(&worktree_path),
            }));
            for agent in entries {
                let mut row = object_value(vec![
                    ("kind", json!("standalone-agent")),
                    ("entry", agent.clone()),
                ]);
                if let Some(last_used_at) = last_used_at(last_used, str_field(&agent, "id")) {
                    row.as_object_mut()
                        .expect("standalone row object")
                        .insert("lastUsedAt".to_string(), json!(last_used_at));
                }
                let row = add_selectable(row, &mut selectable_rows);
                rows.push(row);
                rendered_agent_ids.insert(str_field(&agent, "id").to_string());
            }
        }
    }

    let orphan_agents = standalone_agents
        .iter()
        .filter(|agent| str_field(agent, "worktreePath").is_empty())
        .cloned()
        .collect::<Vec<_>>();
    if !orphan_agents.is_empty() {
        rows.push(json!({ "kind": "section", "label": "Orphaned Agents" }));
        for agent in sort_agents(orphan_agents, last_used) {
            let mut row = object_value(vec![
                ("kind", json!("orphan-agent")),
                ("entry", agent.clone()),
            ]);
            if let Some(last_used_at) = last_used_at(last_used, str_field(&agent, "id")) {
                row.as_object_mut()
                    .expect("orphan row object")
                    .insert("lastUsedAt".to_string(), json!(last_used_at));
            }
            let row = add_selectable(row, &mut selectable_rows);
            rows.push(row);
            rendered_agent_ids.insert(str_field(&agent, "id").to_string());
        }
    }

    let orphan_teammates = select_orphan_teammates(input);
    let input_agent_ids: HashSet<String> = agents
        .iter()
        .map(|agent| str_field(agent, "id").to_string())
        .collect();
    let orphan_teammates = orphan_teammates
        .into_iter()
        .filter(|session| {
            let id = str_field(session, "id");
            !rendered_agent_ids.contains(id) && !input_agent_ids.contains(id)
        })
        .collect::<Vec<_>>();
    if !orphan_teammates.is_empty() {
        rows.push(json!({ "kind": "section", "label": "Orphaned Teammates" }));
        for teammate in orphan_teammates {
            let parent_session_id = teammate["team"]["parentSessionId"]
                .as_str()
                .unwrap_or_default();
            if parent_session_id.is_empty() {
                continue;
            }
            let mut row = object_value(vec![
                ("kind", json!("orphan-teammate")),
                ("entry", teammate.clone()),
                ("parentSessionId", json!(parent_session_id)),
            ]);
            if let Some(last_used_at) = last_used_at(last_used, str_field(&teammate, "id")) {
                row.as_object_mut()
                    .expect("orphan teammate row object")
                    .insert("lastUsedAt".to_string(), json!(last_used_at));
            }
            rows.push(row);
        }
    }

    json!({ "rows": rows, "selectableRows": selectable_rows })
}

fn sort_worktrees<'a>(
    worktrees: &'a [Value],
    flat_agents: &'a [Value],
    last_used: &'a Value,
) -> Vec<&'a Value> {
    let mut decorated = worktrees
        .iter()
        .map(|worktree| {
            let attached_agents = collect_attached_agents(worktree, flat_agents, last_used);
            let attached_services = collect_attached_services(worktree, last_used);
            let row = json!({
                "attachedAgents": attached_agents,
                "attachedServices": attached_services,
            });
            let sort_at = worktree_sort_timestamp(worktree, &row).unwrap_or_default();
            (worktree, sort_at)
        })
        .collect::<Vec<_>>();
    decorated.sort_by(|(left, left_sort), (right, right_sort)| {
        right_sort
            .cmp(left_sort)
            .then_with(|| str_field(left, "name").cmp(str_field(right, "name")))
    });
    decorated
        .into_iter()
        .map(|(worktree, _)| worktree)
        .collect()
}

fn collect_attached_agents(
    worktree: &Value,
    flat_agents: &[Value],
    last_used: &Value,
) -> Vec<Value> {
    let mut by_id = Vec::<Value>::new();
    let mut seen = HashSet::new();
    for agent in array_field(worktree, "agents") {
        let id = str_field(agent, "id");
        seen.insert(id.to_string());
        by_id.push(agent_view(agent, "worktree", last_used));
    }
    for agent in flat_agents {
        if str_field(agent, "worktreePath") != str_field(worktree, "path") {
            continue;
        }
        let id = str_field(agent, "id");
        if seen.contains(id) {
            continue;
        }
        seen.insert(id.to_string());
        by_id.push(agent_view(agent, "standalone", last_used));
    }
    by_id.sort_by(|left, right| {
        compare_recency_or_created(
            &left["entry"],
            left.get("lastUsedAt").and_then(Value::as_str),
            &right["entry"],
            right.get("lastUsedAt").and_then(Value::as_str),
        )
    });
    by_id
}

fn collect_attached_services(worktree: &Value, last_used: &Value) -> Vec<Value> {
    let mut services = array_field(worktree, "services")
        .iter()
        .map(|service| {
            let mut view = object_value(vec![("entry", service.clone())]);
            if let Some(last_used_at) = last_used_at(last_used, str_field(service, "id")) {
                view.as_object_mut()
                    .expect("service view object")
                    .insert("lastUsedAt".to_string(), json!(last_used_at));
            }
            view
        })
        .collect::<Vec<_>>();
    services.sort_by(|left, right| {
        compare_recency_or_created(
            &left["entry"],
            left.get("lastUsedAt").and_then(Value::as_str),
            &right["entry"],
            right.get("lastUsedAt").and_then(Value::as_str),
        )
    });
    services
}

fn agent_view(agent: &Value, source: &str, last_used: &Value) -> Value {
    let mut view = object_value(vec![("entry", agent.clone()), ("source", json!(source))]);
    if let Some(last_used_at) = last_used_at(last_used, str_field(agent, "id")) {
        view.as_object_mut()
            .expect("agent view object")
            .insert("lastUsedAt".to_string(), json!(last_used_at));
    }
    view
}

fn group_standalone_agents_by_worktree(
    agents: &[Value],
    last_used: &Value,
) -> Vec<(String, Vec<Value>)> {
    let mut by_worktree = BTreeMap::<String, Vec<Value>>::new();
    for agent in agents {
        let worktree_path = str_field(agent, "worktreePath");
        if worktree_path.is_empty() {
            continue;
        }
        by_worktree
            .entry(worktree_path.to_string())
            .or_default()
            .push(agent.clone());
    }
    by_worktree
        .into_iter()
        .map(|(path, entries)| (path, sort_agents(entries, last_used)))
        .collect()
}

fn sort_agents(mut agents: Vec<Value>, last_used: &Value) -> Vec<Value> {
    agents.sort_by(|left, right| {
        compare_recency_or_created(
            left,
            last_used_at(last_used, str_field(left, "id")),
            right,
            last_used_at(last_used, str_field(right, "id")),
        )
    });
    agents
}

fn select_orphan_teammates(input: &Value) -> Vec<Value> {
    let mut parents = HashSet::<String>::new();
    for session in array_field(input, "parentSessions") {
        add_known_parent(session, &mut parents);
    }
    for agent in array_field(input, "agents") {
        add_known_parent(agent, &mut parents);
    }
    for worktree in array_field(input, "worktrees") {
        for agent in array_field(worktree, "agents") {
            add_known_parent(agent, &mut parents);
        }
    }

    let mut by_id = HashMap::<String, Value>::new();
    let mut ordered = Vec::<Value>::new();
    for session in array_field(input, "teammates") {
        let parent_session_id = session["team"]["parentSessionId"]
            .as_str()
            .unwrap_or_default();
        if parent_session_id.is_empty() || parents.contains(parent_session_id) {
            continue;
        }
        let id = str_field(session, "id");
        if by_id.contains_key(id) {
            continue;
        }
        by_id.insert(id.to_string(), session.clone());
        ordered.push(session.clone());
    }
    ordered.sort_by(compare_teammates);
    ordered
}

fn add_known_parent(session: &Value, parents: &mut HashSet<String>) {
    if session["team"]["parentSessionId"].as_str().is_some() {
        return;
    }
    let id = str_field(session, "id");
    if !id.is_empty() {
        parents.insert(id.to_string());
    }
}

fn compare_teammates(left: &Value, right: &Value) -> Ordering {
    teammate_order(left)
        .cmp(&teammate_order(right))
        .then_with(|| created_asc(left).cmp(created_asc(right)))
        .then_with(|| str_field(left, "id").cmp(str_field(right, "id")))
}

fn teammate_order(value: &Value) -> i64 {
    value["team"]["order"].as_i64().unwrap_or(i64::MAX)
}

fn created_asc(value: &Value) -> &str {
    value
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or("9999-99-99T99:99:99.999Z")
}

fn compare_recency_or_created(
    left: &Value,
    left_last_used_at: Option<&str>,
    right: &Value,
    right_last_used_at: Option<&str>,
) -> Ordering {
    right_last_used_at
        .unwrap_or_default()
        .cmp(left_last_used_at.unwrap_or_default())
        .then_with(|| str_field(right, "createdAt").cmp(str_field(left, "createdAt")))
        .then_with(|| str_field(left, "id").cmp(str_field(right, "id")))
}

fn worktree_sort_timestamp(worktree: &Value, row: &Value) -> Option<String> {
    let mut best = max_last_used_at(
        row["attachedAgents"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(row["attachedServices"].as_array().into_iter().flatten()),
    );
    for agent in row["attachedAgents"].as_array().into_iter().flatten() {
        best = max_timestamp(
            best,
            agent["entry"].get("createdAt").and_then(Value::as_str),
        );
    }
    for service in row["attachedServices"].as_array().into_iter().flatten() {
        best = max_timestamp(
            best,
            service["entry"].get("createdAt").and_then(Value::as_str),
        );
    }
    max_timestamp(best, worktree.get("graveyardedAt").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn max_last_used_at<'a>(items: impl Iterator<Item = &'a Value>) -> Option<&'a str> {
    let mut best = None;
    for item in items {
        best = max_timestamp(best, item.get("lastUsedAt").and_then(Value::as_str));
    }
    best
}

fn max_timestamp<'a>(current: Option<&'a str>, candidate: Option<&'a str>) -> Option<&'a str> {
    match (current, candidate) {
        (Some(left), Some(right)) if right > left => Some(right),
        (None, Some(right)) => Some(right),
        (Some(left), _) => Some(left),
        (None, None) => None,
    }
}

fn add_selectable(mut row: Value, selectable_rows: &mut Vec<Value>) -> Value {
    let action_index = selectable_rows.len();
    let object = row.as_object_mut().expect("selectable row object");
    object.insert("actionIndex".to_string(), json!(action_index));
    object.insert("actionNumber".to_string(), json!(action_index + 1));
    selectable_rows.push(row.clone());
    row
}

fn last_used_at<'a>(last_used: &'a Value, id: &str) -> Option<&'a str> {
    last_used
        .get(id)
        .and_then(|entry| entry.get("lastUsedAt"))
        .and_then(Value::as_str)
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

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn basename(path: &str) -> &str {
    path.rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
}

fn object_value(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect::<Map<String, Value>>(),
    )
}
