import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import { recordSessionBackendSessionIdMetadata } from "../metadata-store.js";
import {
  buildTmuxWindowMetadata,
  handleSessionRuntimeEvent,
  normalizeAgentInput,
  paneStillContainsAgentDraft,
  resolveLiveSessionTmuxTarget,
  scheduleTmuxAgentSubmit,
  updateSessionLabel,
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
});
