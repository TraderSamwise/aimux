import { deriveRuntimeExchangeIndexes } from "./runtime-core/exchange-derived.js";
import {
  createRuntimeExchangeStore,
  type RuntimeExchangeMessage,
  type RuntimeExchangeThread,
} from "./runtime-core/exchange-store.js";

// Compatibility API: thread callers keep these names, but runtime exchange owns persistence.
export type ThreadKind = RuntimeExchangeThread["kind"];
export type ThreadStatus = RuntimeExchangeThread["status"];
export type MessageKind = RuntimeExchangeMessage["kind"];

export type OrchestrationThread = RuntimeExchangeThread;
export type OrchestrationMessage = RuntimeExchangeMessage;

export interface ThreadSummary {
  thread: OrchestrationThread;
  latestMessage?: OrchestrationMessage;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function threadUpdatedForMessage(
  thread: OrchestrationThread,
  message: OrchestrationMessage,
  updatedAt: string,
): OrchestrationThread {
  return {
    ...thread,
    updatedAt,
    lastMessageId: message.id,
    unreadBy: unique((thread.participants ?? []).filter((id) => id !== message.from)),
  };
}

export function createThread(
  input: Omit<OrchestrationThread, "id" | "createdAt" | "updatedAt" | "status"> &
    Partial<Pick<OrchestrationThread, "id" | "status">>,
): OrchestrationThread {
  const now = nowIso();
  const thread: OrchestrationThread = {
    id: input.id ?? randomId("thread"),
    title: input.title,
    kind: input.kind,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
    participants: unique(input.participants),
    status: input.status ?? "open",
    owner: input.owner,
    waitingOn: input.waitingOn,
    worktreePath: input.worktreePath,
    taskId: input.taskId,
    relatedPlanIds: input.relatedPlanIds,
    lastMessageId: input.lastMessageId,
    unreadBy: input.unreadBy,
    tags: input.tags,
  };
  createRuntimeExchangeStore().update((exchange) =>
    deriveRuntimeExchangeIndexes({
      ...exchange,
      generatedAt: now,
      threads: [...exchange.threads.filter((existing) => existing.id !== thread.id), thread],
    }),
  );
  return thread;
}

export function readThread(threadId: string): OrchestrationThread | undefined {
  return createRuntimeExchangeStore()
    .read()
    .threads.find((thread) => thread.id === threadId);
}

export function updateThread(
  threadId: string,
  updater: (current: OrchestrationThread) => OrchestrationThread,
): OrchestrationThread | undefined {
  const now = nowIso();
  let updated: OrchestrationThread | undefined;
  createRuntimeExchangeStore().update((exchange) => {
    const threads = exchange.threads.map((current) => {
      if (current.id !== threadId) return current;
      updated = {
        ...updater(current),
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: now,
      };
      return updated;
    });
    return deriveRuntimeExchangeIndexes({
      ...exchange,
      generatedAt: updated ? now : exchange.generatedAt,
      threads,
    });
  });
  return updated;
}

export function listThreads(): OrchestrationThread[] {
  return [...createRuntimeExchangeStore().read().threads].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
}

export function appendMessage(
  threadId: string,
  input: Omit<OrchestrationMessage, "id" | "threadId" | "ts"> & Partial<Pick<OrchestrationMessage, "id" | "ts">>,
): OrchestrationMessage {
  const now = nowIso();
  const message: OrchestrationMessage = {
    id: input.id ?? randomId("msg"),
    threadId,
    ts: input.ts ?? now,
    from: input.from,
    to: input.to,
    kind: input.kind,
    body: input.body,
    taskId: input.taskId,
    planId: input.planId,
    metadata: input.metadata,
    deliveredTo: input.deliveredTo,
    deliveredAt: input.deliveredAt,
  };
  let threadFound = false;
  createRuntimeExchangeStore().update((exchange) => {
    const threads = exchange.threads.map((thread) => {
      if (thread.id !== threadId) return thread;
      threadFound = true;
      return threadUpdatedForMessage(thread, message, now);
    });
    if (!threadFound) throw new Error(`thread not found: ${threadId}`);
    return deriveRuntimeExchangeIndexes({
      ...exchange,
      generatedAt: now,
      threads,
      messages: [...exchange.messages.filter((existing) => existing.id !== message.id), message],
    });
  });
  return message;
}

export function readMessages(threadId: string): OrchestrationMessage[] {
  return createRuntimeExchangeStore()
    .read()
    .messages.filter((message) => message.threadId === threadId)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

export function updateMessage(
  threadId: string,
  messageId: string,
  updater: (current: OrchestrationMessage) => OrchestrationMessage,
): OrchestrationMessage | undefined {
  let updated: OrchestrationMessage | undefined;
  createRuntimeExchangeStore().update((exchange) => {
    const messages = exchange.messages.map((message) => {
      if (message.threadId !== threadId || message.id !== messageId) return message;
      updated = {
        ...updater(message),
        id: message.id,
        threadId: message.threadId,
        ts: message.ts,
      };
      return updated;
    });
    return {
      ...exchange,
      generatedAt: updated ? nowIso() : exchange.generatedAt,
      messages,
    };
  });
  return updated;
}

export function markMessageDelivered(
  threadId: string,
  messageId: string,
  recipient: string,
): OrchestrationMessage | undefined {
  return updateMessage(threadId, messageId, (current) => {
    const deliveredTo = unique([...(current.deliveredTo ?? []), recipient]);
    return {
      ...current,
      deliveredTo,
      deliveredAt: new Date().toISOString(),
    };
  });
}

export function markThreadSeen(threadId: string, sessionId: string): OrchestrationThread | undefined {
  return updateThread(threadId, (current) => ({
    ...current,
    unreadBy: (current.unreadBy ?? []).filter((id) => id !== sessionId),
  }));
}

export function setThreadStatus(
  threadId: string,
  status: ThreadStatus,
  input?: { owner?: string; waitingOn?: string[] },
): OrchestrationThread | undefined {
  return updateThread(threadId, (current) => ({
    ...current,
    status,
    owner: input?.owner ?? current.owner,
    waitingOn: input?.waitingOn ?? (status === "done" || status === "abandoned" ? [] : current.waitingOn),
  }));
}

export function openTaskThread(
  taskId: string,
  input: {
    title: string;
    createdBy: string;
    participants: string[];
    worktreePath?: string;
    kind?: Extract<ThreadKind, "task" | "review">;
  },
): OrchestrationThread {
  const existing = listThreads().find((thread) => thread.taskId === taskId);
  if (existing) return existing;
  return createThread({
    title: input.title,
    kind: input.kind ?? "task",
    createdBy: input.createdBy,
    participants: input.participants,
    taskId,
    worktreePath: input.worktreePath,
  });
}

export function listThreadsForParticipant(participantId: string): OrchestrationThread[] {
  return listThreads().filter((thread) => thread.participants.includes(participantId));
}

export function listThreadSummaries(participantId?: string): ThreadSummary[] {
  const threads = participantId ? listThreadsForParticipant(participantId) : listThreads();
  return threads.map((thread) => {
    const messages = readMessages(thread.id);
    return {
      thread,
      latestMessage: messages[messages.length - 1],
    };
  });
}
