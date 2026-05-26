import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import { createRuntimeTopologyStore } from "./topology-store.js";
import {
  deleteTopologyWorktreeGraveyardEntry,
  listTopologyWorktreeGraveyard,
  listTopologyWorktreeGraveyardPaths,
  listTopologyWorktreeStates,
  moveTopologyWorktreeToGraveyard,
  removeTopologyWorktree,
  resurrectTopologyWorktreeFromGraveyard,
  upsertTopologyWorktree,
} from "./topology-worktrees.js";

describe("topology worktree lifecycle", () => {
  let repoRoot = "";
  let topologyPath = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-topology-worktrees-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    topologyPath = join(repoRoot, ".aimux", "runtime-topology.yaml");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("tracks active worktrees in topology", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const worktreePath = join(repoRoot, "../feature-a");

    upsertTopologyWorktree(
      {
        path: worktreePath,
        name: "feature-a",
        branch: "feature-a",
        basePath: repoRoot,
        createdAt: "2026-05-25T00:00:00.000Z",
      },
      "active",
      { store, projectRoot: repoRoot, now: "2026-05-25T00:00:00.000Z" },
    );

    expect(listTopologyWorktreeStates({ statuses: ["active"], store })).toMatchObject([
      {
        path: worktreePath,
        name: "feature-a",
        branch: "feature-a",
        basePath: repoRoot,
        status: "active",
      },
    ]);
  });

  it("moves worktrees to topology graveyard without deleting the authority record", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const worktreePath = join(repoRoot, "../feature-b");
    upsertTopologyWorktree({ path: worktreePath, name: "feature-b", branch: "feature-b" }, "active", {
      store,
      projectRoot: repoRoot,
      now: "2026-05-25T00:00:00.000Z",
    });

    const moved = moveTopologyWorktreeToGraveyard(worktreePath, {
      store,
      projectRoot: repoRoot,
      now: "2026-05-25T01:00:00.000Z",
      reason: "user-requested",
    });

    expect(moved).toMatchObject({
      path: worktreePath,
      name: "feature-b",
      branch: "feature-b",
      graveyardedAt: "2026-05-25T01:00:00.000Z",
      reason: "user-requested",
    });
    expect(listTopologyWorktreeStates({ statuses: ["graveyard"], store })).toMatchObject([
      { path: worktreePath, status: "graveyard", removedAt: "2026-05-25T01:00:00.000Z" },
    ]);
    expect(listTopologyWorktreeGraveyardPaths({ store })).toEqual(new Set([worktreePath]));
  });

  it("marks graveyard entries deleted while preserving audit history", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const worktreePath = join(repoRoot, "../feature-c");
    upsertTopologyWorktree({ path: worktreePath, name: "feature-c" }, "active", { store, projectRoot: repoRoot });
    moveTopologyWorktreeToGraveyard(worktreePath, {
      store,
      projectRoot: repoRoot,
      now: "2026-05-25T01:00:00.000Z",
    });

    const deleted = deleteTopologyWorktreeGraveyardEntry(worktreePath, {
      store,
      now: "2026-05-25T02:00:00.000Z",
    });

    expect(deleted?.deletedAt).toBe("2026-05-25T02:00:00.000Z");
    expect(listTopologyWorktreeGraveyard({ store })).toEqual([]);
    expect(listTopologyWorktreeGraveyard({ store, includeDeleted: true })).toMatchObject([
      { path: worktreePath, deletedAt: "2026-05-25T02:00:00.000Z" },
    ]);
  });

  it("resurrects topology graveyard entries back to active worktrees", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const worktreePath = join(repoRoot, "../feature-resurrect");
    upsertTopologyWorktree({ path: worktreePath, name: "feature-resurrect" }, "active", {
      store,
      projectRoot: repoRoot,
      now: "2026-05-25T00:00:00.000Z",
    });
    moveTopologyWorktreeToGraveyard(worktreePath, {
      store,
      projectRoot: repoRoot,
      now: "2026-05-25T01:00:00.000Z",
    });

    const resurrected = resurrectTopologyWorktreeFromGraveyard(worktreePath, {
      store,
      projectRoot: repoRoot,
      now: "2026-05-25T02:00:00.000Z",
    });

    expect(resurrected).toMatchObject({ path: worktreePath, status: "active" });
    expect(listTopologyWorktreeGraveyard({ store })).toEqual([]);
    expect(listTopologyWorktreeStates({ statuses: ["active"], store })).toMatchObject([
      { path: worktreePath, status: "active" },
    ]);
  });

  it("removes active worktree topology without creating graveyard state", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const worktreePath = join(repoRoot, "../feature-d");
    upsertTopologyWorktree({ path: worktreePath, name: "feature-d" }, "active", { store, projectRoot: repoRoot });

    const removed = removeTopologyWorktree(worktreePath, { store });

    expect(removed?.path).toBe(worktreePath);
    expect(listTopologyWorktreeStates({ store })).toEqual([]);
    expect(listTopologyWorktreeGraveyard({ store })).toEqual([]);
  });
});
