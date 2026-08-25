import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RuntimeExchangeStore,
  emptyRuntimeExchange,
  getExchangeStoreStats,
  resetExchangeStoreStats,
} from "./exchange-store.js";
import { RUNTIME_EXCHANGE_RETENTION, compactRuntimeExchange } from "./exchange-retention.js";

describe("RuntimeExchangeStore", () => {
  it("round-trips the runtime exchange YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const store = new RuntimeExchangeStore(join(dir, "runtime-exchange.yaml"));
      const now = "2026-05-25T00:00:00.000Z";
      store.write({
        ...emptyRuntimeExchange(now),
        threads: [
          {
            id: "thread-1",
            title: "Task: wire exchange",
            kind: "task",
            status: "waiting",
            createdAt: now,
            updatedAt: now,
            createdBy: "user",
            participants: ["user", "codex-1"],
            owner: "codex-1",
            waitingOn: ["codex-1"],
            taskId: "task-1",
            unreadBy: ["codex-1"],
          },
        ],
        messages: [
          {
            id: "msg-1",
            threadId: "thread-1",
            ts: now,
            from: "user",
            to: ["codex-1"],
            kind: "request",
            body: "Please wire exchange.",
            taskId: "task-1",
            metadata: { priority: 1, review: false, note: "schema" },
          },
        ],
        tasks: [
          {
            id: "task-1",
            status: "pending",
            assignedBy: "user",
            assignedTo: "codex-1",
            threadId: "thread-1",
            description: "Wire exchange",
            prompt: "Please wire exchange.",
            createdAt: now,
            updatedAt: now,
            type: "task",
          },
        ],
        handoffs: [
          {
            id: "handoff-1",
            threadId: "thread-1",
            status: "waiting",
            from: "user",
            to: ["codex-1"],
            createdAt: now,
            updatedAt: now,
          },
        ],
        reviews: [
          {
            id: "review-1",
            taskId: "task-1",
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
        ],
        waits: [
          {
            id: "wait-1",
            status: "waiting",
            subjectKind: "thread",
            subjectId: "thread-1",
            waitingOn: ["codex-1"],
            createdAt: now,
            updatedAt: now,
          },
        ],
        inbox: [
          {
            id: "inbox-1",
            participantId: "codex-1",
            subjectKind: "thread",
            subjectId: "thread-1",
            state: "waiting",
            urgency: 10,
            updatedAt: now,
          },
        ],
        planRefs: [
          {
            id: "plan-1",
            path: "/repo/.aimux/plans/task.md",
            threadId: "thread-1",
            taskId: "task-1",
            title: "Task plan",
            createdAt: now,
            updatedAt: now,
          },
        ],
        continuityRefs: [
          {
            id: "history-1",
            kind: "history",
            path: "/repo/.aimux/history/codex-1.jsonl",
            threadId: "thread-1",
            createdAt: now,
            updatedAt: now,
          },
        ],
        attachmentRefs: [
          {
            id: "attachment-1",
            path: "/repo/.aimux/attachments/attachment-1.json",
            contentUrl: "/attachments/attachment-1/content",
            threadId: "thread-1",
            messageId: "msg-1",
            mediaType: "text/plain",
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

      expect(store.read()).toMatchObject({
        version: 1,
        threads: [{ id: "thread-1", kind: "task", waitingOn: ["codex-1"] }],
        messages: [{ id: "msg-1", threadId: "thread-1", metadata: { priority: 1 } }],
        tasks: [{ id: "task-1", threadId: "thread-1" }],
        handoffs: [{ id: "handoff-1", threadId: "thread-1" }],
        reviews: [{ id: "review-1", taskId: "task-1" }],
        waits: [{ id: "wait-1", subjectKind: "thread", subjectId: "thread-1" }],
        inbox: [{ id: "inbox-1", state: "waiting", urgency: 10 }],
        planRefs: [{ id: "plan-1", taskId: "task-1" }],
        continuityRefs: [{ id: "history-1", kind: "history" }],
        attachmentRefs: [{ id: "attachment-1", messageId: "msg-1" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The read cache stores a normalized exchange and clones it per read. If a later
  // optimization returns shared cached state, a caller mutating it would poison every
  // later read process-wide. This is the test that keeps the invariant explicit.
  it("never lets a caller's mutation leak into a later read", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const store = new RuntimeExchangeStore(path);
      const now = "2026-05-25T00:00:00.000Z";
      store.write({
        ...emptyRuntimeExchange(now),
        threads: [
          {
            id: "thread-1",
            title: "Thread",
            kind: "task",
            status: "open",
            createdAt: now,
            updatedAt: now,
            createdBy: "user",
            participants: ["user", "codex-1"],
            waitingOn: ["codex-1"],
            unreadBy: ["codex-1"],
          },
        ],
        messages: [
          {
            id: "msg-1",
            threadId: "thread-1",
            ts: now,
            from: "user",
            to: ["codex-1"],
            kind: "request",
            body: "hello",
            metadata: { attempt: 1 },
            deliveredTo: ["codex-1"],
          },
        ],
        // Every record type is seeded: a passthrough added to any one of them must
        // trip this, not just the three the dashboard path happens to read.
        tasks: [
          {
            id: "task-1",
            status: "pending",
            assignedBy: "user",
            assignedTo: "codex-1",
            threadId: "thread-1",
            description: "d",
            prompt: "p",
            createdAt: now,
            updatedAt: now,
          },
        ],
        handoffs: [
          {
            id: "handoff-1",
            threadId: "thread-1",
            status: "waiting",
            from: "user",
            to: ["codex-1"],
            createdAt: now,
            updatedAt: now,
          },
        ],
        reviews: [{ id: "review-1", taskId: "task-1", status: "pending", createdAt: now, updatedAt: now }],
        waits: [
          {
            id: "wait-1",
            status: "waiting",
            subjectKind: "thread",
            subjectId: "thread-1",
            waitingOn: ["codex-1"],
            createdAt: now,
            updatedAt: now,
          },
        ],
        planRefs: [
          { id: "plan-1", path: "/p.md", threadId: "thread-1", taskId: "task-1", createdAt: now, updatedAt: now },
        ],
        continuityRefs: [
          { id: "hist-1", kind: "history", path: "/h.jsonl", threadId: "thread-1", createdAt: now, updatedAt: now },
        ],
        attachmentRefs: [
          { id: "att-1", path: "/a.json", threadId: "thread-1", messageId: "msg-1", createdAt: now, updatedAt: now },
        ],
      });

      // Deep-copied on purpose: if a passthrough field aliased the cache, this handle
      // would be poisoned by the mutations below too, and the comparison would pass
      // while both sides were corrupt.
      const pristine = structuredClone(store.read());
      const mutated = store.read();
      mutated.threads.push({ ...mutated.threads[0], id: "injected" });
      mutated.threads[0].participants.push("injected");
      mutated.threads[0].title = "clobbered";
      mutated.threads[0].waitingOn?.push("injected");
      mutated.messages[0].to?.push("injected");
      mutated.messages[0].body = "clobbered";
      if (mutated.messages[0].metadata) mutated.messages[0].metadata.attempt = 99;
      mutated.tasks[0].description = "clobbered";
      mutated.handoffs[0].to.push("injected");
      mutated.reviews[0].status = "approved";
      mutated.waits[0].waitingOn.push("injected");
      mutated.planRefs[0].path = "/clobbered";
      mutated.continuityRefs[0].path = "/clobbered";
      mutated.attachmentRefs[0].path = "/clobbered";
      mutated.inbox.push({
        id: "injected",
        participantId: "user",
        subjectKind: "thread",
        subjectId: "thread-1",
        state: "unread",
        urgency: 1,
        updatedAt: now,
      });

      expect(store.read()).toEqual(pristine);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses the normalized exchange graph across unchanged reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const store = new RuntimeExchangeStore(path);
      const now = "2026-05-25T00:00:00.000Z";
      store.write({
        ...emptyRuntimeExchange(now),
        threads: Array.from({ length: 100 }, (_, index) => ({
          id: `thread-${index}`,
          title: `Thread ${index}`,
          kind: "task",
          status: "open",
          createdAt: now,
          updatedAt: now,
          createdBy: "user",
          participants: ["user", "codex-1"],
          waitingOn: ["codex-1"],
          unreadBy: ["codex-1"],
        })),
        messages: Array.from({ length: 100 }, (_, index) => ({
          id: `msg-${index}`,
          threadId: `thread-${index}`,
          ts: now,
          from: "user",
          to: ["codex-1"],
          kind: "request",
          body: `message ${index}`,
          metadata: { index },
        })),
      });

      resetExchangeStoreStats();
      expect(store.read().threads).toHaveLength(100);
      expect(store.read().messages).toHaveLength(100);

      expect(getExchangeStoreStats()).toEqual({ reads: 2, parses: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves a rewritten file rather than a cached parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const store = new RuntimeExchangeStore(path);
      const now = "2026-05-25T00:00:00.000Z";
      const thread = {
        id: "thread-1",
        title: "Thread",
        kind: "task" as const,
        status: "open" as const,
        createdAt: now,
        updatedAt: now,
        createdBy: "user",
        participants: ["user"],
      };
      store.write({ ...emptyRuntimeExchange(now), threads: [thread] });
      expect(store.read().threads[0].title).toBe("Thread");

      // Written outside the store, mimicking another process, and byte-length identical
      // so neither a size-based nor a stat-based cache key would notice the change.
      const before = readFileSync(path, "utf-8");
      const after = before.replace("title: Thread", "title: Thredz");
      expect(after).not.toBe(before);
      expect(after.length).toBe(before.length);
      writeFileSync(path, after);
      expect(store.read().threads[0].title).toBe("Thredz");

      // Deleting must not leave the previous parse reachable.
      rmSync(path, { force: true });
      expect(store.read().threads).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacts automatically before writing runtime exchange YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const store = new RuntimeExchangeStore(path);
      const now = "2026-05-25T00:00:00.000Z";
      store.write({
        ...emptyRuntimeExchange(now),
        threads: Array.from({ length: RUNTIME_EXCHANGE_RETENTION.closedWorkflowThreads + 1 }, (_, index) => ({
          id: `thread-${index}`,
          title: `Thread ${index}`,
          kind: "task",
          status: "done",
          createdAt: now,
          updatedAt: `2026-05-25T00:${String(index).padStart(2, "0")}:00.000Z`,
          createdBy: "user",
          participants: ["user", "codex-1"],
        })),
      });

      expect(store.read().threads).toHaveLength(RUNTIME_EXCHANGE_RETENTION.closedWorkflowThreads);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt exchange YAML instead of silently resetting exchange truth", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      writeFileSync(path, "version: nope\n");
      expect(() => new RuntimeExchangeStore(path).read()).toThrow("unsupported runtime exchange version");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes update with a filesystem lock and releases it after writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const store = new RuntimeExchangeStore(path);

      store.update((exchange) => ({
        ...exchange,
        threads: [
          {
            id: "thread-1",
            title: "Thread",
            kind: "conversation",
            status: "open",
            createdAt: exchange.generatedAt,
            updatedAt: exchange.generatedAt,
            createdBy: "user",
            participants: ["user"],
          },
        ],
      }));

      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(store.read().threads.map((thread) => thread.id)).toEqual(["thread-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers a stale update lock owned by a dead process", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const lockPath = `${path}.lock`;
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(join(lockPath, "owner"), "999999\n");

      const store = new RuntimeExchangeStore(path);
      store.update((exchange) => exchange);

      expect(existsSync(lockPath)).toBe(false);
      expect(store.read()).toMatchObject({ version: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers an aged update lock without an owner file before timing out", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const lockPath = `${path}.lock`;
      mkdirSync(lockPath, { recursive: true });
      const staleTime = new Date(Date.now() - 5_000);
      utimesSync(lockPath, staleTime, staleTime);

      const store = new RuntimeExchangeStore(path);
      store.update((exchange) => exchange);

      expect(existsSync(lockPath)).toBe(false);
      expect(store.read()).toMatchObject({ version: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not recover an aged update lock while its owner process is alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const lockPath = `${path}.lock`;
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
      const staleTime = new Date(Date.now() - 10_000);
      utimesSync(lockPath, staleTime, staleTime);

      const store = new RuntimeExchangeStore(path) as unknown as {
        recoverStaleUpdateLock(lockPath: string): boolean;
      };

      expect(store.recoverStaleUpdateLock(lockPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes records that reference missing exchange subjects", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const store = new RuntimeExchangeStore(path);
      const now = "2026-05-25T00:00:00.000Z";

      store.write({
        ...emptyRuntimeExchange(now),
        threads: [
          {
            id: "thread-keep",
            title: "Keep",
            kind: "task",
            status: "open",
            createdAt: now,
            updatedAt: now,
            createdBy: "user",
            participants: ["user"],
          },
        ],
        messages: [
          {
            id: "msg-keep",
            threadId: "thread-keep",
            ts: now,
            from: "user",
            kind: "note",
            body: "keep",
          },
          {
            id: "msg-drop",
            threadId: "thread-drop",
            ts: now,
            from: "user",
            kind: "note",
            body: "drop",
          },
        ],
        tasks: [
          {
            id: "task-keep",
            status: "pending",
            assignedBy: "user",
            threadId: "thread-keep",
            description: "keep",
            prompt: "keep",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "task-drop",
            status: "done",
            assignedBy: "user",
            threadId: "thread-drop",
            description: "drop",
            prompt: "drop",
            createdAt: now,
            updatedAt: now,
          },
        ],
        handoffs: [
          {
            id: "handoff-drop",
            threadId: "thread-drop",
            status: "waiting",
            from: "user",
            to: ["codex-1"],
            createdAt: now,
            updatedAt: now,
          },
        ],
        reviews: [
          {
            id: "review-keep",
            taskId: "task-keep",
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "review-drop",
            taskId: "task-drop",
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
        ],
        waits: [
          {
            id: "wait-keep",
            status: "waiting",
            subjectKind: "task",
            subjectId: "task-keep",
            waitingOn: ["codex-1"],
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "wait-drop",
            status: "waiting",
            subjectKind: "task",
            subjectId: "task-drop",
            waitingOn: ["codex-1"],
            createdAt: now,
            updatedAt: now,
          },
        ],
        inbox: [
          {
            id: "inbox-keep",
            participantId: "codex-1",
            subjectKind: "message",
            subjectId: "msg-keep",
            state: "unread",
            urgency: 1,
            updatedAt: now,
          },
          {
            id: "inbox-drop",
            participantId: "codex-1",
            subjectKind: "message",
            subjectId: "msg-drop",
            state: "unread",
            urgency: 1,
            updatedAt: now,
          },
        ],
        planRefs: [
          { id: "plan-keep", path: "/plan.md", taskId: "task-keep", createdAt: now, updatedAt: now },
          { id: "plan-drop", path: "/drop.md", taskId: "task-drop", createdAt: now, updatedAt: now },
        ],
        continuityRefs: [
          {
            id: "context-keep",
            kind: "context",
            path: "/context.md",
            threadId: "thread-keep",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "context-drop",
            kind: "context",
            path: "/drop.md",
            threadId: "thread-drop",
            createdAt: now,
            updatedAt: now,
          },
        ],
        attachmentRefs: [
          { id: "attachment-keep", path: "/a", messageId: "msg-keep", createdAt: now, updatedAt: now },
          { id: "attachment-drop", path: "/b", messageId: "msg-drop", createdAt: now, updatedAt: now },
        ],
      });

      const exchange = store.read();
      expect(exchange.messages.map((message) => message.id)).toEqual(["msg-keep"]);
      expect(exchange.tasks.map((task) => task.id)).toEqual(["task-keep"]);
      expect(exchange.handoffs).toEqual([]);
      expect(exchange.reviews.map((review) => review.id)).toEqual(["review-keep"]);
      expect(exchange.waits.map((wait) => wait.id)).toEqual(["wait-keep"]);
      expect(exchange.inbox.map((entry) => entry.id)).toEqual(["inbox-keep"]);
      expect(exchange.planRefs.map((ref) => ref.id)).toEqual(["plan-keep"]);
      expect(exchange.continuityRefs.map((ref) => ref.id)).toEqual(["context-keep"]);
      expect(exchange.attachmentRefs.map((ref) => ref.id)).toEqual(["attachment-keep"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacts closed exchange history while preserving active workflow state", () => {
    const now = "2026-05-25T00:00:00.000Z";
    const old = "2026-05-01T00:00:00.000Z";
    const activeThread = {
      id: "thread-active",
      title: "Active",
      kind: "task" as const,
      status: "waiting" as const,
      createdAt: old,
      updatedAt: now,
      createdBy: "user",
      participants: ["user", "codex-1"],
      waitingOn: ["codex-1"],
      unreadBy: ["codex-1"],
      taskId: "task-active",
      lastMessageId: "active-old",
    };
    const oldClosedThreads = Array.from(
      { length: RUNTIME_EXCHANGE_RETENTION.closedWorkflowThreads + 5 },
      (_, index) => ({
        id: `thread-closed-${index}`,
        title: `Closed ${index}`,
        kind: "task" as const,
        status: "done" as const,
        createdAt: old,
        updatedAt: `2026-05-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        createdBy: "user",
        participants: ["user", "codex-1"],
        taskId: `task-closed-${index}`,
      }),
    );
    const activeMessages = Array.from({ length: RUNTIME_EXCHANGE_RETENTION.activeThreadMessages + 10 }, (_, index) => ({
      id: `active-${index}`,
      threadId: "thread-active",
      ts: `2026-05-25T00:${String(index).padStart(2, "0")}:00.000Z`,
      from: index % 2 === 0 ? "user" : "codex-1",
      kind: "reply" as const,
      body: `active message ${index}`,
    }));
    const closedMessages = oldClosedThreads.map((thread, index) => ({
      id: `closed-message-${index}`,
      threadId: thread.id,
      ts: thread.updatedAt,
      from: "codex-1",
      kind: "reply" as const,
      body: `closed message ${index}`,
    }));

    const report = compactRuntimeExchange({
      ...emptyRuntimeExchange(now),
      threads: [activeThread, ...oldClosedThreads],
      messages: [...activeMessages, ...closedMessages],
      tasks: [
        {
          id: "task-active",
          status: "in_progress",
          assignedBy: "user",
          assignedTo: "codex-1",
          threadId: "thread-active",
          description: "Active task",
          prompt: "Do active task",
          createdAt: old,
          updatedAt: now,
        },
        ...oldClosedThreads.map((thread, index) => ({
          id: `task-closed-${index}`,
          status: "done" as const,
          assignedBy: "user",
          assignedTo: "codex-1",
          threadId: thread.id,
          description: `Closed task ${index}`,
          prompt: `Do closed task ${index}`,
          createdAt: old,
          updatedAt: thread.updatedAt,
        })),
      ],
      waits: [
        {
          id: "wait-active",
          status: "waiting",
          subjectKind: "thread",
          subjectId: "thread-active",
          waitingOn: ["codex-1"],
          createdAt: old,
          updatedAt: now,
        },
        {
          id: "wait-pruned",
          status: "satisfied",
          subjectKind: "thread",
          subjectId: "thread-closed-0",
          waitingOn: ["codex-1"],
          createdAt: old,
          updatedAt: old,
        },
      ],
      attachmentRefs: [
        { id: "attachment-active", path: "/active", messageId: "active-309", createdAt: now, updatedAt: now },
        { id: "attachment-pruned", path: "/pruned", messageId: "active-0", createdAt: old, updatedAt: old },
      ],
    });

    expect(report.changed).toBe(true);
    expect(report.retained.threads.some((thread) => thread.id === "thread-active")).toBe(true);
    expect(report.retained.tasks.some((task) => task.id === "task-active")).toBe(true);
    expect(report.retained.threads.filter((thread) => thread.id.startsWith("thread-closed-"))).toHaveLength(
      RUNTIME_EXCHANGE_RETENTION.closedWorkflowThreads,
    );
    expect(report.retained.messages.filter((message) => message.threadId === "thread-active")).toHaveLength(
      RUNTIME_EXCHANGE_RETENTION.activeThreadMessages,
    );
    expect(report.retained.messages.some((message) => message.id === "active-0")).toBe(false);
    expect(report.retained.messages.some((message) => message.id === "active-309")).toBe(true);
    expect(report.retained.waits.map((wait) => wait.id)).toEqual(["wait-active"]);
    expect(report.retained.attachmentRefs.map((ref) => ref.id)).toEqual(["attachment-active"]);
  });

  it("keeps only bounded latest notification threads and their latest messages", () => {
    const now = "2026-05-25T00:00:00.000Z";
    const notificationThreads = Array.from(
      { length: RUNTIME_EXCHANGE_RETENTION.notificationThreads + 3 },
      (_, index) => ({
        id: `notification-${index}`,
        title: `Notification ${index}`,
        kind: "conversation" as const,
        status: "open" as const,
        createdAt: `2026-05-25T00:${String(index).padStart(2, "0")}:00.000Z`,
        updatedAt: `2026-05-25T00:${String(index).padStart(2, "0")}:00.000Z`,
        createdBy: "aimux",
        participants: ["aimux", "project"],
        tags: ["notification"],
        lastMessageId: `notification-message-${index}-1`,
      }),
    );
    const report = compactRuntimeExchange({
      ...emptyRuntimeExchange(now),
      threads: notificationThreads,
      messages: notificationThreads.flatMap((thread, index) => [
        {
          id: `notification-message-${index}-0`,
          threadId: thread.id,
          ts: thread.createdAt,
          from: "aimux",
          kind: "note" as const,
          body: "older",
        },
        {
          id: `notification-message-${index}-1`,
          threadId: thread.id,
          ts: thread.updatedAt,
          from: "aimux",
          kind: "note" as const,
          body: "latest",
        },
      ]),
    });

    expect(report.retained.threads).toHaveLength(RUNTIME_EXCHANGE_RETENTION.notificationThreads);
    expect(report.retained.messages).toHaveLength(RUNTIME_EXCHANGE_RETENTION.notificationThreads);
    expect(report.retained.threads.some((thread) => thread.id === "notification-0")).toBe(false);
    expect(report.retained.threads.some((thread) => thread.id === "notification-502")).toBe(true);
    expect(report.retained.messages.every((message) => message.id.endsWith("-1"))).toBe(true);
  });

  it("preserves active tasks that reference a missing thread by clearing the dangling thread id", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-"));
    try {
      const path = join(dir, "runtime-exchange.yaml");
      const store = new RuntimeExchangeStore(path);
      const now = "2026-05-25T00:00:00.000Z";

      store.write({
        ...emptyRuntimeExchange(now),
        tasks: [
          {
            id: "task-active",
            status: "in_progress",
            assignedBy: "user",
            assignedTo: "codex-1",
            threadId: "thread-missing",
            description: "keep active",
            prompt: "keep active",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "task-done",
            status: "done",
            assignedBy: "user",
            assignedTo: "codex-1",
            threadId: "thread-missing",
            description: "drop done",
            prompt: "drop done",
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

      expect(store.read().tasks).toEqual([
        expect.objectContaining({ id: "task-active", status: "in_progress", threadId: undefined }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
