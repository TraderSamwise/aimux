import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { readMessages, readThread } from "./threads.js";
import { readTask } from "./tasks.js";
import { acceptHandoff, assignTask, completeHandoff, sendHandoff } from "./orchestration-actions.js";

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
});
