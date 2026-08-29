import { atom, type Getter, type Setter } from "jotai";
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
export const transcriptStartLineFamily = atomFamily((_sessionId: string) =>
  atom<number | undefined>(undefined),
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
 * The tool's own progress line. Sparse events keep the last value so the footer
 * does not flicker; explicit empty strings still clear finished turns.
 */
export const activityTextFamily = atomFamily((_sessionId: string) => atom<string>(""));
// Kept for future stream-token dedup; not wired up yet — see Task 3 deviation #6.
export const streamTokenFamily = atomFamily((_sessionId: string) => atom<number>(0));
export const lastErrorFamily = atomFamily((_sessionId: string) => atom<string | null>(null));

function mergeTranscriptMessages(
  existing: AgentTranscriptMessage[],
  incoming: AgentTranscriptMessage[],
): AgentTranscriptMessage[] {
  const overlap = longestTranscriptOverlap(existing, incoming);
  return [...stripLatestMarkers(existing.slice(0, existing.length - overlap)), ...incoming];
}

function stripLatestMarkers(messages: AgentTranscriptMessage[]): AgentTranscriptMessage[] {
  return messages.map((message) => {
    if (!message.latest) return message;
    const { latest: _latest, ...rest } = message;
    return rest;
  });
}

function longestTranscriptOverlap(
  existing: AgentTranscriptMessage[],
  incoming: AgentTranscriptMessage[],
): number {
  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (
        transcriptMessageSignature(existing[existing.length - length + index]) !==
        transcriptMessageSignature(incoming[index])
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function transcriptMessageSignature(message: AgentTranscriptMessage): string {
  return `${message.role}\0${message.text}\0${JSON.stringify(message.parts)}`;
}

function applyTranscriptMessages(
  get: Getter,
  set: Setter,
  sessionId: string,
  messages: AgentTranscriptMessage[],
  startLine: number | undefined,
) {
  const startLineAtom = transcriptStartLineFamily(sessionId);
  const currentStartLine = get(startLineAtom);
  if (startLine === undefined || currentStartLine === undefined || startLine <= currentStartLine) {
    set(transcriptFamily(sessionId), messages);
    set(startLineAtom, startLine);
    return;
  }
  set(
    transcriptFamily(sessionId),
    mergeTranscriptMessages(get(transcriptFamily(sessionId)), messages),
  );
}

export const applyOutputSnapshotAtom = atom(
  null,
  (
    get,
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
      startLine?: number;
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
      applyTranscriptMessages(get, set, snapshot.sessionId, snapshot.messages, snapshot.startLine);
    } else if (snapshot.output !== undefined) {
      set(transcriptFamily(snapshot.sessionId), []);
      set(transcriptStartLineFamily(snapshot.sessionId), snapshot.startLine);
    }
    set(activityFamily(snapshot.sessionId), snapshot.activity);
    if (snapshot.activityText !== undefined) {
      set(activityTextFamily(snapshot.sessionId), snapshot.activityText);
    }
    set(attentionFamily(snapshot.sessionId), snapshot.attention);
    set(lastErrorFamily(snapshot.sessionId), null);
  },
);

// Route a single SSE event into the right per-session family slots.
// Equivalent to the Zustand `ingestEvent` reducer.
export const ingestEventAtom = atom(null, (get, set, event: StreamEvent) => {
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
        applyTranscriptMessages(get, set, event.sessionId, event.messages, event.startLine);
      } else if (event.output !== undefined) {
        set(transcriptFamily(event.sessionId), []);
        set(transcriptStartLineFamily(event.sessionId), event.startLine);
      }
      // Only overwrite when the service actually reported one. A stream that
      // stops carrying activity must leave the last known state standing rather
      // than blanking it, or the indicator flickers off between events.
      if (event.activity !== undefined) set(activityFamily(event.sessionId), event.activity);
      if (event.attention !== undefined) set(attentionFamily(event.sessionId), event.attention);
      if (event.activityText !== undefined)
        set(activityTextFamily(event.sessionId), event.activityText);
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
