use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

pub fn render_cli_agents_flat_lines(agents: &[Value], project_root: Option<&str>) -> Vec<String> {
    if agents.is_empty() {
        return vec!["no agents".into()];
    }

    let mut lines = Vec::new();
    for agent in agents {
        let role = string_field(agent, "role").unwrap_or_default();
        lines.push(format!(
            "{}  [{}]{}",
            js_string_or_undefined(field(agent, "id")),
            agent_canonical_id(agent),
            if role.is_empty() {
                String::new()
            } else {
                format!("  {role}")
            }
        ));
        lines.push(render_agent_summary(agent));
        if let Some(worktree_path) =
            string_field(agent, "worktreePath").filter(|path| !path.is_empty())
        {
            lines.push(format!("    worktree: {worktree_path}"));
        } else if let Some(project_root) = project_root.filter(|path| !path.is_empty()) {
            lines.push(format!("    worktree: {project_root}"));
        }
        if let Some(task) = field(agent, "task").and_then(Value::as_object) {
            lines.push(format!(
                "    task: {} ({})",
                task.get("description")
                    .filter(|value| !value.is_null())
                    .map(|value| js_string(Some(value)))
                    .unwrap_or_default(),
                task.get("status")
                    .filter(|value| !value.is_null())
                    .map(|value| js_string(Some(value)))
                    .unwrap_or_else(|| "?".into())
            ));
        }
    }
    lines
}

pub fn render_cli_agents_by_worktree_lines(
    agents: &[Value],
    project_root: Option<&str>,
) -> Vec<String> {
    if agents.is_empty() {
        return vec!["no agents".into()];
    }

    let project_root = project_root.unwrap_or_default();
    let mut groups: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for agent in agents {
        let worktree_path = string_field(agent, "worktreePath");
        groups
            .entry(agent_worktree_sort_key(
                worktree_path.as_deref(),
                project_root,
            ))
            .or_default()
            .push(agent);
    }

    let mut lines = Vec::new();
    for (index, (path, mut group_agents)) in groups.into_iter().enumerate() {
        if index > 0 {
            lines.push(String::new());
        }
        let path_for_label = if path.is_empty() {
            None
        } else {
            Some(path.as_str())
        };
        let label = agent_worktree_label(path_for_label, project_root);
        if !path.is_empty() {
            lines.push(format!("{label}  {path}"));
        } else if !project_root.is_empty() {
            lines.push(format!("{label}  {project_root}"));
        } else {
            lines.push(label);
        }

        group_agents.sort_by(|left, right| {
            js_string_or_undefined(field(left, "id"))
                .cmp(&js_string_or_undefined(field(right, "id")))
        });
        for agent in group_agents {
            lines.push(render_agent_summary(agent));
            if let Some(task) = field(agent, "task").and_then(Value::as_object) {
                lines.push(format!(
                    "    task: {} ({})",
                    task.get("description")
                        .filter(|value| !value.is_null())
                        .map(|value| js_string(Some(value)))
                        .unwrap_or_default(),
                    task.get("status")
                        .filter(|value| !value.is_null())
                        .map(|value| js_string(Some(value)))
                        .unwrap_or_else(|| "?".into())
                ));
            }
        }
    }
    lines
}

fn render_agent_summary(agent: &Value) -> String {
    let mut tags = Vec::new();
    if let Some(role) = string_field(agent, "role").filter(|role| !role.is_empty()) {
        tags.push(format!("role={role}"));
    }
    if field(agent, "overseer").is_some_and(truthy) {
        tags.push("overseer".into());
    }
    if field(agent, "scribe").is_some_and(truthy) {
        tags.push("scribe".into());
    }
    if field(agent, "loop")
        .and_then(|loop_value| field(loop_value, "active"))
        .is_some_and(truthy)
    {
        let goal = field(agent, "loop")
            .and_then(|loop_value| string_field(loop_value, "goal"))
            .filter(|goal| !goal.is_empty())
            .map(|goal| format!("={goal}"))
            .unwrap_or_default();
        tags.push(format!("loop{goal}"));
    }

    let state = ["activity", "attention"]
        .into_iter()
        .filter_map(|key| string_field(agent, key))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let mut detail = vec![
        format!("canonical={}", agent_canonical_id(agent)),
        format!("aimux={}", js_string_or_undefined(field(agent, "id"))),
    ];
    if let Some(backend_session_id) =
        string_field(agent, "backendSessionId").filter(|value| !value.is_empty())
    {
        detail.push(format!("backend={backend_session_id}"));
    }
    if !state.is_empty() {
        detail.push(format!("state={state}"));
    }
    if !tags.is_empty() {
        detail.push(tags.join(" "));
    }
    format!(
        "  {}  {}",
        field(agent, "status")
            .filter(|value| !value.is_null())
            .map(|value| js_string(Some(value)))
            .unwrap_or_else(|| "?".into()),
        detail.join("  ")
    )
}

fn agent_canonical_id(agent: &Value) -> String {
    field(agent, "toolConfigKey")
        .or_else(|| field(agent, "tool"))
        .or_else(|| field(agent, "command"))
        .filter(|value| !value.is_null())
        .map(|value| js_string(Some(value)))
        .unwrap_or_else(|| "?".into())
}

fn agent_worktree_label(path: Option<&str>, project_root: &str) -> String {
    match path {
        None => "Main Checkout".into(),
        Some(path) if !project_root.is_empty() && path == project_root => "Main Checkout".into(),
        Some(path) => Path::new(path)
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or(path)
            .to_owned(),
    }
}

fn agent_worktree_sort_key(path: Option<&str>, project_root: &str) -> String {
    match path {
        None => String::new(),
        Some(path) if !project_root.is_empty() && path == project_root => String::new(),
        Some(path) => path.to_owned(),
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    field(value, key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string_or_undefined(value: Option<&Value>) -> String {
    value
        .map(|value| js_string(Some(value)))
        .unwrap_or_else(|| "undefined".into())
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| js_string(Some(value)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}
