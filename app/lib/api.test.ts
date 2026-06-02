import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import {
  acceptShareInvite,
  clearNotifications,
  createService,
  createWorktree,
  createShareInvite,
  deleteGraveyardWorktree,
  getShare,
  getAgentOutput,
  getTask,
  graveyardWorktree,
  leaveShare,
  listShares,
  listProjects,
  listNotifications,
  listTasks,
  listThreads,
  listWorkflow,
  markNotificationsRead,
  removeService,
  removeWorktree,
  removeShareParticipant,
  putPlan,
  resurrectGraveyardWorktree,
  resumeService,
  sendAgentInput,
  setApiRelay,
  stopService,
  uploadImageAttachment,
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
    const fetchMock = installFetchMock({ sessionId: "session/a b", output: "" });

    await getAgentOutput(endpoint, "session/a b", -25, { token: "local-token" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43210/agents/output?sessionId=session%2Fa+b&startLine=-25");
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

    await putPlan(endpoint, "agent-1", "ship it");
    await createService(endpoint, {
      command: "yarn dev",
      worktreePath: "/tmp/a",
      serviceId: "svc-1",
    });
    await stopService(endpoint, "svc-1");
    await resumeService(endpoint, "svc-1");
    await removeService(endpoint, "svc-1");
    await createWorktree(endpoint, "feature/a");
    await removeWorktree(endpoint, "/repo/feature/a");
    await graveyardWorktree(endpoint, "/repo/feature/a");
    await resurrectGraveyardWorktree(endpoint, "/repo/feature/a");
    await deleteGraveyardWorktree(endpoint, "/repo/feature/a");
    await sendAgentInput(endpoint, "agent-1", "hello", { attachmentIds: ["att_one"] });
    await uploadImageAttachment(endpoint, {
      filename: "shot.png",
      mimeType: "image/png",
      dataBase64: "aGVsbG8=",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(1, "PUT", "/proxy/127.0.0.1/43210/plans/agent-1", {
      content: "ship it",
    });
    expect(request).toHaveBeenNthCalledWith(2, "POST", "/proxy/127.0.0.1/43210/services/create", {
      command: "yarn dev",
      worktreePath: "/tmp/a",
      serviceId: "svc-1",
    });
    expect(request).toHaveBeenNthCalledWith(3, "POST", "/proxy/127.0.0.1/43210/services/stop", {
      serviceId: "svc-1",
    });
    expect(request).toHaveBeenNthCalledWith(4, "POST", "/proxy/127.0.0.1/43210/services/resume", {
      serviceId: "svc-1",
    });
    expect(request).toHaveBeenNthCalledWith(5, "POST", "/proxy/127.0.0.1/43210/services/remove", {
      serviceId: "svc-1",
    });
    expect(request).toHaveBeenNthCalledWith(6, "POST", "/proxy/127.0.0.1/43210/worktrees/create", {
      name: "feature/a",
    });
    expect(request).toHaveBeenNthCalledWith(7, "POST", "/proxy/127.0.0.1/43210/worktrees/remove", {
      path: "/repo/feature/a",
    });
    expect(request).toHaveBeenNthCalledWith(
      8,
      "POST",
      "/proxy/127.0.0.1/43210/worktrees/graveyard",
      {
        path: "/repo/feature/a",
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      9,
      "POST",
      "/proxy/127.0.0.1/43210/graveyard/worktrees/resurrect",
      {
        path: "/repo/feature/a",
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      10,
      "POST",
      "/proxy/127.0.0.1/43210/graveyard/worktrees/delete",
      {
        path: "/repo/feature/a",
      },
    );
    expect(request).toHaveBeenNthCalledWith(11, "POST", "/proxy/127.0.0.1/43210/agents/input", {
      sessionId: "agent-1",
      text: "hello",
      attachmentIds: ["att_one"],
    });
    expect(request).toHaveBeenNthCalledWith(12, "POST", "/proxy/127.0.0.1/43210/attachments", {
      kind: "image",
      filename: "shot.png",
      mimeType: "image/png",
      dataBase64: "aGVsbG8=",
    });
  });

  it("uploads image attachments through direct project HTTP with auth", async () => {
    const fetchMock = installFetchMock({
      ok: true,
      attachment: {
        id: "att_one",
        kind: "image",
        filename: "shot.png",
        mimeType: "image/png",
        sizeBytes: 5,
        sha256: "hash",
        createdAt: "2026-05-24T00:00:00.000Z",
        source: "upload",
        contentUrl: "/attachments/att_one/content",
      },
    });

    await uploadImageAttachment(
      endpoint,
      {
        filename: "shot.png",
        mimeType: "image/png",
        dataBase64: "aGVsbG8=",
      },
      { token: "local-token" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:43210/attachments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "image",
      filename: "shot.png",
      mimeType: "image/png",
      dataBase64: "aGVsbG8=",
    });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer local-token");
  });

  it("preserves optional list query parameters through the relay proxy", async () => {
    const fetchMock = installFetchMock();
    const request = installRelayMock([]);

    await listThreads(endpoint, "agent/1");
    await listNotifications(endpoint, { unreadOnly: true, sessionId: "agent/1" });
    await listWorkflow(endpoint, "codex/1");
    await listTasks(endpoint, { sessionId: "agent/1", status: "pending" });
    await getTask(endpoint, "task/1");

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
    expect(request).toHaveBeenNthCalledWith(
      3,
      "GET",
      "/proxy/127.0.0.1/43210/workflow?participant=codex%2F1",
      undefined,
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      "GET",
      "/proxy/127.0.0.1/43210/tasks?session=agent%2F1&status=pending",
      undefined,
    );
    expect(request).toHaveBeenNthCalledWith(
      5,
      "GET",
      "/proxy/127.0.0.1/43210/tasks/task%2F1",
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

    await expect(getAgentOutput(endpoint, "session-1")).rejects.toThrow("Relay not connected");
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

  it("manages shares through owner-scoped relay HTTP routes", async () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "relay";
    process.env.EXPO_PUBLIC_AIMUX_RELAY_URL = "wss://relay-preview.example.com/";
    const fetchMock = installFetchMock({ ok: true, share: { id: "share_1" } });

    await listShares({ token: "clerk-token" });
    await getShare("user/owner", "share/1", { token: "clerk-token" });
    await leaveShare("user/owner", "share/1", { token: "clerk-token" });
    await removeShareParticipant("user/owner", "share/1", "user/guest", {
      token: "clerk-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://relay-preview.example.com/shares",
      "https://relay-preview.example.com/shares/user%2Fowner/share%2F1",
      "https://relay-preview.example.com/shares/user%2Fowner/share%2F1/leave",
      "https://relay-preview.example.com/shares/user%2Fowner/share%2F1/participants/user%2Fguest",
    ]);
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("POST");
    expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBe("DELETE");
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers((init as RequestInit).headers).get("authorization")).toBe(
        "Bearer clerk-token",
      );
    }
  });
});
