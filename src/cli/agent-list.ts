import { basename } from "node:path";

import type { AgentListItem } from "../project-api-contract.js";

export type CliAgentListItem = AgentListItem & {
  loop?: { active?: boolean; goal?: string };
  task?: { description?: string; status?: string };
};

function agentCanonicalId(agent: CliAgentListItem): string {
  return agent.toolConfigKey ?? agent.tool ?? agent.command ?? "?";
}

function agentWorktreeLabel(path: string | undefined, projectRoot: string | undefined): string {
  if (!path) return "Main Checkout";
  if (projectRoot && path === projectRoot) return "Main Checkout";
  return basename(path);
}

function agentWorktreeSortKey(path: string | undefined, projectRoot: string | undefined): string {
  if (!path || (projectRoot && path === projectRoot)) return "";
  return path;
}

function renderAgentSummary(agent: CliAgentListItem): string {
  const tags = [
    agent.role ? `role=${agent.role}` : null,
    agent.overseer ? "overseer" : null,
    agent.loop?.active ? `loop${agent.loop.goal ? `=${agent.loop.goal}` : ""}` : null,
  ].filter(Boolean);
  const state = [agent.activity, agent.attention].filter(Boolean).join("/");
  const detail = [
    `canonical=${agentCanonicalId(agent)}`,
    `aimux=${agent.id}`,
    agent.backendSessionId ? `backend=${agent.backendSessionId}` : null,
    state ? `state=${state}` : null,
    tags.length ? tags.join(" ") : null,
  ].filter(Boolean);
  return `  ${agent.status ?? "?"}  ${detail.join("  ")}`;
}

export function renderAgentsFlatLines(agents: CliAgentListItem[], projectRoot?: string): string[] {
  if (agents.length === 0) return ["no agents"];
  const lines: string[] = [];
  for (const agent of agents) {
    lines.push(`${agent.id}  [${agentCanonicalId(agent)}]${agent.role ? `  ${agent.role}` : ""}`);
    lines.push(renderAgentSummary(agent));
    if (agent.worktreePath) lines.push(`    worktree: ${agent.worktreePath}`);
    else if (projectRoot) lines.push(`    worktree: ${projectRoot}`);
    if (agent.task) lines.push(`    task: ${agent.task.description ?? ""} (${agent.task.status ?? "?"})`);
  }
  return lines;
}

export function renderAgentsByWorktreeLines(agents: CliAgentListItem[], projectRoot?: string): string[] {
  if (agents.length === 0) return ["no agents"];
  const groups = new Map<string, CliAgentListItem[]>();
  for (const agent of agents) {
    const key = agentWorktreeSortKey(agent.worktreePath, projectRoot);
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  const lines: string[] = [];
  const sortedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [index, [path, group]] of sortedGroups.entries()) {
    if (index > 0) lines.push("");
    const label = agentWorktreeLabel(path || undefined, projectRoot);
    lines.push(`${label}${path ? `  ${path}` : projectRoot ? `  ${projectRoot}` : ""}`);
    for (const agent of group.sort((left, right) => left.id.localeCompare(right.id))) {
      lines.push(renderAgentSummary(agent));
      if (agent.task) lines.push(`    task: ${agent.task.description ?? ""} (${agent.task.status ?? "?"})`);
    }
  }
  return lines;
}
