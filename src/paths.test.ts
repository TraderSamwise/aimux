import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  getDaemonLogPath,
  getDaemonStdioLogPath,
  getGlobalAimuxDir,
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

  it("uses AIMUX_HOME for runtime-private global state", () => {
    const previous = process.env.AIMUX_HOME;
    const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-home-"));
    try {
      process.env.AIMUX_HOME = aimuxHome;
      expect(getGlobalAimuxDir()).toBe(aimuxHome);
      expect(getDaemonLogPath()).toBe(join(aimuxHome, "daemon", "logs", "daemon.jsonl"));
    } finally {
      if (previous === undefined) {
        delete process.env.AIMUX_HOME;
      } else {
        process.env.AIMUX_HOME = previous;
      }
      rmSync(aimuxHome, { recursive: true, force: true });
    }
  });
});
