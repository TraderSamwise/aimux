import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_COMMAND_NAMES } from "./core-command-contract.js";

const daemonMocks = vi.hoisted(() => ({
  ensureDaemonRunning: vi.fn(),
  requestDaemonJson: vi.fn(),
}));

vi.mock("./daemon.js", () => ({
  ensureDaemonRunning: daemonMocks.ensureDaemonRunning,
  requestDaemonJson: daemonMocks.requestDaemonJson,
}));

describe("requestCoreCommand", () => {
  beforeEach(() => {
    daemonMocks.ensureDaemonRunning.mockReset();
    daemonMocks.requestDaemonJson.mockReset();
    daemonMocks.requestDaemonJson.mockImplementation(async (_path: string, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? "{}") as { command: string };
      return {
        ok: true,
        id: "test",
        command: body.command,
        issuedAt: new Date(0).toISOString(),
        result: { pong: true },
      };
    });
  });

  it("ensures the daemon by default", async () => {
    const { requestCoreCommand } = await import("./core-command-client.js");

    await requestCoreCommand(CORE_COMMAND_NAMES.ping);

    expect(daemonMocks.ensureDaemonRunning).toHaveBeenCalledTimes(1);
  });

  it("can skip daemon startup for read-only diagnostics", async () => {
    const { requestCoreCommand } = await import("./core-command-client.js");

    await requestCoreCommand(CORE_COMMAND_NAMES.ping, undefined, { ensureDaemon: false });

    expect(daemonMocks.ensureDaemonRunning).not.toHaveBeenCalled();
  });
});
