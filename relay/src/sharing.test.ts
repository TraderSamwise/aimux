import { describe, expect, it } from "vitest";
import {
  acceptShareInvite,
  actorDisplayPrefix,
  createShareInvite,
  emptySharingState,
  bindShareToMachine,
  findShareForSession,
  getShareChatMode,
  isSharedRelayRequestAllowed,
  listAcceptedShares,
  removeAcceptedShare,
  removeShareParticipant,
  revokeShareInvite,
  sharedRelayRequestAccess,
  stripTrustedAimuxHeaders,
  normalizeSharingState,
  summarizeShare,
  machinesHostingShare,
  nextShareRefreshBatch,
  rememberMachineProjectRoots,
  updateShareServiceEndpoints,
  upsertAcceptedShare,
  type ShareActor,
  type SharedSessionRecord,
  type SharingState,
} from "./sharing";
import { resolveSharedDaemonTarget } from "./machines";

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
      machineId: undefined,
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
      machineId: undefined,
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
      machineId: undefined,
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
      machineId: undefined,
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
      machineId: undefined,
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
      machineId: undefined,
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
      machineId: undefined,
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
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/attachments", sessionId: "claude-abc" }, share)).toBe(
      true,
    );
    // Answering the agent's own chooser. Same authority as typing the option's
    // number into the composer, so withholding it would only make the guest
    // reach for the worse route.
    expect(
      isSharedRelayRequestAllowed({ method: "POST", path: "/live-pane/select", sessionId: "claude-abc" }, share),
    ).toBe(true);
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/live-pane/select", sessionId: "other" }, share)).toBe(
      false,
    );
    expect(
      isSharedRelayRequestAllowed(
        { method: "GET", path: "/attachments/att_abc/content", sessionId: "claude-abc" },
        share,
      ),
    ).toBe(true);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/events", sessionId: "claude-abc" }, share)).toBe(true);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/agents/history" }, share)).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/agents/input", sessionId: "claude-abc" }, share)).toBe(
      false,
    );
    expect(
      isSharedRelayRequestAllowed({ method: "GET", path: "/attachments/file.png", sessionId: "claude-abc" }, share),
    ).toBe(false);
    expect(
      isSharedRelayRequestAllowed({ method: "GET", path: "/attachments/att_abc", sessionId: "claude-abc" }, share),
    ).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/attachments-private/file.png" }, share)).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/attachments/../agents/input" }, share)).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/attachments/%2e%2e/agents/input" }, share)).toBe(false);
    // Sharing is full trust over the shared session, so killing it is a
    // guest's to do. This assertion used to read `false`, and it was changed
    // deliberately rather than relaxed by accident: the limit is the session,
    // not the verb.
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/agents/kill", sessionId: "claude-abc" }, share)).toBe(
      true,
    );
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/live-pane/input", sessionId: "other" }, share)).toBe(
      false,
    );
    expect(isSharedRelayRequestAllowed({ method: "POST", path: "/agents/input", sessionId: "other" }, share)).toBe(
      false,
    );
  });

  it("gives a guest the session, and only ever that session", async () => {
    // The point of widening the verbs: every one of them still has to name
    // the shared session. A route list that grew without this test would be a
    // guest able to kill any agent in the owner's project.
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      machineId: undefined,
      sessionId: "claude-abc",
      email: "alex@example.com",
    });
    const share = Object.values(created.state.shares)[0];

    const writes = [
      "/live-pane/interrupt",
      "/agents/interrupt",
      "/agents/stop",
      "/agents/resume",
      "/agents/kill",
      "/agents/fork",
    ];
    for (const path of writes) {
      expect(isSharedRelayRequestAllowed({ method: "POST", path, sessionId: "claude-abc" }, share), path).toBe(true);
      expect(isSharedRelayRequestAllowed({ method: "POST", path, sessionId: "claude-other" }, share), path).toBe(false);
      // No session named at all is the case a body-less POST produces, and it
      // must not inherit the share's session by default.
      expect(isSharedRelayRequestAllowed({ method: "POST", path }, share), path).toBe(false);
    }

    // Administering the share stays the owner's, and has no guest route.
    for (const path of ["/agents/spawn", "/agents/rename", "/worktrees/create", "/services/stop"]) {
      expect(isSharedRelayRequestAllowed({ method: "POST", path, sessionId: "claude-abc" }, share), path).toBe(false);
    }

    // The plan names its session in the path, so it is checked there.
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/plans/claude-abc" }, share)).toBe(true);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/plans/claude-other" }, share)).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/plans" }, share)).toBe(false);
    expect(isSharedRelayRequestAllowed({ method: "GET", path: "/plans/claude-abc/extra" }, share)).toBe(false);

    expect(
      isSharedRelayRequestAllowed({ method: "GET", path: "/agents/output/stream", sessionId: "claude-abc" }, share),
    ).toBe(true);
    expect(
      isSharedRelayRequestAllowed({ method: "GET", path: "/agents/output/stream", sessionId: "other" }, share),
    ).toBe(false);
  });

  it("unwraps proxied project routes before shared-route authorization", async () => {
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/Users/sam/cs/example",
      machineId: undefined,
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
        { method: "POST", path: "/proxy/127.0.0.1/43192/attachments", body: { sessionId: "claude-abc" } },
        share,
      ),
    ).toMatchObject({ allowed: true, path: "/attachments", sessionId: "claude-abc" });
    expect(
      sharedRelayRequestAccess(
        { method: "GET", path: "/proxy/127.0.0.1/43192/attachments/att_abc/content?sessionId=claude-abc" },
        share,
      ),
    ).toMatchObject({
      allowed: true,
      path: "/attachments/att_abc/content?sessionId=claude-abc",
      sessionId: "claude-abc",
    });
    expect(
      sharedRelayRequestAccess(
        {
          method: "POST",
          path: "/proxy/127.0.0.1/43192/attachments?sessionId=other",
          body: { sessionId: "claude-abc" },
        },
        share,
      ),
    ).toMatchObject({ allowed: false, path: "/attachments?sessionId=other", sessionId: undefined });
    expect(
      sharedRelayRequestAccess(
        { method: "POST", path: "/proxy/127.0.0.1/43192/agents/input", body: { sessionId: "other" } },
        share,
      ),
    ).toMatchObject({ allowed: false, path: "/agents/input", sessionId: "other" });
  });

  it("sanitizes actor display prefixes", () => {
    expect(actorDisplayPrefix({ userId: "u", displayName: "  Sam   Teady  ", role: "owner" })).toBe("[Sam Teady]");
    expect(actorDisplayPrefix({ userId: "u", displayName: "", role: "guest" })).toBe("[User]");
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
      machineId: undefined,
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
      machineId: undefined,
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
            machineId: undefined,
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
        machineId: undefined,
        sessionId: "claude-abc",
        email: "alex@example.com",
      },
    );

    expect(Object.values(created.state.shares)[0].serviceEndpoint).toBeUndefined();
  });
});

describe("which share a new invite extends", () => {
  const owner: ShareActor = { userId: "user_owner", displayName: "Sam", role: "owner" };

  async function invite(
    state: Parameters<typeof createShareInvite>[0],
    machineId?: string,
    projectRoot = "/repo/aimux",
  ) {
    return createShareInvite(state, {
      owner,
      projectRoot,
      sessionId: "claude-1",
      email: "guest@example.com",
      machineId,
    });
  }

  // A session id names a session on one host, so an invite for strix's
  // `claude-1` must not rebind the guests of the mbp's share of that name.
  it("keeps two machines' shares of one session id apart", async () => {
    const first = await invite(emptySharingState(), "mbp");
    const second = await invite(first.state, "strix");

    expect(second.token.share.id).not.toBe(first.token.share.id);
    expect(Object.keys(second.state.shares)).toHaveLength(2);
  });

  it("extends the same share when the machine is the same", async () => {
    const first = await invite(emptySharingState(), "mbp");
    const second = await invite(first.state, "mbp");

    expect(second.token.share.id).toBe(first.token.share.id);
    expect(Object.keys(second.state.shares)).toHaveLength(1);
  });

  // A share made before machines existed is the same share. Creating a second
  // one would leave its guests on a record nothing routes any more.
  it("adopts a share that names no machine rather than duplicating it", async () => {
    const legacy = await invite(emptySharingState(), undefined);
    const bound = await invite(legacy.state, "mbp");

    expect(bound.token.share.id).toBe(legacy.token.share.id);
    expect(bound.token.share.machineId).toBe("mbp");
    expect(Object.keys(bound.state.shares)).toHaveLength(1);
  });

  // "Unbound" says nothing about which host made it, so adopting on the
  // session id alone let strix's first invite take over the mbp's legacy share
  // and rebind its guests to strix -- while `projectRoot` went on naming the
  // mbp's checkout. The checkout is the evidence that it is the same share.
  it("does not adopt an unbound share of a different checkout", async () => {
    const legacy = await invite(emptySharingState(), undefined, "/Users/sam/cs/aimux");
    const other = await invite(legacy.state, "strix", "/home/sam/aimux");

    expect(other.token.share.id).not.toBe(legacy.token.share.id);
    expect(other.token.share.projectRoot).toBe("/home/sam/aimux");
    expect(Object.values(legacy.state.shares)[0].machineId).toBeUndefined();
    expect(Object.keys(other.state.shares)).toHaveLength(2);
  });

  // Adoption of an unbound share requires the root to match, so a root left
  // behind by a moved checkout would make the next invite build a second share
  // and strand the first one's guests.
  it("follows the checkout the invite came from", async () => {
    const first = await invite(emptySharingState(), "mbp", "/Users/sam/cs/aimux");
    const moved = await invite(first.state, "mbp", "/Users/sam/code/aimux");

    expect(moved.token.share.id).toBe(first.token.share.id);
    expect(moved.token.share.projectRoot).toBe("/Users/sam/code/aimux");
    expect(Object.keys(moved.state.shares)).toHaveLength(1);
  });

  // An invite that cannot say which machine it came from used to adopt an
  // unbound share of ANY checkout, and `createShareInvite` then rewrote that
  // share's `projectRoot` -- which moved the guests already on it into a
  // project nobody had shared with them, and left the share they accepted
  // unreachable.
  it("does not move a share's guests into another checkout", async () => {
    const first = await invite(emptySharingState(), undefined, "/repo/a");
    const accepted = await acceptShareInvite(first.state, {
      token: first.token.token,
      actor: { userId: "user_guest", displayName: "Guest", email: "guest@example.com", role: "guest" },
    });

    const second = await invite(accepted.state, undefined, "/repo/b");

    expect(second.token.share.id).not.toBe(first.token.share.id);
    expect(Object.keys(second.state.shares)).toHaveLength(2);
    const held = second.state.shares[first.token.share.id];
    expect(held.projectRoot, "the accepted share keeps its own checkout").toBe("/repo/a");
    expect(held.participants.user_guest?.status).toBe("active");
  });

  it("adopts neither when two unbound shares could be the one", () => {
    const unbound = (id: string): SharedSessionRecord => ({
      id,
      ownerUserId: owner.userId,
      projectRoot: "/repo/aimux",
      sessionId: "claude-1",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      version: 1,
      invites: {},
      participants: {},
    });
    const state: SharingState = {
      ...emptySharingState(),
      shares: { a: unbound("a"), b: unbound("b") },
    };

    expect(findShareForSession(state, owner.userId, "claude-1", "strix", "/repo/aimux")).toBeUndefined();
  });
});

describe("binding a share that already exists", () => {
  const owner: ShareActor = { userId: "user_owner", displayName: "Sam", role: "owner" };

  async function invite(
    state: Parameters<typeof createShareInvite>[0],
    machineId?: string,
    projectRoot = "/repo/aimux",
    sessionId = "claude-1",
  ) {
    return createShareInvite(state, {
      owner,
      projectRoot,
      sessionId,
      email: "guest@example.com",
      machineId,
    });
  }

  /// The endpoint report is the evidence a machine holds a checkout, and it
  /// is what the routing already narrows on.
  function reporting(state: SharingState, machines: Record<string, string[]>): SharingState {
    return Object.entries(machines).reduce(
      (carried, [machineId, roots]) => rememberMachineProjectRoots(carried, machineId, roots),
      state,
    );
  }

  // The case the whole phase exists for: a share made before a share recorded
  // its host, with its guest already accepted, repaired without a new token
  // and a second email.
  it("points a share that names no machine at the host that has it", async () => {
    const legacy = await invite(emptySharingState(), undefined);
    const accepted = await acceptShareInvite(legacy.state, {
      token: legacy.token.token,
      actor: { userId: "user_guest", displayName: "Guest", email: "guest@example.com", role: "guest" },
    });
    const shareId = legacy.token.share.id;

    const bound = bindShareToMachine(reporting(accepted.state, { mbp: ["/repo/aimux"] }), {
      owner,
      shareId,
      machineId: "mbp",
    });

    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.alreadyBound).toBe(false);
    expect(bound.share.id).toBe(shareId);
    expect(bound.share.machineId).toBe("mbp");
    // The guest it already has is still on it: a repair, not a new share.
    expect(Object.keys(bound.state.shares)).toHaveLength(1);
    expect(bound.share.participants.user_guest?.status).toBe("active");
  });

  // What the guest's 503 actually was. Two Macs with the same checkout both
  // claim an unbound share, so the route refuses a host that is sitting
  // right there -- until the share names one.
  it("is what makes the route pick a host while a second machine claims the checkout", async () => {
    const legacy = await invite(emptySharingState(), undefined);
    const share = Object.values(legacy.state.shares)[0];
    const claimed = reporting(legacy.state, {
      mbp: ["/repo/aimux"],
      strix: ["/repo/aimux"],
    });
    const online = [
      { id: "mbp", name: "mbp" },
      { id: "strix", name: "strix" },
    ];

    const before = resolveSharedDaemonTarget(machinesHostingShare(claimed, share, online), share.machineId);
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.refusal).toBe("share-names-no-machine");

    const bound = bindShareToMachine(claimed, { owner, shareId: share.id, machineId: "mbp" });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const after = resolveSharedDaemonTarget(
      machinesHostingShare(bound.state, bound.share, online),
      bound.share.machineId,
    );
    expect(after).toEqual({ ok: true, machineId: "mbp" });
  });

  it("writes nothing when the share already names that machine", async () => {
    const first = await invite(emptySharingState(), "mbp");
    const again = bindShareToMachine(reporting(first.state, { mbp: ["/repo/aimux"] }), {
      owner,
      shareId: first.token.share.id,
      machineId: "mbp",
    });

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyBound).toBe(true);
    // A repeated bind that bumped the version would hand every guest a
    // refresh of a record that did not change.
    expect(again.share.version).toBe(first.token.share.version);
    expect(again.share.updatedAt).toBe(first.token.share.updatedAt);
  });

  // There is no unbind route and a re-invite builds a SECOND share, so
  // refusing to move would make one wrong press permanent -- on a share
  // whose guests go on being refused for as long as it stands.
  it("moves a share that was pointed at the wrong machine", async () => {
    const first = await invite(emptySharingState(), "strix");
    const corrected = bindShareToMachine(reporting(first.state, { mbp: ["/repo/aimux"], strix: ["/repo/aimux"] }), {
      owner,
      shareId: first.token.share.id,
      machineId: "mbp",
    });

    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.alreadyBound).toBe(false);
    expect(corrected.share.machineId).toBe("mbp");
    expect(Object.keys(corrected.state.shares)).toHaveLength(1);
  });

  // And this is what makes moving safe rather than a free hand. Nothing else
  // says the target has the project, let alone the session, so without it one
  // press from the wrong machine could hand accepted guests a different
  // agent's transcript -- worse than the refusal it replaced.
  it("will not point a share at a machine that has not reported its checkout", async () => {
    const first = await invite(emptySharingState(), "mbp");
    const elsewhere = reporting(first.state, {
      mbp: ["/repo/aimux"],
      strix: ["/repo/something-else"],
    });

    expect(
      bindShareToMachine(elsewhere, {
        owner,
        shareId: first.token.share.id,
        machineId: "strix",
      }),
    ).toEqual({ ok: false, refusal: "machine-does-not-hold-checkout" });
    expect(Object.values(elsewhere.shares)[0].machineId).toBe("mbp");
  });

  // A checkout that was renamed or moved leaves the stored root behind, and
  // the machine reports the new one -- so checking the stored root would
  // refuse the repair for ever, on exactly the share that needs it. The
  // caller says which checkout it is looking at, as an invite does.
  it("re-points a share whose checkout was renamed", async () => {
    const first = await invite(emptySharingState(), undefined, "/repo/old-name");
    const renamed = reporting(first.state, { mbp: ["/repo/new-name"] });

    const bound = bindShareToMachine(renamed, {
      owner,
      shareId: first.token.share.id,
      machineId: "mbp",
      projectRoot: "/repo/new-name",
    });

    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.share.machineId).toBe("mbp");
    expect(bound.share.projectRoot).toBe("/repo/new-name");
    expect(Object.keys(bound.state.shares), "still one share").toHaveLength(1);
  });

  // And the caller's checkout is still checked against the report, so a
  // rename is not a way to point a share anywhere at all.
  it("refuses a checkout the machine has not reported either", async () => {
    const first = await invite(emptySharingState(), undefined, "/repo/old-name");
    const renamed = reporting(first.state, { mbp: ["/repo/new-name"] });

    expect(
      bindShareToMachine(renamed, {
        owner,
        shareId: first.token.share.id,
        machineId: "mbp",
        projectRoot: "/repo/somewhere-else",
      }),
    ).toEqual({ ok: false, refusal: "machine-does-not-hold-checkout" });
    expect(Object.values(renamed.shares)[0].projectRoot).toBe("/repo/old-name");
  });

  // Nothing reported at all is nothing to check against -- an older daemon,
  // or a relay that has just restarted. Refusing every bind then would leave
  // the repair unavailable exactly when the routing is least sure.
  it("allows a bind when no machine has reported anything yet", async () => {
    const legacy = await invite(emptySharingState(), undefined);

    const bound = bindShareToMachine(legacy.state, {
      owner,
      shareId: legacy.token.share.id,
      machineId: "mbp",
    });

    expect(bound.ok).toBe(true);
  });

  it("refuses a share id that is not the caller's", async () => {
    const legacy = await invite(emptySharingState(), undefined);
    const reported = reporting(legacy.state, { theirs: ["/repo/aimux"] });

    expect(
      bindShareToMachine(reported, {
        owner: { userId: "user_someone_else", displayName: "Someone", role: "owner" },
        shareId: legacy.token.share.id,
        machineId: "theirs",
      }),
    ).toEqual({ ok: false, refusal: "no-such-share" });
    expect(Object.values(reported.shares)[0].machineId).toBeUndefined();
  });

  it("refuses a share id nothing holds", async () => {
    const legacy = await invite(emptySharingState(), undefined);

    expect(
      bindShareToMachine(reporting(legacy.state, { mbp: ["/repo/aimux"] }), {
        owner,
        shareId: "share_does_not_exist",
        machineId: "mbp",
      }),
    ).toEqual({ ok: false, refusal: "no-such-share" });
  });

  it("refuses a machine id it cannot use rather than reporting a bind", async () => {
    const legacy = await invite(emptySharingState(), undefined);

    expect(() =>
      bindShareToMachine(legacy.state, {
        owner,
        shareId: legacy.token.share.id,
        machineId: "   ",
      }),
    ).toThrow(/machineId is required/);
  });

  it("says whether a summary's share has a host, and never which", async () => {
    const legacy = await invite(emptySharingState(), undefined);
    expect(summarizeShare(Object.values(legacy.state.shares)[0]).hostBound).toBe(false);

    const bound = bindShareToMachine(legacy.state, {
      owner,
      shareId: legacy.token.share.id,
      machineId: "mbp",
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const summary = summarizeShare(bound.share);
    expect(summary.hostBound).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("mbp");
  });

  // Rebuilt field by field, so a field not named there is dropped and the
  // guest's stored copy goes on saying nothing about its host for ever.
  it("keeps hostBound on a stored copy", async () => {
    const legacy = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: "/repo/aimux",
      sessionId: "claude-1",
      email: "guest@example.com",
      machineId: undefined,
      serviceEndpoint: { host: "127.0.0.1", port: 4311 },
    });
    const stored = upsertAcceptedShare(emptySharingState(), summarizeShare(Object.values(legacy.state.shares)[0]));

    expect(listAcceptedShares(stored)[0].hostBound).toBe(false);
  });
});

describe("routing a share that names no host", () => {
  // Such a share used to route only while exactly ONE machine was connected,
  // so starting a second daemon anywhere killed it -- with an error saying
  // the machine hosting it was not connected, while that machine was sitting
  // right there reporting for duty. Sam's own shared chat is one of these:
  // the record carries no machineId at all.
  const machines = [{ id: "mini" }, { id: "mbp2" }];
  const share = { machineId: undefined, projectRoot: "/Users/sam/cs/tealstreet-next" };

  function stateWithRoots(roots: Record<string, string[]>): SharingState {
    let state = emptySharingState();
    for (const [machineId, list] of Object.entries(roots)) {
      state = rememberMachineProjectRoots(state, machineId, list);
    }
    return state;
  }

  it("routes to the machine that reports the checkout, not to the only one connected", () => {
    const state = stateWithRoots({
      mini: ["/Users/sam/cs/tealstreet-next", "/Users/sam/cs/aimux"],
      mbp2: ["/Users/sam/cs/something-else"],
    });

    expect(machinesHostingShare(state, share, machines)).toEqual([{ id: "mini" }]);
  });

  it("leaves a share that names a host entirely alone", () => {
    const state = stateWithRoots({ mbp2: ["/Users/sam/cs/tealstreet-next"] });
    const bound = { machineId: "mini", projectRoot: "/Users/sam/cs/tealstreet-next" };

    // Not second-guessed by a report: a bound share is that host's, and the
    // routing rule refuses it when that host is away rather than silently
    // sending the guest somewhere else.
    expect(machinesHostingShare(state, bound, machines)).toEqual(machines);
  });

  it("says what it said before when nothing has reported yet", () => {
    // An older daemon, or a relay that has just restarted. This may only ever
    // narrow the previous answer, never invent a refusal out of an absence.
    expect(machinesHostingShare(emptySharingState(), share, machines)).toEqual(machines);
    const elsewhere = stateWithRoots({ mbp2: ["/Users/sam/cs/nothing-to-do-with-it"] });
    expect(machinesHostingShare(elsewhere, share, machines)).toEqual(machines);
  });

  it("forgets a root a machine no longer reports", () => {
    // Replaced, not merged: a checkout removed from a machine has to stop
    // being attributed to it, or a guest is routed to a host that no longer
    // has it.
    let state = stateWithRoots({ mini: ["/Users/sam/cs/tealstreet-next"] });
    state = rememberMachineProjectRoots(state, "mini", ["/Users/sam/cs/aimux"]);

    expect(machinesHostingShare(state, share, machines)).toEqual(machines);
  });

  it("records nothing for a machine with no usable id", () => {
    const state = rememberMachineProjectRoots(emptySharingState(), "unidentified", ["/x"]);
    expect(state.machineProjectRoots).toBeUndefined();
  });

  it("keeps the report index bounded, and never evicts the machine reporting", () => {
    // Written by every machine that ever connects, and read on the routing
    // path. Without a ceiling it grows for the life of the account.
    //
    // The reporter is named so that it sorts FIRST, because an earlier
    // version of this test used a reporter that sorted last and therefore
    // proved the sort order rather than the guard -- deleting the guard left
    // it green.
    let state = emptySharingState();
    for (let index = 0; index < 140; index += 1) {
      state = rememberMachineProjectRoots(state, `zz-${String(index).padStart(3, "0")}`, [
        `/Users/sam/cs/project-${index}`,
      ]);
    }
    state = rememberMachineProjectRoots(state, "aaa-reporter", ["/Users/sam/cs/tealstreet-next"]);

    const held = Object.keys(state.machineProjectRoots ?? {});
    expect(held.length).toBeLessThanOrEqual(100);
    // The machine whose answer is current is the one that must stay, however
    // its id sorts.
    expect(held).toContain("aaa-reporter");
    expect(state.machineProjectRoots?.["aaa-reporter"]).toEqual(["/Users/sam/cs/tealstreet-next"]);
  });

  it("evicts an id nothing is connected to before a machine that is", () => {
    // The realistic reason this index ever gets long is `ephemeral` minting a
    // fresh id on every restart that cannot read its identity file. Those ids
    // are never connected again, so they cost nothing to forget -- and a live
    // host evicted in their place would be REFUSED a route while it sat there
    // connected, which is the bug the index was added to fix.
    const connectedMachineIds = ["aaa-live-host", "aaa-other"];
    let state = emptySharingState();
    for (let index = 0; index < 100; index += 1) {
      state = rememberMachineProjectRoots(state, `zz-stale-${String(index).padStart(3, "0")}`, [
        `/Users/sam/cs/old-${index}`,
      ]);
    }
    // The live ids sort BEFORE every stale one, so eviction by id alone takes
    // the host as soon as it is not the machine currently reporting. That is
    // what makes this test able to fail.
    state = rememberMachineProjectRoots(state, "aaa-live-host", ["/Users/sam/cs/tealstreet-next"], {
      connectedMachineIds,
    });
    state = rememberMachineProjectRoots(state, "aaa-other", ["/Users/sam/cs/aimux"], {
      connectedMachineIds,
    });

    const held = Object.keys(state.machineProjectRoots ?? {});
    expect(held.length).toBeLessThanOrEqual(100);
    expect(held).toContain("aaa-live-host");
    expect(held).toContain("aaa-other");
    expect(machinesHostingShare(state, share, [{ id: "aaa-live-host" }, { id: "aaa-other" }])).toEqual([
      { id: "aaa-live-host" },
    ]);
  });

  it("trims a stored index that is already over the ceiling", () => {
    // A record written by an older build, or grown some other way. The load
    // path cannot see who is connected, so it only trims once the record is
    // absurd -- and it keeps the same end of the sorted ids that report-time
    // eviction keeps, so which machines survive does not depend on which path
    // ran.
    const machineProjectRoots: Record<string, string[]> = {};
    for (let index = 0; index < 500; index += 1) {
      machineProjectRoots[`m-${String(index).padStart(4, "0")}`] = [`/Users/sam/cs/p${index}`];
    }

    const normalized = normalizeSharingState({ ...emptySharingState(), machineProjectRoots });

    const held = Object.keys(normalized.machineProjectRoots ?? {});
    expect(held.length).toBe(200);
    expect(held).toContain("m-0499");
    expect(held).not.toContain("m-0000");
  });

  it("does not crash on a machine id that is also a property of Object", () => {
    // `isValidMachineId` admits `constructor`, and a plain property read then
    // returns a function rather than a list. `.includes` on that threw inside
    // a guest's request handling, which is a 500 for a chat that works.
    let state = rememberMachineProjectRoots(emptySharingState(), "constructor", ["/Users/sam/cs/tealstreet-next"]);
    state = rememberMachineProjectRoots(state, "mini", ["/Users/sam/cs/tealstreet-next"]);

    expect(() =>
      machinesHostingShare(state, share, [{ id: "constructor" }, { id: "mini" }, { id: "toString" }]),
    ).not.toThrow();
    expect(machinesHostingShare(state, share, [{ id: "toString" }, { id: "mini" }])).toEqual([{ id: "mini" }]);
  });

  it("caps the roots one machine may claim", () => {
    const state = rememberMachineProjectRoots(
      emptySharingState(),
      "mini",
      Array.from({ length: 260 }, (_, index) => `/Users/sam/cs/p${index}`),
    );

    expect(state.machineProjectRoots?.mini?.length).toBe(200);
  });

  it("reads a stored index back as roots or as nothing, never as junk", () => {
    // It comes back from durable storage and decides where a guest is sent.
    // Anything that is not a machine with a list of roots has to resolve to
    // "nothing reported", which WIDENS the candidates rather than refusing.
    const normalized = normalizeSharingState({
      ...emptySharingState(),
      machineProjectRoots: {
        mini: ["/Users/sam/cs/tealstreet-next", "/Users/sam/cs/tealstreet-next/"],
        mbp2: [] as string[],
        "not a machine id!": ["/Users/sam/cs/tealstreet-next"],
        broken: 7 as unknown as string[],
        mixed: [12 as unknown as string, "/Users/sam/cs/aimux"],
      },
    });

    expect(normalized.machineProjectRoots).toEqual({
      mini: ["/Users/sam/cs/tealstreet-next"],
      mixed: ["/Users/sam/cs/aimux"],
    });
    expect(machinesHostingShare(normalized, share, [{ id: "mini" }, { id: "broken" }])).toEqual([{ id: "mini" }]);
  });

  it("stores no index at all when nothing survives normalizing", () => {
    const normalized = normalizeSharingState({
      ...emptySharingState(),
      machineProjectRoots: { mbp2: [], "!": ["/x"] },
    });

    expect(normalized.machineProjectRoots).toBeUndefined();
  });

  it("does not rewrite the state when a machine reports what it already did", () => {
    // This arrives every thirty seconds. Re-writing it each time would be a
    // durable write per tick for ever.
    const first = rememberMachineProjectRoots(emptySharingState(), "mini", ["/a", "/b"]);
    expect(rememberMachineProjectRoots(first, "mini", ["/b", "/a"])).toBe(first);
  });
});

describe("share service endpoints", () => {
  // A project service binds a fresh port on every start. The share stored the
  // endpoint once, when the invite was written, and nothing moved it -- so the
  // first restart after a share was created left it proxying to a port nothing
  // was listening on, with the daemon connected and the agent working.
  async function shareOn(input: { ownerUserId?: string; projectRoot?: string; machineId?: string; port?: number }) {
    const created = await createShareInvite(emptySharingState(), {
      owner: { ...owner, userId: input.ownerUserId ?? owner.userId },
      projectRoot: input.projectRoot ?? "/Users/sam/cs/example",
      serviceEndpoint: { host: "127.0.0.1", port: input.port ?? 44659 },
      machineId: input.machineId,
      sessionId: "claude-abc",
      email: "alex@example.com",
      now: activeInviteCreatedAt,
    });
    return created.state;
  }

  function endpointOf(state: SharingState, shareId: string) {
    return state.shares[shareId].serviceEndpoint;
  }

  it("moves a share onto the port its project service is listening on now", async () => {
    const state = await shareOn({ machineId: "mini" });
    const shareId = Object.keys(state.shares)[0];

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
      now: "2099-05-25T00:00:00.000Z",
    });

    expect(result.updated).toEqual([shareId]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
    expect(result.state.shares[shareId].updatedAt).toBe("2099-05-25T00:00:00.000Z");
  });

  it("reports no update when the service is still on the port the share has", async () => {
    // This frame arrives on every daemon connect, and the ordinary case is
    // that nothing moved. Writing storage anyway would be a write per connect.
    const state = await shareOn({ machineId: "mini", port: 49226 });
    const shareId = Object.keys(state.shares)[0];

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });

    expect(result.updated).toEqual([]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
  });

  it("leaves a share for another project root where it is", async () => {
    const state = await shareOn({ projectRoot: "/Users/sam/cs/other", machineId: "mini" });
    const shareId = Object.keys(state.shares)[0];

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });

    expect(result.updated).toEqual([]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
  });

  it("leaves another owner's share where it is", async () => {
    const state = await shareOn({ ownerUserId: "user_someone_else", machineId: "mini" });
    const shareId = Object.keys(state.shares)[0];

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });

    expect(result.updated).toEqual([]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
  });

  it("leaves a share on another machine where it is", async () => {
    // A port number means nothing without the host it is on: the same path on
    // a second machine is a different service, and moving it there would break
    // a share that was working.
    const state = await shareOn({ machineId: "mbp2" });
    const shareId = Object.keys(state.shares)[0];

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });

    expect(result.updated).toEqual([]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
  });

  it("moves a share with no host only when the reporter is the owner's only machine", async () => {
    // Owner and project root is all such a share was ever keyed on, and it is
    // exactly the share old enough to have gone stale -- but a share that
    // names no host says nothing about WHICH host made it, and the same
    // checkout path on two machines is ordinary here. One connected machine is
    // the only case where `resolveSharedDaemonTarget` routes such a share at
    // all, so it is the only case where this report describes the service the
    // guest would actually reach.
    const state = await shareOn({});
    const shareId = Object.keys(state.shares)[0];
    expect(state.shares[shareId].machineId).toBeUndefined();

    const alone = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      senderIsOnlyMachine: true,
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });

    expect(alone.updated).toEqual([shareId]);
    expect(endpointOf(alone.state, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
    // Not bound by the move: binding is permanent, and a wrong guess breaks a
    // share that worked whenever its real host was the only one online.
    expect(alone.state.shares[shareId].machineId).toBeUndefined();
  });

  it("leaves a share with no host alone while a second machine is connected", async () => {
    // With two machines up the share is unroutable anyway, so moving its
    // endpoint could only be a guess -- and two machines holding the same
    // checkout path would take turns overwriting it, every turn a durable
    // write and a push to every guest.
    const state = await shareOn({});
    const shareId = Object.keys(state.shares)[0];

    for (const machineId of ["mini", "mbp2"]) {
      const result = updateShareServiceEndpoints(state, {
        ownerUserId: "user_owner",
        machineId,
        senderIsOnlyMachine: false,
        endpoints: [
          {
            projectRoot: "/Users/sam/cs/example",
            serviceEndpoint: { host: "127.0.0.1", port: 49226 },
          },
        ],
      });
      expect(result.updated, `machineId ${machineId}`).toEqual([]);
      expect(result.matched, `machineId ${machineId}`).toEqual([]);
      expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    }
  });

  it("treats a share whose stored host fails validation as having none", async () => {
    // `normalizeShare` sanitizes a stored machineId, so a share holding one
    // that fails `isValidMachineId` -- `Sam-MBP.local`, say -- reads as
    // unbound on every load. It has to land on the unbound rule, not on the
    // bound one, or it would be movable by any machine on the account.
    const state = await shareOn({});
    const shareId = Object.keys(state.shares)[0];
    state.shares[shareId].machineId = "Sam-MBP.local";

    const crowded = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      senderIsOnlyMachine: false,
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });
    expect(crowded.updated).toEqual([]);

    const alone = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      senderIsOnlyMachine: true,
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });
    expect(alone.updated).toEqual([shareId]);
  });

  it("will not move a nested project's share onto the project it is nested in", async () => {
    // The stored root is capped at 600 characters, so the stored root of a
    // path nested inside a 600-character project IS the outer project's root,
    // character for character. Nothing in the data can tell the two shares
    // apart, so moving either one moves the wrong project's share -- the
    // collision this cap protection exists for, in the shape the first
    // version of it missed: one exact root and one truncated root, rather
    // than two truncated ones.
    const outer = `/Users/sam/cs/${"n".repeat(600 - 14)}`;
    expect(outer).toHaveLength(600);
    const inner = `${outer}/app`;

    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: outer,
      serviceEndpoint: { host: "127.0.0.1", port: 44659 },
      machineId: "mini",
      sessionId: "claude-outer",
      email: "alex@example.com",
      now: activeInviteCreatedAt,
    });
    const withInner = await createShareInvite(created.state, {
      owner,
      projectRoot: inner,
      serviceEndpoint: { host: "127.0.0.1", port: 44660 },
      machineId: "mini",
      sessionId: "claude-inner",
      email: "alex@example.com",
      now: activeInviteCreatedAt,
    });
    // Both shares hold the same stored root, which is the whole problem.
    const roots = Object.values(withInner.state.shares).map((share) => share.projectRoot);
    expect(new Set(roots).size).toBe(1);

    const result = updateShareServiceEndpoints(withInner.state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      senderIsOnlyMachine: true,
      endpoints: [
        { projectRoot: outer, serviceEndpoint: { host: "127.0.0.1", port: 10001 } },
        { projectRoot: inner, serviceEndpoint: { host: "127.0.0.1", port: 20002 } },
      ],
    });

    expect(result.updated).toEqual([]);
    for (const share of Object.values(result.state.shares)) {
      expect(share.serviceEndpoint?.port).not.toBe(10001);
      expect(share.serviceEndpoint?.port).not.toBe(20002);
    }
  });

  it("matches a root whose 600th character is the slash the cap cut it at", async () => {
    // The stored copy is truncated at write time and only then loses its
    // trailing slash. Folding the slash first and truncating after made the
    // two sides disagree, and such a share could never be moved again.
    const root = `/${"a".repeat(598)}/project`;
    expect(root.length).toBeGreaterThan(600);
    expect(root.charAt(599)).toBe("/");

    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: root,
      serviceEndpoint: { host: "127.0.0.1", port: 44659 },
      machineId: "mini",
      sessionId: "claude-abc",
      email: "alex@example.com",
      now: activeInviteCreatedAt,
    });
    const shareId = Object.keys(created.state.shares)[0];

    const result = updateShareServiceEndpoints(created.state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      senderIsOnlyMachine: true,
      endpoints: [{ projectRoot: root, serviceEndpoint: { host: "127.0.0.1", port: 49226 } }],
    });

    expect(result.updated).toEqual([shareId]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
  });

  it("still moves a share when the same directory is reported twice", async () => {
    // Two spellings of one directory are not an ambiguity -- they carry the
    // same endpoint. Treating any repeated key as ambiguous stopped a long
    // root from following its service whenever the report listed it twice,
    // and the relay cannot assume the sender deduped.
    const root = `/Users/sam/cs/${"nested/".repeat(120)}example`;
    expect(root.length).toBeGreaterThan(600);
    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: root,
      serviceEndpoint: { host: "127.0.0.1", port: 44659 },
      machineId: "mini",
      sessionId: "claude-abc",
      email: "alex@example.com",
      now: activeInviteCreatedAt,
    });
    const shareId = Object.keys(created.state.shares)[0];

    const result = updateShareServiceEndpoints(created.state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      senderIsOnlyMachine: true,
      endpoints: [
        { projectRoot: root, serviceEndpoint: { host: "127.0.0.1", port: 49226 } },
        { projectRoot: `${root}/`, serviceEndpoint: { host: "127.0.0.1", port: 49226 } },
      ],
    });

    expect(result.updated).toEqual([shareId]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
  });

  it("will not move either share when two roots share the stored root's length", async () => {
    // The stored root is capped at 600 characters, so a longer one is held
    // truncated and can only be matched by comparing the report's first 600.
    // Two roots that agree for 600 characters then collide -- and a wrong
    // match moves the OTHER project's share, which is worse than the silent
    // no-match it replaced. Neither moves.
    const prefix = `/Users/sam/cs/${"nested/".repeat(120)}`;
    expect(prefix.length).toBeGreaterThan(600);
    const first = `${prefix}alpha`;
    const second = `${prefix}beta`;
    expect(first.slice(0, 600)).toBe(second.slice(0, 600));

    const created = await createShareInvite(emptySharingState(), {
      owner,
      projectRoot: first,
      serviceEndpoint: { host: "127.0.0.1", port: 44659 },
      machineId: "mini",
      sessionId: "claude-abc",
      email: "alex@example.com",
      now: activeInviteCreatedAt,
    });
    const shareId = Object.keys(created.state.shares)[0];

    const result = updateShareServiceEndpoints(created.state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        { projectRoot: first, serviceEndpoint: { host: "127.0.0.1", port: 49226 } },
        { projectRoot: second, serviceEndpoint: { host: "127.0.0.1", port: 51000 } },
      ],
    });

    expect(result.updated).toEqual([]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
  });

  it("refuses an invite carrying a host a guest could not reach", async () => {
    // The report path is not the only writer of an endpoint. An invite that
    // stores an unroutable host creates a share that refuses every request
    // from the person it was made for, and says nothing about why.
    await expect(
      createShareInvite(emptySharingState(), {
        owner,
        projectRoot: "/Users/sam/cs/example",
        serviceEndpoint: { host: "127.0.0.1/..", port: 44659 },
        machineId: "mini",
        sessionId: "claude-abc",
        email: "alex@example.com",
        now: activeInviteCreatedAt,
      }),
    ).rejects.toThrow(/not routable/);
  });

  it("will not let a daemon with no machine identity move a machine-bound share", async () => {
    // A daemon that connected without a usable machine id is tagged
    // `unidentified`, and that id is deliberately refused as a machine id --
    // so reading it as "claims no machine" let it move every machine-bound
    // share in the account onto its own ports, which is the bug this whole
    // change exists to fix, with a second machine's ports instead of a stale
    // one.
    const state = await shareOn({ machineId: "mini" });
    const shareId = Object.keys(state.shares)[0];

    for (const machineId of ["unidentified", undefined, "", "NOT A MACHINE"]) {
      const result = updateShareServiceEndpoints(state, {
        ownerUserId: "user_owner",
        machineId,
        endpoints: [
          {
            projectRoot: "/Users/sam/cs/example",
            serviceEndpoint: { host: "127.0.0.1", port: 49226 },
          },
        ],
      });
      expect(result.updated, `machineId ${String(machineId)}`).toEqual([]);
      expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    }
  });

  it("matches a root that differs only by a trailing slash", async () => {
    // A non-match is silent -- it looks exactly like "nothing moved" -- so a
    // spelling difference would leave the fix inert with nothing saying so.
    const state = await shareOn({ machineId: "mini" });
    const shareId = Object.keys(state.shares)[0];

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example/",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });

    expect(result.updated).toEqual([shareId]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
  });

  it("matches when it is the STORED root that carries the trailing slash", async () => {
    // Both sides have to be folded. Folding only the report still matched
    // every root in the fixtures, because a stored root is usually canonical
    // -- it is the share written from a path with a slash on the end that
    // could never be moved again.
    const state = await shareOn({ machineId: "mini", projectRoot: "/Users/sam/cs/example/" });
    const shareId = Object.keys(state.shares)[0];
    expect(state.shares[shareId].projectRoot).toBe("/Users/sam/cs/example/");

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });

    expect(result.updated).toEqual([shareId]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
  });

  it("still matches a root long enough to have been truncated when it was stored", async () => {
    // The stored copy went through a 600-character cap. Comparing the report
    // raw meant a deep worktree path could never match its own share.
    const deepRoot = `/Users/sam/cs/${"nested/".repeat(120)}example`;
    expect(deepRoot.length).toBeGreaterThan(600);
    const state = await shareOn({ machineId: "mini", projectRoot: deepRoot });
    const shareId = Object.keys(state.shares)[0];

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [{ projectRoot: deepRoot, serviceEndpoint: { host: "127.0.0.1", port: 49226 } }],
    });

    expect(result.updated).toEqual([shareId]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
  });

  it("follows a service that kept its port and changed its host", async () => {
    const state = await shareOn({ machineId: "mini" });
    const shareId = Object.keys(state.shares)[0];

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "::1", port: 44659 },
        },
      ],
    });

    expect(result.updated).toEqual([shareId]);
    expect(endpointOf(result.state, shareId)).toEqual({ host: "::1", port: 44659 });
  });

  it("does not delete a guest's share because its stored host predates the host rule", async () => {
    // The endpoint sanitizer runs on EVERY read of sharing state, and
    // `normalizeAcceptedShare` drops an entry whose endpoint comes back
    // undefined. So a new host rule put in that sanitizer would not refuse an
    // old host -- it would delete the guest's share, and the share would
    // vanish from their list on the next read with nothing saying why. The
    // rule belongs on the writer that is new.
    const state = await shareOn({ machineId: "mini" });
    const share = Object.values(state.shares)[0];
    const indexed = upsertAcceptedShare(emptySharingState(), {
      ...summarizeShare(share),
      serviceEndpoint: { host: "legacy host/weird", port: 44659 },
    });

    expect(listAcceptedShares(indexed)).toHaveLength(1);
    expect(listAcceptedShares(normalizeSharingState(indexed))).toHaveLength(1);
  });

  it("moves a share whose stored host predates the host rule onto a reachable one", async () => {
    const state = await shareOn({ machineId: "mini" });
    const shareId = Object.keys(state.shares)[0];
    state.shares[shareId].serviceEndpoint = { host: "legacy host/weird", port: 44659 };

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });

    expect(result.state.shares[shareId]).toBeDefined();
    expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
  });

  it("refuses a host a guest could not build a proxy path from", async () => {
    // A guest sends `/proxy/<host>/<port><path>`, matched by a pattern that
    // stops at the first slash. A host carrying one produces a path the
    // share's own allowlist does not recognise, so every request from that
    // guest is refused -- a share bricked by a value the relay accepted.
    const state = await shareOn({ machineId: "mini" });
    const shareId = Object.keys(state.shares)[0];

    for (const host of ["127.0.0.1/..", "evil host", "a?b", "x#y"]) {
      const result = updateShareServiceEndpoints(state, {
        ownerUserId: "user_owner",
        machineId: "mini",
        endpoints: [
          {
            projectRoot: "/Users/sam/cs/example",
            serviceEndpoint: { host, port: 49226 },
          },
        ],
      });
      expect(result.updated, `host ${host}`).toEqual([]);
      expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    }
  });

  it("lets each machine work through its own shares, whatever the other reports", async () => {
    // A single cursor over all shares was written by whichever machine
    // reported last, while each report only ever contains that machine's own
    // shares -- so one machine with one permanently stale share pinned the
    // other machine's window and ten of its shares were never attempted
    // again. Per-share turns cannot be frozen from outside.
    let state = emptySharingState();
    const minisShares: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const created = await createShareInvite(state, {
        owner,
        projectRoot: "/Users/sam/cs/example",
        serviceEndpoint: { host: "127.0.0.1", port: 44659 },
        machineId: "mini",
        sessionId: `claude-mini-${index}`,
        email: "alex@example.com",
        now: activeInviteCreatedAt,
      });
      state = created.state;
      minisShares.push(created.token.share.id);
    }
    const other = await createShareInvite(state, {
      owner,
      projectRoot: "/Users/sam/cs/other",
      serviceEndpoint: { host: "127.0.0.1", port: 44659 },
      machineId: "mbp2",
      sessionId: "claude-mbp2",
      email: "alex@example.com",
      now: activeInviteCreatedAt,
    });
    state = other.state;

    // mbp2 reports between every pair of mini reports, taking its own turn
    // each time -- which is what used to move the shared cursor.
    const attempted = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      const mbp2Batch = nextShareRefreshBatch(state, [other.token.share.id], 20);
      stamp(state, mbp2Batch, `2099-06-0${round + 1}T00:00:00.000Z`);

      const miniBatch = nextShareRefreshBatch(state, minisShares, 20);
      for (const id of miniBatch) attempted.add(id);
      stamp(state, miniBatch, `2099-06-0${round + 1}T00:00:30.000Z`);
    }

    expect(attempted.size).toBe(minisShares.length);
  });

  function stamp(state: SharingState, ids: string[], at: string) {
    for (const id of ids) state.shares[id].lastReceiverRefreshAt = at;
  }

  it("reports every share it matched, moved or not", async () => {
    // The caller retries a receiver whose own copy could not be refreshed, and
    // by then this record already matches the report -- so "matched" is the
    // only thing that can find that share again.
    const state = await shareOn({ machineId: "mini", port: 49226 });
    const shareId = Object.keys(state.shares)[0];

    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints: [
        {
          projectRoot: "/Users/sam/cs/example",
          serviceEndpoint: { host: "127.0.0.1", port: 49226 },
        },
      ],
    });

    expect(result.updated).toEqual([]);
    expect(result.matched).toEqual([shareId]);
  });

  it("refuses an endpoint that is not a port", async () => {
    const state = await shareOn({ machineId: "mini" });
    const shareId = Object.keys(state.shares)[0];

    for (const port of [0, 70000, Number.NaN]) {
      const result = updateShareServiceEndpoints(state, {
        ownerUserId: "user_owner",
        machineId: "mini",
        endpoints: [
          {
            projectRoot: "/Users/sam/cs/example",
            serviceEndpoint: { host: "127.0.0.1", port },
          },
        ],
      });
      expect(result.updated, `port ${port}`).toEqual([]);
      expect(endpointOf(result.state, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    }
  });
});
