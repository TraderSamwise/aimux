import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FastControlItem } from "./fast-control.js";
import { buildMetaDashboardModel, listAllProjectsExposeItems } from "./meta-dashboard-model.js";
import type { TmuxRuntimeManager } from "./tmux/runtime-manager.js";

function item(
  repoRoot: string,
  sessionId: string,
  opts: { worktreePath?: string; kind?: "agent" | "service" } = {},
): FastControlItem {
  return {
    id: sessionId,
    target: {
      sessionName: `aimux-${basename(repoRoot)}-id`,
      windowId: `@${sessionId}`,
      windowIndex: 1,
      windowName: "claude",
    },
    metadata: {
      sessionId,
      command: opts.kind === "service" ? "shell" : "claude",
      args: [],
      toolConfigKey: "claude",
      kind: opts.kind ?? "agent",
      worktreePath: opts.worktreePath,
    },
    label: sessionId,
    urgency: 0,
    activity: 0,
    recentRank: 0,
  };
}

function fakeTmux(sessionNames: string[]): TmuxRuntimeManager {
  return {
    listSessionNames: vi.fn(() => sessionNames),
    getProjectSession: vi.fn((repoRoot: string) => ({
      projectRoot: repoRoot,
      projectId: "id",
      sessionName: `aimux-${basename(repoRoot)}-id`,
    })),
  } as unknown as TmuxRuntimeManager;
}

const projects = [
  { id: "a", name: "alpha", repoRoot: "/repos/alpha", lastSeen: "" },
  { id: "b", name: "bravo", repoRoot: "/repos/bravo", lastSeen: "" },
  { id: "c", name: "charlie", repoRoot: "/repos/charlie", lastSeen: "" }, // stopped
];

const itemsByRoot: Record<string, FastControlItem[]> = {
  "/repos/alpha": [
    item("/repos/alpha", "a-main"),
    item("/repos/alpha", "a-main2", { worktreePath: "/repos/alpha" }), // normalizes to main
    item("/repos/alpha", "a-svc", { kind: "service" }),
    item("/repos/alpha", "a-wt", { worktreePath: "/repos/alpha/.aimux/worktrees/feat" }),
  ],
  "/repos/bravo": [item("/repos/bravo", "b-main")],
};

const worktreesByRoot: Record<string, ReturnType<typeof import("./worktree.js").listWorktrees>> = {
  "/repos/alpha": [
    { name: "alpha", path: "/repos/alpha", branch: "main", isBare: false },
    { name: "feat", path: "/repos/alpha/.aimux/worktrees/feat", branch: "feat/x", isBare: false },
    { name: "empty", path: "/repos/alpha/.aimux/worktrees/empty", branch: "empty/y", isBare: false },
  ],
  "/repos/bravo": [{ name: "bravo", path: "/repos/bravo", branch: "main", isBare: false }],
};

function deps() {
  return {
    tmux: fakeTmux(["aimux-alpha-id", "aimux-bravo-id"]),
    listProjectsFn: vi.fn(() => projects),
    listItemsFn: vi.fn((ctx: { projectRoot: string }) => itemsByRoot[ctx.projectRoot] ?? []),
    listWorktreesFn: vi.fn((root: string) => worktreesByRoot[root] ?? []),
  };
}

describe("buildMetaDashboardModel", () => {
  it("groups running projects by worktree, main first, and marks stopped projects", () => {
    const model = buildMetaDashboardModel(deps());
    expect(model.projects.map((p) => `${p.name}:${p.running}`)).toEqual(["alpha:true", "bravo:true", "charlie:false"]);

    const alpha = model.projects[0]!;
    // main bucket (incl. the worktreePath===repoRoot item) + the feat worktree; empty worktree omitted.
    expect(alpha.worktreeGroups.map((g) => g.name)).toEqual(["main", "feat"]);
    expect(alpha.worktreeGroups[0]!.isMainCheckout).toBe(true);
    expect(alpha.worktreeGroups[0]!.rows.map((r) => r.sessionId)).toEqual(["a-main", "a-main2", "a-svc"]);
    expect(alpha.worktreeGroups[1]!.branch).toBe("feat/x");
    expect(alpha.worktreeGroups[1]!.rows.map((r) => r.sessionId)).toEqual(["a-wt"]);

    // stopped project has no groups.
    expect(model.projects[2]!.worktreeGroups).toEqual([]);
  });

  it("hides worktrees that have no agents/services", () => {
    const model = buildMetaDashboardModel(deps());
    const names = model.projects[0]!.worktreeGroups.map((g) => g.name);
    expect(names).not.toContain("empty");
  });

  it("carries jump targets and row kinds", () => {
    const model = buildMetaDashboardModel(deps());
    const svc = model.projects[0]!.worktreeGroups[0]!.rows.find((r) => r.sessionId === "a-svc")!;
    expect(svc.kind).toBe("service");
    expect(svc.target.sessionName).toBe("aimux-alpha-id");
  });
});

describe("listAllProjectsExposeItems", () => {
  it("spans only running projects and tags each item with its project", () => {
    const items = listAllProjectsExposeItems(deps());
    const byProject = items.reduce<Record<string, number>>((acc, it) => {
      acc[it.projectName] = (acc[it.projectName] ?? 0) + 1;
      return acc;
    }, {});
    expect(byProject).toEqual({ alpha: 4, bravo: 1 });
    expect(items.every((it) => it.projectRoot && it.projectId)).toBe(true);
  });
});
