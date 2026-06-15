import { statusDot, statusTone, style, type StatusKind } from "./theme.js";

export interface AgentStatusInput {
  activity?: string;
  attention?: string;
}

export interface AgentStatusChip {
  kind: StatusKind;
  label: string;
}

// Attention signals win over plain activity (they need the user). "idle"/"done"/
// "none" attention values are not real signals — they fall through to activity.
const ATTENTION: Record<string, AgentStatusChip> = {
  error: { kind: "error", label: "Error" },
  blocked: { kind: "blocked", label: "Blocked" },
  needs_input: { kind: "needs", label: "Needs input" },
  needs_response: { kind: "needs", label: "Needs reply" },
};

const ACTIVITY: Record<string, AgentStatusChip> = {
  running: { kind: "working", label: "Working" },
  waiting: { kind: "needs", label: "Waiting" },
  done: { kind: "done", label: "Done" },
  idle: { kind: "idle", label: "Idle" },
};

/** Map an agent's activity/attention semantics to a presentation status chip. */
export function agentStatusChip(input: AgentStatusInput): AgentStatusChip | null {
  if (input.attention && ATTENTION[input.attention]) return ATTENTION[input.attention]!;
  if (input.activity && ACTIVITY[input.activity]) return ACTIVITY[input.activity]!;
  return null;
}

/** Colored status dot + label, matching the dashboard's status cell. "" if unknown. */
export function renderAgentStatusChip(input: AgentStatusInput): string {
  const chip = agentStatusChip(input);
  if (!chip) return "";
  return `${statusDot(chip.kind)} ${style(chip.label, statusTone(chip.kind))}`;
}
