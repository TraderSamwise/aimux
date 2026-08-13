import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverNotificationPush, deliverSecurityAlert } from "./security-delivery";
import type { SecurityPushTokenRecord } from "./security";

function token(overrides: Partial<SecurityPushTokenRecord>): SecurityPushTokenRecord {
  return {
    userId: "user_owner",
    deviceId: "device-1",
    token: "ExponentPushToken[a]",
    platform: "ios",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("deliverNotificationPush", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pushes only to the owner's mobile tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverNotificationPush({
      userId: "user_owner",
      title: "Agent needs input",
      body: "claude-abc is waiting",
      kind: "needs_input",
      sessionId: "claude-abc",
      projectRoot: "/repo",
      pushTokens: [
        token({ deviceId: "ios", token: "ExponentPushToken[owner-ios]", platform: "ios" }),
        token({ deviceId: "android", token: "ExponentPushToken[owner-android]", platform: "android" }),
        token({ deviceId: "web", token: "ExponentPushToken[owner-web]", platform: "web" }),
        token({ userId: "user_guest", deviceId: "guest", token: "ExponentPushToken[guest]" }),
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Array<{
      to: string;
      priority?: string;
      sound?: string;
      interruptionLevel?: string;
    }>;
    expect(body.map((message) => message.to).sort()).toEqual([
      "ExponentPushToken[owner-android]",
      "ExponentPushToken[owner-ios]",
    ]);
    const ios = body.find((m) => m.to === "ExponentPushToken[owner-ios]");
    const android = body.find((m) => m.to === "ExponentPushToken[owner-android]");
    expect(ios).toMatchObject({
      title: "Agent needs input",
      body: "claude-abc is waiting",
      sound: "default",
      priority: "high",
      interruptionLevel: "timeSensitive",
      data: { category: "agent", kind: "needs_input", sessionId: "claude-abc", projectRoot: "/repo" },
    });
    expect(android).toMatchObject({ priority: "high" });
    expect(android).not.toHaveProperty("interruptionLevel");
    expect(android).not.toHaveProperty("sound");
  });

  it("does not call the push API when no owner mobile tokens exist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverNotificationPush({
      userId: "user_owner",
      title: "Agent done",
      body: "finished",
      pushTokens: [token({ userId: "user_guest", platform: "ios" }), token({ platform: "web" })],
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips owner mobile tokens that muted agent alerts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverNotificationPush({
      userId: "user_owner",
      title: "Agent done",
      body: "finished",
      pushTokens: [
        token({
          deviceId: "muted-ios",
          platform: "ios",
          token: "ExponentPushToken[muted-ios]",
          agentAlerts: false,
        }),
        token({ deviceId: "live-ios", platform: "ios", token: "ExponentPushToken[live-ios]" }),
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Array<{ to: string }>;
    expect(body.map((message) => message.to)).toEqual(["ExponentPushToken[live-ios]"]);
  });

  it("throws when Expo returns a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deliverNotificationPush({
        userId: "user_owner",
        title: "Agent needs input",
        body: "waiting",
        pushTokens: [token({ platform: "ios", token: "ExponentPushToken[owner-ios]" })],
      }),
    ).rejects.toThrow(/Expo push failed \(429\)/);
  });
});

describe("deliverSecurityAlert", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not push shared client security alerts to sharee tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverSecurityAlert({
      env: {} as any,
      userId: "user_owner",
      event: {
        id: "evt_1",
        kind: "shared_client_connected",
        title: "Shared chat participant connected",
        body: "Alex connected to claude-abc from SG.",
        createdAt: "2026-06-01T00:00:00.000Z",
        shareId: "share_123",
        sessionId: "claude-abc",
        actorUserId: "user_guest",
        actorName: "Alex",
      },
      pushTokens: [
        token({ userId: "user_owner", deviceId: "owner", token: "ExponentPushToken[owner]" }),
        token({ userId: "user_guest", deviceId: "guest", token: "ExponentPushToken[guest]" }),
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Array<{
      to: string;
      data: Record<string, string>;
    }>;
    expect(body.map((message) => message.to)).toEqual(["ExponentPushToken[owner]"]);
    expect(body[0]?.data).toMatchObject({
      category: "security",
      kind: "shared_client_connected",
      shareId: "share_123",
      sessionId: "claude-abc",
    });
  });

  it("emails shared client security alerts to the owner account", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.clerk.com/v1/users/user_owner") {
        return new Response(
          JSON.stringify({
            primary_email_address_id: "email_owner",
            email_addresses: [{ id: "email_owner", email_address: "owner@example.com" }],
          }),
          { status: 200 },
        );
      }
      if (url === "https://api.resend.com/emails") {
        const body = JSON.parse(init?.body as string) as { to: string[]; subject: string };
        expect(body).toMatchObject({
          to: ["owner@example.com"],
          subject: "Shared chat participant connected",
        });
        return new Response("{}", { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await deliverSecurityAlert({
      env: {
        CLERK_SECRET_KEY: "clerk_secret",
        RESEND_API_KEY: "resend_secret",
        SECURITY_EMAIL_FROM: "security@example.com",
      } as any,
      userId: "user_owner",
      event: {
        id: "evt_1",
        kind: "shared_client_connected",
        title: "Shared chat participant connected",
        body: "Alex connected to claude-abc from SG.",
        createdAt: "2026-06-01T00:00:00.000Z",
        shareId: "share_123",
        sessionId: "claude-abc",
        actorUserId: "user_guest",
        actorName: "Alex",
      },
      pushTokens: [],
    });

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toContain("https://api.clerk.com/v1/users/user_owner");
    expect(urls).toContain("https://api.resend.com/emails");
    expect(urls).not.toContain("https://api.clerk.com/v1/users/user_guest");
  });
});
