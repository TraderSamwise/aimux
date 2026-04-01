import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import { getTasksDir } from "./paths.js";

export type TaskStatus = "pending" | "assigned" | "in_progress" | "blocked" | "done" | "failed";

export interface Task {
  id: string;
  status: TaskStatus;
  assignedBy: string;
  assignedTo?: string;
  threadId?: string;
  tool?: string;
  description: string;
  prompt: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  notifiedAt?: string;
  /** Role name of the intended assignee (e.g. "coder", "reviewer") */
  assignee?: string;
  /** Role name of the task creator */
  assigner?: string;
  /** Task type: regular task or code review */
  type?: "task" | "review";
  /** Review verdict */
  reviewStatus?: "pending" | "approved" | "changes_requested";
  /** Reviewer feedback text */
  reviewFeedback?: string;
  /** Git diff associated with the task */
  diff?: string;
  /** Revision iteration count (incremented on each review round-trip) */
  iteration?: number;
  /** ID of the task this review refers to */
  reviewOf?: string;
}

const LOCK_RETRIES = { retries: 5, minTimeout: 50 };

/**
 * Get the tasks directory path, creating it if needed.
 */
function ensureTasksDir(): string {
  const dir = getTasksDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Read a single task by ID.
 */
export function readTask(id: string): Task | undefined {
  const filePath = join(ensureTasksDir(), `${id}.json`);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Task;
  } catch {
    return undefined;
  }
}

/**
 * Read all tasks from the tasks directory.
 */
export function readAllTasks(): Task[] {
  const dir = ensureTasksDir();
  const tasks: Task[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return tasks;
  }
  for (const file of files) {
    try {
      const data = readFileSync(join(dir, file), "utf-8");
      tasks.push(JSON.parse(data) as Task);
    } catch {
      // skip corrupt files
    }
  }
  return tasks;
}

/**
 * Write a task to disk with file locking.
 */
export async function writeTask(task: Task): Promise<void> {
  const dir = ensureTasksDir();
  const filePath = join(dir, `${task.id}.json`);

  // Ensure the file exists for proper-lockfile (it locks existing files)
  if (!existsSync(filePath)) {
    writeFileSync(filePath, "{}");
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, { retries: LOCK_RETRIES });
    task.updatedAt = new Date().toISOString();
    writeFileSync(filePath, JSON.stringify(task, null, 2) + "\n");
  } finally {
    if (release) await release();
  }
}

/**
 * Returns true if the session has an active (assigned) task.
 */
export function hasActiveTask(sessionId: string): boolean {
  const all = readAllTasks();
  return all.some((t) => ["assigned", "in_progress", "blocked"].includes(t.status) && t.assignedTo === sessionId);
}

/**
 * Remove done/failed tasks older than maxAgeMs.
 */
export function cleanupTasks(maxAgeMs: number): void {
  const dir = ensureTasksDir();
  const now = Date.now();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const data = readFileSync(join(dir, file), "utf-8");
      const task = JSON.parse(data) as Task;
      if ((task.status === "done" || task.status === "failed") && now - new Date(task.updatedAt).getTime() > maxAgeMs) {
        unlinkSync(join(dir, file));
      }
    } catch {
      // skip
    }
  }
}

/**
 * List pending review tasks assigned to a given role.
 */
export function listPendingReviews(role: string): Task[] {
  return readAllTasks().filter(
    (t) => t.type === "review" && t.assignee === role && t.status === "pending" && t.reviewStatus === "pending",
  );
}

/**
 * List active tasks assigned to a given role (pending or assigned, not done/failed).
 */
export function listTasksForRole(role: string): Task[] {
  return readAllTasks().filter((t) => t.assignee === role && t.status !== "done" && t.status !== "failed");
}
