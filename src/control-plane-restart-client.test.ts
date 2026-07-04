import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_COMMAND_NAMES } from "./core-command-contract.js";
import type { RuntimeRestartResult } from "./runtime-restart.js";

const mocks = vi.hoisted(() => ({
  requestCoreCommand: vi.fn(),
  restartAimuxControlPlane: vi.fn(),
  renderRuntimeRestartResult: vi.fn(),
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
    expect(mocks.restartAimuxControlPlane).toHaveBeenCalledWith({ projectRoot: "/repo" });
  });

  it("does not mask non-bootstrap daemon errors", async () => {
    mocks.requestCoreCommand.mockRejectedValueOnce(new Error("permission denied"));

    await expect(restartControlPlaneFromCli()).rejects.toThrow("permission denied");
    expect(mocks.restartAimuxControlPlane).not.toHaveBeenCalled();
  });
});
