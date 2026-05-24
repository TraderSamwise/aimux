import { describe, expect, it } from "vitest";
import { createShareSecurityEvent, emptySecurityState, appendSecurityEvent } from "./security";

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
});
