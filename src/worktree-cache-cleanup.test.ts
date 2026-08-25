import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initPaths } from "./paths.js";
import { upsertTopologyService } from "./runtime-core/topology-services.js";
import { upsertTopologySession } from "./runtime-core/topology-sessions.js";
import { buildWorktreeCacheCleanupPlan, runWorktreeCacheCleanup } from "./worktree-cache-cleanup.js";

describe("worktree cache cleanup", () => {
  let tmpRoot = "";
  let projectRoot = "";
  let worktreeRoot = "";

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "aimux-worktree-cache-cleanup-"));
    projectRoot = join(tmpRoot, "repo");
    worktreeRoot = join(projectRoot, ".aimux", "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    projectRoot = realpathSync(projectRoot);
    worktreeRoot = realpathSync(worktreeRoot);
    await initPaths(projectRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeCache(path: string): void {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "payload.txt"), "cache\n");
  }

  it("plans nested cache directories in Aimux-managed worktrees", () => {
    const worktreePath = join(worktreeRoot, "perf");
    writeCache(join(worktreePath, "node_modules"));
    writeCache(join(worktreePath, "apps", "web", ".next"));

    const plan = buildWorktreeCacheCleanupPlan({
      projectRoot,
      worktreeBaseDir: worktreeRoot,
      worktrees: [
        { name: "repo", branch: "master", path: projectRoot, isBare: false },
        { name: "perf", branch: "perf", path: worktreePath, isBare: false },
      ],
    });

    expect(plan.targets.map((target) => target.relativePath).sort()).toEqual(["apps/web/.next", "node_modules"]);
    expect(plan.skipped).toContainEqual({ worktreePath: projectRoot, reason: "main-worktree" });
    expect(plan.reclaimableBytes).toBeGreaterThan(0);
  });

  it("skips worktrees with active agents or services by default", () => {
    const worktreePath = join(worktreeRoot, "live");
    writeCache(join(worktreePath, "node_modules"));
    upsertTopologySession({ id: "codex-live", tool: "codex", command: "codex", args: [], worktreePath }, "idle", {
      projectRoot,
    });
    upsertTopologyService({ id: "web", command: "yarn", worktreePath }, "starting", { projectRoot });

    const plan = buildWorktreeCacheCleanupPlan({
      projectRoot,
      worktreeBaseDir: worktreeRoot,
      worktrees: [{ name: "live", branch: "live", path: worktreePath, isBare: false }],
    });

    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toMatchObject([
      { worktreePath, reason: "active-runtime", sessions: ["codex-live"], services: ["web"] },
    ]);
  });

  it("removes planned cache directories only when dry run is disabled", () => {
    const worktreePath = join(worktreeRoot, "old");
    const cachePath = join(worktreePath, "apps", "web", ".next");
    writeCache(cachePath);

    const dryRun = runWorktreeCacheCleanup({
      projectRoot,
      worktreeBaseDir: worktreeRoot,
      worktrees: [{ name: "old", branch: "old", path: worktreePath, isBare: false }],
    });

    expect(dryRun.dryRun).toBe(true);
    expect(existsSync(cachePath)).toBe(true);

    const deleted = runWorktreeCacheCleanup({
      projectRoot,
      worktreeBaseDir: worktreeRoot,
      dryRun: false,
      worktrees: [{ name: "old", branch: "old", path: worktreePath, isBare: false }],
    });

    expect(deleted.results).toMatchObject([{ path: cachePath, status: "removed" }]);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("ignores configured cleanup names outside the generated-cache allowlist", () => {
    const worktreePath = join(worktreeRoot, "unsafe-config");
    const sourcePath = join(worktreePath, "src");
    const cachePath = join(worktreePath, "node_modules");
    writeCache(sourcePath);
    writeCache(cachePath);

    const deleted = runWorktreeCacheCleanup({
      projectRoot,
      worktreeBaseDir: worktreeRoot,
      dryRun: false,
      cacheDirNames: ["src", "node_modules"],
      worktrees: [{ name: "unsafe-config", branch: "unsafe-config", path: worktreePath, isBare: false }],
    });

    expect(deleted.results).toMatchObject([{ path: cachePath, status: "removed" }]);
    expect(existsSync(cachePath)).toBe(false);
    expect(existsSync(sourcePath)).toBe(true);
  });
});
