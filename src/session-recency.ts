import type { SessionUserLabel } from "./session-semantics.js";

/**
 * The single source of truth for an agent's "time anchor": which timestamp to show
 * as relative recency and what verb describes it ("output", "prompted", "idle", …).
 * Both the dashboard and Exposé derive their recency from this so they never disagree.
 *
 * Pending/lifecycle states (starting/stopping/…) are handled by the caller, since the
 * value selection there is runtime-specific.
 */
export interface SessionRecencyInput {
  label?: SessionUserLabel;
  latestUnreadAt?: string;
  lastOutputAt?: string;
  becameIdleAt?: string;
  lastUsedAt?: string;
}

export interface SessionRecencyAnchor {
  label: string;
  value?: string;
}

export function sessionRecencyAnchor(input: SessionRecencyInput): SessionRecencyAnchor | null {
  const { label, latestUnreadAt, lastOutputAt, becameIdleAt, lastUsedAt } = input;
  const output = lastOutputAt ? { label: "output", value: lastOutputAt } : null;
  switch (label) {
    case "needs_input":
    case "needs_response":
      return { label: "prompted", value: latestUnreadAt ?? lastOutputAt ?? becameIdleAt ?? lastUsedAt };
    case "next_step":
    case "idle":
    case "interrupted":
      return output ?? { label: "idle", value: becameIdleAt ?? lastUsedAt };
    case "working":
    case "ready":
      return output;
    case "done":
      return output ?? { label: "done", value: becameIdleAt ?? lastUsedAt };
    case "offline":
      return output ?? { label: "offline", value: lastUsedAt };
    case "blocked":
      return { label: "blocked", value: latestUnreadAt ?? becameIdleAt ?? lastOutputAt ?? lastUsedAt };
    case "error":
      return { label: "failed", value: latestUnreadAt ?? becameIdleAt ?? lastOutputAt ?? lastUsedAt };
    default:
      return output;
  }
}
