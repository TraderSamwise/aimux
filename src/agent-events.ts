import type { MetadataTone } from "./metadata-store.js";

export type AgentActivityState = "idle" | "running" | "done" | "error" | "waiting" | "interrupted";

export type AgentAttentionState = "normal" | "needs_input" | "blocked" | "error" | "needs_response";

export type AgentEventKind =
  | "prompt"
  | "response"
  | "status"
  | "task_assigned"
  | "task_done"
  | "task_failed"
  | "needs_input"
  | "blocked"
  | "interrupted"
  | "notify";

export function isAgentOutputEventKind(kind: AgentEventKind): boolean {
  return kind !== "prompt" && kind !== "task_assigned";
}

export interface AgentEvent {
  kind: AgentEventKind;
  ts?: string;
  message?: string;
  source?: string;
  tone?: MetadataTone;
  threadId?: string;
  threadName?: string;
}

export interface SessionDerivedState {
  activity?: AgentActivityState;
  attention?: AgentAttentionState;
  unseenCount?: number;
  lastOutputAt?: string;
  becameIdleAt?: string;
  lastEvent?: AgentEvent;
  events?: AgentEvent[];
}
