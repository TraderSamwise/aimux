import { describe, expect, it } from "vitest";
import type { MetaDashboardModel } from "../meta-dashboard-model.js";
import { flattenSelectableRows, renderMetaDashboard, resolveJumpTarget } from "./meta-dashboard.js";
import { stripAnsi } from "../tui/render/text.js";

function target(sessionName: string, windowId: string) {
  return { sessionName, windowId, windowIndex: 1, windowName: "claude" };
}

const model: MetaDashboardModel = {
  projects: [
    {
      id: "a",
      name: "alpha",
      repoRoot: "/repos/alpha",
      running: true,
      worktreeGroups: [
        {
          worktreePath: null,
          name: "main",
          branch: "main",
          isMainCheckout: true,
          rows: [
            {
              kind: "agent",
              sessionId: "a1",
              label: "Claude",
              tool: "claude",
              urgency: 0,
              target: target("aimux-alpha", "@1"),
            },
            {
              kind: "service",
              sessionId: "a2",
              label: "dev",
              tool: "shell",
              urgency: 0,
              target: target("aimux-alpha", "@2"),
            },
          ],
        },
        {
          worktreePath: "/repos/alpha/.aimux/worktrees/feat",
          name: "feat",
          branch: "feat/x",
          isMainCheckout: false,
          rows: [
            {
              kind: "agent",
              sessionId: "a3",
              label: "Codex",
              tool: "codex",
              urgency: 0,
              target: target("aimux-alpha", "@3"),
            },
          ],
        },
      ],
    },
    { id: "b", name: "bravo", repoRoot: "/repos/bravo", running: false, worktreeGroups: [] },
  ],
};

describe("flattenSelectableRows", () => {
  it("flattens only running projects' rows in render order", () => {
    expect(flattenSelectableRows(model).map((s) => s.row.sessionId)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("resolveJumpTarget", () => {
  const hostFor = (root: string) => `host:${root}`;

  it("maps an index to that row's target with the project host session", () => {
    const jump = resolveJumpTarget(model, 2, hostFor); // third selectable row = a3 (feat)
    expect(jump).not.toBeNull();
    expect(jump!.projectRoot).toBe("/repos/alpha");
    expect(jump!.target.windowId).toBe("@3");
    expect(jump!.target.sessionName).toBe("host:/repos/alpha");
  });

  it("returns null for an out-of-range index", () => {
    expect(resolveJumpTarget(model, 99, hostFor)).toBeNull();
  });
});

describe("renderMetaDashboard", () => {
  it("renders project, worktree, and agent labels and marks stopped projects", () => {
    const plain = stripAnsi(renderMetaDashboard(model, 0, 100, 40));
    expect(plain).toContain("alpha");
    expect(plain).toContain("bravo");
    expect(plain).toContain("(stopped)");
    expect(plain).toContain("main");
    expect(plain).toContain("feat");
    expect(plain).toContain("Claude");
    expect(plain).toContain("Codex");
  });

  it("shows an empty state when there are no projects", () => {
    const plain = stripAnsi(renderMetaDashboard({ projects: [] }, 0, 80, 24));
    expect(plain).toContain("No projects registered");
  });

  it("does not throw on a tiny terminal", () => {
    expect(() => renderMetaDashboard(model, 2, 10, 4)).not.toThrow();
  });
});
