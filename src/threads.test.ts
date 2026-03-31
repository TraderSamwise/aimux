import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import {
  appendMessage,
  createThread,
  listThreads,
  markThreadSeen,
  openTaskThread,
  readMessages,
  readThread,
} from "./threads.js";

describe("threads", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-threads-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("creates and lists threads", () => {
    const thread = createThread({
      title: "Review API shape",
      kind: "conversation",
      createdBy: "claude-1",
      participants: ["claude-1", "codex-1"],
    });
    expect(listThreads()).toHaveLength(1);
    expect(readThread(thread.id)?.title).toBe("Review API shape");
  });

  it("appends messages and tracks unread state", () => {
    const thread = createThread({
      title: "Ask about parser",
      kind: "conversation",
      createdBy: "claude-1",
      participants: ["claude-1", "codex-1"],
    });
    appendMessage(thread.id, {
      from: "claude-1",
      to: ["codex-1"],
      kind: "request",
      body: "Why this parser?",
    });
    expect(readMessages(thread.id)).toHaveLength(1);
    const updated = readThread(thread.id);
    expect(updated?.unreadBy).toContain("codex-1");
    expect(updated?.unreadBy).not.toContain("claude-1");
  });

  it("marks threads seen per participant", () => {
    const thread = createThread({
      title: "Ask about parser",
      kind: "conversation",
      createdBy: "claude-1",
      participants: ["claude-1", "codex-1"],
      unreadBy: ["codex-1"],
    });
    expect(markThreadSeen(thread.id, "codex-1")?.unreadBy).toEqual([]);
  });

  it("opens stable task-linked threads", () => {
    const first = openTaskThread("task-1", {
      title: "Task: ship auth",
      createdBy: "claude-lead",
      participants: ["claude-lead", "codex-worker"],
      worktreePath: "/repo/mobile",
    });
    const second = openTaskThread("task-1", {
      title: "Task: ship auth",
      createdBy: "claude-lead",
      participants: ["claude-lead", "codex-worker"],
      worktreePath: "/repo/mobile",
    });
    expect(second.id).toBe(first.id);
    expect(readThread(first.id)?.taskId).toBe("task-1");
  });
});
