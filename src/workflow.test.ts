import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { assignTask } from "./orchestration-actions.js";
import { openTaskThread } from "./threads.js";
import { readTask, writeTask, type Task } from "./tasks.js";
import { saveTeamConfig } from "./team.js";
import { requestReview } from "./task-workflow.js";
import { addNotification } from "./notifications.js";
import { buildCoordinationThreadEntries, buildWorkflowEntries, filterWorkflowEntries } from "./workflow.js";

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

  it("excludes notification-tagged threads from coordination thread entries", async () => {
    addNotification({
      title: "[Needs input] claude @ beautify-tui",
      body: "Claude is waiting for your input",
      sessionId: "claude-x",
      kind: "needs_input",
    });
    await assignTask({ from: "claude-lead", to: "codex-worker", description: "Audit the parser failure path" });

    const entries = buildCoordinationThreadEntries("user");
    expect(entries.some((entry) => entry.thread.title.includes("[Needs input]"))).toBe(false);
    expect(entries.some((entry) => entry.thread.kind === "task")).toBe(true);
  });

  it("filters workflow entries by waiting-on-me, blocked, and families", async () => {
    const created = await assignTask({
      from: "claude-lead",
      to: "reviewer",
      description: "Audit the parser failure path",
    });

    const reviewTask: Task = {
      id: "review-filter",
      status: "blocked",
      assignedBy: "reviewer",
      description: "Review: Audit the parser failure path",
      prompt: "Please review the parser fix.",
      createdAt: new Date(Date.now() + 1).toISOString(),
      updatedAt: new Date(Date.now() + 1).toISOString(),
      assignee: "reviewer",
      type: "review",
      reviewStatus: "pending",
      reviewOf: created.task.id,
      assignedTo: "reviewer",
    };
    openTaskThread(reviewTask.id, {
      title: reviewTask.description,
      createdBy: "reviewer",
      participants: ["reviewer", "claude-lead"],
      kind: "review",
    });
    await writeTask(reviewTask);

    const entries = buildWorkflowEntries("reviewer");
    expect(filterWorkflowEntries(entries, "on_me", "reviewer").length).toBeGreaterThan(0);
    expect(
      filterWorkflowEntries(entries, "blocked", "reviewer").some((entry) => entry.task?.id === reviewTask.id),
    ).toBe(true);
    expect(
      filterWorkflowEntries(entries, "families", "reviewer").every((entry) => entry.familyTaskIds.length > 1),
    ).toBe(true);
  });

  it("persists requested reviews before returning them", async () => {
    const reviewTask = await requestReview("codex-1", "coder", "diff", "Review parser work");

    expect(reviewTask?.assignee).toBe("reviewer");
    expect(readTask(reviewTask!.id)).toMatchObject({
      id: reviewTask!.id,
      assignee: "reviewer",
      prompt: "Review parser work",
    });
  });

  it("does not fall back to assigning reviews to the requesting role", async () => {
    saveTeamConfig({
      defaultRole: "coder",
      roles: {
        coder: { description: "Writes code", canEdit: true },
        reviewer: { description: "Reviews changes" },
      },
    });

    const reviewTask = await requestReview("codex-1", "coder", undefined, "Review parser work");

    expect(reviewTask?.assignee).toBe("reviewer");
  });
});
