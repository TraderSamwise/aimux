import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDebugStateReport } from "./debug-state.js";
import type { ReadOnlyProjectPaths } from "./paths.js";
import { createRuntimeTopologyStore, emptyRuntimeTopology } from "./runtime-core/topology-store.js";

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
    runtimeTopologyPath: join(projectStateDir, "runtime-topology.yaml"),
    runtimeExchangePath: join(projectStateDir, "runtime-exchange.yaml"),
    instancesPath: join(projectStateDir, "instances.json"),
    localInstancesPath: join(localAimuxDir, "instances.json"),
    metadataPath: join(projectStateDir, "metadata.json"),
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

function writeTopologySession(paths: ReadOnlyProjectPaths, session: any): void {
  const now = new Date().toISOString();
  createRuntimeTopologyStore(paths.runtimeTopologyPath).write({
    ...emptyRuntimeTopology(now),
    rigs: [{ id: "rig:test", name: "repo", projectRoot: paths.repoRoot, createdAt: now, updatedAt: now }],
    nodes: [
      {
        id: `agent:${session.id}`,
        rigId: "rig:test",
        logicalId: session.id,
        toolConfigKey: session.toolConfigKey ?? session.tool,
        cwd: session.worktreePath,
        label: session.label,
        createdAt: now,
      },
    ],
    sessions: [
      {
        id: session.id,
        nodeId: `agent:${session.id}`,
        status: session.lifecycle === "offline" ? "offline" : "running",
        tool: session.tool,
        command: session.command,
        args: session.args ?? [],
        backendSessionId: session.backendSessionId,
        worktreePath: session.worktreePath,
        label: session.label,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
}

describe("buildDebugStateReport", () => {
  it("joins session evidence without mutating source files", () => {
    const paths = makePaths();
    writeTopologySession(paths, {
      id: "codex-a1",
      tool: "codex",
      toolConfigKey: "codex",
      command: "codex",
      args: [],
      lifecycle: "offline",
      backendSessionId: "backend-a1",
      worktreePath: "/repo/worktree-a",
    });
    writeJson(paths.statePath, {
      sessions: [],
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
    expect(report.sources.savedState.value).not.toHaveProperty("sessions");
    expect(report.sources.runtimeTopology.value?.sessions).toHaveLength(1);
    expect(report.sources.metadata.value?.sessions).toHaveLength(0);
    expect(report.sourceRoles.runtimeTopology.role).toBe("authority");
    expect(report.sourceRoles.metadata.role).toBe("projection");
    expect(report.sourceRoles.metadata.note).toContain("backend identity fields are ignored");
    expect(report.sources.tmux.value?.windows).toHaveLength(1);
    expect(snapshot([...before.keys()])).toEqual(before);
  });

  it("does not resolve topology-owned identity from stale metadata projection fields", () => {
    const paths = makePaths();
    writeJson(paths.metadataPath, {
      version: 1,
      sessions: {
        "codex-stale": {
          backendSessionId: "backend-stale",
          label: "stale-label",
          context: { worktreePath: "/repo/worktree-a" },
        },
      },
    });

    const report = buildDebugStateReport({
      target: "backend-stale",
      paths,
      tmuxWindows: [],
      worktrees: [],
    });

    expect(report.targetResolution.status).toBe("missing");
    expect(report.sources.metadata.value?.sessions).toEqual([]);

    const labelReport = buildDebugStateReport({
      target: "stale-label",
      paths,
      tmuxWindows: [],
      worktrees: [],
    });

    expect(labelReport.targetResolution.status).toBe("missing");
    expect(labelReport.sources.metadata.value?.sessions).toEqual([]);
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
    expect(report.sources.dashboardSnapshot.status).toBe("unavailable");
    expect(report.sources.runtimeRows.status).toBe("unavailable");
  });

  it("marks ambiguous exact matches instead of guessing", () => {
    const paths = makePaths();
    writeTopologySession(paths, {
      id: "same",
      tool: "codex",
      toolConfigKey: "codex",
      command: "codex",
      args: [],
      lifecycle: "offline",
    });
    writeJson(paths.statePath, {
      sessions: [],
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
    createRuntimeTopologyStore(paths.runtimeTopologyPath).update((topology) => topology);
    writeFileSync(
      paths.runtimeExchangePath,
      [
        "version: 1",
        "generatedAt: '2026-01-01T00:00:00.000Z'",
        "threads:",
        "  - id: notice-thread",
        "    title: Notice",
        "    kind: conversation",
        "    status: open",
        "    createdAt: '2026-01-01T00:00:00.000Z'",
        "    updatedAt: '2026-01-01T00:00:00.000Z'",
        "    createdBy: aimux",
        "    participants: [aimux, codex-a1]",
        "    tags: [notification]",
        "messages:",
        "  - id: notice-1",
        "    threadId: notice-thread",
        "    ts: '2026-01-01T00:00:00.000Z'",
        "    from: aimux",
        "    to: [codex-a1]",
        "    kind: note",
        "    body: Notice",
        "    metadata:",
        "      notificationRecordId: notice-1",
        "      notificationSessionId: codex-a1",
        "      notificationTargetKey: session:codex-a1",
        "tasks: []",
        "handoffs: []",
        "reviews: []",
        "waits: []",
        "inbox: []",
        "planRefs: []",
        "continuityRefs: []",
        "attachmentRefs: []",
        "",
      ].join("\n"),
    );

    const report = buildDebugStateReport({
      target: "codex-a1",
      paths,
      tmuxWindows: [],
      worktrees: [],
    });

    expect(report.targetResolution.status).toBe("matched");
    expect(report.targetResolution.matches).toEqual([
      expect.objectContaining({ kind: "notification", source: "runtimeExchange", id: "notice-1" }),
    ]);
    expect(report.sources.notifications.value?.notifications).toHaveLength(1);
  });

  it("reads worktree graveyard entries from runtime topology", () => {
    const paths = makePaths();
    const now = new Date().toISOString();
    createRuntimeTopologyStore(paths.runtimeTopologyPath).write({
      ...emptyRuntimeTopology(now),
      rigs: [{ id: "rig:test", name: "repo", projectRoot: paths.repoRoot, createdAt: now, updatedAt: now }],
      worktreeGraveyard: [
        {
          id: "graveyard-feature-a",
          rigId: "rig:test",
          path: "/repo/feature-a",
          name: "feature-a",
          branch: "feature-a",
          graveyardedAt: now,
        },
      ],
    });

    const report = buildDebugStateReport({
      target: "feature-a",
      paths,
      tmuxWindows: [],
      worktrees: [],
    });

    expect(report.targetResolution.status).toBe("matched");
    expect(report.sources.worktreeGraveyard.path).toBe(paths.runtimeTopologyPath);
    expect(report.sources.worktreeGraveyard.value?.entries).toEqual([
      expect.objectContaining({ name: "feature-a", path: "/repo/feature-a" }),
    ]);
  });

  it("matches topology-only services and worktrees", () => {
    const paths = makePaths();
    const now = new Date().toISOString();
    createRuntimeTopologyStore(paths.runtimeTopologyPath).write({
      ...emptyRuntimeTopology(now),
      rigs: [{ id: "rig:test", name: "repo", projectRoot: paths.repoRoot, createdAt: now, updatedAt: now }],
      nodes: [{ id: "service:service-web", rigId: "rig:test", logicalId: "service-web", createdAt: now }],
      services: [
        {
          id: "service-web",
          rigId: "rig:test",
          nodeId: "service:service-web",
          status: "stopped",
          launchCommandLine: "yarn web",
          label: "web",
          createdAt: now,
          updatedAt: now,
        },
      ],
      worktrees: [
        {
          id: "worktree-feature-b",
          rigId: "rig:test",
          path: "/repo/feature-b",
          name: "feature-b",
          status: "active",
          branch: "feature-b",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const serviceReport = buildDebugStateReport({ target: "service-web", paths, tmuxWindows: [], worktrees: [] });
    expect(serviceReport.targetResolution.status).toBe("matched");
    expect(serviceReport.sources.runtimeTopology.value?.services).toHaveLength(1);

    const worktreeReport = buildDebugStateReport({ target: "feature-b", paths, tmuxWindows: [], worktrees: [] });
    expect(worktreeReport.targetResolution.status).toBe("matched");
    expect(worktreeReport.sources.runtimeTopology.value?.worktrees).toHaveLength(1);
  });
});
