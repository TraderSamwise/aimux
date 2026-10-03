import { atom, type Getter, type Setter } from "jotai";
import { agentStateKey, type AgentStateKey, type ProjectStateKey } from "@/lib/project-key";
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

export const outputBufferFamily = atomFamily((_agentStateKey: AgentStateKey) => atom<string>(""));
export const outputAvailableFamily = atomFamily((_agentStateKey: AgentStateKey) =>
  atom<boolean>(false),
);
/**
 * The same pane with tmux's colours still on it, for the terminal view.
 *
 * Held beside `outputBuffer` rather than replacing it: the plain form is what
 * every other reader (and the parser behind them) takes, and a service too old
 * to send this one leaves it empty rather than blanking the view.
 */
export const outputAnsiFamily = atomFamily((_agentStateKey: AgentStateKey) => atom<string>(""));
/**
 * The conversation, as the service projected it.
 *
 * Not derived from `parsed` any more: the mapping from blocks to messages
 * lives beside the parser that produces the blocks, so both this app and any
 * other client read the same one instead of each keeping a copy that drifts.
 */
export const transcriptFamily = atomFamily((_agentStateKey: AgentStateKey) =>
  atom<AgentTranscriptMessage[]>([]),
);
export const transcriptStartLineFamily = atomFamily((_agentStateKey: AgentStateKey) =>
  atom<number | undefined>(undefined),
);
export const streamingFamily = atomFamily((_agentStateKey: AgentStateKey) => atom<boolean>(false));
/**
 * What the runtime says the session is doing, as opposed to what arriving bytes
 * imply. `undefined` means the service does not report it — not that the agent
 * is idle — so readers must keep their own fallback for that case.
 */
export const activityFamily = atomFamily((_agentStateKey: AgentStateKey) =>
  atom<AgentActivityState | undefined>(undefined),
);
export const attentionFamily = atomFamily((_agentStateKey: AgentStateKey) =>
  atom<AgentAttentionState | undefined>(undefined),
);
/**
 * The tool's own progress line. Sparse events keep the last value so the footer
 * does not flicker; explicit empty strings still clear finished turns.
 */
export const activityTextFamily = atomFamily((_agentStateKey: AgentStateKey) => atom<string>(""));
const localInterruptedUntilFamily = atomFamily((_agentStateKey: AgentStateKey) => atom<number>(0));
// Kept for future stream-token dedup; not wired up yet — see Task 3 deviation #6.
export const streamTokenFamily = atomFamily((_agentStateKey: AgentStateKey) => atom<number>(0));
export const lastErrorFamily = atomFamily((_agentStateKey: AgentStateKey) =>
  atom<string | null>(null),
);

export const LOCAL_INTERRUPT_ACTIVITY_HOLD_MS = 5_000;

export type AgentOutputPayload = {
  agentStateKey: AgentStateKey;
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

function stabilizeSameWindowTranscriptMessages(
  existing: AgentTranscriptMessage[],
  incoming: AgentTranscriptMessage[],
): AgentTranscriptMessage[] {
  if (existing.length === 0 || incoming.length === 0) return incoming;
  const matches = transcriptMessageAlignment(existing, incoming);
  if (matches.length === 0) {
    return existing.some((message) => !message.latest)
      ? [...stripLatestMarkers(existing.filter((message) => !message.latest)), ...incoming]
      : incoming;
  }

  const merged: AgentTranscriptMessage[] = [];
  let existingCursor = 0;
  let incomingCursor = 0;
  for (const [existingIndex, incomingIndex] of matches) {
    appendStabilizedTranscriptGap(
      merged,
      existing.slice(existingCursor, existingIndex),
      incoming.slice(incomingCursor, incomingIndex),
    );
    merged.push(incoming[incomingIndex]);
    existingCursor = existingIndex + 1;
    incomingCursor = incomingIndex + 1;
  }
  appendStabilizedTranscriptGap(
    merged,
    existing.slice(existingCursor),
    incoming.slice(incomingCursor),
  );
  return merged;
}

function appendStabilizedTranscriptGap(
  target: AgentTranscriptMessage[],
  existingGap: AgentTranscriptMessage[],
  incomingGap: AgentTranscriptMessage[],
) {
  if (existingGap.some((message) => !message.latest)) {
    target.push(...stripLatestMarkers(existingGap.filter((message) => !message.latest)));
    return;
  }
  target.push(...incomingGap);
}

function transcriptMessageAlignment(
  existing: AgentTranscriptMessage[],
  incoming: AgentTranscriptMessage[],
): Array<[number, number]> {
  const lengths = Array.from({ length: existing.length + 1 }, () =>
    Array.from({ length: incoming.length + 1 }, () => 0),
  );
  for (let existingIndex = existing.length - 1; existingIndex >= 0; existingIndex -= 1) {
    for (let incomingIndex = incoming.length - 1; incomingIndex >= 0; incomingIndex -= 1) {
      lengths[existingIndex][incomingIndex] =
        transcriptMessageSignature(existing[existingIndex]) ===
        transcriptMessageSignature(incoming[incomingIndex])
          ? lengths[existingIndex + 1][incomingIndex + 1] + 1
          : Math.max(
              lengths[existingIndex + 1][incomingIndex],
              lengths[existingIndex][incomingIndex + 1],
            );
    }
  }

  const matches: Array<[number, number]> = [];
  let existingIndex = 0;
  let incomingIndex = 0;
  while (existingIndex < existing.length && incomingIndex < incoming.length) {
    if (
      transcriptMessageSignature(existing[existingIndex]) ===
      transcriptMessageSignature(incoming[incomingIndex])
    ) {
      matches.push([existingIndex, incomingIndex]);
      existingIndex += 1;
      incomingIndex += 1;
    } else if (
      lengths[existingIndex + 1][incomingIndex] >= lengths[existingIndex][incomingIndex + 1]
    ) {
      existingIndex += 1;
    } else {
      incomingIndex += 1;
    }
  }
  return matches;
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
  agentStateKey: AgentStateKey,
  messages: AgentTranscriptMessage[],
  startLine: number | undefined,
) {
  const startLineAtom = transcriptStartLineFamily(agentStateKey);
  const currentStartLine = get(startLineAtom);
  if (startLine === undefined || currentStartLine === undefined || startLine < currentStartLine) {
    set(transcriptFamily(agentStateKey), messages);
    set(startLineAtom, startLine);
    return;
  }
  if (startLine === currentStartLine) {
    set(
      transcriptFamily(agentStateKey),
      stabilizeSameWindowTranscriptMessages(get(transcriptFamily(agentStateKey)), messages),
    );
    return;
  }
  set(
    transcriptFamily(agentStateKey),
    mergeTranscriptMessages(get(transcriptFamily(agentStateKey)), messages),
  );
}

function applyAgentOutputPayload(
  get: Getter,
  set: Setter,
  payload: AgentOutputPayload,
  options: { sparseActivity: boolean },
) {
  const localInterruptActive =
    get(activityFamily(payload.agentStateKey)) === "interrupted" &&
    get(localInterruptedUntilFamily(payload.agentStateKey)) > Date.now();
  const incomingLooksLikeStaleProgress =
    payload.activity === "running" ||
    (payload.activity === undefined &&
      typeof payload.activityText === "string" &&
      payload.activityText.trim().length > 0);
  const preserveLocalInterrupt =
    localInterruptActive &&
    (incomingLooksLikeStaleProgress || (!options.sparseActivity && payload.activity === undefined));

  if (payload.output !== undefined) {
    set(outputBufferFamily(payload.agentStateKey), payload.output);
    set(outputAnsiFamily(payload.agentStateKey), payload.outputAnsi ?? payload.output);
    set(
      outputAvailableFamily(payload.agentStateKey),
      Boolean(payload.output.length || payload.outputAvailable),
    );
  } else if (payload.outputAnsi !== undefined) {
    set(outputAnsiFamily(payload.agentStateKey), payload.outputAnsi);
    set(
      outputAvailableFamily(payload.agentStateKey),
      Boolean(payload.outputAnsi.length || payload.outputAvailable),
    );
  } else if (payload.outputAvailable !== undefined) {
    set(outputAvailableFamily(payload.agentStateKey), payload.outputAvailable);
  }
  if (payload.messages !== undefined) {
    applyTranscriptMessages(get, set, payload.agentStateKey, payload.messages, payload.startLine);
  } else if (payload.output !== undefined) {
    set(transcriptFamily(payload.agentStateKey), []);
    set(transcriptStartLineFamily(payload.agentStateKey), payload.startLine);
  }
  if (!options.sparseActivity || payload.activity !== undefined) {
    if (!preserveLocalInterrupt) {
      set(activityFamily(payload.agentStateKey), payload.activity);
      if (payload.activity !== "interrupted") {
        set(localInterruptedUntilFamily(payload.agentStateKey), 0);
      }
    }
  }
  if (payload.activityText !== undefined && !preserveLocalInterrupt) {
    set(activityTextFamily(payload.agentStateKey), payload.activityText);
  }
  if (!options.sparseActivity || payload.attention !== undefined) {
    set(attentionFamily(payload.agentStateKey), payload.attention);
  }
  set(
    lastErrorFamily(payload.agentStateKey),
    formatTmuxUnavailable(payload.tmuxUnavailable, "tmux pane output unavailable"),
  );
}

export const applyOutputSnapshotAtom = atom(null, (get, set, snapshot: AgentOutputPayload) => {
  applyAgentOutputPayload(get, set, snapshot, { sparseActivity: false });
});

export const markOutputInterruptedAtom = atom(null, (_get, set, agentStateKey: AgentStateKey) => {
  set(localInterruptedUntilFamily(agentStateKey), Date.now() + LOCAL_INTERRUPT_ACTIVITY_HOLD_MS);
  set(applyOutputSnapshotAtom, {
    agentStateKey,
    outputAnsi: undefined,
    activity: "interrupted",
    activityText: "",
    attention: undefined,
  });
});

export const clearLocalInterruptHoldAtom = atom(null, (_get, set, agentStateKey: AgentStateKey) => {
  set(localInterruptedUntilFamily(agentStateKey), 0);
});

function agentOutputEventPayload(
  projectStateKey: ProjectStateKey,
  event: AgentOutputEvent,
): AgentOutputPayload {
  return {
    agentStateKey: agentStateKey(projectStateKey, event.sessionId),
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

export interface AgentStreamEventInput<T> {
  // Which project service this stream belongs to. The event itself names only
  // a session, and a session id is unique within one service, not across the
  // fleet.
  projectStateKey: ProjectStateKey;
  event: T;
}

export const applyOutputEventAtom = atom(
  null,
  (get, set, { projectStateKey, event }: AgentStreamEventInput<AgentOutputEvent>) => {
    applyAgentOutputPayload(get, set, agentOutputEventPayload(projectStateKey, event), {
      sparseActivity: true,
    });
    set(streamingFamily(agentStateKey(projectStateKey, event.sessionId)), true);
  },
);

// Route a single SSE event into the right per-agent family slots.
export const ingestEventAtom = atom(
  null,
  (get, set, { projectStateKey, event }: AgentStreamEventInput<StreamEvent>) => {
    const keyFor = (sessionId: string | undefined) => agentStateKey(projectStateKey, sessionId);
    switch (event.type) {
      case "ready":
        if (event.sessionId) {
          set(streamingFamily(keyFor(event.sessionId)), false);
          set(lastErrorFamily(keyFor(event.sessionId)), null);
        }
        return;
      case "agent_output":
        set(applyOutputEventAtom, { projectStateKey, event });
        return;
      case "alert":
        if (!event.sessionId) return;
        if (event.kind === "task_done" || event.kind === "task_failed") {
          set(streamingFamily(keyFor(event.sessionId)), false);
        }
        return;
      case "error":
        set(lastErrorFamily(keyFor(event.sessionId)), event.error);
        set(streamingFamily(keyFor(event.sessionId)), false);
        return;
    }
  },
);
