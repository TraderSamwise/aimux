// SSE event taxonomy for the aimux project metadata server (`/events` endpoint).
// Canonical server-side types live in src/project-events.ts (AlertEvent,
// AlertKind). Redeclared here so the Expo bundle stays hermetic.

export type AlertKind =
  | "notification"
  | "needs_input"
  | "task_done"
  | "task_failed"
  | "blocked"
  | "message_waiting"
  | "handoff_waiting"
  | "task_assigned"
  | "review_waiting";

export interface ReadyEvent {
  type: "ready";
  projectId: string;
  ts: string;
  sessionId: string | null;
  startLine: number;
  intervalMs: number;
}

export interface AlertEvent {
  type: "alert";
  kind: AlertKind;
  projectId: string;
  sessionId?: string;
  title: string;
  message: string;
  ts: string;
  threadId?: string;
  taskId?: string;
  worktreePath?: string;
  dedupeKey?: string;
  forceNotify?: boolean;
}

export interface ParsedAgentOutput {
  blocks?: Array<{ type?: string; kind?: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface AgentOutputEvent {
  type: "agent_output";
  sessionId: string;
  output: string;
  startLine: number;
  parsed?: ParsedAgentOutput;
}

export interface StreamErrorEvent {
  type: "error";
  sessionId: string;
  error: string;
}

export type StreamEvent = ReadyEvent | AlertEvent | AgentOutputEvent | StreamErrorEvent;

// Display-side representation of an image part as it appears in history.
export interface HistoryImagePart {
  type: "image";
  attachmentId: string;
  filename?: string;
  mimeType?: string;
  contentUrl?: string;
}

export interface HistoryImageReferencePart {
  type: "image_reference";
  label: string;
  attachmentId?: string;
  filename?: string;
  mimeType?: string;
  contentUrl?: string;
}

export type HistoryPart =
  | { type: "text"; text: string }
  | HistoryImagePart
  | HistoryImageReferencePart;

export interface ChatActor {
  userId: string;
  displayName: string;
  email?: string;
  role?: "owner" | "guest";
}

export interface ChatMessage {
  id?: string;
  clientMessageId?: string;
  role?: "user" | "assistant" | "system" | "tool";
  ts?: string;
  parts?: HistoryPart[];
  text?: string;
  actor?: ChatActor;
  shareId?: string;
  chatMode?: "single" | "multi";
  [k: string]: unknown;
}
