import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDebugStateReport } from "./debug-state.js";
import type { ReadOnlyProjectPaths } from "./paths.js";

function makePaths(): ReadOnlyProjectPaths {
  const root = mkdtempSync(join(tmpdir(), "aimux-debug-state-"));
  const projectStateDir = join(root, "global");
  const localAimuxDir = join(root, "repo", ".aimux");
  mkdirSync(projectStateDir, { recursive: true });
  mkdirSync(localAimuxDir, { recursive: true });
  return {
    repoRoot: join(root, "repo"),
    projectId: "repo-123",
    projectStateDir,
    localAimuxDir,
    statePath: join(projectStateDir, "state.json"),
    graveyardPath: join(projectStateDir, "graveyard.json"),
    worktreeGraveyardPath: join(projectStateDir, "worktree-graveyard.json"),
    instancesPath: join(projectStateDir, "instances.json"),
    localInstancesPath: join(localAimuxDir, "instances.json"),
    metadataPath: join(projectStateDir, "metadata.json"),
    notificationsPath: join(projectStateDir, "notifications.json"),
    notificationContextPath: join(projectStateDir, "notification-context.json"),
    dashboardOperationFailuresPath: join(projectStateDir, "dashboard-operation-failures.json"),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(paths: string[]): Map<string, string> {
  return new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
}

describe("buildDebugStateReport", () => {
  it("joins session evidence without mutating source files", () => {
    const paths = makePaths();
    writeJson(paths.statePath, {
      sessions: [
        {
          id: "codex-a1",
          tool: "codex",
          backendSessionId: "backend-a1",
          worktreePath: "/repo/worktree-a",
        },
      ],
      services: [],
    });
    writeJson(paths.metadataPath, {
      version: 1,
      sessions: {
        "codex-a1": {
          backendSessionId: "backend-a1",
          context: { worktreePath: "/repo/worktree-a", worktreeName: "worktree-a" },
        },
      },
    });
    writeJson(paths.instancesPath, [
      {
        instanceId: "instance-a",
        pid: 123,
        sessions: [{ id: "codex-a1", backendSessionId: "backend-a1", worktreePath: "/repo/worktree-a" }],
      },
    ]);
    writeJson(paths.localInstancesPath, []);
    const before = snapshot([paths.statePath, paths.metadataPath, paths.instancesPath, paths.localInstancesPath]);

    const report = buildDebugStateReport({
      target: "backend-a1",
      paths,
      tmuxWindows: [
        {
          target: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex-a1" },
          metadata: {
            kind: "agent",
            sessionId: "codex-a1",
            backendSessionId: "backend-a1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
            worktreePath: "/repo/worktree-a",
          },
        },
      ],
      worktrees: [],
    });

    expect(report.targetResolution.status).toBe("matched");
    expect(report.targetResolution.entityCount).toBe(1);
    expect(report.sources.savedState.value?.sessions).toHaveLength(1);
    expect(report.sources.metadata.value?.sessions).toHaveLength(1);
    expect(report.sources.tmux.value?.windows).toHaveLength(1);
    expect(snapshot([...before.keys()])).toEqual(before);
  });

  it("matches service and worktree sources", () => {
    const paths = makePaths();
    writeJson(paths.statePath, {
      sessions: [],
      services: [{ id: "service-1", worktreePath: "/repo/app", cwd: "/repo/app/apps/web", label: "web" }],
    });
    writeJson(paths.metadataPath, { version: 1, sessions: {} });
    writeJson(paths.instancesPath, []);

    const report = buildDebugStateReport({
      target: "service-1",
      paths,
      tmuxWindows: [],
      worktrees: [{ name: "app", path: "/repo/app", branch: "app", isBare: false }],
    });

    expect(report.targetResolution.status).toBe("matched");
    expect(report.sources.savedState.value?.services).toHaveLength(1);
  });

  it("reports missing with explicit unavailable live-only sources", () => {
    const paths = makePaths();
    const report = buildDebugStateReport({
      target: "missing",
      paths,
      tmuxWindows: [],
      worktrees: [],
    });

    expect(report.targetResolution.status).toBe("missing");
    expect(report.sources.savedState.status).toBe("missing");
    expect(report.sources.pendingActions.status).toBe("unavailable");
    expect(report.sources.dashboardProjection.status).toBe("unavailable");
    expect(report.sources.runtimeRows.status).toBe("unavailable");
  });

  it("marks ambiguous exact matches instead of guessing", () => {
    const paths = makePaths();
    writeJson(paths.statePath, {
      sessions: [{ id: "same", tool: "codex" }],
      services: [{ id: "same", worktreePath: "/repo/app" }],
    });

    const report = buildDebugStateReport({
      target: "same",
      paths,
      tmuxWindows: [],
      worktrees: [],
    });

    expect(report.targetResolution.status).toBe("ambiguous");
    expect(report.targetResolution.entityCount).toBe(2);
  });

  it("resolves targets found only in notifications", () => {
    const paths = makePaths();
    writeJson(paths.notificationsPath, {
      notifications: [{ id: "notice-1", sessionId: "codex-a1", targetKey: "session:codex-a1" }],
    });

    const report = buildDebugStateReport({
      target: "codex-a1",
      paths,
      tmuxWindows: [],
      worktrees: [],
    });

    expect(report.targetResolution.status).toBe("matched");
    expect(report.targetResolution.matches).toEqual([
      expect.objectContaining({ kind: "notification", source: "notifications", id: "notice-1" }),
    ]);
    expect(report.sources.notifications.value?.notifications).toHaveLength(1);
  });
});
