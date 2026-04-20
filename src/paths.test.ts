import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getProjectIdFor } from "./paths.js";

describe("path project identity", () => {
  it("resolves aimux-managed worktrees to the parent project", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-paths-"));
    try {
      const worktreePath = join(repoRoot, ".aimux", "worktrees", "feature-a");
      expect(getProjectIdFor(worktreePath)).toBe(getProjectIdFor(repoRoot));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
