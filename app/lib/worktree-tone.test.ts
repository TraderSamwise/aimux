import { describe, expect, it } from "vitest";
import { worktreeIdentity, worktreeToneForBucket } from "./worktree-tone";

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
  it("assigns tones by identity, not by position", () => {
    expect(worktreeIdentity(groups, { path: "/p" })?.tone).toBe(worktreeToneForBucket(groups[0]!));
    expect(worktreeIdentity(groups, { path: "/p/wt/e2e-audit" })?.tone).toBe(
      worktreeToneForBucket(groups[1]!),
    );
    expect(worktreeIdentity(groups, { path: "/p/wt/mcp" })?.tone).toBe(
      worktreeToneForBucket(groups[2]!),
    );
  });

  it("names the worktree from the group, since a running session carries only a path", () => {
    // The whole point: `worktreeName` is undefined on every live session, so a
    // header reading it directly fell back to the generated session label.
    expect(worktreeIdentity(groups, { path: "/p/wt/e2e-audit" })).toEqual({
      name: "e2e-audit",
      branch: "fix/e2e",
      tone: worktreeToneForBucket(groups[1]!),
    });
  });

  it("matches on path before name, since every project's root is called main", () => {
    // A name-first match would hand the root's tone to any worktree also named main.
    const shadowed = [bucket("main", "/other"), bucket("main", "/p")];
    expect(worktreeIdentity(shadowed, { path: "/p", name: "main" })?.tone).toBe(
      worktreeToneForBucket(shadowed[1]!),
    );
  });

  it("falls back to the name when the group carries no path", () => {
    const [solo] = [bucket("solo", null)];
    expect(worktreeIdentity([solo], { name: "solo", projectRoot: "/p" })).toEqual({
      name: "solo",
      branch: "b",
      tone: worktreeToneForBucket(solo!, "/p"),
    });
  });

  it("keeps a worktree tone stable when other groups disappear", () => {
    const target = bucket("w6", "/p/w6");
    const many = Array.from({ length: 7 }, (_, i) =>
      i === 6 ? target : bucket(`w${i}`, `/p/w${i}`),
    );
    expect(worktreeIdentity(many, { path: "/p/w6" })?.tone).toBe(
      worktreeIdentity([target], { path: "/p/w6" })?.tone,
    );
  });

  it("returns nothing when the worktree is unknown or there are no groups", () => {
    expect(worktreeIdentity(groups, { path: "/p/wt/gone" })).toBeUndefined();
    expect(worktreeIdentity([], { path: "/p" })).toBeUndefined();
    expect(worktreeIdentity(undefined, { path: "/p" })).toBeUndefined();
    expect(worktreeIdentity(groups, {})).toBeUndefined();
  });
});
