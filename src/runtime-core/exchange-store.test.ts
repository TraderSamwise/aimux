import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeExchangeStore, emptyRuntimeExchange } from "./exchange-store.js";

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
            status: "pending",
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
});
