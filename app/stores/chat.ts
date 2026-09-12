import { atom, type Getter, type Setter } from "jotai";
import { atomFamily } from "jotai/utils";
import type {
  AgentActivityState,
  AgentAttentionState,
  AgentOutputEvent,
  AgentTranscriptMessage,
  StreamEvent,
} from "@/lib/events";
import { formatTmuxUnavailable } from "@/lib/unavailable-state";
import type { TmuxUnavailableMarker } from "../../src/project-api-contract";

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
const localInterruptedUntilFamily = atomFamily((_sessionId: string) => atom<number>(0));
// Kept for future stream-token dedup; not wired up yet — see Task 3 deviation #6.
export const streamTokenFamily = atomFamily((_sessionId: string) => atom<number>(0));
export const lastErrorFamily = atomFamily((_sessionId: string) => atom<string | null>(null));

export const LOCAL_INTERRUPT_ACTIVITY_HOLD_MS = 5_000;

export type AgentOutputPayload = {
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
  tmuxUnavailable?: TmuxUnavailableMarker;
};

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

function applyAgentOutputPayload(
  get: Getter,
  set: Setter,
  payload: AgentOutputPayload,
  options: { sparseActivity: boolean },
) {
  const localInterruptActive =
    get(activityFamily(payload.sessionId)) === "interrupted" &&
    get(localInterruptedUntilFamily(payload.sessionId)) > Date.now();
  const incomingLooksLikeStaleProgress =
    payload.activity === "running" ||
    (payload.activity === undefined &&
      typeof payload.activityText === "string" &&
      payload.activityText.trim().length > 0);
  const preserveLocalInterrupt =
    localInterruptActive &&
    (incomingLooksLikeStaleProgress || (!options.sparseActivity && payload.activity === undefined));

  if (payload.output !== undefined) {
    set(outputBufferFamily(payload.sessionId), payload.output);
    set(outputAnsiFamily(payload.sessionId), payload.outputAnsi ?? payload.output);
    set(
      outputAvailableFamily(payload.sessionId),
      Boolean(payload.output.length || payload.outputAvailable),
    );
  } else if (payload.outputAnsi !== undefined) {
    set(outputAnsiFamily(payload.sessionId), payload.outputAnsi);
    set(
      outputAvailableFamily(payload.sessionId),
      Boolean(payload.outputAnsi.length || payload.outputAvailable),
    );
  } else if (payload.outputAvailable !== undefined) {
    set(outputAvailableFamily(payload.sessionId), payload.outputAvailable);
  }
  if (payload.messages !== undefined) {
    applyTranscriptMessages(get, set, payload.sessionId, payload.messages, payload.startLine);
  } else if (payload.output !== undefined) {
    set(transcriptFamily(payload.sessionId), []);
    set(transcriptStartLineFamily(payload.sessionId), payload.startLine);
  }
  if (!options.sparseActivity || payload.activity !== undefined) {
    if (!preserveLocalInterrupt) {
      set(activityFamily(payload.sessionId), payload.activity);
      if (payload.activity !== "interrupted") {
        set(localInterruptedUntilFamily(payload.sessionId), 0);
      }
    }
  }
  if (payload.activityText !== undefined && !preserveLocalInterrupt) {
    set(activityTextFamily(payload.sessionId), payload.activityText);
  }
  if (!options.sparseActivity || payload.attention !== undefined) {
    set(attentionFamily(payload.sessionId), payload.attention);
  }
  set(
    lastErrorFamily(payload.sessionId),
    formatTmuxUnavailable(payload.tmuxUnavailable, "tmux pane output unavailable"),
  );
}

export const applyOutputSnapshotAtom = atom(null, (get, set, snapshot: AgentOutputPayload) => {
  applyAgentOutputPayload(get, set, snapshot, { sparseActivity: false });
});

export const markOutputInterruptedAtom = atom(null, (_get, set, sessionId: string) => {
  set(localInterruptedUntilFamily(sessionId), Date.now() + LOCAL_INTERRUPT_ACTIVITY_HOLD_MS);
  set(applyOutputSnapshotAtom, {
    sessionId,
    outputAnsi: undefined,
    activity: "interrupted",
    activityText: "",
    attention: undefined,
  });
});

export const clearLocalInterruptHoldAtom = atom(null, (_get, set, sessionId: string) => {
  set(localInterruptedUntilFamily(sessionId), 0);
});

function agentOutputEventPayload(event: AgentOutputEvent): AgentOutputPayload {
  return {
    sessionId: event.sessionId,
    output: event.output,
    outputAnsi: event.outputAnsi,
    outputAvailable: event.outputAvailable,
    startLine: event.startLine,
    messages: event.messages,
    activity: event.activity,
    activityText: event.activityText,
    attention: event.attention,
    tmuxUnavailable: event.tmuxUnavailable,
  };
}

export const applyOutputEventAtom = atom(null, (get, set, event: AgentOutputEvent) => {
  applyAgentOutputPayload(get, set, agentOutputEventPayload(event), { sparseActivity: true });
  set(streamingFamily(event.sessionId), true);
});

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
      set(applyOutputEventAtom, event);
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
