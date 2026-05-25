import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { ParsedAgentOutput, StreamEvent } from "@/lib/events";

// ─── Per-session base families ─────────────────────────────────────────────

export const outputBufferFamily = atomFamily((_sessionId: string) => atom<string>(""));
export const parsedOutputFamily = atomFamily((_sessionId: string) =>
  atom<ParsedAgentOutput | null>(null),
);
export const streamingFamily = atomFamily((_sessionId: string) => atom<boolean>(false));
// Kept for future stream-token dedup; not wired up yet — see Task 3 deviation #6.
export const streamTokenFamily = atomFamily((_sessionId: string) => atom<number>(0));
export const lastErrorFamily = atomFamily((_sessionId: string) => atom<string | null>(null));

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
