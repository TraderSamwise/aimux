import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_API_ROUTES, CORE_COMMAND_NAMES } from "./core-command-contract.js";

const daemonMocks = vi.hoisted(() => ({
  requestDaemonJson: vi.fn(),
}));

vi.mock("./daemon-client.js", () => ({
  requestDaemonJson: daemonMocks.requestDaemonJson,
}));

import { sendCoreCommand } from "./core-command-transport.js";

describe("sendCoreCommand", () => {
  beforeEach(() => {
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

  it("posts command envelopes to the daemon command route", async () => {
    await expect(sendCoreCommand(CORE_COMMAND_NAMES.ping, undefined, { timeoutMs: 1234 })).resolves.toMatchObject({
      ok: true,
      command: CORE_COMMAND_NAMES.ping,
    });

    expect(daemonMocks.requestDaemonJson).toHaveBeenCalledWith(CORE_API_ROUTES.commands, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: CORE_COMMAND_NAMES.ping }),
      timeoutMs: 1234,
    });
  });

  it("throws daemon command errors", async () => {
    daemonMocks.requestDaemonJson.mockResolvedValue({ ok: false, error: "bad command" });

    await expect(sendCoreCommand(CORE_COMMAND_NAMES.ping)).rejects.toThrow("bad command");
  });

  it("throws mismatched command responses", async () => {
    daemonMocks.requestDaemonJson.mockResolvedValue({
      ok: true,
      id: "test",
      command: CORE_COMMAND_NAMES.status,
      issuedAt: new Date(0).toISOString(),
      result: { pong: true },
    });

    await expect(sendCoreCommand(CORE_COMMAND_NAMES.ping)).rejects.toThrow(
      "core command response mismatch: expected core.ping, got core.status",
    );
  });
});
