import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverNotificationPush, deliverSecurityAlert } from "./security-delivery";
import type { SecurityEventRecord, SecurityPushTokenRecord } from "./security";

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

function securityEvent(overrides: Partial<SecurityEventRecord> = {}): SecurityEventRecord {
  return {
    id: "evt_1",
    kind: "shared_client_connected",
    title: "Shared chat participant connected",
    body: "Alex connected to claude-abc from SG.",
    createdAt: "2026-06-01T00:00:00.000Z",
    shareId: "share_123",
    sessionId: "claude-abc",
    actorUserId: "user_guest",
    actorName: "Alex",
    ...overrides,
  };
}

function expoOk(count: number): Response {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: count }, () => ({ status: "ok" })),
    }),
    { status: 200 },
  );
}

describe("deliverNotificationPush", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pushes only to the owner's mobile tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(expoOk(2));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverNotificationPush({
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

    expect(result).toEqual({ sent: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Array<{
      to: string;
      priority?: string;
      sound?: string;
      interruptionLevel?: string;
      channelId?: string;
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
      interruptionLevel: "time-sensitive",
      data: { category: "agent", kind: "needs_input", sessionId: "claude-abc", projectRoot: "/repo" },
    });
    expect(android).toMatchObject({ priority: "high" });
    expect(android).toMatchObject({ channelId: "security" });
    expect(android).not.toHaveProperty("interruptionLevel");
    expect(android).not.toHaveProperty("sound");
  });

  it("does not call the push API when no owner mobile tokens exist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(expoOk(0));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverNotificationPush({
      userId: "user_owner",
      title: "Agent done",
      body: "finished",
      pushTokens: [token({ userId: "user_guest", platform: "ios" }), token({ platform: "web" })],
    });

    expect(result).toEqual({ sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips owner mobile tokens that muted agent alerts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(expoOk(1));
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

  it("throws when Expo accepts the request but rejects a push token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ status: "error", message: "DeviceNotRegistered" }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deliverNotificationPush({
        userId: "user_owner",
        title: "Agent needs input",
        body: "waiting",
        pushTokens: [token({ platform: "ios", token: "ExponentPushToken[stale]" })],
      }),
    ).rejects.toThrow(/Expo push rejected a token: DeviceNotRegistered/);
  });

  it("throws when Expo accepts the request but returns unreadable tickets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deliverNotificationPush({
        userId: "user_owner",
        title: "Agent needs input",
        body: "waiting",
        pushTokens: [token({ platform: "ios", token: "ExponentPushToken[owner-ios]" })],
      }),
    ).rejects.toThrow(/Expo push returned unreadable success response/);
  });

  it("throws when Expo accepts the request but omits ticket data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deliverNotificationPush({
        userId: "user_owner",
        title: "Agent needs input",
        body: "waiting",
        pushTokens: [token({ platform: "ios", token: "ExponentPushToken[owner-ios]" })],
      }),
    ).rejects.toThrow(/Expo push returned invalid success response: missing data tickets/);
  });
});

describe("deliverSecurityAlert", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not push shared client security alerts to sharee tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(expoOk(1));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverSecurityAlert({
      env: {} as any,
      userId: "user_owner",
      event: securityEvent(),
      pushTokens: [
        token({ userId: "user_owner", deviceId: "owner", token: "ExponentPushToken[owner]", platform: "android" }),
        token({ userId: "user_guest", deviceId: "guest", token: "ExponentPushToken[guest]" }),
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Array<{
      to: string;
      channelId?: string;
      data: Record<string, string>;
    }>;
    expect(body.map((message) => message.to)).toEqual(["ExponentPushToken[owner]"]);
    expect(body[0]?.channelId).toBe("security");
    expect(body[0]?.data).toMatchObject({
      category: "security",
      kind: "shared_client_connected",
      shareId: "share_123",
      sessionId: "claude-abc",
    });
    expect(result).toMatchObject({
      delivered: true,
      channels: [
        { channel: "email", status: "skipped", sent: 0, reason: "security email not configured" },
        { channel: "push", status: "delivered", sent: 1 },
      ],
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

    const result = await deliverSecurityAlert({
      env: {
        CLERK_SECRET_KEY: "clerk_secret",
        RESEND_API_KEY: "resend_secret",
        SECURITY_EMAIL_FROM: "security@example.com",
      } as any,
      userId: "user_owner",
      event: securityEvent(),
      pushTokens: [],
    });

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toContain("https://api.clerk.com/v1/users/user_owner");
    expect(urls).toContain("https://api.resend.com/emails");
    expect(urls).not.toContain("https://api.clerk.com/v1/users/user_guest");
    expect(result).toMatchObject({
      delivered: true,
      channels: [
        { channel: "email", status: "delivered", sent: 1 },
        { channel: "push", status: "skipped", sent: 0, reason: "no eligible push tokens" },
      ],
    });
  });

  it("reports degraded delivery when email fails but push succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string) => {
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
        return new Response("rate limited", { status: 429 });
      }
      if (url === "https://exp.host/--/api/v2/push/send") {
        return expoOk(1);
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverSecurityAlert({
      env: {
        CLERK_SECRET_KEY: "clerk_secret",
        RESEND_API_KEY: "resend_secret",
        SECURITY_EMAIL_FROM: "security@example.com",
      } as any,
      userId: "user_owner",
      event: securityEvent(),
      pushTokens: [token({ userId: "user_owner", deviceId: "owner", token: "ExponentPushToken[owner]" })],
    });

    expect(result.delivered).toBe(true);
    expect(result.channels).toMatchObject([
      { channel: "email", status: "failed", reason: expect.stringContaining("Resend email failed (429)") },
      { channel: "push", status: "delivered", sent: 1 },
    ]);
    expect(warn).toHaveBeenCalledWith("security alert delivery degraded", expect.stringContaining("email=failed"));
    expect(error).not.toHaveBeenCalled();
  });

  it("reports total delivery failure visibly when every attempted channel fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string) => {
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
        return new Response("invalid key", { status: 401 });
      }
      if (url === "https://exp.host/--/api/v2/push/send") {
        return new Response("rate limited", { status: 429 });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverSecurityAlert({
      env: {
        CLERK_SECRET_KEY: "clerk_secret",
        RESEND_API_KEY: "resend_secret",
        SECURITY_EMAIL_FROM: "security@example.com",
      } as any,
      userId: "user_owner",
      event: securityEvent(),
      pushTokens: [token({ userId: "user_owner", deviceId: "owner", token: "ExponentPushToken[owner]" })],
    });

    expect(result.delivered).toBe(false);
    expect(result.channels).toMatchObject([
      { channel: "email", status: "failed", reason: expect.stringContaining("Resend email failed (401)") },
      { channel: "push", status: "failed", reason: expect.stringContaining("Expo push failed (429)") },
    ]);
    expect(error).toHaveBeenCalledWith(
      "security alert delivery failed: no channel delivered",
      expect.stringContaining("push=failed"),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports total delivery failure when no channel is configured or eligible", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(expoOk(0));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverSecurityAlert({
      env: {} as any,
      userId: "user_owner",
      event: securityEvent(),
      pushTokens: [],
    });

    expect(result).toMatchObject({
      delivered: false,
      channels: [
        { channel: "email", status: "skipped", reason: "security email not configured" },
        { channel: "push", status: "skipped", reason: "no eligible push tokens" },
      ],
    });
    expect(error).toHaveBeenCalledWith(
      "security alert delivery failed: no channel delivered",
      expect.stringContaining("email=skipped"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
