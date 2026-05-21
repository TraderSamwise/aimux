import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { SavedState } from "./index.js";
import {
  mergeRuntimeSnapshots,
  mergeServiceSnapshots,
  snapshotProjectAgentWindows,
  snapshotProjectServiceWindows,
} from "./service-state-snapshot.js";
import { initPaths } from "../paths.js";

describe("service-state-snapshot", () => {
  it("merges runtime-stop service snapshots as offline services without stale tmux retention", () => {
    const existing: SavedState = {
      savedAt: "2026-05-01T00:00:00.000Z",
      cwd: "/repo",
      sessions: [{ id: "agent-1", tool: "codex", toolConfigKey: "codex", command: "codex", args: [] }],
      services: [
        {
          id: "service-1",
          label: "old",
          launchCommandLine: "yarn dev",
        },
      ],
    };

    const merged = mergeServiceSnapshots(
      existing,
      [
        {
          id: "service-1",
          label: "web",
          launchCommandLine: "yarn dev",
          cwd: "/repo/apps/web",
          tmuxTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "web" },
          retained: true,
        },
      ],
      "/repo",
      "2026-05-02T00:00:00.000Z",
    );

    expect(merged).toEqual({
      savedAt: "2026-05-02T00:00:00.000Z",
      cwd: "/repo",
      sessions: existing.sessions,
      services: [
        {
          id: "service-1",
          label: "web",
          launchCommandLine: "yarn dev",
          cwd: "/repo/apps/web",
          tmuxTarget: undefined,
          retained: undefined,
        },
      ],
    });
  });

  it("merges runtime-stop agent snapshots as offline sessions that replace stale live state", () => {
    const existing: SavedState = {
      savedAt: "2026-05-01T00:00:00.000Z",
      cwd: "/repo",
      sessions: [
        {
          id: "old-id",
          tool: "claude",
          toolConfigKey: "claude",
          command: "claude",
          args: [],
          lifecycle: "live",
          backendSessionId: "backend-1",
          tmuxTarget: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "claude" },
        },
      ],
      services: [],
    };

    const merged = mergeRuntimeSnapshots(
      existing,
      {
        sessions: [
          {
            id: "new-id",
            tool: "claude",
            toolConfigKey: "claude",
            command: "claude",
            args: ["--resume"],
            lifecycle: "live",
            backendSessionId: "backend-1",
            tmuxTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "claude" },
          },
        ],
      },
      "/repo",
      "2026-05-02T00:00:00.000Z",
    );

    expect(merged.sessions).toEqual([
      {
        id: "new-id",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: ["--resume"],
        lifecycle: "offline",
        backendSessionId: "backend-1",
      },
    ]);
  });

  it("does not snapshot managed windows for missing worktrees", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-service-snapshot-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    try {
      const tmux: any = {
        listProjectManagedWindows: () => [
          {
            target: { windowId: "@1", windowName: "codex" },
            metadata: {
              kind: "agent",
              sessionId: "codex-1",
              command: "codex",
              args: [],
              worktreePath: join(repoRoot, ".aimux/worktrees/missing"),
            },
          },
          {
            target: { windowId: "@2", windowName: "shell" },
            metadata: {
              kind: "service",
              sessionId: "service-1",
              command: "shell",
              args: [],
              worktreePath: join(repoRoot, ".aimux/worktrees/missing"),
            },
          },
        ],
        isWindowAlive: () => true,
        displayMessage: () => repoRoot,
      };

      expect(snapshotProjectAgentWindows(repoRoot, tmux)).toEqual([]);
      expect(snapshotProjectServiceWindows(repoRoot, tmux)).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves teammate metadata when snapshotting managed agent windows", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-agent-snapshot-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    try {
      const tmux: any = {
        listProjectManagedWindows: () => [
          {
            target: { windowId: "@1", windowName: "codex" },
            metadata: {
              kind: "agent",
              sessionId: "codex-teammate",
              command: "codex",
              args: [],
              toolConfigKey: "codex",
              worktreePath: repoRoot,
              team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer" },
            },
          },
        ],
        isWindowAlive: () => true,
      };

      expect(snapshotProjectAgentWindows(repoRoot, tmux)).toEqual([
        expect.objectContaining({
          id: "codex-teammate",
          team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer" },
        }),
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
