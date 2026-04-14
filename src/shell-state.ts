import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState } from "./agent-events.js";
import { loadConfig } from "./config.js";
import { loadMetadataState } from "./metadata-store.js";
import { clearNotifications } from "./notifications.js";
import type { AlertKind } from "./project-events.js";

export interface ApplyShellStateInput {
  state: string;
  sessionId: string;
  tool?: string;
  tracker: AgentTracker;
  projectRoot?: string;
  emitAlert: (input: {
    kind: AlertKind;
    sessionId?: string;
    title: string;
    message: string;
    dedupeKey?: string;
    forceNotify?: boolean;
  }) => void;
}

export interface ApplyShellStateResult {
  ok: true;
  state: string;
  sessionId: string;
  tool: string;
  previousActivity?: AgentActivityState;
  nextActivity: AgentActivityState;
  notified: boolean;
}

export function applyShellStateTransition(input: ApplyShellStateInput): ApplyShellStateResult {
  const state = input.state.trim();
  const sessionId = input.sessionId.trim();
  const tool = input.tool?.trim() || "shell";
  const previousActivity = loadMetadataState(input.projectRoot).sessions[sessionId]?.derived?.activity;
  let nextActivity: AgentActivityState;
  let notified = false;

  if (state === "running" || state === "command" || state === "busy") {
    nextActivity = "running";
    if (previousActivity !== "running") {
      clearNotifications({ sessionId });
      input.tracker.setActivity(sessionId, "running", input.projectRoot);
      input.tracker.setAttention(sessionId, "normal", input.projectRoot);
      input.tracker.markSeen(sessionId, input.projectRoot);
    }
  } else if (state === "prompt" || state === "idle") {
    nextActivity = "idle";
    if (previousActivity !== "idle") {
      input.tracker.setActivity(sessionId, "idle", input.projectRoot);
      input.tracker.setAttention(sessionId, "normal", input.projectRoot);
    }
    const config = loadConfig().notifications;
    if (config.enabled && config.onComplete && previousActivity === "running") {
      input.emitAlert({
        kind: "task_done",
        sessionId,
        title: tool,
        message: "Shell returned to a prompt.",
        dedupeKey: `shell-complete:${sessionId}`,
      });
      notified = true;
    }
  } else {
    throw new Error(`Unsupported shell hook state: ${state}`);
  }

  return {
    ok: true,
    state,
    sessionId,
    tool,
    previousActivity,
    nextActivity,
    notified,
  };
}
