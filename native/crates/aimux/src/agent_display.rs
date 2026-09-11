use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentDisplayInput<'a> {
    pub kind: Option<&'a str>,
    pub id: Option<&'a str>,
    pub label: Option<&'a str>,
    pub command: Option<&'a str>,
    pub tool_config_key: Option<&'a str>,
    pub launch_command_line: Option<&'a str>,
    pub role: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentDisplayPolicy {
    /// Matches app/lib/agent-display.ts: generated labels require id equality or the generated-id regex.
    AppAgentDisplay,
    /// Matches src/statusline-model.ts: generated labels use only tool/label and roles render without a space.
    StatuslineModel,
}

impl<'a> AgentDisplayInput<'a> {
    pub fn from_value(value: &'a Value) -> Self {
        Self {
            kind: string_field(value, "kind"),
            id: string_field(value, "id").or_else(|| string_field(value, "sessionId")),
            label: string_field(value, "label"),
            command: string_field(value, "command").or_else(|| string_field(value, "tool")),
            tool_config_key: string_field(value, "toolConfigKey"),
            launch_command_line: string_field(value, "launchCommandLine"),
            role: string_field(value, "role"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentDisplaySession {
    pub policy: AgentDisplayPolicy,
    pub kind: Option<String>,
    pub id: Option<String>,
    pub tool: String,
    pub user_label: Option<String>,
    pub generated_label: bool,
    pub display_role: Option<String>,
    pub launch_command_line: Option<String>,
}

impl AgentDisplaySession {
    pub fn resolve(agent: &AgentDisplayInput<'_>, policy: AgentDisplayPolicy) -> Self {
        let tool = resolved_tool_name(agent, policy);
        let user_label = normalize(agent.label);
        let generated_label = user_label
            .as_deref()
            .is_some_and(|label| is_generated_label_for_policy(label, agent.id, &tool, policy));
        Self {
            policy,
            kind: normalize(agent.kind),
            id: normalize(agent.id),
            tool,
            user_label,
            generated_label,
            display_role: normalize(agent.role),
            launch_command_line: normalize(agent.launch_command_line),
        }
    }

    pub fn short_name(&self) -> String {
        if let Some(label) = self.user_label.as_deref()
            && !self.generated_label
        {
            return label.to_owned();
        }
        self.tool.clone()
    }

    pub fn compact_title(&self) -> String {
        if self.kind.as_deref() == Some("service") {
            if let Some(command) = self.launch_command_line.as_deref() {
                return command.to_owned();
            }
            let fallback = if self.tool.is_empty() {
                "service"
            } else {
                self.tool.as_str()
            };
            let base = self.user_label.as_deref().unwrap_or(fallback);
            return format!("{base}[svc]");
        }

        let base = self.short_name();
        match self.display_role.as_deref() {
            Some(role) if !role.is_empty() => match self.policy {
                AgentDisplayPolicy::AppAgentDisplay => format!("{base} ({role})"),
                AgentDisplayPolicy::StatuslineModel => format!("{base}({role})"),
            },
            _ => base,
        }
    }
}

pub fn resolve_app_agent_display(agent: &AgentDisplayInput<'_>) -> AgentDisplaySession {
    AgentDisplaySession::resolve(agent, AgentDisplayPolicy::AppAgentDisplay)
}

pub fn resolve_statusline_model(agent: &AgentDisplayInput<'_>) -> AgentDisplaySession {
    AgentDisplaySession::resolve(agent, AgentDisplayPolicy::StatuslineModel)
}

pub fn is_generated_agent_label(label: &str, agent: &AgentDisplayInput<'_>) -> bool {
    let input = AgentDisplayInput {
        label: Some(label),
        ..*agent
    };
    resolve_app_agent_display(&input).generated_label
}

pub fn agent_short_name(agent: &AgentDisplayInput<'_>) -> String {
    resolve_app_agent_display(agent).short_name()
}

pub fn agent_compact_identity(agent: &AgentDisplayInput<'_>) -> String {
    resolve_app_agent_display(agent).compact_title()
}

fn resolved_tool_name(agent: &AgentDisplayInput<'_>, policy: AgentDisplayPolicy) -> String {
    match policy {
        AgentDisplayPolicy::AppAgentDisplay => normalize(agent.tool_config_key)
            .or_else(|| first_token_of(normalize(agent.command)))
            .or_else(|| tool_from_generated_label(normalize(agent.label)))
            .or_else(|| tool_from_generated_label(normalize(agent.id)))
            .unwrap_or_else(|| "agent".to_owned()),
        AgentDisplayPolicy::StatuslineModel => normalize(agent.tool_config_key)
            .or_else(|| normalize(agent.command))
            .or_else(|| normalize(agent.id))
            .unwrap_or_default(),
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

fn is_generated_label_for_policy(
    label: &str,
    id: Option<&str>,
    tool: &str,
    policy: AgentDisplayPolicy,
) -> bool {
    match policy {
        AgentDisplayPolicy::AppAgentDisplay => {
            let normalized_label = label.trim();
            if normalized_label.is_empty() {
                return false;
            }
            if id.is_some_and(|id| !id.trim().is_empty() && normalized_label == id.trim()) {
                return true;
            }
            if generated_agent_label_tool(normalized_label).is_none() {
                return false;
            }
            let tool = tool.to_ascii_lowercase();
            !tool.is_empty()
                && normalized_label
                    .to_ascii_lowercase()
                    .starts_with(&format!("{tool}-"))
        }
        AgentDisplayPolicy::StatuslineModel => {
            let label = label.trim().to_ascii_lowercase();
            let tool = tool.trim().to_ascii_lowercase();
            !label.is_empty()
                && !tool.is_empty()
                && (label == tool || label.starts_with(&format!("{tool}-")))
        }
    }
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
        let statusline = AgentDisplayInput {
            command: Some("codex"),
            ..agent
        };
        let resolved_statusline = resolve_statusline_model(&statusline);
        assert!(!resolved_statusline.generated_label);
        assert_eq!(resolved_statusline.short_name(), "reviewer");
        assert!(is_generated_agent_label("reviewer", &agent));
        assert_eq!(agent_short_name(&agent), "codex");

        let statusline_generated = AgentDisplayInput {
            id: Some("codex-abc"),
            label: Some("Codex"),
            command: Some("codex"),
            role: Some("coder"),
            ..AgentDisplayInput::default()
        };
        assert_eq!(
            resolve_statusline_model(&statusline_generated).compact_title(),
            "codex(coder)"
        );

        let app_generated = AgentDisplayInput {
            id: Some("codex-abc123"),
            label: Some("codex-abc123"),
            command: Some("codex"),
            role: Some("coder"),
            ..AgentDisplayInput::default()
        };
        assert!(is_generated_agent_label("codex-abc123", &app_generated));
        assert_eq!(agent_compact_identity(&app_generated), "codex (coder)");
    }

    #[test]
    fn resolved_display_session_is_the_compact_title_source() {
        let service = resolve_statusline_model(&AgentDisplayInput {
            kind: Some("service"),
            label: Some("shell"),
            command: Some("shell"),
            launch_command_line: Some(" yarn dev "),
            ..AgentDisplayInput::default()
        });
        assert_eq!(service.tool, "shell");
        assert_eq!(service.user_label.as_deref(), Some("shell"));
        assert!(service.generated_label);
        assert_eq!(service.compact_title(), "yarn dev");

        let agent = resolve_statusline_model(&AgentDisplayInput {
            id: Some("claude-abc123"),
            label: Some("claude-abc123"),
            command: Some("claude"),
            role: Some(" reviewer "),
            ..AgentDisplayInput::default()
        });
        assert_eq!(agent.tool, "claude");
        assert!(agent.generated_label);
        assert_eq!(agent.display_role.as_deref(), Some("reviewer"));
        assert_eq!(agent.compact_title(), "claude(reviewer)");
    }
}
