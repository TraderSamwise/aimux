import { describe, expect, it } from "vitest";
import { appendSecurityEvent, createShareSecurityEvent, emptySecurityState, recordClientConnection } from "./security";

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
});
