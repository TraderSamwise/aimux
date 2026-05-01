import { describe, expect, it, vi } from "vitest";
import {
  forkDashboardAgentWithFeedback,
  graveyardSessionWithFeedback,
  removeDashboardServiceWithFeedback,
  resumeOfflineSessionWithFeedback,
  resumeOfflineServiceWithFeedback,
  spawnDashboardAgentWithFeedback,
  stopDashboardServiceWithFeedback,
  stopSessionToOfflineWithFeedback,
} from "./dashboard-ops.js";

describe("dashboard-ops", () => {
  it("shows optimistic starting state and clears it on successful service resume", async () => {
    const services = [
      [{ id: "svc-1", status: "offline", pendingAction: "starting" }],
      [{ id: "svc-1", status: "running" }],
    ];
    let serviceIndex = 0;
    const host = {
      mode: "dashboard",
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        serviceIndex = Math.min(serviceIndex + 1, services.length - 1);
        return true;
      }),
      getDashboardServices: vi.fn(() => services[serviceIndex]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineServiceWithFeedback(host, { id: "svc-1", label: "shell" });

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/services/resume",
      { serviceId: "svc-1" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.get("svc-1")).toBeNull();
    expect(host.footerFlash).toBe("◆ Started service shell");
    expect(host.footerFlashTicks).toBe(3);
    expect(host.renderDashboard).toHaveBeenCalledTimes(2);
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("refreshes local state and shows a dashboard error when service resume fails", async () => {
    const host = {
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      resumeOfflineServiceById: vi.fn(() => {
        throw new Error("boom");
      }),
      refreshLocalDashboardModel: vi.fn(),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineServiceWithFeedback(host, { id: "svc-1", label: "shell" });

    expect(host.dashboardPendingActions.get("svc-1")).toBeNull();
    expect(host.refreshLocalDashboardModel).toHaveBeenCalledOnce();
    expect(host.showDashboardError).toHaveBeenCalledWith("Failed to start service", ["boom"]);
  });

  it("stops a service through the project service in dashboard mode and waits for offline render state", async () => {
    const services = [[{ id: "svc-1", status: "running" }], [], [{ id: "svc-1", status: "offline" }]];
    let serviceIndex = 0;
    const host = {
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        serviceIndex = Math.min(serviceIndex + 1, services.length - 1);
        return true;
      }),
      getDashboardServices: vi.fn(() => services[serviceIndex]),
      showDashboardError: vi.fn(),
    };

    await stopDashboardServiceWithFeedback(host, { id: "svc-1", label: "shell" });

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/services/stop",
      { serviceId: "svc-1" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.get("svc-1")).toBeNull();
    expect(host.footerFlash).toBe("◆ Stopped service shell");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("removes an offline service through the project service in dashboard mode and waits for row removal", async () => {
    const services = [[{ id: "svc-1", status: "offline" }], []];
    let serviceIndex = 0;
    const host = {
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        serviceIndex = Math.min(serviceIndex + 1, services.length - 1);
        return true;
      }),
      getDashboardServices: vi.fn(() => services[serviceIndex]),
      showDashboardError: vi.fn(),
    };

    await removeDashboardServiceWithFeedback(host, { id: "svc-1", label: "shell" });

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/services/remove",
      { serviceId: "svc-1" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.get("svc-1")).toBeNull();
    expect(host.footerFlash).toBe("◆ Deleted service shell");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("stops an agent through the project service in dashboard mode and waits for offline render state", async () => {
    const session = { id: "sess-1", command: "claude", label: "claude" };
    const sessions = [[{ ...session, status: "running" }], [], [{ ...session, status: "offline" }]];
    let sessionIndex = 0;
    const host = {
      mode: "dashboard",
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      getSessionLabel: vi.fn(() => "claude"),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        sessionIndex = Math.min(sessionIndex + 1, sessions.length - 1);
        return true;
      }),
      getDashboardSessions: vi.fn(() => sessions[sessionIndex]),
      showDashboardError: vi.fn(),
    };

    await stopSessionToOfflineWithFeedback(host, session);

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/agents/stop",
      { sessionId: "sess-1" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.get("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Stopped claude");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("resumes an offline agent through the project service in dashboard mode and waits for the rendered row", async () => {
    const session = { id: "sess-1", command: "claude", label: "claude" };
    const sessions = [
      [{ ...session, status: "offline", pendingAction: "starting" }],
      [{ ...session, status: "waiting" }],
    ];
    let sessionIndex = 0;
    const host = {
      mode: "dashboard",
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        sessionIndex = Math.min(sessionIndex + 1, sessions.length - 1);
        return true;
      }),
      waitForSessionStart: vi.fn(async () => false),
      getDashboardSessions: vi.fn(() => sessions[sessionIndex]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineSessionWithFeedback(host, session);

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/agents/resume",
      { sessionId: "sess-1" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.get("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Restored claude");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("treats a live runtime as successful resume even if the rendered row stays stale", async () => {
    const session = { id: "sess-1", command: "codex", label: "codex" };
    const sessions = [
      [{ ...session, status: "offline", pendingAction: "starting", pid: 77545, foregroundCommand: "volta-shim" }],
    ];
    const host = {
      mode: "dashboard",
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => true),
      waitForSessionStart: vi.fn(async () => true),
      getDashboardSessions: vi.fn(() => sessions[0]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineSessionWithFeedback(host, session);

    expect(host.waitForSessionStart).not.toHaveBeenCalled();
    expect(host.refreshLocalDashboardModel).toHaveBeenCalled();
    expect(host.dashboardPendingActions.get("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Restored codex");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("treats a live service entry as successful resume even if the rendered row stays stale", async () => {
    const service = { id: "svc-1", label: "shell" };
    const services = [
      [{ ...service, status: "offline", pendingAction: "starting", pid: 61700, foregroundCommand: "zsh" }],
    ];
    const host = {
      mode: "dashboard",
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(serviceId: string, kind: string | null) {
        this.dashboardPendingActions.set(serviceId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => true),
      getDashboardServices: vi.fn(() => services[0]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineServiceWithFeedback(host, service);

    expect(host.dashboardPendingActions.get("svc-1")).toBeNull();
    expect(host.footerFlash).toBe("◆ Started service shell");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("graveyards an agent through the project service in dashboard mode and waits for row removal", async () => {
    const session = { id: "sess-1", command: "claude", label: "claude" };
    const sessions = [[session], []];
    let sessionIndex = 0;
    const host = {
      mode: "dashboard",
      offlineSessions: [] as any[],
      sessions: [session],
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      getSessionLabel: vi.fn(() => "claude"),
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        sessionIndex = Math.min(sessionIndex + 1, sessions.length - 1);
        return true;
      }),
      getDashboardSessions: vi.fn(() => sessions[sessionIndex]),
      adjustAfterRemove: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
      showDashboardError: vi.fn(),
    };

    await graveyardSessionWithFeedback(host, "sess-1", true);

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/agents/kill",
      { sessionId: "sess-1" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.get("sess-1")).toBeNull();
    expect(host.adjustAfterRemove).toHaveBeenCalledWith(true);
    expect(host.footerFlash).toBe("Sent claude to graveyard");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("spawns an agent through the project service in dashboard mode and waits for the row to appear", async () => {
    const sessions = [[], [{ id: "claude-abcd12", status: "running" }]];
    let sessionIndex = 0;
    const host = {
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      preferDashboardEntrySelection: vi.fn(),
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        sessionIndex = Math.min(sessionIndex + 1, sessions.length - 1);
        return true;
      }),
      getDashboardSessions: vi.fn(() => sessions[sessionIndex]),
      showDashboardError: vi.fn(),
    };

    await spawnDashboardAgentWithFeedback(host, {
      sessionId: "claude-abcd12",
      tool: "claude",
      worktreePath: "/repo",
    });

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/agents/spawn",
      {
        tool: "claude",
        sessionId: "claude-abcd12",
        worktreePath: "/repo",
        open: false,
      },
      { timeoutMs: 10_000 },
    );
    expect(host.preferDashboardEntrySelection).toHaveBeenCalledWith("session", "claude-abcd12", "/repo");
    expect(host.dashboardPendingActions.get("claude-abcd12")).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("forks an agent through the project service in dashboard mode and waits for the row to appear", async () => {
    const sessions = [[], [{ id: "codex-fork12", status: "running" }]];
    let sessionIndex = 0;
    const host = {
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      preferDashboardEntrySelection: vi.fn(),
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        sessionIndex = Math.min(sessionIndex + 1, sessions.length - 1);
        return true;
      }),
      getDashboardSessions: vi.fn(() => sessions[sessionIndex]),
      showDashboardError: vi.fn(),
    };

    await forkDashboardAgentWithFeedback(host, {
      sourceSessionId: "claude-src",
      targetSessionId: "codex-fork12",
      tool: "codex",
      worktreePath: "/repo",
    });

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/agents/fork",
      {
        sourceSessionId: "claude-src",
        targetSessionId: "codex-fork12",
        tool: "codex",
        instruction: undefined,
        worktreePath: "/repo",
        open: false,
      },
      { timeoutMs: 10_000 },
    );
    expect(host.preferDashboardEntrySelection).toHaveBeenCalledWith("session", "codex-fork12", "/repo");
    expect(host.dashboardPendingActions.get("codex-fork12")).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });
});
