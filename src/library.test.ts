import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStubPlan, loadLibraryEntries } from "./library.js";

const STUB = `---
sessionId: claude-1
tool: claude
worktree: main
updatedAt: 2026-06-17T00:00:00.000Z
---

# Goal

TBD

# Current Status

TBD

# Steps

- [ ] TBD

# Notes

- None yet.
`;

const REAL_PLAN = `---
sessionId: claude-2
tool: claude
worktree: main
updatedAt: 2026-06-17T05:00:00.000Z
---

# Goal

Ship the library screen

# Steps

- [x] write loader
`;

describe("isStubPlan", () => {
  it("detects the untouched auto-generated stub", () => {
    expect(isStubPlan(STUB)).toBe(true);
  });
  it("treats a filled-in plan as non-stub", () => {
    expect(isStubPlan(REAL_PLAN)).toBe(false);
  });
});

describe("loadLibraryEntries", () => {
  let repoRoot = "";
  let plansDir = "";
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-library-"));
    plansDir = join(repoRoot, ".aimux", "plans");
    mkdirSync(plansDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("includes allowlisted project docs and non-stub plans, skips stubs", () => {
    writeFileSync(join(repoRoot, "README.md"), "# Project\nhello");
    writeFileSync(join(repoRoot, "AGENTS.md"), "# Agents");
    writeFileSync(join(repoRoot, "NOTALLOWED.md"), "# nope");
    writeFileSync(join(plansDir, "claude-1.md"), STUB);
    writeFileSync(join(plansDir, "claude-2.md"), REAL_PLAN);

    const entries = loadLibraryEntries({
      repoRoot,
      plansDir,
      resolveLabel: (id) => (id === "claude-2" ? "library agent" : undefined),
    });
    const ids = entries.map((e) => e.id);
    expect(ids).toContain("doc:README.md");
    expect(ids).toContain("doc:AGENTS.md");
    expect(ids).not.toContain("doc:NOTALLOWED.md");
    expect(ids).toContain("plan:claude-2");
    expect(ids).not.toContain("plan:claude-1"); // stub skipped
    const plan = entries.find((e) => e.id === "plan:claude-2")!;
    expect(plan.label).toBe("library agent");
    expect(plan.title).toBe("library agent");
    expect(plan.preview).toContain("Ship the library screen");
    expect(plan.preview).not.toContain("---"); // frontmatter stripped
  });

  it("sorts entries newest-first by updatedAt", () => {
    // README mtime forced older than the real plan's frontmatter updatedAt
    writeFileSync(join(repoRoot, "README.md"), "# old");
    const old = new Date("2026-06-16T00:00:00.000Z");
    utimesSync(join(repoRoot, "README.md"), old, old);
    writeFileSync(join(plansDir, "claude-2.md"), REAL_PLAN);

    const entries = loadLibraryEntries({ repoRoot, plansDir });
    expect(entries[0]!.id).toBe("plan:claude-2");
    expect(entries[1]!.id).toBe("doc:README.md");
  });

  it("falls back to mtime when a plan has no frontmatter updatedAt", () => {
    writeFileSync(join(plansDir, "claude-3.md"), "# Goal\n\nreal work, no frontmatter\n");
    const entries = loadLibraryEntries({ repoRoot, plansDir });
    const plan = entries.find((e) => e.id === "plan:claude-3")!;
    expect(plan.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns empty when nothing exists", () => {
    expect(loadLibraryEntries({ repoRoot, plansDir })).toEqual([]);
  });
});
