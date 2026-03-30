import type { MetadataTone } from "./metadata-store.js";

export type AgentActivityState = "idle" | "running" | "done" | "error" | "waiting" | "interrupted";

export type AgentAttentionState = "normal" | "needs_input" | "blocked" | "error";

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
  lastEvent?: AgentEvent;
  events?: AgentEvent[];
}
