import { describe, expect, it } from "vitest";
import {
  appendSecurityEvent,
  approveSecurityDevice,
  blockSecurityDevice,
  createShareSecurityEvent,
  emptySecurityState,
  isDeviceApproved,
  notificationPushTokensForDevicePolicy,
  recordClientConnection,
  unblockSecurityDevice,
} from "./security";

describe("relay security events", () => {
  it("builds share acceptance events with participant metadata", () => {
    const event = createShareSecurityEvent({
      kind: "shared_invite_accepted",
      shareId: "share_123",
      sessionId: "claude-abc",
      actor: {
        userId: "user_guest",
        displayName: "Alex",
        email: "alex@example.com",
      },
      now: "2026-05-24T00:00:00.000Z",
    });

    expect(event).toMatchObject({
      kind: "shared_invite_accepted",
      shareId: "share_123",
      sessionId: "claude-abc",
      actorUserId: "user_guest",
      actorName: "Alex",
      actorEmail: "alex@example.com",
      title: "Shared chat invite accepted",
      body: "Alex joined claude-abc.",
      createdAt: "2026-05-24T00:00:00.000Z",
    });
    expect(event.id).toBeTruthy();
  });

  it("keeps share security events in the durable security event feed", () => {
    const state = emptySecurityState();
    const event = createShareSecurityEvent({
      kind: "shared_participant_removed",
      shareId: "share_123",
      sessionId: "claude-abc",
      actor: { userId: "user_owner", displayName: "Sam" },
      target: { userId: "user_guest", displayName: "Alex", email: "alex@example.com" },
      now: "2026-05-24T00:00:00.000Z",
    });

    appendSecurityEvent(state, event);

    expect(state.events[0]).toMatchObject({
      kind: "shared_participant_removed",
      actorUserId: "user_owner",
      targetUserId: "user_guest",
      targetEmail: "alex@example.com",
      body: "Alex was removed from claude-abc by Sam.",
    });
  });

  it("builds distinct owner-facing events for shared participant clients", () => {
    const result = recordClientConnection(
      emptySecurityState(),
      { deviceId: "guest-browser", kind: "web", name: "Web browser" },
      {
        country: "SG",
        shared: {
          shareId: "share_123",
          sessionId: "claude-abc",
          actorUserId: "user_guest",
          actorName: "Alex",
          actorEmail: "alex@example.com",
        },
      },
      "2026-05-24T00:00:00.000Z",
    );

    expect(result.device.id).toBe("shared:share_123:user_guest:guest-browser");
    expect(result.events.map((event) => event.kind)).toEqual(["shared_client_connected"]);
    expect(result.events[0]).toMatchObject({
      kind: "shared_client_connected",
      shareId: "share_123",
      sessionId: "claude-abc",
      actorUserId: "user_guest",
      actorEmail: "alex@example.com",
      title: "Shared chat participant connected",
      body: "Alex connected to claude-abc from SG.",
    });
    expect(result.events[0]?.title).not.toBe("New remote client detected");
  });

  it("records repeat shared participant connections without normal client_connected noise", () => {
    const first = recordClientConnection(
      emptySecurityState(),
      { deviceId: "guest-browser", kind: "web", name: "Web browser" },
      {
        shared: {
          shareId: "share_123",
          sessionId: "claude-abc",
          actorUserId: "user_guest",
          actorName: "Alex",
        },
      },
      "2026-05-24T00:00:00.000Z",
    );
    const second = recordClientConnection(
      first.state,
      { deviceId: "guest-browser", kind: "web", name: "Web browser" },
      {
        shared: {
          shareId: "share_123",
          sessionId: "claude-abc",
          actorUserId: "user_guest",
          actorName: "Alex",
        },
      },
      "2026-05-24T00:05:00.000Z",
    );

    expect(second.firstSeen).toBe(false);
    expect(second.events.map((event) => event.kind)).toEqual(["shared_client_connected"]);
    expect(second.state.events[0]).toMatchObject({
      kind: "shared_client_connected",
      createdAt: "2026-05-24T00:05:00.000Z",
    });
  });

  it("approves and blocks owner remote devices", () => {
    const connected = recordClientConnection(
      emptySecurityState(),
      { deviceId: "client_123", kind: "ios", name: "iPhone" },
      { country: "SG" },
      "2026-05-24T00:00:00.000Z",
    );

    const approved = approveSecurityDevice(connected.state, "client_123", "2026-05-24T00:01:00.000Z");
    expect(approved.device).toMatchObject({
      id: "client_123",
      approvedAt: "2026-05-24T00:01:00.000Z",
      blockedAt: undefined,
    });
    expect(isDeviceApproved(approved.device ?? undefined)).toBe(true);
    expect(approved.event).toMatchObject({
      kind: "device_approved",
      deviceId: "client_123",
      title: "Remote device approved",
    });

    const blocked = blockSecurityDevice(approved.state, "client_123", "2026-05-24T00:02:00.000Z");
    expect(blocked.device).toMatchObject({
      id: "client_123",
      approvedAt: undefined,
      blockedAt: "2026-05-24T00:02:00.000Z",
    });
    expect(isDeviceApproved(blocked.device ?? undefined)).toBe(false);
    expect(blocked.event).toMatchObject({
      kind: "device_blocked",
      deviceId: "client_123",
      title: "Remote device blocked",
    });

    const unblocked = unblockSecurityDevice(blocked.state, "client_123");
    expect(unblocked.device).toMatchObject({
      id: "client_123",
      approvedAt: undefined,
      blockedAt: undefined,
    });
    expect(isDeviceApproved(unblocked.device ?? undefined)).toBe(false);
  });

  it("does not approve unknown devices", () => {
    const result = approveSecurityDevice(emptySecurityState(), "missing");

    expect(result.device).toBeNull();
    expect(result.event).toBeNull();
    expect(result.state.events).toEqual([]);
  });

  it("filters normal notification tokens to approved devices under enforce policy", () => {
    const connected = recordClientConnection(
      emptySecurityState(),
      { deviceId: "approved-device", kind: "ios", name: "iPhone" },
      {},
      "2026-05-24T00:00:00.000Z",
    );
    const withPending = recordClientConnection(
      connected.state,
      { deviceId: "pending-device", kind: "android", name: "Android" },
      {},
      "2026-05-24T00:01:00.000Z",
    );
    const approved = approveSecurityDevice(withPending.state, "approved-device", "2026-05-24T00:02:00.000Z");
    approved.state.pushTokens["user:approved-device"] = {
      userId: "user",
      deviceId: "approved-device",
      token: "approved-token",
      platform: "ios",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    };
    approved.state.pushTokens["user:pending-device"] = {
      userId: "user",
      deviceId: "pending-device",
      token: "pending-token",
      platform: "android",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    };

    expect(notificationPushTokensForDevicePolicy(approved.state, "warn").map((token) => token.token).sort()).toEqual([
      "approved-token",
      "pending-token",
    ]);
    expect(notificationPushTokensForDevicePolicy(approved.state, "enforce").map((token) => token.token)).toEqual([
      "approved-token",
    ]);
  });
});
