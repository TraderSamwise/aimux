import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  getProjectsRegistryPath,
  getDaemonLogPath,
  getDaemonStdioLogPath,
  getGlobalAimuxDir,
  getProjectIdFor,
  getProjectLogPathFor,
  getProjectServiceStdioLogPathFor,
  initPaths,
  listProjects,
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
    const previous = process.env.AIMUX_HOME;
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-log-paths-"));
    try {
      delete process.env.AIMUX_HOME;
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
      if (previous === undefined) {
        delete process.env.AIMUX_HOME;
      } else {
        process.env.AIMUX_HOME = previous;
      }
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

  it("does not register ephemeral tmp aimux roots as desktop projects", async () => {
    const previous = process.env.AIMUX_HOME;
    const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-home-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-transient-project-"));
    try {
      process.env.AIMUX_HOME = aimuxHome;

      await initPaths(repoRoot);

      expect(listProjects()).toEqual([]);
    } finally {
      if (previous === undefined) {
        delete process.env.AIMUX_HOME;
      } else {
        process.env.AIMUX_HOME = previous;
      }
      rmSync(aimuxHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("hard-fails instead of growing an over-cap project registry", async () => {
    const previous = process.env.AIMUX_HOME;
    const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-home-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "real-project-"));
    try {
      process.env.AIMUX_HOME = aimuxHome;
      const projects = Array.from({ length: 500 }, (_, index) => {
        const root = `/Users/example/project-${index}`;
        return {
          id: `${basename(root)}-${index}`,
          name: basename(root),
          repoRoot: root,
          lastSeen: new Date(0).toISOString(),
        };
      });
      mkdirSync(aimuxHome, { recursive: true });
      writeFileSync(getProjectsRegistryPath(), JSON.stringify({ version: 1, projects }, null, 2));

      await expect(initPaths(repoRoot)).rejects.toThrow(/project registry has 501 entries; cap is 500/);
    } finally {
      if (previous === undefined) {
        delete process.env.AIMUX_HOME;
      } else {
        process.env.AIMUX_HOME = previous;
      }
      rmSync(aimuxHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
