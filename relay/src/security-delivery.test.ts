import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverNotificationPush } from "./security-delivery";
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
