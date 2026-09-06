use serde_json::{Value, json};

pub fn run_monitor_targets_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "monitorSessionTargetsForProject" => monitor_session_targets_for_project(
            input.get("project").unwrap_or(&Value::Null),
            input.get("state").unwrap_or(&Value::Null),
        ),
        "monitorSharedTargets" => {
            monitor_shared_targets(input.get("shares").unwrap_or(&Value::Null))
        }
        "targetMatchesSettings" => json!(target_matches_settings(
            input.get("target").unwrap_or(&Value::Null),
            input.get("settings").unwrap_or(&Value::Null)
        )),
        "monitorTargetLabel" => json!(monitor_target_label(
            input.get("target").unwrap_or(&Value::Null)
        )),
        "monitorProjectTargetId" => json!(monitor_project_target_id(
            str_field(input, "projectPath")
                .as_deref()
                .unwrap_or_default(),
            str_field(input, "sessionId").as_deref().unwrap_or_default()
        )),
        "monitorSharedTargetId" => json!(monitor_shared_target_id(
            str_field(input, "ownerUserId")
                .as_deref()
                .unwrap_or_default(),
            str_field(input, "shareId").as_deref().unwrap_or_default()
        )),
        _ => panic!("unknown monitor targets contract api: {api}"),
    }
}

fn monitor_session_targets_for_project(project: &Value, state: &Value) -> Value {
    let Some(endpoint) = get_project_service_endpoint(project) else {
        return json!([]);
    };
    let Some(sessions) = state.get("sessions").and_then(Value::as_array) else {
        return json!([]);
    };
    let project_path = str_field(project, "path").unwrap_or_default();
    let project_name = str_field(project, "name").unwrap_or_default();
    let targets: Vec<Value> = sessions
        .iter()
        .filter(|session| {
            matches!(
                str_field(session, "status").as_deref(),
                Some("running" | "idle" | "waiting")
            )
        })
        .filter(|session| !bool_field(session, "overseer") && !bool_field(session, "scribe"))
        .map(|session| {
            let session_id = str_field(session, "id").unwrap_or_default();
            json!({
                "kind": "project-agent",
                "id": monitor_project_target_id(&project_path, &session_id),
                "projectPath": project_path,
                "projectName": project_name,
                "sessionId": session_id,
                "sessionLabel": agent_compact_identity(session),
                "status": str_field(session, "status").unwrap_or_default(),
                "endpoint": endpoint,
            })
        })
        .collect();
    Value::Array(targets)
}

fn monitor_shared_targets(shares: &Value) -> Value {
    Value::Array(
        shares
            .as_array()
            .into_iter()
            .flatten()
            .map(|share| {
                let owner = str_field(share, "ownerUserId").unwrap_or_default();
                let share_id = str_field(share, "shareId").unwrap_or_default();
                let project_root = str_field(share, "projectRoot").unwrap_or_default();
                let session_id = str_field(share, "sessionId").unwrap_or_default();
                json!({
                    "kind": "shared-chat",
                    "id": monitor_shared_target_id(&owner, &share_id),
                    "ownerUserId": owner,
                    "shareId": share_id,
                    "projectRoot": project_root,
                    "projectName": project_name_from_root(&project_root),
                    "sessionId": session_id,
                    "sessionLabel": session_id,
                    "endpoint": share.get("serviceEndpoint").cloned().unwrap_or(Value::Null),
                })
            })
            .collect(),
    )
}

fn target_matches_settings(target: &Value, settings: &Value) -> bool {
    let kind = str_field(target, "kind");
    if kind != str_field(settings, "targetKind")
        || str_field(target, "sessionId") != str_field(settings, "sessionId")
    {
        return false;
    }
    if kind.as_deref() == Some("project-agent") {
        return str_field(target, "projectPath") == str_field(settings, "projectPath");
    }
    str_field(target, "ownerUserId") == str_field(settings, "shareOwnerUserId")
        && str_field(target, "shareId") == str_field(settings, "shareId")
}

fn monitor_target_label(target: &Value) -> String {
    if target.is_null() {
        return "Choose a destination before starting.".to_owned();
    }
    if str_field(target, "kind").as_deref() == Some("shared-chat") {
        return format!(
            "{} shared chat",
            str_field(target, "projectName").unwrap_or_default()
        );
    }
    format!(
        "{} / {}",
        str_field(target, "projectName").unwrap_or_default(),
        str_field(target, "sessionLabel").unwrap_or_default()
    )
}

fn monitor_project_target_id(project_path: &str, session_id: &str) -> String {
    format!("project:{project_path}:{session_id}")
}

fn monitor_shared_target_id(owner_user_id: &str, share_id: &str) -> String {
    format!("shared:{owner_user_id}:{share_id}")
}

fn get_project_service_endpoint(project: &Value) -> Option<Value> {
    project
        .get("serviceAlive")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        .then(|| project.get("serviceEndpoint").cloned())
        .flatten()
        .filter(|endpoint| !endpoint.is_null())
}

fn project_name_from_root(project_root: &str) -> String {
    project_root
        .split(['/', '\\'])
        .rfind(|part| !part.is_empty())
        .filter(|part| !part.is_empty())
        .unwrap_or(if project_root.is_empty() {
            "Shared chat"
        } else {
            project_root
        })
        .to_owned()
}

fn agent_compact_identity(agent: &Value) -> String {
    let name = agent_short_name(agent);
    let role = str_field(agent, "role").unwrap_or_default();
    if role.is_empty() {
        name
    } else {
        format!("{name} ({role})")
    }
}

fn agent_short_name(agent: &Value) -> String {
    if let Some(label) = truthy_field(agent, "label")
        && !is_generated_agent_label(&label, agent)
    {
        return label;
    }
    agent_tool_name(agent)
}

fn agent_tool_name(agent: &Value) -> String {
    truthy_field(agent, "toolConfigKey")
        .or_else(|| str_field(agent, "command").and_then(|command| first_token(&command)))
        .or_else(|| truthy_field(agent, "label").and_then(|label| generated_label_tool(&label)))
        .or_else(|| truthy_field(agent, "id").and_then(|id| generated_label_tool(&id)))
        .unwrap_or_else(|| "agent".to_owned())
}

fn is_generated_agent_label(label: &str, agent: &Value) -> bool {
    if label.trim().is_empty() {
        return false;
    }
    if truthy_field(agent, "id").is_some_and(|id| label == id) {
        return true;
    }
    if generated_label_tool(label).is_none() {
        return false;
    }
    let tool = agent_tool_name(agent).to_ascii_lowercase();
    label.to_ascii_lowercase().starts_with(&format!("{tool}-"))
}

fn first_token(command: &str) -> Option<String> {
    command
        .split_whitespace()
        .next()
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
}

fn generated_label_tool(value: &str) -> Option<String> {
    let (tool, suffix) = value.split_once('-')?;
    if !matches!(
        tool.to_ascii_lowercase().as_str(),
        "claude" | "codex" | "aider" | "shell"
    ) {
        return None;
    }
    if suffix.len() < 5
        || !suffix.chars().any(|ch| ch.is_ascii_digit())
        || !suffix.chars().all(|ch| ch.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(tool.to_ascii_lowercase())
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn str_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .map(ToOwned::to_owned)
}

fn truthy_field(value: &Value, field: &str) -> Option<String> {
    str_field(value, field).filter(|value| !value.is_empty())
}
