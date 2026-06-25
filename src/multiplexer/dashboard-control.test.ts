import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getProjectServiceManifest } from "../project-service-manifest.js";
import { getProjectStateDirFor } from "../paths.js";

const mocks = vi.hoisted(() => ({
  requestJson: vi.fn(),
  loadMetadataEndpoint: vi.fn(),
  removeMetadataEndpoint: vi.fn(),
  updateSessionMetadata: vi.fn(),
  ensureDaemonRunning: vi.fn(),
  ensureProjectService: vi.fn(),
  stopProjectService: vi.fn(),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

function healthyServiceResponse(pid = 2, projectRoot = process.cwd()) {
  return {
    status: 200,
    json: {
      ok: true,
      projectStateDir: getProjectStateDirFor(projectRoot),
      pid,
      serviceInfo: getProjectServiceManifest(),
    },
  };
}

function resetDashboardControlMocks(): void {
  vi.resetModules();
  mocks.requestJson.mockReset();
  mocks.loadMetadataEndpoint.mockReset();
  mocks.removeMetadataEndpoint.mockReset();
  mocks.updateSessionMetadata.mockReset();
  mocks.ensureDaemonRunning.mockReset();
  mocks.ensureProjectService.mockReset();
  mocks.stopProjectService.mockReset();
  mocks.spawn.mockReset();
  mocks.spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
  mocks.loadMetadataEndpoint.mockReturnValue({
    host: "127.0.0.1",
    port: 43444,
    pid: 2,
    updatedAt: "2026-06-21T00:00:00.000Z",
  });
  mocks.ensureDaemonRunning.mockResolvedValue({ pid: 1, port: 43190 });
  mocks.ensureProjectService.mockResolvedValue({ projectId: "repo", projectRoot: process.cwd(), pid: 2 });
  mocks.stopProjectService.mockResolvedValue({ projectId: "repo", projectRoot: process.cwd(), pid: 2 });
}

vi.mock("../http-client.js", () => ({
  requestJson: mocks.requestJson,
  isHttpTimeoutError: (error: unknown) => (error as { code?: string })?.code === "ETIMEDOUT",
}));

vi.mock("../metadata-store.js", () => ({
  loadMetadataState: vi.fn(() => ({ sessions: {} })),
  loadMetadataEndpoint: mocks.loadMetadataEndpoint,
  removeMetadataEndpoint: mocks.removeMetadataEndpoint,
  updateSessionMetadata: mocks.updateSessionMetadata,
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
    resetDashboardControlMocks();
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

  it("repairs the dashboard host project instead of process cwd", async () => {
    const projectRoot = "/repo/actual-project";
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:43444"), { code: "ECONNREFUSED" });
    mocks.requestJson
      .mockResolvedValueOnce(healthyServiceResponse(2, projectRoot))
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(healthyServiceResponse(2, projectRoot))
      .mockResolvedValueOnce({ status: 200, json: { ok: true } });
    const { postToProjectService } = await import("./dashboard-control.js");

    const result = await postToProjectService(
      { dashboardServiceRecovery: null, projectRoot },
      "/agents/resume",
      { sessionId: "claude-1" },
    );

    expect(result).toEqual({ ok: true });
    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(projectRoot);
    expect(mocks.stopProjectService).toHaveBeenCalledWith(projectRoot);
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(projectRoot);
    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalledWith(process.cwd());
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

  it("validates GET routes once and reuses the endpoint health cache", async () => {
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

  it("does not restart the project service when a GET route succeeds", async () => {
    mocks.requestJson
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 8 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 8,
    });

    expect(mocks.stopProjectService).not.toHaveBeenCalled();
    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expect(mocks.ensureProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson).toHaveBeenCalledTimes(2);
    expect(mocks.requestJson.mock.calls[0][0]).toContain("/health");
    expect(mocks.requestJson.mock.calls[1][0]).toContain("/desktop-state");
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

  it("does not send mutating requests when endpoint identity cannot be verified", async () => {
    const timeout = Object.assign(new Error("request timed out after 20ms"), { code: "ETIMEDOUT" });
    mocks.requestJson.mockRejectedValue(timeout);
    const { postToProjectService } = await import("./dashboard-control.js");

    await expect(
      postToProjectService(
        { dashboardServiceRecovery: null },
        "/agents/resume",
        { sessionId: "claude-1" },
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow("project service endpoint could not be verified");

    expect(mocks.stopProjectService).not.toHaveBeenCalled();
    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expect(mocks.ensureProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson.mock.calls.every((call) => !String(call[0]).includes("/agents/resume"))).toBe(true);
  });

  it("restarts stale project-service endpoints before mutating requests", async () => {
    mocks.requestJson
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          projectStateDir: getProjectStateDirFor(process.cwd()),
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

  it("rejects mutating requests to endpoints for a different project state dir", async () => {
    mocks.requestJson
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          projectStateDir: "/tmp/other-aimux-project",
          pid: 2,
          serviceInfo: getProjectServiceManifest(),
        },
      })
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 7 } });
    const { postToProjectService } = await import("./dashboard-control.js");

    await expect(
      postToProjectService({ dashboardServiceRecovery: null }, "/agents/resume", { sessionId: "claude-1" }),
    ).resolves.toEqual({ ok: true, value: 7 });

    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
  });

  it("restarts stale project-service endpoints before GET requests", async () => {
    mocks.requestJson
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          projectStateDir: "/tmp/other-aimux-project",
          pid: 2,
          serviceInfo: getProjectServiceManifest(),
        },
      })
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 9 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 9,
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

  it("validates metadata endpoints before dashboard streams use them", async () => {
    const { resolveCurrentProjectServiceEndpointForDashboard } = await import("./dashboard-control.js");
    const endpoint = { host: "127.0.0.1", port: 43444, pid: 2 };
    mocks.loadMetadataEndpoint.mockReturnValue(endpoint);
    mocks.requestJson.mockResolvedValueOnce(healthyServiceResponse());

    await expect(resolveCurrentProjectServiceEndpointForDashboard({ dashboardServiceRecovery: null })).resolves.toBe(
      endpoint,
    );

    expect(mocks.requestJson).toHaveBeenCalledTimes(1);
    expect(mocks.requestJson.mock.calls[0][0]).toContain("/health");
  });

  it("repairs dashboard stream endpoints that point at another project service", async () => {
    const { resolveCurrentProjectServiceEndpointForDashboard } = await import("./dashboard-control.js");
    const endpoint = { host: "127.0.0.1", port: 43444, pid: 2 };
    mocks.loadMetadataEndpoint.mockReturnValue(endpoint);
    mocks.requestJson
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          projectStateDir: "/tmp/other-aimux-project",
          pid: 2,
          serviceInfo: getProjectServiceManifest(),
        },
      })
      .mockResolvedValueOnce(healthyServiceResponse());

    await expect(resolveCurrentProjectServiceEndpointForDashboard({ dashboardServiceRecovery: null })).resolves.toBe(
      endpoint,
    );

    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(2);
  });
});

describe("dashboard live target activation", () => {
  it("primes live tmux footer files under the dashboard project root", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-project-"));
    const stateDir = getProjectStateDirFor(projectRoot);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "statusline.json"),
      `${JSON.stringify({
        updatedAt: new Date().toISOString(),
        sessions: [{ id: "codex-1", name: "codex" }],
        metadata: {
          "codex-1": {
            statusline: {
              top: [{ text: "project-root-top" }],
              bottom: [{ text: "project-root-bottom" }],
            },
          },
        },
      })}\n`,
    );
    await import("../paths.js").then(({ initPaths }) => initPaths(process.cwd()));
    const target = {
      sessionName: "aimux-repo",
      windowId: "@agent",
      windowIndex: 2,
      windowName: "codex(coder)",
    };
    const host: any = {
      mode: "session",
      projectRoot,
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn((root: string) => {
          expect(root).toBe(projectRoot);
          return [{ metadata: { kind: "agent", sessionId: "codex-1" }, target }];
        }),
        isInsideTmux: vi.fn(() => false),
        openTarget: vi.fn(),
        refreshStatus: vi.fn(),
        displayMessage: vi.fn(() => projectRoot),
        currentClientSession: vi.fn(() => undefined),
      },
      postToProjectService: vi.fn(async () => ({ ok: true })),
      invalidateDesktopStateSnapshot: vi.fn(),
      showDashboardError: vi.fn(),
    };
    const { openLiveTmuxWindowForEntry } = await import("./dashboard-control.js");

    const result = openLiveTmuxWindowForEntry(host, { id: "codex-1" });
    expect(host.showDashboardError).not.toHaveBeenCalled();
    expect(result).toBe("opened");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const topPath = join(stateDir, "tmux-statusline", "top-@agent.txt");
    const bottomPath = join(stateDir, "tmux-statusline", "bottom-@agent.txt");
    expect(readFileSync(topPath, "utf8")).toContain("aimux-dashboard-project-");
    expect(readFileSync(bottomPath, "utf8").length).toBeGreaterThan(0);
    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/notification-context",
      expect.objectContaining({
        focused: true,
        sessionId: "codex-1",
        source: "tui",
      }),
    );
    expect(host.postToProjectService).toHaveBeenCalledWith("/mark-seen", { session: "codex-1" });
    expect(existsSync(join(getProjectStateDirFor(process.cwd()), "tmux-statusline", "top-@agent.txt"))).toBe(false);
    rmSync(projectRoot, { recursive: true, force: true });
  });

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

    expect(host.postToProjectService).toHaveBeenNthCalledWith(
      1,
      "/control/open-notification-target",
      {
        sessionId: "codex-1",
        focus: false,
      },
      { timeoutMs: expect.any(Number) },
    );
    expect(host.postToProjectService).toHaveBeenNthCalledWith(
      2,
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

    expect(host.postToProjectService).toHaveBeenCalledTimes(3);
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("does not focus a stale agent after activation invalidates during resolve", async () => {
    const token = { targetKind: "session", targetId: "codex-1", inputEpoch: 0 };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardActivationToken: token,
      postToProjectService: vi.fn(async (_path, body) => {
        if (body.focus === false) {
          host.dashboardInputEpoch = 1;
          return { ok: true };
        }
        return { ok: true };
      }),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn(() => undefined),
      },
      showDashboardError: vi.fn(),
    };
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");

    await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1" }, 1000)).resolves.toBe("missing");

    expect(host.postToProjectService).toHaveBeenCalledTimes(1);
    expect(host.postToProjectService.mock.calls[0]?.[1]).toMatchObject({ focus: false });
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

  it("suppresses stale agent focus errors when dashboard input invalidates the activation", async () => {
    const token = { targetKind: "session", targetId: "codex-1", inputEpoch: 0 };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardActivationToken: token,
      postToProjectService: vi.fn(async () => {
        host.dashboardInputEpoch = 1;
        throw new Error("tmux focus failed");
      }),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn(() => undefined),
      },
      showDashboardError: vi.fn(),
    };
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");

    await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1", status: "offline" }, 1000)).resolves.toBe(
      "missing",
    );

    expect(host.postToProjectService).toHaveBeenCalledTimes(1);
    expect(host.showDashboardError).not.toHaveBeenCalled();
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

    expect(host.postToProjectService).toHaveBeenNthCalledWith(
      1,
      "/control/open-notification-target",
      {
        sessionId: "service-1",
        focus: false,
      },
      { timeoutMs: expect.any(Number) },
    );
    expect(host.postToProjectService).toHaveBeenNthCalledWith(
      2,
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
  beforeEach(() => {
    resetDashboardControlMocks();
  });

  it("loads route options from the project service in dashboard mode", async () => {
    const { showOrchestrationRoutePicker } = await import("./dashboard-control.js");
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.requestJson.mockResolvedValueOnce(healthyServiceResponse()).mockResolvedValueOnce({
      status: 200,
      json: {
        ok: true,
        options: [
          {
            label: "Role: reviewer [1: codex-1]",
            assignee: "reviewer",
            worktreePath: "/repo/.aimux/worktrees/demo",
            recipientIds: ["codex-1"],
          },
        ],
      },
    });
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardState: {
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [],
        worktreeSessions: [],
        worktreeNavOrder: [],
      },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => [{ id: "codex-1" }]),
      getFromProjectService: vi.fn(),
      openDashboardOverlay: vi.fn(),
      renderOrchestrationRoutePicker: vi.fn(),
      showDashboardError: vi.fn(),
    };

    showOrchestrationRoutePicker(host, "task");
    await vi.waitFor(() => expect(host.renderOrchestrationRoutePicker).toHaveBeenCalledOnce());

    expect(host.getFromProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson.mock.calls.some((call) => String(call[0]).includes("/health"))).toBe(true);
    const requestedRoutes = mocks.requestJson.mock.calls.some((call) =>
      String(call[0]).includes(
        "/orchestration/routes?mode=task&selectedSessionId=codex-1&worktreePath=%2Frepo%2F.aimux%2Fworktrees%2Fdemo",
      ),
    );
    expect(requestedRoutes).toBe(true);
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
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.requestJson
      .mockResolvedValueOnce(healthyServiceResponse())
      .mockResolvedValueOnce({ status: 200, json: { ok: true, options: [{ recipientIds: "codex-1" }] } });
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardState: { worktreeEntries: [], worktreeSessions: [], worktreeNavOrder: [] },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => []),
      getFromProjectService: vi.fn(),
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
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.requestJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRoutes = (value) => resolve({ status: 200, json: value });
        }),
    );
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardState: { worktreeEntries: [], worktreeSessions: [], worktreeNavOrder: [] },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => []),
      getFromProjectService: vi.fn(),
      openDashboardOverlay: vi.fn(),
      renderOrchestrationRoutePicker: vi.fn(),
      showDashboardError: vi.fn(),
    };

    showOrchestrationRoutePicker(host, "message");
    await vi.waitFor(() => expect(mocks.requestJson).toHaveBeenCalledTimes(1));
    host.dashboardInputEpoch = 1;
    resolveRoutes({ ok: true, options: [{ label: "Agent", sessionId: "codex-1" }] });
    await Promise.resolve();

    expect(host.getFromProjectService).not.toHaveBeenCalled();
    expect(host.openDashboardOverlay).not.toHaveBeenCalled();
    expect(host.renderOrchestrationRoutePicker).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });
});

describe("startRuntimeGuardRepair", () => {
  beforeEach(() => {
    resetDashboardControlMocks();
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

  it("does not block navigation while another dashboard owns the repair lock", async () => {
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
    expect(secondHost.dashboardBusyState).toBeNull();
    expect(secondHost.footerFlash).toBe("Aimux repair already running");
    expect(secondHost.footerFlashTicks).toBe(3);
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

  it("does not reclaim an aged repair lock while its owner is still alive", async () => {
    expect(testAimuxHome).toBeTruthy();
    const lockPath = join(testAimuxHome!, "locks", "dashboard-control-plane-repair");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 987654, projectRoot: "/repo/app" }));
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(lockPath, old, old);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 987654) return true;
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }) as typeof process.kill);
    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    const host = {
      projectRoot: "/repo/other",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    try {
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
    } finally {
      killSpy.mockRestore();
    }

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(host.footerFlash).toBe("Aimux repair already running");
    expect(existsSync(lockPath)).toBe(true);
  });

  it("does not reclaim a repair lock while another reclaim is in progress", async () => {
    expect(testAimuxHome).toBeTruthy();
    const lockPath = join(testAimuxHome!, "locks", "dashboard-control-plane-repair");
    const stealPath = join(testAimuxHome!, "locks", "dashboard-control-plane-repair.steal");
    mkdirSync(lockPath, { recursive: true });
    mkdirSync(stealPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 987654, projectRoot: "/repo/app" }));
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(lockPath, old, old);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 987654) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    }) as typeof process.kill);
    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    const host = {
      projectRoot: "/repo/other",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    try {
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
    } finally {
      killSpy.mockRestore();
    }

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(host.footerFlash).toBe("Aimux repair already running");
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(stealPath)).toBe(true);
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

  it("fails locally and keeps the repair lock when guarded repair hangs", async () => {
    vi.useFakeTimers();
    const child = {
      pid: 7654,
      kill: vi.fn(),
      on: vi.fn(),
      unref: vi.fn(),
    };
    mocks.spawn.mockReturnValueOnce(child);
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
      showDashboardError: vi.fn(),
    };

    try {
      const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
      startRuntimeGuardRepair(host as never, { kind: "runtime-rebuild-required" });
      vi.advanceTimersByTime(45_000);
    } finally {
      vi.useRealTimers();
    }

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(existsSync(join(testAimuxHome!, "locks", "dashboard-control-plane-repair"))).toBe(true);
    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.runtimeGuardRepairBusy).toBe(false);
    expect(host.dashboardBusyState).toBeNull();
    expect(host.runtimeGuardRepairFailedKey).toBe("runtime-rebuild-required");
    expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair failed", ["aimux repair timed out after 45s"]);
  });

  it("releases a retained repair lock after the timed-out child exits", async () => {
    vi.useFakeTimers();
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const child = {
      pid: 7654,
      kill: vi.fn(),
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === "exit") onExit = handler;
      }),
      unref: vi.fn(),
    };
    mocks.spawn.mockReturnValueOnce(child);
    const lockPath = join(testAimuxHome!, "locks", "dashboard-control-plane-repair");
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
      showDashboardError: vi.fn(),
    };

    try {
      const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
      startRuntimeGuardRepair(host as never, { kind: "runtime-rebuild-required" });
      vi.advanceTimersByTime(45_000);
      expect(existsSync(lockPath)).toBe(true);
      onExit?.(1, null);
      expect(existsSync(lockPath)).toBe(false);
      vi.advanceTimersByTime(5_001);
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(host.showDashboardError).toHaveBeenCalledTimes(1);
  });

  it("force-kills and releases the repair lock when the timed-out child does not exit", async () => {
    vi.useFakeTimers();
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const child = {
      pid: 7654,
      kill: vi.fn(),
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === "exit") onExit = handler;
      }),
      unref: vi.fn(),
    };
    mocks.spawn.mockReturnValueOnce(child);
    const lockPath = join(testAimuxHome!, "locks", "dashboard-control-plane-repair");
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
      showDashboardError: vi.fn(),
    };

    try {
      const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
      startRuntimeGuardRepair(host as never, { kind: "runtime-rebuild-required" });
      vi.advanceTimersByTime(45_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(existsSync(lockPath)).toBe(true);
      vi.advanceTimersByTime(5_001);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(existsSync(lockPath)).toBe(true);
      onExit?.(null, "SIGKILL");
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    expect(host.showDashboardError).toHaveBeenCalledTimes(1);
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

  it("retries the same guarded repair after a failure cooldown", async () => {
    vi.useFakeTimers();
    let onError: ((error: Error) => void) | undefined;
    const makeChild = () => ({
      on: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") onError = handler;
      }),
      unref: vi.fn(),
    });
    mocks.spawn.mockReturnValueOnce(makeChild()).mockReturnValueOnce(makeChild());
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

    try {
      const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
      startRuntimeGuardRepair(host as never, state);
      onError?.(new Error("spawn failed"));
      startRuntimeGuardRepair(host as never, state);
      expect(mocks.spawn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);
      startRuntimeGuardRepair(host as never, state);
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears stale repair error overlays when a retry succeeds", async () => {
    vi.useFakeTimers();
    let onError: ((error: Error) => void) | undefined;
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    mocks.spawn
      .mockReturnValueOnce({
        on: vi.fn((event: string, handler: (error: Error) => void) => {
          if (event === "error") onError = handler;
        }),
        unref: vi.fn(),
      })
      .mockReturnValueOnce({
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
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      dashboardErrorState: null as { title: string; lines: string[] } | null,
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      renderCurrentDashboardView: vi.fn(),
      showDashboardError: vi.fn(function (this: any, title: string, lines: string[]) {
        host.dashboardErrorState = { title, lines };
      }),
      refreshDashboardModelFromService: vi.fn().mockResolvedValue(true),
    };

    try {
      const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
      onError?.(new Error("spawn failed"));
      expect(host.dashboardErrorState).toMatchObject({ title: "Aimux repair failed" });

      vi.advanceTimersByTime(5000);
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
      expect(host.dashboardErrorState).toBeNull();

      onExit?.(0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(host.runtimeGuardState).toEqual({ kind: "ok" });
      expect(host.dashboardErrorState).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
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
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true, {
      lifecycle: expect.objectContaining({ mode: "dashboard" }),
    });
  });

  it("clears the guarded repair timeout after successful verification", async () => {
    vi.useFakeTimers();
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let finishRefresh: ((value: boolean) => void) | undefined;
    const child = {
      kill: vi.fn(),
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === "exit") onExit = handler;
      }),
      unref: vi.fn(),
    };
    mocks.spawn.mockReturnValueOnce(child);
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      renderCurrentDashboardView: vi.fn(),
      dashboardModelServiceRefreshedAt: 0,
      showDashboardError: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => {
        const result = await new Promise<boolean>((resolve) => {
          finishRefresh = resolve;
        });
        host.dashboardModelServiceRefreshedAt += 1;
        return result;
      }),
    };

    try {
      const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
      onExit?.(0, null);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(finishRefresh).toBeDefined();
      finishRefresh?.(true);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      vi.advanceTimersByTime(45_000);
    } finally {
      vi.useRealTimers();
    }

    expect(host.runtimeGuardState).toEqual({ kind: "ok" });
    expect(child.kill).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("times out hung guarded repair verification without killing an exited child", async () => {
    vi.useFakeTimers();
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let finishRefresh: ((value: boolean) => void) | undefined;
    const child = {
      kill: vi.fn(),
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === "exit") onExit = handler;
      }),
      unref: vi.fn(),
    };
    mocks.spawn.mockReturnValueOnce(child);
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      renderCurrentDashboardView: vi.fn(),
      dashboardModelServiceRefreshedAt: 0,
      showDashboardError: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => {
        await new Promise<boolean>((resolve) => {
          finishRefresh = resolve;
        });
        host.dashboardModelServiceRefreshedAt += 1;
        return true;
      }),
    };

    try {
      const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
      onExit?.(0, null);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(finishRefresh).toBeDefined();
      vi.advanceTimersByTime(45_000);
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }

    expect(child.kill).not.toHaveBeenCalled();
    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.dashboardBusyState).toBeNull();
    expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair failed", ["aimux repair timed out after 45s"]);
  });

  it("does not refresh dashboard data after guarded repair times out during probing", async () => {
    vi.useFakeTimers();
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let finishProbe: ((value: ReturnType<typeof healthyServiceResponse>) => void) | undefined;
    const child = {
      kill: vi.fn(),
      on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === "exit") onExit = handler;
      }),
      unref: vi.fn(),
    };
    mocks.spawn.mockReturnValueOnce(child);
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.requestJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      renderCurrentDashboardView: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => true),
      showDashboardError: vi.fn(),
    };

    try {
      const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
      onExit?.(0, null);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      vi.advanceTimersByTime(45_001);
      await Promise.resolve();
      expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair failed", ["aimux repair timed out after 45s"]);
      const renderCallsAfterTimeout = host.renderCurrentDashboardView.mock.calls.length;
      expect(finishProbe).toBeDefined();
      finishProbe?.(healthyServiceResponse(2, "/repo/app"));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(host.renderCurrentDashboardView).toHaveBeenCalledTimes(renderCallsAfterTimeout);
    } finally {
      vi.useRealTimers();
    }

    expect(child.kill).not.toHaveBeenCalled();
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
  });

  it("does not mark successful guarded repair failed after leaving dashboard mode", async () => {
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
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
    const host = {
      mode: "dashboard",
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      renderCurrentDashboardView: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => false),
      showDashboardError: vi.fn(),
    };

    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
    host.mode = "session";
    onExit?.(0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.runtimeGuardRepairFailedKey).toBeUndefined();
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
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
        projectStateDir: getProjectStateDirFor("/repo/app"),
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
    resetDashboardControlMocks();
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
        projectStateDir: getProjectStateDirFor("/repo/app"),
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
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
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
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
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

  it("clears a stale repair error after external guard recovery", async () => {
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
    const host = runtimeGuardHost() as any;
    host.runtimeGuardState = { kind: "stale", reason: "service-mismatch" };
    host.dashboardErrorState = { title: "Aimux repair failed", lines: ["previous failure"] };

    const { refreshRuntimeGuard } = await import("./dashboard-control.js");
    await refreshRuntimeGuard(host as never);

    expect(host.runtimeGuardState).toEqual({ kind: "ok" });
    expect(host.dashboardErrorState).toBeNull();
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
