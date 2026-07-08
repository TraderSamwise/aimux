import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRestartResult } from "./runtime-restart.js";

const mocks = vi.hoisted(() => ({
  loadDaemonInfo: vi.fn(),
  loadDaemonState: vi.fn(),
  restartAimuxControlPlane: vi.fn(),
  renderRuntimeRestartResult: vi.fn(),
  stopDaemonInfo: vi.fn(),
  ensureDaemonRunning: vi.fn(),
}));

vi.mock("./daemon-state.js", () => ({
  loadDaemonInfo: mocks.loadDaemonInfo,
  loadDaemonState: mocks.loadDaemonState,
}));

vi.mock("./daemon-supervisor.js", () => ({
  stopDaemonInfo: mocks.stopDaemonInfo,
  ensureDaemonRunning: mocks.ensureDaemonRunning,
}));

vi.mock("./runtime-restart.js", () => ({
  restartAimuxControlPlane: mocks.restartAimuxControlPlane,
  renderRuntimeRestartResult: mocks.renderRuntimeRestartResult,
}));

import { restartControlPlaneFromCli } from "./control-plane-restart-client.js";

function restartResult(): RuntimeRestartResult {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    before: {} as RuntimeRestartResult["before"],
    verification: { status: "skipped", after: null, error: null },
    daemon: {
      previous: null,
      current: { pid: 42, port: 43190, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    },
    projects: [],
    summary: {
      projects: 0,
      servicesEnsured: 0,
      runtimeRepairs: 0,
      dashboardsReloaded: 0,
      runtimeRebuildRequired: 0,
      failures: 0,
    },
  };
}

describe("restartControlPlaneFromCli", () => {
  beforeEach(() => {
    mocks.restartAimuxControlPlane.mockReset();
    mocks.renderRuntimeRestartResult.mockReset();
    mocks.loadDaemonInfo.mockReset();
    mocks.loadDaemonState.mockReset();
    mocks.stopDaemonInfo.mockReset();
    mocks.ensureDaemonRunning.mockReset();
    mocks.loadDaemonInfo.mockReturnValue(null);
    mocks.loadDaemonState.mockReturnValue({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      projects: {},
    });
  });

  it("runs restart through local repair orchestration", async () => {
    const restart = restartResult();
    mocks.restartAimuxControlPlane.mockResolvedValueOnce(restart);
    mocks.renderRuntimeRestartResult.mockReturnValueOnce("local text");

    const result = await restartControlPlaneFromCli();

    expect(result).toEqual({ restart, text: "local text", source: "local-bootstrap" });
    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledWith({
      projectRoot: undefined,
      stopDaemon: undefined,
      ensureDaemonRunning: expect.any(Function),
    });
    const options = mocks.restartAimuxControlPlane.mock.calls[0][0];
    options.ensureDaemonRunning();
    expect(mocks.ensureDaemonRunning).toHaveBeenCalledWith({ adoptExisting: false });
  });

  it("passes project-scoped restart requests to local repair orchestration", async () => {
    const restart = restartResult();
    mocks.restartAimuxControlPlane.mockResolvedValueOnce(restart);
    mocks.renderRuntimeRestartResult.mockReturnValueOnce("project text");

    const result = await restartControlPlaneFromCli("/repo");

    expect(result.text).toBe("project text");
    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledWith({
      projectRoot: "/repo",
      stopDaemon: undefined,
      ensureDaemonRunning: expect.any(Function),
    });
  });

  it("preserves stale daemon info for local bootstrap repair", async () => {
    const restart = restartResult();
    const daemon = {
      pid: 111,
      port: 43190,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const state = {
      version: 1 as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
      projects: {
        alpha: {
          projectId: "alpha",
          projectRoot: "/repo",
          pid: 222,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    mocks.loadDaemonInfo.mockReturnValueOnce(daemon);
    mocks.loadDaemonState.mockReturnValueOnce(state);
    mocks.restartAimuxControlPlane.mockImplementationOnce(async (options: { stopDaemon?: () => Promise<unknown> }) => {
      expect(options.stopDaemon).toEqual(expect.any(Function));
      await options.stopDaemon?.();
      return restart;
    });
    mocks.stopDaemonInfo.mockResolvedValueOnce({ ...daemon, stoppedProjectServices: [state.projects.alpha] });
    mocks.renderRuntimeRestartResult.mockReturnValueOnce("local text");

    const result = await restartControlPlaneFromCli("/repo");

    expect(result.source).toBe("local-bootstrap");
    expect(mocks.stopDaemonInfo).toHaveBeenCalledWith(daemon, state);
  });
});
