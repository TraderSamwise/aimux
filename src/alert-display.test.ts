import { describe, expect, it } from "vitest";
import { contextualizeAlertInput, sessionAlertTitle } from "./alert-display.js";

describe("alert display context", () => {
  it("names needs-input alerts by session label and worktree", () => {
    expect(
      sessionAlertTitle("needs_input", "claude-hb01nv", "claude-hb01nv needs input", {
        label: "bugs",
        worktreeName: "cdc-patches",
      }),
    ).toBe("bugs @ cdc-patches needs input");
  });

  it("replaces generic service completion titles with contextual titles", () => {
    expect(
      contextualizeAlertInput(
        {
          kind: "task_done",
          sessionId: "service-123",
          title: "service",
          message: "Shell returned to a prompt.",
          projectName: "aimux",
          projectRoot: "/repo",
        },
        { label: "shell", worktreeName: "Main Checkout", worktreePath: "/repo" },
      ),
    ).toMatchObject({
      title: "[Done] aimux / Main Checkout",
      message: "Agent or service finished: shell @ Main Checkout finished - Shell returned to a prompt.",
      projectName: "aimux",
      projectRoot: "/repo",
      worktreePath: "/repo",
      worktreeName: "Main Checkout",
      categoryLabel: "Done",
      reasonLabel: "Agent or service finished",
    });
  });

  it("labels idle turn-end alerts as next-step notifications with branch context", () => {
    expect(
      contextualizeAlertInput(
        {
          kind: "next_step",
          sessionId: "codex-rmq9pv",
          title: "codex-rmq9pv ready for next step",
          message: "Agent stopped after a turn.",
          projectName: "aimux",
          projectRoot: "/repo",
          dedupeKey: "idle-needs-input:codex-rmq9pv",
        },
        { label: "codex", worktreeName: "notifications", branch: "notification-taxonomy" },
      ),
    ).toMatchObject({
      title: "[Next step] aimux / notifications (notification-taxonomy)",
      message: "Agent stopped after a turn: codex @ notifications ready for next step",
      categoryLabel: "Next step",
      reasonLabel: "Agent stopped after a turn",
      worktreeName: "notifications",
      branch: "notification-taxonomy",
    });
  });

  it("normalizes raw failure titles from direct publishers", () => {
    expect(
      sessionAlertTitle("task_failed", "codex-xzl7jp", "codex-xzl7jp failed", {
        label: "codex",
        branch: "feat/demo",
      }),
    ).toBe("codex @ feat/demo errored");
  });
});
