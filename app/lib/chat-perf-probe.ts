import { useEffect } from "react";

export interface ChatPerfStats {
  averageMs: number;
  count: number;
  detail: string;
  id: string;
  lastMs: number;
  maxMs: number;
  slowCount: number;
}

const CHAT_PERF_SLOW_COMMIT_MS = 16;
const CHAT_PERF_FLUSH_MS = 250;

const stats = new Map<string, ChatPerfStats>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    for (const listener of listeners) listener();
  }, CHAT_PERF_FLUSH_MS);
}

export function recordChatPerfCommit(id: string, durationMs: number, detail = "") {
  const previous = stats.get(id);
  const count = (previous?.count ?? 0) + 1;
  const averageMs = previous
    ? previous.averageMs + (durationMs - previous.averageMs) / count
    : durationMs;
  stats.set(id, {
    averageMs,
    count,
    detail,
    id,
    lastMs: durationMs,
    maxMs: Math.max(previous?.maxMs ?? 0, durationMs),
    slowCount: (previous?.slowCount ?? 0) + (durationMs >= CHAT_PERF_SLOW_COMMIT_MS ? 1 : 0),
  });
  scheduleFlush();
}

export function useChatPerfProbe(id: string, detail = "") {
  const renderStartMs = nowMs();
  useEffect(() => {
    recordChatPerfCommit(id, nowMs() - renderStartMs, detail);
  });
}

export function getChatPerfStats(): ChatPerfStats[] {
  return Array.from(stats.values()).sort((a, b) => b.maxMs - a.maxMs);
}

export function subscribeChatPerfStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
