import { describe, expect, it } from "vitest";
import { resolveOrchestrationRecipients, resolveOrchestrationTarget } from "./orchestration-routing.js";

describe("orchestration routing", () => {
  const candidates = [
    { id: "claude-ui", tool: "claude", role: "ui", worktreePath: "/repo/ui", status: "idle" },
    { id: "codex-ui", tool: "codex", role: "ui", worktreePath: "/repo/ui", status: "running" },
    { id: "codex-coder", tool: "codex", role: "coder", worktreePath: "/repo/api", status: "waiting" },
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
    ]);
  });
});
