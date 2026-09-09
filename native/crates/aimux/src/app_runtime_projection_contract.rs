use serde_json::{Map, Value, json};

const MAIN_CHECKOUT_KEY: &str = "__main_checkout__";

pub fn run_app_runtime_projection_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "healthForStatus" => json!(
            array_field(input, "cases")
                .iter()
                .map(|case| health_for_status(
                    optional_str(case, "status"),
                    optional_str(case, "pendingAction")
                ))
                .collect::<Vec<_>>()
        ),
        "buildProjectTopology" => build_project_topology(input),
        "runtimeBrandForCommand" => json!(
            array_field(input, "commands")
                .iter()
                .map(|command| runtime_brand_for_command(command.as_str(), None))
                .collect::<Vec<_>>()
        ),
        "runtimeBrandForKind" => json!(
            array_field(input, "cases")
                .iter()
                .map(|case| {
                    let fallback = if str_field(case, "kind") == "service" {
                        Some("service")
                    } else {
                        Some("unknown")
                    };
                    runtime_brand_for_command(optional_str(case, "command"), fallback)
                })
                .collect::<Vec<_>>()
        ),
        api => panic!("unknown app runtime projection contract api: {api}"),
    }
}

fn build_project_topology(input: &Value) -> Value {
    let project = input.get("project").unwrap_or(&Value::Null);
    let state = input.get("state").unwrap_or(&Value::Null);
    let worktrees = group_by_worktree(state);
    let project_id = format!("project:{}", str_field(project, "path"));
    let topology_worktrees = worktrees.iter().map(topology_worktree).collect::<Vec<_>>();
    let leaf_nodes = topology_worktrees
        .iter()
        .flat_map(|worktree| {
            let agents = array_field(worktree, "agents").iter();
            let services = array_field(worktree, "services").iter();
            agents.chain(services)
        })
        .cloned()
        .collect::<Vec<_>>();
    let project_node = json!({
        "id": project_id,
        "kind": "project",
        "label": str_field(project, "name"),
        "subtitle": str_field(project, "path"),
        "health": rollup_health(&leaf_nodes),
    });

    let mut nodes = Vec::from([project_node.clone()]);
    nodes.extend(topology_worktrees.iter().map(|worktree| {
        object_without_nulls([
            ("id", Some(worktree["id"].clone())),
            ("kind", Some(json!("worktree"))),
            ("label", Some(worktree["name"].clone())),
            (
                "subtitle",
                optional_non_empty_value(worktree.get("branch"))
                    .or_else(|| optional_non_empty_value(worktree.get("path"))),
            ),
            ("health", Some(worktree["health"].clone())),
        ])
    }));
    nodes.extend(leaf_nodes.clone());

    let mut edges = topology_worktrees
        .iter()
        .map(|worktree| {
            let worktree_id = str_field(worktree, "id");
            json!({
                "id": format!("{project_id}->{worktree_id}"),
                "from": project_id,
                "to": worktree_id,
            })
        })
        .collect::<Vec<_>>();
    for worktree in &topology_worktrees {
        let worktree_id = str_field(worktree, "id");
        for node in array_field(worktree, "agents")
            .iter()
            .chain(array_field(worktree, "services"))
        {
            let node_id = str_field(node, "id");
            edges.push(json!({
                "id": format!("{worktree_id}->{node_id}"),
                "from": worktree_id,
                "to": node_id,
            }));
        }
    }

    json!({
        "project": project_node,
        "worktrees": topology_worktrees,
        "nodes": nodes,
        "edges": edges,
        "summary": {
            "worktrees": topology_worktrees.len(),
            "agents": topology_worktrees.iter().map(|worktree| array_field(worktree, "agents").len()).sum::<usize>(),
            "services": topology_worktrees.iter().map(|worktree| array_field(worktree, "services").len()).sum::<usize>(),
            "active": leaf_nodes.iter().filter(|node| str_field(node, "health") == "active").count(),
            "attention": leaf_nodes.iter().filter(|node| str_field(node, "health") == "attention").count(),
            "offline": leaf_nodes.iter().filter(|node| str_field(node, "health") == "offline").count(),
        },
    })
}

fn topology_worktree(bucket: &Value) -> Value {
    let key = str_field(bucket, "key");
    let agents = array_field(bucket, "sessions")
        .iter()
        .map(|session| agent_node(session, key))
        .collect::<Vec<_>>();
    let services = array_field(bucket, "services")
        .iter()
        .map(|service| service_node(service, key))
        .collect::<Vec<_>>();
    json!({
        "id": format!("worktree:{key}"),
        "name": str_field(bucket, "name"),
        "branch": str_field(bucket, "branch"),
        "path": bucket.get("path").cloned().unwrap_or(Value::Null),
        "health": rollup_health(&agents.iter().chain(&services).cloned().collect::<Vec<_>>()),
        "agents": agents,
        "services": services,
    })
}

fn agent_node(session: &Value, worktree_key: &str) -> Value {
    let tool = agent_tool_name(session);
    object_without_nulls([
        (
            "id",
            Some(json!(format!("agent:{}", str_field(session, "id")))),
        ),
        ("kind", Some(json!("agent"))),
        ("label", Some(json!(agent_compact_identity(session)))),
        (
            "subtitle",
            optional_join([
                Some(tool.as_str()),
                optional_str(session, "headline").or_else(|| optional_str(session, "previewLine")),
            ]),
        ),
        ("status", session.get("status").cloned()),
        ("command", session.get("command").cloned()),
        (
            "health",
            Some(json!(health_for_status(
                optional_str(session, "status"),
                optional_str(session, "pendingAction"),
            ))),
        ),
        ("worktreeKey", Some(json!(worktree_key))),
        ("sourceId", session.get("id").cloned()),
    ])
}

fn service_node(service: &Value, worktree_key: &str) -> Value {
    let detail = optional_str(service, "shellCommand")
        .or_else(|| optional_str(service, "previewLine"))
        .or_else(|| optional_str(service, "command"))
        .unwrap_or_default();
    object_without_nulls([
        (
            "id",
            Some(json!(format!("service:{}", str_field(service, "id")))),
        ),
        ("kind", Some(json!("service"))),
        (
            "label",
            Some(json!(
                optional_str(service, "label").unwrap_or_else(|| str_field(service, "id"))
            )),
        ),
        ("subtitle", Some(json!(detail))),
        ("status", service.get("status").cloned()),
        ("command", service.get("command").cloned()),
        (
            "health",
            Some(json!(health_for_status(
                optional_str(service, "status"),
                optional_str(service, "pendingAction"),
            ))),
        ),
        ("worktreeKey", Some(json!(worktree_key))),
        ("sourceId", service.get("id").cloned()),
    ])
}

fn group_by_worktree(state: &Value) -> Vec<Value> {
    let main_path = optional_str(state, "mainCheckoutPath");
    let mut buckets = Vec::<Value>::new();
    buckets.push(json!({
        "key": MAIN_CHECKOUT_KEY,
        "name": state.get("mainCheckoutInfo").and_then(|info| info.get("name")).and_then(Value::as_str).unwrap_or("Main Checkout"),
        "branch": state.get("mainCheckoutInfo").and_then(|info| info.get("branch")).and_then(Value::as_str).unwrap_or_default(),
        "path": main_path,
        "isMainCheckout": true,
        "sessions": [],
        "services": [],
    }));
    for worktree in array_field(state, "worktrees") {
        if main_path.is_some_and(|path| path == str_field(worktree, "path")) {
            continue;
        }
        buckets.push(json!({
            "key": str_field(worktree, "path"),
            "name": str_field(worktree, "name"),
            "branch": str_field(worktree, "branch"),
            "path": str_field(worktree, "path"),
            "isMainCheckout": false,
            "sessions": [],
            "services": [],
        }));
    }
    for session in array_field(state, "sessions") {
        let index = bucket_index(
            &mut buckets,
            main_path,
            optional_str(session, "worktreePath"),
        );
        buckets[index]["sessions"]
            .as_array_mut()
            .expect("bucket sessions")
            .push(session.clone());
    }
    for service in array_field(state, "services") {
        let index = bucket_index(
            &mut buckets,
            main_path,
            optional_str(service, "worktreePath"),
        );
        buckets[index]["services"]
            .as_array_mut()
            .expect("bucket services")
            .push(service.clone());
    }
    buckets
}

fn bucket_index(
    buckets: &mut Vec<Value>,
    main_path: Option<&str>,
    worktree_path: Option<&str>,
) -> usize {
    let Some(worktree_path) = worktree_path else {
        return 0;
    };
    if main_path == Some(worktree_path) {
        return 0;
    }
    if let Some(index) = buckets
        .iter()
        .position(|bucket| str_field(bucket, "key") == worktree_path)
    {
        return index;
    }
    buckets.push(json!({
        "key": worktree_path,
        "name": worktree_path.rsplit(['/', '\\']).next().unwrap_or(worktree_path),
        "branch": "",
        "path": worktree_path,
        "isMainCheckout": false,
        "sessions": [],
        "services": [],
    }));
    buckets.len() - 1
}

fn health_for_status(status: Option<&str>, pending_action: Option<&str>) -> &'static str {
    if pending_action.is_some_and(|action| !action.trim().is_empty()) {
        return "attention";
    }
    match status.unwrap_or_default().trim().to_lowercase().as_str() {
        "running" => "active",
        "waiting" => "attention",
        "idle" => "idle",
        "exited" | "offline" => "offline",
        _ => "idle",
    }
}

fn rollup_health(nodes: &[Value]) -> String {
    nodes
        .iter()
        .map(|node| str_field(node, "health"))
        .max_by_key(|health| health_rank(health))
        .unwrap_or("idle")
        .to_string()
}

fn health_rank(health: &str) -> i32 {
    match health {
        "attention" => 4,
        "active" => 3,
        "idle" => 2,
        "offline" => 1,
        _ => 0,
    }
}

fn runtime_brand_for_command(command: Option<&str>, fallback: Option<&str>) -> Value {
    let normalized = command.unwrap_or_default().trim().to_lowercase();
    if normalized.contains("claude") {
        return brand("claude");
    }
    if normalized.contains("codex") {
        return brand("codex");
    }
    if normalized.contains("bash") || normalized.contains("zsh") || normalized.contains("shell") {
        return brand("shell");
    }
    if let Some(fallback) = fallback {
        return brand(fallback);
    }
    brand("unknown")
}

fn brand(id: &str) -> Value {
    match id {
        "claude" => {
            json!({"id": "claude", "label": "Claude", "shortLabel": "CL", "color": "#f97316", "background": "rgba(249, 115, 22, 0.14)"})
        }
        "codex" => {
            json!({"id": "codex", "label": "Codex", "shortLabel": "CX", "color": "#22c55e", "background": "rgba(34, 197, 94, 0.14)"})
        }
        "shell" => {
            json!({"id": "shell", "label": "Shell", "shortLabel": "SH", "color": "#38bdf8", "background": "rgba(56, 189, 248, 0.14)"})
        }
        "service" => {
            json!({"id": "service", "label": "Service", "shortLabel": "SV", "color": "#a78bfa", "background": "rgba(167, 139, 250, 0.14)"})
        }
        _ => {
            json!({"id": "unknown", "label": "Unknown", "shortLabel": "??", "color": "#a1a1aa", "background": "rgba(161, 161, 170, 0.14)"})
        }
    }
}

fn agent_tool_name(agent: &Value) -> String {
    if let Some(tool_config_key) =
        optional_str(agent, "toolConfigKey").filter(|value| !value.trim().is_empty())
    {
        return tool_config_key.to_string();
    }
    if let Some(token) = first_token_of(optional_str(agent, "command")) {
        return token;
    }
    if let Some(tool) = tool_from_generated_label(optional_str(agent, "label").unwrap_or_default())
    {
        return tool;
    }
    if let Some(tool) = tool_from_generated_label(optional_str(agent, "id").unwrap_or_default()) {
        return tool;
    }
    String::from("agent")
}

fn agent_compact_identity(agent: &Value) -> String {
    let name = agent_short_name(agent);
    match optional_str(agent, "role").filter(|role| !role.trim().is_empty()) {
        Some(role) => format!("{name} ({role})"),
        None => name,
    }
}

fn agent_short_name(agent: &Value) -> String {
    let label = optional_str(agent, "label").unwrap_or_default().trim();
    if !label.is_empty() && !is_generated_agent_label(label, agent) {
        return label.to_string();
    }
    agent_tool_name(agent)
}

fn is_generated_agent_label(label: &str, agent: &Value) -> bool {
    let id = optional_str(agent, "id").unwrap_or_default().trim();
    if !id.is_empty() && label == id {
        return true;
    }
    let Some(tool) = tool_from_generated_label(label) else {
        return false;
    };
    let agent_tool = agent_tool_name(agent).to_lowercase();
    !agent_tool.is_empty()
        && tool == agent_tool
        && label.to_lowercase().starts_with(&format!("{tool}-"))
}

fn tool_from_generated_label(value: &str) -> Option<String> {
    let lower = value.to_lowercase();
    for tool in ["claude", "codex", "aider", "shell"] {
        let Some(rest) = lower.strip_prefix(&format!("{tool}-")) else {
            continue;
        };
        if rest.len() >= 5
            && rest.chars().any(|ch| ch.is_ascii_digit())
            && rest
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        {
            return Some(tool.to_string());
        }
    }
    None
}

fn first_token_of(command: Option<&str>) -> Option<String> {
    command
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
}

fn object_without_nulls<const N: usize>(entries: [(&str, Option<Value>); N]) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        if let Some(value) = value.filter(|value| !value.is_null()) {
            map.insert(key.to_string(), value);
        }
    }
    Value::Object(map)
}

fn optional_join<const N: usize>(parts: [Option<&str>; N]) -> Option<Value> {
    let joined = parts
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    if joined.is_empty() {
        None
    } else {
        Some(json!(joined))
    }
}

fn optional_non_empty_value(value: Option<&Value>) -> Option<Value> {
    value.cloned().filter(|value| match value {
        Value::String(text) => !text.is_empty(),
        Value::Null => false,
        _ => true,
    })
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

fn optional_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}
