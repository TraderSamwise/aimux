import { firstTokenOf } from "@/lib/status-tone";

export interface AgentDisplayInput {
  id?: string | null;
  label?: string | null;
  command?: string | null;
  toolConfigKey?: string | null;
  role?: string | null;
}

const GENERATED_AGENT_LABEL_RE = /^(claude|codex|aider|shell)-(?=[a-z0-9]*\d)[a-z0-9]{5,}$/i;

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function toolFromGeneratedLabel(value: string): string {
  const match = GENERATED_AGENT_LABEL_RE.exec(value);
  return match?.[1]?.toLowerCase() ?? "";
}

export function agentToolName(agent: AgentDisplayInput): string {
  const tool =
    normalize(agent.toolConfigKey) ||
    firstTokenOf(normalize(agent.command) || undefined) ||
    toolFromGeneratedLabel(normalize(agent.label)) ||
    toolFromGeneratedLabel(normalize(agent.id));
  return tool || "agent";
}

export function isGeneratedAgentLabel(label: string, agent: AgentDisplayInput): boolean {
  const normalizedLabel = normalize(label);
  if (!normalizedLabel) return false;
  const id = normalize(agent.id);
  if (id && normalizedLabel === id) return true;
  if (!GENERATED_AGENT_LABEL_RE.test(normalizedLabel)) return false;
  const tool = agentToolName(agent).toLowerCase();
  return Boolean(tool && normalizedLabel.toLowerCase().startsWith(`${tool}-`));
}

export function agentShortName(agent: AgentDisplayInput): string {
  const label = normalize(agent.label);
  if (label && !isGeneratedAgentLabel(label, agent)) return label;
  return agentToolName(agent);
}

export function agentRoleLabel(agent: AgentDisplayInput): string {
  return normalize(agent.role);
}

export function agentCompactIdentity(agent: AgentDisplayInput): string {
  const name = agentShortName(agent);
  const role = agentRoleLabel(agent);
  return role ? `${name} (${role})` : name;
}
