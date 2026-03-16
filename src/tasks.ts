import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import { getAimuxDir } from "./config.js";

export interface Task {
  id: string;
  status: "pending" | "assigned" | "done" | "failed";
  assignedBy: string;
  assignedTo?: string;
  tool?: string;
  description: string;
  prompt: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  notifiedAt?: string;
}

const LOCK_RETRIES = { retries: 5, minTimeout: 50 };

/**
 * Get the tasks directory path, creating it if needed.
 */
export function getTasksDir(cwd?: string): string {
  const dir = join(getAimuxDir(cwd), "tasks");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Read a single task by ID.
 */
export function readTask(id: string, cwd?: string): Task | undefined {
  const filePath = join(getTasksDir(cwd), `${id}.json`);
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
export function readAllTasks(cwd?: string): Task[] {
  const dir = getTasksDir(cwd);
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
export async function writeTask(task: Task, cwd?: string): Promise<void> {
  const dir = getTasksDir(cwd);
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
export function hasActiveTask(sessionId: string, cwd?: string): boolean {
  const all = readAllTasks(cwd);
  return all.some((t) => t.status === "assigned" && t.assignedTo === sessionId);
}

/**
 * Remove done/failed tasks older than maxAgeMs.
 */
export function cleanupTasks(maxAgeMs: number, cwd?: string): void {
  const dir = getTasksDir(cwd);
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
