import { describe, expect, it } from "vitest";
import { resolveOrchestrationRecipients, resolveOrchestrationTarget } from "./orchestration-routing.js";

describe("orchestration routing", () => {
  const candidates = [
    {
      id: "claude-ui",
      tool: "claude",
      role: "ui",
      worktreePath: "/repo/ui",
      status: "idle",
      canReceiveInput: true,
      isAlive: true,
      workflowPressure: 0,
    },
    {
      id: "codex-ui",
      tool: "codex",
      role: "ui",
      worktreePath: "/repo/ui",
      status: "running",
      canReceiveInput: true,
      isAlive: true,
      workflowPressure: 4,
    },
    {
      id: "codex-coder",
      tool: "codex",
      role: "coder",
      worktreePath: "/repo/api",
      status: "waiting",
      canReceiveInput: true,
      isAlive: true,
      workflowPressure: 2,
    },
  ];

  it("prefers direct session targeting when provided", () => {
    expect(resolveOrchestrationTarget({ candidates, to: "codex-coder" })?.id).toBe("codex-coder");
  });

  it("routes by role and worktree", () => {
    expect(resolveOrchestrationTarget({ candidates, assignee: "ui", worktreePath: "/repo/ui" })?.id).toBe("claude-ui");
  });

  it("routes by tool when role is absent", () => {
    expect(resolveOrchestrationTarget({ candidates, tool: "codex", worktreePath: "/repo/api" })?.id).toBe(
      "codex-coder",
    );
  });

  it("returns routed recipients as a session id list", () => {
    expect(resolveOrchestrationRecipients({ candidates, assignee: "ui", worktreePath: "/repo/ui" })).toEqual([
      "claude-ui",
      "codex-ui",
    ]);
  });

  it("preserves explicit multi-recipient targeting order for live sessions", () => {
    expect(resolveOrchestrationRecipients({ candidates, to: ["codex-coder", "claude-ui"] })).toEqual([
      "codex-coder",
      "claude-ui",
    ]);
  });

  it("prefers idle recipients over running ones", () => {
    expect(resolveOrchestrationTarget({ candidates, assignee: "ui" })?.id).toBe("claude-ui");
  });

  it("filters blocked recipients from implicit routing", () => {
    expect(
      resolveOrchestrationRecipients({
        candidates: [
          ...candidates,
          { id: "blocked-ui", role: "ui", tool: "claude", status: "idle", canReceiveInput: false, isAlive: true },
        ],
        assignee: "ui",
      }),
    ).toEqual(["claude-ui", "codex-ui"]);
  });

  it("prefers lower workflow pressure among equally available candidates", () => {
    expect(
      resolveOrchestrationTarget({
        candidates: [
          {
            id: "claude-ui-light",
            role: "ui",
            tool: "claude",
            status: "idle",
            canReceiveInput: true,
            isAlive: true,
            workflowPressure: 0,
          },
          {
            id: "claude-ui-loaded",
            role: "ui",
            tool: "claude",
            status: "idle",
            canReceiveInput: true,
            isAlive: true,
            workflowPressure: 6,
          },
        ],
        assignee: "ui",
      })?.id,
    ).toBe("claude-ui-light");
  });
});
