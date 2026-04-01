import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { assignTask } from "./orchestration-actions.js";
import { openTaskThread } from "./threads.js";
import { writeTask, type Task } from "./tasks.js";
import { buildWorkflowEntries } from "./workflow.js";

describe("workflow model", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-workflow-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("groups related task and review items into the same workflow family", async () => {
    const created = await assignTask({
      from: "claude-lead",
      to: "codex-worker",
      description: "Audit the parser failure path",
    });

    const reviewTask: Task = {
      id: "review-parser",
      status: "pending",
      assignedBy: "codex-worker",
      description: "Review: Audit the parser failure path",
      prompt: "Please review the parser fix.",
      createdAt: new Date(Date.now() + 1).toISOString(),
      updatedAt: new Date(Date.now() + 1).toISOString(),
      assignee: "reviewer",
      type: "review",
      reviewStatus: "pending",
      reviewOf: created.task.id,
    };
    openTaskThread(reviewTask.id, {
      title: reviewTask.description,
      createdBy: "codex-worker",
      participants: ["codex-worker", "reviewer"],
      kind: "review",
    });
    await writeTask(reviewTask);

    const entries = buildWorkflowEntries("reviewer");
    const familyEntries = entries.filter((entry) => entry.familyRootTaskId === created.task.id);
    expect(familyEntries).toHaveLength(2);
    for (const entry of familyEntries) {
      expect(entry.familyTaskIds).toEqual([created.task.id, reviewTask.id]);
    }
  });
});
