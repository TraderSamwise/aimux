use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentDisplayInput<'a> {
    pub id: Option<&'a str>,
    pub label: Option<&'a str>,
    pub command: Option<&'a str>,
    pub tool_config_key: Option<&'a str>,
    pub role: Option<&'a str>,
}

impl<'a> AgentDisplayInput<'a> {
    pub fn from_value(value: &'a Value) -> Self {
        Self {
            id: string_field(value, "id").or_else(|| string_field(value, "sessionId")),
            label: string_field(value, "label"),
            command: string_field(value, "command").or_else(|| string_field(value, "tool")),
            tool_config_key: string_field(value, "toolConfigKey"),
            role: string_field(value, "role"),
        }
    }
}

pub fn agent_tool_name(agent: &AgentDisplayInput<'_>) -> String {
    normalize(agent.tool_config_key)
        .or_else(|| first_token_of(normalize(agent.command)))
        .or_else(|| tool_from_generated_label(normalize(agent.label)))
        .or_else(|| tool_from_generated_label(normalize(agent.id)))
        .unwrap_or_else(|| "agent".to_owned())
}

pub fn is_generated_agent_label(label: &str, agent: &AgentDisplayInput<'_>) -> bool {
    let label = label.trim().to_ascii_lowercase();
    let tool = agent_tool_name(agent).trim().to_ascii_lowercase();
    if label.is_empty() || tool.is_empty() {
        return false;
    }
    label == tool || label.starts_with(&format!("{tool}-"))
}

pub fn agent_short_name(agent: &AgentDisplayInput<'_>) -> String {
    if let Some(label) = normalize(agent.label)
        && !is_generated_agent_label(&label, agent)
    {
        return label;
    }
    agent_tool_name(agent)
}

pub fn agent_role_label(agent: &AgentDisplayInput<'_>) -> String {
    normalize(agent.role).unwrap_or_default()
}

pub fn agent_compact_identity(agent: &AgentDisplayInput<'_>) -> String {
    let name = agent_short_name(agent);
    let role = agent_role_label(agent);
    if role.is_empty() {
        name
    } else {
        format!("{name}({role})")
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

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_label_matches_node_rule_without_id_equality() {
        let agent = AgentDisplayInput {
            id: Some("reviewer"),
            label: Some("reviewer"),
            command: Some("codex"),
            ..AgentDisplayInput::default()
        };
        assert!(!is_generated_agent_label("reviewer", &agent));
        assert_eq!(agent_short_name(&agent), "reviewer");

        let generated = AgentDisplayInput {
            id: Some("codex-abc"),
            label: Some("Codex"),
            command: Some("codex"),
            role: Some("coder"),
            ..AgentDisplayInput::default()
        };
        assert!(is_generated_agent_label("Codex", &generated));
        assert_eq!(agent_compact_identity(&generated), "codex(coder)");
    }
}
