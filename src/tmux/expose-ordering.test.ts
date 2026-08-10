import { describe, expect, it } from "vitest";

import { groupItemsByProject, groupItemsByWorktree, orderExposeItems } from "./expose.js";
import type { ExposeScopeItem, ExposeScopeView } from "./expose-model.js";

function item(id: string, options: { projectName?: string; projectRoot?: string; worktreePath?: string } = {}) {
  return {
    label: id,
    target: { windowId: id, windowName: id },
    metadata: { worktreePath: options.worktreePath },
    projectName: options.projectName,
    projectRoot: options.projectRoot,
  } as unknown as ExposeScopeItem;
}

function view(items: ExposeScopeItem[], sublabel: ExposeScopeView["sublabel"]): ExposeScopeView {
  return { scope: "global", items, scopeLabel: "all projects", sublabel };
}

describe("groupItemsByProject", () => {
  it("keeps first-seen project order and item order inside a project", () => {
    const result = groupItemsByProject([
      item("b1", { projectName: "beta" }),
      item("a1", { projectName: "alpha" }),
      item("b2", { projectName: "beta" }),
      item("a2", { projectName: "alpha" }),
    ]);
    expect(result.map((g) => g.label)).toEqual(["beta", "alpha"]);
    expect(result[0]!.items.map((i) => i.target.windowId)).toEqual(["b1", "b2"]);
    expect(result[1]!.items.map((i) => i.target.windowId)).toEqual(["a1", "a2"]);
  });

  it("buckets items with no project name under one label", () => {
    const result = groupItemsByProject([item("x"), item("y", { projectName: "  " })]);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("unknown project");
  });
});

describe("groupItemsByWorktree", () => {
  it("keeps first-seen worktree order and item order inside a worktree", () => {
    const result = groupItemsByWorktree(
      [
        item("custom-1", { worktreePath: "/repo/.aimux/worktrees/custom" }),
        item("main-1", { worktreePath: "/repo" }),
        item("custom-2", { worktreePath: "/repo/.aimux/worktrees/custom" }),
        item("main-2", { worktreePath: "/repo" }),
        item("audit-1", { worktreePath: "/repo/.aimux/worktrees/e2e-audit" }),
      ],
      "/repo",
    );
    expect(result.map((g) => g.label)).toEqual(["custom", "main", "e2e-audit"]);
    expect(result[0]!.items.map((i) => i.target.windowId)).toEqual(["custom-1", "custom-2"]);
    expect(result[1]!.items.map((i) => i.target.windowId)).toEqual(["main-1", "main-2"]);
    expect(result[2]!.items.map((i) => i.target.windowId)).toEqual(["audit-1"]);
  });

  it("buckets missing and project-root worktrees under main", () => {
    const result = groupItemsByWorktree([item("x"), item("y", { worktreePath: "/repo" })], "/repo");
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("main");
  });
});

describe("orderExposeItems", () => {
  it("regroups project-scope items by worktree in the flat grid", () => {
    const ordered = orderExposeItems(
      view(
        [
          item("custom-1", { worktreePath: "/repo/.aimux/worktrees/custom" }),
          item("main-1", { worktreePath: "/repo" }),
          item("custom-2", { worktreePath: "/repo/.aimux/worktrees/custom" }),
          item("main-2", { worktreePath: "/repo" }),
          item("audit-1", { worktreePath: "/repo/.aimux/worktrees/e2e-audit" }),
        ],
        "worktree",
      ),
      "/repo",
    );
    expect(ordered.map((i) => i.target.windowId)).toEqual(["custom-1", "custom-2", "main-1", "main-2", "audit-1"]);
  });

  it("regroups global items by project, then by worktree inside each project", () => {
    const ordered = orderExposeItems(
      view(
        [
          item("beta-custom-1", {
            projectName: "beta",
            projectRoot: "/beta",
            worktreePath: "/beta/.aimux/worktrees/custom",
          }),
          item("alpha-main-1", { projectName: "alpha", projectRoot: "/alpha", worktreePath: "/alpha" }),
          item("beta-main-1", { projectName: "beta", projectRoot: "/beta", worktreePath: "/beta" }),
          item("alpha-main-2", { projectName: "alpha", projectRoot: "/alpha", worktreePath: "/alpha" }),
          item("beta-custom-2", {
            projectName: "beta",
            projectRoot: "/beta",
            worktreePath: "/beta/.aimux/worktrees/custom",
          }),
        ],
        "project-worktree",
      ),
      "/fallback",
    );
    expect(ordered.map((i) => i.target.windowId)).toEqual([
      "beta-custom-1",
      "beta-custom-2",
      "beta-main-1",
      "alpha-main-1",
      "alpha-main-2",
    ]);
  });

  it("regroups single-project global items by worktree", () => {
    const ordered = orderExposeItems(
      view(
        [
          item("custom-1", { projectName: "alpha", projectRoot: "/repo", worktreePath: "/repo/wt/custom" }),
          item("main-1", { projectName: "alpha", projectRoot: "/repo", worktreePath: "/repo" }),
          item("custom-2", { projectName: "alpha", projectRoot: "/repo", worktreePath: "/repo/wt/custom" }),
        ],
        "project-worktree",
      ),
      "/repo",
    );
    expect(ordered.map((i) => i.target.windowId)).toEqual(["custom-1", "custom-2", "main-1"]);
  });

  it("leaves order alone for a single global worktree, a single project worktree, or worktree-local scope", () => {
    const singleGlobalWorktree = [
      item("a1", { projectName: "alpha", projectRoot: "/repo", worktreePath: "/repo" }),
      item("a2", { projectName: "alpha", projectRoot: "/repo", worktreePath: "/repo" }),
    ];
    expect(orderExposeItems(view(singleGlobalWorktree, "project-worktree"), "/repo")).toBe(singleGlobalWorktree);
    const singleWorktree = [
      item("custom-1", { worktreePath: "/repo/wt/custom" }),
      item("custom-2", { worktreePath: "/repo/wt/custom" }),
    ];
    expect(orderExposeItems(view(singleWorktree, "worktree"), "/repo")).toBe(singleWorktree);
    const local = [item("custom-1", { worktreePath: "/repo/wt/custom" }), item("main-1", { worktreePath: "/repo" })];
    expect(orderExposeItems(view(local, "none"), "/repo")).toBe(local);
  });
});
