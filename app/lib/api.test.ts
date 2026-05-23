import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import {
  getAgentHistory,
  getAgentOutput,
  listProjects,
  listThreads,
  putPlan,
  sendAgentInput,
  setApiRelay,
  spawnAgent,
  stopService,
} from "@/lib/api";
import type { RelayTransport } from "@/lib/relay-transport";

const endpoint = { host: "127.0.0.1", port: 43210 };
const originalConnectionMode = process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;

function installFetchMock(body: unknown = { ok: true }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function installRelayMock(body: unknown = { ok: true }) {
  const request = vi.fn(async (method: string, path: string, payload?: unknown) => ({
    status: 200,
    body,
    method,
    path,
    payload,
  }));
  setApiRelay({ wsConnected: true, request } as unknown as RelayTransport);
  return request;
}

describe("api relay routing", () => {
  afterEach(() => {
    setApiRelay(null);
    if (originalConnectionMode === undefined) {
      delete process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
    } else {
      process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = originalConnectionMode;
    }
    vi.restoreAllMocks();
  });

  it("uses direct project HTTP when no relay transport is connected", async () => {
    const fetchMock = installFetchMock({ sessionId: "session/a b", messages: [] });

    await getAgentHistory(endpoint, "session/a b", 25, { token: "local-token" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43210/agents/history?sessionId=session%2Fa%20b&lastN=25");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer local-token");
  });

  it("routes project GET requests through the relay proxy when connected", async () => {
    const fetchMock = installFetchMock();
    const request = installRelayMock({ sessionId: "s/1", output: "hello" });

    await getAgentOutput(endpoint, "s/1", 7);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/proxy/127.0.0.1/43210/agents/output?sessionId=s%2F1&startLine=7",
      undefined,
    );
  });

  it("routes project POST and PUT bodies through the relay proxy when connected", async () => {
    const fetchMock = installFetchMock();
    const request = installRelayMock({ ok: true, sessionId: "agent-1" });

    await sendAgentInput(endpoint, {
      sessionId: "agent-1",
      data: "hello",
      submit: true,
    });
    await putPlan(endpoint, "agent-1", "ship it");
    await spawnAgent(endpoint, { tool: "codex", worktreePath: "/tmp/work" });
    await stopService(endpoint, "svc-1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(1, "POST", "/proxy/127.0.0.1/43210/agents/input", {
      sessionId: "agent-1",
      data: "hello",
      submit: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/proxy/127.0.0.1/43210/plans/agent-1", {
      content: "ship it",
    });
    expect(request).toHaveBeenNthCalledWith(3, "POST", "/proxy/127.0.0.1/43210/agents/spawn", {
      tool: "codex",
      worktreePath: "/tmp/work",
    });
    expect(request).toHaveBeenNthCalledWith(4, "POST", "/proxy/127.0.0.1/43210/services/stop", {
      serviceId: "svc-1",
    });
  });

  it("preserves optional list query parameters through the relay proxy", async () => {
    const fetchMock = installFetchMock();
    const request = installRelayMock([]);

    await listThreads(endpoint, "agent/1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/proxy/127.0.0.1/43210/threads?session=agent%2F1",
      undefined,
    );
  });

  it("does not fall back to direct HTTP when relay transport is not ready", async () => {
    const fetchMock = installFetchMock();
    const request = vi.fn(async () => {
      throw new Error("Relay not connected");
    });
    setApiRelay({ wsConnected: false, request } as unknown as RelayTransport);

    await expect(listProjects()).rejects.toThrow("Relay not connected");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("GET", "/projects", undefined);
  });

  it("does not fall back to direct HTTP when relay mode is configured before transport registration", async () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "relay";
    const fetchMock = installFetchMock();

    await expect(getAgentHistory(endpoint, "session-1")).rejects.toThrow("Relay not connected");
    await expect(listProjects()).rejects.toThrow("Relay not connected");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
