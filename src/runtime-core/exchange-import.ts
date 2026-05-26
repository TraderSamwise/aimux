import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { AttachmentRecord } from "../attachment-store.js";
import {
  getAttachmentsDir,
  getContextDir,
  getHistoryDir,
  getPlansDir,
  getRecordingsDir,
  getStatusDir,
  getTasksDir,
  getThreadsDir,
} from "../paths.js";
import type { Task } from "../tasks.js";
import type { OrchestrationMessage, OrchestrationThread } from "../threads.js";
import {
  emptyRuntimeExchange,
  type RuntimeExchange,
  type RuntimeExchangeAttachmentRef,
  type RuntimeExchangeContinuityRef,
  type RuntimeExchangeHandoff,
  type RuntimeExchangeInboxEntry,
  type RuntimeExchangeMessage,
  type RuntimeExchangePlanRef,
  type RuntimeExchangeReview,
  type RuntimeExchangeTask,
  type RuntimeExchangeThread,
  type RuntimeExchangeWait,
} from "./exchange-store.js";

export interface RuntimeExchangeLegacySnapshot {
  threads?: OrchestrationThread[];
  messages?: OrchestrationMessage[];
  tasks?: Task[];
  planPaths?: string[];
  historyPaths?: string[];
  contextPaths?: string[];
  recordingPaths?: string[];
  statusPaths?: string[];
  attachments?: AttachmentRecord[];
  now?: string;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function safeJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(predicate)
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function listNestedFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const paths: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        paths.push(...listNestedFiles(path, predicate));
      } else if (predicate(entry.name)) {
        paths.push(path);
      }
    }
  } catch {
    return [];
  }
  return paths;
}

function readLegacyThreads(): OrchestrationThread[] {
  return listFiles(getThreadsDir(), (name) => name.endsWith(".json"))
    .map((path) => safeJson<OrchestrationThread>(path))
    .filter((thread): thread is OrchestrationThread => Boolean(thread));
}

function readLegacyMessages(threadIds: string[]): OrchestrationMessage[] {
  return threadIds.flatMap((threadId) => {
    const path = join(getThreadsDir(), `${threadId}.jsonl`);
    if (!existsSync(path)) return [];
    try {
      return readFileSync(path, "utf8")
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
        .filter((message): message is OrchestrationMessage => Boolean(message));
    } catch {
      return [];
    }
  });
}

function readLegacyTasks(): Task[] {
  return listFiles(getTasksDir(), (name) => name.endsWith(".json"))
    .map((path) => safeJson<Task>(path))
    .filter((task): task is Task => Boolean(task));
}

function readLegacyAttachments(): AttachmentRecord[] {
  return listFiles(getAttachmentsDir(), (name) => name.endsWith(".json"))
    .map((path) => safeJson<AttachmentRecord>(path))
    .filter((attachment): attachment is AttachmentRecord => Boolean(attachment));
}

function toExchangeThread(thread: OrchestrationThread): RuntimeExchangeThread {
  return {
    id: thread.id,
    title: thread.title,
    kind: thread.kind,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    createdBy: thread.createdBy,
    participants: thread.participants,
    owner: thread.owner,
    waitingOn: thread.waitingOn,
    worktreePath: thread.worktreePath,
    taskId: thread.taskId,
    relatedPlanIds: thread.relatedPlanIds,
    lastMessageId: thread.lastMessageId,
    unreadBy: thread.unreadBy,
    tags: thread.tags,
  };
}

function toExchangeMessage(message: OrchestrationMessage): RuntimeExchangeMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    ts: message.ts,
    from: message.from,
    to: message.to,
    kind: message.kind,
    body: message.body,
    taskId: message.taskId,
    planId: message.planId,
    metadata: message.metadata,
    deliveredTo: message.deliveredTo,
    deliveredAt: message.deliveredAt,
  };
}

function normalizeReviewStatus(status: unknown): RuntimeExchangeTask["reviewStatus"] {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (normalized === "approved" || normalized === "approve") return "approved";
  if (normalized === "changes_requested" || normalized === "request_changes") return "changes_requested";
  if (normalized === "pending") return "pending";
  return undefined;
}

function toExchangeTask(task: Task): RuntimeExchangeTask {
  return {
    id: task.id,
    status: task.status,
    assignedBy: task.assignedBy,
    assignedTo: task.assignedTo,
    assignee: task.assignee,
    assigner: task.assigner,
    threadId: task.threadId,
    tool: task.tool,
    description: task.description,
    prompt: task.prompt,
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    notifiedAt: task.notifiedAt,
    type: task.type,
    reviewStatus: normalizeReviewStatus(task.reviewStatus),
    reviewFeedback: task.reviewFeedback,
    diff: task.diff,
    iteration: task.iteration,
    reviewOf: task.reviewOf,
  };
}

function buildHandoff(thread: OrchestrationThread): RuntimeExchangeHandoff | undefined {
  if (thread.kind !== "handoff") return undefined;
  const recipients = unique(
    thread.waitingOn?.length ? thread.waitingOn : thread.participants.filter((id) => id !== thread.createdBy),
  );
  if (recipients.length === 0) return undefined;
  return {
    id: `handoff:${thread.id}`,
    threadId: thread.id,
    status: thread.status === "done" ? "completed" : thread.status === "abandoned" ? "cancelled" : "waiting",
    from: thread.createdBy,
    to: recipients,
    acceptedBy: thread.status === "open" ? thread.owner : undefined,
    completedBy: thread.status === "done" ? thread.owner : undefined,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function buildReview(task: Task): RuntimeExchangeReview | undefined {
  if (task.type !== "review") return undefined;
  return {
    id: `review:${task.id}`,
    taskId: task.id,
    reviewOf: task.reviewOf,
    reviewer: task.assignedTo ?? task.assignee,
    status: normalizeReviewStatus(task.reviewStatus) ?? "pending",
    feedback: task.reviewFeedback ?? task.result,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function buildThreadWait(thread: OrchestrationThread): RuntimeExchangeWait | undefined {
  const waitingOn = unique(thread.waitingOn ?? []);
  if (waitingOn.length === 0) return undefined;
  return {
    id: `wait:thread:${thread.id}`,
    status: thread.status === "done" || thread.status === "abandoned" ? "satisfied" : "waiting",
    subjectKind: "thread",
    subjectId: thread.id,
    waitingOn,
    owner: thread.owner,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    resolvedAt: thread.status === "done" || thread.status === "abandoned" ? thread.updatedAt : undefined,
  };
}

function buildInboxEntries(thread: OrchestrationThread): RuntimeExchangeInboxEntry[] {
  const participants = unique([...(thread.unreadBy ?? []), ...(thread.waitingOn ?? [])]);
  return participants.map((participantId) => {
    const waiting = (thread.waitingOn ?? []).includes(participantId);
    return {
      id: `inbox:${participantId}:thread:${thread.id}`,
      participantId,
      subjectKind: "thread",
      subjectId: thread.id,
      state: thread.status === "blocked" ? "blocked" : waiting ? "waiting" : "unread",
      urgency: (waiting ? 10 : 0) + ((thread.unreadBy ?? []).includes(participantId) ? 3 : 0),
      updatedAt: thread.updatedAt,
    };
  });
}

function planRefFromPath(path: string, now: string): RuntimeExchangePlanRef {
  const sessionId = basename(path).replace(/\.md$/, "");
  return {
    id: `plan:${sessionId}`,
    path,
    ownerSessionId: sessionId,
    title: sessionId,
    createdAt: now,
    updatedAt: now,
  };
}

function continuityKindForPath(path: string): RuntimeExchangeContinuityRef["kind"] {
  if (path.includes("/recordings/")) return "recording";
  if (path.includes("/status/")) return "status";
  if (path.includes("/history/")) return "history";
  return "context";
}

function continuityRefFromPath(path: string, now: string): RuntimeExchangeContinuityRef {
  const kind = continuityKindForPath(path);
  const file = basename(path);
  const sessionId = file.replace(/\.(jsonl|md|txt)$/, "");
  return {
    id: `${kind}:${sessionId}:${file}`,
    kind,
    path,
    sessionId,
    createdAt: now,
    updatedAt: now,
  };
}

function attachmentRefFromRecord(record: AttachmentRecord): RuntimeExchangeAttachmentRef {
  return {
    id: record.id,
    path: record.contentPath,
    contentUrl: `/attachments/${record.id}/content`,
    mediaType: record.mimeType,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  };
}

export function buildRuntimeExchangeFromLegacySnapshot(input: RuntimeExchangeLegacySnapshot = {}): RuntimeExchange {
  const now = input.now ?? new Date().toISOString();
  const exchange = emptyRuntimeExchange(now);
  const threads = input.threads ?? [];
  const tasks = input.tasks ?? [];
  exchange.threads = threads.map(toExchangeThread);
  exchange.messages = (input.messages ?? []).map(toExchangeMessage);
  exchange.tasks = tasks.map(toExchangeTask);
  exchange.handoffs = threads
    .map(buildHandoff)
    .filter((handoff): handoff is RuntimeExchangeHandoff => Boolean(handoff));
  exchange.reviews = tasks.map(buildReview).filter((review): review is RuntimeExchangeReview => Boolean(review));
  exchange.waits = threads.map(buildThreadWait).filter((wait): wait is RuntimeExchangeWait => Boolean(wait));
  exchange.inbox = threads.flatMap(buildInboxEntries);
  exchange.planRefs = (input.planPaths ?? []).map((path) => planRefFromPath(path, now));
  exchange.continuityRefs = [
    ...(input.historyPaths ?? []),
    ...(input.contextPaths ?? []),
    ...(input.recordingPaths ?? []),
    ...(input.statusPaths ?? []),
  ].map((path) => continuityRefFromPath(path, now));
  exchange.attachmentRefs = (input.attachments ?? []).map(attachmentRefFromRecord);
  return exchange;
}

export function importRuntimeExchangeFromLegacyFiles(input: { now?: string } = {}): RuntimeExchange {
  const now = input.now ?? new Date().toISOString();
  const threads = readLegacyThreads();
  return buildRuntimeExchangeFromLegacySnapshot({
    now,
    threads,
    messages: readLegacyMessages(threads.map((thread) => thread.id)),
    tasks: readLegacyTasks(),
    planPaths: listFiles(getPlansDir(), (name) => name.endsWith(".md")),
    historyPaths: listFiles(getHistoryDir(), (name) => name.endsWith(".jsonl")),
    contextPaths: listNestedFiles(getContextDir(), (name) => name.endsWith(".md") || name.endsWith(".jsonl")),
    recordingPaths: listFiles(getRecordingsDir(), (name) => name.endsWith(".txt") || name.endsWith(".log")),
    statusPaths: listFiles(getStatusDir(), (name) => name.endsWith(".md")),
    attachments: readLegacyAttachments(),
  });
}
