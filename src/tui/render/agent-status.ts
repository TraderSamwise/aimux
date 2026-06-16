import type { AgentActivityState } from "../../agent-events.js";
import type { SessionUserLabel } from "../../session-semantics.js";
import { pill, statusDot, statusTone, style, type StatusKind } from "./theme.js";

export interface AgentStatusInput {
  activity?: string;
  attention?: string;
  /** Dashboard-semantic user label; when present it wins over activity/attention. */
  userLabel?: SessionUserLabel;
}

export interface AgentStatusChip {
  kind: StatusKind;
  label: string;
}

// The dashboard's semantic user label → presentation chip. Keeping Exposé on the
// same labels as the dashboard means the two never show different states for an agent.
const USER_LABEL: Record<SessionUserLabel, AgentStatusChip> = {
  working: { kind: "working", label: "Working" },
  ready: { kind: "ready", label: "Ready" },
  needs_input: { kind: "needs", label: "Needs input" },
  needs_response: { kind: "needs", label: "Needs reply" },
  next_step: { kind: "needs", label: "Next step" },
  blocked: { kind: "blocked", label: "Blocked" },
  error: { kind: "error", label: "Error" },
  idle: { kind: "idle", label: "Idle" },
  offline: { kind: "offline", label: "Offline" },
  done: { kind: "done", label: "Done" },
  interrupted: { kind: "idle", label: "Interrupted" },
  starting: { kind: "working", label: "Starting" },
  stopping: { kind: "idle", label: "Stopping" },
  graveyarding: { kind: "offline", label: "Removing" },
};

// Attention signals win over plain activity (they need the user). "idle"/"done"/
// "none" attention values are not real signals — they fall through to activity.
const ATTENTION: Record<string, AgentStatusChip> = {
  error: { kind: "error", label: "Error" },
  blocked: { kind: "blocked", label: "Blocked" },
  needs_input: { kind: "needs", label: "Needs input" },
  needs_response: { kind: "needs", label: "Needs reply" },
};

// Typed against AgentActivityState so a new activity state is a compile error here.
const ACTIVITY: Record<AgentActivityState, AgentStatusChip> = {
  running: { kind: "working", label: "Working" },
  waiting: { kind: "needs", label: "Waiting" },
  done: { kind: "done", label: "Done" },
  idle: { kind: "idle", label: "Idle" },
  error: { kind: "error", label: "Error" },
  interrupted: { kind: "idle", label: "Interrupted" },
};

/** Map an agent's semantics to a presentation status chip. The dashboard-semantic
 *  user label wins when present; activity/attention are the legacy fallback. */
export function agentStatusChip(input: AgentStatusInput): AgentStatusChip | null {
  if (input.userLabel) {
    const chip = USER_LABEL[input.userLabel];
    if (chip) return chip;
  }
  if (input.attention) {
    const chip = ATTENTION[input.attention];
    if (chip) return chip;
  }
  if (input.activity) {
    const chip = ACTIVITY[input.activity as AgentActivityState];
    if (chip) return chip;
  }
  return null;
}

/** Colored status dot + label, matching the dashboard's status cell. "" if unknown. */
export function renderAgentStatusChip(input: AgentStatusInput): string {
  const chip = agentStatusChip(input);
  if (!chip) return "";
  return `${statusDot(chip.kind)} ${style(chip.label, statusTone(chip.kind))}`;
}

/** The presentation status kind for an agent, or null when unknown. */
export function agentStatusKind(input: AgentStatusInput): StatusKind | null {
  return agentStatusChip(input)?.kind ?? null;
}

/** Status as an uppercase state-tinted pill (e.g. ` NEEDS INPUT `). "" if unknown. */
export function renderAgentStatusPill(input: AgentStatusInput): string {
  const chip = agentStatusChip(input);
  if (!chip) return "";
  return pill(chip.label.toUpperCase(), statusTone(chip.kind));
}
