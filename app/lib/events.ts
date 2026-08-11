// SSE event taxonomy for the aimux project metadata server (`/events` endpoint).

import type { ProjectUpdateEvent } from "../../src/project-api-contract";
// `import type` on purpose: the module it lives in imports node:crypto, and a
// value import would drag that into the Metro bundle.
import type { AgentTranscriptMessage } from "../../src/agent-transcript";
import type { AgentActivityState, AgentAttentionState } from "../../src/agent-events";

export type { ProjectUpdateEvent, AgentTranscriptMessage, AgentActivityState, AgentAttentionState };

export type AlertKind =
  | "notification"
  | "needs_input"
  | "next_step"
  | "task_done"
  | "task_failed"
  | "blocked"
  | "message_waiting"
  | "handoff_waiting"
  | "task_assigned"
  | "review_waiting"
  | "interaction_request";

export interface AlertInteraction {
  id: string;
  type: "permission" | "exit_plan" | "question" | "input";
  summary?: string;
  telemetry?: boolean;
  toolName?: string;
  toolInputJSON?: string;
}

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
  notificationId?: string;
  projectName?: string;
  projectRoot?: string;
  threadId?: string;
  taskId?: string;
  worktreePath?: string;
  worktreeName?: string;
  branch?: string;
  categoryLabel?: string;
  reasonLabel?: string;
  dedupeKey?: string;
  forceNotify?: boolean;
  interaction?: AlertInteraction;
}

export interface ParsedAgentOutput {
  blocks?: Array<{ type?: string; kind?: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface AgentOutputEvent {
  type: "agent_output";
  sessionId: string;
  output: string;
  /** The pane with tmux's colours still attached; absent from older services. */
  outputAnsi?: string;
  startLine: number;
  parsed?: ParsedAgentOutput;
  messages?: AgentTranscriptMessage[];
  /**
   * What the session is doing, per the tool's own hooks.
   *
   * Worth carrying rather than inferring: this moves without the pane moving,
   * which is the whole point — arriving output cannot distinguish an agent that
   * finished from one that is merely quiet. Absent for services without the
   * `agentActivityState` capability, so absence is not idleness.
   */
  activity?: AgentActivityState;
  /** The tool's own progress line, e.g. `Jitterbugging… (2m 23s · ↓ 8.1k tokens)`. */
  activityText?: string;
  attention?: AgentAttentionState;
}

export interface StreamErrorEvent {
  type: "error";
  sessionId: string;
  error: string;
}

export type StreamEvent =
  | ReadyEvent
  | AlertEvent
  | AgentOutputEvent
  | ProjectUpdateEvent
  | StreamErrorEvent;

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

export type HistoryTextMark = "bold" | "dim" | "italic" | "underline" | "strike";

export interface HistoryTextColor {
  model: "rgb";
  value: string;
}

export interface HistoryTextSpan {
  text: string;
  marks?: HistoryTextMark[];
  foreground?: HistoryTextColor;
  background?: HistoryTextColor;
}

export type HistoryPart =
  | { type: "text"; text: string; spans?: HistoryTextSpan[] }
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
