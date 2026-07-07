import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAttachmentsDir,
  getContextDir,
  getHistoryDir,
  getPlansDir,
  getRecordingsDir,
  getStatusDir,
  getLegacyTasksDir,
  getLegacyThreadsDir,
  initPaths,
} from "../paths.js";
import type { Task } from "../tasks.js";
import type { OrchestrationMessage, OrchestrationThread } from "../threads.js";
import { buildRuntimeExchangeFromLegacySnapshot, importRuntimeExchangeFromLegacyFiles } from "./exchange-import.js";
import { RuntimeExchangeStore } from "./exchange-store.js";

describe("runtime exchange legacy import helpers", () => {
  const now = "2026-05-25T00:00:00.000Z";
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-exchange-import-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("converts legacy thread, message, task, handoff, review, wait, and inbox shapes", () => {
    const thread: OrchestrationThread = {
      id: "thread-1",
      title: "Task",
      kind: "handoff",
      status: "waiting",
      createdAt: now,
      updatedAt: now,
      createdBy: "user",
      participants: ["user", "codex-1"],
      owner: "user",
      waitingOn: ["codex-1"],
      taskId: "task-1",
      unreadBy: ["codex-1"],
    };
    const message: OrchestrationMessage = {
      id: "msg-1",
      threadId: "thread-1",
      ts: now,
      from: "user",
      to: ["codex-1"],
      kind: "handoff",
      body: "Take this.",
      taskId: "task-1",
    };
    const task: Task = {
      id: "task-1",
      status: "pending",
      assignedBy: "user",
      assignedTo: "codex-1",
      threadId: "thread-1",
      description: "Review changes",
      prompt: "Review changes",
      createdAt: now,
      updatedAt: now,
      type: "review",
      reviewStatus: "request-changes",
      reviewFeedback: "Needs tests",
      reviewOf: "task-root",
    };

    const exchange = buildRuntimeExchangeFromLegacySnapshot({
      now,
      threads: [thread],
      messages: [message],
      tasks: [task],
      planPaths: [join(repoRoot, ".aimux", "plans", "codex-1.md")],
      historyPaths: [join(repoRoot, ".aimux", "history", "codex-1.jsonl")],
      contextPaths: [join(repoRoot, ".aimux", "context", "codex-1", "live.md")],
      recordingPaths: ["C:\\repo\\.aimux\\recordings\\codex-1.txt"],
      statusPaths: [join(repoRoot, ".aimux", "status", "codex-1.md")],
      attachments: [
        {
          id: "attachment-1",
          kind: "image",
          filename: "image.png",
          mimeType: "image/png",
          sizeBytes: 10,
          sha256: "abc",
          createdAt: now,
          source: "path",
          contentPath: join(repoRoot, ".aimux", "attachments", "image.png"),
        },
      ],
    });

    expect(exchange.threads).toMatchObject([{ id: "thread-1", kind: "handoff" }]);
    expect(exchange.messages).toMatchObject([{ id: "msg-1", threadId: "thread-1" }]);
    expect(exchange.tasks).toMatchObject([{ id: "task-1", reviewStatus: "changes_requested" }]);
    expect(exchange.handoffs).toMatchObject([{ id: "handoff:thread-1", to: ["codex-1"] }]);
    expect(exchange.reviews).toMatchObject([{ id: "review:task-1", status: "changes_requested" }]);
    expect(exchange.waits).toMatchObject([{ id: "wait:thread:thread-1", waitingOn: ["codex-1"] }]);
    expect(exchange.inbox).toMatchObject([{ id: "inbox:codex-1:thread:thread-1", state: "waiting", urgency: 13 }]);
    expect(exchange.planRefs).toMatchObject([{ id: "plan:codex-1", ownerSessionId: "codex-1" }]);
    expect(exchange.continuityRefs.map((ref) => ref.kind)).toEqual(["history", "context", "recording", "status"]);
    expect(exchange.attachmentRefs).toMatchObject([{ id: "attachment-1", mediaType: "image/png" }]);
  });

  it("imports legacy files without creating missing legacy directories", () => {
    mkdirSync(getLegacyThreadsDir(), { recursive: true });
    mkdirSync(getLegacyTasksDir(), { recursive: true });
    mkdirSync(getPlansDir(), { recursive: true });
    mkdirSync(getHistoryDir(), { recursive: true });
    mkdirSync(join(getContextDir(), "codex-1"), { recursive: true });
    mkdirSync(getRecordingsDir(), { recursive: true });
    mkdirSync(getStatusDir(), { recursive: true });
    mkdirSync(getAttachmentsDir(), { recursive: true });

    writeFileSync(
      join(getLegacyThreadsDir(), "thread-1.json"),
      JSON.stringify({
        id: "thread-1",
        title: "Task",
        kind: "task",
        status: "waiting",
        createdAt: now,
        updatedAt: now,
        createdBy: "user",
        participants: ["user", "codex-1"],
        waitingOn: ["codex-1"],
        taskId: "task-1",
      }) + "\n",
    );
    writeFileSync(
      join(getLegacyThreadsDir(), "thread-1.jsonl"),
      JSON.stringify({
        id: "msg-1",
        threadId: "thread-1",
        ts: now,
        from: "user",
        kind: "request",
        body: "Do task.",
      }) + "\n",
    );
    writeFileSync(
      join(getLegacyTasksDir(), "task-1.json"),
      JSON.stringify({
        id: "task-1",
        status: "pending",
        assignedBy: "user",
        threadId: "thread-1",
        description: "Do task",
        prompt: "Do task.",
        createdAt: now,
        updatedAt: now,
      }) + "\n",
    );
    writeFileSync(join(getPlansDir(), "codex-1.md"), "# Plan\n");
    writeFileSync(join(getHistoryDir(), "codex-1.jsonl"), "{}\n");
    writeFileSync(join(getContextDir(), "codex-1", "live.md"), "live\n");
    writeFileSync(join(getRecordingsDir(), "codex-1.txt"), "recording\n");
    writeFileSync(join(getStatusDir(), "codex-1.md"), "status\n");
    writeFileSync(
      join(getAttachmentsDir(), "attachment-1.json"),
      JSON.stringify({
        id: "attachment-1",
        kind: "image",
        filename: "image.png",
        mimeType: "image/png",
        sizeBytes: 10,
        sha256: "abc",
        createdAt: now,
        source: "path",
        contentPath: join(getAttachmentsDir(), "image.png"),
      }) + "\n",
    );

    const exchange = new RuntimeExchangeStore(join(repoRoot, "runtime-exchange.yaml")).write(
      importRuntimeExchangeFromLegacyFiles({ now }),
    );

    expect(exchange.threads.map((thread) => thread.id)).toEqual(["thread-1"]);
    expect(exchange.messages.map((message) => message.id)).toEqual(["msg-1"]);
    expect(exchange.tasks.map((task) => task.id)).toEqual(["task-1"]);
    expect(exchange.waits.map((wait) => wait.id)).toEqual(["wait:thread:thread-1"]);
    expect(exchange.planRefs.map((ref) => ref.id)).toEqual(["plan:codex-1"]);
    expect(exchange.continuityRefs.map((ref) => ref.kind).sort()).toEqual([
      "context",
      "history",
      "recording",
      "status",
    ]);
    expect(exchange.attachmentRefs.map((ref) => ref.id)).toEqual(["attachment-1"]);
  });

  it("leaves absent optional legacy directories untouched", () => {
    rmSync(getRecordingsDir(), { recursive: true, force: true });

    const exchange = importRuntimeExchangeFromLegacyFiles({ now });

    expect(exchange.continuityRefs).toEqual([]);
    expect(existsSync(getRecordingsDir())).toBe(false);
  });
});
