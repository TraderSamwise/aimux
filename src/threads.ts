import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getThreadsDir } from "./paths.js";

export type ThreadKind = "conversation" | "task" | "review" | "handoff" | "user";
export type ThreadStatus = "open" | "waiting" | "blocked" | "done" | "abandoned";
export type MessageKind = "request" | "reply" | "status" | "decision" | "handoff" | "note";

export interface OrchestrationThread {
  id: string;
  title: string;
  kind: ThreadKind;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  participants: string[];
  status: ThreadStatus;
  owner?: string;
  waitingOn?: string[];
  worktreePath?: string;
  taskId?: string;
  relatedPlanIds?: string[];
  lastMessageId?: string;
  unreadBy?: string[];
  tags?: string[];
}

export interface OrchestrationMessage {
  id: string;
  threadId: string;
  ts: string;
  from: string;
  to?: string[];
  kind: MessageKind;
  body: string;
  taskId?: string;
  planId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  deliveredTo?: string[];
  deliveredAt?: string;
}

export interface ThreadSummary {
  thread: OrchestrationThread;
  latestMessage?: OrchestrationMessage;
}

function threadsDir(): string {
  const dir = getThreadsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function threadPath(threadId: string): string {
  return join(threadsDir(), `${threadId}.json`);
}

function messagesPath(threadId: string): string {
  return join(threadsDir(), `${threadId}.jsonl`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createThread(
  input: Omit<OrchestrationThread, "id" | "createdAt" | "updatedAt" | "status"> &
    Partial<Pick<OrchestrationThread, "id" | "status">>,
): OrchestrationThread {
  const thread: OrchestrationThread = {
    id: input.id ?? randomId("thread"),
    title: input.title,
    kind: input.kind,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    createdBy: input.createdBy,
    participants: [...new Set(input.participants)],
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
  writeFileSync(threadPath(thread.id), JSON.stringify(thread, null, 2) + "\n");
  return thread;
}

export function readThread(threadId: string): OrchestrationThread | undefined {
  if (!existsSync(threadPath(threadId))) return undefined;
  try {
    return JSON.parse(readFileSync(threadPath(threadId), "utf-8")) as OrchestrationThread;
  } catch {
    return undefined;
  }
}

export function updateThread(
  threadId: string,
  updater: (current: OrchestrationThread) => OrchestrationThread,
): OrchestrationThread | undefined {
  const current = readThread(threadId);
  if (!current) return undefined;
  const next: OrchestrationThread = {
    ...updater(current),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  };
  writeFileSync(threadPath(threadId), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function listThreads(): OrchestrationThread[] {
  try {
    return readdirSync(threadsDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(threadsDir(), name), "utf-8")) as OrchestrationThread;
        } catch {
          return undefined;
        }
      })
      .filter((value): value is OrchestrationThread => Boolean(value))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  } catch {
    return [];
  }
}

export function appendMessage(
  threadId: string,
  input: Omit<OrchestrationMessage, "id" | "threadId" | "ts"> & Partial<Pick<OrchestrationMessage, "id" | "ts">>,
): OrchestrationMessage {
  const message: OrchestrationMessage = {
    id: input.id ?? randomId("msg"),
    threadId,
    ts: input.ts ?? nowIso(),
    from: input.from,
    to: input.to,
    kind: input.kind,
    body: input.body,
    taskId: input.taskId,
    planId: input.planId,
    metadata: input.metadata,
  };
  appendFileSync(messagesPath(threadId), JSON.stringify(message) + "\n");
  updateThread(threadId, (current) => ({
    ...current,
    lastMessageId: message.id,
    unreadBy: [...new Set((current.participants ?? []).filter((id) => id !== message.from))],
  }));
  return message;
}

export function readMessages(threadId: string): OrchestrationMessage[] {
  if (!existsSync(messagesPath(threadId))) return [];
  try {
    return readFileSync(messagesPath(threadId), "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as OrchestrationMessage;
        } catch {
          return undefined;
        }
      })
      .filter((value): value is OrchestrationMessage => Boolean(value));
  } catch {
    return [];
  }
}

export function updateMessage(
  threadId: string,
  messageId: string,
  updater: (current: OrchestrationMessage) => OrchestrationMessage,
): OrchestrationMessage | undefined {
  const messages = readMessages(threadId);
  if (messages.length === 0) return undefined;
  let updated: OrchestrationMessage | undefined;
  const nextMessages = messages.map((message) => {
    if (message.id !== messageId) return message;
    updated = {
      ...updater(message),
      id: message.id,
      threadId: message.threadId,
      ts: message.ts,
    };
    return updated;
  });
  if (!updated) return undefined;
  writeFileSync(messagesPath(threadId), nextMessages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  return updated;
}

export function markMessageDelivered(
  threadId: string,
  messageId: string,
  recipient: string,
): OrchestrationMessage | undefined {
  return updateMessage(threadId, messageId, (current) => {
    const deliveredTo = [...new Set([...(current.deliveredTo ?? []), recipient])];
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
