import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStatePath, initPaths } from "../paths.js";
import { runtimeLifecycleMethods } from "./runtime-lifecycle-methods.js";

describe("runtime lifecycle state persistence", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-runtime-lifecycle-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function host(overrides: Record<string, unknown> = {}) {
    return {
      sessions: [],
      offlineSessions: [],
      offlineServices: [],
      sessionToolKeys: new Map(),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      buildLiveServiceStates: vi.fn(() => []),
      getRemoteInstancesSafe: vi.fn(() => []),
      invalidateDesktopStateSnapshot: vi.fn(),
      isSessionRuntimeLive: vi.fn(() => true),
      ...overrides,
    };
  }

  it("persists an empty session list after the last local agent row is removed", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [{ id: "stale-agent", command: "codex", tool: "codex", args: [] }],
          services: [{ id: "stale-service", command: "shell", args: [] }],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(host() as never);

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as { sessions: unknown[]; services: unknown[] };
    expect(saved.sessions).toEqual([]);
    expect(saved.services).toEqual([{ id: "stale-service", command: "shell", args: [] }]);
  });

  it("preserves service rows that were not loaded into the current process yet", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [],
          services: [{ id: "existing-service", command: "shell", args: [], worktreePath: repoRoot }],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(host() as never);

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      services: Array<{ id: string }>;
    };
    expect(saved.services.map((service) => service.id)).toEqual(["existing-service"]);
  });

  it("drops explicitly removed service rows when merging state", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [],
          services: [{ id: "removed-service", command: "shell", args: [], worktreePath: repoRoot }],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(
      host({
        removedServiceIds: new Set(["removed-service"]),
      }) as never,
    );

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      services: Array<{ id: string }>;
    };
    expect(saved.services).toEqual([]);
  });

  it("does not erase live remote sessions when this instance has no local rows", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [{ id: "remote-agent", command: "claude", tool: "claude", args: [] }],
          services: [{ id: "stale-service", command: "shell", args: [] }],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(
      host({
        getRemoteInstancesSafe: vi.fn(() => [
          {
            instanceId: "remote",
            pid: 123,
            cwd: repoRoot,
            updatedAt: new Date().toISOString(),
            sessions: [{ id: "remote-agent", tool: "claude" }],
          },
        ]),
      }) as never,
    );

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      sessions: Array<{ id: string }>;
      services: Array<{ id: string }>;
    };
    expect(saved.sessions.map((session) => session.id)).toEqual(["remote-agent"]);
    expect(saved.services.map((service) => service.id)).toEqual(["stale-service"]);
  });

  it("persists remote instance session refs even when state has no matching row yet", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [],
          services: [],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(
      host({
        getRemoteInstancesSafe: vi.fn(() => [
          {
            instanceId: "remote",
            pid: 123,
            cwd: repoRoot,
            updatedAt: new Date().toISOString(),
            sessions: [
              {
                id: "remote-agent",
                tool: "claude",
                backendSessionId: "native-session",
                worktreePath: repoRoot,
              },
            ],
          },
        ]),
      }) as never,
    );

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      sessions: Array<{ id: string; command: string; lifecycle?: string; backendSessionId?: string }>;
    };
    expect(saved.sessions).toEqual([
      {
        id: "remote-agent",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "offline",
        backendSessionId: "native-session",
        worktreePath: repoRoot,
      },
    ]);
  });

  it("converts recoverable existing live sessions to offline instead of erasing them", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [
            {
              id: "local-agent",
              command: "claude",
              tool: "claude",
              toolConfigKey: "claude",
              args: ["--resume", "backend-1"],
              lifecycle: "live",
              backendSessionId: "backend-1",
              worktreePath: repoRoot,
              tmuxTarget: {
                sessionName: "aimux-repo",
                windowId: "@7",
                windowIndex: 7,
                windowName: "claude",
              },
            },
          ],
          services: [],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(host() as never);

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      sessions: Array<{ id: string; lifecycle?: string; tmuxTarget?: unknown; backendSessionId?: string }>;
    };
    expect(saved.sessions).toEqual([
      {
        id: "local-agent",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: ["--resume", "backend-1"],
        lifecycle: "offline",
        backendSessionId: "backend-1",
        worktreePath: repoRoot,
      },
    ]);
  });

  it("preserves valid live session rows without backend ids during partial saves", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [
            {
              id: "local-agent",
              command: "claude",
              tool: "claude",
              toolConfigKey: "claude",
              args: [],
              lifecycle: "live",
              worktreePath: repoRoot,
            },
          ],
          services: [],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(host() as never);

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      sessions: Array<{ id: string; lifecycle?: string; tmuxTarget?: unknown; backendSessionId?: string }>;
    };
    expect(saved.sessions).toEqual([
      {
        id: "local-agent",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "offline",
        worktreePath: repoRoot,
      },
    ]);
  });

  it("deduplicates recovered existing sessions while preserving the latest row", () => {
    const duplicate = {
      id: "local-agent",
      command: "claude",
      tool: "claude",
      toolConfigKey: "claude",
      args: ["--resume", "backend-1"],
      lifecycle: "live",
      backendSessionId: "backend-1",
      worktreePath: repoRoot,
      tmuxTarget: {
        sessionName: "aimux-repo",
        windowId: "@7",
        windowIndex: 7,
        windowName: "claude",
      },
    };
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [
            { ...duplicate, label: "old" },
            { ...duplicate, label: "new" },
          ],
          services: [],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(host() as never);

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      sessions: Array<{ id: string; lifecycle?: string; label?: string }>;
    };
    expect(saved.sessions).toHaveLength(1);
    expect(saved.sessions[0]).toMatchObject({
      id: "local-agent",
      lifecycle: "offline",
      label: "new",
    });
  });

  it("persists intentional offline sessions without stale tmux targets", () => {
    runtimeLifecycleMethods.saveState.call(
      host({
        offlineSessions: [
          {
            id: "codex-offline",
            tool: "codex",
            toolConfigKey: "codex",
            command: "codex",
            args: [],
            tmuxTarget: {
              sessionName: "aimux-repo",
              windowId: "@2",
              windowIndex: 2,
              windowName: "codex",
            },
          },
        ],
      }) as never,
    );

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      sessions: Array<{ id: string; lifecycle?: string; tmuxTarget?: unknown }>;
    };
    expect(saved.sessions).toEqual([
      {
        id: "codex-offline",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        lifecycle: "offline",
      },
    ]);
  });

  it("persists only live runtimes that still have matching tmux authority", () => {
    const runtime = {
      id: "codex-live",
      command: "codex",
      backendSessionId: "backend-1",
      startTime: Date.parse("2026-04-21T00:00:00.000Z"),
    };
    const tmuxTarget = {
      sessionName: "aimux-repo",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    };

    runtimeLifecycleMethods.saveState.call(
      host({
        sessions: [runtime],
        sessionToolKeys: new Map([["codex-live", "codex"]]),
        sessionOriginalArgs: new Map([["codex-live", ["--resume"]]]),
        sessionWorktreePaths: new Map([["codex-live", repoRoot]]),
        sessionTmuxTargets: new Map([["codex-live", tmuxTarget]]),
        getSessionLabel: vi.fn(() => "coder"),
        deriveHeadline: vi.fn(() => "working"),
      }) as never,
    );

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      sessions: Array<{ id: string; lifecycle?: string; tmuxTarget?: unknown }>;
    };
    expect(saved.sessions).toEqual([
      expect.objectContaining({
        id: "codex-live",
        lifecycle: "live",
        backendSessionId: "backend-1",
        tmuxTarget,
      }),
    ]);
  });
});
