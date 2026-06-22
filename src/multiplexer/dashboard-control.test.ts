import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getProjectServiceManifest } from "../project-service-manifest.js";

const mocks = vi.hoisted(() => ({
  requestJson: vi.fn(),
  loadMetadataEndpoint: vi.fn(),
  removeMetadataEndpoint: vi.fn(),
  ensureDaemonRunning: vi.fn(),
  ensureProjectService: vi.fn(),
  stopProjectService: vi.fn(),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

function healthyServiceResponse(pid = 2) {
  return { status: 200, json: { ok: true, pid, serviceInfo: getProjectServiceManifest() } };
}

vi.mock("../http-client.js", () => ({
  requestJson: mocks.requestJson,
  isHttpTimeoutError: (error: unknown) => (error as { code?: string })?.code === "ETIMEDOUT",
}));

vi.mock("../metadata-store.js", () => ({
  loadMetadataState: vi.fn(() => ({ sessions: {} })),
  loadMetadataEndpoint: mocks.loadMetadataEndpoint,
  removeMetadataEndpoint: mocks.removeMetadataEndpoint,
}));

vi.mock("../daemon.js", () => ({
  ensureDaemonRunning: mocks.ensureDaemonRunning,
  ensureProjectService: mocks.ensureProjectService,
  stopProjectService: mocks.stopProjectService,
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

let previousAimuxHome: string | undefined;
let testAimuxHome: string | null = null;

beforeEach(() => {
  previousAimuxHome = process.env.AIMUX_HOME;
  testAimuxHome = mkdtempSync(join(tmpdir(), "aimux-dashboard-control-"));
  process.env.AIMUX_HOME = testAimuxHome;
});

afterEach(() => {
  if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousAimuxHome;
  if (testAimuxHome) rmSync(testAimuxHome, { recursive: true, force: true });
  testAimuxHome = null;
});

describe("postToProjectService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.ensureDaemonRunning.mockResolvedValue({ pid: 1, port: 43190 });
    mocks.ensureProjectService.mockResolvedValue({ projectId: "repo", projectRoot: process.cwd(), pid: 2 });
    mocks.stopProjectService.mockResolvedValue({ projectId: "repo", projectRoot: process.cwd(), pid: 2 });
  });

  it("recovers from a stale refused project-service endpoint", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:43444"), { code: "ECONNREFUSED" });
    mocks.requestJson
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true } });
    const { postToProjectService } = await import("./dashboard-control.js");

    const result = await postToProjectService({ dashboardServiceRecovery: null }, "/agents/resume", {
      sessionId: "claude-1",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-retryable HTTP failures", async () => {
    mocks.requestJson
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 409, json: { ok: false, error: "already exists" } });
    const { postToProjectService } = await import("./dashboard-control.js");

    await expect(
      postToProjectService({ dashboardServiceRecovery: null }, "/agents/spawn", { sessionId: "claude-1" }),
    ).rejects.toThrow("already exists");

    expect(mocks.ensureProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson).toHaveBeenCalledTimes(2);
  });

  it("validates the first GET endpoint and caches recent health", async () => {
    mocks.requestJson
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 1 } })
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 2 } });
    const { getFromProjectService } = await import("./dashboard-control.js");
    const host = { dashboardServiceRecovery: null };

    await expect(getFromProjectService(host, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 1,
    });
    await expect(getFromProjectService(host, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 2,
    });

    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expect(mocks.stopProjectService).not.toHaveBeenCalled();
    expect(mocks.ensureProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
    expect(mocks.requestJson.mock.calls[0][0]).toContain("/health");
    expect(mocks.requestJson.mock.calls[1][0]).toContain("/desktop-state");
    expect(mocks.requestJson.mock.calls[2][0]).toContain("/desktop-state");
  });

  it("retries transient GET timeouts without restarting the project service", async () => {
    const timeout = Object.assign(new Error("request timed out after 250ms"), { code: "ETIMEDOUT" });
    mocks.requestJson
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 3 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 3,
    });

    expect(mocks.stopProjectService).not.toHaveBeenCalled();
    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expect(mocks.ensureProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
  });

  it("surfaces POST timeouts without replaying a mutating request", async () => {
    const timeout = Object.assign(new Error("request timed out after 250ms"), { code: "ETIMEDOUT" });
    mocks.requestJson.mockResolvedValueOnce(healthyServiceResponse()).mockRejectedValueOnce(timeout);
    const { postToProjectService } = await import("./dashboard-control.js");

    await expect(
      postToProjectService({ dashboardServiceRecovery: null }, "/agents/resume", { sessionId: "claude-1" }),
    ).rejects.toThrow("request timed out after 250ms");

    expect(mocks.stopProjectService).not.toHaveBeenCalled();
    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expect(mocks.ensureProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson).toHaveBeenCalledTimes(2);
  });

  it("restarts stale project-service endpoints before mutating requests", async () => {
    mocks.requestJson
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          pid: 2,
          serviceInfo: { ...getProjectServiceManifest(), buildStamp: "old-build" },
        },
      })
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true, resumed: true } });
    const { postToProjectService } = await import("./dashboard-control.js");

    await expect(
      postToProjectService({ dashboardServiceRecovery: null }, "/agents/resume", { sessionId: "claude-1" }),
    ).resolves.toEqual({ ok: true, resumed: true });

    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
    expect(mocks.requestJson.mock.calls[0][0]).toContain("/health");
    expect(mocks.requestJson.mock.calls[2][0]).toContain("/agents/resume");
  });

  it("restarts stale project-service endpoints before GET reads", async () => {
    mocks.requestJson
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          pid: 2,
          serviceInfo: { ...getProjectServiceManifest(), buildStamp: "old-build" },
        },
      })
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 4 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 4,
    });

    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
    expect(mocks.requestJson.mock.calls[0][0]).toContain("/health");
    expect(mocks.requestJson.mock.calls[2][0]).toContain("/desktop-state");
  });

  it("recovers after route connection-refused", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:43444"), { code: "ECONNREFUSED" });
    mocks.requestJson
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 4 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 4,
    });

    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(4);
  });

  it("restarts the project service before retrying retryable HTTP statuses", async () => {
    mocks.requestJson
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 503, json: { ok: false, error: "starting" } })
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 6 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 6,
    });

    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(4);
  });

  it("bounds control-plane recovery by the project-service request timeout", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadMetadataEndpoint.mockReturnValue(null);
      mocks.ensureDaemonRunning.mockImplementation(() => new Promise(() => {}));
      const { postToProjectService } = await import("./dashboard-control.js");

      const request = postToProjectService(
        { dashboardServiceRecovery: null },
        "/agents/resume",
        { sessionId: "claude-1" },
        { timeoutMs: 25 },
      );
      const rejection = expect(request).rejects.toThrow("project service recovery timed out");
      await vi.advanceTimersByTimeAsync(30);

      await rejection;
      expect(mocks.requestJson).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates a later restart request after an in-flight ensure completes", async () => {
    let finishEnsure: (() => void) | undefined;
    let ensureCalls = 0;
    mocks.ensureProjectService.mockImplementation(() => {
      ensureCalls += 1;
      if (ensureCalls === 1) {
        return new Promise((resolve) => {
          finishEnsure = () => resolve({ projectId: "repo", projectRoot: process.cwd(), pid: 2 });
        });
      }
      return Promise.resolve({ projectId: "repo", projectRoot: process.cwd(), pid: 3 });
    });
    const { ensureDashboardControlPlane } = await import("./dashboard-control.js");
    const host = { dashboardServiceRecovery: null };

    const first = ensureDashboardControlPlane(host, 1000);
    await Promise.resolve();
    const second = ensureDashboardControlPlane(host, 1000, { restartProjectService: true });
    await Promise.resolve();
    finishEnsure?.();
    await Promise.all([first, second]);

    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledTimes(2);
  });

  it("validates endpoints for raw dashboard streams before returning them", async () => {
    mocks.requestJson.mockResolvedValueOnce(healthyServiceResponse());
    const { resolveCurrentProjectServiceEndpointForDashboard } = await import("./dashboard-control.js");
    const endpoint = { host: "127.0.0.1", port: 43444, pid: 2 };
    mocks.loadMetadataEndpoint.mockReturnValue(endpoint);

    await expect(resolveCurrentProjectServiceEndpointForDashboard({ dashboardServiceRecovery: null })).resolves.toBe(
      endpoint,
    );

    expect(mocks.requestJson).toHaveBeenCalledWith(
      "http://127.0.0.1:43444/health",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });
});

describe("dashboard live target activation", () => {
  it("opens agents through the project-service control API in dashboard mode", async () => {
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : "@9")),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1" }, 1200)).resolves.toBe("opened");

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/control/open-notification-target",
      {
        sessionId: "codex-1",
        focus: true,
        currentClientSession: "aimux-repo-client-live",
        clientTty: "/dev/live",
        currentWindowId: "@9",
      },
      { timeoutMs: expect.any(Number) },
    );
    expect(host.postToProjectService.mock.calls[0][2].timeoutMs).toBeLessThanOrEqual(1200);
  });

  it("uses a restore-sized service timeout for offline agent activation", async () => {
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn(() => undefined),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1", status: "offline" })).resolves.toBe("opened");

    expect(host.postToProjectService.mock.calls[0][2].timeoutMs).toBeGreaterThan(30_000);
  });

  it("retries offline focus responses while waiting for restored agents", async () => {
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi
        .fn()
        .mockRejectedValueOnce(new Error("agent is offline"))
        .mockResolvedValueOnce({ ok: true }),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn(() => undefined),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1", status: "offline" }, 1000)).resolves.toBe(
      "opened",
    );

    expect(host.postToProjectService).toHaveBeenCalledTimes(2);
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("stops waiting for an agent focus when dashboard input invalidates the activation", async () => {
    vi.useFakeTimers();
    try {
      const token = { targetKind: "session", targetId: "codex-1", inputEpoch: 0 };
      const host: any = {
        mode: "dashboard",
        dashboardInputEpoch: 0,
        dashboardActivationToken: token,
        postToProjectService: vi.fn(async () => {
          host.mode = "session";
          host.dashboardInputEpoch = 1;
          throw new Error("agent is offline");
        }),
        tmuxRuntimeManager: {
          currentClientSession: vi.fn(() => "aimux-repo-client-live"),
          displayMessage: vi.fn(() => undefined),
        },
        showDashboardError: vi.fn(),
      };
      const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");

      const pending = waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1", status: "offline" }, 1000);
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toBe("missing");
      expect(host.postToProjectService).toHaveBeenCalledTimes(1);
      expect(host.showDashboardError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens services through the project-service control API in dashboard mode", async () => {
    const { waitAndOpenLiveTmuxWindowForService } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn(() => undefined),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForService(host, "service-1", 1200)).resolves.toBe("opened");

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/control/open-notification-target",
      {
        sessionId: "service-1",
        focus: true,
        currentClientSession: "aimux-repo-client-live",
        clientTty: undefined,
        currentWindowId: undefined,
      },
      { timeoutMs: expect.any(Number) },
    );
    expect(host.postToProjectService.mock.calls[0][2].timeoutMs).toBeLessThanOrEqual(1200);
  });
});

describe("showOrchestrationRoutePicker", () => {
  it("loads route options from the project service in dashboard mode", async () => {
    const { showOrchestrationRoutePicker } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      dashboardState: {
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [],
        worktreeSessions: [],
        worktreeNavOrder: [],
      },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => [{ id: "codex-1" }]),
      getFromProjectService: vi.fn(async () => ({
        ok: true,
        options: [
          {
            label: "Role: reviewer [1: codex-1]",
            assignee: "reviewer",
            worktreePath: "/repo/.aimux/worktrees/demo",
            recipientIds: ["codex-1"],
          },
        ],
      })),
      openDashboardOverlay: vi.fn(),
      renderOrchestrationRoutePicker: vi.fn(),
      showDashboardError: vi.fn(),
    };

    showOrchestrationRoutePicker(host, "task");
    await vi.waitFor(() => expect(host.renderOrchestrationRoutePicker).toHaveBeenCalledOnce());

    expect(host.getFromProjectService).toHaveBeenCalledWith(
      "/orchestration/routes?mode=task&selectedSessionId=codex-1&worktreePath=%2Frepo%2F.aimux%2Fworktrees%2Fdemo",
    );
    expect(host.orchestrationRouteMode).toBe("task");
    expect(host.orchestrationRouteOptions).toEqual([
      {
        label: "Role: reviewer [1: codex-1]",
        assignee: "reviewer",
        worktreePath: "/repo/.aimux/worktrees/demo",
        recipientIds: ["codex-1"],
      },
    ]);
    expect(host.openDashboardOverlay).toHaveBeenCalledWith("orchestration-route-picker");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("rejects malformed service route option payloads before opening the picker", async () => {
    const { showOrchestrationRoutePicker } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      dashboardState: { worktreeEntries: [], worktreeSessions: [], worktreeNavOrder: [] },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => []),
      getFromProjectService: vi.fn(async () => ({ ok: true, options: [{ recipientIds: "codex-1" }] })),
      openDashboardOverlay: vi.fn(),
      renderOrchestrationRoutePicker: vi.fn(),
      showDashboardError: vi.fn(),
    };

    showOrchestrationRoutePicker(host, "message");
    await vi.waitFor(() => expect(host.showDashboardError).toHaveBeenCalledOnce());

    expect(host.openDashboardOverlay).not.toHaveBeenCalled();
    expect(host.renderOrchestrationRoutePicker).not.toHaveBeenCalled();
  });

  it("does not open a stale route picker after newer dashboard input", async () => {
    let resolveRoutes!: (value: unknown) => void;
    const { showOrchestrationRoutePicker } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardState: { worktreeEntries: [], worktreeSessions: [], worktreeNavOrder: [] },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => []),
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRoutes = resolve;
          }),
      ),
      openDashboardOverlay: vi.fn(),
      renderOrchestrationRoutePicker: vi.fn(),
      showDashboardError: vi.fn(),
    };

    showOrchestrationRoutePicker(host, "message");
    host.dashboardInputEpoch = 1;
    resolveRoutes({ ok: true, options: [{ label: "Agent", sessionId: "codex-1" }] });
    await vi.waitFor(() => expect(host.getFromProjectService).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(host.openDashboardOverlay).not.toHaveBeenCalled();
    expect(host.renderOrchestrationRoutePicker).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });
});

describe("startRuntimeGuardRepair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not repair transient disconnected service states", async () => {
    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    startRuntimeGuardRepair(host as never, { kind: "disconnected" });

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(host.dashboardBusyState).toBeNull();
  });

  it("uses PATH aimux restart for guarded repair", async () => {
    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    const originalArgv = process.argv[1];
    const originalCliBin = process.env.AIMUX_CLI_BIN;
    process.argv[1] = "/Users/sam/cs/aimux/dist/main.js";
    delete process.env.AIMUX_CLI_BIN;
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    try {
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
    } finally {
      process.argv[1] = originalArgv;
      if (originalCliBin === undefined) delete process.env.AIMUX_CLI_BIN;
      else process.env.AIMUX_CLI_BIN = originalCliBin;
    }

    expect(mocks.spawn).toHaveBeenCalledWith("aimux", ["restart", "--project", "/repo/app"], {
      detached: true,
      stdio: "ignore",
    });
    expect(host.dashboardBusyState).toMatchObject({ title: "Repairing Aimux" });
  });

  it("does not spawn a second guarded repair while another dashboard owns the repair lock", async () => {
    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    const firstHost = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };
    const secondHost = {
      projectRoot: "/repo/other",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    startRuntimeGuardRepair(firstHost as never, { kind: "stale", reason: "service-mismatch" });
    startRuntimeGuardRepair(secondHost as never, { kind: "stale", reason: "service-mismatch" });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(secondHost.dashboardBusyState).toMatchObject({
      title: "Repairing Aimux",
      lines: ["Another dashboard is repairing the local control plane."],
    });
    expect(secondHost.runtimeGuardRepairBusy).toBe(true);
  });

  it("reclaims a repair lock owned by an exited repair child", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 987654) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    }) as typeof process.kill);
    mocks.spawn
      .mockReturnValueOnce({ pid: 987654, on: vi.fn(), unref: vi.fn() })
      .mockReturnValueOnce({ pid: 987655, on: vi.fn(), unref: vi.fn() });
    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    const firstHost = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };
    const secondHost = {
      projectRoot: "/repo/other",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    try {
      startRuntimeGuardRepair(firstHost as never, { kind: "stale", reason: "service-mismatch" });
      startRuntimeGuardRepair(secondHost as never, { kind: "stale", reason: "service-mismatch" });
    } finally {
      killSpy.mockRestore();
    }

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("shows a dashboard error when guarded repair fails to spawn", async () => {
    let onError: ((error: Error) => void) | undefined;
    mocks.spawn.mockReturnValueOnce({
      on: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") onError = handler;
      }),
      unref: vi.fn(),
    });
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
      showDashboardError: vi.fn(),
    };

    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    startRuntimeGuardRepair(host as never, { kind: "runtime-rebuild-required" });
    onError?.(new Error("spawn failed"));

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair failed", ["spawn failed"]);
  });

  it("does not show stale guarded repair failures after leaving dashboard mode", async () => {
    let onError: ((error: Error) => void) | undefined;
    mocks.spawn.mockReturnValueOnce({
      on: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") onError = handler;
      }),
      unref: vi.fn(),
    });
    const host = {
      mode: "dashboard",
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
      showDashboardError: vi.fn(),
    };

    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    startRuntimeGuardRepair(host as never, { kind: "runtime-rebuild-required" });
    host.mode = "session";
    onError?.(new Error("spawn failed"));

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.runtimeGuardRepairBusy).toBe(false);
    expect(host.dashboardBusyState).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("does not repeatedly spawn repair for the same guarded state after failure", async () => {
    let onError: ((error: Error) => void) | undefined;
    mocks.spawn.mockReturnValueOnce({
      on: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") onError = handler;
      }),
      unref: vi.fn(),
    });
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
      showDashboardError: vi.fn(),
    };
    const state = { kind: "stale", reason: "self-drift" } as const;

    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    startRuntimeGuardRepair(host as never, state);
    onError?.(new Error("spawn failed"));
    startRuntimeGuardRepair(host as never, state);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("clears busy state only after guarded repair verifies the runtime", async () => {
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    mocks.spawn.mockReturnValueOnce({
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === "exit") onExit = handler;
      }),
      unref: vi.fn(),
    });
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.requestJson.mockResolvedValue(healthyServiceResponse());
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      renderCurrentDashboardView: vi.fn(),
      dashboardModelServiceRefreshedAt: 0,
      refreshDashboardModelFromService: vi.fn(async () => {
        host.dashboardModelServiceRefreshedAt += 1;
        return false;
      }),
    };

    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
    onExit?.(0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.dashboardBusyState).toBeNull();
    expect(host.runtimeGuardState).toEqual({ kind: "ok" });
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
  });

  it("keeps guard failure visible when guarded repair exits but verification is still stale", async () => {
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    mocks.spawn.mockReturnValueOnce({
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === "exit") onExit = handler;
      }),
      unref: vi.fn(),
    });
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.requestJson.mockResolvedValue({
      status: 200,
      json: {
        ok: true,
        pid: 2,
        serviceInfo: { ...getProjectServiceManifest(), buildStamp: "old-build" },
      },
    });
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      renderCurrentDashboardView: vi.fn(),
      showDashboardError: vi.fn(),
      refreshDashboardModelFromService: vi.fn().mockResolvedValue(true),
    };

    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
    onExit?.(0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.runtimeGuardRepairFailedKey).toBe("stale:service-mismatch");
    expect(host.runtimeGuardState).toEqual({ kind: "stale", reason: "service-mismatch" });
    expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair failed", [
      "aimux repair completed but the control plane is still out of sync (service-mismatch)",
    ]);
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
  });

  it("uses AIMUX_CLI_BIN when the install shim exported a custom path", async () => {
    const { resolveDashboardReloadCommand } = await import("./dashboard-control.js");
    const originalCliBin = process.env.AIMUX_CLI_BIN;
    process.env.AIMUX_CLI_BIN = "/custom/bin/aimux";

    try {
      expect(resolveDashboardReloadCommand()).toBe("/custom/bin/aimux");
    } finally {
      if (originalCliBin === undefined) delete process.env.AIMUX_CLI_BIN;
      else process.env.AIMUX_CLI_BIN = originalCliBin;
    }
  });
});

describe("refreshRuntimeGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
  });

  function runtimeGuardHost() {
    return {
      mode: "dashboard",
      projectRoot: "/repo/app",
      runtimeGuardState: { kind: "ok" },
      runtimeGuardDisconnectProbeCount: 0,
      runtimeGuardProbing: false,
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };
  }

  it("does not restart Aimux for repeated disconnected health probes", async () => {
    mocks.requestJson.mockRejectedValue(new Error("request timed out after 250ms"));
    const host = runtimeGuardHost();
    host.runtimeGuardDisconnectProbeCount = 1;

    const { refreshRuntimeGuard } = await import("./dashboard-control.js");
    await refreshRuntimeGuard(host as never);

    expect(host.runtimeGuardState).toEqual({ kind: "disconnected" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(host.dashboardBusyState).toBeNull();
  });

  it("still restarts Aimux when the service manifest is stale", async () => {
    mocks.requestJson.mockResolvedValue({
      status: 200,
      json: {
        ok: true,
        pid: 2,
        serviceInfo: { ...getProjectServiceManifest(), buildStamp: "old-build" },
      },
    });
    const host = runtimeGuardHost();

    const { refreshRuntimeGuard } = await import("./dashboard-control.js");
    await refreshRuntimeGuard(host as never);

    expect(host.runtimeGuardState).toEqual({ kind: "stale", reason: "service-mismatch" });
    expect(mocks.spawn).toHaveBeenCalledWith("aimux", ["restart", "--project", "/repo/app"], {
      detached: true,
      stdio: "ignore",
    });
    expect(host.dashboardBusyState).toMatchObject({ title: "Repairing Aimux" });
  });

  it("keeps the repair overlay while a spawned repair is still running", async () => {
    mocks.requestJson.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() },
    });
    const host = runtimeGuardHost();
    host.runtimeGuardState = { kind: "stale", reason: "service-mismatch" };
    host.runtimeGuardRepairing = true;
    host.runtimeGuardRepairBusy = true;
    host.dashboardBusyState = { title: "Repairing Aimux", lines: [], spinnerFrame: 0, startedAt: Date.now() };

    const { refreshRuntimeGuard } = await import("./dashboard-control.js");
    await refreshRuntimeGuard(host as never);

    expect(host.runtimeGuardState).toEqual({ kind: "ok" });
    expect(host.dashboardBusyState).toMatchObject({ title: "Repairing Aimux" });
  });

  it("clears a competing-repair overlay after the guard recovers", async () => {
    mocks.requestJson.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() },
    });
    const host = runtimeGuardHost();
    host.runtimeGuardState = { kind: "stale", reason: "service-mismatch" };
    host.runtimeGuardRepairBusy = true;
    host.dashboardBusyState = {
      title: "Repairing Aimux",
      lines: ["Another dashboard is repairing the local control plane."],
      spinnerFrame: 0,
      startedAt: Date.now(),
    };

    const { refreshRuntimeGuard } = await import("./dashboard-control.js");
    await refreshRuntimeGuard(host as never);

    expect(host.runtimeGuardState).toEqual({ kind: "ok" });
    expect(host.dashboardBusyState).toBeNull();
    expect(host.runtimeGuardRepairBusy).toBe(false);
  });
});

describe("handleDashboardSubscreenNavigationKey", () => {
  function makeHost() {
    return {
      showCoordination: vi.fn(),
      renderCoordination: vi.fn(),
      showProject: vi.fn(),
      renderProject: vi.fn(),
      showLibrary: vi.fn(),
      renderLibrary: vi.fn(),
      showTopology: vi.fn(),
      renderTopology: vi.fn(),
      showGraveyard: vi.fn(),
      renderGraveyard: vi.fn(),
    };
  }

  it("maps leading-letter hotkeys to their screens (c/p/l/t/g)", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    const cases: Array<[string, keyof ReturnType<typeof makeHost>, string]> = [
      ["c", "showCoordination", "project"],
      ["p", "showProject", "coordination"],
      ["l", "showLibrary", "coordination"],
      ["t", "showTopology", "coordination"],
      ["g", "showGraveyard", "coordination"],
    ];
    for (const [key, method, otherScreen] of cases) {
      const host = makeHost();
      // currentScreen differs from target, so the show* (not render*) path runs.
      const handled = handleDashboardSubscreenNavigationKey(host as never, key, otherScreen as never);
      expect(handled).toBe(true);
      expect(host[method]).toHaveBeenCalledTimes(1);
    }
  });

  it("declines (returns false) when the hotkey matches the current screen, so the screen's own handler can act", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    // e.g. on coordination, [c] must reach the section handler (clear/complete), not re-nav.
    const cases: Array<[string, string, keyof ReturnType<typeof makeHost>]> = [
      ["c", "coordination", "showCoordination"],
      ["p", "project", "showProject"],
      ["l", "library", "showLibrary"],
      ["t", "topology", "showTopology"],
      ["g", "graveyard", "showGraveyard"],
    ];
    for (const [key, screen, showMethod] of cases) {
      const host = makeHost();
      expect(handleDashboardSubscreenNavigationKey(host as never, key, screen as never)).toBe(false);
      // Declining must not also fire the switch — the key belongs to the screen's own handler.
      expect(host[showMethod]).not.toHaveBeenCalled();
    }
  });

  it("no longer treats the retired i/y keys as navigation", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    for (const key of ["i", "y", "z"]) {
      const host = makeHost();
      expect(handleDashboardSubscreenNavigationKey(host as never, key, "graveyard")).toBe(false);
    }
  });
});
