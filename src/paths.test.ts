import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  getDaemonLogPath,
  getDaemonStdioLogPath,
  getProjectIdFor,
  getProjectLogPathFor,
  getProjectServiceStdioLogPathFor,
} from "./paths.js";

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

  it("resolves persistent log paths", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-log-paths-"));
    try {
      const norm = (p: string) => p.replaceAll("\\", "/");
      expect(norm(getDaemonLogPath())).toMatch(/\.aimux\/daemon\/logs\/daemon\.jsonl$/);
      expect(norm(getDaemonStdioLogPath())).toMatch(/\.aimux\/daemon\/logs\/daemon-stdio\.log$/);
      expect(norm(getProjectLogPathFor(repoRoot))).toMatch(
        /\.aimux\/projects\/aimux-log-paths-.*\/logs\/aimux\.jsonl$/,
      );
      expect(norm(getProjectServiceStdioLogPathFor(repoRoot))).toMatch(
        /\.aimux\/projects\/aimux-log-paths-.*\/logs\/project-service-stdio\.log$/,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
