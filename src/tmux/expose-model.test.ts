import { describe, expect, it, vi } from "vitest";
import type { AimuxConfig } from "../config.js";
import type { FastControlContext } from "../fast-control.js";
import { initialExposeScope, loadExposeScopeItems, nextExposeScope } from "./expose-model.js";
import { TmuxRuntimeManager } from "./runtime-manager.js";

vi.mock("../worktree.js", () => ({
  listWorktrees: vi.fn(() => [{ path: "/repo" }, { path: "/repo/.aimux/worktrees/feat-x" }]),
}));

function config(initialScope: "worktree" | "project" | "global"): AimuxConfig {
  return { expose: { initialScope } } as AimuxConfig;
}

describe("nextExposeScope", () => {
  it("walks up the ladder", () => {
    expect(nextExposeScope("worktree")).toBe("project");
    expect(nextExposeScope("project")).toBe("global");
  });

  it("clamps at global", () => {
    expect(nextExposeScope("global")).toBe("global");
  });
});

describe("initialExposeScope", () => {
  const insideAgent: FastControlContext = { projectRoot: "/repo", currentWindow: "codex", currentWindowId: "@2" };

  it("starts at global when launched cross-project", () => {
    expect(initialExposeScope(true, insideAgent, config("worktree"))).toBe("global");
  });

  it("starts at worktree inside an agent window", () => {
    expect(initialExposeScope(false, insideAgent, config("worktree"))).toBe("worktree");
  });

  it("starts at project on the dashboard window", () => {
    expect(
      initialExposeScope(
        false,
        { projectRoot: "/repo", currentWindow: "dashboard", currentWindowId: "@9" },
        config("worktree"),
      ),
    ).toBe("project");
  });

  it("starts at the configured initial scope", () => {
    expect(initialExposeScope(false, insideAgent, config("project"))).toBe("project");
    expect(initialExposeScope(false, insideAgent, config("global"))).toBe("global");
  });

  it("starts at project when there is no current window id", () => {
    expect(initialExposeScope(false, { projectRoot: "/repo", currentWindow: "codex" }, config("worktree"))).toBe(
      "project",
    );
  });
});

describe("loadExposeScopeItems", () => {
  const context: FastControlContext = { projectRoot: "/repo", currentWindow: "codex", currentWindowId: "@2" };
  const tmux = {} as unknown as TmuxRuntimeManager;
  const agentItem = { id: "wt-agent" } as never;
  const globalItem = { id: "other", projectRoot: "/other", projectName: "other" } as never;

  it("loads worktree scope via listItemsFn with scope 'worktree'", () => {
    const listItemsFn = vi.fn(() => [agentItem]);
    const listAllFn = vi.fn(() => []);
    const view = loadExposeScopeItems("worktree", context, { tmux, listItemsFn, listAllFn });
    expect(listItemsFn).toHaveBeenCalledWith(context, tmux, { scope: "worktree" });
    expect(listAllFn).not.toHaveBeenCalled();
    expect(view).toMatchObject({ scope: "worktree", scopeLabel: "this worktree", sublabel: "none" });
    expect(view.items.map((i) => i.id)).toEqual(["wt-agent"]);
  });

  it("loads project scope via listItemsFn with scope 'all'", () => {
    const listItemsFn = vi.fn(() => [agentItem]);
    const listAllFn = vi.fn(() => []);
    const view = loadExposeScopeItems("project", context, { tmux, listItemsFn, listAllFn });
    expect(listItemsFn).toHaveBeenCalledWith(context, tmux, { scope: "all" });
    expect(listAllFn).not.toHaveBeenCalled();
    expect(view).toMatchObject({ scope: "project", scopeLabel: "all worktrees", sublabel: "worktree" });
  });

  it("loads global scope via listAllFn", () => {
    const listItemsFn = vi.fn(() => []);
    const listAllFn = vi.fn(() => [globalItem]);
    const view = loadExposeScopeItems("global", context, { tmux, listItemsFn, listAllFn });
    expect(listAllFn).toHaveBeenCalledWith({ tmux });
    expect(listItemsFn).not.toHaveBeenCalled();
    expect(view).toMatchObject({ scope: "global", scopeLabel: "all projects", sublabel: "project-worktree" });
    expect(view.items.map((i) => i.id)).toEqual(["other"]);
  });
});
