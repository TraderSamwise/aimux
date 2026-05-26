import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { createRuntimeExchangeStore } from "./runtime-core/exchange-store.js";

import { readTask, readAllTasks, writeTask, hasActiveTask, cleanupTasks, type Task } from "./tasks.js";

function makeTmpDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aimux-test-")));
  mkdirSync(join(dir, ".git"), { recursive: true });
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
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    await initPaths(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("writeTask + readTask", () => {
    it("writes and reads a task", async () => {
      const task = makeTask({ assignedTo: "codex-1" });
      await writeTask(task);

      const read = readTask("test-task-1");
      expect(read).toBeDefined();
      expect(read!.id).toBe("test-task-1");
      expect(read!.status).toBe("pending");
      expect(read!.description).toBe("Test task");
      expect(createRuntimeExchangeStore().read().waits).toMatchObject([
        { id: "wait:task:test-task-1", subjectKind: "task", subjectId: "test-task-1" },
      ]);
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
    it("reads all tasks from the runtime exchange", async () => {
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

    it("returns exchange tasks without scanning legacy task files", async () => {
      await writeTask(makeTask({ id: "good" }));
      mkdirSync(join(tmpDir, ".aimux", "tasks"), { recursive: true });

      expect(readAllTasks().map((task) => task.id)).toEqual(["good"]);
    });
  });

  describe("review indexes", () => {
    it("keeps review rows derived from review tasks", async () => {
      await writeTask(
        makeTask({
          id: "review-1",
          type: "review",
          reviewStatus: "request-changes",
          reviewFeedback: "Needs tests",
          reviewOf: "task-1",
        }),
      );

      expect(createRuntimeExchangeStore().read().reviews).toMatchObject([
        {
          id: "review:review-1",
          taskId: "review-1",
          reviewOf: "task-1",
          status: "changes_requested",
          feedback: "Needs tests",
        },
      ]);
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
      await writeTask(makeTask({ id: "old-done", status: "done" }));
      const oldDone = readTask("old-done")!;
      oldDone.updatedAt = oldDate;
      await writeTask(oldDone);
      oldDone.updatedAt = oldDate;
      await import("./runtime-core/exchange-store.js").then(({ createRuntimeExchangeStore }) => {
        createRuntimeExchangeStore().update((exchange) => ({
          ...exchange,
          tasks: exchange.tasks.map((task) => (task.id === "old-done" ? { ...task, updatedAt: oldDate } : task)),
        }));
      });

      await writeTask(makeTask({ id: "recent-done", status: "done" }));
      await writeTask(makeTask({ id: "pending", status: "pending" }));

      cleanupTasks(3600000); // 1 hour threshold

      const remaining = readAllTasks();
      expect(remaining.map((t) => t.id).sort()).toEqual(["pending", "recent-done"]);
    });

    it("keeps pending and assigned tasks regardless of age", async () => {
      const oldDate = new Date(Date.now() - 7200000).toISOString();
      await writeTask(makeTask({ id: "old-pending", status: "pending" }));
      await import("./runtime-core/exchange-store.js").then(({ createRuntimeExchangeStore }) => {
        createRuntimeExchangeStore().update((exchange) => ({
          ...exchange,
          tasks: exchange.tasks.map((task) => (task.id === "old-pending" ? { ...task, updatedAt: oldDate } : task)),
        }));
      });

      cleanupTasks(3600000);

      expect(readTask("old-pending")).toBeDefined();
    });
  });
});
