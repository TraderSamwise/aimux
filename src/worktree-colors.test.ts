import { describe, expect, it } from "vitest";

import {
  WORKTREE_COLOR_HEXES,
  WORKTREE_COLOR_XTERM_CODES,
  worktreeColorHex,
  worktreeColorIndex,
  worktreeColorKey,
  worktreeColorXterm,
} from "./worktree-colors.js";

describe("worktree colors", () => {
  it("uses one deterministic palette for terminal and GUI tones", () => {
    const input = { path: "/repo/.aimux/worktrees/e2e-audit", projectRoot: "/repo", name: "e2e-audit" };
    const index = worktreeColorIndex(input);

    expect(worktreeColorHex(input)).toBe(WORKTREE_COLOR_HEXES[index]);
    expect(worktreeColorXterm(input)).toBe(WORKTREE_COLOR_XTERM_CODES[index]);
  });

  it("is stable for the same identity regardless of surrounding order", () => {
    const target = { path: "/repo/.aimux/worktrees/custom-modules-mcp" };
    const before = [{ path: "/repo" }, target, { path: "/repo/.aimux/worktrees/e2e-audit" }].map((worktree) =>
      worktreeColorIndex(worktree),
    );
    const after = [target, { path: "/repo" }].map((worktree) => worktreeColorIndex(worktree));

    expect(before[1]).toBe(after[0]);
  });

  it("prefers path and falls back to project plus name", () => {
    expect(worktreeColorKey({ path: "/repo", projectRoot: "/other", name: "main" })).toBe("path:/repo");
    expect(worktreeColorKey({ projectRoot: "/repo", name: "main" })).toBe("project-root:/repo\0name:main");
    expect(worktreeColorKey({ name: "scratch" })).toBe("name:scratch");
  });
});
