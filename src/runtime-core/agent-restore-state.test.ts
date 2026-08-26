import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../atomic-write.js";
import { getProjectStateDir, initPaths } from "../paths.js";
import {
  acknowledgeAgentRestoreOffer,
  deriveAgentRestoreOffer,
  readAgentRestoreOffer,
  readLastOnlineAgentsSnapshot,
  recordLastOnlineAgents,
  reconcileAgentRestoreOfferWithRestorableSessions,
  removeAgentRestoreOfferSessions,
} from "./agent-restore-state.js";

describe("agent restore state", () => {
  let previousAimuxHome: string | undefined;
  let aimuxHome = "";
  let repoRoot = "";

  beforeEach(async () => {
    previousAimuxHome = process.env.AIMUX_HOME;
    aimuxHome = mkdtempSync(join(tmpdir(), "aimux-agent-restore-home-"));
    process.env.AIMUX_HOME = aimuxHome;
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-agent-restore-repo-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
    if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousAimuxHome;
  });

  it("records current online agents without prompting in the same process", () => {
    const first = recordLastOnlineAgents(
      [
        { id: "claude-1", command: "claude", label: "claude(coder)" },
        { id: "codex-2", command: "codex", worktreePath: join(repoRoot, ".aimux/worktrees/feat") },
      ],
      { now: "2026-08-22T01:00:00.000Z" },
    );

    expect(readLastOnlineAgentsSnapshot()?.sessionIds).toEqual(["claude-1", "codex-2"]);
    expect(deriveAgentRestoreOffer([], { now: "2026-08-22T01:01:00.000Z" })).toBeNull();

    const second = recordLastOnlineAgents(
      [
        { id: "claude-1", command: "claude", label: "claude(coder)" },
        { id: "codex-2", command: "codex", worktreePath: join(repoRoot, ".aimux/worktrees/feat") },
      ],
      { now: "2026-08-22T01:10:00.000Z" },
    );
    expect(second?.updatedAt).toBe(first?.updatedAt);
  });

  it("creates a one-shot offer from a previous writer instance", () => {
    writeJsonAtomic(join(getProjectStateDir(), "last-online-agents.json"), {
      version: 1,
      id: "snapshot-old",
      writerInstanceId: "previous-process",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
      sessionIds: ["claude-1", "codex-2"],
      sessions: [
        { id: "claude-1", command: "claude", label: "claude(coder)" },
        { id: "codex-2", command: "codex", label: "codex(coder)" },
      ],
    });

    const offer = deriveAgentRestoreOffer([], { now: "2026-08-22T01:02:00.000Z" });

    expect(offer?.snapshotId).toBe("snapshot-old");
    expect(offer?.sessionIds).toEqual(["claude-1", "codex-2"]);
    expect(offer?.worktreeGroups).toEqual([{ name: "Main Checkout", count: 2 }]);
    expect(readAgentRestoreOffer()?.sessionIds).toEqual(["claude-1", "codex-2"]);

    acknowledgeAgentRestoreOffer();

    expect(readAgentRestoreOffer()).toBeNull();
    expect(deriveAgentRestoreOffer([], { now: "2026-08-22T01:03:00.000Z" })).toBeNull();
  });

  it("does not create a previous-writer offer while any agent is live", () => {
    writeJsonAtomic(join(getProjectStateDir(), "last-online-agents.json"), {
      version: 1,
      id: "snapshot-old",
      writerInstanceId: "previous-process",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
      sessionIds: ["claude-1", "codex-2"],
      sessions: [
        { id: "claude-1", command: "claude", label: "claude(coder)" },
        { id: "codex-2", command: "codex", label: "codex(coder)" },
      ],
    });

    expect(deriveAgentRestoreOffer(["claude-1"], { now: "2026-08-22T01:02:00.000Z" })).toBeNull();
    expect(readAgentRestoreOffer()).toBeNull();
  });

  it("starts a new prompt generation when a new writer records the same session ids", () => {
    writeJsonAtomic(join(getProjectStateDir(), "last-online-agents.json"), {
      version: 1,
      id: "snapshot-old",
      writerInstanceId: "previous-process",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
      sessionIds: ["claude-1"],
      sessions: [{ id: "claude-1", command: "claude" }],
    });
    deriveAgentRestoreOffer([], { now: "2026-08-22T01:01:00.000Z" });
    acknowledgeAgentRestoreOffer();

    const fresh = recordLastOnlineAgents([{ id: "claude-1", command: "claude" }], {
      now: "2026-08-22T01:02:00.000Z",
    });

    expect(fresh).not.toBeNull();
    expect(fresh?.id).not.toBe("snapshot-old");
    writeJsonAtomic(join(getProjectStateDir(), "last-online-agents.json"), {
      ...fresh!,
      writerInstanceId: "next-process",
    });
    expect(deriveAgentRestoreOffer([], { now: "2026-08-22T01:03:00.000Z" })?.snapshotId).toBe(fresh?.id);
  });

  it("continues updating the online snapshot while an old offer is unresolved", () => {
    writeJsonAtomic(join(getProjectStateDir(), "last-online-agents.json"), {
      version: 1,
      id: "snapshot-old",
      writerInstanceId: "previous-process",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
      sessionIds: ["claude-old"],
      sessions: [{ id: "claude-old", command: "claude" }],
    });
    deriveAgentRestoreOffer([], { now: "2026-08-22T01:01:00.000Z" });

    recordLastOnlineAgents([{ id: "codex-new", command: "codex" }], { now: "2026-08-22T01:02:00.000Z" });

    expect(readAgentRestoreOffer()?.sessionIds).toEqual(["claude-old"]);
    const latest = readLastOnlineAgentsSnapshot();
    expect(latest?.sessionIds).toEqual(["codex-new"]);

    writeJsonAtomic(join(getProjectStateDir(), "last-online-agents.json"), {
      ...latest!,
      writerInstanceId: "next-process",
    });

    expect(deriveAgentRestoreOffer([], { now: "2026-08-22T01:03:00.000Z" })?.sessionIds).toEqual(["codex-new"]);
  });

  it("removes restored sessions and acknowledges the offer after the last one", () => {
    writeJsonAtomic(join(getProjectStateDir(), "last-online-agents.json"), {
      version: 1,
      id: "snapshot-old",
      writerInstanceId: "previous-process",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
      sessionIds: ["claude-1", "codex-2"],
      sessions: [
        { id: "claude-1", command: "claude" },
        { id: "codex-2", command: "codex" },
      ],
    });
    deriveAgentRestoreOffer([], { now: "2026-08-22T01:02:00.000Z" });

    expect(removeAgentRestoreOfferSessions(["claude-1"])?.sessionIds).toEqual(["codex-2"]);
    expect(removeAgentRestoreOfferSessions(["codex-2"])).toBeNull();
    expect(readAgentRestoreOffer()).toBeNull();
    expect(deriveAgentRestoreOffer([], { now: "2026-08-22T01:03:00.000Z" })).toBeNull();
  });

  it("reconciles stale offers to the currently restorable offline inventory", () => {
    const worktreePath = join(repoRoot, ".aimux/worktrees/feature-a");
    writeJsonAtomic(join(getProjectStateDir(), "last-online-agents.json"), {
      version: 1,
      id: "snapshot-old",
      writerInstanceId: "previous-process",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
      sessionIds: ["claude-ready", "codex-ready", "claude-stale", "codex-blocked"],
      sessions: [
        { id: "claude-ready", command: "claude", worktreePath: repoRoot },
        { id: "codex-ready", command: "codex", worktreePath },
        { id: "claude-stale", command: "claude", worktreePath },
        { id: "codex-blocked", command: "codex", worktreePath },
      ],
    });
    const offer = deriveAgentRestoreOffer([], { now: "2026-08-22T01:02:00.000Z" });

    const reconciled = reconcileAgentRestoreOfferWithRestorableSessions(offer, ["claude-ready", "codex-ready"]);

    expect(reconciled?.sessionIds).toEqual(["claude-ready", "codex-ready"]);
    expect(reconciled?.worktreeGroups).toEqual([
      { name: "Main Checkout", count: 1 },
      { name: "feature-a", count: 1, path: worktreePath },
    ]);
    expect(readAgentRestoreOffer()?.sessionIds).toEqual(["claude-ready", "codex-ready"]);
  });

  it("groups legacy and repo-root main checkout sessions together", () => {
    writeJsonAtomic(join(getProjectStateDir(), "last-online-agents.json"), {
      version: 1,
      id: "snapshot-main-mixed",
      writerInstanceId: "previous-process",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
      sessionIds: ["claude-legacy", "codex-main"],
      sessions: [
        { id: "claude-legacy", command: "claude" },
        { id: "codex-main", command: "codex", worktreePath: repoRoot },
      ],
    });

    const offer = deriveAgentRestoreOffer([], { now: "2026-08-22T01:02:00.000Z" });

    expect(offer?.worktreeGroups).toEqual([{ name: "Main Checkout", count: 2 }]);
  });

  it("deletes stale inventory-derived restore offers without prompting", () => {
    const staleOfferPath = join(getProjectStateDir(), "agent-restore-offer.json");
    writeJsonAtomic(staleOfferPath, {
      version: 1,
      id: "restore-inventory-old",
      snapshotId: "inventory-old",
      snapshotUpdatedAt: "2026-08-22T01:00:00.000Z",
      source: "restorable-inventory",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
      sessionIds: ["codex-stale"],
      sessions: [{ id: "codex-stale", command: "codex" }],
    });

    expect(readAgentRestoreOffer()).toBeNull();
    expect(existsSync(staleOfferPath)).toBe(false);
    expect(deriveAgentRestoreOffer([], { now: "2026-08-22T01:01:00.000Z" })).toBeNull();
  });
});
