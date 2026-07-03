import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: null as null | { pid: number; port: number; startedAt: string; updatedAt: string },
  requestJson: vi.fn(),
}));

vi.mock("./daemon-state.js", () => ({
  getDaemonBaseUrl: (port?: number) => `http://127.0.0.1:${port ?? 43190}`,
  loadDaemonInfo: () => mocks.info,
}));

vi.mock("./http-client.js", () => ({
  requestJson: mocks.requestJson,
}));

import { requestDaemonJson } from "./daemon-client.js";

describe("requestDaemonJson", () => {
  beforeEach(() => {
    mocks.info = {
      pid: 123,
      port: 43210,
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    mocks.requestJson.mockReset();
    mocks.requestJson.mockResolvedValue({ status: 200, json: { ok: true, value: 1 } });
  });

  it("throws when the daemon is not running", async () => {
    mocks.info = null;

    await expect(requestDaemonJson("/health")).rejects.toThrow("aimux daemon is not running");
    expect(mocks.requestJson).not.toHaveBeenCalled();
  });

  it("passes request fields to the stored daemon endpoint", async () => {
    await expect(
      requestDaemonJson("/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "ping" }),
        timeoutMs: 1234,
      }),
    ).resolves.toEqual({ ok: true, value: 1 });

    expect(mocks.requestJson).toHaveBeenCalledWith("http://127.0.0.1:43210/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "ping" }),
      timeoutMs: 1234,
    });
  });

  it("throws daemon error payloads for non-2xx responses", async () => {
    mocks.requestJson.mockResolvedValue({ status: 503, json: { error: "daemon unavailable" } });

    await expect(requestDaemonJson("/health")).rejects.toThrow("daemon unavailable");
  });

  it("throws daemon error payloads when ok is false", async () => {
    mocks.requestJson.mockResolvedValue({ status: 200, json: { ok: false, error: "bad command" } });

    await expect(requestDaemonJson("/commands")).rejects.toThrow("bad command");
  });
});
