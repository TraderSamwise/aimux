import { describe, expect, it } from "vitest";

import {
  worktreeColorAnsi,
  worktreeColorAnsiForCode,
  worktreeColorCode,
  worktreeColorHexForCode,
  worktreeColorHex,
  worktreeColorKey,
  rgbFromWorktreeColorCode,
} from "./worktree-colors.js";

function colorDistance(a: number, b: number): number {
  const left = rgbFromWorktreeColorCode(a);
  const right = rgbFromWorktreeColorCode(b);
  return Math.sqrt((left.r - right.r) ** 2 + (left.g - right.g) ** 2 + (left.b - right.b) ** 2);
}

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

  it("keeps common project worktree names visually separated", () => {
    for (const root of ["/Users/sam/cs/aimux", "/Users/sam/cs/tealstreet-next"]) {
      const colors = [
        worktreeColorCode({ path: root, name: "main" }),
        ...[
          "context-mcp",
          "affiliates",
          "auto-api-sync",
          "data-analytics",
          "custom-modules-mcp",
          "e2e-audit",
          "okx-open-stops",
          "v2-key-sync",
        ].map((name) => worktreeColorCode({ path: `${root}/.aimux/worktrees/${name}`, name })),
      ];

      const distances = colors.flatMap((color, index) =>
        colors.slice(index + 1).map((other) => colorDistance(color, other)),
      );
      expect(Math.min(...distances)).toBeGreaterThan(60);
    }
  });

  it("keeps tealstreet-next dashboard colors distinct", () => {
    const root = "/Users/sam/cs/tealstreet-next";
    const colors = new Map([
      ["main", worktreeColorHex({ path: root, name: "main" })],
      ...[
        "context-mcp",
        "affiliates",
        "auto-api-sync",
        "data-analytics",
        "custom-modules-mcp",
        "e2e-audit",
        "okx-open-stops",
        "v2-key-sync",
      ].map((name): [string, string] => [name, worktreeColorHex({ path: `${root}/.aimux/worktrees/${name}`, name })]),
    ]);

    expect(colors).toEqual(
      new Map([
        ["main", "#f477ae"],
        ["context-mcp", "#854ee6"],
        ["affiliates", "#70f09e"],
        ["auto-api-sync", "#d7a558"],
        ["data-analytics", "#50b191"],
        ["custom-modules-mcp", "#d2418b"],
        ["e2e-audit", "#83e5e0"],
        ["okx-open-stops", "#4b85f3"],
        ["v2-key-sync", "#66b141"],
      ]),
    );
  });

  it("prefers path and falls back to project plus name", () => {
    expect(worktreeColorKey({ path: "/repo", projectRoot: "/other", name: "main" })).toBe("path:/repo");
    expect(worktreeColorKey({ projectRoot: "/repo", name: "main" })).toBe("project-root:/repo\0name:main");
    expect(worktreeColorKey({ name: "scratch" })).toBe("name:scratch");
  });
});
