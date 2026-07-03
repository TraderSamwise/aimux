import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_COMMAND_NAMES } from "./core-command-contract.js";

const daemonMocks = vi.hoisted(() => ({
  ensureDaemonRunning: vi.fn(),
  sendCoreCommand: vi.fn(),
}));

vi.mock("./daemon-supervisor.js", () => ({
  ensureDaemonRunning: daemonMocks.ensureDaemonRunning,
}));

vi.mock("./core-command-transport.js", () => ({
  sendCoreCommand: daemonMocks.sendCoreCommand,
}));

describe("requestCoreCommand", () => {
  beforeEach(() => {
    daemonMocks.ensureDaemonRunning.mockReset();
    daemonMocks.sendCoreCommand.mockReset();
    daemonMocks.sendCoreCommand.mockImplementation(async (command: string) => {
      return {
        ok: true,
        id: "test",
        command,
        issuedAt: new Date(0).toISOString(),
        result: { pong: true },
      };
    });
  });

  it("ensures the daemon by default", async () => {
    const { requestCoreCommand } = await import("./core-command-client.js");

    await requestCoreCommand(CORE_COMMAND_NAMES.ping);

    expect(daemonMocks.ensureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(daemonMocks.sendCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.ping, undefined, {
      timeoutMs: undefined,
    });
  });

  it("can skip daemon startup for read-only diagnostics", async () => {
    const { requestCoreCommand } = await import("./core-command-client.js");

    await requestCoreCommand(CORE_COMMAND_NAMES.relayStatus, undefined, { ensureDaemon: false });

    expect(daemonMocks.ensureDaemonRunning).not.toHaveBeenCalled();
  });

  it("passes command options to the pure transport", async () => {
    const { requestCoreCommand } = await import("./core-command-client.js");

    await requestCoreCommand(CORE_COMMAND_NAMES.relayStatus, undefined, { ensureDaemon: false, timeoutMs: 1234 });

    expect(daemonMocks.sendCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.relayStatus, undefined, {
      timeoutMs: 1234,
    });
  });
});
