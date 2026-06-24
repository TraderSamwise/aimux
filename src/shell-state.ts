import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState } from "./agent-events.js";
import { loadConfig } from "./config.js";
import { loadMetadataState, updateSessionMetadata } from "./metadata-store.js";
import { clearNotifications } from "./notifications.js";
import type { AlertKind } from "./project-events.js";

export interface ApplyShellStateInput {
  state: string;
  sessionId: string;
  tool?: string;
  command?: string;
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
  command?: string;
}

function normalizeShellCommand(command: string | undefined): string | undefined {
  const trimmed = command?.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

export function applyShellStateTransition(input: ApplyShellStateInput): ApplyShellStateResult {
  const state = input.state.trim();
  const sessionId = input.sessionId.trim();
  const tool = input.tool?.trim() || "shell";
  const command = normalizeShellCommand(input.command);
  const previousActivity = loadMetadataState(input.projectRoot).sessions[sessionId]?.derived?.activity;
  let nextActivity: AgentActivityState;
  let notified = false;

  if (state === "running" || state === "command" || state === "busy") {
    nextActivity = "running";
    if (command) {
      updateSessionMetadata(
        sessionId,
        (current) => ({
          ...current,
          derived: {
            ...(current.derived ?? {}),
            shellCommand: command,
            shellCommandState: "running",
          },
        }),
        input.projectRoot,
      );
    }
    if (previousActivity !== "running") {
      clearNotifications({ sessionId, projectRoot: input.projectRoot });
      input.tracker.setActivity(sessionId, "running", input.projectRoot);
      input.tracker.setAttention(sessionId, "normal", input.projectRoot);
      input.tracker.markSeen(sessionId, input.projectRoot);
    }
  } else if (state === "prompt" || state === "idle") {
    nextActivity = "idle";
    updateSessionMetadata(
      sessionId,
      (current) => ({
        ...current,
        derived: {
          ...(current.derived ?? {}),
          shellCommandState: "prompt",
        },
      }),
      input.projectRoot,
    );
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
    command,
  };
}
