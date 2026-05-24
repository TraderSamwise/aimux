import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import { recordSessionBackendSessionIdMetadata } from "../metadata-store.js";
import { readSessionInputOperation } from "../session-input-operations.js";
import { readSessionMessages } from "../session-message-history.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import {
  buildTmuxWindowMetadata,
  handleSessionRuntimeEvent,
  normalizeAgentInput,
  paneStillContainsAgentDraft,
  registerManagedSession,
  resolveLiveSessionTmuxTarget,
  scheduleTmuxAgentSubmit,
  updateSessionLabel,
  writeAgentInput,
} from "./session-runtime-core.js";

describe("session runtime prompt submission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats Codex pasted-content markers as a still-visible draft", () => {
    const host: any = {
      tmuxRuntimeManager: {
        captureTarget: vi.fn(() => "› [Pasted Content 3434 chars]"),
      },
    };

    expect(
      paneStillContainsAgentDraft(
        host,
        { windowId: "@1" },
        "This is a long aimux task prompt that Codex will collapse into a pasted-content marker.",
      ),
    ).toBe(true);
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

  it("compacts Codex submitted injections to the single-line shape used by startup kickoff", () => {
    const host: any = {
      sessionToolKeys: new Map([["codex-1", "codex"]]),
    };

    expect(normalizeAgentInput(host, "Aimux task\n\nRun:\n  aimux task show t1\n", true, "codex-1")).toBe(
      "Aimux task Run: aimux task show t1",
    );
  });

  it("preserves multiline submitted injections for non-Codex tools", () => {
    const host: any = {
      sessionToolKeys: new Map([["claude-1", "claude"]]),
    };

    expect(normalizeAgentInput(host, "Aimux task\n\nRun:\n  aimux task show t1\n", true, "claude-1")).toBe(
      "Aimux task\n\nRun:\n  aimux task show t1",
    );
  });

  it("submits agent prompt injection with raw carriage return after the draft is stable", () => {
    vi.useFakeTimers();
    const target = { windowId: "@1" };
    const captures = [
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "",
    ];
    const host: any = {
      sessionTmuxTargets: new Map([["codex-1", target]]),
      tmuxRuntimeManager: {
        captureTarget: vi.fn(() => captures.shift() ?? ""),
        sendCarriageReturn: vi.fn(),
        sendEnter: vi.fn(),
      },
    };

    scheduleTmuxAgentSubmit(host, "codex-1", target, "Review task details and respond through aimux.");

    vi.advanceTimersByTime(300);
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(200);

    expect(host.tmuxRuntimeManager.sendCarriageReturn).toHaveBeenCalledWith(target);
    expect(host.tmuxRuntimeManager.sendEnter).not.toHaveBeenCalled();
  });

  it("marks submitted tmux input only after carriage return delivery succeeds", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    vi.useFakeTimers();
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" };
    const captures = [
      "› Review task details",
      "› Review task details",
      "› Review task details",
      "› Review task details",
      "",
    ];
    const tmuxRuntimeManager: any = {
      captureTarget: vi.fn(() => captures.shift() ?? ""),
      sendText: vi.fn(),
      sendKey: vi.fn(),
      sendEnter: vi.fn(),
      sendCarriageReturn: vi.fn(),
      getTargetByWindowId: vi.fn(() => target),
      getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "codex-1" })),
      isWindowAlive: vi.fn(() => true),
    };
    const transport = new TmuxSessionTransport("codex-1", "codex", target, tmuxRuntimeManager, 80, 24);
    try {
      await initPaths(repoRoot);
      const host: any = {
        sessions: [{ id: "codex-1", transport, exited: false }],
        sessionToolKeys: new Map([["codex-1", "codex"]]),
        sessionTmuxTargets: new Map([["codex-1", target]]),
        tmuxRuntimeManager,
      };

      const resultPromise = writeAgentInput(
        host,
        "codex-1",
        "Review task details",
        undefined,
        "client-message-1",
        true,
      );

      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(700);

      const result = await resultPromise;

      expect(result.accepted).toBe(true);
      expect(result.operation.state).toBe("submitted");
      expect(readSessionInputOperation(result.operation.id)?.state).toBe("submitted");
      expect(tmuxRuntimeManager.sendText).toHaveBeenCalledWith(target, "Review task details");
      expect(tmuxRuntimeManager.sendCarriageReturn).toHaveBeenCalledWith(target);
      expect(tmuxRuntimeManager.sendEnter).not.toHaveBeenCalled();
    } finally {
      transport.destroy();
      vi.useRealTimers();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("prefixes multi-user input for the agent while storing original message metadata", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      const writes: string[] = [];
      const host: any = {
        sessions: [
          {
            id: "claude-1",
            exited: false,
            write: (data: string) => writes.push(data),
          },
        ],
        sessionToolKeys: new Map([["claude-1", "claude"]]),
      };

      const result = await writeAgentInput(host, "claude-1", "Can you check this?", undefined, "client-1", true, {
        shareId: "share_123",
        mode: "multi",
        actor: {
          userId: "user_123",
          displayName: "Sam Steady",
          email: "sam@example.com",
          role: "owner",
        },
      });

      const repeat = await writeAgentInput(host, "claude-1", "Second question", undefined, "client-2", true, {
        shareId: "share_123",
        mode: "multi",
        actor: {
          userId: "user_123",
          displayName: "Sam Steady",
          email: "sam@example.com",
          role: "owner",
        },
      });
      const downgraded = await writeAgentInput(host, "claude-1", "Back to normal", undefined, "client-3", true, {
        shareId: "share_123",
        mode: "single",
        actor: {
          userId: "user_123",
          displayName: "Sam Steady",
          email: "sam@example.com",
          role: "owner",
        },
      });

      expect(result.accepted).toBe(true);
      expect(repeat.accepted).toBe(true);
      expect(downgraded.accepted).toBe(true);
      expect(writes).toEqual([
        "Aimux collaboration note: This shared chat is now multi-user. Human messages are prefixed as [Name]: message so you can distinguish participants.\n\n[Sam Steady]: Can you check this?\r",
        "[Sam Steady]: Second question\r",
        "Aimux collaboration note: This shared chat is back to single-user mode. Future unprefixed user messages are from the remaining participant.\n\nBack to normal\r",
      ]);
      expect(readSessionMessages("claude-1")).toMatchObject([
        {
          clientMessageId: "client-1",
          sessionId: "claude-1",
          role: "user",
          parts: [{ type: "text", text: "Can you check this?" }],
          actor: {
            userId: "user_123",
            displayName: "Sam Steady",
            email: "sam@example.com",
            role: "owner",
          },
          shareId: "share_123",
          chatMode: "multi",
        },
        {
          clientMessageId: "client-2",
          parts: [{ type: "text", text: "Second question" }],
          chatMode: "multi",
        },
        {
          clientMessageId: "client-3",
          parts: [{ type: "text", text: "Back to normal" }],
          chatMode: "single",
        },
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails submitted tmux input when the target disappears before prompt submission", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    vi.useFakeTimers();
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" };
    let lookups = 0;
    const tmuxRuntimeManager: any = {
      captureTarget: vi.fn(() => "› Review task details"),
      sendText: vi.fn(),
      sendKey: vi.fn(),
      sendEnter: vi.fn(),
      sendCarriageReturn: vi.fn(),
      getTargetByWindowId: vi.fn(() => {
        lookups += 1;
        return lookups <= 2 ? target : undefined;
      }),
      getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "codex-1" })),
      isWindowAlive: vi.fn(() => true),
      listProjectManagedWindows: vi.fn(() => []),
    };
    const transport = new TmuxSessionTransport("codex-1", "codex", target, tmuxRuntimeManager, 80, 24);
    try {
      await initPaths(repoRoot);
      const host: any = {
        sessions: [{ id: "codex-1", transport, exited: false }],
        sessionToolKeys: new Map([["codex-1", "codex"]]),
        sessionTmuxTargets: new Map([["codex-1", target]]),
        tmuxRuntimeManager,
      };

      const resultPromise = writeAgentInput(host, "codex-1", "Review task details", undefined, undefined, true);

      await vi.advanceTimersByTimeAsync(300);

      const result = await resultPromise;

      expect(result.accepted).toBe(false);
      expect(result.operation.state).toBe("failed");
      expect(result.error).toContain("prompt submit was not accepted");
      expect(readSessionInputOperation(result.operation.id)?.state).toBe("failed");
      expect(tmuxRuntimeManager.sendText).toHaveBeenCalledWith(target, "Review task details");
      expect(tmuxRuntimeManager.sendCarriageReturn).not.toHaveBeenCalled();
    } finally {
      transport.destroy();
      vi.useRealTimers();
      rmSync(repoRoot, { recursive: true, force: true });
    }
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

  it("publishes metadata backend ids to tmux metadata when the runtime has not learned them yet", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      recordSessionBackendSessionIdMetadata("claude-racy", "backend-racy", repoRoot);
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
        backendSessionId: "backend-racy",
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps runtime backend ids ahead of stale metadata in tmux metadata", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      recordSessionBackendSessionIdMetadata("claude-current", "backend-stale", repoRoot);
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
      writeSessionsFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      contextWatcher: { start: vi.fn() },
    };

    const runtime = registerManagedSession(host, transport, [], "codex", undefined, "coder", undefined, team);

    expect(runtime.team).toEqual(team);
    expect(host.sessionRoles.get("codex-1")).toBeUndefined();
  });

  it("preserves quick exited sessions when durable metadata has the backend id", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      recordSessionBackendSessionIdMetadata("claude-racy-exit", "backend-racy-exit", repoRoot);
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
        writeSessionsFile: vi.fn(),
        updateContextWatcherSessions: vi.fn(),
        writeStatuslineFile: vi.fn(),
        saveState: vi.fn(),
        renderDashboard: vi.fn(),
      };

      handleSessionRuntimeEvent(host, runtime, { type: "exit", code: 0 });

      expect(host.offlineSessions).toEqual([
        expect.objectContaining({
          id: "claude-racy-exit",
          lifecycle: "offline",
          backendSessionId: "backend-racy-exit",
        }),
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps runtime backend ids ahead of stale metadata when preserving exited sessions", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-"));
    try {
      await initPaths(repoRoot);
      recordSessionBackendSessionIdMetadata("claude-current-exit", "backend-stale-exit", repoRoot);
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
        writeSessionsFile: vi.fn(),
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
        writeSessionsFile: vi.fn(),
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
        writeSessionsFile: vi.fn(),
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
