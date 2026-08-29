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
export const outputAvailableFamily = atomFamily((_sessionId: string) => atom<boolean>(false));
/**
 * The same pane with tmux's colours still on it, for the terminal view.
 *
 * Held beside `outputBuffer` rather than replacing it: the plain form is what
 * every other reader (and the parser behind them) takes, and a service too old
 * to send this one leaves it empty rather than blanking the view.
 */
export const outputAnsiFamily = atomFamily((_sessionId: string) => atom<string>(""));
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
      output?: string;
      /**
       * Required, though the value may be undefined: callers build this object
       * field by field, so an optional key is one a caller can simply forget —
       * which is how the coloured terminal shipped reading a field nothing ever
       * set. Spelling it out makes the omission a type error instead of a
       * silent fall back to the uncoloured text.
       */
      outputAnsi: string | undefined;
      outputAvailable?: boolean;
      messages?: AgentTranscriptMessage[];
      activity?: AgentActivityState;
      activityText?: string;
      attention?: AgentAttentionState;
    },
  ) => {
    if (snapshot.output !== undefined) {
      set(outputBufferFamily(snapshot.sessionId), snapshot.output);
      set(outputAnsiFamily(snapshot.sessionId), snapshot.outputAnsi ?? snapshot.output);
      set(
        outputAvailableFamily(snapshot.sessionId),
        Boolean(snapshot.output.length || snapshot.outputAvailable),
      );
    } else if (snapshot.outputAnsi !== undefined) {
      set(outputAnsiFamily(snapshot.sessionId), snapshot.outputAnsi);
      set(
        outputAvailableFamily(snapshot.sessionId),
        Boolean(snapshot.outputAnsi.length || snapshot.outputAvailable),
      );
    } else if (snapshot.outputAvailable !== undefined) {
      set(outputAvailableFamily(snapshot.sessionId), snapshot.outputAvailable);
    }
    if (snapshot.messages !== undefined) {
      set(transcriptFamily(snapshot.sessionId), snapshot.messages);
    } else if (snapshot.output !== undefined) {
      set(transcriptFamily(snapshot.sessionId), []);
    }
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
      if (event.output !== undefined) {
        set(outputBufferFamily(event.sessionId), event.output);
        set(outputAnsiFamily(event.sessionId), event.outputAnsi ?? event.output);
        set(
          outputAvailableFamily(event.sessionId),
          Boolean(event.output.length || event.outputAvailable),
        );
      } else if (event.outputAnsi !== undefined) {
        set(outputAnsiFamily(event.sessionId), event.outputAnsi);
        set(
          outputAvailableFamily(event.sessionId),
          Boolean(event.outputAnsi.length || event.outputAvailable),
        );
      } else if (event.outputAvailable !== undefined) {
        set(outputAvailableFamily(event.sessionId), event.outputAvailable);
      }
      if (event.messages !== undefined) {
        set(transcriptFamily(event.sessionId), event.messages);
      } else if (event.output !== undefined) {
        set(transcriptFamily(event.sessionId), []);
      }
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
