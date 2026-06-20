import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import {
  buildTmuxWindowMetadata,
  handleSessionRuntimeEvent,
  registerManagedSession,
  resolveLiveSessionTmuxTarget,
  resizeAgentPane,
  sendAgentInput,
  updateSessionLabel,
} from "./session-runtime-core.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";

describe("session runtime prompt submission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not apply dashboard rename locally when project-service rename fails", async () => {
    const host: any = {
      mode: "dashboard",
      sessionLabels: new Map([["codex-1", "old"]]),
      offlineSessions: [],
      dashboardSessionsCache: [{ id: "codex-1", label: "old" }],
      dashboardWorktreeGroupsCache: [{ sessions: [{ id: "codex-1", label: "old" }] }],
      dashboardState: { worktreeSessions: [{ id: "codex-1", label: "old" }] },
      setPendingDashboardSessionAction: vi.fn(),
      writeStatuslineFile: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      postToProjectService: vi.fn(async () => {
        throw new Error("boom");
      }),
      refreshDashboardModelFromService: vi.fn(async () => true),
    };

    await updateSessionLabel(host, "codex-1", "new");

    expect(host.sessionLabels.get("codex-1")).toBe("old");
    expect(host.dashboardSessionsCache[0].label).toBe("old");
    expect(host.footerFlash).toBe("Rename failed: boom");
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
    expect(host.setPendingDashboardSessionAction).toHaveBeenLastCalledWith("codex-1", null);
  });

  it("submits tmux-backed chat input through the carriage-return prompt path", async () => {
    vi.useFakeTimers();
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" };
    const captures = ["› line one line two", "› line one line two", "› line one line two", "› line one line two", ""];
    const tmuxRuntimeManager = {
      sendText: vi.fn(),
      sendKey: vi.fn(),
      sendEnter: vi.fn(),
      sendCarriageReturn: vi.fn(),
      getTargetByWindowId: vi.fn(() => target),
      getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "codex-1" })),
      captureTarget: vi.fn(() => captures.shift() ?? ""),
      isWindowAlive: vi.fn(() => true),
    };
    const transport = new TmuxSessionTransport("codex-1", "codex", target, tmuxRuntimeManager as any, 80, 24);
    const host: any = {
      sessions: [{ id: "codex-1", command: "codex", transport }],
      sessionTmuxTargets: new Map([["codex-1", target]]),
      sessionToolKeys: new Map([["codex-1", "codex"]]),
      tmuxRuntimeManager,
    };

    try {
      const sent = sendAgentInput(host, "codex-1", "line one\nline two");

      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(700);

      await expect(sent).resolves.toEqual({ sessionId: "codex-1", accepted: true });
      expect(tmuxRuntimeManager.sendText).toHaveBeenCalledWith(target, "line one line two");
      expect(tmuxRuntimeManager.sendEnter).not.toHaveBeenCalled();
      expect(tmuxRuntimeManager.sendCarriageReturn).toHaveBeenCalledWith(target);
    } finally {
      transport.destroy();
    }
  });

  it("retargets tmux-backed sessions before resizing", async () => {
    const staleTarget = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" };
    const liveTarget = { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "codex" };
    const tmuxRuntimeManager = {
      sendText: vi.fn(),
      sendKey: vi.fn(),
      sendEnter: vi.fn(),
      resizeTarget: vi.fn(),
      getTargetByWindowId: vi.fn(() => liveTarget),
      getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "codex-1" })),
      isWindowAlive: vi.fn(() => true),
    };
    const transport = new TmuxSessionTransport("codex-1", "codex", staleTarget, tmuxRuntimeManager as any, 80, 24);
    const runtime = {
      id: "codex-1",
      command: "codex",
      transport,
      resize: vi.fn((cols: number, rows: number) => transport.resize(cols, rows)),
    };
    const host: any = {
      sessions: [runtime],
      sessionTmuxTargets: new Map([["codex-1", staleTarget]]),
      tmuxRuntimeManager,
    };

    try {
      await expect(resizeAgentPane(host, "codex-1", 100, 32)).resolves.toEqual({
        sessionId: "codex-1",
        cols: 100,
        rows: 32,
      });
      expect(runtime.resize).toHaveBeenCalledWith(100, 32);
      expect(tmuxRuntimeManager.resizeTarget).toHaveBeenCalledWith(liveTarget, 100, 32);
      expect(host.sessionTmuxTargets.get("codex-1")).toEqual(liveTarget);
    } finally {
      transport.destroy();
    }
  });

  it("does not re-add graveyarded live sessions as offline when their process exits", () => {
    const runtime: any = {
      id: "codex-1",
      command: "codex",
      startTime: Date.now(),
      backendSessionId: "backend-1",
      transport: {},
    };
    const host: any = {
      sessions: [runtime],
      offlineSessions: [],
      stoppingSessionIds: new Set(["codex-1"]),
      graveyardAfterStopSessionIds: new Set(["codex-1"]),
      sessionToolKeys: new Map([["codex-1", "codex"]]),
      sessionOriginalArgs: new Map([["codex-1", []]]),
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      getSessionLabel: vi.fn(),
      deriveHeadline: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      saveState: vi.fn(),
      debug: vi.fn(),
      renderDashboard: vi.fn(),
      publishAlert: vi.fn(),
    };

    handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

    expect(host.sessions).toEqual([]);
    expect(host.offlineSessions).toEqual([]);
    expect(host.stoppingSessionIds.has("codex-1")).toBe(false);
    expect(host.graveyardAfterStopSessionIds.has("codex-1")).toBe(false);
    expect(host.saveState).toHaveBeenCalledOnce();
  });

  it("allows a live just-created tmux target before metadata has been written", () => {
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "claude" };
    const resolved = { ...target, windowIndex: 2 };
    const host: any = {
      sessionTmuxTargets: new Map([["claude-1", target]]),
      tmuxRuntimeManager: {
        getTargetByWindowId: vi.fn(() => resolved),
        getWindowMetadata: vi.fn(() => null),
      },
    };

    expect(resolveLiveSessionTmuxTarget(host, "claude-1")).toEqual(resolved);
    expect(host.sessionTmuxTargets.get("claude-1")).toEqual(resolved);
  });

  it("rejects a cached tmux target when metadata belongs to another session", () => {
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "claude" };
    const host: any = {
      sessionTmuxTargets: new Map([["claude-1", target]]),
      tmuxRuntimeManager: {
        getTargetByWindowId: vi.fn(() => target),
        getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "claude-other" })),
        listProjectManagedWindows: vi.fn(() => []),
      },
    };

    expect(resolveLiveSessionTmuxTarget(host, "claude-1")).toBeUndefined();
  });

  it("does not publish metadata backend ids to tmux metadata", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const host: any = {
        sessions: [{ id: "claude-racy", command: "claude" }],
        sessionOriginalArgs: new Map([["claude-racy", ["--resume"]]]),
        sessionToolKeys: new Map([["claude-racy", "claude"]]),
        sessionWorktreePaths: new Map([["claude-racy", repoRoot]]),
        sessionLabels: new Map(),
        sessionRoles: new Map(),
        offlineSessions: [],
      };

      expect(buildTmuxWindowMetadata(host, "claude-racy", "claude")).toMatchObject({
        sessionId: "claude-racy",
        backendSessionId: undefined,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps runtime backend ids ahead of stale metadata in tmux metadata", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const host: any = {
        sessions: [{ id: "claude-current", command: "claude", backendSessionId: "backend-current" }],
        sessionOriginalArgs: new Map([["claude-current", []]]),
        sessionToolKeys: new Map([["claude-current", "claude"]]),
        sessionWorktreePaths: new Map([["claude-current", repoRoot]]),
        sessionLabels: new Map(),
        sessionRoles: new Map(),
        offlineSessions: [],
      };

      expect(buildTmuxWindowMetadata(host, "claude-current", "claude")).toMatchObject({
        sessionId: "claude-current",
        backendSessionId: "backend-current",
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves teammate metadata when tmux metadata sync runs before runtime hydration catches up", async () => {
    const team = {
      teamId: "team-1",
      parentSessionId: "parent-1",
      role: "reviewer",
    };
    const host: any = {
      sessions: [{ id: "codex-1", command: "codex" }],
      sessionOriginalArgs: new Map([["codex-1", []]]),
      sessionToolKeys: new Map([["codex-1", "codex"]]),
      sessionWorktreePaths: new Map(),
      sessionLabels: new Map(),
      sessionRoles: new Map(),
      offlineSessions: [],
    };

    expect(buildTmuxWindowMetadata(host, "codex-1", "codex", { team })).toMatchObject({
      sessionId: "codex-1",
      team,
    });
  });

  it("attaches teammate metadata when registering recovered tmux runtimes", () => {
    const team = {
      teamId: "team-1",
      parentSessionId: "parent-1",
      role: "implementer",
    };
    const transport = {
      id: "codex-1",
      command: "codex",
      exited: false,
      exitCode: undefined,
      status: { status: "running" },
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
      destroy: vi.fn(),
    };
    const host: any = {
      sessions: [],
      sessionToolKeys: new Map(),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map(),
      sessionRoles: new Map(),
      sessionLabels: new Map(),
      offlineSessions: [],
      handleSessionRuntimeEvent: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      contextWatcher: { start: vi.fn() },
    };

    const runtime = registerManagedSession(host, transport, [], "codex", undefined, "coder", undefined, team);

    expect(runtime.team).toEqual(team);
    expect(host.sessionRoles.get("codex-1")).toBeUndefined();
  });

  it("does not preserve quick exited sessions only because metadata has a backend id", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const runtime = { id: "claude-racy-exit", command: "claude", startTime: Date.now() };
      const host: any = {
        sessions: [runtime],
        offlineSessions: [],
        stoppingSessionIds: new Set(),
        sessionOriginalArgs: new Map([["claude-racy-exit", ["--resume"]]]),
        sessionToolKeys: new Map([["claude-racy-exit", "claude"]]),
        sessionWorktreePaths: new Map([["claude-racy-exit", repoRoot]]),
        sessionTmuxTargets: new Map(),
        startedInDashboard: true,
        getSessionLabel: vi.fn(() => undefined),
        deriveHeadline: vi.fn(() => undefined),
        updateContextWatcherSessions: vi.fn(),
        writeStatuslineFile: vi.fn(),
        saveState: vi.fn(),
        renderDashboard: vi.fn(),
      };

      handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

      expect(host.offlineSessions).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps runtime backend ids ahead of stale metadata when preserving exited sessions", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const runtime = {
        id: "claude-current-exit",
        command: "claude",
        startTime: Date.now(),
        backendSessionId: "backend-current-exit",
      };
      const host: any = {
        sessions: [runtime],
        offlineSessions: [],
        stoppingSessionIds: new Set(),
        sessionOriginalArgs: new Map([["claude-current-exit", []]]),
        sessionToolKeys: new Map([["claude-current-exit", "claude"]]),
        sessionWorktreePaths: new Map([["claude-current-exit", repoRoot]]),
        sessionTmuxTargets: new Map(),
        startedInDashboard: true,
        getSessionLabel: vi.fn(() => undefined),
        deriveHeadline: vi.fn(() => undefined),
        updateContextWatcherSessions: vi.fn(),
        writeStatuslineFile: vi.fn(),
        saveState: vi.fn(),
        renderDashboard: vi.fn(),
      };

      handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

      expect(host.offlineSessions[0]).toMatchObject({
        id: "claude-current-exit",
        backendSessionId: "backend-current-exit",
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not preserve quick exited sessions without backend ids or explicit stops", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const runtime = { id: "claude-quick-crash", command: "claude", startTime: Date.now() };
      const host: any = {
        sessions: [runtime],
        offlineSessions: [],
        stoppingSessionIds: new Set(),
        sessionOriginalArgs: new Map([["claude-quick-crash", []]]),
        sessionToolKeys: new Map([["claude-quick-crash", "claude"]]),
        sessionWorktreePaths: new Map([["claude-quick-crash", repoRoot]]),
        sessionTmuxTargets: new Map(),
        startedInDashboard: true,
        getSessionLabel: vi.fn(() => undefined),
        deriveHeadline: vi.fn(() => undefined),
        updateContextWatcherSessions: vi.fn(),
        writeStatuslineFile: vi.fn(),
        saveState: vi.fn(),
        renderDashboard: vi.fn(),
      };

      handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

      expect(host.offlineSessions).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves teammate metadata when an exited runtime becomes offline", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const team = {
        teamId: "team-1",
        parentSessionId: "parent-1",
        role: "reviewer",
      };
      const runtime = {
        id: "claude-team-exit",
        command: "claude",
        startTime: Date.now() - 20_000,
        team,
      };
      const host: any = {
        sessions: [runtime],
        offlineSessions: [],
        stoppingSessionIds: new Set(),
        sessionOriginalArgs: new Map([["claude-team-exit", []]]),
        sessionToolKeys: new Map([["claude-team-exit", "claude"]]),
        sessionWorktreePaths: new Map([["claude-team-exit", repoRoot]]),
        sessionTmuxTargets: new Map(),
        startedInDashboard: true,
        getSessionLabel: vi.fn(() => undefined),
        deriveHeadline: vi.fn(() => undefined),
        updateContextWatcherSessions: vi.fn(),
        writeStatuslineFile: vi.fn(),
        saveState: vi.fn(),
        renderDashboard: vi.fn(),
      };

      handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

      expect(host.offlineSessions[0]).toMatchObject({
        id: "claude-team-exit",
        team,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
