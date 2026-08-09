import { describe, expect, it } from "vitest";
import { WORKTREE_TONES, worktreeTone } from "./worktree-tone";

const bucket = (name: string, path: string | null) =>
  ({
    key: name,
    name,
    branch: "b",
    path,
    isMainCheckout: false,
    sessions: [],
    services: [],
  }) as never;

const groups = [
  bucket("main", "/p"),
  bucket("e2e-audit", "/p/wt/e2e-audit"),
  bucket("mcp", "/p/wt/mcp"),
];

describe("worktreeTone", () => {
  it("assigns tones by position, so the first six worktrees differ", () => {
    expect(worktreeTone(groups, { path: "/p" })).toBe(WORKTREE_TONES[0]);
    expect(worktreeTone(groups, { path: "/p/wt/e2e-audit" })).toBe(WORKTREE_TONES[1]);
    expect(worktreeTone(groups, { path: "/p/wt/mcp" })).toBe(WORKTREE_TONES[2]);
  });

  it("matches on path before name, since every project's root is called main", () => {
    // A name-first match would hand the root's tone to any worktree also named main.
    const shadowed = [bucket("main", "/other"), bucket("main", "/p")];
    expect(worktreeTone(shadowed, { path: "/p", name: "main" })).toBe(WORKTREE_TONES[1]);
  });

  it("falls back to the name when the group carries no path", () => {
    expect(worktreeTone([bucket("solo", null)], { name: "solo" })).toBe(WORKTREE_TONES[0]);
  });

  it("wraps around the palette rather than running out", () => {
    const many = Array.from({ length: 7 }, (_, i) => bucket(`w${i}`, `/p/w${i}`));
    expect(worktreeTone(many, { path: "/p/w6" })).toBe(WORKTREE_TONES[0]);
  });

  it("returns nothing when the worktree is unknown or there are no groups", () => {
    expect(worktreeTone(groups, { path: "/p/wt/gone" })).toBeUndefined();
    expect(worktreeTone([], { path: "/p" })).toBeUndefined();
    expect(worktreeTone(undefined, { path: "/p" })).toBeUndefined();
    expect(worktreeTone(groups, {})).toBeUndefined();
  });
});
