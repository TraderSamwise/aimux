import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock paths module so tasks read/write to tmpDir
let tmpDir: string;
vi.mock("./paths.js", () => ({
  getTasksDir: () => join(tmpDir, "tasks"),
  getThreadsDir: () => join(tmpDir, "threads"),
  getLocalAimuxDir: () => join(tmpDir, ".aimux"),
}));

import { TaskDispatcher } from "./task-dispatcher.js";
import { writeTask, readTask, type Task } from "./tasks.js";
import { readMessages } from "./threads.js";

function makeTmpDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aimux-test-")));
  mkdirSync(join(dir, "tasks"), { recursive: true });
  mkdirSync(join(dir, "threads"), { recursive: true });
  return dir;
}

/** Wait for fire-and-forget async writeTask calls from tick() to settle */
const flush = () => new Promise((r) => setTimeout(r, 100));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    status: "pending",
    assignedBy: "claude-leader",
    description: "Test task",
    prompt: "Do something",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockSession(id: string, status: string, exited = false) {
  const written: string[] = [];
  return {
    id,
    command: "claude",
    status,
    exited,
    write: (data: string) => written.push(data),
    written,
    backendSessionId: undefined as string | undefined,
    getScreenState: () => "",
    kill: () => {},
    destroy: () => {},
    resize: () => {},
    onData: () => {},
    onExit: () => {},
    get exitCode() {
      return undefined;
    },
  };
}

function availabilityFor(session: ReturnType<typeof makeMockSession> | undefined) {
  if (!session || session.exited) return "offline";
  return session.status === "idle" ? "available" : "busy";
}

describe("TaskDispatcher", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(async () => {
    await flush(); // let pending writes settle before cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("tick - dispatch pending tasks", () => {
    it("injects pending task into idle session", async () => {
      const session = makeMockSession("claude-worker", "idle");
      const dispatcher = new TaskDispatcher(
        (id) => (id === "claude-worker" ? (session as any) : undefined),
        () => "claude",
        () => undefined,
        (id) => availabilityFor(id === "claude-worker" ? session : undefined),
      );

      await writeTask(makeTask({ id: "t1", assignedBy: "claude-leader" }));
      dispatcher.tick(["claude-worker"]);
      await flush();

      expect(session.written.length).toBe(1);
      expect(session.written[0]).toContain("[AIMUX TASK t1");

      const task = readTask("t1");
      expect(task?.status).toBe("assigned");
      expect(task?.assignedTo).toBe("claude-worker");
      expect(task?.threadId).toBeDefined();
      const messages = readMessages(task?.threadId ?? "");
      expect(messages[0]?.deliveredTo).toContain("claude-worker");
    });

    it("does not inject into busy session", async () => {
      const session = makeMockSession("claude-worker", "running");
      const dispatcher = new TaskDispatcher(
        (id) => (id === "claude-worker" ? (session as any) : undefined),
        () => "claude",
        () => undefined,
        (id) => availabilityFor(id === "claude-worker" ? session : undefined),
      );

      await writeTask(makeTask({ id: "t1" }));
      dispatcher.tick(["claude-worker"]);
      await flush();

      expect(session.written.length).toBe(0);
      expect(readTask("t1")?.status).toBe("pending");
    });

    it("does not inject task into assigner (no self-delegation)", async () => {
      const session = makeMockSession("claude-leader", "idle");
      const dispatcher = new TaskDispatcher(
        (id) => (id === "claude-leader" ? (session as any) : undefined),
        () => "claude",
        () => undefined,
        (id) => availabilityFor(id === "claude-leader" ? session : undefined),
      );

      await writeTask(makeTask({ id: "t1", assignedBy: "claude-leader" }));
      dispatcher.tick(["claude-leader"]);
      await flush();

      expect(session.written.length).toBe(0);
    });

    it("respects assignedTo targeting", async () => {
      const worker1 = makeMockSession("worker-1", "idle");
      const worker2 = makeMockSession("worker-2", "idle");
      const sessions = new Map([
        ["worker-1", worker1],
        ["worker-2", worker2],
      ]);
      const dispatcher = new TaskDispatcher(
        (id) => sessions.get(id) as any,
        () => "claude",
        () => undefined,
        (id) => availabilityFor(sessions.get(id)),
      );

      await writeTask(makeTask({ id: "t1", assignedBy: "leader", assignedTo: "worker-2" }));
      dispatcher.tick(["worker-1", "worker-2"]);
      await flush();

      expect(worker1.written.length).toBe(0);
      expect(worker2.written.length).toBe(1);
    });

    it("does not double-dispatch to session with active task", async () => {
      const session = makeMockSession("claude-worker", "idle");
      const dispatcher = new TaskDispatcher(
        (id) => (id === "claude-worker" ? (session as any) : undefined),
        () => "claude",
        () => undefined,
        (id) => availabilityFor(id === "claude-worker" ? session : undefined),
      );

      await writeTask(makeTask({ id: "t1", assignedBy: "leader", status: "assigned", assignedTo: "claude-worker" }));
      await writeTask(makeTask({ id: "t2", assignedBy: "leader" }));
      dispatcher.tick(["claude-worker"]);
      await flush();

      expect(session.written.length).toBe(0);
    });
  });

  describe("tick - notify assigners", () => {
    it("notifies assigner when task completes", async () => {
      const leader = makeMockSession("claude-leader", "idle");
      const dispatcher = new TaskDispatcher(
        (id) => (id === "claude-leader" ? (leader as any) : undefined),
        () => "claude",
        () => undefined,
        (id) => availabilityFor(id === "claude-leader" ? leader : undefined),
      );

      await writeTask(
        makeTask({
          id: "t1",
          assignedBy: "claude-leader",
          assignedTo: "claude-worker",
          status: "done",
          result: "All tests pass",
        }),
      );
      dispatcher.tick(["claude-leader"]);
      await flush();

      expect(leader.written.length).toBe(1);
      expect(leader.written[0]).toContain("[AIMUX TASK COMPLETE t1]");
      expect(leader.written[0]).toContain("All tests pass");

      const task = readTask("t1");
      expect(task?.notifiedAt).toBeDefined();
    });

    it("does not re-notify already notified tasks", async () => {
      const leader = makeMockSession("claude-leader", "idle");
      const dispatcher = new TaskDispatcher(
        (id) => (id === "claude-leader" ? (leader as any) : undefined),
        () => "claude",
        () => undefined,
        (id) => availabilityFor(id === "claude-leader" ? leader : undefined),
      );

      await writeTask(
        makeTask({
          id: "t1",
          assignedBy: "claude-leader",
          status: "done",
          result: "Done",
          notifiedAt: new Date().toISOString(),
        }),
      );
      dispatcher.tick(["claude-leader"]);
      await flush();

      expect(leader.written.length).toBe(0);
    });
  });

  describe("tick - orphan detection", () => {
    it("marks task as failed when assigned session exits", async () => {
      const session = makeMockSession("claude-worker", "exited", true);
      const dispatcher = new TaskDispatcher(
        (id) => (id === "claude-worker" ? (session as any) : undefined),
        () => "claude",
        () => undefined,
        (id) => availabilityFor(id === "claude-worker" ? session : undefined),
      );

      await writeTask(makeTask({ id: "t1", assignedBy: "leader", status: "assigned", assignedTo: "claude-worker" }));
      dispatcher.tick(["claude-worker"]);
      await flush();

      const task = readTask("t1");
      expect(task?.status).toBe("failed");
      expect(task?.error).toContain("exited");
    });
  });

  describe("getTaskCounts", () => {
    it("returns cached counts from last tick", async () => {
      const dispatcher = new TaskDispatcher(
        () => undefined,
        () => "claude",
        () => undefined,
        () => "offline",
      );

      await writeTask(makeTask({ id: "t1", status: "pending" }));
      await writeTask(makeTask({ id: "t2", status: "pending" }));
      await writeTask(makeTask({ id: "t3", status: "assigned", assignedTo: "x" }));

      dispatcher.tick([]);
      await flush();

      const counts = dispatcher.getTaskCounts();
      expect(counts.pending).toBe(2);
      expect(counts.assigned).toBe(1);
    });
  });

  describe("drainEvents", () => {
    it("returns events and clears queue", async () => {
      const session = makeMockSession("claude-worker", "idle");
      const dispatcher = new TaskDispatcher(
        (id) => (id === "claude-worker" ? (session as any) : undefined),
        () => "claude",
        () => undefined,
        (id) => availabilityFor(id === "claude-worker" ? session : undefined),
      );

      await writeTask(makeTask({ id: "t1", assignedBy: "leader" }));
      dispatcher.tick(["claude-worker"]);
      await flush();

      const events = dispatcher.drainEvents();
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("assigned");
      expect(events[0].sessionId).toBe("claude-worker");

      expect(dispatcher.drainEvents().length).toBe(0);
    });
  });
});
