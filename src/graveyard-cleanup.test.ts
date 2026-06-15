import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildGraveyardCleanupPlan, deleteGraveyardAgent, runGraveyardCleanup } from "./graveyard-cleanup.js";
import { getContextDir, getHistoryDir, getPlansDir, getRecordingsDir, getStatusDir, initPaths } from "./paths.js";
import { loadMetadataState, updateSessionMetadata } from "./metadata-store.js";
import {
  listTopologySessionStates,
  moveTopologySessionToGraveyard,
  upsertTopologySession,
} from "./runtime-core/topology-sessions.js";

describe("graveyard cleanup", () => {
  let repoRoot = "";
  let aimuxHome = "";
  let previousAimuxHome: string | undefined;

  beforeEach(async () => {
    previousAimuxHome = process.env.AIMUX_HOME;
    aimuxHome = mkdtempSync(join(tmpdir(), "aimux-cleanup-home-"));
    process.env.AIMUX_HOME = aimuxHome;
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-cleanup-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
    if (previousAimuxHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = previousAimuxHome;
    }
  });

  it("plans agents and worktrees whose graveyard lifetime has expired", () => {
    const plan = buildGraveyardCleanupPlan({
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: 14 },
      sessions: [
        {
          id: "expired-agent",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          status: "graveyard",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          id: "fresh-agent",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          status: "graveyard",
          updatedAt: "2026-06-01T00:00:01.000Z",
          graveyardedAt: "2026-06-01T00:00:01.000Z",
        },
      ],
      worktrees: [
        {
          id: "old-worktree",
          path: "/repo/.aimux/worktrees/old",
          name: "old",
          graveyardedAt: "2026-05-31T00:00:00.000Z",
        },
        {
          id: "fresh-worktree",
          path: "/repo/.aimux/worktrees/fresh",
          name: "fresh",
          graveyardedAt: "2026-06-01T00:00:01.000Z",
        },
      ],
    });

    expect(plan.cutoff).toBe("2026-05-31T00:00:00.000Z");
    expect(plan.agents).toMatchObject([{ sessionId: "expired-agent", graveyardedAt: "2026-05-30T00:00:00.000Z" }]);
    expect(plan.worktrees).toMatchObject([{ path: "/repo/.aimux/worktrees/old", name: "old" }]);
  });

  it("returns an empty plan when cleanup is disabled", () => {
    const plan = buildGraveyardCleanupPlan({
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: false, retentionDays: 14 },
      sessions: [
        {
          id: "expired-agent",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          status: "graveyard",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
      ],
      worktrees: [{ id: "old-worktree", path: "/repo/old", graveyardedAt: "2026-05-31T00:00:00.000Z" }],
    });

    expect(plan.enabled).toBe(false);
    expect(plan.agents).toEqual([]);
    expect(plan.worktrees).toEqual([]);
  });

  it("falls back to the default retention when config retention is not numeric", () => {
    const plan = buildGraveyardCleanupPlan({
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: null as unknown as number },
      sessions: [
        {
          id: "recent-agent",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          status: "graveyard",
          updatedAt: "2026-06-10T00:00:00.000Z",
        },
      ],
      worktrees: [],
    });

    expect(plan.retentionDays).toBe(14);
    expect(plan.agents).toEqual([]);
  });

  it("does not run standalone agent cleanup for agents under an expired worktree", async () => {
    const deleteAgent = vi.fn();
    const deleteWorktree = vi.fn(() => ({ path: "/repo/.aimux/worktrees/old", status: "removed" }));
    const plan = buildGraveyardCleanupPlan({
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: 14 },
      sessions: [
        {
          id: "codex-old",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          status: "graveyard",
          worktreePath: "/repo/.aimux/worktrees/old",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
      ],
      worktrees: [
        {
          id: "old-worktree",
          path: "/repo/.aimux/worktrees/old",
          name: "old",
          graveyardedAt: "2026-05-31T00:00:00.000Z",
        },
      ],
    });

    const result = await runGraveyardCleanup(plan, { deleteAgent, deleteWorktree });

    expect(deleteWorktree).toHaveBeenCalledWith("/repo/.aimux/worktrees/old");
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result.results).toEqual([{ kind: "worktree", id: "/repo/.aimux/worktrees/old", status: "removed" }]);
  });

  it("continues dependent agent cleanup when expired worktree cleanup fails", async () => {
    const deleteAgent = vi.fn(() => ({ sessionId: "codex-old", removedAssets: [] }));
    const deleteWorktree = vi.fn(() => {
      throw new Error("worktree remove failed");
    });
    const plan = buildGraveyardCleanupPlan({
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: 14 },
      sessions: [
        {
          id: "codex-old",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          status: "graveyard",
          worktreePath: "/repo/.aimux/worktrees/old",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
      ],
      worktrees: [
        {
          id: "old-worktree",
          path: "/repo/.aimux/worktrees/old",
          name: "old",
          graveyardedAt: "2026-05-31T00:00:00.000Z",
        },
      ],
    });

    const result = await runGraveyardCleanup(plan, { deleteAgent, deleteWorktree });

    expect(deleteWorktree).toHaveBeenCalledWith("/repo/.aimux/worktrees/old");
    expect(deleteAgent).toHaveBeenCalledWith("codex-old");
    expect(result.results).toEqual([
      {
        kind: "worktree",
        id: "/repo/.aimux/worktrees/old",
        status: "failed",
        error: "worktree remove failed",
      },
      { kind: "agent", id: "codex-old", status: "removed", removedAssets: [] },
    ]);
  });

  it("continues dependent agent cleanup when expired worktree cleanup reports a non-removed status", async () => {
    const deleteAgent = vi.fn(() => ({ sessionId: "codex-old", removedAssets: [] }));
    const deleteWorktree = vi.fn(() => ({ path: "/repo/.aimux/worktrees/old", status: "not-found" }));
    const plan = buildGraveyardCleanupPlan({
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: 14 },
      sessions: [
        {
          id: "codex-old",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          status: "graveyard",
          worktreePath: "/repo/.aimux/worktrees/old",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
      ],
      worktrees: [
        {
          id: "old-worktree",
          path: "/repo/.aimux/worktrees/old",
          name: "old",
          graveyardedAt: "2026-05-31T00:00:00.000Z",
        },
      ],
    });

    const result = await runGraveyardCleanup(plan, { deleteAgent, deleteWorktree });

    expect(deleteWorktree).toHaveBeenCalledWith("/repo/.aimux/worktrees/old");
    expect(deleteAgent).toHaveBeenCalledWith("codex-old");
    expect(result.results).toEqual([
      {
        kind: "worktree",
        id: "/repo/.aimux/worktrees/old",
        status: "failed",
        error: 'worktree cleanup returned non-removed status "not-found"',
      },
      { kind: "agent", id: "codex-old", status: "removed", removedAssets: [] },
    ]);
  });

  it("dry-run reports worktree and standalone agent targets without deleting them", async () => {
    const deleteAgent = vi.fn();
    const deleteWorktree = vi.fn();
    const plan = buildGraveyardCleanupPlan({
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: 14 },
      sessions: [
        {
          id: "codex-old",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          status: "graveyard",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
      ],
      worktrees: [
        {
          id: "old-worktree",
          path: "/repo/.aimux/worktrees/old",
          name: "old",
          graveyardedAt: "2026-05-31T00:00:00.000Z",
        },
      ],
    });

    const result = await runGraveyardCleanup(plan, { deleteAgent, deleteWorktree }, { dryRun: true });

    expect(deleteAgent).not.toHaveBeenCalled();
    expect(deleteWorktree).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      { kind: "worktree", id: "/repo/.aimux/worktrees/old", status: "dry-run" },
      { kind: "agent", id: "codex-old", status: "dry-run" },
    ]);
  });

  it("deletes standalone graveyard agent topology, metadata, and per-session assets", () => {
    upsertTopologySession(
      {
        id: "codex-old",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
      },
      "offline",
    );
    moveTopologySessionToGraveyard("codex-old", { now: "2026-05-30T00:00:00.000Z" });
    updateSessionMetadata("codex-old", (current) => ({ ...current, status: { text: "done" } }));

    const contextDir = join(getContextDir(), "codex-old");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(getRecordingsDir(), { recursive: true });
    writeFileSync(join(contextDir, "live.md"), "live\n");
    writeFileSync(join(getRecordingsDir(), "codex-old.log"), "raw\n");
    writeFileSync(join(getRecordingsDir(), "codex-old.txt"), "text\n");
    writeFileSync(join(getHistoryDir(), "codex-old.jsonl"), "{}\n");
    writeFileSync(join(getPlansDir(), "codex-old.md"), "# plan\n");
    writeFileSync(join(getStatusDir(), "codex-old.md"), "status\n");

    const deleted = deleteGraveyardAgent("codex-old");

    expect(deleted.sessionId).toBe("codex-old");
    expect(deleted.removedAssets).toEqual(
      expect.arrayContaining([
        join(getRecordingsDir(), "codex-old.log"),
        join(getRecordingsDir(), "codex-old.txt"),
        join(getHistoryDir(), "codex-old.jsonl"),
        contextDir,
        join(getPlansDir(), "codex-old.md"),
        join(getStatusDir(), "codex-old.md"),
      ]),
    );
    expect(existsSync(contextDir)).toBe(false);
    expect(existsSync(join(getRecordingsDir(), "codex-old.log"))).toBe(false);
    expect(loadMetadataState().sessions["codex-old"]).toBeUndefined();
    expect(listTopologySessionStates({ statuses: ["graveyard"] })).toEqual([]);
  });
});
