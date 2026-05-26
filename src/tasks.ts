import { deriveRuntimeExchangeIndexes } from "./runtime-core/exchange-derived.js";
import { createRuntimeExchangeStore, type RuntimeExchangeTask } from "./runtime-core/exchange-store.js";

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

/**
 * Read a single task by ID.
 */
export function readTask(id: string): Task | undefined {
  const task = createRuntimeExchangeStore()
    .read()
    .tasks.find((entry) => entry.id === id);
  return task ? fromExchangeTask(task) : undefined;
}

/**
 * Read all tasks from the runtime exchange.
 */
export function readAllTasks(): Task[] {
  return createRuntimeExchangeStore().read().tasks.map(fromExchangeTask);
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
