import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../atomic-write.js";
import { getProjectStateDir, initPaths } from "../paths.js";
import {
  acknowledgeAgentRestoreOffer,
  deriveAgentRestoreOffer,
  deriveAgentRestoreOfferFromRestorableInventory,
  readAgentRestoreOffer,
  readLastOnlineAgentsSnapshot,
  recordLastOnlineAgents,
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

  it("creates a one-shot offer from restorable inventory when no online snapshot exists", () => {
    const offer = deriveAgentRestoreOfferFromRestorableInventory(
      [],
      [{ id: "codex-offline", command: "codex", label: "codex(coder)" }],
      { now: "2026-08-22T01:04:00.000Z" },
    );

    expect(offer?.source).toBe("restorable-inventory");
    expect(offer?.sessionIds).toEqual(["codex-offline"]);
    expect(readAgentRestoreOffer()?.sessionIds).toEqual(["codex-offline"]);

    acknowledgeAgentRestoreOffer();

    expect(
      deriveAgentRestoreOfferFromRestorableInventory(
        [],
        [{ id: "codex-offline", command: "codex", label: "codex(coder)" }],
        { now: "2026-08-22T01:05:00.000Z" },
      ),
    ).toBeNull();
  });

  it("clears inventory offers when live agents are present", () => {
    expect(
      deriveAgentRestoreOfferFromRestorableInventory(
        [],
        [{ id: "codex-offline", command: "codex", label: "codex(coder)" }],
        { now: "2026-08-22T01:08:00.000Z" },
      )?.source,
    ).toBe("restorable-inventory");

    expect(deriveAgentRestoreOffer(["codex-live"], { now: "2026-08-22T01:09:00.000Z" })).toBeNull();
    expect(readAgentRestoreOffer()).toBeNull();
  });

  it("does not re-offer dismissed inventory sessions when the restorable set changes", () => {
    expect(
      deriveAgentRestoreOfferFromRestorableInventory(
        [],
        [
          { id: "codex-a", command: "codex", label: "codex(a)" },
          { id: "codex-b", command: "codex", label: "codex(b)" },
        ],
        { now: "2026-08-22T01:06:00.000Z" },
      )?.sessionIds,
    ).toEqual(["codex-a", "codex-b"]);

    acknowledgeAgentRestoreOffer();

    expect(
      deriveAgentRestoreOfferFromRestorableInventory(
        [],
        [
          { id: "codex-b", command: "codex", label: "codex(b-renamed)" },
          { id: "codex-c", command: "codex", label: "codex(c)" },
        ],
        { now: "2026-08-22T01:07:00.000Z" },
      )?.sessionIds,
    ).toEqual(["codex-c"]);
  });
});
