import { create } from "zustand";
import type { ChatMessage, HistoryPart, StreamEvent } from "@/lib/events";

export interface PendingMessage {
  clientMessageId: string;
  parts: HistoryPart[];
  ts: string;
  deliveryState: "sending" | "submitted" | "failed";
  deliveryError?: string;
}

interface SessionChatState {
  history: ChatMessage[];
  pendingMessages: PendingMessage[];
  output: string;
  streaming: boolean;
  streamToken: number;
  lastError: string | null;
}

interface ChatStoreState {
  bySession: Record<string, SessionChatState>;
  bumpStreamToken: (sessionId: string) => number;
  setHistory: (sessionId: string, messages: ChatMessage[]) => void;
  setOutput: (sessionId: string, output: string) => void;
  addPending: (sessionId: string, pending: PendingMessage) => void;
  updatePending: (
    sessionId: string,
    clientMessageId: string,
    patch: Partial<PendingMessage>,
  ) => void;
  setStreaming: (sessionId: string, streaming: boolean) => void;
  setError: (sessionId: string, error: string | null) => void;
  ingestEvent: (event: StreamEvent) => void;
  clearSession: (sessionId: string) => void;
}

function blank(): SessionChatState {
  return {
    history: [],
    pendingMessages: [],
    output: "",
    streaming: false,
    streamToken: 0,
    lastError: null,
  };
}

function ensure(state: ChatStoreState, sessionId: string): SessionChatState {
  return state.bySession[sessionId] ?? blank();
}

function reconcilePending(pending: PendingMessage[], delivered: ChatMessage[]): PendingMessage[] {
  if (pending.length === 0) return pending;
  const deliveredIds = new Set(
    delivered.map((m) => m.clientMessageId).filter((id): id is string => Boolean(id)),
  );
  return pending.filter((p) => {
    if (p.deliveryState === "failed") return true;
    return !deliveredIds.has(p.clientMessageId);
  });
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  bySession: {},

  bumpStreamToken: (sessionId: string) => {
    const current = ensure(get(), sessionId);
    const next = current.streamToken + 1;
    set((state) => ({
      bySession: { ...state.bySession, [sessionId]: { ...current, streamToken: next } },
    }));
    return next;
  },

  setHistory: (sessionId, messages) =>
    set((state) => {
      const current = ensure(state, sessionId);
      const pendingMessages = reconcilePending(current.pendingMessages, messages);
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...current, history: messages, pendingMessages },
        },
      };
    }),

  setOutput: (sessionId, output) =>
    set((state) => {
      const current = ensure(state, sessionId);
      return { bySession: { ...state.bySession, [sessionId]: { ...current, output } } };
    }),

  addPending: (sessionId, pending) =>
    set((state) => {
      const current = ensure(state, sessionId);
      const filtered = current.pendingMessages.filter(
        (p) => p.clientMessageId !== pending.clientMessageId,
      );
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...current, pendingMessages: [...filtered, pending] },
        },
      };
    }),

  updatePending: (sessionId, clientMessageId, patch) =>
    set((state) => {
      const current = ensure(state, sessionId);
      const next = current.pendingMessages.map((p) =>
        p.clientMessageId === clientMessageId ? { ...p, ...patch } : p,
      );
      return {
        bySession: { ...state.bySession, [sessionId]: { ...current, pendingMessages: next } },
      };
    }),

  setStreaming: (sessionId, streaming) =>
    set((state) => {
      const current = ensure(state, sessionId);
      return { bySession: { ...state.bySession, [sessionId]: { ...current, streaming } } };
    }),

  setError: (sessionId, error) =>
    set((state) => {
      const current = ensure(state, sessionId);
      return {
        bySession: { ...state.bySession, [sessionId]: { ...current, lastError: error } },
      };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (!state.bySession[sessionId]) return state;
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),

  ingestEvent: (event) => {
    switch (event.type) {
      case "ready": {
        if (event.sessionId) {
          // Reset streaming/output on a fresh connection.
          set((state) => {
            const current = ensure(state, event.sessionId!);
            return {
              bySession: {
                ...state.bySession,
                [event.sessionId!]: { ...current, streaming: false, lastError: null },
              },
            };
          });
        }
        return;
      }
      case "history_update": {
        const sessionId = event.sessionId;
        get().setHistory(sessionId, event.messages ?? []);
        return;
      }
      case "agent_output": {
        const sessionId = event.sessionId;
        get().setOutput(sessionId, event.output);
        get().setStreaming(sessionId, true);
        return;
      }
      case "alert": {
        if (!event.sessionId) return;
        if (event.kind === "task_done" || event.kind === "task_failed") {
          get().setStreaming(event.sessionId, false);
        }
        return;
      }
      case "error": {
        get().setError(event.sessionId, event.error);
        get().setStreaming(event.sessionId, false);
        return;
      }
    }
  },
}));

export function getSessionChatState(sessionId: string | null): SessionChatState {
  if (!sessionId) return blank();
  return useChatStore.getState().bySession[sessionId] ?? blank();
}
