use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentDisplayInput {
    id: Option<String>,
    label: Option<String>,
    command: Option<String>,
    tool_config_key: Option<String>,
    role: Option<String>,
}

pub fn run_agent_display_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    let agent = input
        .get("agent")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .expect("agent display contract input")
        .unwrap_or_default();
    match api {
        "agentToolName" => json!(agent_tool_name(&agent)),
        "isGeneratedAgentLabel" => json!(is_generated_agent_label(
            input
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            &agent
        )),
        "agentShortName" => json!(agent_short_name(&agent)),
        "agentRoleLabel" => json!(agent_role_label(&agent)),
        "agentCompactIdentity" => json!(agent_compact_identity(&agent)),
        _ => panic!("unknown agent display contract api: {api}"),
    }
}

fn agent_tool_name(agent: &AgentDisplayInput) -> String {
    let tool = normalize(agent.tool_config_key.as_deref())
        .or_else(|| first_token_of(normalize(agent.command.as_deref())))
        .or_else(|| tool_from_generated_label(normalize(agent.label.as_deref())))
        .or_else(|| tool_from_generated_label(normalize(agent.id.as_deref())));
    tool.unwrap_or_else(|| "agent".to_owned())
}

fn is_generated_agent_label(label: &str, agent: &AgentDisplayInput) -> bool {
    let normalized_label = label.trim();
    if normalized_label.is_empty() {
        return false;
    }
    if agent
        .id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty() && normalized_label == id.trim())
    {
        return true;
    }
    if generated_agent_label_tool(normalized_label).is_none() {
        return false;
    }
    let tool = agent_tool_name(agent).to_ascii_lowercase();
    !tool.is_empty()
        && normalized_label
            .to_ascii_lowercase()
            .starts_with(&format!("{tool}-"))
}

fn agent_short_name(agent: &AgentDisplayInput) -> String {
    if let Some(label) = normalize(agent.label.as_deref())
        && !is_generated_agent_label(&label, agent)
    {
        return label;
    }
    agent_tool_name(agent)
}

fn agent_role_label(agent: &AgentDisplayInput) -> String {
    normalize(agent.role.as_deref()).unwrap_or_default()
}

fn agent_compact_identity(agent: &AgentDisplayInput) -> String {
    let name = agent_short_name(agent);
    let role = agent_role_label(agent);
    if role.is_empty() {
        name
    } else {
        format!("{name} ({role})")
    }
}

fn normalize(value: Option<&str>) -> Option<String> {
    let normalized = value.unwrap_or_default().trim();
    (!normalized.is_empty()).then(|| normalized.to_owned())
}

fn first_token_of(command: Option<String>) -> Option<String> {
    command
        .and_then(|command| command.split_whitespace().next().map(ToOwned::to_owned))
        .filter(|token| !token.is_empty())
}

fn tool_from_generated_label(value: Option<String>) -> Option<String> {
    generated_agent_label_tool(value.as_deref().unwrap_or_default())
}

fn generated_agent_label_tool(value: &str) -> Option<String> {
    let (tool, suffix) = value.split_once('-')?;
    if !matches!(
        tool.to_ascii_lowercase().as_str(),
        "claude" | "codex" | "aider" | "shell"
    ) {
        return None;
    }
    if suffix.len() < 5 || !suffix.chars().any(|ch| ch.is_ascii_digit()) {
        return None;
    }
    if !suffix.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        return None;
    }
    Some(tool.to_ascii_lowercase())
}
