import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getContextDir, initPaths } from "../paths.js";
import { updateSessionMetadata } from "../metadata-store.js";
import { listTopologySessionStates } from "../runtime-core/topology-sessions.js";
import { runtimeLifecycleMethods } from "./runtime-lifecycle-methods.js";
import { loadOfflineTopologySessions } from "./runtime-state.js";
import {
  buildTmuxWindowMetadata,
  handleSessionRuntimeEvent,
  reconcileAgentActivity,
  registerManagedSession,
  readAgentOutput,
  resolveLiveSessionTmuxTarget,
  resizeAgentPane,
  sendAgentInput,
  syncTmuxWindowMetadata,
  updateContextWatcherSessions,
  updateSessionLabel,
} from "./session-runtime-core.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import { SessionBootstrapService } from "../session-bootstrap.js";

describe("session runtime prompt submission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the context watcher running for managed tmux sessions", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-context-"));
    await initPaths(repoRoot);
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "claude" };
    const host: any = {
      sessions: [{ id: "claude-live", command: "claude" }],
      sessionToolKeys: new Map([["claude-live", "claude"]]),
      sessionTmuxTargets: new Map([["claude-live", target]]),
      tmuxRuntimeManager: {
        getTargetByWindowId: vi.fn(() => target),
        getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "claude-live" })),
        listProjectManagedWindows: vi.fn(),
        isWindowAlive: vi.fn(() => true),
      },
      contextWatcher: {
        updateSessions: vi.fn(),
        start: vi.fn(),
      },
      projectRoot: "/repo",
    };

    updateContextWatcherSessions(host);

    expect(host.contextWatcher.updateSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "claude-live",
        command: "claude",
        tmuxTarget: target,
      }),
    ]);
    expect(host.contextWatcher.start).toHaveBeenCalledOnce();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("does not apply dashboard rename locally when project-service rename fails", async () => {
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
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
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }) }),
    );
    expect(host.setPendingDashboardSessionAction).toHaveBeenLastCalledWith("codex-1", null);
  });

  it("does not clear newer dashboard rename pending state from a stale rename", async () => {
    let token = 0;
    const pending = new Map<string, { kind: string; token: number }>();
    let rejectRename!: (error: unknown) => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      sessionLabels: new Map([["codex-1", "old"]]),
      offlineSessions: [],
      dashboardSessionsCache: [{ id: "codex-1", label: "old" }],
      dashboardWorktreeGroupsCache: [{ sessions: [{ id: "codex-1", label: "old" }] }],
      dashboardState: { worktreeSessions: [{ id: "codex-1", label: "old" }] },
      dashboardPendingActions: {
        clearSessionActionIfToken: vi.fn((sessionId: string, clearToken: number) => {
          if (pending.get(sessionId)?.token !== clearToken) return false;
          pending.delete(sessionId);
          return true;
        }),
      },
      setPendingDashboardSessionAction: vi.fn((sessionId: string, kind: string | null) => {
        if (!kind) {
          pending.delete(sessionId);
          return undefined;
        }
        token += 1;
        pending.set(sessionId, { kind, token });
        return token;
      }),
      reapplyDashboardPendingActions: vi.fn(),
      writeStatuslineFile: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      postToProjectService: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectRename = reject;
          }),
      ),
      refreshDashboardModelFromService: vi.fn(async () => true),
    };

    const rename = updateSessionLabel(host, "codex-1", "new");
    await vi.waitFor(() => expect(host.postToProjectService).toHaveBeenCalledOnce());
    host.dashboardInputEpoch = 1;
    host.setPendingDashboardSessionAction("codex-1", "renaming");
    rejectRename(new Error("late failure"));
    await rename;

    expect(pending.get("codex-1")).toEqual({ kind: "renaming", token: 2 });
    expect(host.footerFlash).toBeUndefined();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
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

  it("returns on acceptance without blocking on submit when waitForSubmit is false", async () => {
    vi.useFakeTimers();
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" };
    const captures = ["› hi", "› hi", "› hi", "› hi", ""];
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
      // Resolves without advancing any timers: the response does not block on the
      // timer-driven tmux submit confirmation.
      await expect(sendAgentInput(host, "codex-1", "hi", { waitForSubmit: false })).resolves.toEqual({
        sessionId: "codex-1",
        accepted: true,
      });
      expect(tmuxRuntimeManager.sendText).toHaveBeenCalledWith(target, "hi");
      // The carriage-return submit has not happened yet — it runs in the background.
      expect(tmuxRuntimeManager.sendCarriageReturn).not.toHaveBeenCalled();

      // Draining the background timers still submits the prompt exactly once:
      // waitForDraft polls (300ms, then 250ms) until the draft is stable, then
      // submitStep sends the carriage return (200ms) and confirms it cleared (700ms).
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(700);
      expect(tmuxRuntimeManager.sendCarriageReturn).toHaveBeenCalledTimes(1);
      expect(tmuxRuntimeManager.sendCarriageReturn).toHaveBeenCalledWith(target);
    } finally {
      transport.destroy();
      vi.useRealTimers();
    }
  });

  it("waits for active prompt input to stay idle before writing guarded tmux input", async () => {
    vi.useFakeTimers();
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" };
    const captures = [
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› human draft\n  gpt-5.5 high",
      "› aimux delivery",
      "› aimux delivery",
      "",
    ];
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
      const sent = sendAgentInput(host, "codex-1", "aimux delivery", {
        waitForSubmit: false,
        waitForActiveDraftIdle: true,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(tmuxRuntimeManager.sendText).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(tmuxRuntimeManager.sendText).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(tmuxRuntimeManager.sendText).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_000);
      expect(tmuxRuntimeManager.sendText).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(tmuxRuntimeManager.sendText).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(sent).resolves.toEqual({ sessionId: "codex-1", accepted: true });
      expect(tmuxRuntimeManager.sendText).toHaveBeenCalledWith(target, "aimux delivery");
    } finally {
      transport.destroy();
      vi.useRealTimers();
    }
  });

  it("writes guarded tmux input after visible prompt input clears", async () => {
    vi.useFakeTimers();
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" };
    const captures = ["› human draft\n  gpt-5.5 high", "", "› aimux delivery", "› aimux delivery", ""];
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
      const sent = sendAgentInput(host, "codex-1", "aimux delivery", {
        waitForSubmit: false,
        waitForActiveDraftIdle: true,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(sent).resolves.toEqual({ sessionId: "codex-1", accepted: true });
      expect(tmuxRuntimeManager.sendText).toHaveBeenCalledWith(target, "aimux delivery");
    } finally {
      transport.destroy();
      vi.useRealTimers();
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

  it("rejects invalid resize dimensions before resolving sessions", async () => {
    const host: any = { sessions: [] };

    await expect(resizeAgentPane(host, "codex-1", 0, 32)).rejects.toThrow("cols must be a positive integer");
    await expect(resizeAgentPane(host, "codex-1", 100, 10.5)).rejects.toThrow("rows must be a positive integer");
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
      sessions: [{ id: "claude-1", startTime: Date.now() }],
      sessionTmuxTargets: new Map([["claude-1", target]]),
      tmuxRuntimeManager: {
        getTargetByWindowId: vi.fn(() => resolved),
        getWindowMetadata: vi.fn(() => null),
      },
    };

    expect(resolveLiveSessionTmuxTarget(host, "claude-1")).toEqual(resolved);
    expect(host.sessionTmuxTargets.get("claude-1")).toEqual(resolved);
  });

  it("rejects a metadata-less tmux target after startup grace", () => {
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "claude" };
    const host: any = {
      sessions: [{ id: "claude-1", startTime: Date.now() - 60_000 }],
      sessionTmuxTargets: new Map([["claude-1", target]]),
      tmuxRuntimeManager: {
        getTargetByWindowId: vi.fn(() => target),
        getWindowMetadata: vi.fn(() => null),
        listProjectManagedWindows: vi.fn(() => []),
      },
    };

    expect(resolveLiveSessionTmuxTarget(host, "claude-1")).toBeUndefined();
    expect(host.sessionTmuxTargets.has("claude-1")).toBe(false);
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
    expect(host.sessionTmuxTargets.has("claude-1")).toBe(false);
  });

  it("removes a stale cached tmux target before adopting a scanned replacement", () => {
    const staleTarget = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "claude" };
    const replacement = { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "claude" };
    const host: any = {
      sessionTmuxTargets: new Map([["claude-1", staleTarget]]),
      tmuxRuntimeManager: {
        getTargetByWindowId: vi.fn(() => undefined),
        getWindowMetadata: vi.fn(() => null),
        listProjectManagedWindows: vi.fn(() => [
          { target: replacement, metadata: { kind: "agent", sessionId: "claude-1" } },
        ]),
      },
    };

    expect(resolveLiveSessionTmuxTarget(host, "claude-1")).toEqual(replacement);
    expect(host.sessionTmuxTargets.get("claude-1")).toEqual(replacement);
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

  it("revalidates target ownership before every output capture", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const target = { sessionName: "aimux-test", windowId: "@3", windowIndex: 3, windowName: "claude" };
      const tmuxRuntimeManager = {
        getTargetByWindowId: vi.fn(() => target),
        getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "claude-1" })),
        captureTarget: vi.fn(() => "pane text"),
        listProjectManagedWindows: vi.fn(() => []),
        isWindowAlive: vi.fn(() => true),
      };
      const host: any = {
        sessions: [{ id: "claude-1", command: "claude", status: "running" }],
        sessionTmuxTargets: new Map([["claude-1", target]]),
        sessionToolKeys: new Map([["claude-1", "claude"]]),
        sessionWorktreePaths: new Map([["claude-1", repoRoot]]),
        sessionLabels: new Map(),
        sessionRoles: new Map(),
        sessionOriginalArgs: new Map([["claude-1", []]]),
        offlineSessions: [],
        tmuxRuntimeManager,
      };

      await readAgentOutput(host, "claude-1");
      await readAgentOutput(host, "claude-1");
      await readAgentOutput(host, "claude-1");

      const livePath = join(getContextDir(), "claude-1", "live.md");
      expect(existsSync(livePath)).toBe(true);
      expect(readFileSync(livePath, "utf-8")).toContain("pane text");
      expect(tmuxRuntimeManager.captureTarget).toHaveBeenCalledTimes(3);
      expect(tmuxRuntimeManager.getTargetByWindowId).toHaveBeenCalledTimes(3);
      expect(tmuxRuntimeManager.getWindowMetadata).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("re-resolves the target before capture when the cached target moved", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const stale = { sessionName: "aimux-test", windowId: "@3", windowIndex: 3, windowName: "claude" };
      const moved = { sessionName: "aimux-test", windowId: "@9", windowIndex: 9, windowName: "claude" };
      const tmuxRuntimeManager = {
        getTargetByWindowId: vi.fn(() => moved),
        getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "claude-1" })),
        captureTarget: vi.fn(() => "pane text"),
        listProjectManagedWindows: vi.fn(() => []),
        isWindowAlive: vi.fn(() => true),
      };
      const host: any = {
        sessions: [{ id: "claude-1", command: "claude", status: "running" }],
        sessionTmuxTargets: new Map([["claude-1", stale]]),
        sessionToolKeys: new Map([["claude-1", "claude"]]),
        sessionWorktreePaths: new Map([["claude-1", repoRoot]]),
        sessionLabels: new Map(),
        sessionRoles: new Map(),
        sessionOriginalArgs: new Map([["claude-1", []]]),
        offlineSessions: [],
        tmuxRuntimeManager,
      };

      const result = await readAgentOutput(host, "claude-1");

      expect(result.output).toContain("pane text");
      expect(tmuxRuntimeManager.captureTarget.mock.calls[0]![0]).toEqual(moved);
      expect(tmuxRuntimeManager.getTargetByWindowId).toHaveBeenCalled();
      expect(host.sessionTmuxTargets.get("claude-1")).toEqual(moved);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports interrupted when the live pane shows an interrupted prompt", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      updateSessionMetadata(
        "claude-1",
        (current) => ({
          ...current,
          derived: { ...(current.derived ?? {}), activity: "running", attention: "normal" },
        }),
        repoRoot,
      );
      const target = { sessionName: "aimux-test", windowId: "@3", windowIndex: 3, windowName: "claude" };
      const tmuxRuntimeManager = {
        getTargetByWindowId: vi.fn(() => target),
        getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "claude-1" })),
        captureTarget: vi.fn(() =>
          ["• Working (4s · esc to interrupt)", "", "Interrupted · What should Claude do instead?"].join("\n"),
        ),
        listProjectManagedWindows: vi.fn(() => []),
        isWindowAlive: vi.fn(() => true),
      };
      const host: any = {
        sessions: [{ id: "claude-1", command: "claude", status: "running" }],
        sessionTmuxTargets: new Map([["claude-1", target]]),
        sessionToolKeys: new Map([["claude-1", "claude"]]),
        sessionWorktreePaths: new Map([["claude-1", repoRoot]]),
        sessionLabels: new Map(),
        sessionRoles: new Map(),
        sessionOriginalArgs: new Map([["claude-1", []]]),
        offlineSessions: [],
        tmuxRuntimeManager,
        projectRoot: repoRoot,
      };

      const result = await readAgentOutput(host, "claude-1");

      expect(result.activity).toBe("interrupted");
      expect(result.activityText).toBe("");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not rewrite tmux window metadata that already matches", async () => {
    // The agent hook syncs this on every tool call. Writing an identical payload
    // cost a tmux fork that also flushed the read-only query memo.
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const target = { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "claude" };
      let stored: any = null;
      const tmuxRuntimeManager = {
        getTargetByWindowId: vi.fn(() => target),
        getWindowMetadata: vi.fn(() => stored),
        setWindowMetadata: vi.fn((_target: any, metadata: any) => {
          stored = JSON.parse(JSON.stringify(metadata));
        }),
        applyManagedAgentWindowPolicy: vi.fn(),
        isWindowAlive: vi.fn(() => true),
      };
      const transport = new TmuxSessionTransport("claude-1", "claude", target, tmuxRuntimeManager as any, 80, 24);
      const host: any = {
        sessions: [{ id: "claude-1", command: "claude", transport, startTime: Date.now() }],
        sessionTmuxTargets: new Map([["claude-1", target]]),
        sessionOriginalArgs: new Map([["claude-1", []]]),
        sessionToolKeys: new Map([["claude-1", "claude"]]),
        sessionWorktreePaths: new Map([["claude-1", repoRoot]]),
        sessionLabels: new Map(),
        sessionRoles: new Map(),
        offlineSessions: [],
        tmuxRuntimeManager,
      };

      try {
        syncTmuxWindowMetadata(host, "claude-1");
        for (let call = 0; call < 20; call += 1) syncTmuxWindowMetadata(host, "claude-1");

        expect(tmuxRuntimeManager.setWindowMetadata).toHaveBeenCalledTimes(1);
        // Policy is three constants derived from the tool key; once per window.
        expect(tmuxRuntimeManager.applyManagedAgentWindowPolicy).toHaveBeenCalledTimes(1);
      } finally {
        transport.destroy();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("writes tmux window metadata as soon as the payload actually changes", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const target = { sessionName: "aimux-test", windowId: "@8", windowIndex: 8, windowName: "claude" };
      let stored: any = null;
      const tmuxRuntimeManager = {
        getTargetByWindowId: vi.fn(() => target),
        getWindowMetadata: vi.fn(() => stored),
        setWindowMetadata: vi.fn((_target: any, metadata: any) => {
          stored = JSON.parse(JSON.stringify(metadata));
        }),
        applyManagedAgentWindowPolicy: vi.fn(),
        isWindowAlive: vi.fn(() => true),
      };
      const transport = new TmuxSessionTransport("claude-2", "claude", target, tmuxRuntimeManager as any, 80, 24);
      const host: any = {
        sessions: [{ id: "claude-2", command: "claude", transport, startTime: Date.now() }],
        sessionTmuxTargets: new Map([["claude-2", target]]),
        sessionOriginalArgs: new Map([["claude-2", []]]),
        sessionToolKeys: new Map([["claude-2", "claude"]]),
        sessionWorktreePaths: new Map([["claude-2", repoRoot]]),
        sessionLabels: new Map([["claude-2", "before"]]),
        sessionRoles: new Map(),
        offlineSessions: [],
        tmuxRuntimeManager,
      };

      try {
        syncTmuxWindowMetadata(host, "claude-2");
        expect(tmuxRuntimeManager.setWindowMetadata).toHaveBeenCalledTimes(1);

        // Exposé reads this payload live, so a change must land on the next sync
        // rather than waiting for a timer.
        host.sessionLabels.set("claude-2", "after");
        syncTmuxWindowMetadata(host, "claude-2");

        expect(tmuxRuntimeManager.setWindowMetadata).toHaveBeenCalledTimes(2);
        expect(stored.label).toBe("after");
      } finally {
        transport.destroy();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not stamp metadata onto a rejected metadata-less target", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-stale-metadata-"));
    try {
      await initPaths(repoRoot);
      const target = { sessionName: "aimux-test", windowId: "@9", windowIndex: 9, windowName: "claude" };
      const tmuxRuntimeManager = {
        getTargetByWindowId: vi.fn(() => target),
        getWindowMetadata: vi.fn(() => null),
        listProjectManagedWindows: vi.fn(() => []),
        setWindowMetadata: vi.fn(),
        applyManagedAgentWindowPolicy: vi.fn(),
      };
      const transport = new TmuxSessionTransport("claude-stale", "claude", target, tmuxRuntimeManager as any, 80, 24);
      const host: any = {
        sessions: [{ id: "claude-stale", command: "claude", transport, startTime: Date.now() - 60_000 }],
        sessionTmuxTargets: new Map([["claude-stale", target]]),
        sessionOriginalArgs: new Map([["claude-stale", []]]),
        sessionToolKeys: new Map([["claude-stale", "claude"]]),
        sessionWorktreePaths: new Map([["claude-stale", repoRoot]]),
        sessionLabels: new Map(),
        sessionRoles: new Map(),
        offlineSessions: [],
        tmuxRuntimeManager,
      };

      try {
        syncTmuxWindowMetadata(host, "claude-stale");

        expect(tmuxRuntimeManager.setWindowMetadata).not.toHaveBeenCalled();
        expect(tmuxRuntimeManager.applyManagedAgentWindowPolicy).not.toHaveBeenCalled();
      } finally {
        transport.destroy();
      }
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

  it("keeps a project service alive when its last session exits", async () => {
    // A project service outlives its sessions: its lifetime belongs to whoever
    // supervises the process. Resolving the run here exits with the session's
    // code, which a supervisor reads as a crash — and the daemon-hosted actor
    // never caught it, because it is the one caller that never assigns resolveRun.
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const runtime = { id: "claude-last", command: "claude", startTime: Date.now() - 60_000 };
      const resolveRun = vi.fn();
      const host: any = {
        mode: "project-service",
        sessions: [runtime],
        offlineSessions: [],
        stoppingSessionIds: new Set(),
        sessionOriginalArgs: new Map(),
        sessionToolKeys: new Map(),
        sessionWorktreePaths: new Map(),
        sessionTmuxTargets: new Map(),
        startedInDashboard: false,
        resolveRun,
        getSessionLabel: vi.fn(() => undefined),
        deriveHeadline: vi.fn(() => undefined),
        updateContextWatcherSessions: vi.fn(),
        writeStatuslineFile: vi.fn(),
        saveState: vi.fn(),
        renderDashboard: vi.fn(),
        publishAlert: vi.fn(),
      };

      handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

      expect(resolveRun).not.toHaveBeenCalled();
      expect(host.renderDashboard).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("still exits a non-dashboard, non-service host when its last session exits", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const runtime = { id: "claude-last", command: "claude", startTime: Date.now() - 60_000 };
      const resolveRun = vi.fn();
      const host: any = {
        mode: "dashboard",
        sessions: [runtime],
        offlineSessions: [],
        stoppingSessionIds: new Set(),
        sessionOriginalArgs: new Map(),
        sessionToolKeys: new Map(),
        sessionWorktreePaths: new Map(),
        sessionTmuxTargets: new Map(),
        startedInDashboard: false,
        resolveRun,
        getSessionLabel: vi.fn(() => undefined),
        deriveHeadline: vi.fn(() => undefined),
        updateContextWatcherSessions: vi.fn(),
        writeStatuslineFile: vi.fn(),
        saveState: vi.fn(),
        renderDashboard: vi.fn(),
        publishAlert: vi.fn(),
      };

      handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

      expect(resolveRun).toHaveBeenCalledWith(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
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

  it("blocks restore for quick unexpected exits even when a backend id exists", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const runtime = {
        id: "claude-current-crash",
        command: "claude",
        startTime: Date.now(),
        backendSessionId: "backend-current-crash",
      };
      const host: any = {
        sessions: [runtime],
        offlineSessions: [],
        stoppingSessionIds: new Set(),
        sessionOriginalArgs: new Map([["claude-current-crash", []]]),
        sessionToolKeys: new Map([["claude-current-crash", "claude"]]),
        sessionWorktreePaths: new Map([["claude-current-crash", repoRoot]]),
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

      expect(listTopologySessionStates({ statuses: ["offline"] })[0]).toMatchObject({
        id: "claude-current-crash",
        backendSessionId: "backend-current-crash",
        restoreBlockedReason: "agent exited during startup",
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("blocks restore when a restored session exits during the restore probe", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const runtime = {
        id: "claude-restored-exit",
        command: "claude",
        startTime: Date.now() - 20_000,
        restoreStartedAt: Date.now() - 5_000,
        backendSessionId: "backend-restored-exit",
      };
      const host: any = {
        sessions: [runtime],
        offlineSessions: [],
        stoppingSessionIds: new Set(),
        sessionOriginalArgs: new Map([["claude-restored-exit", ["--resume", "backend-restored-exit"]]]),
        sessionToolKeys: new Map([["claude-restored-exit", "claude"]]),
        sessionWorktreePaths: new Map([["claude-restored-exit", repoRoot]]),
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

      expect(listTopologySessionStates({ statuses: ["offline"] })[0]).toMatchObject({
        id: "claude-restored-exit",
        backendSessionId: "backend-restored-exit",
        restoreBlockedReason: "agent exited after restore",
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves fresh relaunchability when a stopped codex runtime exits without a backend id", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const runtime = {
        id: "codex-no-history",
        command: "codex",
        startTime: Date.now() - 20_000,
      };
      const host: any = {
        projectRoot: repoRoot,
        sessions: [runtime],
        offlineSessions: [],
        stoppingSessionIds: new Set(["codex-no-history"]),
        sessionOriginalArgs: new Map([["codex-no-history", ["--dangerously-bypass-approvals-and-sandbox"]]]),
        sessionToolKeys: new Map([["codex-no-history", "codex"]]),
        sessionWorktreePaths: new Map([["codex-no-history", repoRoot]]),
        sessionTmuxTargets: new Map(),
        startedInDashboard: true,
        getSessionLabel: vi.fn(() => undefined),
        deriveHeadline: vi.fn(() => undefined),
        updateContextWatcherSessions: vi.fn(),
        writeStatuslineFile: vi.fn(),
        saveState: vi.fn(),
        renderDashboard: vi.fn(),
        debug: vi.fn(),
      };

      handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

      expect(listTopologySessionStates({ statuses: ["offline"] })[0]).toMatchObject({
        id: "codex-no-history",
        freshRelaunchAllowed: true,
        restoreBlockedReason: undefined,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("writes exited runtime state to topology even when the offline projection is stale", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const runtime = {
        id: "claude-stale-cache",
        command: "claude",
        startTime: Date.now() - 20_000,
        backendSessionId: "backend-current",
      };
      const host: any = {
        projectRoot: repoRoot,
        sessions: [runtime],
        offlineSessions: [{ id: "claude-stale-cache", command: "claude", backendSessionId: "backend-stale" }],
        offlineServices: [],
        stoppingSessionIds: new Set(),
        sessionOriginalArgs: new Map([["claude-stale-cache", []]]),
        sessionToolKeys: new Map([["claude-stale-cache", "claude"]]),
        sessionWorktreePaths: new Map([["claude-stale-cache", repoRoot]]),
        sessionTmuxTargets: new Map(),
        startedInDashboard: true,
        getSessionLabel: vi.fn(() => undefined),
        deriveHeadline: vi.fn(() => undefined),
        updateContextWatcherSessions: vi.fn(),
        buildLiveServiceStates: vi.fn(() => []),
        isSessionRuntimeLive: vi.fn(() => false),
        invalidateDesktopStateSnapshot: vi.fn(),
        writeStatuslineFile: vi.fn(),
        saveState: vi.fn(() => runtimeLifecycleMethods.saveState.call(host as never)),
        loadOfflineTopologySessions: vi.fn(() => loadOfflineTopologySessions(host)),
        renderDashboard: vi.fn(),
      };

      handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

      expect(listTopologySessionStates({ statuses: ["offline"] })[0]).toMatchObject({
        id: "claude-stale-cache",
        backendSessionId: "backend-current",
      });
      expect(host.loadOfflineTopologySessions).toHaveBeenCalledOnce();
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

      expect(listTopologySessionStates({ statuses: ["offline"] })[0]).toMatchObject({
        id: "claude-team-exit",
        team,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("reconcileAgentActivity", () => {
  it("believes the pane over an enum that never got the memo", () => {
    // Measured live: claude-lgir7g reported idle while its pane counted up
    // through "Flambeing... (5m 37s)". Claude emits no event when it keeps
    // working after a response, so the enum simply stops moving.
    expect(reconcileAgentActivity("idle", "Flambeing... (5m 37s)")).toBe("running");
    expect(reconcileAgentActivity("done", "Booting... (1s)")).toBe("running");
    expect(reconcileAgentActivity(undefined, "Booting... (1s)")).toBe("running");
  });

  it("leaves the enum alone when the pane shows no progress line", () => {
    // Absence is not evidence of finishing: a pane between frames, or a tool
    // that prints no spinner at all, must not silently demote a live agent.
    expect(reconcileAgentActivity("running", "")).toBe("running");
    expect(reconcileAgentActivity("idle", "")).toBe("idle");
    expect(reconcileAgentActivity(undefined, undefined)).toBeUndefined();
  });

  it("never talks over a session that is blocked on its operator", () => {
    // An approval prompt can sit under a spinner. The operator needs to know
    // they are the blocker, which "Frosting..." would hide.
    expect(reconcileAgentActivity("waiting", "Frosting... (2s)")).toBe("waiting");
    expect(reconcileAgentActivity("error", "Frosting... (2s)")).toBe("error");
    expect(reconcileAgentActivity("interrupted", "Frosting... (2s)")).toBe("interrupted");
  });

  it("believes the pane when the visible prompt is interrupted", () => {
    expect(reconcileAgentActivity("running", "", { interruptedVisible: true })).toBe("interrupted");
    expect(reconcileAgentActivity("running", "Frosting... (2s)", { interruptedVisible: true })).toBe("interrupted");
  });
});

describe("what a forked session remembers as its args", () => {
  // The real composer, so this cannot pass against a drifted copy of it.
  const compose = (base: string[], action: string[], saved: string[]) =>
    SessionBootstrapService.prototype.composeToolArgs.call(null as never, { args: base }, action, saved);

  it("resumes itself, not its parent, on the next launch", () => {
    // Remembering the fork's own launch args would compose this on resume:
    //   claude … --resume <child> --resume <parent> --fork-session
    // which branches the parent again and throws the child's work away.
    const base = ["--dangerously-skip-permissions"];
    const parent = "0f0e2b1a-1111-2222-3333-444455556666";
    const child = "0f0e2b1a-7777-8888-9999-aaaabbbbcccc";

    const launchedWith = compose(base, ["--resume", parent, "--fork-session"], []);
    expect(launchedWith).toEqual([...base, "--resume", parent, "--fork-session"]);

    const remembered = base;
    const resumed = compose(base, ["--resume", child], remembered);
    expect(resumed).toEqual([...base, "--resume", child]);
    expect(resumed).not.toContain(parent);
    expect(resumed).not.toContain("--fork-session");

    const ifWeHadRememberedTheLaunch = compose(base, ["--resume", child], launchedWith);
    expect(ifWeHadRememberedTheLaunch).toContain("--fork-session");
  });
});
