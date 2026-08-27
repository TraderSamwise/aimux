import { describe, expect, it } from "vitest";

import { renderAgentsByWorktreeLines, renderAgentsFlatLines, type CliAgentListItem } from "./agent-list.js";

const agents: CliAgentListItem[] = [
  {
    id: "codex-2",
    command: "codex",
    tool: "codex",
    toolConfigKey: "codex",
    status: "running",
    worktreePath: "/repo/worktrees/feature",
    activity: "working",
    attention: "ok",
    role: "coder",
    backendSessionId: "backend-2",
    loop: { active: true, goal: "ship" },
  },
  {
    id: "claude-1",
    command: "claude",
    tool: "claude",
    toolConfigKey: "claude",
    status: "idle",
    worktreePath: "/repo",
    task: { description: "Review handoff", status: "pending" },
  },
];

describe("agent list CLI renderers", () => {
  it("renders flat agent summaries with canonical, Aimux, backend, state, and task fields", () => {
    expect(renderAgentsFlatLines(agents, "/repo")).toEqual([
      "codex-2  [codex]  coder",
      "  running  canonical=codex  aimux=codex-2  backend=backend-2  state=working/ok  role=coder loop=ship",
      "    worktree: /repo/worktrees/feature",
      "claude-1  [claude]",
      "  idle  canonical=claude  aimux=claude-1",
      "    worktree: /repo",
      "    task: Review handoff (pending)",
    ]);
  });

  it("renders worktree-grouped summaries with main checkout first", () => {
    expect(renderAgentsByWorktreeLines(agents, "/repo")).toEqual([
      "Main Checkout  /repo",
      "  idle  canonical=claude  aimux=claude-1",
      "    task: Review handoff (pending)",
      "",
      "feature  /repo/worktrees/feature",
      "  running  canonical=codex  aimux=codex-2  backend=backend-2  state=working/ok  role=coder loop=ship",
    ]);
  });

  it("renders an empty inventory explicitly", () => {
    expect(renderAgentsFlatLines([])).toEqual(["no agents"]);
    expect(renderAgentsByWorktreeLines([])).toEqual(["no agents"]);
  });
});
