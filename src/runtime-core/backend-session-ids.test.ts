import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import { recordTopologyBackendSessionId } from "./backend-session-ids.js";
import { listTopologySessionStates, upsertTopologySession } from "./topology-sessions.js";

describe("recordTopologyBackendSessionId", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-backend-session-ids-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("strictly records a backend id into an existing topology row", () => {
    upsertTopologySession(
      {
        id: "claude-1",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "offline",
        worktreePath: repoRoot,
      },
      "offline",
      { projectRoot: repoRoot },
    );

    expect(
      recordTopologyBackendSessionId({
        projectRoot: repoRoot,
        sessionId: "claude-1",
        backendSessionId: "backend-1",
      }),
    ).toEqual({ sessionId: "claude-1", backendSessionId: "backend-1" });

    expect(listTopologySessionStates().find((session) => session.id === "claude-1")?.backendSessionId).toBe(
      "backend-1",
    );
  });

  it("preserves live tmux binding metadata while latching the backend id", () => {
    upsertTopologySession(
      {
        id: "claude-live",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "live",
        worktreePath: repoRoot,
        tmuxTarget: {
          sessionName: "aimux-test",
          windowId: "@1",
          windowIndex: 1,
          windowName: "claude",
        },
      },
      "running",
      { projectRoot: repoRoot },
    );

    recordTopologyBackendSessionId({
      projectRoot: repoRoot,
      sessionId: "claude-live",
      backendSessionId: "backend-live",
    });

    const live = listTopologySessionStates().find((session) => session.id === "claude-live");
    expect(live).toMatchObject({
      status: "running",
      backendSessionId: "backend-live",
      tmuxTarget: {
        sessionName: "aimux-test",
        windowId: "@1",
        windowIndex: 1,
        windowName: "claude",
      },
    });
  });

  it("refuses missing rows and conflicting backend ids", () => {
    expect(() =>
      recordTopologyBackendSessionId({ projectRoot: repoRoot, sessionId: "missing", backendSessionId: "backend-1" }),
    ).toThrow('Agent "missing" is not managed in runtime topology');

    upsertTopologySession(
      {
        id: "claude-1",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "offline",
        backendSessionId: "backend-original",
      },
      "offline",
      { projectRoot: repoRoot },
    );

    expect(() =>
      recordTopologyBackendSessionId({
        projectRoot: repoRoot,
        sessionId: "claude-1",
        backendSessionId: "backend-new",
      }),
    ).toThrow('Agent "claude-1" already has backend session "backend-original"');
  });
});
