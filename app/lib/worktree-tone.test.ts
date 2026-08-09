import { describe, expect, it } from "vitest";
import { WORKTREE_TONES, worktreeIdentity } from "./worktree-tone";

const bucket = (name: string, path: string | null, branch = "b") =>
  ({
    key: name,
    name,
    branch,
    path,
    isMainCheckout: false,
    sessions: [],
    services: [],
  }) as never;

const groups = [
  bucket("main", "/p", "master"),
  bucket("e2e-audit", "/p/wt/e2e-audit", "fix/e2e"),
  bucket("mcp", "/p/wt/mcp"),
];

describe("worktreeIdentity", () => {
  it("assigns tones by position, so the first six worktrees differ", () => {
    expect(worktreeIdentity(groups, { path: "/p" })?.tone).toBe(WORKTREE_TONES[0]);
    expect(worktreeIdentity(groups, { path: "/p/wt/e2e-audit" })?.tone).toBe(WORKTREE_TONES[1]);
    expect(worktreeIdentity(groups, { path: "/p/wt/mcp" })?.tone).toBe(WORKTREE_TONES[2]);
  });

  it("names the worktree from the group, since a running session carries only a path", () => {
    // The whole point: `worktreeName` is undefined on every live session, so a
    // header reading it directly fell back to the generated session label.
    expect(worktreeIdentity(groups, { path: "/p/wt/e2e-audit" })).toEqual({
      name: "e2e-audit",
      branch: "fix/e2e",
      tone: WORKTREE_TONES[1],
    });
  });

  it("matches on path before name, since every project's root is called main", () => {
    // A name-first match would hand the root's tone to any worktree also named main.
    const shadowed = [bucket("main", "/other"), bucket("main", "/p")];
    expect(worktreeIdentity(shadowed, { path: "/p", name: "main" })?.tone).toBe(WORKTREE_TONES[1]);
  });

  it("falls back to the name when the group carries no path", () => {
    expect(worktreeIdentity([bucket("solo", null)], { name: "solo" })?.name).toBe("solo");
  });

  it("wraps around the palette rather than running out", () => {
    const many = Array.from({ length: 7 }, (_, i) => bucket(`w${i}`, `/p/w${i}`));
    expect(worktreeIdentity(many, { path: "/p/w6" })?.tone).toBe(WORKTREE_TONES[0]);
  });

  it("returns nothing when the worktree is unknown or there are no groups", () => {
    expect(worktreeIdentity(groups, { path: "/p/wt/gone" })).toBeUndefined();
    expect(worktreeIdentity([], { path: "/p" })).toBeUndefined();
    expect(worktreeIdentity(undefined, { path: "/p" })).toBeUndefined();
    expect(worktreeIdentity(groups, {})).toBeUndefined();
  });
});
