import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { readThread } from "./threads.js";
import { sendDirectMessage, sendThreadMessage } from "./orchestration.js";

describe("orchestration", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-orchestration-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("opens and reuses direct conversation threads", () => {
    const first = sendDirectMessage({
      from: "user",
      to: ["codex-1"],
      body: "Please review the parser change.",
      title: "Parser review",
    });
    const second = sendDirectMessage({
      from: "user",
      to: ["codex-1"],
      body: "Any update?",
    });
    expect(first.threadCreated).toBe(true);
    expect(second.threadCreated).toBe(false);
    expect(second.thread.id).toBe(first.thread.id);
    expect(readThread(first.thread.id)?.waitingOn).toEqual(["codex-1"]);
  });

  it("marks replies as waiting on the next recipients", () => {
    const created = sendDirectMessage({
      from: "claude-lead",
      to: ["codex-1"],
      body: "Take the next debugging pass.",
    });
    const replied = sendThreadMessage({
      threadId: created.thread.id,
      from: "codex-1",
      to: ["claude-lead"],
      kind: "reply",
      body: "I found the root cause. Can you confirm the rollout plan?",
    });
    expect(replied.thread.waitingOn).toEqual(["claude-lead"]);
    expect(replied.thread.owner).toBe("codex-1");
    expect(replied.thread.unreadBy).toContain("claude-lead");
  });
});
