import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CORE_COMMAND_NAMES } from "../core-command-contract.js";
import { getProjectServiceManifest } from "../project-service-manifest.js";
import { getProjectStateDirFor } from "../paths.js";
import { loadLastUsedState } from "../last-used.js";
import type { RuntimeRestartResult } from "../runtime-restart.js";

const mocks = vi.hoisted(() => ({
  requestJson: vi.fn(),
  loadMetadataEndpoint: vi.fn(),
  removeMetadataEndpoint: vi.fn(),
  updateSessionMetadata: vi.fn(),
  sendCoreCommand: vi.fn(),
  restartAimuxControlPlane: vi.fn(),
  isRuntimeRestartInProgress: vi.fn(),
}));

function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

function successfulRepairResult(projectRoot = "/repo/app"): RuntimeRestartResult {
  return {
    startedAt: "2026-06-21T00:00:00.000Z",
    finishedAt: "2026-06-21T00:00:01.000Z",
    before: null as never,
    verification: { status: "ok", after: null, error: null },
    daemon: {
      previous: null,
      current: { pid: 1, port: 43190, startedAt: "after", updatedAt: "after" },
    },
    projects: [
      {
        projectRoot,
        runtimeRebuildRequired: false,
        runtime: { status: "skipped", error: null },
        service: { status: "ensured", state: null, error: null },
        dashboard: { status: "skipped", sessionName: null, target: null, error: null },
      },
    ],
    summary: {
      projects: 1,
      servicesEnsured: 1,
      runtimeRepairs: 0,
      dashboardsReloaded: 0,
      runtimeRebuildRequired: 0,
      failures: 0,
    },
  };
}

function projectServiceState(projectRoot = process.cwd(), pid = 2) {
  return {
    projectId: "repo",
    projectRoot,
    pid,
    startedAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  };
}

function coreCommandOk(command: string, result: unknown) {
  return {
    ok: true,
    id: "test",
    command,
    issuedAt: "2026-06-21T00:00:00.000Z",
    result,
  };
}

function expectCoreProjectEnsure(projectRoot = process.cwd()): void {
  expect(mocks.sendCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectEnsure, { projectRoot });
}

function expectCoreProjectStop(projectRoot = process.cwd()): void {
  expect(mocks.sendCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectStop, { projectRoot });
}

function expectNoCoreProjectLifecycleCommand(): void {
  expect(mocks.sendCoreCommand).not.toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectStop, expect.anything());
  expect(mocks.sendCoreCommand).not.toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectEnsure, expect.anything());
}

function resetDashboardControlMocks(): void {
  vi.resetModules();
  mocks.requestJson.mockReset();
  mocks.loadMetadataEndpoint.mockReset();
  mocks.removeMetadataEndpoint.mockReset();
  mocks.updateSessionMetadata.mockReset();
  mocks.sendCoreCommand.mockReset();
  mocks.restartAimuxControlPlane.mockReset();
  mocks.isRuntimeRestartInProgress.mockReset();
  mocks.restartAimuxControlPlane.mockReturnValue(new Promise(() => {}));
  mocks.isRuntimeRestartInProgress.mockReturnValue(false);
  mocks.loadMetadataEndpoint.mockReturnValue({
    host: "127.0.0.1",
    port: 43444,
    pid: 2,
    updatedAt: "2026-06-21T00:00:00.000Z",
  });
  mocks.sendCoreCommand.mockImplementation(async (command: string, payload?: { projectRoot?: string }) => {
    if (command === CORE_COMMAND_NAMES.projectStop) {
      return coreCommandOk(command, { project: projectServiceState(payload?.projectRoot) });
    }
    if (command === CORE_COMMAND_NAMES.projectEnsure) {
      return coreCommandOk(command, { project: projectServiceState(payload?.projectRoot) });
    }
    return coreCommandOk(command, {});
  });
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

vi.mock("../core-command-transport.js", () => ({
  sendCoreCommand: mocks.sendCoreCommand,
}));

vi.mock("../runtime-restart.js", () => ({
  isRuntimeRestartInProgress: mocks.isRuntimeRestartInProgress,
  restartAimuxControlPlane: mocks.restartAimuxControlPlane,
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
    expectCoreProjectStop();
    expectCoreProjectEnsure();
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

    const result = await postToProjectService({ dashboardServiceRecovery: null, projectRoot }, "/agents/resume", {
      sessionId: "claude-1",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(projectRoot);
    expectCoreProjectStop(projectRoot);
    expectCoreProjectEnsure(projectRoot);
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

    expectNoCoreProjectLifecycleCommand();
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
    expectNoCoreProjectLifecycleCommand();
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

    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expectNoCoreProjectLifecycleCommand();
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

    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expectNoCoreProjectLifecycleCommand();
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

    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expectNoCoreProjectLifecycleCommand();
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

    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expectNoCoreProjectLifecycleCommand();
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
    expectCoreProjectStop();
    expectCoreProjectEnsure();
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
    expectCoreProjectStop();
    expectCoreProjectEnsure();
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
    expectCoreProjectStop();
    expectCoreProjectEnsure();
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
    expectCoreProjectStop();
    expectCoreProjectEnsure();
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

    expectCoreProjectStop();
    expectCoreProjectEnsure();
    expect(mocks.requestJson).toHaveBeenCalledTimes(4);
  });

  it("bounds control-plane recovery by the project-service request timeout", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadMetadataEndpoint.mockReturnValue(null);
      mocks.sendCoreCommand.mockImplementation(() => new Promise(() => {}));
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
    mocks.sendCoreCommand.mockImplementation(async (command: string, payload?: { projectRoot?: string }) => {
      if (command === CORE_COMMAND_NAMES.projectStop) {
        return coreCommandOk(command, { project: projectServiceState(payload?.projectRoot) });
      }
      if (command !== CORE_COMMAND_NAMES.projectEnsure) {
        return coreCommandOk(command, {});
      }
      ensureCalls += 1;
      if (ensureCalls === 1) {
        return new Promise((resolve) => {
          finishEnsure = () =>
            resolve(coreCommandOk(command, { project: projectServiceState(payload?.projectRoot, 2) }));
        });
      }
      return coreCommandOk(command, { project: projectServiceState(payload?.projectRoot, 3) });
    });
    const { ensureDashboardControlPlane } = await import("./dashboard-control.js");
    const host = { dashboardServiceRecovery: null };

    const first = ensureDashboardControlPlane(host, 1000);
    await Promise.resolve();
    const second = ensureDashboardControlPlane(host, 1000, { restartProjectService: true });
    await Promise.resolve();
    finishEnsure?.();
    await Promise.all([first, second]);

    expectCoreProjectStop();
    expect(
      mocks.sendCoreCommand.mock.calls.filter((call) => call[0] === CORE_COMMAND_NAMES.projectEnsure),
    ).toHaveLength(2);
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
    expectCoreProjectStop();
    expectCoreProjectEnsure();
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
        screen: "agent",
        sessionId: "codex-1",
        source: "tui",
      }),
      { timeoutMs: 3000 },
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

  it("focuses the client attached to the dashboard pane instead of stale ambient tmux context", async () => {
    const previousPane = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%dashboard";
    try {
      const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
      const host: any = {
        mode: "dashboard",
        postToProjectService: vi.fn(async () => ({ ok: true })),
        tmuxRuntimeManager: {
          currentClientSession: vi.fn(() => "stale-client-session"),
          displayMessage: vi.fn((format: string, target?: string) => {
            if (target === "%dashboard" && format === "#{window_id}") return "@dashboard";
            if (format === "#{client_tty}") return "/dev/stale";
            if (format === "#{window_id}") return "@stale";
            return undefined;
          }),
          listClients: vi.fn(() => [
            {
              tty: "/dev/live",
              sessionName: "aimux-repo-client-live",
              windowId: "@dashboard",
              name: "live",
            },
            {
              tty: "/dev/stale",
              sessionName: "stale-client-session",
              windowId: "@stale",
              name: "stale",
            },
          ]),
        },
        showDashboardError: vi.fn(),
      };

      await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1" }, 1200)).resolves.toBe("opened");

      expect(host.postToProjectService).toHaveBeenNthCalledWith(
        2,
        "/control/open-notification-target",
        {
          sessionId: "codex-1",
          focus: true,
          currentClientSession: "aimux-repo-client-live",
          clientTty: "/dev/live",
          currentWindowId: "@dashboard",
        },
        { timeoutMs: expect.any(Number) },
      );
    } finally {
      if (previousPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = previousPane;
    }
  });

  it("does not surface a focus error when dashboard mode has no attached client tty", async () => {
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn(() => undefined),
        listClients: vi.fn(() => []),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1", status: "running" }, 120)).resolves.toBe(
      "missing",
    );

    expect(host.showDashboardError).not.toHaveBeenCalled();
    expect(host.postToProjectService).not.toHaveBeenCalled();
  });

  it("focuses live dashboard agents through local tmux before falling back to the service API", async () => {
    const previousPane = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%dashboard";
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-focus-"));
    try {
      const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
      const target = {
        sessionName: "aimux-repo",
        windowId: "@agent",
        windowIndex: 2,
        windowName: "codex(coder)",
      };
      const host: any = {
        mode: "dashboard",
        projectRoot,
        postToProjectService: vi.fn(async () => ({ ok: true })),
        invalidateDesktopStateSnapshot: vi.fn(),
        tmuxRuntimeManager: {
          currentClientSession: vi.fn(() => "stale-client-session"),
          displayMessage: vi.fn((format: string, targetArg?: string) => {
            if (targetArg === "%dashboard" && format === "#{window_id}") return "@dashboard";
            if (format === "#{client_tty}") return "/dev/stale";
            if (format === "#{pane_current_path}") return projectRoot;
            return undefined;
          }),
          listClients: vi.fn(() => [
            {
              tty: "/dev/live",
              sessionName: "aimux-repo-client-live",
              windowId: "@dashboard",
              name: "live",
            },
          ]),
          findClientByTty: vi.fn((tty: string) => (tty === "/dev/live" ? { tty } : null)),
          listProjectManagedWindows: vi.fn(() => [
            {
              metadata: { kind: "agent", sessionId: "codex-1" },
              target,
            },
          ]),
          isWindowAlive: vi.fn(() => true),
          switchClientToTarget: vi.fn(),
          refreshStatus: vi.fn(),
        },
        showDashboardError: vi.fn(),
      };

      await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1" }, 1200)).resolves.toBe("opened");

      expect(host.tmuxRuntimeManager.switchClientToTarget).toHaveBeenCalledWith("/dev/live", target);
      expect(loadLastUsedState(projectRoot).clients["aimux-repo-client-live"]).toBeUndefined();
      expect(loadLastUsedState(projectRoot).clients["stale-client-session"]).toBeUndefined();
      expect(host.postToProjectService).toHaveBeenCalledWith("/usage/mark", {
        itemId: "codex-1",
        clientSession: "aimux-repo-client-live",
        usedAt: expect.any(String),
      });
      expect(host.postToProjectService).not.toHaveBeenCalledWith(
        "/control/open-notification-target",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      if (previousPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = previousPane;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the project-service control API when a matched local agent window is dead", async () => {
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
    const target = {
      sessionName: "aimux-repo",
      windowId: "@dead-agent",
      windowIndex: 2,
      windowName: "codex(coder)",
    };
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
        listClients: vi.fn(() => []),
        listProjectManagedWindows: vi.fn(() => [
          {
            metadata: { kind: "agent", sessionId: "codex-1" },
            target,
          },
        ]),
        isWindowAlive: vi.fn(() => false),
        switchClientToTarget: vi.fn(),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1" }, 1200)).resolves.toBe("opened");

    expect(host.tmuxRuntimeManager.switchClientToTarget).not.toHaveBeenCalled();
    expect(host.postToProjectService).toHaveBeenNthCalledWith(
      1,
      "/control/open-notification-target",
      {
        sessionId: "codex-1",
        focus: false,
      },
      { timeoutMs: expect.any(Number) },
    );
  });

  it("falls back to the project-service control API when local agent focus errors", async () => {
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
        listClients: vi.fn(() => []),
        listProjectManagedWindows: vi.fn(() => {
          throw new Error("tmux list failed");
        }),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1", status: "running" }, 1200)).resolves.toBe(
      "opened",
    );

    expect(host.showDashboardError).not.toHaveBeenCalled();
    expect(host.postToProjectService).toHaveBeenNthCalledWith(
      1,
      "/control/open-notification-target",
      {
        sessionId: "codex-1",
        focus: false,
      },
      { timeoutMs: expect.any(Number) },
    );
  });

  it("uses a restore-sized service timeout for offline agent activation", async () => {
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
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
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
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
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
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
          displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
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
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
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
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
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
        clientTty: "/dev/live",
        currentWindowId: undefined,
      },
      { timeoutMs: expect.any(Number) },
    );
    expect(host.postToProjectService.mock.calls[0][2].timeoutMs).toBeLessThanOrEqual(1200);
  });

  it("focuses live dashboard services through local tmux before falling back to the service API", async () => {
    const previousPane = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%dashboard";
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-service-focus-"));
    try {
      const { waitAndOpenLiveTmuxWindowForService } = await import("./dashboard-control.js");
      const target = {
        sessionName: "aimux-repo",
        windowId: "@service",
        windowIndex: 3,
        windowName: "shell",
      };
      const duplicateTarget = {
        sessionName: "aimux-repo",
        windowId: "@duplicate-service",
        windowIndex: 4,
        windowName: "shell",
      };
      const host: any = {
        mode: "dashboard",
        projectRoot,
        postToProjectService: vi.fn(async () => ({ ok: true })),
        invalidateDesktopStateSnapshot: vi.fn(),
        getDashboardViewportTarget: vi.fn(() => undefined),
        tmuxRuntimeManager: {
          currentClientSession: vi.fn(() => "stale-client-session"),
          displayMessage: vi.fn((format: string, targetArg?: string) => {
            if (targetArg === "%dashboard" && format === "#{window_id}") return "@dashboard";
            if (format === "#{client_tty}") return "/dev/stale";
            if (format === "#{pane_current_path}") return projectRoot;
            return undefined;
          }),
          listClients: vi.fn(() => [
            {
              tty: "/dev/live",
              sessionName: "aimux-repo-client-live",
              windowId: "@dashboard",
              name: "live",
            },
          ]),
          findClientByTty: vi.fn((tty: string) => (tty === "/dev/live" ? { tty } : null)),
          listProjectManagedWindows: vi.fn(() => [
            {
              metadata: { kind: "service", sessionId: "service-1" },
              target: duplicateTarget,
            },
            {
              metadata: { kind: "service", sessionId: "service-1" },
              target,
            },
          ]),
          isWindowAlive: vi.fn(() => true),
          switchClientToTarget: vi.fn(),
          refreshStatus: vi.fn(),
        },
        showDashboardError: vi.fn(),
      };

      await expect(
        waitAndOpenLiveTmuxWindowForService(host, { id: "service-1", tmuxWindowId: "@service" }, 1200),
      ).resolves.toBe("opened");

      expect(host.tmuxRuntimeManager.switchClientToTarget).toHaveBeenCalledWith("/dev/live", target);
      expect(host.tmuxRuntimeManager.displayMessage).toHaveBeenCalledWith("#{window_id}", "%dashboard");
      expect(loadLastUsedState(projectRoot).clients["aimux-repo-client-live"]).toBeUndefined();
      expect(loadLastUsedState(projectRoot).clients["stale-client-session"]).toBeUndefined();
      expect(host.postToProjectService).toHaveBeenCalledWith("/usage/mark", {
        itemId: "service-1",
        clientSession: "aimux-repo-client-live",
        usedAt: expect.any(String),
      });
      expect(host.postToProjectService).not.toHaveBeenCalledWith(
        "/control/open-notification-target",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      if (previousPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = previousPane;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the project-service control API when a matched local service window is dead", async () => {
    const { waitAndOpenLiveTmuxWindowForService } = await import("./dashboard-control.js");
    const target = {
      sessionName: "aimux-repo",
      windowId: "@dead-service",
      windowIndex: 3,
      windowName: "shell",
    };
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
        listClients: vi.fn(() => []),
        listProjectManagedWindows: vi.fn(() => [
          {
            metadata: { kind: "service", sessionId: "service-1" },
            target,
          },
        ]),
        isWindowAlive: vi.fn(() => false),
        switchClientToTarget: vi.fn(),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForService(host, "service-1", 1200)).resolves.toBe("opened");

    expect(host.tmuxRuntimeManager.switchClientToTarget).not.toHaveBeenCalled();
    expect(host.postToProjectService).toHaveBeenNthCalledWith(
      1,
      "/control/open-notification-target",
      {
        sessionId: "service-1",
        focus: false,
      },
      { timeoutMs: expect.any(Number) },
    );
  });

  it("falls back to the project-service control API when local service focus errors", async () => {
    const { waitAndOpenLiveTmuxWindowForService } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : undefined)),
        listClients: vi.fn(() => []),
        listProjectManagedWindows: vi.fn(() => {
          throw new Error("tmux list failed");
        }),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForService(host, "service-1", 1200)).resolves.toBe("opened");

    expect(host.showDashboardError).not.toHaveBeenCalled();
    expect(host.postToProjectService).toHaveBeenNthCalledWith(
      1,
      "/control/open-notification-target",
      {
        sessionId: "service-1",
        focus: false,
      },
      { timeoutMs: expect.any(Number) },
    );
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
      runtimeGuardRepairTimedOutPending: false,
      runtimeGuardRepairFailedKey: undefined,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    startRuntimeGuardRepair(host as never, { kind: "disconnected" });

    expect(mocks.restartAimuxControlPlane).not.toHaveBeenCalled();
    expect(host.dashboardBusyState).toBeNull();
  });

  it("runs guarded repair through the current Core process", async () => {
    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairTimedOutPending: false,
      runtimeGuardRepairFailedKey: undefined,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });

    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/repo/app",
        reloadDashboards: false,
        verifyDashboards: false,
      }),
    );
    expect(host.dashboardBusyState).toMatchObject({ title: "Repairing Aimux" });
    expect(host.dashboardRepairNotices).toMatchObject([
      {
        kind: "runtime-guard-repair",
        phase: "started",
        message: "Aimux repair started",
      },
    ]);
  });

  it("reloads a self-drifted dashboard only after repair cleanup", async () => {
    const repair = deferred<RuntimeRestartResult>();
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
    const lockPath = join(testAimuxHome!, "locks", "dashboard-control-plane-repair");
    const reloadDashboardAfterRuntimeGuardRepair = vi.fn();
    const host = {
      mode: "dashboard",
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairTimedOutPending: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      runtimeGuardState: { kind: "stale", reason: "self-drift" },
      renderCurrentDashboardView: vi.fn(),
      reloadDashboardAfterRuntimeGuardRepair,
    };

    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    startRuntimeGuardRepair(host as never, { kind: "stale", reason: "self-drift" });
    const renderCallsBeforeResolve = host.renderCurrentDashboardView.mock.calls.length;
    repair.resolve(successfulRepairResult());
    await Promise.resolve();
    await Promise.resolve();

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.runtimeGuardRepairBusy).toBe(false);
    expect(host.dashboardBusyState).toBeNull();
    expect(existsSync(lockPath)).toBe(false);
    expect(reloadDashboardAfterRuntimeGuardRepair).toHaveBeenCalledWith("/repo/app");
    expect(host.renderCurrentDashboardView).toHaveBeenCalledTimes(renderCallsBeforeResolve);
    expect(host.dashboardRepairNotices).toMatchObject([
      {
        kind: "runtime-guard-repair",
        phase: "started",
        message: "Aimux repair started",
      },
      {
        kind: "runtime-guard-repair",
        phase: "succeeded",
        message: "Aimux repair complete",
      },
    ]);
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
    startRuntimeGuardRepair(secondHost as never, { kind: "stale", reason: "service-mismatch" });
    startRuntimeGuardRepair(secondHost as never, { kind: "runtime-rebuild-required" });

    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledTimes(1);
    expect(secondHost.dashboardBusyState).toBeNull();
    expect(secondHost.footerFlash).toBe("Aimux repair already running");
    expect(secondHost.footerFlashTicks).toBe(3);
    expect(secondHost.runtimeGuardRepairBusy).toBe(true);
    expect(secondHost.renderCurrentDashboardView).toHaveBeenCalledTimes(1);
    expect(secondHost.dashboardRepairNotices).toMatchObject([
      {
        kind: "runtime-guard-repair",
        phase: "blocked",
        message: "Aimux repair already running",
      },
    ]);
    expect(secondHost.dashboardRepairNotices).toHaveLength(1);
  });

  it("waits instead of repairing while a global aimux restart is running", async () => {
    mocks.isRuntimeRestartInProgress.mockReturnValueOnce(true);
    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    const host = {
      projectRoot: "/repo/app",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      runtimeGuardRepairBusy: false,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });

    expect(mocks.restartAimuxControlPlane).not.toHaveBeenCalled();
    expect(host.dashboardBusyState).toBeNull();
    expect(host.runtimeGuardRepairBusy).toBe(true);
    expect(host.footerFlash).toBe("Aimux repair already running");
    expect(host.dashboardRepairNotices).toMatchObject([
      {
        kind: "runtime-guard-repair",
        phase: "blocked",
        message: "Aimux repair already running",
      },
    ]);
  });

  it("reclaims a repair lock owned by an exited repair process", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 987654) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    }) as typeof process.kill);
    expect(testAimuxHome).toBeTruthy();
    const lockPath = join(testAimuxHome!, "locks", "dashboard-control-plane-repair");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 987654, projectRoot: "/repo/app" }));
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(lockPath, old, old);
    const { startRuntimeGuardRepair } = await import("./dashboard-control.js");
    const host = {
      projectRoot: "/repo/other",
      runtimeGuardRepairing: false,
      runtimeGuardRepairFailedKey: undefined,
      dashboardBusyState: null,
      renderCurrentDashboardView: vi.fn(),
    };

    try {
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
    } finally {
      killSpy.mockRestore();
    }

    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledTimes(1);
  });

  it("reclaims an aged repair lock even while its owner is still alive", async () => {
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

    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledTimes(1);
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

    expect(mocks.restartAimuxControlPlane).not.toHaveBeenCalled();
    expect(host.footerFlash).toBe("Aimux repair already running");
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(stealPath)).toBe(true);
  });

  it("shows a dashboard error when guarded repair fails", async () => {
    const repair = deferred<never>();
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
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
    repair.reject(new Error("repair failed"));
    await Promise.resolve();

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair failed", ["repair failed"]);
    expect(host.dashboardRepairNotices).toMatchObject([
      {
        kind: "runtime-guard-repair",
        phase: "started",
        message: "Aimux repair started",
      },
      {
        kind: "runtime-guard-repair",
        phase: "failed",
        message: "Aimux repair failed",
        error: "repair failed",
      },
    ]);
  });

  it("aborts and releases the dashboard repair lock when guarded repair hangs", async () => {
    vi.useFakeTimers();
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
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }

    const restartOptions = mocks.restartAimuxControlPlane.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(restartOptions.abortSignal?.aborted).toBe(true);
    expect(existsSync(join(testAimuxHome!, "locks", "dashboard-control-plane-repair"))).toBe(false);
    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.runtimeGuardRepairTimedOutPending).toBe(true);
    expect(host.runtimeGuardRepairBusy).toBe(false);
    expect(host.dashboardBusyState).toBeNull();
    expect(host.runtimeGuardRepairFailedKey).toBe("runtime-rebuild-required");
    expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair timed out", [
      "aimux repair is still running after 45s",
    ]);
  });

  it("clears the timed-out repair latch when the aborted repair later rejects", async () => {
    vi.useFakeTimers();
    const repair = deferred();
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
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
      await Promise.resolve();
      expect(existsSync(lockPath)).toBe(false);
      expect(host.runtimeGuardRepairTimedOutPending).toBe(true);
      repair.reject(new Error("late failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(existsSync(lockPath)).toBe(false);
      expect(host.runtimeGuardRepairTimedOutPending).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    expect(host.showDashboardError).toHaveBeenCalledTimes(1);
  });

  it("allows another dashboard repair attempt after a timed-out repair settles and the cooldown passes", async () => {
    vi.useFakeTimers();
    const repair = deferred();
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise).mockReturnValueOnce(new Promise(() => {}));
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
      await Promise.resolve();
      expect(existsSync(lockPath)).toBe(false);
      expect(host.runtimeGuardRepairTimedOutPending).toBe(true);
      expect(mocks.restartAimuxControlPlane).toHaveBeenCalledTimes(1);

      startRuntimeGuardRepair(host as never, { kind: "runtime-rebuild-required" });
      expect(mocks.restartAimuxControlPlane).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_001);
      startRuntimeGuardRepair(host as never, { kind: "runtime-rebuild-required" });
      expect(mocks.restartAimuxControlPlane).toHaveBeenCalledTimes(1);

      repair.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(host.runtimeGuardRepairTimedOutPending).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
      startRuntimeGuardRepair(host as never, { kind: "runtime-rebuild-required" });
      expect(mocks.restartAimuxControlPlane).toHaveBeenCalledTimes(2);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    expect(host.showDashboardError).toHaveBeenCalledTimes(1);
  });

  it("does not show stale guarded repair failures after leaving dashboard mode", async () => {
    const repair = deferred<never>();
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
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
    repair.reject(new Error("repair failed"));
    await Promise.resolve();

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.runtimeGuardRepairBusy).toBe(false);
    expect(host.dashboardBusyState).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("retries the same guarded repair after a failure cooldown", async () => {
    vi.useFakeTimers();
    const repair = deferred<never>();
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise).mockReturnValueOnce(new Promise(() => {}));
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
      repair.reject(new Error("repair failed"));
      await Promise.resolve();
      startRuntimeGuardRepair(host as never, state);
      expect(mocks.restartAimuxControlPlane).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);
      startRuntimeGuardRepair(host as never, state);
      expect(mocks.restartAimuxControlPlane).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears stale repair error overlays when a retry succeeds", async () => {
    vi.useFakeTimers();
    const failedRepair = deferred<never>();
    const successfulRepair = deferred();
    mocks.restartAimuxControlPlane
      .mockReturnValueOnce(failedRepair.promise)
      .mockReturnValueOnce(successfulRepair.promise);
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
      failedRepair.reject(new Error("repair failed"));
      await Promise.resolve();
      expect(host.dashboardErrorState).toMatchObject({ title: "Aimux repair failed" });

      vi.advanceTimersByTime(5000);
      startRuntimeGuardRepair(host as never, { kind: "stale", reason: "service-mismatch" });
      expect(host.dashboardErrorState).toBeNull();

      successfulRepair.resolve(successfulRepairResult());
      await vi.advanceTimersByTimeAsync(0);
      expect(host.runtimeGuardState).toEqual({ kind: "ok" });
      expect(host.dashboardErrorState).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears busy state only after guarded repair verifies the runtime", async () => {
    const repair = deferred();
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
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
    repair.resolve(successfulRepairResult());
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
    const repair = deferred();
    let finishRefresh: ((value: boolean) => void) | undefined;
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
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
      repair.resolve(successfulRepairResult());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(finishRefresh).toBeDefined();
      finishRefresh?.(true);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      vi.advanceTimersByTime(45_000);
    } finally {
      vi.useRealTimers();
    }

    expect(host.runtimeGuardState).toEqual({ kind: "ok" });
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("times out hung guarded repair verification", async () => {
    vi.useFakeTimers();
    const repair = deferred();
    let finishRefresh: ((value: boolean) => void) | undefined;
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
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
      repair.resolve(successfulRepairResult());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(finishRefresh).toBeDefined();
      vi.advanceTimersByTime(45_000);
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.dashboardBusyState).toBeNull();
    expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair timed out", [
      "aimux repair is still running after 45s",
    ]);
  });

  it("does not refresh dashboard data after guarded repair times out during probing", async () => {
    vi.useFakeTimers();
    const repair = deferred();
    let finishProbe: ((value: ReturnType<typeof healthyServiceResponse>) => void) | undefined;
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
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
      repair.resolve(successfulRepairResult());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      vi.advanceTimersByTime(45_001);
      await Promise.resolve();
      expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair timed out", [
        "aimux repair is still running after 45s",
      ]);
      const renderCallsAfterTimeout = host.renderCurrentDashboardView.mock.calls.length;
      expect(finishProbe).toBeDefined();
      finishProbe?.(healthyServiceResponse(2, "/repo/app"));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(host.renderCurrentDashboardView).toHaveBeenCalledTimes(renderCallsAfterTimeout);
    } finally {
      vi.useRealTimers();
    }

    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
  });

  it("does not mark successful guarded repair failed after leaving dashboard mode", async () => {
    const repair = deferred();
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
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
    repair.resolve(successfulRepairResult());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.runtimeGuardRepairFailedKey).toBeUndefined();
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("keeps guard failure visible when guarded repair exits but verification is still stale", async () => {
    const repair = deferred();
    mocks.restartAimuxControlPlane.mockReturnValueOnce(repair.promise);
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
    repair.resolve(successfulRepairResult());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.runtimeGuardRepairing).toBe(false);
    expect(host.runtimeGuardRepairFailedKey).toBe("stale:service-mismatch");
    expect(host.runtimeGuardState).toEqual({ kind: "stale", reason: "service-mismatch" });
    expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair failed", [
      "aimux repair completed but the control plane is still out of sync (service-mismatch)",
    ]);
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
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
      dashboardErrorState: null,
      dashboardState: {
        screen: "dashboard",
        level: "sessions",
        sessionIndex: 0,
        worktreeEntries: [{ kind: "session", id: "codex-1" }],
        worktreeSessions: [{ id: "codex-1", status: "ready" }],
        worktreeNavOrder: [undefined],
      },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => [{ id: "codex-1", status: "ready" }]),
      tmuxRuntimeManager: { listProjectManagedWindows: vi.fn() },
      handleDashboardKey: vi.fn(),
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
    expect(mocks.restartAimuxControlPlane).not.toHaveBeenCalled();
    expect(host.dashboardBusyState).toBeNull();
  });

  it("does not restart Aimux for a single stale service manifest probe", async () => {
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

    expect(host.runtimeGuardState).toEqual({ kind: "ok" });
    expect(mocks.restartAimuxControlPlane).not.toHaveBeenCalled();
    expect(host.dashboardBusyState).toBeNull();
  });

  it("still restarts Aimux when the service manifest is repeatedly stale", async () => {
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
    await refreshRuntimeGuard(host as never);

    expect(host.runtimeGuardState).toEqual({ kind: "stale", reason: "service-mismatch" });
    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/repo/app",
        reloadDashboards: false,
        verifyDashboards: false,
      }),
    );
    expect(host.dashboardBusyState).toMatchObject({ title: "Repairing Aimux" });
  });

  it("does not launch repair while dashboard startup is still priming", async () => {
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
    host.dashboardStartupPriming = true;

    const { refreshRuntimeGuard } = await import("./dashboard-control.js");
    await refreshRuntimeGuard(host as never);
    await refreshRuntimeGuard(host as never);

    expect(host.runtimeGuardState).toEqual({ kind: "stale", reason: "service-mismatch" });
    expect(mocks.restartAimuxControlPlane).not.toHaveBeenCalled();
    expect(host.dashboardBusyState).toBeNull();
  });

  it("keeps the repair overlay while a Core repair is still running", async () => {
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

  it("replays local tmux focus after reconnect restores a temporarily empty model", async () => {
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
    const host = runtimeGuardHost() as any;
    host.runtimeGuardState = { kind: "disconnected" };
    host.runtimeGuardRepairBusy = true;
    host.dashboardBusyState = { title: "Aimux is reconnecting", lines: [], spinnerFrame: 0, startedAt: Date.now() };
    host.dashboardState.worktreeEntries = [];
    host.dashboardState.worktreeSessions = [];
    host.getDashboardSessions = vi.fn(() => []);

    const { handleActiveDashboardOverlayKey, refreshRuntimeGuard } = await import("./dashboard-control.js");
    expect(handleActiveDashboardOverlayKey(host as never, Buffer.from("\r"))).toBe(true);
    expect(host.handleDashboardKey).not.toHaveBeenCalled();

    host.dashboardState.worktreeEntries = [{ kind: "session", id: "codex-1" }];
    host.dashboardState.worktreeSessions = [{ id: "codex-1", status: "ready" }];
    host.getDashboardSessions = vi.fn(() => [{ id: "codex-1", status: "ready" }]);
    await refreshRuntimeGuard(host as never);

    expect(host.dashboardBusyState).toBeNull();
    expect(host.handleDashboardKey).toHaveBeenCalledOnce();
    expect(host.handleDashboardKey).toHaveBeenCalledWith(Buffer.from("\r"));
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("replays local tmux focus when a busy repair settles into reconnecting with a live model", async () => {
    mocks.requestJson.mockRejectedValue(new Error("request timed out after 250ms"));
    const host = runtimeGuardHost() as any;
    host.runtimeGuardState = { kind: "ok" };
    host.runtimeGuardDisconnectProbeCount = 1;
    host.runtimeGuardRepairBusy = true;
    host.dashboardBusyState = { title: "Repairing Aimux", lines: [], spinnerFrame: 0, startedAt: Date.now() };
    host.dashboardState.worktreeEntries = [];
    host.dashboardState.worktreeSessions = [];
    host.getDashboardSessions = vi.fn(() => []);

    const { handleActiveDashboardOverlayKey, refreshRuntimeGuard } = await import("./dashboard-control.js");
    expect(handleActiveDashboardOverlayKey(host as never, Buffer.from("\r"))).toBe(true);
    expect(host.handleDashboardKey).not.toHaveBeenCalled();

    host.dashboardBusyState = null;
    host.runtimeGuardRepairBusy = false;
    host.dashboardState.worktreeEntries = [{ kind: "session", id: "codex-1" }];
    host.dashboardState.worktreeSessions = [{ id: "codex-1", status: "ready" }];
    host.getDashboardSessions = vi.fn(() => [{ id: "codex-1", status: "ready" }]);
    await refreshRuntimeGuard(host as never);

    expect(host.runtimeGuardState).toEqual({ kind: "disconnected" });
    expect(host.handleDashboardKey).toHaveBeenCalledOnce();
    expect(host.handleDashboardKey).toHaveBeenCalledWith(Buffer.from("\r"));
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it.each([
    ["Enter", "\r"],
    ["lowercase l", "l"],
  ])("retries queued local tmux focus for %s after the busy overlay clears", async (_label, rawKey) => {
    vi.useFakeTimers();
    const host = runtimeGuardHost() as any;
    host.runtimeGuardState = { kind: "disconnected" };
    host.runtimeGuardRepairBusy = true;
    host.dashboardBusyState = { title: "Repairing Aimux", lines: [], spinnerFrame: 0, startedAt: Date.now() };
    host.dashboardState.worktreeEntries = [];
    host.dashboardState.worktreeSessions = [];
    host.getDashboardSessions = vi.fn(() => []);

    try {
      const { handleActiveDashboardOverlayKey } = await import("./dashboard-control.js");
      expect(handleActiveDashboardOverlayKey(host as never, Buffer.from(rawKey))).toBe(true);
      expect(host.handleDashboardKey).not.toHaveBeenCalled();

      host.dashboardBusyState = null;
      host.runtimeGuardRepairBusy = false;
      host.dashboardState.worktreeEntries = [{ kind: "session", id: "codex-1" }];
      host.dashboardState.worktreeSessions = [{ id: "codex-1", status: "ready" }];
      host.getDashboardSessions = vi.fn(() => [{ id: "codex-1", status: "ready" }]);
      await vi.advanceTimersByTimeAsync(50);

      expect(host.handleDashboardKey).toHaveBeenCalledOnce();
      expect(host.handleDashboardKey).toHaveBeenCalledWith(Buffer.from(rawKey));
    } finally {
      vi.useRealTimers();
    }
  });

  it("only replays the first local navigation key from coalesced busy-overlay input", async () => {
    vi.useFakeTimers();
    const host = runtimeGuardHost() as any;
    host.runtimeGuardState = { kind: "disconnected" };
    host.runtimeGuardRepairBusy = true;
    host.dashboardBusyState = { title: "Repairing Aimux", lines: [], spinnerFrame: 0, startedAt: Date.now() };
    host.dashboardState.worktreeEntries = [];
    host.dashboardState.worktreeSessions = [];
    host.getDashboardSessions = vi.fn(() => []);

    try {
      const { handleActiveDashboardOverlayKey } = await import("./dashboard-control.js");
      expect(handleActiveDashboardOverlayKey(host as never, Buffer.from("\rn"))).toBe(true);
      expect(host.handleDashboardKey).not.toHaveBeenCalled();

      host.dashboardBusyState = null;
      host.runtimeGuardRepairBusy = false;
      host.dashboardState.worktreeEntries = [{ kind: "session", id: "codex-1" }];
      host.dashboardState.worktreeSessions = [{ id: "codex-1", status: "ready" }];
      host.getDashboardSessions = vi.fn(() => [{ id: "codex-1", status: "ready" }]);
      await vi.advanceTimersByTimeAsync(50);

      expect(host.handleDashboardKey).toHaveBeenCalledOnce();
      expect(host.handleDashboardKey).toHaveBeenCalledWith(Buffer.from("\r"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay mutating keys swallowed by reconnect overlays", async () => {
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
    const host = runtimeGuardHost() as any;
    host.runtimeGuardState = { kind: "disconnected" };
    host.runtimeGuardRepairBusy = true;
    host.dashboardBusyState = { title: "Aimux is reconnecting", lines: [], spinnerFrame: 0, startedAt: Date.now() };
    host.dashboardState.worktreeEntries = [];
    host.dashboardState.worktreeSessions = [];
    host.getDashboardSessions = vi.fn(() => []);

    const { handleActiveDashboardOverlayKey, refreshRuntimeGuard } = await import("./dashboard-control.js");
    expect(handleActiveDashboardOverlayKey(host as never, Buffer.from("n"))).toBe(true);

    host.dashboardState.worktreeEntries = [{ kind: "session", id: "codex-1" }];
    host.dashboardState.worktreeSessions = [{ id: "codex-1", status: "ready" }];
    host.getDashboardSessions = vi.fn(() => [{ id: "codex-1", status: "ready" }]);
    await refreshRuntimeGuard(host as never);

    expect(host.dashboardBusyState).toBeNull();
    expect(host.handleDashboardKey).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });

  it.each([
    ["mutating key", "n"],
    ["shifted Library shortcut", "L"],
  ])("does not replay a swallowed %s after reconnect", async (_label, rawKey) => {
    mocks.requestJson.mockResolvedValue(healthyServiceResponse(2, "/repo/app"));
    const host = runtimeGuardHost() as any;
    host.runtimeGuardState = { kind: "disconnected" };
    host.runtimeGuardRepairBusy = true;
    host.dashboardBusyState = { title: "Aimux is reconnecting", lines: [], spinnerFrame: 0, startedAt: Date.now() };
    host.dashboardState.worktreeEntries = [];
    host.dashboardState.worktreeSessions = [];
    host.getDashboardSessions = vi.fn(() => []);

    const { handleActiveDashboardOverlayKey, refreshRuntimeGuard } = await import("./dashboard-control.js");
    expect(handleActiveDashboardOverlayKey(host as never, Buffer.from(rawKey))).toBe(true);

    host.dashboardState.worktreeEntries = [{ kind: "session", id: "codex-1" }];
    host.dashboardState.worktreeSessions = [{ id: "codex-1", status: "ready" }];
    host.getDashboardSessions = vi.fn(() => [{ id: "codex-1", status: "ready" }]);
    await refreshRuntimeGuard(host as never);

    expect(host.dashboardBusyState).toBeNull();
    expect(host.handleDashboardKey).not.toHaveBeenCalled();
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

  it("maps screen hotkeys to their screens (c/p/L/t/g)", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    const cases: Array<[Buffer, string, keyof ReturnType<typeof makeHost>, string]> = [
      [Buffer.from("c"), "c", "showCoordination", "project"],
      [Buffer.from("p"), "p", "showProject", "coordination"],
      [Buffer.from("L"), "l", "showLibrary", "coordination"],
      [Buffer.from("t"), "t", "showTopology", "coordination"],
      [Buffer.from("g"), "g", "showGraveyard", "coordination"],
    ];
    for (const [raw, key, method, otherScreen] of cases) {
      const host = makeHost();
      const [event] = (await import("../key-parser.js")).parseKeys(raw);
      // currentScreen differs from target, so the show* (not render*) path runs.
      const handled = handleDashboardSubscreenNavigationKey(host as never, key, otherScreen as never, event);
      expect(handled).toBe(true);
      expect(host[method]).toHaveBeenCalledTimes(1);
    }
  });

  it("declines (returns false) when the hotkey matches the current screen, so the screen's own handler can act", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    // e.g. on coordination, [c] must reach the section handler (clear/complete), not re-nav.
    const cases: Array<[Buffer, string, string, keyof ReturnType<typeof makeHost>]> = [
      [Buffer.from("c"), "c", "coordination", "showCoordination"],
      [Buffer.from("p"), "p", "project", "showProject"],
      [Buffer.from("L"), "l", "library", "showLibrary"],
      [Buffer.from("t"), "t", "topology", "showTopology"],
      [Buffer.from("g"), "g", "graveyard", "showGraveyard"],
    ];
    for (const [raw, key, screen, showMethod] of cases) {
      const host = makeHost();
      const [event] = (await import("../key-parser.js")).parseKeys(raw);
      expect(handleDashboardSubscreenNavigationKey(host as never, key, screen as never, event)).toBe(false);
      // Declining must not also fire the switch — the key belongs to the screen's own handler.
      expect(host[showMethod]).not.toHaveBeenCalled();
    }
  });

  it("leaves lowercase l available for local navigation on subscreens", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    const { parseKeys } = await import("../key-parser.js");
    const host = makeHost();
    const [event] = parseKeys(Buffer.from("l"));
    expect(handleDashboardSubscreenNavigationKey(host as never, "l", "coordination", event)).toBe(false);
    expect(host.showLibrary).not.toHaveBeenCalled();
  });

  it("no longer treats the retired i/y keys as navigation", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    for (const key of ["i", "y", "z"]) {
      const host = makeHost();
      expect(handleDashboardSubscreenNavigationKey(host as never, key, "graveyard")).toBe(false);
    }
  });
});
