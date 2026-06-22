import { describe, expect, it, vi } from "vitest";
import {
  createDashboardServiceWithFeedback,
  forkDashboardAgentWithFeedback,
  graveyardSessionWithFeedback,
  migrateSessionWithFeedback,
  removeDashboardServiceWithFeedback,
  resumeOfflineSessionWithFeedback,
  resumeOfflineServiceWithFeedback,
  spawnDashboardAgentWithFeedback,
  stopDashboardServiceWithFeedback,
  stopSessionToOfflineWithFeedback,
} from "./dashboard-ops.js";

function makePendingActionsFake() {
  const actions = new Map<string, string | null>();
  return {
    getSessionAction(sessionId: string) {
      return actions.get(`session:${sessionId}`);
    },
    getServiceAction(serviceId: string) {
      return actions.get(`service:${serviceId}`);
    },
    setSessionAction(sessionId: string, kind: string) {
      actions.set(`session:${sessionId}`, kind);
    },
    clearSessionAction(sessionId: string) {
      actions.set(`session:${sessionId}`, null);
    },
    setServiceAction(serviceId: string, kind: string) {
      actions.set(`service:${serviceId}`, kind);
    },
    clearServiceAction(serviceId: string) {
      actions.set(`service:${serviceId}`, null);
    },
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("dashboard-ops", () => {
  it("creates a service through the project service and clears creating when a live row appears", async () => {
    let createdServiceId = "";
    const services = [[], () => [{ id: createdServiceId, status: "running", pid: 1234, foregroundCommand: "zsh" }]];
    let serviceIndex = 0;
    const host = {
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardServiceAction(serviceId: string, kind: string | null, opts?: any) {
        if (kind === null) this.dashboardPendingActions.clearServiceAction(serviceId);
        else this.dashboardPendingActions.setServiceAction(serviceId, kind);
        this.serviceSeed = opts?.serviceSeed;
      },
      serviceSeed: undefined as any,
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      postToProjectService: vi.fn(async (_path: string, body: any) => {
        createdServiceId = body.serviceId;
      }),
      refreshDashboardModelFromService: vi.fn(async () => {
        serviceIndex = Math.min(serviceIndex + 1, services.length - 1);
        return true;
      }),
      getDashboardServices: vi.fn(() => {
        const value = services[serviceIndex];
        return typeof value === "function" ? value() : value;
      }),
      showDashboardError: vi.fn(),
    };

    await createDashboardServiceWithFeedback(host, "", "/repo");

    const serviceId = host.postToProjectService.mock.calls[0][1].serviceId;
    expect(serviceId).toMatch(/^service-/);
    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/services/create",
      { serviceId, command: "", worktreePath: "/repo" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.getServiceAction(serviceId)).toBeNull();
    expect(host.footerFlash).toBe("◆ Created service shell");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("shows optimistic starting state and clears it on successful service resume", async () => {
    const services = [[], [{ id: "svc-1", status: "running" }]];
    let serviceIndex = 0;
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardServiceAction(serviceId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearServiceAction(serviceId);
        else this.dashboardPendingActions.setServiceAction(serviceId, kind);
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
    expect(host.dashboardPendingActions.getServiceAction("svc-1")).toBeNull();
    expect(host.footerFlash).toBe("◆ Started service shell");
    expect(host.footerFlashTicks).toBe(3);
    expect(host.renderDashboard).toHaveBeenCalledTimes(2);
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("refreshes local state and shows a dashboard error when service resume fails", async () => {
    const host = {
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardServiceAction(serviceId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearServiceAction(serviceId);
        else this.dashboardPendingActions.setServiceAction(serviceId, kind);
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

    expect(host.dashboardPendingActions.getServiceAction("svc-1")).toBeNull();
    expect(host.refreshLocalDashboardModel).toHaveBeenCalledOnce();
    expect(host.showDashboardError).toHaveBeenCalledWith("Failed to start service", ["boom"]);
  });

  it("stops a service through the project service when a fresh snapshot has no model changes", async () => {
    const services = [[{ id: "svc-1", status: "running" }]];
    const host = {
      dashboardInputEpoch: 0,
      dashboardModelServiceRefreshedAt: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardServiceAction(serviceId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearServiceAction(serviceId);
        else this.dashboardPendingActions.setServiceAction(serviceId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        host.dashboardModelServiceRefreshedAt += 1;
        return false;
      }),
      getDashboardServices: vi.fn(() => services[0]),
      showDashboardError: vi.fn(),
    };

    await stopDashboardServiceWithFeedback(host, { id: "svc-1", label: "shell" });

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/services/stop",
      { serviceId: "svc-1" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.getServiceAction("svc-1")).toBeNull();
    expect(host.footerFlash).toBe("◆ Stopped service shell");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("removes an offline service through the project service in dashboard mode and waits for row removal", async () => {
    const services = [[{ id: "svc-1", status: "offline" }], []];
    let serviceIndex = 0;
    const host = {
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardServiceAction(serviceId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearServiceAction(serviceId);
        else this.dashboardPendingActions.setServiceAction(serviceId, kind);
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
    expect(host.dashboardPendingActions.getServiceAction("svc-1")).toBeNull();
    expect(host.footerFlash).toBe("◆ Deleted service shell");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("stops an agent through the project service when a fresh snapshot has no model changes", async () => {
    const session = { id: "sess-1", command: "claude", label: "claude" };
    const sessions = [[{ ...session, status: "running" }]];
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardModelServiceRefreshedAt: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      getSessionLabel: vi.fn(() => "claude"),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        host.dashboardModelServiceRefreshedAt += 1;
        return false;
      }),
      getDashboardSessions: vi.fn(() => sessions[0]),
      showDashboardError: vi.fn(),
    };

    await stopSessionToOfflineWithFeedback(host, session);

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/agents/stop",
      { sessionId: "sess-1" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Stopped claude");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("clears pending stop state without rendering stale completion after newer input", async () => {
    const session = { id: "sess-1", command: "claude", label: "claude" };
    const request = deferred();
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardModelServiceRefreshedAt: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      getSessionLabel: vi.fn(() => "claude"),
      postToProjectService: vi.fn(async () => request.promise),
      refreshDashboardModelFromService: vi.fn(async () => {
        host.dashboardModelServiceRefreshedAt += 1;
        return false;
      }),
      getDashboardSessions: vi.fn(() => [{ ...session, status: "running" }]),
      showDashboardError: vi.fn(),
    };

    const action = stopSessionToOfflineWithFeedback(host, session);
    await vi.waitFor(() => expect(host.postToProjectService).toHaveBeenCalledOnce());
    host.dashboardInputEpoch = 1;
    request.resolve();
    await action;

    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Stopping claude");
    expect(host.renderDashboard).toHaveBeenCalledTimes(1);
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("resumes an offline agent through the project service in dashboard mode and waits for the rendered row", async () => {
    const session = { id: "sess-1", command: "claude", label: "claude", backendSessionId: "backend-claude" };
    const sessions = [[], [{ ...session, status: "waiting", tmuxWindowId: "@21" }]];
    let sessionIndex = 0;
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardModelServiceRefreshedAt: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
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
      { timeoutMs: 60_000 },
    );
    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Restored claude");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("delegates dashboard restore to the project service even when cached restorability is blocked", async () => {
    const session = {
      id: "sess-1",
      command: "claude",
      label: "claude",
      restoreState: "blocked",
      restoreBlockedReason: "missing exact resumable backend session id",
    };
    const sessions = [[session], [{ ...session, status: "waiting", tmuxWindowId: "@21" }]];
    let sessionIndex = 0;
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        sessionIndex = Math.min(sessionIndex + 1, sessions.length - 1);
        return true;
      }),
      waitForSessionStart: vi.fn(),
      getDashboardSessions: vi.fn(() => sessions[sessionIndex]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineSessionWithFeedback(host, session);

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/agents/resume",
      { sessionId: "sess-1" },
      { timeoutMs: 60_000 },
    );
    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Restored claude");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("serializes concurrent dashboard agent restores", async () => {
    const first = deferred();
    const liveIds = new Set<string>();
    const postOrder: string[] = [];
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async (_path: string, body: any) => {
        postOrder.push(body.sessionId);
        if (body.sessionId === "sess-1") {
          await first.promise;
        }
        liveIds.add(body.sessionId);
      }),
      refreshDashboardModelFromService: vi.fn(async () => true),
      waitForSessionStart: vi.fn(async () => false),
      getDashboardSessions: vi.fn(() =>
        [...liveIds].map((id) => ({ id, command: "claude", status: "waiting", tmuxWindowId: `@${id}` })),
      ),
      showDashboardError: vi.fn(),
    };

    const restoreOne = resumeOfflineSessionWithFeedback(host, {
      id: "sess-1",
      command: "claude",
      args: [],
      backendSessionId: "backend-1",
    });
    await nextTick();
    const restoreTwo = resumeOfflineSessionWithFeedback(host, {
      id: "sess-2",
      command: "claude",
      args: [],
      backendSessionId: "backend-2",
    });
    await nextTick();

    expect(postOrder).toEqual(["sess-1"]);
    expect(host.dashboardPendingActions.getSessionAction("sess-2")).toBe("starting");

    first.resolve();
    await Promise.all([restoreOne, restoreTwo]);

    expect(postOrder).toEqual(["sess-1", "sess-2"]);
    expect(host.dashboardPendingActions.getSessionAction("sess-2")).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("surfaces partial teammate restore failures after restoring the parent agent", async () => {
    const session = { id: "parent-1", command: "claude", label: "claude", backendSessionId: "backend-parent" };
    const sessions = [[], [{ ...session, status: "waiting", tmuxWindowId: "@21" }]];
    let sessionIndex = 0;
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => ({
        ok: true,
        warning: "Failed to resume 2 teammates",
        teammateFailures: [
          { sessionId: "codex-1", error: "missing backend session id" },
          { sessionId: "codex-2", error: "missing backend session id" },
        ],
      })),
      refreshDashboardModelFromService: vi.fn(async () => {
        sessionIndex = Math.min(sessionIndex + 1, sessions.length - 1);
        return true;
      }),
      waitForSessionStart: vi.fn(async () => false),
      getDashboardSessions: vi.fn(() => sessions[sessionIndex]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineSessionWithFeedback(host, session);

    expect(host.dashboardPendingActions.getSessionAction("parent-1")).toBeNull();
    expect(host.footerFlash).toBe("Restored claude");
    expect(host.showDashboardError).toHaveBeenCalledWith('Restored "claude" with teammate issues', [
      "codex-1: missing backend session id",
      "codex-2: missing backend session id",
    ]);
  });

  it("surfaces structured teammate restore failures without a warning string", async () => {
    const session = { id: "parent-1", command: "claude", label: "claude", backendSessionId: "backend-parent" };
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => ({
        ok: true,
        teammateFailures: [{ sessionId: "codex-1", error: "missing backend session id" }],
      })),
      refreshDashboardModelFromService: vi.fn(async () => true),
      waitForSessionStart: vi.fn(async () => false),
      getDashboardSessions: vi.fn(() => [{ ...session, status: "waiting", tmuxWindowId: "@21" }]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineSessionWithFeedback(host, session);

    expect(host.showDashboardError).toHaveBeenCalledWith('Restored "claude" with teammate issues', [
      "codex-1: missing backend session id",
    ]);
  });

  it("does not surface bare teammate ids when partial restore failures are unstructured", async () => {
    const session = { id: "parent-1", command: "claude", label: "claude", backendSessionId: "backend-parent" };
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      postToProjectService: vi.fn(async () => ({
        ok: true,
        warning:
          'Failed to resume 2 teammates: codex-1: Cannot restore session "codex-1"; codex-2: Cannot restore session "codex-2"',
        teammateFailures: [{ sessionId: "codex-1" }, { sessionId: "codex-2" }],
      })),
      refreshDashboardModelFromService: vi.fn(async () => true),
      waitForSessionStart: vi.fn(async () => false),
      getDashboardSessions: vi.fn(() => [{ ...session, status: "waiting", tmuxWindowId: "@21" }]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineSessionWithFeedback(host, session);

    expect(host.showDashboardError).toHaveBeenCalledWith('Restored "claude" with teammate issues', [
      'Failed to resume 2 teammates: codex-1: Cannot restore session "codex-1"; codex-2: Cannot restore session "codex-2"',
      "Stale teammates remain offline; create a new team to replace them.",
    ]);
  });

  it("treats a live runtime as successful resume even if the rendered row stays stale", async () => {
    const session = { id: "sess-1", command: "codex", label: "codex", backendSessionId: "backend-codex" };
    const sessions = [
      [
        {
          ...session,
          status: "offline",
          pendingAction: "starting",
          pid: 77545,
          foregroundCommand: "volta-shim",
          tmuxWindowId: "@22",
        },
      ],
    ];
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
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
    expect(host.refreshLocalDashboardModel).not.toHaveBeenCalled();
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Restored codex");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("does not require renderDashboard during the wait-for-start settle branch", async () => {
    const session = { id: "sess-1", command: "codex", label: "codex", backendSessionId: "backend-codex" };
    let refreshCount = 0;
    let renderAccess = 0;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      refreshLocalDashboardModel: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        refreshCount += 1;
        return true;
      }),
      waitForSessionStart: vi.fn(async () => true),
      getDashboardSessions: vi.fn(() =>
        refreshCount < 2 ? [] : [{ ...session, status: "running", tmuxWindowId: "@21" }],
      ),
      showDashboardError: vi.fn(),
    };
    const renderDashboard = vi.fn();
    Object.defineProperty(host, "renderDashboard", {
      configurable: true,
      get() {
        renderAccess += 1;
        return renderAccess === 3 ? undefined : renderDashboard;
      },
    });

    await resumeOfflineSessionWithFeedback(host, session);

    expect(host.waitForSessionStart).toHaveBeenCalledWith("sess-1", expect.any(Number));
    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Restored codex");
    expect(renderDashboard).toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("preserves teammate metadata in dashboard resume pending seeds", async () => {
    const session = {
      id: "teammate-1",
      command: "codex",
      label: "reviewer",
      worktreePath: "/repo",
      backendSessionId: "backend-teammate",
      team: { teamId: "team-parent", parentSessionId: "parent-1", role: "reviewer" },
    };
    const sessions = [[], [{ ...session, status: "running", tmuxWindowId: "@1" }]];
    let sessionIndex = 0;
    const sessionSeeds: any[] = [];
    const host = {
      mode: "dashboard",
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null, opts?: any) {
        if (opts?.sessionSeed) sessionSeeds.push(opts.sessionSeed);
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
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

    expect(sessionSeeds[0]).toEqual(expect.objectContaining({ id: "teammate-1", team: session.team }));
    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/agents/resume",
      { sessionId: "teammate-1" },
      { timeoutMs: 60_000 },
    );
  });

  it("clears pending and reports restore failure when the service snapshot is unreachable", async () => {
    const session = { id: "sess-1", command: "codex", label: "codex", backendSessionId: "backend-codex" };
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardModelServiceRefreshError: new Error("offline"),
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => false),
      waitForSessionStart: vi.fn(async () => false),
      getDashboardSessions: vi.fn(() => [{ ...session, status: "offline", pendingAction: "starting" }]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineSessionWithFeedback(host, session);

    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.waitForSessionStart).not.toHaveBeenCalled();
    expect(host.showDashboardError).toHaveBeenCalledWith('Failed to restore "codex"', [
      "starting did not settle before timing out",
    ]);
  });

  it("treats a live tmux agent window as successful resume when the dashboard model lags", async () => {
    const session = { id: "sess-1", command: "claude", label: "claude", backendSessionId: "backend-claude" };
    const sessions = [[{ ...session, status: "offline", pendingAction: "starting" }]];
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => true),
      waitForSessionStart: vi.fn(async () => false),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => [
          {
            target: {
              sessionName: "aimux-repo",
              windowId: "@3",
              windowIndex: 3,
              windowName: "claude",
            },
            metadata: {
              kind: "agent",
              sessionId: "sess-1",
              command: "claude",
            },
          },
        ]),
        isWindowAlive: vi.fn(() => true),
      },
      getDashboardSessions: vi.fn(() => sessions[0]),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineSessionWithFeedback(host, session);

    expect(host.tmuxRuntimeManager.listProjectManagedWindows).toHaveBeenCalled();
    expect(host.refreshLocalDashboardModel).not.toHaveBeenCalled();
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Restored claude");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("treats a live service entry as successful resume even if the rendered row stays stale", async () => {
    const service = { id: "svc-1", label: "shell" };
    const services = [
      [{ ...service, status: "offline", pendingAction: "starting", pid: 61700, foregroundCommand: "zsh" }],
    ];
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardServiceAction(serviceId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearServiceAction(serviceId);
        else this.dashboardPendingActions.setServiceAction(serviceId, kind);
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

    expect(host.dashboardPendingActions.getServiceAction("svc-1")).toBeNull();
    expect(host.footerFlash).toBe("◆ Started service shell");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("keeps migrate pending until the migrated row is live", async () => {
    const session = { id: "sess-1", command: "codex", label: "codex", status: "running" };
    const sessions = [
      [session],
      [],
      [{ ...session, status: "running", pid: 77545, foregroundCommand: "codex", tmuxWindowId: "@23" }],
    ];
    let sessionIndex = 0;
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      getSessionLabel: vi.fn(() => "codex"),
      migrateAgent: vi.fn(async () => undefined),
      postToProjectService: vi.fn(async () => undefined),
      refreshDashboardModelFromService: vi.fn(async () => {
        sessionIndex = Math.min(sessionIndex + 1, sessions.length - 1);
        return true;
      }),
      refreshLocalDashboardModel: vi.fn(),
      getDashboardSessions: vi.fn(() => sessions[sessionIndex]),
      showDashboardError: vi.fn(),
    };

    await migrateSessionWithFeedback(host, session, "/repo/.aimux/worktrees/demo", "demo");

    expect(host.migrateAgent).not.toHaveBeenCalled();
    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/agents/migrate",
      { sessionId: "sess-1", worktreePath: "/repo/.aimux/worktrees/demo" },
      { timeoutMs: 10_000 },
    );
    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.footerFlash).toBe("Migrated codex to demo");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("graveyards an agent through the project service in dashboard mode and waits for row removal", async () => {
    const session = { id: "sess-1", command: "claude", label: "claude" };
    const sessions = [[session], []];
    let sessionIndex = 0;
    const host = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      offlineSessions: [] as any[],
      sessions: [session],
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
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
    expect(host.dashboardPendingActions.getSessionAction("sess-1")).toBeNull();
    expect(host.adjustAfterRemove).toHaveBeenCalledWith(true);
    expect(host.footerFlash).toBe("Sent claude to graveyard");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("spawns an agent through the project service in dashboard mode and waits for the row to appear", async () => {
    const sessions = [
      [],
      [{ id: "claude-abcd12", status: "running" }],
      [{ id: "claude-abcd12", status: "running", tmuxWindowId: "@42" }],
    ];
    let sessionIndex = 0;
    const host = {
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
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
        extraArgs: undefined,
        open: false,
      },
      { timeoutMs: 10_000 },
    );
    expect(host.preferDashboardEntrySelection).toHaveBeenCalledWith("session", "claude-abcd12", "/repo");
    expect(host.dashboardPendingActions.getSessionAction("claude-abcd12")).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("forks an agent through the project service in dashboard mode and waits for the row to appear", async () => {
    const sessions = [[], [{ id: "codex-fork12", status: "running", tmuxWindowId: "@43" }]];
    let sessionIndex = 0;
    const host = {
      dashboardPendingActions: makePendingActionsFake(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        if (kind === null) this.dashboardPendingActions.clearSessionAction(sessionId);
        else this.dashboardPendingActions.setSessionAction(sessionId, kind);
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
        extraArgs: undefined,
        open: false,
      },
      { timeoutMs: 10_000 },
    );
    expect(host.preferDashboardEntrySelection).toHaveBeenCalledWith("session", "codex-fork12", "/repo");
    expect(host.dashboardPendingActions.getSessionAction("codex-fork12")).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });
});
