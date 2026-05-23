import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { ChatMessage, HistoryPart, ParsedAgentOutput, StreamEvent } from "@/lib/events";

export interface PendingMessage {
  clientMessageId: string;
  parts: HistoryPart[];
  ts: string;
  deliveryState: "sending" | "submitted" | "failed";
  deliveryError?: string;
}

// ─── Per-session base families ─────────────────────────────────────────────

export const chatHistoryFamily = atomFamily((_sessionId: string) => atom<ChatMessage[]>([]));
export const pendingMessagesFamily = atomFamily((_sessionId: string) => atom<PendingMessage[]>([]));
export const outputBufferFamily = atomFamily((_sessionId: string) => atom<string>(""));
export const parsedOutputFamily = atomFamily((_sessionId: string) =>
  atom<ParsedAgentOutput | null>(null),
);
export const streamingFamily = atomFamily((_sessionId: string) => atom<boolean>(false));
// Kept for future stream-token dedup; not wired up yet — see Task 3 deviation #6.
export const streamTokenFamily = atomFamily((_sessionId: string) => atom<number>(0));
export const lastErrorFamily = atomFamily((_sessionId: string) => atom<string | null>(null));

// ─── Action atoms ──────────────────────────────────────────────────────────

// Replace the per-session history and reconcile pending messages — any pending
// message whose clientMessageId now appears in the delivered history is dropped
// (matches desktop-ui/src/stores/state.svelte.js:107-122).
export const setHistoryAtom = atom(
  null,
  (get, set, args: { sessionId: string; messages: ChatMessage[] }) => {
    const { sessionId, messages } = args;
    set(chatHistoryFamily(sessionId), messages);
    const pending = get(pendingMessagesFamily(sessionId));
    if (pending.length === 0) return;
    const deliveredIds = new Set(
      messages.map((m) => m.clientMessageId).filter((id): id is string => Boolean(id)),
    );
    const next = pending.filter((p) => {
      if (p.deliveryState === "failed") return true;
      return !deliveredIds.has(p.clientMessageId);
    });
    if (next.length !== pending.length) {
      set(pendingMessagesFamily(sessionId), next);
    }
  },
);

// Append a pending message, replacing any existing one with the same clientMessageId.
export const addPendingAtom = atom(
  null,
  (get, set, args: { sessionId: string; pending: PendingMessage }) => {
    const { sessionId, pending } = args;
    const current = get(pendingMessagesFamily(sessionId));
    const filtered = current.filter((p) => p.clientMessageId !== pending.clientMessageId);
    set(pendingMessagesFamily(sessionId), [...filtered, pending]);
  },
);

// Patch an existing pending message by clientMessageId.
export const updatePendingAtom = atom(
  null,
  (
    get,
    set,
    args: {
      sessionId: string;
      clientMessageId: string;
      patch: Partial<PendingMessage>;
    },
  ) => {
    const { sessionId, clientMessageId, patch } = args;
    const current = get(pendingMessagesFamily(sessionId));
    const next = current.map((p) =>
      p.clientMessageId === clientMessageId ? { ...p, ...patch } : p,
    );
    set(pendingMessagesFamily(sessionId), next);
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
    case "history_update":
      set(setHistoryAtom, {
        sessionId: event.sessionId,
        messages: event.messages ?? [],
      });
      return;
    case "agent_output":
      set(outputBufferFamily(event.sessionId), event.output);
      set(parsedOutputFamily(event.sessionId), event.parsed ?? null);
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
