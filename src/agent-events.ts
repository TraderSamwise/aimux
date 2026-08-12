import type { AgentEventKind } from "./agent-events-contract.js";
export type {
  AgentActivityState,
  AgentAttentionState,
  AgentEvent,
  AgentEventKind,
  MetadataTone,
  SessionDerivedState,
} from "./agent-events-contract.js";

export function isAgentOutputEventKind(kind: AgentEventKind): boolean {
  return kind !== "prompt" && kind !== "task_assigned";
}
