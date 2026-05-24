import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import {
  acceptShareInvite,
  clearNotifications,
  createShareInvite,
  getAgentHistory,
  getAgentOutput,
  listProjects,
  listNotifications,
  listThreads,
  markNotificationsRead,
  putPlan,
  sendAgentInput,
  setApiRelay,
  spawnAgent,
  stopService,
} from "@/lib/api";
import type { RelayTransport } from "@/lib/relay-transport";

const endpoint = { host: "127.0.0.1", port: 43210 };
const originalConnectionMode = process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
const originalRelayUrl = process.env.EXPO_PUBLIC_AIMUX_RELAY_URL;

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
    if (originalRelayUrl === undefined) {
      delete process.env.EXPO_PUBLIC_AIMUX_RELAY_URL;
    } else {
      process.env.EXPO_PUBLIC_AIMUX_RELAY_URL = originalRelayUrl;
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
    await listNotifications(endpoint, { unreadOnly: true, sessionId: "agent/1" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(
      1,
      "GET",
      "/proxy/127.0.0.1/43210/threads?session=agent%2F1",
      undefined,
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "GET",
      "/proxy/127.0.0.1/43210/notifications?unread=1&sessionId=agent%2F1",
      undefined,
    );
  });

  it("routes notification mutations through the relay proxy", async () => {
    const fetchMock = installFetchMock();
    const request = installRelayMock({ ok: true, updated: 1 });

    await markNotificationsRead(endpoint, { id: "notice-1" });
    await clearNotifications(endpoint, { sessionId: "agent-1" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(
      1,
      "POST",
      "/proxy/127.0.0.1/43210/notifications/read",
      {
        id: "notice-1",
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/proxy/127.0.0.1/43210/notifications/clear",
      {
        sessionId: "agent-1",
      },
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

  it("creates share invites through relay HTTP with auth", async () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "relay";
    process.env.EXPO_PUBLIC_AIMUX_RELAY_URL = "wss://relay-preview.example.com/";
    const fetchMock = installFetchMock({
      ok: true,
      emailDelivered: true,
      share: {
        id: "share_1",
        ownerUserId: "user_owner",
        projectRoot: "/repo",
        sessionId: "claude-1",
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
        version: 1,
        mode: "single",
        participants: [],
        invites: [],
      },
      invite: {
        id: "invite_1",
        email: "guest@example.com",
        status: "pending",
        createdAt: "2026-05-24T00:00:00.000Z",
        expiresAt: "2026-05-31T00:00:00.000Z",
      },
      acceptUrl: "https://aimux.app/shares/invite/user_owner/token/accept",
    });

    await createShareInvite("/repo", "claude-1", "guest@example.com", endpoint, {
      token: "clerk-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay-preview.example.com/shares/invite");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      projectRoot: "/repo",
      sessionId: "claude-1",
      email: "guest@example.com",
      serviceEndpoint: endpoint,
    });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer clerk-token");
  });

  it("accepts share invites through relay HTTP with auth", async () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "relay";
    process.env.EXPO_PUBLIC_AIMUX_RELAY_URL = "wss://relay-preview.example.com/";
    const fetchMock = installFetchMock({
      ok: true,
      share: {
        id: "share_1",
        ownerUserId: "user_owner",
        projectRoot: "/repo",
        serviceEndpoint: endpoint,
        sessionId: "claude-1",
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
        version: 2,
        mode: "multi",
        participants: [],
        invites: [],
      },
      participant: {
        userId: "user_guest",
        displayName: "Guest",
        role: "guest",
        status: "active",
        joinedAt: "2026-05-24T00:00:00.000Z",
      },
    });

    await acceptShareInvite("user/owner", "token/value", { token: "clerk-token" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://relay-preview.example.com/shares/invite/user%2Fowner/token%2Fvalue/accept",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer clerk-token");
  });
});
