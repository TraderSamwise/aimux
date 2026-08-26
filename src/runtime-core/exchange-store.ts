import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWrite } from "../atomic-write.js";
import { log } from "../debug.js";
import { getRuntimeExchangePath } from "../paths.js";
import {
  RUNTIME_EXCHANGE_RETENTION,
  compactRuntimeExchange,
  countRuntimeExchangeBytes,
  countRuntimeExchangeRecords,
  type RuntimeExchangeCompactionReport,
  type RuntimeExchangeByteCounts,
  type RuntimeExchangeCounts,
} from "./exchange-retention.js";

export const RUNTIME_EXCHANGE_VERSION = 1;
const UPDATE_LOCK_TIMEOUT_MS = 5_000;
const UPDATE_LOCK_RETRY_MS = 25;
const UPDATE_LOCK_STALE_MS = UPDATE_LOCK_TIMEOUT_MS - 1_000;
const SLOW_EXCHANGE_READ_MS = 25;

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
  promptOriginalBytes?: number;
  result?: string;
  resultOriginalBytes?: number;
  error?: string;
  errorOriginalBytes?: number;
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
  const tasks = exchange.tasks.flatMap((task) => {
    if (!task.threadId || threadIds.has(task.threadId)) return [task];
    if (task.status !== "done" && task.status !== "failed") return [{ ...task, threadId: undefined }];
    return [];
  });
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
        promptOriginalBytes: asOptionalNumber(row.promptOriginalBytes),
        result: asOptionalString(row.result),
        resultOriginalBytes: asOptionalNumber(row.resultOriginalBytes),
        error: asOptionalString(row.error),
        errorOriginalBytes: asOptionalNumber(row.errorOriginalBytes),
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

/**
 * Parsed-store cache keyed on the file's exact contents.
 *
 * One dashboard rebuild reads this store ~136 times, because `readMessages` re-reads
 * and re-parses the whole file per thread. At ~4ms a parse that was ~90% of the
 * `/desktop-state` response time, and since every project service shares one event
 * loop it starved unrelated projects' health checks.
 *
 * Keyed on content, not on `(ino, mtime, size)`: inodes are recycled after the rename
 * in `atomicWrite`, Linux mtimes are only tick-granular, and timestamp-only writes are
 * byte-length identical, so a stat key can collide. `read()` feeds `update()`'s
 * read-modify-write, so a stale hit would silently clobber another process's records
 * rather than merely show stale data. Reading the file is much cheaper than parsing it,
 * so comparing contents buys that correctness for almost nothing.
 *
 * Cache the normalized graph too. The dashboard may hit the same exchange file dozens
 * of times per refresh; re-coercing a large exchange can starve the project-service
 * event loop just like reparsing did. Hits return a clone so callers still get a
 * mutation-safe graph.
 */
const RAW_CACHE_MAX = 32;
const rawCache = new Map<string, { text: string; normalized: RuntimeExchange }>();

function rememberRawCache(
  path: string,
  text: string,
  normalized: RuntimeExchange,
  options: { clone?: boolean } = {},
): void {
  rawCache.delete(path);
  rawCache.set(path, { text, normalized: options.clone === false ? normalized : structuredClone(normalized) });
  if (rawCache.size > RAW_CACHE_MAX) {
    const oldest = rawCache.keys().next().value;
    if (oldest !== undefined) rawCache.delete(oldest);
  }
}

// Errnos for which the `existsSync` guard this replaced returned false, so they must
// keep degrading to an empty exchange instead of failing the whole read.
const MISSING_FILE_ERROR_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

// Instrumentation for tests that assert how many times one operation parses this store.
let readCount = 0;
let parseCount = 0;
let readCacheHitCount = 0;
let readCacheMissCount = 0;
let writeCount = 0;
let writeNoopCount = 0;
let lastWrite:
  | {
      ts: string;
      path: string;
      skipped: boolean;
      reason: "changed" | "same-bytes" | "missing-file";
      bytesBefore: number;
      bytesAfter: number;
      compacted: boolean;
      compareDurationMs: number;
      writeDurationMs: number;
    }
  | undefined;
let compactionCount = 0;
let compactedRecordCount = 0;
let lastCompaction:
  | {
      ts: string;
      path: string;
      changed: boolean;
      bytesBefore: number;
      bytesAfter: number;
      before: RuntimeExchangeCounts;
      after: RuntimeExchangeCounts;
      removed: RuntimeExchangeCounts;
      byteCounts: RuntimeExchangeCompactionReport["bytes"];
      retention: RuntimeExchangeCompactionReport["retention"];
    }
  | undefined;

export function getExchangeStoreStats(): { reads: number; parses: number } {
  return { reads: readCount, parses: parseCount };
}

export function getExchangeStoreTelemetry(): {
  reads: number;
  parses: number;
  readCacheHits: number;
  readCacheMisses: number;
  writes: number;
  writeNoops: number;
  lastWrite?: typeof lastWrite;
  compactions: number;
  compactedRecords: number;
  lastCompaction?: typeof lastCompaction;
} {
  return {
    reads: readCount,
    parses: parseCount,
    readCacheHits: readCacheHitCount,
    readCacheMisses: readCacheMissCount,
    writes: writeCount,
    writeNoops: writeNoopCount,
    lastWrite,
    compactions: compactionCount,
    compactedRecords: compactedRecordCount,
    lastCompaction,
  };
}

export function resetExchangeStoreStats(): void {
  readCount = 0;
  parseCount = 0;
  readCacheHitCount = 0;
  readCacheMissCount = 0;
  writeCount = 0;
  writeNoopCount = 0;
  lastWrite = undefined;
  compactionCount = 0;
  compactedRecordCount = 0;
  lastCompaction = undefined;
}

function recordSlowExchangeRead(fields: Record<string, unknown>): void {
  log.warn("slow runtime exchange read", "api", fields);
}

function recordExchangeCompaction(fields: Exclude<typeof lastCompaction, undefined>): void {
  compactionCount += 1;
  compactedRecordCount += fields.removed.totalRecords;
  lastCompaction = fields;
  log.info("runtime exchange compacted", "api", fields);
}

function recordExchangeWrite(fields: Exclude<typeof lastWrite, undefined>): void {
  writeCount += 1;
  if (fields.skipped) writeNoopCount += 1;
  lastWrite = fields;
  if (fields.writeDurationMs >= SLOW_EXCHANGE_READ_MS || fields.compacted) {
    log.info("runtime exchange write", "api", fields);
  }
}

function serializeRuntimeExchange(exchange: RuntimeExchange): string {
  return stringify(exchange, { lineWidth: 120, sortMapEntries: false });
}

export function inspectRuntimeExchangeStore(path = getRuntimeExchangePath()): {
  path: string;
  exists: boolean;
  bytes: number;
  counts: RuntimeExchangeCounts;
  byteCounts: RuntimeExchangeByteCounts;
  compactableByteCounts: RuntimeExchangeCompactionReport["bytes"]["removed"];
  retention: RuntimeExchangeCompactionReport["retention"];
  telemetry: ReturnType<typeof getExchangeStoreTelemetry>;
  error?: string;
} {
  const store = new RuntimeExchangeStore(path);
  const exists = existsSync(path);
  const bytes = exists ? statSync(path).size : 0;
  try {
    const exchange = store.read();
    const report = compactRuntimeExchange(exchange);
    return {
      path,
      exists,
      bytes,
      counts: countRuntimeExchangeRecords(exchange),
      byteCounts: countRuntimeExchangeBytes(exchange),
      compactableByteCounts: report.bytes.removed,
      retention: report.retention,
      telemetry: getExchangeStoreTelemetry(),
    };
  } catch (error) {
    return {
      path,
      exists,
      bytes,
      counts: countRuntimeExchangeRecords(emptyRuntimeExchange()),
      byteCounts: countRuntimeExchangeBytes(emptyRuntimeExchange()),
      compactableByteCounts: countRuntimeExchangeBytes(emptyRuntimeExchange()),
      retention: RUNTIME_EXCHANGE_RETENTION,
      telemetry: getExchangeStoreTelemetry(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface RuntimeExchangeCompactWriteResult {
  path: string;
  changed: boolean;
  bytesBefore: number;
  bytesAfter: number;
  before: RuntimeExchangeCounts;
  after: RuntimeExchangeCounts;
  removed: RuntimeExchangeCounts;
  byteCounts: RuntimeExchangeCompactionReport["bytes"];
  retention: RuntimeExchangeCompactionReport["retention"];
}

export class RuntimeExchangeStore {
  constructor(readonly path = getRuntimeExchangePath()) {}

  read(): RuntimeExchange {
    return this.readWithRaw().exchange;
  }

  private readWithRaw(): { exchange: RuntimeExchange; text?: string } {
    readCount += 1;
    const startedAt = Date.now();
    let readDurationMs = 0;
    let compareDurationMs = 0;
    let parseDurationMs = 0;
    let coerceDurationMs = 0;
    let cloneDurationMs = 0;
    let text: string;
    try {
      const readStartedAt = Date.now();
      text = readFileSync(this.path, "utf-8");
      readDurationMs = Date.now() - readStartedAt;
    } catch (error) {
      // This replaced an `existsSync` guard, so the errnos for which `existsSync`
      // returned false must still degrade to an empty exchange rather than throw.
      // EACCES deliberately still throws: it did before too, when the file existed
      // but could not be opened.
      if (MISSING_FILE_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
        rawCache.delete(this.path);
        return { exchange: emptyRuntimeExchange() };
      }
      throw error;
    }
    const cached = rawCache.get(this.path);
    const compareStartedAt = Date.now();
    const cacheHit = Boolean(cached && cached.text === text);
    compareDurationMs = Date.now() - compareStartedAt;
    if (cacheHit && cached) {
      readCacheHitCount += 1;
      rawCache.delete(this.path);
      rawCache.set(this.path, cached);
      const cloneStartedAt = Date.now();
      const exchange = structuredClone(cached.normalized);
      cloneDurationMs = Date.now() - cloneStartedAt;
      const durationMs = Date.now() - startedAt;
      if (durationMs >= SLOW_EXCHANGE_READ_MS) {
        recordSlowExchangeRead({
          path: this.path,
          cacheHit: true,
          bytes: Buffer.byteLength(text),
          durationMs,
          readDurationMs,
          compareDurationMs,
          cloneDurationMs,
        });
      }
      return { exchange, text };
    }
    readCacheMissCount += 1;
    parseCount += 1;
    const parseStartedAt = Date.now();
    const raw = parse(text);
    parseDurationMs = Date.now() - parseStartedAt;
    const coerceStartedAt = Date.now();
    const normalized = coerceRuntimeExchange(raw);
    coerceDurationMs = Date.now() - coerceStartedAt;
    rememberRawCache(this.path, text, normalized, { clone: false });
    const cloneStartedAt = Date.now();
    const exchange = structuredClone(normalized);
    cloneDurationMs = Date.now() - cloneStartedAt;
    const durationMs = Date.now() - startedAt;
    if (durationMs >= SLOW_EXCHANGE_READ_MS) {
      recordSlowExchangeRead({
        path: this.path,
        cacheHit: false,
        bytes: Buffer.byteLength(text),
        durationMs,
        readDurationMs,
        compareDurationMs,
        parseDurationMs,
        coerceDurationMs,
        cloneDurationMs,
      });
    }
    return { exchange, text };
  }

  private writeCompacted(
    exchange: RuntimeExchange,
    options: { trustedCurrentText?: string } = {},
  ): {
    exchange: RuntimeExchange;
    result: RuntimeExchangeCompactWriteResult;
  } {
    const normalized = coerceRuntimeExchange(exchange);
    const beforeText = serializeRuntimeExchange(normalized);
    const compaction = compactRuntimeExchange(normalized);
    const retained = coerceRuntimeExchange(compaction.retained);
    const afterText = serializeRuntimeExchange(retained);
    const writeStartedAt = Date.now();
    let compareDurationMs = 0;
    let skipped = false;
    let reason: Exclude<Exclude<typeof lastWrite, undefined>["reason"], "changed"> = "missing-file";
    if (options.trustedCurrentText !== undefined) {
      if (options.trustedCurrentText === afterText) {
        skipped = true;
        reason = "same-bytes";
      }
    } else {
      try {
        const compareStartedAt = Date.now();
        const currentText = readFileSync(this.path, "utf-8");
        compareDurationMs = Date.now() - compareStartedAt;
        if (currentText === afterText) {
          skipped = true;
          reason = "same-bytes";
        }
      } catch (error) {
        if (!MISSING_FILE_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    if (!skipped) {
      atomicWrite(this.path, afterText);
    }
    const writeDurationMs = Date.now() - writeStartedAt;
    rememberRawCache(this.path, afterText, retained);
    const result = {
      path: this.path,
      changed: compaction.changed,
      bytesBefore: Buffer.byteLength(beforeText),
      bytesAfter: Buffer.byteLength(afterText),
      before: compaction.before,
      after: compaction.after,
      removed: compaction.removed,
      byteCounts: compaction.bytes,
      retention: compaction.retention,
    };
    recordExchangeWrite({
      ts: new Date().toISOString(),
      path: this.path,
      skipped,
      reason: skipped ? reason : "changed",
      bytesBefore: result.bytesBefore,
      bytesAfter: result.bytesAfter,
      compacted: result.changed,
      compareDurationMs,
      writeDurationMs,
    });
    if (result.changed) recordExchangeCompaction({ ts: new Date().toISOString(), ...result });
    return { exchange: retained, result };
  }

  // Write seeds a cloned cache entry; the returned state still belongs to the caller.
  write(exchange: RuntimeExchange): RuntimeExchange {
    return this.writeCompacted(exchange).exchange;
  }

  compact(): RuntimeExchangeCompactWriteResult {
    const release = this.acquireUpdateLock();
    try {
      const current = this.readWithRaw();
      return this.writeCompacted(current.exchange, { trustedCurrentText: current.text }).result;
    } finally {
      release();
    }
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
    const ownerPath = join(lockPath, "owner");
    try {
      const ownerPid = Number.parseInt(readFileSync(ownerPath, "utf-8").trim(), 10);
      if (Number.isFinite(ownerPid) && ownerPid > 0) {
        if (isProcessAlive(ownerPid)) return false;
        rmSync(lockPath, { recursive: true, force: true });
        return true;
      }
    } catch {
      if (existsSync(ownerPath)) return false;
    }

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
      const current = this.readWithRaw();
      return this.writeCompacted(mutator(current.exchange), { trustedCurrentText: current.text }).exchange;
    } finally {
      release();
    }
  }
}

export function createRuntimeExchangeStore(path?: string): RuntimeExchangeStore {
  return new RuntimeExchangeStore(path);
}
