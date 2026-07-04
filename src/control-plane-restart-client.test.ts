import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_COMMAND_NAMES } from "./core-command-contract.js";
import type { RuntimeRestartResult } from "./runtime-restart.js";

const mocks = vi.hoisted(() => ({
  loadDaemonInfo: vi.fn(),
  loadDaemonState: vi.fn(),
  requestCoreCommand: vi.fn(),
  restartAimuxControlPlane: vi.fn(),
  renderRuntimeRestartResult: vi.fn(),
  stopDaemonInfo: vi.fn(),
}));

vi.mock("./daemon-state.js", () => ({
  loadDaemonInfo: mocks.loadDaemonInfo,
  loadDaemonState: mocks.loadDaemonState,
}));

vi.mock("./daemon-supervisor.js", () => ({
  stopDaemonInfo: mocks.stopDaemonInfo,
}));

vi.mock("./core-command-client.js", () => ({
  requestCoreCommand: mocks.requestCoreCommand,
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
    mocks.requestCoreCommand.mockReset();
    mocks.restartAimuxControlPlane.mockReset();
    mocks.renderRuntimeRestartResult.mockReset();
    mocks.loadDaemonInfo.mockReset();
    mocks.loadDaemonState.mockReset();
    mocks.stopDaemonInfo.mockReset();
    mocks.loadDaemonInfo.mockReturnValue(null);
    mocks.loadDaemonState.mockReturnValue({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      projects: {},
    });
  });

  it("delegates normal restart work to the daemon core command", async () => {
    const restart = restartResult();
    mocks.requestCoreCommand.mockResolvedValueOnce({
      ok: true,
      id: "restart",
      command: CORE_COMMAND_NAMES.restart,
      issuedAt: "2026-01-01T00:00:00.000Z",
      result: { restart, text: "daemon text" },
    });

    const result = await restartControlPlaneFromCli();

    expect(result).toEqual({ restart, text: "daemon text", source: "daemon" });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.restart, undefined);
    expect(mocks.restartAimuxControlPlane).not.toHaveBeenCalled();
  });

  it("passes project-scoped restart requests to the daemon core command", async () => {
    const restart = restartResult();
    mocks.requestCoreCommand.mockResolvedValueOnce({
      ok: true,
      id: "restart",
      command: CORE_COMMAND_NAMES.restart,
      issuedAt: "2026-01-01T00:00:00.000Z",
      result: { restart, text: "project text" },
    });

    await restartControlPlaneFromCli("/repo");

    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.restart, { projectRoot: "/repo" });
  });

  it("uses local bootstrap repair when the daemon is from another build", async () => {
    const restart = restartResult();
    mocks.requestCoreCommand.mockRejectedValueOnce(
      new Error("aimux daemon on default port is from a different local build"),
    );
    mocks.restartAimuxControlPlane.mockResolvedValueOnce(restart);
    mocks.renderRuntimeRestartResult.mockReturnValueOnce("local text");

    const result = await restartControlPlaneFromCli("/repo");

    expect(result).toEqual({ restart, text: "local text", source: "local-bootstrap" });
    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledWith({ projectRoot: "/repo", stopDaemon: undefined });
  });

  it("uses local bootstrap repair without a project scope", async () => {
    const restart = restartResult();
    mocks.requestCoreCommand.mockRejectedValueOnce(
      new Error("aimux daemon on default port is from a different local build"),
    );
    mocks.restartAimuxControlPlane.mockResolvedValueOnce(restart);
    mocks.renderRuntimeRestartResult.mockReturnValueOnce("local text");

    const result = await restartControlPlaneFromCli();

    expect(result).toEqual({ restart, text: "local text", source: "local-bootstrap" });
    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledWith({ projectRoot: undefined, stopDaemon: undefined });
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
    mocks.requestCoreCommand.mockRejectedValueOnce(
      new Error("stored daemon health response does not match this Aimux build"),
    );
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

  it("does not mask non-bootstrap daemon errors", async () => {
    mocks.requestCoreCommand.mockRejectedValueOnce(new Error("permission denied"));

    await expect(restartControlPlaneFromCli()).rejects.toThrow("permission denied");
    expect(mocks.restartAimuxControlPlane).not.toHaveBeenCalled();
  });
});
