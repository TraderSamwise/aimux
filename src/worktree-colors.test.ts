import { describe, expect, it } from "vitest";

import {
  worktreeColorAnsi,
  worktreeColorAnsiForCode,
  worktreeColorCode,
  worktreeColorHexForCode,
  worktreeColorHex,
  worktreeColorKey,
} from "./worktree-colors.js";

describe("worktree colors", () => {
  it("uses one deterministic truecolor value for terminal and GUI tones", () => {
    const input = { path: "/repo/.aimux/worktrees/e2e-audit", projectRoot: "/repo", name: "e2e-audit" };
    const code = worktreeColorCode(input);

    expect(worktreeColorHex(input)).toBe(worktreeColorHexForCode(code));
    expect(worktreeColorAnsi(input)).toBe(worktreeColorAnsiForCode(code));
    expect(worktreeColorAnsi(input)).toMatch(/^38;2;\d+;\d+;\d+$/);
  });

  it("is stable for the same identity regardless of surrounding order", () => {
    const target = { path: "/repo/.aimux/worktrees/custom-modules-mcp" };
    const before = [{ path: "/repo" }, target, { path: "/repo/.aimux/worktrees/e2e-audit" }].map((worktree) =>
      worktreeColorCode(worktree),
    );
    const after = [target, { path: "/repo" }].map((worktree) => worktreeColorCode(worktree));

    expect(before[1]).toBe(after[0]);
  });

  it("does not quantize identities into a tiny palette", () => {
    const colors = new Set(
      Array.from({ length: 300 }, (_, index) => worktreeColorHex({ path: `/repo/.aimux/worktrees/worktree-${index}` })),
    );

    expect(colors.size).toBeGreaterThan(250);
  });

  it("prefers path and falls back to project plus name", () => {
    expect(worktreeColorKey({ path: "/repo", projectRoot: "/other", name: "main" })).toBe("path:/repo");
    expect(worktreeColorKey({ projectRoot: "/repo", name: "main" })).toBe("project-root:/repo\0name:main");
    expect(worktreeColorKey({ name: "scratch" })).toBe("name:scratch");
  });
});
