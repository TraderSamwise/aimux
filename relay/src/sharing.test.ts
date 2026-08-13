import { describe, expect, it } from "vitest";
import {
  acceptShareInvite,
  actorDisplayPrefix,
  createShareInvite,
  emptySharingState,
  getShareChatMode,
  isSharedRelayRequestAllowed,
  listAcceptedShares,
  removeAcceptedShare,
  removeShareParticipant,
  revokeShareInvite,
  sharedRelayRequestAccess,
  stripTrustedAimuxHeaders,
  summarizeShare,
  upsertAcceptedShare,
} from "./sharing";

const owner = {
  userId: "user_owner",
  displayName: "Sam",
  email: "sam@example.com",
  role: "owner" as const,
};
const activeInviteCreatedAt = "2099-05-24T00:00:00.000Z";
const activeInviteAcceptedAt = "2099-05-24T00:01:00.000Z";

describe("sharing state", () => {
  it("creates hashed invites and enters multi mode after acceptance", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      serviceEndpoint: { host: "127.0.0.1", port: 43192 },
      sessionId: "claude-abc",
      email: "ALEX@EXAMPLE.COM",
      now: activeInviteCreatedAt,
    });

    const share = Object.values(created.state.shares)[0];
    const invite = Object.values(share.invites)[0];
    expect(share.serviceEndpoint).toEqual({ host: "127.0.0.1", port: 43192 });
    expect(invite.email).toBe("alex@example.com");
    expect(invite.tokenHash).not.toBe(created.token.token);
    expect(getShareChatMode(share)).toBe("single");

    const accepted = await acceptShareInvite(created.state, {
      token: created.token.token,
      actor: {
        userId: "user_guest",
        displayName: "Alex",
        email: "alex@example.com",
        role: "guest",
      },
      now: activeInviteAcceptedAt,
    });

    expect(accepted.participant.email).toBe("alex@example.com");
    expect(getShareChatMode(accepted.share)).toBe("multi");
    expect(Object.values(accepted.share.invites)[0].status).toBe("accepted");
  });

  it("indexes accepted shares outside the owner durable object", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      serviceEndpoint: { host: "127.0.0.1", port: 43192 },
      sessionId: "claude-abc",
      email: "alex@example.com",
      now: activeInviteCreatedAt,
    });
    const accepted = await acceptShareInvite(created.state, {
      token: created.token.token,
      actor: {
        userId: "user_guest",
        displayName: "Alex",
        email: "alex@example.com",
        role: "guest",
      },
      now: activeInviteAcceptedAt,
    });
    const indexed = upsertAcceptedShare(emptySharingState(), summarizeShare(accepted.share));

    expect(listAcceptedShares(indexed)).toHaveLength(1);
    expect(listAcceptedShares(indexed)[0]).toMatchObject({
      id: accepted.share.id,
      ownerUserId: "user_owner",
      serviceEndpoint: { host: "127.0.0.1", port: 43192 },
      sessionId: "claude-abc",
    });

    const removed = removeAcceptedShare(indexed, "user_owner", accepted.share.id);
    expect(listAcceptedShares(removed)).toEqual([]);
  });

  it("rejects accepting an invite for a different authenticated email", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      sessionId: "claude-abc",
      email: "alex@example.com",
    });

    await expect(
      acceptShareInvite(created.state, {
        token: created.token.token,
        actor: {
          userId: "user_other",
          displayName: "Mallory",
          email: "mallory@example.com",
          role: "guest",
        },
      }),
    ).rejects.toThrow("Invite email does not match authenticated user");
  });

  it("rejects accepting a guest invite as the owner", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      sessionId: "claude-abc",
      email: "sam@example.com",
    });

    await expect(
      acceptShareInvite(created.state, {
        token: created.token.token,
        actor: owner,
      }),
    ).rejects.toThrow("Owner cannot accept a guest invite");
  });

  it("rejects expired invites", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      sessionId: "claude-abc",
      email: "alex@example.com",
    });
    const share = Object.values(created.state.shares)[0];
    const invite = Object.values(share.invites)[0];
    invite.expiresAt = "2020-01-01T00:00:00.000Z";

    await expect(
      acceptShareInvite(created.state, {
        token: created.token.token,
        actor: {
          userId: "user_guest",
          displayName: "Alex",
          email: "alex@example.com",
          role: "guest",
        },
      }),
    ).rejects.toThrow("Invite is invalid, expired, or already used");
  });

  it("downgrades back to single mode when a guest is removed", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      sessionId: "claude-abc",
      email: "alex@example.com",
    });
    const accepted = await acceptShareInvite(created.state, {
      token: created.token.token,
      actor: {
        userId: "user_guest",
        displayName: "Alex",
        email: "alex@example.com",
        role: "guest",
      },
    });

    const removed = removeShareParticipant(accepted.state, accepted.share.id, "user_guest");

    expect(removed.share).toBeDefined();
    expect(getShareChatMode(removed.share!)).toBe("single");
    expect(removed.share!.participants.user_guest.status).toBe("removed");
  });

  it("allows only chat-scoped relay routes for guests", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      sessionId: "claude-abc",
      email: "alex@example.com",
    });
    const share = Object.values(created.state.shares)[0];

    expect(
      isSharedRelayRequestAllowed({ method: "GET", path: "/agents/history", sessionId: "claude-abc" }, share),
    ).toBe(true);
    expect(
      isSharedRelayRequestAllowed({ method: "GET", path: "/live-pane/output", sessionId: "claude-abc" }, share),
    ).toBe(true);
    expect(
      isSharedRelayRequestAllowed({ method: "POST", path: "/live-pane/input", sessionId: "claude-abc" }, share),
    ).toBe(true);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/events", sessionId: "claude-abc" }, share)).toBe(true);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/agents/history" }, share)).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/agents/input", sessionId: "claude-abc" }, share)).toBe(
      false,
    );
    expect(
      isSharedRelayRequestAllowed({ method: "GET", path: "/attachments/file.png", sessionId: "claude-abc" }, share),
    ).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/attachments-private/file.png" }, share)).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/attachments/../agents/input" }, share)).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/attachments/%2e%2e/agents/input" }, share)).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/agents/kill", sessionId: "claude-abc" }, share)).toBe(
      false,
    );
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/live-pane/input", sessionId: "other" }, share)).toBe(
      false,
    );
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/agents/input", sessionId: "other" }, share)).toBe(
      false,
    );
  });

  it("unwraps proxied project routes before shared-route authorization", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      sessionId: "claude-abc",
      email: "alex@example.com",
    });
    const share = Object.values(created.state.shares)[0];

    expect(
      sharedRelayRequestAccess(
        { method: "GET", path: "/proxy/127.0.0.1/43192/agents/history?sessionId=claude-abc" },
        share,
      ),
    ).toMatchObject({ allowed: true, path: "/agents/history?sessionId=claude-abc", sessionId: "claude-abc" });
    expect(
      sharedRelayRequestAccess(
        { method: "POST", path: "/proxy/127.0.0.1/43192/live-pane/input", body: { sessionId: "claude-abc" } },
        share,
      ),
    ).toMatchObject({ allowed: true, path: "/live-pane/input", sessionId: "claude-abc" });
    expect(
      sharedRelayRequestAccess(
        { method: "POST", path: "/proxy/127.0.0.1/43192/agents/input", body: { sessionId: "other" } },
        share,
      ),
    ).toMatchObject({ allowed: false, path: "/agents/input", sessionId: "other" });
  });

  it("sanitizes actor display prefixes", () => {
    expect(actorDisplayPrefix({ userId: "u", displayName: "  Sam   Teady  ", role: "owner" })).toBe("[Sam Teady]:");
    expect(actorDisplayPrefix({ userId: "u", displayName: "", role: "guest" })).toBe("[User]:");
  });

  it("strips client-provided trusted relay headers before injection", () => {
    expect(
      stripTrustedAimuxHeaders({
        "content-type": "application/json",
        "x-aimux-actor-name": "Mallory",
        "X-Aimux-Share-Mode": "multi",
      }),
    ).toEqual({ "content-type": "application/json" });
  });

  it("revokes pending invites without exposing token hashes", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      sessionId: "claude-abc",
      email: "alex@example.com",
      now: activeInviteCreatedAt,
    });
    const share = Object.values(created.state.shares)[0];
    const invite = Object.values(share.invites)[0];

    const revoked = revokeShareInvite(created.state, share.id, invite.id, "2099-05-24T00:02:00.000Z");

    expect(revoked.invite).toMatchObject({
      id: invite.id,
      status: "revoked",
      revokedAt: "2099-05-24T00:02:00.000Z",
    });
    const summary = summarizeShare(revoked.share!);
    expect(summary.invites[0]).toMatchObject({ id: invite.id, status: "revoked" });
    expect(summary.invites[0]).not.toHaveProperty("tokenHash");
  });

  it("redacts invite token hashes from public summaries", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      sessionId: "claude-abc",
      email: "alex@example.com",
    });
    const summary = summarizeShare(Object.values(created.state.shares)[0]);

    expect(summary.invites[0]).toMatchObject({ email: "alex@example.com", status: "pending" });
    expect(summary.invites[0]).not.toHaveProperty("tokenHash");
    expect(summary.serviceEndpoint).toBeUndefined();
  });

  it("normalizes persisted service endpoints when reusing shares", async () => {
    const created = await createShareInvite(
      {
        version: 1,
        shares: {
          share_existing: {
            id: "share_existing",
            ownerUserId: owner.userId,
            projectRoot: "/Users/sam/cs/example",
            serviceEndpoint: { host: "", port: 99999 },
            sessionId: "claude-abc",
            createdAt: "2026-05-24T00:00:00.000Z",
            updatedAt: "2026-05-24T00:00:00.000Z",
            version: 1,
            participants: {
              [owner.userId]: {
                ...owner,
                status: "active",
                joinedAt: "2026-05-24T00:00:00.000Z",
                lastSeenAt: "2026-05-24T00:00:00.000Z",
              },
            },
            invites: {},
          },
        },
      },
      {
        owner,
        projectRoot: "/Users/sam/cs/example",
        sessionId: "claude-abc",
        email: "alex@example.com",
      },
    );

    expect(Object.values(created.state.shares)[0].serviceEndpoint).toBeUndefined();
  });
});
