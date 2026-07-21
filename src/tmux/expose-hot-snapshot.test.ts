import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHotExposeScopeView, writeHotExposeScopeView } from "./expose-hot-snapshot.js";
import type { ExposeScopeItem, ExposeScopeView } from "./expose-model.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function createStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "aimux-expose-hot-snapshot-test-"));
  tempRoots.push(root);
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  return stateDir;
}

function item(id = "session-1", windowId = "@1"): ExposeScopeItem {
  return {
    id,
    label: id,
    urgency: 0,
    activity: 0,
    recentRank: 0,
    previewSnapshot: {
      output: "warm preview\n",
      capturedAt: "2026-07-20T13:00:00.000Z",
      source: "capture",
      windowId,
      startLine: -40,
      lineCount: 40,
    },
    target: { sessionName: "aimux-test", windowId, windowIndex: 1, windowName: id },
    metadata: {
      kind: "agent",
      sessionId: id,
      command: "codex",
      args: [],
      toolConfigKey: "codex",
      worktreePath: "/repo",
    },
  };
}

function view(scope: ExposeScopeView["scope"], items = [item()]): ExposeScopeView {
  return {
    scope,
    items,
    scopeLabel: scope === "global" ? "all projects" : scope === "worktree" ? "this worktree" : "all worktrees",
    sublabel: scope === "global" ? "project-worktree" : scope === "worktree" ? "none" : "worktree",
  };
}

describe("expose hot snapshots", () => {
  it("round-trips a valid scoped snapshot", () => {
    const stateDir = createStateDir();
    writeHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" }, view("project"));

    expect(readHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" })).toMatchObject({
      scope: "project",
      items: [{ id: "session-1", previewSnapshot: { output: "warm preview\n" } }],
    });
  });

  it("does not reuse one worktree snapshot for another worktree", () => {
    const stateDir = createStateDir();
    writeHotExposeScopeView(
      stateDir,
      { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo/worktrees/a" },
      view("worktree", [item("a", "@1")]),
    );

    expect(
      readHotExposeScopeView(stateDir, {
        projectRoot: "/repo",
        scope: "worktree",
        worktreeKey: "/repo/worktrees/b",
      }),
    ).toBeNull();
  });

  it("does not reuse one launch window snapshot for another worktree launcher", () => {
    const stateDir = createStateDir();
    writeHotExposeScopeView(
      stateDir,
      { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo", launchWindowId: "@1" },
      view("worktree", [item("a", "@1")]),
    );

    expect(
      readHotExposeScopeView(stateDir, {
        projectRoot: "/repo",
        scope: "worktree",
        worktreeKey: "/repo",
        launchWindowId: "@2",
      }),
    ).toBeNull();
  });

  it("ignores malformed or expired cache files", () => {
    const stateDir = createStateDir();
    const path = join(stateDir, "expose-hot-snapshots.json");
    writeFileSync(path, "{");
    expect(readHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" })).toBeNull();

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        views: {
          "project|%2Frepo||": {
            ...view("project"),
            projectRoot: "/repo",
            updatedAt: "2020-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    expect(readHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" })).toBeNull();
  });

  it("replaces a malformed cache file on the next successful write", () => {
    const stateDir = createStateDir();
    writeFileSync(join(stateDir, "expose-hot-snapshots.json"), "{");

    writeHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" }, view("project"));

    expect(
      readHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" })?.items.map((i) => i.id),
    ).toEqual(["session-1"]);
  });

  it("writes derived cache files with owner-only permissions", () => {
    const stateDir = createStateDir();
    const path = join(stateDir, "expose-hot-snapshots.json");

    writeHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" }, view("project"));

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("recovers from a stale write lock", () => {
    const stateDir = createStateDir();
    const lockPath = join(stateDir, "expose-hot-snapshots.lock");
    mkdirSync(lockPath);
    const staleTime = new Date(Date.now() - 6000);
    utimesSync(lockPath, staleTime, staleTime);

    writeHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" }, view("project"));

    expect(readHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" })?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "session-1" })]),
    );
    expect(existsSync(lockPath)).toBe(false);
  });

  it("skips writes behind a live write lock without blocking", () => {
    const stateDir = createStateDir();
    const lockPath = join(stateDir, "expose-hot-snapshots.lock");
    mkdirSync(lockPath);

    const startedAt = Date.now();
    writeHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" }, view("project"));

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(readHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" })).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("bounds cached preview output and item count", () => {
    const stateDir = createStateDir();
    const items = Array.from({ length: 120 }, (_, index) => {
      const next = item(`session-${index}`, `@${index}`);
      next.previewSnapshot = {
        output: Array.from({ length: 120 }, (__, line) => `${line}:${"x".repeat(300)}`).join("\n"),
        capturedAt: "2026-07-20T13:00:00.000Z",
        source: "capture",
        windowId: next.target.windowId,
      };
      return next;
    });

    writeHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" }, view("project", items));
    const hot = readHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" });
    const output = hot?.items[0]?.previewSnapshot?.output ?? "";

    expect(hot?.items).toHaveLength(100);
    expect(output.split("\n").length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(readFileSync(join(stateDir, "expose-hot-snapshots.json"), "utf8")).not.toContain("session-119");
  });

  it("ignores cached items that are missing target or metadata shape", () => {
    const stateDir = createStateDir();
    writeFileSync(
      join(stateDir, "expose-hot-snapshots.json"),
      JSON.stringify({
        version: 1,
        views: {
          "project|%2Frepo||": {
            scope: "project",
            projectRoot: "/repo",
            scopeLabel: "all worktrees",
            sublabel: "worktree",
            updatedAt: new Date().toISOString(),
            items: [{ id: "bad", label: "bad", urgency: 0, activity: 0, recentRank: 0 }],
          },
        },
      }),
    );

    expect(readHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" })).toBeNull();
  });
});
