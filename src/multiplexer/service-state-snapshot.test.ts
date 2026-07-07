import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  mergeRuntimeSnapshots,
  mergeServiceSnapshots,
  persistProjectRuntimeSnapshotsBeforeTmuxStop,
  snapshotProjectServiceWindows,
} from "./service-state-snapshot.js";
import { getStatePath, initPaths } from "../paths.js";
import { listTopologySessionStates } from "../runtime-core/topology-sessions.js";
import { listTopologyServiceStates, upsertTopologyService } from "../runtime-core/topology-services.js";

describe("service-state-snapshot", () => {
  it("merges runtime-stop service snapshots as offline services without stale tmux retention", () => {
    const existing = {
      savedAt: "2026-05-01T00:00:00.000Z",
      cwd: "/repo",
      sessions: [{ id: "agent-1", tool: "codex", toolConfigKey: "codex", command: "codex", args: [] }],
      services: [
        {
          id: "stale-service",
          label: "stale",
          launchCommandLine: "yarn stale",
        },
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

  it("does not let runtime-stop agent snapshots mutate topology", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-agent-snapshot-merge-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    const existing = {
      savedAt: "2026-05-01T00:00:00.000Z",
      cwd: repoRoot,
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

    try {
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
        } as any,
        repoRoot,
        "2026-05-02T00:00:00.000Z",
      );

      expect(merged).toEqual({
        savedAt: "2026-05-02T00:00:00.000Z",
        cwd: repoRoot,
        services: [],
      });
      expect(listTopologySessionStates({ statuses: ["offline"] })).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("demotes observed running services to topology stopped state before tmux stop", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-service-stop-snapshot-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    const target = { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "web" };
    try {
      upsertTopologyService(
        {
          id: "service-1",
          label: "web",
          launchCommandLine: "yarn web",
          worktreePath: repoRoot,
          tmuxTarget: target,
        },
        "running",
        { projectRoot: repoRoot },
      );
      const tmux: any = {
        listProjectManagedWindows: () => [
          {
            target,
            metadata: {
              kind: "service",
              sessionId: "service-1",
              label: "web",
              launchCommandLine: "yarn web",
              worktreePath: repoRoot,
              createdAt: "2026-05-01T00:00:00.000Z",
            },
          },
        ],
        isWindowAlive: () => true,
        displayMessage: () => repoRoot,
      };

      persistProjectRuntimeSnapshotsBeforeTmuxStop(repoRoot, tmux);

      expect(listTopologyServiceStates({ statuses: ["stopped"] })).toMatchObject([
        {
          id: "service-1",
          status: "stopped",
          label: "web",
          launchCommandLine: "yarn web",
          worktreePath: repoRoot,
          retained: true,
        },
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("clears stale compatibility service snapshots when no service windows are observed", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-empty-service-stop-snapshot-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    try {
      writeFileSync(
        getStatePath(),
        JSON.stringify({
          savedAt: "2026-05-01T00:00:00.000Z",
          cwd: repoRoot,
          services: [{ id: "stale-service", label: "stale", launchCommandLine: "yarn stale" }],
        }),
      );
      const tmux: any = {
        listProjectManagedWindows: () => [],
      };

      const result = persistProjectRuntimeSnapshotsBeforeTmuxStop(repoRoot, tmux);
      const state = JSON.parse(readFileSync(getStatePath(), "utf-8"));

      expect(result.services).toEqual([]);
      expect(state).toMatchObject({ cwd: repoRoot, services: [] });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
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

      expect(snapshotProjectServiceWindows(repoRoot, tmux)).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
