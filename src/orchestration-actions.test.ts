import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { readMessages, readThread } from "./threads.js";
import { readTask } from "./tasks.js";
import {
  acceptHandoff,
  acceptTask,
  assignTask,
  blockTask,
  completeHandoff,
  completeTask,
  sendHandoff,
} from "./orchestration-actions.js";

describe("orchestration actions", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-orchestration-actions-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("creates a targeted task thread and task record", async () => {
    const result = await assignTask({
      from: "claude-lead",
      to: "codex-worker",
      description: "Audit the parser failure path",
    });

    expect(result.task.threadId).toBeTruthy();
    expect(readTask(result.task.id)?.description).toContain("parser failure path");
    expect(result.thread?.participants).toEqual(["claude-lead", "codex-worker"]);
    expect(result.thread?.waitingOn).toEqual(["codex-worker"]);
    expect(result.thread?.kind).toBe("task");
  });

  it("creates a handoff thread with a handoff message", () => {
    const result = sendHandoff({
      from: "claude-lead",
      to: ["codex-worker"],
      body: "Take over the UI debug pass from here.",
      title: "UI handoff",
    });

    expect(result.thread.kind).toBe("handoff");
    expect(result.thread.waitingOn).toEqual(["codex-worker"]);
    expect(result.message.kind).toBe("handoff");
    expect(result.message.to).toEqual(["codex-worker"]);
    expect(readThread(result.thread.id)?.title).toBe("UI handoff");
    expect(readMessages(result.thread.id).at(-1)?.body).toContain("Take over the UI debug pass");
  });

  it("accepts a handoff without leaving the thread waiting", () => {
    const created = sendHandoff({
      from: "claude-lead",
      to: ["codex-worker"],
      body: "Take over the UI debug pass from here.",
    });

    const accepted = acceptHandoff({
      threadId: created.thread.id,
      from: "codex-worker",
    });

    expect(accepted.thread.owner).toBe("codex-worker");
    expect(accepted.thread.waitingOn).toEqual([]);
    expect(accepted.thread.status).toBe("open");
    expect(accepted.message.metadata?.handoffAction).toBe("accepted");
  });

  it("completes a handoff and waits on the originator", () => {
    const created = sendHandoff({
      from: "claude-lead",
      to: ["codex-worker"],
      body: "Take over the UI debug pass from here.",
    });

    const completed = completeHandoff({
      threadId: created.thread.id,
      from: "codex-worker",
    });

    expect(completed.thread.owner).toBe("codex-worker");
    expect(completed.thread.waitingOn).toEqual(["claude-lead"]);
    expect(completed.thread.status).toBe("waiting");
    expect(completed.message.metadata?.handoffAction).toBe("completed");
  });

  it("accepts blocks and completes tasks with matching thread updates", async () => {
    const created = await assignTask({
      from: "claude-lead",
      to: "codex-worker",
      description: "Audit the parser failure path",
    });

    const accepted = await acceptTask({
      taskId: created.task.id,
      from: "codex-worker",
    });
    expect(accepted.task.status).toBe("in_progress");
    expect(accepted.thread?.status).toBe("open");
    expect(accepted.thread?.owner).toBe("codex-worker");
    expect(accepted.message?.metadata?.taskAction).toBe("accepted");

    const blocked = await blockTask({
      taskId: created.task.id,
      from: "codex-worker",
      body: "Need a failing reproduction case.",
    });
    expect(blocked.task.status).toBe("blocked");
    expect(blocked.thread?.status).toBe("blocked");
    expect(blocked.thread?.waitingOn).toEqual(["claude-lead"]);
    expect(blocked.message?.metadata?.taskAction).toBe("blocked");

    const completed = await completeTask({
      taskId: created.task.id,
      from: "codex-worker",
      body: "Found and fixed the parser timeout branch.",
    });
    expect(completed.task.status).toBe("done");
    expect(completed.task.result).toContain("fixed");
    expect(completed.thread?.status).toBe("waiting");
    expect(completed.thread?.waitingOn).toEqual(["claude-lead"]);
    expect(completed.message?.metadata?.taskAction).toBe("completed");
  });
});
