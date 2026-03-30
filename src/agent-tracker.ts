import type { AgentActivityState, AgentAttentionState, AgentEvent, SessionDerivedState } from "./agent-events.js";
import { updateSessionMetadata, type SessionMetadata } from "./metadata-store.js";

function nowIso(): string {
  return new Date().toISOString();
}

function incrementUnseen(current: SessionDerivedState | undefined): number {
  return (current?.unseenCount ?? 0) + 1;
}

function deriveFromEvent(
  current: SessionDerivedState | undefined,
  event: AgentEvent,
): Pick<SessionDerivedState, "activity" | "attention" | "unseenCount"> {
  const message = event.message?.toLowerCase() ?? "";
  const tone = event.tone;
  let activity: AgentActivityState | undefined = current?.activity;
  let attention: AgentAttentionState | undefined = current?.attention ?? "normal";
  let unseenCount = current?.unseenCount ?? 0;

  switch (event.kind) {
    case "prompt":
    case "task_assigned":
      activity = "running";
      if (attention === "normal") attention = "normal";
      break;
    case "response":
      activity = "idle";
      unseenCount = incrementUnseen(current);
      break;
    case "task_done":
      activity = "done";
      attention = "normal";
      unseenCount = incrementUnseen(current);
      break;
    case "task_failed":
      activity = "error";
      attention = "error";
      unseenCount = incrementUnseen(current);
      break;
    case "needs_input":
      activity = "waiting";
      attention = "needs_input";
      unseenCount = incrementUnseen(current);
      break;
    case "blocked":
      activity = "waiting";
      attention = "blocked";
      unseenCount = incrementUnseen(current);
      break;
    case "interrupted":
      activity = "interrupted";
      unseenCount = incrementUnseen(current);
      break;
    case "notify":
      unseenCount = incrementUnseen(current);
      if (tone === "error") attention = "error";
      break;
    case "status":
      if (tone === "error") {
        activity = "error";
        attention = "error";
        unseenCount = incrementUnseen(current);
        break;
      }
      if (/need(s)? (your )?input|waiting for you|press enter|confirm|approval/.test(message)) {
        activity = "waiting";
        attention = "needs_input";
        unseenCount = incrementUnseen(current);
        break;
      }
      if (/blocked|waiting on|stuck/.test(message)) {
        activity = "waiting";
        attention = "blocked";
        unseenCount = incrementUnseen(current);
        break;
      }
      if (tone === "success" || /done|complete|completed|finished|resolved/.test(message)) {
        activity = "done";
        attention = "normal";
        unseenCount = incrementUnseen(current);
        break;
      }
      if (/working|running|thinking|building|deploying|indexing|searching|editing/.test(message)) {
        activity = "running";
      }
      break;
  }

  return {
    activity,
    attention,
    unseenCount,
  };
}

export class AgentTracker {
  emit(sessionId: string, event: AgentEvent, projectRoot?: string): void {
    const normalized: AgentEvent = {
      ...event,
      ts: event.ts ?? nowIso(),
    };
    updateSessionMetadata(
      sessionId,
      (current) => {
        const derivedCurrent = current.derived;
        const nextState = deriveFromEvent(derivedCurrent, normalized);
        const events = [...(derivedCurrent?.events ?? []).slice(-19), normalized];
        return {
          ...current,
          derived: {
            ...derivedCurrent,
            ...nextState,
            threadId: normalized.threadId ?? derivedCurrent?.threadId,
            threadName: normalized.threadName ?? derivedCurrent?.threadName,
            lastEvent: normalized,
            events,
          },
        };
      },
      projectRoot,
    );
  }

  markSeen(sessionId: string, projectRoot?: string): void {
    updateSessionMetadata(
      sessionId,
      (current) => ({
        ...current,
        derived: {
          ...(current.derived ?? {}),
          unseenCount: 0,
        },
      }),
      projectRoot,
    );
  }

  setActivity(sessionId: string, activity: AgentActivityState, projectRoot?: string): void {
    updateSessionMetadata(
      sessionId,
      (current) => ({
        ...current,
        derived: {
          ...(current.derived ?? {}),
          activity,
        },
      }),
      projectRoot,
    );
  }

  setAttention(sessionId: string, attention: AgentAttentionState, projectRoot?: string): void {
    updateSessionMetadata(
      sessionId,
      (current) => ({
        ...current,
        derived: {
          ...(current.derived ?? {}),
          attention,
        },
      }),
      projectRoot,
    );
  }
}

export function getDerivedState(metadata: SessionMetadata | undefined): SessionDerivedState | undefined {
  return metadata?.derived;
}
