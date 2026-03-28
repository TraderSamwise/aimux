import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock paths module so tasks read/write to tmpDir
let tmpDir: string;
vi.mock("./paths.js", () => ({
  getTasksDir: () => join(tmpDir, "tasks"),
}));

import { readTask, readAllTasks, writeTask, hasActiveTask, cleanupTasks, type Task } from "./tasks.js";

function makeTmpDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aimux-test-")));
  mkdirSync(join(dir, "tasks"), { recursive: true });
  return dir;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-task-1",
    status: "pending",
    assignedBy: "claude-abc",
    description: "Test task",
    prompt: "Do something",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("tasks", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("writeTask + readTask", () => {
    it("writes and reads a task", async () => {
      const task = makeTask();
      await writeTask(task);

      const read = readTask("test-task-1");
      expect(read).toBeDefined();
      expect(read!.id).toBe("test-task-1");
      expect(read!.status).toBe("pending");
      expect(read!.description).toBe("Test task");
    });

    it("returns undefined for non-existent task", () => {
      const read = readTask("nonexistent");
      expect(read).toBeUndefined();
    });

    it("updates updatedAt on write", async () => {
      const task = makeTask({ updatedAt: "2020-01-01T00:00:00Z" });
      await writeTask(task);

      const read = readTask("test-task-1");
      expect(read!.updatedAt).not.toBe("2020-01-01T00:00:00Z");
    });
  });

  describe("readAllTasks", () => {
    it("reads all tasks from directory", async () => {
      await writeTask(makeTask({ id: "task-a" }));
      await writeTask(makeTask({ id: "task-b" }));
      await writeTask(makeTask({ id: "task-c" }));

      const all = readAllTasks();
      expect(all).toHaveLength(3);
      expect(all.map((t) => t.id).sort()).toEqual(["task-a", "task-b", "task-c"]);
    });

    it("returns empty array for empty directory", () => {
      const all = readAllTasks();
      expect(all).toEqual([]);
    });

    it("skips corrupt files", async () => {
      await writeTask(makeTask({ id: "good" }));
      writeFileSync(join(tmpDir, "tasks", "bad.json"), "not json{{{");

      const all = readAllTasks();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("good");
    });
  });

  describe("hasActiveTask", () => {
    it("returns true when session has assigned task", async () => {
      await writeTask(makeTask({ id: "t1", status: "assigned", assignedTo: "claude-xyz" }));

      expect(hasActiveTask("claude-xyz")).toBe(true);
    });

    it("returns false when session has no assigned tasks", async () => {
      await writeTask(makeTask({ id: "t1", status: "pending" }));

      expect(hasActiveTask("claude-xyz")).toBe(false);
    });

    it("returns false for empty tasks directory", () => {
      expect(hasActiveTask("claude-xyz")).toBe(false);
    });
  });

  describe("cleanupTasks", () => {
    it("removes old done/failed tasks", async () => {
      const oldDate = new Date(Date.now() - 7200000).toISOString(); // 2 hours ago
      await writeTask(makeTask({ id: "old-done", status: "done", updatedAt: oldDate }));
      // Force the updatedAt back (writeTask overwrites it)
      const taskPath = join(tmpDir, "tasks", "old-done.json");
      const data = JSON.parse(readFileSync(taskPath, "utf-8"));
      data.updatedAt = oldDate;
      writeFileSync(taskPath, JSON.stringify(data));

      await writeTask(makeTask({ id: "recent-done", status: "done" }));
      await writeTask(makeTask({ id: "pending", status: "pending" }));

      cleanupTasks(3600000); // 1 hour threshold

      const remaining = readAllTasks();
      expect(remaining.map((t) => t.id).sort()).toEqual(["pending", "recent-done"]);
    });

    it("keeps pending and assigned tasks regardless of age", async () => {
      const oldDate = new Date(Date.now() - 7200000).toISOString();
      await writeTask(makeTask({ id: "old-pending", status: "pending" }));
      const taskPath = join(tmpDir, "tasks", "old-pending.json");
      const data = JSON.parse(readFileSync(taskPath, "utf-8"));
      data.updatedAt = oldDate;
      writeFileSync(taskPath, JSON.stringify(data));

      cleanupTasks(3600000);

      expect(readTask("old-pending")).toBeDefined();
    });
  });
});
