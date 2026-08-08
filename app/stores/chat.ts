import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type {
  AgentActivityState,
  AgentAttentionState,
  AgentTranscriptMessage,
  StreamEvent,
} from "@/lib/events";

// ─── Per-session base families ─────────────────────────────────────────────

export const outputBufferFamily = atomFamily((_sessionId: string) => atom<string>(""));
/**
 * The conversation, as the service projected it.
 *
 * Not derived from `parsed` any more: the mapping from blocks to messages
 * lives beside the parser that produces the blocks, so both this app and any
 * other client read the same one instead of each keeping a copy that drifts.
 */
export const transcriptFamily = atomFamily((_sessionId: string) =>
  atom<AgentTranscriptMessage[]>([]),
);
export const streamingFamily = atomFamily((_sessionId: string) => atom<boolean>(false));
/**
 * What the runtime says the session is doing, as opposed to what arriving bytes
 * imply. `undefined` means the service does not report it — not that the agent
 * is idle — so readers must keep their own fallback for that case.
 */
export const activityFamily = atomFamily((_sessionId: string) =>
  atom<AgentActivityState | undefined>(undefined),
);
export const attentionFamily = atomFamily((_sessionId: string) =>
  atom<AgentAttentionState | undefined>(undefined),
);
/**
 * The tool's own progress line. Unlike `activity`, this is replaced on every
 * event rather than held when absent: it describes a turn in flight, so keeping
 * the last one would leave a frozen timer beside a finished agent.
 */
export const activityTextFamily = atomFamily((_sessionId: string) => atom<string>(""));
// Kept for future stream-token dedup; not wired up yet — see Task 3 deviation #6.
export const streamTokenFamily = atomFamily((_sessionId: string) => atom<number>(0));
export const lastErrorFamily = atomFamily((_sessionId: string) => atom<string | null>(null));

export const applyOutputSnapshotAtom = atom(
  null,
  (
    _get,
    set,
    snapshot: {
      sessionId: string;
      output: string;
      messages?: AgentTranscriptMessage[];
      activity?: AgentActivityState;
      activityText?: string;
      attention?: AgentAttentionState;
    },
  ) => {
    set(outputBufferFamily(snapshot.sessionId), snapshot.output);
    set(transcriptFamily(snapshot.sessionId), snapshot.messages ?? []);
    set(activityFamily(snapshot.sessionId), snapshot.activity);
    set(activityTextFamily(snapshot.sessionId), snapshot.activityText ?? "");
    set(attentionFamily(snapshot.sessionId), snapshot.attention);
    set(lastErrorFamily(snapshot.sessionId), null);
  },
);

// Route a single SSE event into the right per-session family slots.
// Equivalent to the Zustand `ingestEvent` reducer.
export const ingestEventAtom = atom(null, (_get, set, event: StreamEvent) => {
  switch (event.type) {
    case "ready":
      if (event.sessionId) {
        set(streamingFamily(event.sessionId), false);
        set(lastErrorFamily(event.sessionId), null);
      }
      return;
    case "agent_output":
      set(outputBufferFamily(event.sessionId), event.output);
      set(transcriptFamily(event.sessionId), event.messages ?? []);
      // Only overwrite when the service actually reported one. A stream that
      // stops carrying activity must leave the last known state standing rather
      // than blanking it, or the indicator flickers off between events.
      if (event.activity !== undefined) set(activityFamily(event.sessionId), event.activity);
      if (event.attention !== undefined) set(attentionFamily(event.sessionId), event.attention);
      set(activityTextFamily(event.sessionId), event.activityText ?? "");
      set(streamingFamily(event.sessionId), true);
      return;
    case "alert":
      if (!event.sessionId) return;
      if (event.kind === "task_done" || event.kind === "task_failed") {
        set(streamingFamily(event.sessionId), false);
      }
      return;
    case "error":
      set(lastErrorFamily(event.sessionId), event.error);
      set(streamingFamily(event.sessionId), false);
      return;
  }
});
