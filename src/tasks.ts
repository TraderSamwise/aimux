import { deriveRuntimeExchangeIndexes } from "./runtime-core/exchange-derived.js";
import {
  createRuntimeExchangeStore,
  type RuntimeExchange,
  type RuntimeExchangeTask,
  type RuntimeExchangeThread,
} from "./runtime-core/exchange-store.js";

// Compatibility API: task callers keep these names, but runtime exchange owns persistence.
export type TaskStatus = RuntimeExchangeTask["status"];
export type ReviewStatus = "pending" | "approved" | "changes_requested";
export type ReviewStatusInput =
  | ReviewStatus
  | "approve"
  | "request-changes"
  | "request_changes"
  | "changes-requested"
  | "changes requested";

export interface Task extends Omit<RuntimeExchangeTask, "reviewStatus"> {
  reviewStatus?: ReviewStatusInput;
}

export function normalizeReviewStatus(status: unknown): ReviewStatus | undefined {
  if (!status) return undefined;
  const normalized = String(status)
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (normalized === "approve" || normalized === "approved") return "approved";
  if (normalized === "pending") return "pending";
  if (normalized === "request_changes" || normalized === "changes_requested") return "changes_requested";
  return undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toExchangeTask(task: Task, updatedAt: string): RuntimeExchangeTask {
  return {
    ...task,
    updatedAt,
    reviewStatus: normalizeReviewStatus(task.reviewStatus),
  };
}

function fromExchangeTask(task: RuntimeExchangeTask): Task {
  return { ...task };
}

function latestThreadMessage(exchange: RuntimeExchange, threadId: string): { from: string; body: string } | undefined {
  return exchange.messages
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))[0];
}

function isTaskThreadWaitingOnAssignee(task: RuntimeExchangeTask, thread: RuntimeExchangeThread | undefined): boolean {
  if (!thread || (thread.kind !== "task" && thread.kind !== "review")) return false;
  if (thread.taskId !== task.id) return false;
  if (!task.assignedTo || !thread.waitingOn?.includes(task.assignedTo)) return false;
  return thread.status === "waiting" && (task.status === "done" || task.status === "failed");
}

function reconcileWaitingTaskThreads(): void {
  const updatedAt = nowIso();
  let changed = false;
  createRuntimeExchangeStore().update((exchange) => {
    const threadsByTaskId = new Map(
      exchange.threads.flatMap((thread) => (thread.taskId ? [[thread.taskId, thread]] : [])),
    );
    const tasks = exchange.tasks.map((task) => {
      const thread = threadsByTaskId.get(task.id);
      if (!isTaskThreadWaitingOnAssignee(task, thread)) return task;
      const latest = latestThreadMessage(exchange, thread!.id);
      if (latest?.from === task.assignedTo) return task;
      changed = true;
      return {
        ...task,
        status: "pending" as const,
        assignedBy: latest?.from.trim() || task.assignedBy,
        error: latest?.body.trim() || task.error,
        notifiedAt: undefined,
        updatedAt,
      };
    });
    if (!changed) return exchange;
    return deriveRuntimeExchangeIndexes({
      ...exchange,
      generatedAt: updatedAt,
      tasks,
    });
  });
}

/**
 * Read a single task by ID.
 */
function readTaskFromExchange(id: string): Task | undefined {
  const task = createRuntimeExchangeStore()
    .read()
    .tasks.find((entry) => entry.id === id);
  return task ? fromExchangeTask(task) : undefined;
}

export function readTaskSnapshot(id: string): Task | undefined {
  return readTaskFromExchange(id);
}

export function readTask(id: string): Task | undefined {
  reconcileWaitingTaskThreads();
  return readTaskFromExchange(id);
}

/**
 * Read all tasks from the runtime exchange.
 */
export function readAllTaskSnapshots(): Task[] {
  return createRuntimeExchangeStore().read().tasks.map(fromExchangeTask);
}

/**
 * Read all tasks from the runtime exchange.
 */
export function readAllTasks(): Task[] {
  reconcileWaitingTaskThreads();
  return readAllTaskSnapshots();
}

/**
 * Write a task to the runtime exchange.
 */
export function writeTask(task: Task): void {
  const updatedAt = nowIso();
  createRuntimeExchangeStore().update((exchange) =>
    deriveRuntimeExchangeIndexes({
      ...exchange,
      generatedAt: updatedAt,
      tasks: [...exchange.tasks.filter((existing) => existing.id !== task.id), toExchangeTask(task, updatedAt)],
    }),
  );
  task.updatedAt = updatedAt;
  task.reviewStatus = normalizeReviewStatus(task.reviewStatus);
}

/**
 * Returns true if the session has an active (assigned) task.
 */
export function hasActiveTask(sessionId: string): boolean {
  return readAllTasks().some(
    (task) => ["assigned", "in_progress", "blocked"].includes(task.status) && task.assignedTo === sessionId,
  );
}

/**
 * Remove done/failed tasks older than maxAgeMs.
 */
export function cleanupTasks(maxAgeMs: number): void {
  const now = Date.now();
  const generatedAt = nowIso();
  createRuntimeExchangeStore().update((exchange) =>
    deriveRuntimeExchangeIndexes({
      ...exchange,
      generatedAt,
      tasks: exchange.tasks.filter((task) => {
        if (task.status !== "done" && task.status !== "failed") return true;
        return now - new Date(task.updatedAt).getTime() <= maxAgeMs;
      }),
    }),
  );
}

/**
 * List pending review tasks assigned to a given role.
 */
export function listPendingReviews(role: string): Task[] {
  return readAllTasks().filter(
    (task) =>
      task.type === "review" &&
      task.assignee === role &&
      task.status === "pending" &&
      normalizeReviewStatus(task.reviewStatus) === "pending",
  );
}

/**
 * List active tasks assigned to a given role (pending or assigned, not done/failed).
 */
export function listTasksForRole(role: string): Task[] {
  return readAllTasks().filter((task) => task.assignee === role && task.status !== "done" && task.status !== "failed");
}
