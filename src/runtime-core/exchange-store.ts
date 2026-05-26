import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { getRuntimeExchangePath } from "../paths.js";

export const RUNTIME_EXCHANGE_VERSION = 1;
const UPDATE_LOCK_TIMEOUT_MS = 5_000;
const UPDATE_LOCK_RETRY_MS = 25;
const UPDATE_LOCK_STALE_MS = 1_000;

export type RuntimeExchangeThreadKind = "conversation" | "task" | "review" | "handoff" | "user";
export type RuntimeExchangeThreadStatus = "open" | "waiting" | "blocked" | "done" | "abandoned";
export type RuntimeExchangeMessageKind = "request" | "reply" | "status" | "decision" | "handoff" | "note";
export type RuntimeExchangeTaskStatus = "pending" | "assigned" | "in_progress" | "blocked" | "done" | "failed";
export type RuntimeExchangeReviewStatus = "pending" | "approved" | "changes_requested";
export type RuntimeExchangeWaitStatus = "waiting" | "satisfied" | "cancelled";

export interface RuntimeExchangeThread {
  id: string;
  title: string;
  kind: RuntimeExchangeThreadKind;
  status: RuntimeExchangeThreadStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  participants: string[];
  owner?: string;
  waitingOn?: string[];
  worktreePath?: string;
  taskId?: string;
  relatedPlanIds?: string[];
  lastMessageId?: string;
  unreadBy?: string[];
  tags?: string[];
}

export interface RuntimeExchangeMessage {
  id: string;
  threadId: string;
  ts: string;
  from: string;
  to?: string[];
  kind: RuntimeExchangeMessageKind;
  body: string;
  taskId?: string;
  planId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  deliveredTo?: string[];
  deliveredAt?: string;
}

export interface RuntimeExchangeTask {
  id: string;
  status: RuntimeExchangeTaskStatus;
  assignedBy: string;
  assignedTo?: string;
  assignee?: string;
  assigner?: string;
  threadId?: string;
  tool?: string;
  description: string;
  prompt: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  notifiedAt?: string;
  type?: "task" | "review";
  reviewStatus?: RuntimeExchangeReviewStatus;
  reviewFeedback?: string;
  diff?: string;
  iteration?: number;
  reviewOf?: string;
}

export interface RuntimeExchangeHandoff {
  id: string;
  threadId: string;
  status: "waiting" | "accepted" | "completed" | "cancelled";
  from: string;
  to: string[];
  acceptedBy?: string;
  completedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeExchangeReview {
  id: string;
  taskId: string;
  reviewOf?: string;
  reviewer?: string;
  status: RuntimeExchangeReviewStatus;
  feedback?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeExchangeWait {
  id: string;
  status: RuntimeExchangeWaitStatus;
  subjectKind: "thread" | "task" | "handoff" | "review" | "message";
  subjectId: string;
  waitingOn: string[];
  owner?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface RuntimeExchangeInboxEntry {
  id: string;
  participantId: string;
  subjectKind: "thread" | "task" | "handoff" | "review" | "message";
  subjectId: string;
  state: "unread" | "waiting" | "blocked" | "done";
  urgency: number;
  updatedAt: string;
}

export interface RuntimeExchangePlanRef {
  id: string;
  path: string;
  ownerSessionId?: string;
  threadId?: string;
  taskId?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeExchangeContinuityRef {
  id: string;
  kind: "history" | "context" | "recording" | "status";
  path: string;
  sessionId?: string;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeExchangeAttachmentRef {
  id: string;
  path: string;
  contentUrl?: string;
  threadId?: string;
  messageId?: string;
  mediaType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeExchange {
  version: typeof RUNTIME_EXCHANGE_VERSION;
  generatedAt: string;
  threads: RuntimeExchangeThread[];
  messages: RuntimeExchangeMessage[];
  tasks: RuntimeExchangeTask[];
  handoffs: RuntimeExchangeHandoff[];
  reviews: RuntimeExchangeReview[];
  waits: RuntimeExchangeWait[];
  inbox: RuntimeExchangeInboxEntry[];
  planRefs: RuntimeExchangePlanRef[];
  continuityRefs: RuntimeExchangeContinuityRef[];
  attachmentRefs: RuntimeExchangeAttachmentRef[];
}

export function emptyRuntimeExchange(now = new Date().toISOString()): RuntimeExchange {
  return {
    version: RUNTIME_EXCHANGE_VERSION,
    generatedAt: now,
    threads: [],
    messages: [],
    tasks: [],
    handoffs: [],
    reviews: [],
    waits: [],
    inbox: [],
    planRefs: [],
    continuityRefs: [],
    attachmentRefs: [],
  };
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid runtime exchange: ${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid runtime exchange: ${context} must be a non-empty string`);
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => String(entry));
}

function asRequiredStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`invalid runtime exchange: ${context} must be an array`);
  return value.map((entry) => String(entry)).filter((entry) => entry.trim().length > 0);
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asMessageMetadata(value: unknown): RuntimeExchangeMessage["metadata"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] => {
    const [, field] = entry;
    return field === null || typeof field === "string" || typeof field === "number" || typeof field === "boolean";
  });
  return Object.fromEntries(entries);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeRuntimeExchange(exchange: RuntimeExchange): RuntimeExchange {
  const threads = exchange.threads;
  const threadIds = new Set(threads.map((thread) => thread.id));
  const messages = exchange.messages.filter((message) => threadIds.has(message.threadId));
  const messageIds = new Set(messages.map((message) => message.id));
  const tasks = exchange.tasks.filter((task) => !task.threadId || threadIds.has(task.threadId));
  const taskIds = new Set(tasks.map((task) => task.id));
  const handoffs = exchange.handoffs.filter((handoff) => threadIds.has(handoff.threadId));
  const handoffIds = new Set(handoffs.map((handoff) => handoff.id));
  const reviews = exchange.reviews.filter((review) => taskIds.has(review.taskId));
  const reviewIds = new Set(reviews.map((review) => review.id));
  const subjectExists = (kind: RuntimeExchangeWait["subjectKind"], id: string): boolean => {
    if (kind === "thread") return threadIds.has(id);
    if (kind === "task") return taskIds.has(id);
    if (kind === "handoff") return handoffIds.has(id);
    if (kind === "review") return reviewIds.has(id);
    return messageIds.has(id);
  };

  return {
    ...exchange,
    threads,
    messages,
    tasks,
    handoffs,
    reviews,
    waits: exchange.waits.filter((wait) => subjectExists(wait.subjectKind, wait.subjectId)),
    inbox: exchange.inbox.filter((entry) => subjectExists(entry.subjectKind, entry.subjectId)),
    planRefs: exchange.planRefs.filter(
      (ref) => (!ref.threadId || threadIds.has(ref.threadId)) && (!ref.taskId || taskIds.has(ref.taskId)),
    ),
    continuityRefs: exchange.continuityRefs.filter((ref) => !ref.threadId || threadIds.has(ref.threadId)),
    attachmentRefs: exchange.attachmentRefs.filter(
      (ref) => (!ref.threadId || threadIds.has(ref.threadId)) && (!ref.messageId || messageIds.has(ref.messageId)),
    ),
  };
}

function coerceRuntimeExchange(raw: unknown): RuntimeExchange {
  const record = asRecord(raw, "root");
  if (record.version !== RUNTIME_EXCHANGE_VERSION) {
    throw new Error(`unsupported runtime exchange version: ${String(record.version)}`);
  }
  return normalizeRuntimeExchange({
    version: RUNTIME_EXCHANGE_VERSION,
    generatedAt: asString(record.generatedAt, "generatedAt"),
    threads: asArray(record.threads).map((entry, index) => {
      const row = asRecord(entry, `threads[${index}]`);
      return {
        id: asString(row.id, `threads[${index}].id`),
        title: asString(row.title, `threads[${index}].title`),
        kind: asThreadKind(row.kind),
        status: asThreadStatus(row.status),
        createdAt: asString(row.createdAt, `threads[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `threads[${index}].updatedAt`),
        createdBy: asString(row.createdBy, `threads[${index}].createdBy`),
        participants: asRequiredStringArray(row.participants, `threads[${index}].participants`),
        owner: asOptionalString(row.owner),
        waitingOn: asStringArray(row.waitingOn),
        worktreePath: asOptionalString(row.worktreePath),
        taskId: asOptionalString(row.taskId),
        relatedPlanIds: asStringArray(row.relatedPlanIds),
        lastMessageId: asOptionalString(row.lastMessageId),
        unreadBy: asStringArray(row.unreadBy),
        tags: asStringArray(row.tags),
      };
    }),
    messages: asArray(record.messages).map((entry, index) => {
      const row = asRecord(entry, `messages[${index}]`);
      return {
        id: asString(row.id, `messages[${index}].id`),
        threadId: asString(row.threadId, `messages[${index}].threadId`),
        ts: asString(row.ts, `messages[${index}].ts`),
        from: asString(row.from, `messages[${index}].from`),
        to: asStringArray(row.to),
        kind: asMessageKind(row.kind),
        body: asString(row.body, `messages[${index}].body`),
        taskId: asOptionalString(row.taskId),
        planId: asOptionalString(row.planId),
        metadata: asMessageMetadata(row.metadata),
        deliveredTo: asStringArray(row.deliveredTo),
        deliveredAt: asOptionalString(row.deliveredAt),
      };
    }),
    tasks: asArray(record.tasks).map((entry, index) => {
      const row = asRecord(entry, `tasks[${index}]`);
      return {
        id: asString(row.id, `tasks[${index}].id`),
        status: asTaskStatus(row.status),
        assignedBy: asString(row.assignedBy, `tasks[${index}].assignedBy`),
        assignedTo: asOptionalString(row.assignedTo),
        assignee: asOptionalString(row.assignee),
        assigner: asOptionalString(row.assigner),
        threadId: asOptionalString(row.threadId),
        tool: asOptionalString(row.tool),
        description: asString(row.description, `tasks[${index}].description`),
        prompt: asString(row.prompt, `tasks[${index}].prompt`),
        result: asOptionalString(row.result),
        error: asOptionalString(row.error),
        createdAt: asString(row.createdAt, `tasks[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `tasks[${index}].updatedAt`),
        notifiedAt: asOptionalString(row.notifiedAt),
        type: asTaskType(row.type),
        reviewStatus: row.reviewStatus ? asReviewStatus(row.reviewStatus) : undefined,
        reviewFeedback: asOptionalString(row.reviewFeedback),
        diff: asOptionalString(row.diff),
        iteration: asOptionalNumber(row.iteration),
        reviewOf: asOptionalString(row.reviewOf),
      };
    }),
    handoffs: asArray(record.handoffs).map((entry, index) => {
      const row = asRecord(entry, `handoffs[${index}]`);
      return {
        id: asString(row.id, `handoffs[${index}].id`),
        threadId: asString(row.threadId, `handoffs[${index}].threadId`),
        status: asHandoffStatus(row.status),
        from: asString(row.from, `handoffs[${index}].from`),
        to: asRequiredStringArray(row.to, `handoffs[${index}].to`),
        acceptedBy: asOptionalString(row.acceptedBy),
        completedBy: asOptionalString(row.completedBy),
        createdAt: asString(row.createdAt, `handoffs[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `handoffs[${index}].updatedAt`),
      };
    }),
    reviews: asArray(record.reviews).map((entry, index) => {
      const row = asRecord(entry, `reviews[${index}]`);
      return {
        id: asString(row.id, `reviews[${index}].id`),
        taskId: asString(row.taskId, `reviews[${index}].taskId`),
        reviewOf: asOptionalString(row.reviewOf),
        reviewer: asOptionalString(row.reviewer),
        status: asReviewStatus(row.status),
        feedback: asOptionalString(row.feedback),
        createdAt: asString(row.createdAt, `reviews[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `reviews[${index}].updatedAt`),
      };
    }),
    waits: asArray(record.waits).map((entry, index) => {
      const row = asRecord(entry, `waits[${index}]`);
      return {
        id: asString(row.id, `waits[${index}].id`),
        status: asWaitStatus(row.status),
        subjectKind: asSubjectKind(row.subjectKind),
        subjectId: asString(row.subjectId, `waits[${index}].subjectId`),
        waitingOn: asRequiredStringArray(row.waitingOn, `waits[${index}].waitingOn`),
        owner: asOptionalString(row.owner),
        createdAt: asString(row.createdAt, `waits[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `waits[${index}].updatedAt`),
        resolvedAt: asOptionalString(row.resolvedAt),
      };
    }),
    inbox: asArray(record.inbox).map((entry, index) => {
      const row = asRecord(entry, `inbox[${index}]`);
      return {
        id: asString(row.id, `inbox[${index}].id`),
        participantId: asString(row.participantId, `inbox[${index}].participantId`),
        subjectKind: asSubjectKind(row.subjectKind),
        subjectId: asString(row.subjectId, `inbox[${index}].subjectId`),
        state: asInboxState(row.state),
        urgency: asNumber(row.urgency),
        updatedAt: asString(row.updatedAt, `inbox[${index}].updatedAt`),
      };
    }),
    planRefs: asArray(record.planRefs).map((entry, index) => {
      const row = asRecord(entry, `planRefs[${index}]`);
      return {
        id: asString(row.id, `planRefs[${index}].id`),
        path: asString(row.path, `planRefs[${index}].path`),
        ownerSessionId: asOptionalString(row.ownerSessionId),
        threadId: asOptionalString(row.threadId),
        taskId: asOptionalString(row.taskId),
        title: asOptionalString(row.title),
        createdAt: asString(row.createdAt, `planRefs[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `planRefs[${index}].updatedAt`),
      };
    }),
    continuityRefs: asArray(record.continuityRefs).map((entry, index) => {
      const row = asRecord(entry, `continuityRefs[${index}]`);
      return {
        id: asString(row.id, `continuityRefs[${index}].id`),
        kind: asContinuityKind(row.kind),
        path: asString(row.path, `continuityRefs[${index}].path`),
        sessionId: asOptionalString(row.sessionId),
        threadId: asOptionalString(row.threadId),
        createdAt: asString(row.createdAt, `continuityRefs[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `continuityRefs[${index}].updatedAt`),
      };
    }),
    attachmentRefs: asArray(record.attachmentRefs).map((entry, index) => {
      const row = asRecord(entry, `attachmentRefs[${index}]`);
      return {
        id: asString(row.id, `attachmentRefs[${index}].id`),
        path: asString(row.path, `attachmentRefs[${index}].path`),
        contentUrl: asOptionalString(row.contentUrl),
        threadId: asOptionalString(row.threadId),
        messageId: asOptionalString(row.messageId),
        mediaType: asOptionalString(row.mediaType),
        createdAt: asString(row.createdAt, `attachmentRefs[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `attachmentRefs[${index}].updatedAt`),
      };
    }),
  });
}

function asThreadKind(value: unknown): RuntimeExchangeThreadKind {
  const kind = String(value);
  if (kind === "conversation" || kind === "task" || kind === "review" || kind === "handoff" || kind === "user") {
    return kind;
  }
  return "conversation";
}

function asThreadStatus(value: unknown): RuntimeExchangeThreadStatus {
  const status = String(value);
  if (
    status === "open" ||
    status === "waiting" ||
    status === "blocked" ||
    status === "done" ||
    status === "abandoned"
  ) {
    return status;
  }
  return "open";
}

function asMessageKind(value: unknown): RuntimeExchangeMessageKind {
  const kind = String(value);
  if (
    kind === "request" ||
    kind === "reply" ||
    kind === "status" ||
    kind === "decision" ||
    kind === "handoff" ||
    kind === "note"
  ) {
    return kind;
  }
  return "note";
}

function asTaskStatus(value: unknown): RuntimeExchangeTaskStatus {
  const status = String(value);
  if (
    status === "pending" ||
    status === "assigned" ||
    status === "in_progress" ||
    status === "blocked" ||
    status === "done" ||
    status === "failed"
  ) {
    return status;
  }
  return "failed";
}

function asReviewStatus(value: unknown): RuntimeExchangeReviewStatus {
  const status = String(value);
  if (status === "pending" || status === "approved" || status === "changes_requested") return status;
  return "pending";
}

function asTaskType(value: unknown): RuntimeExchangeTask["type"] {
  const type = String(value);
  if (type === "task" || type === "review") return type;
  return undefined;
}

function asHandoffStatus(value: unknown): RuntimeExchangeHandoff["status"] {
  const status = String(value);
  if (status === "waiting" || status === "accepted" || status === "completed" || status === "cancelled") {
    return status;
  }
  return "waiting";
}

function asWaitStatus(value: unknown): RuntimeExchangeWaitStatus {
  const status = String(value);
  if (status === "waiting" || status === "satisfied" || status === "cancelled") return status;
  return "cancelled";
}

function asSubjectKind(value: unknown): RuntimeExchangeWait["subjectKind"] {
  const kind = String(value);
  if (kind === "thread" || kind === "task" || kind === "handoff" || kind === "review" || kind === "message") {
    return kind;
  }
  return "thread";
}

function asInboxState(value: unknown): RuntimeExchangeInboxEntry["state"] {
  const state = String(value);
  if (state === "unread" || state === "waiting" || state === "blocked" || state === "done") return state;
  return "unread";
}

function asContinuityKind(value: unknown): RuntimeExchangeContinuityRef["kind"] {
  const kind = String(value);
  if (kind === "history" || kind === "context" || kind === "recording" || kind === "status") return kind;
  return "history";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class RuntimeExchangeStore {
  constructor(readonly path = getRuntimeExchangePath()) {}

  read(): RuntimeExchange {
    if (!existsSync(this.path)) return emptyRuntimeExchange();
    const parsed = parse(readFileSync(this.path, "utf-8"));
    return coerceRuntimeExchange(parsed);
  }

  write(exchange: RuntimeExchange): RuntimeExchange {
    mkdirSync(dirname(this.path), { recursive: true });
    const normalized = coerceRuntimeExchange(exchange);
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(
      tmpPath,
      stringify(normalized, {
        lineWidth: 120,
        sortMapEntries: false,
      }),
    );
    renameSync(tmpPath, this.path);
    return normalized;
  }

  private acquireUpdateLock(): () => void {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + UPDATE_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        mkdirSync(lockPath);
        try {
          writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
        } catch (ownerError) {
          rmSync(lockPath, { recursive: true, force: true });
          throw ownerError;
        }
        return () => rmSync(lockPath, { recursive: true, force: true });
      } catch (error) {
        if (this.recoverStaleUpdateLock(lockPath)) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring runtime exchange update lock at ${lockPath}`, { cause: error });
        }
        sleepSync(UPDATE_LOCK_RETRY_MS);
      }
    }
  }

  private recoverStaleUpdateLock(lockPath: string): boolean {
    try {
      const ownerPid = Number.parseInt(readFileSync(join(lockPath, "owner"), "utf-8").trim(), 10);
      if (Number.isFinite(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
        rmSync(lockPath, { recursive: true, force: true });
        return true;
      }
    } catch {}

    try {
      if (Date.now() - statSync(lockPath).mtimeMs > UPDATE_LOCK_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        return true;
      }
    } catch {}

    return false;
  }

  update(mutator: (exchange: RuntimeExchange) => RuntimeExchange): RuntimeExchange {
    const release = this.acquireUpdateLock();
    try {
      return this.write(mutator(this.read()));
    } finally {
      release();
    }
  }
}

export function createRuntimeExchangeStore(path?: string): RuntimeExchangeStore {
  return new RuntimeExchangeStore(path);
}
